process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.LOG_LEVEL = 'silent';
process.env.AI_ENABLED = 'on';
const assert = require('node:assert/strict');
const pedido = require('../src/services/pedido-texto');
const agente = require('../src/ai/agente');
let chamadasIA = 0;
agente.conversar = async () => { chamadasIA++; return true; };
require('../src/services/schedule').isOpen = () => true;
require('../src/bot/vazao').avaliar = () => 'permitir';
const { route } = require('../src/bot/router');
const sessoes = require('../src/bot/session');
const notify = require('../src/bot/notify');
let saidas = [];
const send = async texto => saidas.push(texto);
notify.register(async (_phone, texto) => send(texto));
let serial = 0;
const nova = () => {
  const sess = sessoes.get('1555000' + String(++serial).padStart(4, '0'));
  Object.assign(sess, { lang: 'pt', state: 'MENU', cart: [], menuSelection: { kind: 'items', ids: ['x_tudo'] } });
  saidas = [];
  return sess;
};
(async () => {
  for (const grafia of ['Xtudo', 'X Tudo', 'X-Tudo']) {
    const sess = nova();
    // Percorre menu -> categoria -> pedido, como no print, e não só o parser.
    await route(sess.phone, 'menu', send);
    await route(sess.phone, '1', send);
    await route(sess.phone, `${grafia} sem tomate e xtudo com salsicha extra`, send);
    assert.equal(sess.cart.length, 2);
    assert.deepEqual(sess.cart[0].removed, ['tomate']);
    assert.deepEqual(sess.cart[0].added, []);
    assert.deepEqual(sess.cart[1].added, ['salsicha']);
    assert.deepEqual(sess.cart[1].removed, []);
    assert.equal(sess.cart[0].price, 20);
    assert.equal(sess.cart[1].price, 21);
    assert.equal(sessoes.getSubtotal(sess), 41);
    assert.notEqual(sess.cart[0].id, sess.cart[1].id);
    assert.match(saidas.at(-1), /parte ou junto/);
    assert.equal(sess.menuSelection, null);
    await route(sess.phone, 'junto', send);
    assert.equal(sess.cart[1].preparoSalsicha.modo, 'junto');
    assert.equal(sessoes.getSubtotal(sess), 41);
  }
  assert.equal(chamadasIA, 0);
  process.env.AI_ENABLED = 'off';
  const semIA = nova();
  await route(semIA.phone, 'xtudo sem tomate e xtudo com salsicha extra', send);
  assert.equal(sessoes.getSubtotal(semIA), 41);
  assert.match(saidas.at(-1), /parte ou junto/);
  process.env.AI_ENABLED = 'on';
  const quantidade = nova();
  assert.equal(await pedido.atender(quantidade, 'dois x tudo sem tomate com bacon extra', send), true);
  assert.equal(quantidade.cart[0].qty, 2);
  assert.equal(quantidade.cart[0].price, 24);
  for (const texto of ['nao quero xtudo', 'xtudo?', 'xtudo sem tomate e uma pizza',
    'xtudo com duas salsichas', 'xtudo com bacon e bacon', 'xtudo sem tomate por 1 dolar',
    'xtudo sem tomate entrega em boston', 'xtudo com bacon e um ovo', 'xtudo com cheddar']) {
    const sess = nova();
    assert.equal(await pedido.atender(sess, texto, send), false, texto);
    assert.equal(sess.cart.length, 0, 'frase incerta nao modifica parcialmente');
  }
  const conflito = nova();
  assert.equal(await pedido.atender(conflito, 'xtudo sem tomate com tomate', send), false);
  assert.equal(conflito.cart.length, 0);
  const fechado = nova(); fechado.state = 'PAYMENT_PENDING';
  assert.equal(await pedido.atender(fechado, 'xtudo sem tomate', send), false);
  const semMenu = nova(); semMenu.menuSelection = null;
  assert.equal(await pedido.atender(semMenu, 'xtudo sem tomate', send), false);
  const livre = nova();
  await route(livre.phone, 'xtudo com cheddar', send);
  assert.equal(chamadasIA, 1, 'frase nao suportada continua com a IA');
  console.log('Pedido do print: duas variantes, $41, preparo sem duplicar custo, sem IA e sem aplicacao parcial.');
})().catch(err => { console.error(err); process.exitCode = 1; });
