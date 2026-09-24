const log = require('../log');
const db = require('../db/queries');
const notify = require('../bot/notify');
const zelle = require('./zelle');
const { t } = require('../i18n');
const session = require('../bot/session');

/**
 * Vigia o comprovante do Zelle que não chegou.
 *
 * O Zelle não tem webhook: nada avisa o servidor que o dinheiro chegou. Sem
 * esta vigilância, o cliente que confirmou o pedido e esqueceu o print some — e
 * o dono fica com um pedido entregue e sem nada para conferir no banco.
 *
 * Desde 13/09 a comanda sai na confirmação, e não no print. Isso mudou quem
 * fica esperando o quê:
 *
 *   lembrete_minutos  cobra o comprovante uma vez, pelo WhatsApp — a partir de
 *                     `db.getOrdersAwaitingProof`, que olha o **pagamento**
 *                     ainda pendente, não o pedido (o pedido já está `paid`)
 *   expira_minutos    só alcança pedido que ficou mesmo `pending` — legado de
 *                     antes desta mudança, ou liberação que falhou. Pedido que
 *                     já foi para a cozinha nunca expira: o lanche foi feito
 *   REVISAO_MINUTOS   lembra o dono do comprovante que chegou e ninguém olhou
 *
 * O cliente é cobrado uma vez e só; passado disso o assunto é do dono, que vê
 * o pedido sem print no `!conferir`.
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

/** Cobra o comprovante uma vez, de quem passou do prazo do lembrete. */
async function lembrar(semComprovante, prazoExpira) {
  const agora = Date.now();

  for (const order of semComprovante) {
    if (jaLembrados.has(order.id)) continue;

    // Pedido ainda `pending` é legado: ele vai expirar, e perto do fim não
    // vale mais cobrar — o aviso de expiração sai logo em seguida, e cobrar e
    // cancelar quase juntos confunde. Quem já foi para a cozinha não expira,
    // então a idade não o tira da cobrança.
    const idadeMin = (agora - new Date(order.created_at).getTime()) / 60000;
    if (order.status === 'pending' && idadeMin >= prazoExpira) continue;

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
 *
 * Só pega pedido `pending`, e desde 13/09 isso é raro: pedido confirmado nasce
 * `paid`. Sobra o caso em que a liberação falhou no meio — e aí ninguém
 * cozinhou nada, então cancelar continua certo.
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

/**
 * Lembra o dono uma vez quando o comprovante ficou dez minutos sem conferência.
 *
 * A comanda já saiu com o print — o lembrete não segura nada, só evita que o
 * dinheiro fique sem ninguém olhar o banco.
 */
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
      `⏰ *ZELLE AINDA NAO CONFERIDO*\n\n` +
        `*#${order.id}* — $${Number(order.total).toFixed(2)}\n` +
        `${order.customer_name || 'sem nome'}\n\n` +
        `O comprovante chegou ha mais de ${REVISAO_MINUTOS} minutos e a comanda ja foi para a cozinha.\n` +
        `Confira no banco e marque: *!liberar ${order.id}*\n` +
        `Se o dinheiro nao caiu: *!recusar ${order.id} <motivo>*`
    );

    const enviou = await notify.send(admin, mensagem);
    if (!enviou) continue;

    await db.markReviewReminderSent(order.id);
    log.warn(
      { evt: 'pagamento', pedido: order.id, fase: 'lembrete_revisao' },
      `pagamento do pedido #${order.id} aguardando conferência do dono`
    );
  }
}

async function verificar() {
  const { lembrete, expira } = zelle.prazos();

  // Três listas, três destinatários: quem não mandou o print, o pedido que
  // ficou parado de verdade, e o dono que ainda não conferiu o banco.
  const [semComprovante, vencidos, emRevisao] = await Promise.all([
    db.getOrdersAwaitingProof(lembrete),
    db.getStalePendingOrders(expira),
    db.getOrdersAwaitingReview(),
  ]);

  // Mandou o print, foi conferido ou cancelado: sai da lista — e sai do set,
  // para ele não crescer sem limite.
  const aindaSemComprovante = new Set(semComprovante.map((o) => o.id));
  for (const id of jaLembrados) {
    if (!aindaSemComprovante.has(id)) jaLembrados.delete(id);
  }

  if (vencidos.length) await expirar(vencidos);

  // Lembrar depois de expirar, e reconferir contra os vencidos: o que acabou de
  // expirar neste mesmo ciclo não deve receber a cobrança.
  const idsVencidos = new Set(vencidos.map((o) => o.id));
  const aLembrar = semComprovante.filter((o) => !idsVencidos.has(o.id));
  if (aLembrar.length) await lembrar(aLembrar, expira);
  if (emRevisao.length) await lembrarRevisao(emRevisao);
}

function start() {
  if (timer) return;

  timer = setInterval(() => {
    // Loja fechada há mais de 2 h: nada a vigiar (ver expediente.js).
    if (!require('./expediente').deveVigiar()) return;
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
