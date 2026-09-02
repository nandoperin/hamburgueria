/** Comprovante parado por dez minutos precisa lembrar o dono uma vez. */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.ADMIN_PHONE = '15550001111';

const path = require('path');
const PROJECT = path.resolve(__dirname, '..');
const antigo = (minutos) => new Date(Date.now() - minutos * 60 * 1000).toISOString();

const pagamentos = {
  71: { status: 'awaiting_review', proof_received_at: antigo(11) },
  72: { status: 'awaiting_review', proof_received_at: antigo(9) },
};
const pedidos = [
  { id: 71, status: 'awaiting_review', total: 14.5, customer_name: 'Ana', payments: [pagamentos[71]] },
  { id: 72, status: 'awaiting_review', total: 20, customer_name: 'Bia', payments: [pagamentos[72]] },
];

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getStalePendingOrders: async () => [],
  getOrdersAwaitingReview: async () => pedidos,
  markReviewReminderSent: async (id) => {
    pagamentos[id].status = 'review_reminded';
  },
};

const notify = require(`${PROJECT}/src/bot/notify`);
const enviadas = [];
notify.register(async (phone, texto) => enviadas.push({ phone, texto }));

const watch = require(`${PROJECT}/src/services/pagamentowatch`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  await watch.verificar();

  checar(enviadas.length === 1, 'somente o comprovante com dez minutos gera lembrete');
  checar(enviadas[0].phone === '15550001111', 'o lembrete vai ao dono');
  checar(/71/.test(enviadas[0].texto) && /14\.50/.test(enviadas[0].texto), 'informa pedido e valor');
  checar(/!liberar 71/.test(enviadas[0].texto), 'leva o comando pronto para liberar');
  checar(pagamentos[71].status === 'review_reminded', 'grava que o lembrete ja saiu');

  await watch.verificar();
  checar(enviadas.length === 1, 'nao repete o lembrete no ciclo seguinte');

  watch.stop();
  console.log('\n\x1b[32mreviewwatchtest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
