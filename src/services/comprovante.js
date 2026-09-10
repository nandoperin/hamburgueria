const log = require('../log');
const db = require('../db/queries');
const zelle = require('./zelle');
const notify = require('../bot/notify');
const texto = require('../texto');
const { t } = require('../i18n');
const leitura = require('./leitura-comprovante');
const recebimentos = new Map();

/**
 * Comprovante de pagamento do Zelle.
 *
 * O cliente manda o print, este módulo lê a imagem em memória, avisa o dono e
 * a descarta ao terminar. O dono decide com `!liberar`; nada aqui libera
 * comanda — de propósito.
 *
 * ## Por que isto é uma porta, e não um upload
 *
 * Mesmo sem armazenamento permanente, a imagem ainda entra na memória do
 * servidor e segue para a IA e para o WhatsApp do dono. As checagens limitam
 * formato e tamanho antes desses dois usos.
 *
 * As quatro checagens, e o que cada uma impede:
 *
 * | Checagem | Sem ela |
 * |---|---|
 * | Existe pedido esperando comprovante? | Qualquer número força leitura de foto a qualquer hora |
 * | Tipo real na lista de permitidos | Conteúdo arbitrário chega à IA como imagem |
 * | Teto de tamanho | O cliente escolhe quanta banda e memória o servidor gasta |
 */

/** Extensão pelo mimetype conferido — nunca pelo nome que veio junto do arquivo. */
const EXTENSAO = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

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

  return null;
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

const MOTIVO_I18N = {
  vazio: 'zelle_proof_invalid_type',
  nao_e_imagem: 'zelle_proof_invalid_type',
  tipo_nao_aceito: 'zelle_proof_invalid_type',
  tipo_divergente: 'zelle_proof_invalid_type',
  grande_demais: 'zelle_proof_too_big',
};

/**
 * Entrada principal — uma imagem chegou de um cliente.
 *
 * @returns {boolean} true se a imagem era para nós; false se não havia pedido
 *   esperando comprovante, caso em que quem chamou decide o que responder.
 */
async function receber(args) {
  // Duas copias simultaneas nao geram dois uploads nem duas leituras pagas.
  if (recebimentos.has(args.phone)) return recebimentos.get(args.phone);
  const promessa = processarRecebimento(args);
  recebimentos.set(args.phone, promessa);
  try { return await promessa; } finally { recebimentos.delete(args.phone); }
}

async function processarRecebimento({ phone, buffer, mimetype, lang, send, sess }) {
  // Primeiro de tudo: existe pedido esperando? Sem isto, o resto das checagens
  // seria só um filtro de qualidade num depósito aberto.
  const order = await db.getOrderAwaitingProof(phone);
  if (!order) return false;

  const conferido = validar(buffer, mimetype);
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

  // O estado durável guarda somente que a imagem chegou e quando. O arquivo
  // nunca sai da memória para um bucket ou disco.
  await db.markProofReceived(order.id);

  log.info(
    { evt: 'comprovante', pedido: order.id },
    `comprovante do pedido #${order.id} recebido`
  );

  // O estado e duravel ANTES da leitura. Reenvio/restart nao dispara nova
  // analise do mesmo pedido: getOrderAwaitingProof so aceita pending.
  try {
    await send(t(lang, 'zelle_proof_received', { order_id: order.id }));
  } catch (_err) {
    log.warn({ evt: 'comprovante', pedido: order.id, motivo: 'aviso_cliente_falhou' },
      'comprovante registrado; seguindo com aviso ao dono');
  }
  await avisarDono(order, { buffer, mimetype: conferido.mimetype });
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
 * Manda a imagem e o resumo para o dono.
 *
 * A imagem vai **junto** da mensagem e não é persistida pelo bot. Depois do
 * envio ao dono e da leitura da IA, o buffer fica sem referência e é liberado.
 */
async function avisarDono(order, { buffer, mimetype } = {}) {
  const admins = notify.admins();
  if (!admins.length) return;

  const itens = (Array.isArray(order.items_json) ? order.items_json : [])
    .map((i) => `${i.qty}x ${i.nomeCozinha || i.name}`)
    .join(', ');

  const destino =
    order.order_type === 'pickup' ? 'Retirada' : `Entrega — ${order.city}`;

  const corpo = texto.paraAdmin(
    `💵 *COMPROVANTE RECEBIDO*\n\n` +
      `*#${order.id}* — $${Number(order.total).toFixed(2)}\n` +
      `${order.customer_name || 'sem nome'} · +${order.phone}\n` +
      `${itens}\n` +
      `${destino}\n\n` +
      `Confira e libere:\n*!liberar ${order.id}*\n` +
      `Se estiver errado: *!recusar ${order.id} <motivo>*`
  );

  for (const admin of admins) {
    const foi = buffer
      ? await notify.sendImage(admin, { buffer, mimetype, caption: corpo })
      : false;

    // Sem suporte a imagem, o texto vai sozinho. O arquivo não é mantido pelo
    // bot, portanto a conferência visual depende da mensagem recebida no WhatsApp.
    if (!foi) await notify.send(admin, corpo);
  }
}

module.exports = { receber, validar, tipoReal, avisarDono };
