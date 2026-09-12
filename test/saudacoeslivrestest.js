process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = 'postgresql://fake';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';

const assert = require('node:assert/strict');
const { ehSoSaudacao } = require('../src/services/saudacao');
const db = require('../src/db/queries');
let conhecido = false;
Object.assign(db, {
  getCustomerByPhone: async () => conhecido ? { id: 1, name: 'Ana', lang: 'pt' } : null,
  getLastDeliveryOrder: async () => null,
  getUltimoPedidoFeito: async () => null,
  registrarUsoIA: async () => null,
  getUsoIA: async () => null,
  createOrder: async () => { throw new Error('saudação não cria pedido'); },
  updateOrderStatus: async () => { throw new Error('saudação não altera pedido'); },
});
require('../src/services/schedule').isOpen = () => true;
const provider = require('../src/ai/provider');
const chamadas = [];
provider.habilitada = () => true;
provider.getModelo = () => 'mistral-small-latest';
provider.get = () => ({ conversar: async ({ mensagens }) => {
  chamadas.push([...mensagens].reverse().find(m => m.role === 'user')?.content);
  return { texto: 'Oi! Pode dizer seu pedido.', chamadas: [], uso: { tokensIn: 1, tokensOut: 1 } };
} });
const notify = require('../src/bot/notify');
notify.registerRich({ catalogLink: () => 'https://wa.me/c/15550000000' });
const session = require('../src/bot/session');
const router = require('../src/bot/router');
const agente = require('../src/ai/agente');
let contador = 0;
function preparar(state = 'LANGUAGE') {
  chamadas.length = 0;
  require('../src/ai/custo')._zerar();
  const sess = session.get(`1555900${String(++contador).padStart(4, '0')}`);
  Object.assign(sess, { state, lang: 'pt', cart: [], greeted: state !== 'LANGUAGE' });
  return sess;
}
async function falar(sess, texto) {
  const saidas = [];
  notify.register(async (_phone, texto) => saidas.push(texto));
  await router.route(sess.phone, texto, async t => saidas.push(t));
  return saidas;
}

(async () => {
  const saudacoes = ['ei', 'Ei!', 'eiii', 'oiii', 'OLÁ!!!', 'opa', 'e aí', 'eae',
    'alô', 'salve', 'fala', 'bom dia', 'boaa noitee', 'boa tarde pessoal',
    'ei, tudo bem?', 'oi, tudo joia', 'opa blz', 'olá\nboa noite',
    'tudo bem por aí?', '👋', '👋🏽', 'Ei 👋', 'hi', 'hello', 'hey',
    'hola', 'buenos días', 'buenas tardes', 'buenas noches'];

  // Novo e conhecido recebem a mesma saudação aprovada, sem "não entendi"
  // nem segundo balão, e o histórico da IA já inclui essa resposta.
  for (const cadastrado of [false, true]) {
    conhecido = cadastrado;
    for (const texto of saudacoes) {
      assert(ehSoSaudacao(texto), texto);
      const sess = preparar();
      const saidas = await falar(sess, texto);
      assert.equal(saidas.length, 1, texto);
      assert.match(saidas[0], cadastrado ? /Oi, Ana/ : /Bem-vindo ao Point Burger/);
      assert.match(saidas[0], /Abra o menu digital, clique!/);
      assert.match(saidas[0], /https:\/\/wa\.me\/c\/15550000000/);
      assert.doesNotMatch(saidas[0], /Não entendi|RESUMO|Sanduíches/);
      assert.equal(chamadas.length, 0);
      assert.equal(sess.state, 'MENU');
      assert.equal(sess.cart.length, 0);
      assert(agente.getHistorico(sess.phone).some(m => m.role === 'assistant' && m.content === saidas[0]));
    }
  }

  // Se já abriu o menu, o filtro de texto aleatório deixa a saudação passar
  // para a IA real do fluxo (provedor simulado, sem gastar créditos).
  for (const texto of ['ei', 'eiii', 'oiii', 'e aí', 'alô', '👋🏽']) {
    const sess = preparar('MENU');
    const saidas = await falar(sess, texto);
    assert.deepEqual(chamadas, [texto]);
    assert.deepEqual(saidas, ['Oi! Pode dizer seu pedido.']);
    assert.equal(sess.cart.length, 0);
  }

  // Uma compra ou dúvida junto do cumprimento nunca fica engolida.
  conhecido = false;
  for (const texto of ['ei, quero uma coca', 'oiii, quero 2 x tudo sem tomate',
    'ei, qual o valor da entrega?', 'alô, vocês estão abertos?']) {
    assert.equal(ehSoSaudacao(texto), false, texto);
    const sess = preparar();
    await falar(sess, texto);
    assert.equal(chamadas[0], texto, 'mensagem inteira chega à IA antes das validações normais do pedido');
  }

  for (const texto of ['asdfgh', 'xpto123', '123456', '🍔', 's', 'n', 'menu',
    'ei cancelar', 'ei, meu pedido não chegou', 'ei, tira o tomate']) {
    assert.equal(ehSoSaudacao(texto), false, texto);
  }
  const vazio = preparar('MENU');
  assert.match((await falar(vazio, 'asdfgh')).join('\n'), /Não entendi/);
  assert.equal(chamadas.length, 0, 'texto aleatório continua bloqueado');

  const menu = preparar();
  assert.match((await falar(menu, 'menu')).join('\n'), /Cardápio.*categoria/);
  assert.equal(menu.menuSelection.kind, 'categories');

  // Cumprimento durante a montagem vai à IA, sem reiniciar o carrinho.
  const carrinho = preparar('ORDER');
  carrinho.cart = [{ id: 'x_tudo', productId: 'x_tudo', name: 'X Tudo', price: 20, qty: 1 }];
  const antes = JSON.stringify(carrinho.cart);
  await falar(carrinho, 'ei');
  assert.deepEqual(chamadas, ['ei']);
  assert.equal(JSON.stringify(carrinho.cart), antes);
  assert.equal(carrinho.state, 'ORDER');
  console.log('Saudações livres, menu e mensagem com pedido preservados: passaram.');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
