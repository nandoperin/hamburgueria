const log = require('../log');
const db = require('../db/queries');
const zelle = require('./zelle');
const notify = require('../bot/notify');
const texto = require('../texto');
const { t, prazoPedido } = require('../i18n');
const leitura = require('./leitura-comprovante');
const recebimentos = new Map();

/**
 * Comprovante de pagamento do Zelle.
 *
 * O cliente manda o comprovante e ele é **recebido**, não julgado: registra-se
 * que chegou, o dono recebe o arquivo no WhatsApp e a conversa segue. Este
 * módulo lê o arquivo em memória, encaminha e o descarta ao terminar.
 *
 * ## O comprovante deixou de ser um portão (13/09)
 *
 * Ele já foi o gatilho da comanda: o pedido ficava `pending` até a imagem
 * chegar. Não é mais — a cozinha é liberada na confirmação do cliente, igual
 * ao cash (`db.createZellePayment`). O que muda aqui é só o pagamento, que
 * passa a `awaiting_review`; a conferência do dinheiro continua sendo do dono,
 * no extrato, com `!liberar` ou `!recusar`.
 *
 * Como nada depende mais do conteúdo do arquivo, o conteúdo parou de ser
 * conferido: foto, print ou PDF do banco entram do mesmo jeito, e a leitura
 * automática por IA saiu do caminho (fica atrás de `AI_PROOF_READING=on`).
 * Recusar um PDF legítimo, ou fazer o cliente esperar por uma leitura que não
 * decide nada, era atrito numa etapa que já não segura a venda.
 *
 * O que sobrou de porta, e por quê:
 *
 * | Checagem | Sem ela |
 * |---|---|
 * | Existe pedido esperando comprovante? | Qualquer número manda arquivo ao dono a qualquer hora |
 * | Teto de tamanho | O cliente escolhe quanta banda e memória o servidor gasta |
 * | Tipo real pelos bytes | O dono recebe como foto algo que não é foto — e o envio falha |
 */

/** Extensão pelo mimetype conferido — nunca pelo nome que veio junto do arquivo. */
const EXTENSAO = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/** Tipos que o WhatsApp do dono recebe como foto; o resto vai como arquivo. */
const FOTO = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Tipo real pelos primeiros bytes (magic bytes).
 *
 * O mimetype vem no envelope da mensagem, e quem manda pela API escolhe o que
 * escrever ali — declarar `image/jpeg` num arquivo que não é imagem custa nada.
 * Conferir os primeiros bytes é o que separa o que o remetente **disse** do que
 * ele **mandou**.
 *
 * Não é antivírus: é impedir que conteúdo arbitrário seja tratado como
 * comprovante.
 */
function tipoReal(buffer) {
  if (!buffer || buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }

  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  // O banco às vezes exporta o recibo em PDF, e o cliente encaminha o arquivo
  // em vez do print. `validar` continua recusando PDF — quem aceita os dois é
  // `aceitar`, do comprovante, que não manda nada para o gerador de imagem.
  if (buffer.toString('ascii', 0, 4) === '%PDF') {
    return 'application/pdf';
  }

  return null;
}

/**
 * A porta do comprovante: mede o tamanho, e só.
 *
 * O conteúdo deixou de ser julgado porque o comprovante deixou de decidir
 * qualquer coisa — a comanda já saiu quando o cliente confirmou. Sobrou o teto
 * de bytes, que protege a memória do servidor, e o reconhecimento do tipo:
 * não para aprovar ou recusar, mas para saber se o dono recebe foto, arquivo
 * ou só o aviso em texto.
 *
 * Separada de `validar` de propósito. Aquela continua estrita, com a lista de
 * tipos da configuração, porque serve ao repasse de fotos do atendimento
 * humano (`imagem-repasse.js`), que decodifica a imagem de verdade.
 *
 * @returns {{ok: true, mimetype: string|null} | {ok: false, motivo: string}}
 */
function aceitar(buffer) {
  const regras = zelle.regrasComprovante();

  if (!buffer || !buffer.length) return { ok: false, motivo: 'vazio' };
  if (buffer.length > regras.maxBytes) return { ok: false, motivo: 'grande_demais' };

  // `null` aqui não é recusa: é "não sei o que é". O dono recebe o aviso em
  // texto e cobra o cliente se precisar ver.
  return { ok: true, mimetype: tipoReal(buffer) };
}

/**
 * O arquivo pode entrar?
 *
 * Separado de `receber` para os testes exercitarem a porta sem banco, sem
 * WhatsApp e sem pedido no banco — a superfície de segurança vale por si, e
 * teste que precisa de infraestrutura é teste que não roda.
 *
 * @returns {{ok: true, mimetype: string, ext: string} | {ok: false, motivo: string}}
 */
function validar(buffer, mimetypeDeclarado) {
  const regras = zelle.regrasComprovante();

  if (!buffer || !buffer.length) return { ok: false, motivo: 'vazio' };

  if (buffer.length > regras.maxBytes) {
    return { ok: false, motivo: 'grande_demais' };
  }

  // O tipo real manda. O declarado só entra na conta para recusar quem mente:
  // arquivo cujo conteúdo é PNG mas que se anuncia como PDF é sinal ruim, mesmo
  // que os dois estivessem na lista.
  const real = tipoReal(buffer);
  if (!real) return { ok: false, motivo: 'nao_e_imagem' };

  if (!regras.mimetypes.includes(real)) {
    return { ok: false, motivo: 'tipo_nao_aceito' };
  }

  const declarado = String(mimetypeDeclarado || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (declarado && declarado !== real) {
    return { ok: false, motivo: 'tipo_divergente' };
  }

  return { ok: true, mimetype: real, ext: EXTENSAO[real] };
}

// Os dois unicos motivos que `aceitar` produz. `validar` tem outros, mas eles
// pertencem ao repasse de fotos do atendimento, que tem as proprias mensagens.
const MOTIVO_I18N = {
  vazio: 'zelle_proof_invalid_type',
  grande_demais: 'zelle_proof_too_big',
};

/**
 * Entrada principal — um arquivo chegou de um cliente (foto, print ou PDF).
 *
 * @returns {boolean} true se o arquivo era para nós; false se não havia pedido
 *   esperando comprovante, caso em que quem chamou decide o que responder.
 */
async function receber(args) {
  // Duas copias simultaneas nao geram dois uploads nem duas leituras pagas.
  if (recebimentos.has(args.phone)) return recebimentos.get(args.phone);
  const promessa = processarRecebimento(args);
  recebimentos.set(args.phone, promessa);
  try { return await promessa; } finally { recebimentos.delete(args.phone); }
}

// O mimetype chega no objeto e não é lido: o tipo declarado é do remetente, e
// quem decide como o arquivo é repassado são os primeiros bytes.
async function processarRecebimento({ phone, buffer, lang, send, sess }) {
  // Primeiro de tudo: existe pedido esperando? Sem isto, o resto das checagens
  // seria só um filtro de qualidade num depósito aberto.
  const order = await db.getOrderAwaitingProof(phone);
  if (!order) return false;

  const conferido = aceitar(buffer);
  if (!conferido.ok) {
    log.warn(
      {
        evt: 'comprovante',
        pedido: order.id,
        motivo: conferido.motivo,
        bytes: buffer?.length,
      },
      'comprovante recusado'
    );
    await send(t(lang, MOTIVO_I18N[conferido.motivo] || 'zelle_proof_invalid_type'));
    return true;
  }

  // O estado durável guarda somente que o comprovante chegou e quando. O
  // arquivo nunca sai da memória para um bucket ou disco. A comanda não
  // depende disto: ela saiu na confirmação do cliente.
  const registrado = await db.markProofReceived(order.id);
  if (!registrado) {
    // Entre a consulta e a gravação o pagamento deixou de aguardar (o dono
    // liberou ou recusou à mão, ou o pedido foi cancelado).
    log.warn(
      { evt: 'comprovante', pedido: order.id, motivo: 'pagamento_nao_aguardava' },
      'comprovante chegou para pedido que já não aguardava'
    );
    return false;
  }

  log.info(
    { evt: 'comprovante', pedido: order.id, tipo: conferido.mimetype || 'desconhecido' },
    `comprovante do pedido #${order.id} recebido — a conferir no banco`
  );

  // O pedido deixou de esperar o print. Sem isto, a próxima pergunta do
  // cliente ainda ouviria "envie o comprovante".
  if (sess?.state === 'PAYMENT_PENDING' && String(sess.orderId) === String(order.id)) {
    sess.state = 'ORDER_COMPLETE';
  }

  // O estado e duravel ANTES do aviso. Reenvio/restart nao repete o
  // encaminhamento: markProofReceived so avanca um pagamento ainda pendente.
  try {
    await send(t(lang, 'zelle_proof_received', {
      order_id: order.id,
      estimated_time: prazoPedido(lang, order.order_type),
    }));
  } catch (_err) {
    log.warn({ evt: 'comprovante', pedido: order.id, motivo: 'aviso_cliente_falhou' },
      'comprovante registrado; seguindo com aviso ao dono');
  }
  await avisarDono(order, { buffer, mimetype: conferido.mimetype });

  // Leitura automática por IA: desligada por padrão desde 13/09. O dono pediu
  // agilidade, e ela nunca decidiu nada — quem confere o dinheiro é ele, no
  // extrato. Continua a um `AI_PROOF_READING=on` de distância, sem deploy.
  if (!leitura.ligada()) return true;

  const admins = notify.admins();
  let analise = { ok: false };
  try {
    if (admins.length) analise = await leitura.analisar({ buffer, mimetype: conferido.mimetype, sess });
  } catch (_err) {
    // A leitura nunca pode impedir o dono de receber o comprovante original.
  }
  for (const admin of admins) {
    await notify.send(admin, texto.paraAdmin(
      `*PEDIDO #${order.id} — apoio a conferencia*\n\n` +
      leitura.resumo(analise, order.total, zelle.destinatario())
    ));
  }
  return true;
}

/**
 * Manda o comprovante e o resumo para o dono.
 *
 * A comanda já foi para a cozinha: a mensagem não pede liberação, pede a
 * conferência do dinheiro no banco — e diz o que fazer se ele não caiu.
 *
 * Foto vai como foto, PDF vai como arquivo, e o que não foi reconhecido vai só
 * como texto — melhor o dono saber que chegou algo ilegível do que o envio
 * falhar em silêncio. Nada é persistido pelo bot: depois do envio o buffer
 * fica sem referência e é liberado.
 */
async function avisarDono(order, { buffer, mimetype } = {}) {
  const admins = notify.admins();
  if (!admins.length) return;

  const itens = (Array.isArray(order.items_json) ? order.items_json : [])
    .map((i) => `${i.qty}x ${i.nomeCozinha || i.name}`)
    .join(', ');

  const destino =
    order.order_type === 'pickup' ? 'Retirada' : `Entrega — ${order.city}`;

  // Formato desconhecido não é recusa — mas o dono precisa saber que o arquivo
  // existe e não chegou junto, senão procura um anexo que nunca veio.
  const arquivo = !mimetype
    ? '\n⚠️ Formato não reconhecido — o arquivo não pôde ser reenviado aqui.'
    : FOTO.includes(mimetype) ? '' : `\n⚠️ Veio como arquivo (${EXTENSAO[mimetype]}).`;

  const corpo = texto.paraAdmin(
    `💵 *COMPROVANTE RECEBIDO — PEDIDO JÁ NA COZINHA*\n\n` +
      `*#${order.id}* — $${Number(order.total).toFixed(2)}\n` +
      `${order.customer_name || 'sem nome'} · +${order.phone}\n` +
      `${itens}\n` +
      `${destino}${arquivo}\n\n` +
      `A comanda já foi para a impressora.\n` +
      `Confira o Zelle no banco e marque:\n*!liberar ${order.id}*\n` +
      `Se o dinheiro não caiu: *!recusar ${order.id} <motivo>*`
  );

  for (const admin of admins) {
    let foi = false;
    if (buffer && FOTO.includes(mimetype)) {
      foi = await notify.sendImage(admin, { buffer, mimetype, caption: corpo });
    } else if (buffer && mimetype) {
      foi = await notify.sendDocument(admin, {
        buffer,
        mimetype,
        filename: `comprovante-${order.id}.${EXTENSAO[mimetype] || 'bin'}`,
        caption: corpo,
      });
    }

    // Sem suporte a anexo, o texto vai sozinho. O arquivo não é mantido pelo
    // bot, portanto a conferência visual depende da mensagem recebida no WhatsApp.
    if (!foi) await notify.send(admin, corpo);
  }
}

module.exports = { receber, validar, aceitar, tipoReal, avisarDono };
