/** Liberar por valor so e seguro quando ha um unico comprovante com o total. */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.ADMIN_PHONE = '15550001111';

const path = require('path');
const PROJECT = path.resolve(__dirname, '..');
const ADMIN = '15550001111';

const pedidos = [
  { id: 42, status: 'awaiting_review', total: 99, customer_name: 'Pedido por ID', phone: '15550100042', lang: 'pt', order_type: 'pickup', city: 'Everett' },
  { id: 50, status: 'awaiting_review', total: 14.5, customer_name: 'Ana', phone: '15550100050', lang: 'pt', order_type: 'delivery', city: 'Everett' },
  { id: 51, status: 'awaiting_review', total: 14.75, customer_name: 'Bia', phone: '15550100051', lang: 'pt', order_type: 'delivery', city: 'Chelsea' },
  { id: 60, status: 'awaiting_review', total: 20, customer_name: 'Caio', phone: '15550100060', lang: 'pt', order_type: 'delivery', city: 'Malden' },
  { id: 61, status: 'awaiting_review', total: 20, customer_name: 'Dani', phone: '15550100061', lang: 'pt', order_type: 'delivery', city: 'Medford' },
];
const aprovados = [];

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getOrdersAwaitingReview: async () => pedidos.filter((p) => p.status === 'awaiting_review'),
  getOrder: async (id) => pedidos.find((p) => p.id === id) || null,
  approvePayment: async (id) => aprovados.push(id),
  updateOrderStatus: async (id, status) => {
    const pedido = pedidos.find((p) => p.id === id);
    if (pedido) pedido.status = status;
  },
};

const notify = require(`${PROJECT}/src/bot/notify`);
notify.register(async () => true);
const admin = require(`${PROJECT}/src/bot/handlers/admin`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

async function comando(texto) {
  const respostas = [];
  const tratado = await admin.handle(ADMIN, texto, async (x) => respostas.push(x));
  return { tratado, resposta: respostas.join('\n') };
}

(async () => {
  const ponto = await comando('!liberar 14.50');
  checar(ponto.tratado && aprovados.includes(50), 'valor com ponto libera o unico pedido correspondente');

  const virgula = await comando('!liberar 14,75');
  checar(virgula.tratado && aprovados.includes(51), 'valor com virgula tambem funciona');

  const antes = aprovados.length;
  const ambiguo = await comando('!liberar $20.00');
  checar(aprovados.length === antes, 'dois pedidos com o mesmo valor nao liberam nenhum');
  checar(/60/.test(ambiguo.resposta) && /61/.test(ambiguo.resposta), 'a ambiguidade mostra os IDs corretos');

  await comando('!liberar 42');
  checar(aprovados.includes(42), 'numero inteiro continua sendo ID');

  const inexistente = await comando('!liberar 88.88');
  checar(/nenhum/i.test(inexistente.resposta), 'valor sem comprovante correspondente nao libera nada');

  console.log('\n\x1b[32mliberarvalortest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
