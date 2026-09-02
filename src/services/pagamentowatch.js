const log = require('../log');
const db = require('../db/queries');
const notify = require('../bot/notify');
const zelle = require('./zelle');
const { t } = require('../i18n');
const session = require('../bot/session');

/**
 * Vigia pedidos que ficaram esperando o comprovante do Zelle.
 *
 * O Zelle não tem webhook: nada avisa o servidor que o dinheiro chegou. O
 * pedido nasce `pending` e só sai desse estado quando o cliente manda o print
 * (`comprovante.js` → `awaiting_review`) ou o dono libera. Sem esta vigilância,
 * um cliente que confirmou o pedido e nunca mandou o comprovante deixa o pedido
 * `pending` para sempre — e some sem saber que faltava algo.
 *
 * Dois prazos, de `config/pagamento.json`:
 *
 *   lembrete_minutos  cobra o comprovante uma vez, pelo WhatsApp
 *   expira_minutos    desiste do pedido, libera a sessão e avisa o cliente
 *
 * Enquanto o pedido está `pending`, o destinatário é o cliente: é ele quem
 * precisa mandar o print. Depois que vira `awaiting_review`, o destinatário é
 * o dono: é ele quem precisa conferir e liberar.
 */

const INTERVALO_MS = 60 * 1000;
const REVISAO_MINUTOS = 10;

let timer = null;

// Um lembrete por pedido. Sem isso o cliente receberia a mesma cobrança a cada
// minuto entre o prazo do lembrete e o da expiração.
const jaLembrados = new Set();

/** Idioma gravado no pedido, com queda para o padrão. */
function idioma(order) {
  return order.lang || 'pt';
}

/**
 * Cobra o comprovante uma vez, dos pedidos que passaram do prazo de lembrete
 * mas ainda não do de expiração.
 */
async function lembrar(pendentes, prazoExpira) {
  const agora = Date.now();

  for (const order of pendentes) {
    if (jaLembrados.has(order.id)) continue;

    // Perto de expirar não vale mais cobrar: o próximo passo é desistir, e o
    // aviso de expiração já sai logo em seguida. Evita cobrar e cancelar quase
    // ao mesmo tempo.
    const idadeMin = (agora - new Date(order.created_at).getTime()) / 60000;
    if (idadeMin >= prazoExpira) continue;

    jaLembrados.add(order.id);

    log.info(
      { evt: 'pagamento', pedido: order.id, fase: 'lembrete' },
      `cobrando comprovante do pedido #${order.id}`
    );

    await notify.send(
      order.phone,
      t(idioma(order), 'zelle_reminder', { order_id: order.id })
    );
  }
}

/**
 * Desiste dos pedidos que passaram do prazo de expiração.
 *
 * Marca `cancelled` no banco (não há status `expired` — expirar por silêncio é
 * uma forma de cancelar antes de pagar), avisa o cliente e libera a sessão para
 * que um "oi" comece de novo, sem arrastar o carrinho antigo.
 */
async function expirar(vencidos) {
  for (const order of vencidos) {
    log.info(
      { evt: 'pagamento', pedido: order.id, fase: 'expirado' },
      `pedido #${order.id} expirou por falta de comprovante`
    );

    try {
      await db.updateOrderStatus(order.id, 'cancelled');
    } catch (err) {
      log.error(
        { evt: 'pagamento', pedido: order.id, err },
        'falha ao expirar pedido — tenta de novo no próximo ciclo'
      );
      // Não avisa o cliente nem limpa a sessão se o banco não confirmou a
      // baixa: senão ele receberia "expirou" e o pedido seguiria de pé.
      continue;
    }

    jaLembrados.delete(order.id);
    session.clear(order.phone);

    await notify.send(
      order.phone,
      t(idioma(order), 'zelle_expired', { order_id: order.id })
    );
  }
}

function pagamentoEmRevisao(order) {
  return (order.payments || []).find((p) => p.proof_received_at) || null;
}

/** Lembra o dono uma vez quando o comprovante ficou dez minutos sem decisão. */
async function lembrarRevisao(pedidos) {
  const admin = notify.dono();
  if (!admin) return;

  const agora = Date.now();
  for (const order of pedidos) {
    const payment = pagamentoEmRevisao(order);
    if (!payment || payment.status === 'review_reminded') continue;

    const recebidoEm = new Date(payment.proof_received_at).getTime();
    if (!Number.isFinite(recebidoEm)) continue;
    if (agora - recebidoEm < REVISAO_MINUTOS * 60 * 1000) continue;

    const mensagem = require('../texto').paraAdmin(
      `⏰ *COMPROVANTE AGUARDANDO CONFERENCIA*\n\n` +
        `*#${order.id}* — $${Number(order.total).toFixed(2)}\n` +
        `${order.customer_name || 'sem nome'}\n\n` +
        `O comprovante chegou ha mais de ${REVISAO_MINUTOS} minutos.\n` +
        `Confira e libere: *!liberar ${order.id}*`
    );

    const enviou = await notify.send(admin, mensagem);
    if (!enviou) continue;

    await db.markReviewReminderSent(order.id);
    log.warn(
      { evt: 'pagamento', pedido: order.id, fase: 'lembrete_revisao' },
      `comprovante do pedido #${order.id} aguardando o dono`
    );
  }
}

async function verificar() {
  const { lembrete, expira } = zelle.prazos();

  // Uma consulta por prazo. Vencidos é subconjunto de pendentes (é sempre o
  // prazo maior), então dá para separar as duas ações a partir das duas listas.
  const [pendentes, vencidos, emRevisao] = await Promise.all([
    db.getStalePendingOrders(lembrete),
    db.getStalePendingOrders(expira),
    db.getOrdersAwaitingReview(),
  ]);

  // Pedido que saiu de `pending` (pagou, mandou o print, foi cancelado à mão)
  // deixa de aparecer aqui — tira do set para ele não crescer sem limite.
  const aindaPendentes = new Set(pendentes.map((o) => o.id));
  for (const id of jaLembrados) {
    if (!aindaPendentes.has(id)) jaLembrados.delete(id);
  }

  if (vencidos.length) await expirar(vencidos);

  // Lembrar depois de expirar, e reconferir contra os vencidos: o que acabou de
  // expirar neste mesmo ciclo não deve receber a cobrança.
  const idsVencidos = new Set(vencidos.map((o) => o.id));
  const aLembrar = pendentes.filter((o) => !idsVencidos.has(o.id));
  if (aLembrar.length) await lembrar(aLembrar, expira);
  if (emRevisao.length) await lembrarRevisao(emRevisao);
}

function start() {
  if (timer) return;

  timer = setInterval(() => {
    verificar().catch((err) =>
      log.error({ evt: 'pagamento', err }, 'falha ao verificar pedidos pendentes')
    );
  }, INTERVALO_MS);
  timer.unref();

  const { lembrete, expira } = zelle.prazos();
  log.info(
    { evt: 'boot', lembreteMinutos: lembrete, expiraMinutos: expira },
    `vigilância de pagamento ativa — cobra o cliente em ${lembrete} min, ` +
      `lembra o dono em ${REVISAO_MINUTOS} min e expira em ${expira} min`
  );
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { verificar, start, stop };
