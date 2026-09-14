/** Regressões das conversas 198 e 199 e das regras comerciais associadas. */
process.env.AI_ENABLED = 'off';

const assert = require('assert/strict');
const tools = require('../src/ai/tools');
const session = require('../src/bot/session');
const menu = require('../src/bot/handlers/menu');

const nada = async () => {};

function nova(telefone) {
  session.clear(telefone);
  const sess = session.get(telefone);
  sess.lang = 'pt';
  sess.state = 'ORDER';
  return sess;
}

(async () => {
  assert.equal(menu.isMenuRequest('Manu'), true,
    'erro de digitação "Manu" continua sendo pedido de menu');

  const pagamento = nova('155501981');
  pagamento.cart = [{ id: 'x_bacon', productId: 'x_bacon', name: 'Bacon Burger', qty: 3, price: 15 }];
  pagamento.orderType = 'pickup';
  pagamento.name = 'Cliente';
  pagamento.state = 'PAYMENT_METHOD';

  let r = await tools.executar('definir_pagamento', { metodo: 'cash' }, pagamento, nada,
    { textoCliente: 'aceita cartão?' });
  assert.equal(r.bloqueiaFluxo, true);
  assert.match(r.resultado, /não aceitamos cartão/i);
  assert.equal(pagamento.paymentMethod, null, 'pergunta sobre cartão não assume cash');

  r = await tools.executar('definir_pagamento', { metodo: 'zelle' }, pagamento, nada,
    { textoCliente: 'aceita Zelle?' });
  assert.equal(r.bloqueiaFluxo, true);
  assert.equal(pagamento.paymentMethod, null, 'pergunta sobre Zelle não escolhe Zelle');

  r = await tools.executar('definir_pagamento', { metodo: 'zelle' }, pagamento, nada,
    { textoCliente: 'Zelle' });
  assert.equal(r.bloqueiaFluxo, undefined);
  assert.equal(pagamento.paymentMethod, 'zelle', 'escolha explícita registra Zelle');

  const correcao = nova('155501991');
  correcao.cart = [{ id: 'x_bacon', productId: 'x_bacon', name: 'Bacon Burger', qty: 3, price: 15 }];
  correcao.orderType = 'delivery';
  correcao.city = { id: 'medford', label: 'Medford', delivery_fee: 9 };
  correcao.address = '96 Water St, Medford';
  correcao.name = 'Cliente';
  correcao.paymentMethod = 'zelle';
  correcao.escolhaItensConcluida = true;

  r = await tools.executar('finalizar_pedido', {}, correcao, nada,
    { textoCliente: 'Não só quero 3 xbacon' });
  assert.equal(r.bloqueiaFluxo, true);
  assert.match(r.resultado, /NÃO finalizado/);
  assert.equal(correcao.state, 'ORDER', 'negação com correção mantém carrinho aberto');
  assert.equal(correcao.cart[0].qty, 3, 'quantidade permanece a final informada');

  correcao.state = 'CONFIRM';
  r = await tools.executar('confirmar_resumo', {}, correcao, nada,
    { textoCliente: 'Não, somente 3 xbacon' });
  assert.equal(r.bloqueiaFluxo, true);
  assert.equal(correcao.state, 'CONFIRM', 'negação nunca confirma o resumo');

  const adicionais = nova('155501992');
  await tools.executar('adicionar_item', { item_id: 'x_tudo' }, adicionais, nada,
    { textoCliente: 'quero um x tudo' });
  r = await tools.executar('adicionar_item', { item_id: 'bacon' }, adicionais, nada,
    { textoCliente: 'quero uma porção de bacon à parte' });
  assert.equal(r.bloqueiaFluxo, true);
  assert.match(r.resultado, /não vendemos porção/i);
  assert.equal(adicionais.cart.some((line) => line.productId === 'bacon'), false,
    'adicional comum nunca fica avulso');

  r = await tools.executar('personalizar_item',
    { item_id: 'x_tudo', acrescentar: ['bacon'] }, adicionais, nada,
    { textoCliente: 'coloca bacon no x tudo' });
  assert.equal(r.bloqueiaFluxo, undefined);
  assert.equal(adicionais.cart.some((line) => (line.added || []).includes('bacon')), true,
    'bacon entra somente junto do produto escolhido');

  const salsicha = nova('155501993');
  r = await tools.executar('adicionar_item', { item_id: 'salsicha' }, salsicha, nada,
    { textoCliente: 'quero uma salsicha à parte' });
  assert.equal(r.bloqueiaFluxo, undefined);
  assert.equal(salsicha.cart.some((line) => line.productId === 'salsicha'), true,
    'salsicha continua sendo a única exceção que pode ir à parte');

  for (const tel of ['155501981', '155501991', '155501992', '155501993']) session.clear(tel);
  console.log('conversas198199test: regras críticas protegidas.');
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
