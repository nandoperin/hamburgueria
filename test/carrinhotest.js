process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.SQUARE_ACCESS_TOKEN = 'faketoken';
process.env.SQUARE_LOCATION_ID = 'FAKELOC';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';

const PROJECT = require('path').resolve(__dirname, '..');

// A entrega esta desligada em producao (fase de testes, so retirada). Esta
// suite prova o caminho dela, entao liga as cidades de proposito.
require('./comentrega').ligar();


const schedulePath = require.resolve(`${PROJECT}/src/services/schedule`);
require(schedulePath);
require.cache[schedulePath].exports.isOpen = () => true;

const pedidos = [];
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getCustomerByPhone: async () => null,
  getLastDeliveryOrder: async () => null,
  getActiveOrderByPhone: async () => null,
  upsertCustomer: async (c) => ({ id: 1, ...c }),
  createOrder: async (o) => { pedidos.push(o); return { id: pedidos.length, ...o }; },
  createPayment: async () => ({ id: 1 }),
};

const zellePath = require.resolve(`${PROJECT}/src/services/zelle`);
require(zellePath);
require.cache[zellePath].exports = {
  // Config de verdade fica em config/pagamento.json, que vem com PREENCHER —
  // e `order.js` se recusa a fechar pedido com ela pela metade, de proposito.
  // Aqui a trocamos por uma valida, para exercitar o fluxo e nao a config.
  conferir: () => ({ ok: true, faltando: [] }),
  configurado: () => true,
  destinatario: () => ({ nome: 'Point Burger', email: 'pay@pointburger.test', telefone: '' }),
  instrucoes: (order) =>
    `Pedido #${order.id} registrado! Total: $${Number(order.total).toFixed(2)}. ` +
    `Envie por Zelle e mande o print do comprovante.`,
  regrasComprovante: () => ({
    exigir: true,
    maxBytes: 5 * 1024 * 1024,
    mimetypes: ['image/jpeg', 'image/png', 'image/webp'],
    bucket: 'comprovantes',
  }),
  prazos: () => ({ lembrete: 10, expira: 30 }),
  estornoAutomatico: () => false,
  estornar: async () => ({ estornou: false, manual: false }),
};

const notify = require(`${PROJECT}/src/bot/notify`);
const { route, routeOrder } = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);

notify.registerRich({ sendButtons: async () => {}, sendList: async () => [] });
notify.register(async () => {});
const enviar = async () => {};

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  console.log('\n\x1b[33m### CARRINHO DO CATALOGO APOS PEDIDO FECHADO ###\x1b[0m');

  const TEL = '15558880001';
  session.clear(TEL);

  // Pedido 1, pelo fluxo de texto, ate o link de pagamento.
  await route(TEL, 'Oi', enviar);
  await route(TEL, 'ot:pickup', enviar);
  await route(TEL, 'sanduiches', enviar);
  await route(TEL, '1', enviar);
  await route(TEL, 'finalizar', enviar);
  await route(TEL, 'Fernando Perin', enviar);
  await route(TEL, 'sim', enviar);

  const s = session.get(TEL);
  checar(s.state === 'PAYMENT_PENDING', 'pedido 1 fechado, link enviado');
  checar(s.cart.length === 0, 'o carrinho e esvaziado quando o pedido vai para o banco');
  const total1 = pedidos[0].items.reduce((a, i) => a + i.qty, 0);
  checar(total1 === 1, 'pedido 1 saiu com 1 item');

  // Agora o cliente toca no icone do catalogo e manda um item novo.
  await routeOrder(TEL, {
    source: 'meta',
    externalOrderId: 'carrinho-pedido-2',
    items: [{ productId: 'guarana', quantity: 1, externalProductId: 'guarana' }],
  }, enviar);

  const s2 = session.get(TEL);
  checar(
    s2.cart.length === 1 && s2.cart[0].id === 'guarana',
    'o carrinho novo tem so o Guarana — nao soma com o pedido anterior'
  );
  checar(s2.name === 'Fernando Perin', 'mas o cadastro e preservado');
  checar(s2.state === 'ORDER' && s2.aguardandoMaisItens, 'pedido novo pergunta se quer algo mais');
  await route(TEL, 'não', enviar);
  checar(s2.state === 'ORDER_TYPE', 'depois pergunta entrega/retirada');

  // Fecha o segundo para conferir o total.
  await route(TEL, 'ot:pickup', enviar);
  await route(TEL, 'finalizar', enviar);
  await route(TEL, 'sim', enviar);

  const total2 = pedidos[1].items.reduce((a, i) => a + i.qty, 0);
  checar(total2 === 1, 'pedido 2 saiu com 1 item, nao 2');
  console.log('   pedido 1: ' + pedidos[0].items.map(i=>i.name).join(', '));
  console.log('   pedido 2: ' + pedidos[1].items.map(i=>i.name).join(', '));

  console.log('\n\x1b[32mTodos os cenarios passaram.\x1b[0m');
})().catch((e) => {
  console.error('\n\x1b[31mFALHOU:\x1b[0m', e.message);
  process.exit(1);
});
