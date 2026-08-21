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
 * Diferente do `printwatch`, o destinatário aqui é o **cliente**, não o dono:
 * é ele quem precisa agir (mandar o print) ou saber que o pedido caiu.
 */

const INTERVALO_MS = 60 * 1000;

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

async function verificar() {
  const { lembrete, expira } = zelle.prazos();

  // Uma consulta por prazo. Vencidos é subconjunto de pendentes (é sempre o
  // prazo maior), então dá para separar as duas ações a partir das duas listas.
  const [pendentes, vencidos] = await Promise.all([
    db.getStalePendingOrders(lembrete),
    db.getStalePendingOrders(expira),
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
    `vigilância de pagamento ativa — lembra em ${lembrete} min, expira em ${expira} min`
  );
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { verificar, start, stop };
