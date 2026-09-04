process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.LOG_LEVEL = 'silent';

const assert = require('node:assert/strict');
const tools = require('../src/ai/tools');
const order = require('../src/bot/handlers/order');
const session = require('../src/bot/session');

(async () => {
  const sess = session.get('15551112222');
  Object.assign(sess, { lang: 'pt', state: 'ORDER', orderType: 'pickup', name: 'Fernando' });
  await tools.executar('adicionar_item', {
    item_id: 'x_tudo', quantidade: 1, remover: ['tomate'], acrescentar: ['salsicha'],
  }, sess, async () => {});
  const linha = sess.cart[0];
  const preparo = require('../src/services/preparo-salsicha').definir(sess, {
    item_id: linha.id, modo: 'a_parte',
  });
  assert.equal(preparo.ok, true);

  const resumo = order.summaryLines(sess.cart, 'pt');
  assert.match(resumo, /\*Lanches e produtos\*/);
  assert.match(resumo, /X Tudo \(sem Tomate\) x1 — \$20\.00/);
  assert.match(resumo, /\*Adicionais\*/);
  assert.match(resumo, /Salsicha \(à parte\) x1 — \$1\.00/);
  assert.equal((resumo.match(/Salsicha/g) || []).length, 1, 'adicional aparece uma vez');

  const saidas = [];
  await order.mostrarResumo(sess, async texto => saidas.push(texto));
  assert.match(saidas[0], /X Tudo \(sem Tomate\) x1 — \$20\.00/);
  assert.match(saidas[0], /Salsicha \(à parte\) x1 — \$1\.00/);
  assert.match(saidas[0], /Total: \$21\.00/);

  const dois = session.get('15551112223');
  Object.assign(dois, { lang: 'pt', state: 'ORDER', orderType: 'pickup', name: 'Nando' });
  await tools.executar('adicionar_item', {
    item_id: 'x_tudo', quantidade: 2, acrescentar: ['bacon'],
  }, dois, async () => {});
  const resumoDois = order.summaryLines(dois.cart, 'pt');
  assert.match(resumoDois, /X Tudo x2 — \$40\.00/);
  assert.match(resumoDois, /Bacon x2 — \$8\.00 \(\$4\.00 cada\)/);
  assert.equal(dois.cart[0].price * dois.cart[0].qty, 48, 'carrinho não foi alterado pela apresentação');

  console.log('Resumo separa lanches e adicionais sem duplicar valor.');
})().catch(err => { console.error(err); process.exitCode = 1; });
