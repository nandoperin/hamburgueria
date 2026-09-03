const crypto = require('crypto');

const log = require('../log');
const db = require('../db/queries');
const supabase = require('../db/client');
const zelle = require('./zelle');
const notify = require('../bot/notify');
const texto = require('../texto');
const { t } = require('../i18n');
const leitura = require('./leitura-comprovante');
const recebimentos = new Map();

/**
 * Comprovante de pagamento do Zelle.
 *
 * O cliente manda o print, este módulo guarda e avisa o dono, e o dono decide
 * com `!liberar`. Nada aqui libera comanda — de propósito. Guardar a imagem e
 * pôr comida na chapa são decisões diferentes, e só a segunda custa dinheiro.
 *
 * ## Por que isto é uma porta, e não um upload
 *
 * É o único ponto do sistema em que um estranho faz o servidor **gravar um
 * arquivo**. Sem as checagens abaixo, o bucket vira depósito de qualquer coisa
 * que alguém queira hospedar no nosso Supabase — e a conta é nossa.
 *
 * As quatro checagens, e o que cada uma impede:
 *
 * | Checagem | Sem ela |
 * |---|---|
 * | Existe pedido esperando comprovante? | Qualquer número manda foto a qualquer hora |
 * | Tipo real na lista de permitidos | Sobe-se o que quiser, com nome de imagem |
 * | Teto de tamanho | O cliente escolhe quanta banda e memória o servidor gasta |
 * | Caminho gerado aqui | Nome vindo de fora vira caminho, e caminho vira `../` |
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
 * Não é antivírus: é impedir que o bucket de comprovantes guarde o que não é
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
 * Separado de `receber` para os testes exercitarem a porta sem Supabase, sem
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

/**
 * Caminho no bucket, montado **aqui**.
 *
 * Nada do que veio de fora entra: o id do pedido é número do nosso banco, o
 * nome é aleatório e a extensão sai do tipo conferido. É o que garante que um
 * "arquivo" chamado `../../outro-bucket/x.png` não vire caminho nenhum.
 */
function caminho(orderId, ext) {
  return `comprovantes/${orderId}/${crypto.randomUUID()}.${ext}`;
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

  const destino = caminho(order.id, conferido.ext);

  const { error } = await supabase.storage
    .from(zelle.regrasComprovante().bucket)
    .upload(destino, buffer, { contentType: conferido.mimetype, upsert: false });

  if (error) {
    log.error(
      { evt: 'comprovante', pedido: order.id, err: error },
      'falha ao guardar comprovante'
    );
    // O cliente já mandou o dinheiro — não pode ficar sem caminho porque o
    // nosso Storage falhou. O dono recebe a imagem assim mesmo e resolve.
    await avisarDono(order, {
      falhaAoGuardar: true,
      buffer,
      mimetype: conferido.mimetype,
    });
    await send(t(lang, 'zelle_proof_received', { order_id: order.id }));
    return true;
  }

  await db.attachProof(order.id, destino);
  await db.updateOrderStatus(order.id, 'awaiting_review');

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
      'comprovante salvo; seguindo com aviso ao dono');
  }
  await avisarDono(order, { buffer, mimetype: conferido.mimetype });
  let analise = { ok: false };
  try {
    if (notify.dono()) analise = await leitura.analisar({ buffer, mimetype: conferido.mimetype, sess });
  } catch (_err) {
    // A leitura nunca pode impedir o dono de receber o comprovante original.
  }
  const admin = notify.dono();
  if (admin) {
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
 * A imagem vai **junto** da mensagem, não como link: o dono está no celular, no
 * meio do serviço, e abrir uma URL assinada do Supabase para conferir um Zelle é
 * atrito onde não pode haver. A cópia no bucket existe para o dia seguinte, não
 * para agora.
 */
async function avisarDono(order, { buffer, mimetype, falhaAoGuardar = false } = {}) {
  const admin = notify.dono();
  if (!admin) return;

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
      (falhaAoGuardar
        ? '⚠️ A imagem NAO foi salva no Storage. Guarde esta conversa.\n\n'
        : '') +
      `Confira e libere:\n*!liberar ${order.id}*\n` +
      `Se estiver errado: *!recusar ${order.id} <motivo>*`
  );

  const foi = buffer
    ? await notify.sendImage(admin, { buffer, mimetype, caption: corpo })
    : false;

  // Sem suporte a imagem, o texto vai sozinho — o dono ainda decide pelo valor
  // e pelo nome, e o comprovante continua no bucket.
  if (!foi) await notify.send(admin, corpo);
}

module.exports = { receber, validar, tipoReal, caminho, avisarDono };
