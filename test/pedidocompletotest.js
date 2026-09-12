/**
 * O pedido inteiro numa mensagem: "um x burger pra entrega, pago em cash".
 *
 * Produto, quantidade, entrega e pagamento de uma vez. Nas provas com o
 * modelo real ele registrava entrega e pagamento e pulava o produto: o
 * pagamento era recusado (carrinho vazio), ele dizia "Cash registrado!" mesmo
 * assim, e a conversa se perdia. Aqui o código registra o produto que o
 * modelo pulou, não pergunta "Quer algo mais?" a quem já disse como recebe, e
 * pergunta só o que falta — cliente conhecido continua confirmando o endereço.
 */
const assert = require('node:assert/strict');
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';
process.env.LOG_LEVEL = 'silent';

const db = require('../src/db/queries');
Object.assign(db, {
  getCustomerByPhone: async () => null,
  getLastDeliveryOrder: async () => null,
  getUltimoPedidoFeito: async () => null,
  registrarUsoIA: async () => null,
  getUsoIA: async () => null,
});
require('../src/services/schedule').isOpen = () => true;
require('./comentrega').ligar();
const provider = require('../src/ai/provider');
let respostas = [];
let chamadas = 0;
provider.habilitada = () => true;
provider.getModelo = () => 'mistral-small-latest';
provider.get = () => ({ conversar: async () => {
  chamadas++;
  const resposta = respostas.shift();
  assert.ok(resposta, 'o fluxo não deveria gastar mais uma chamada do modelo');
  return { uso: { tokensIn: 1, tokensOut: 1 }, ...resposta };
} });
const session = require('../src/bot/session');
const agente = require('../src/ai/agente');
const tools = require('../src/ai/tools');
const pedidoTexto = require('../src/services/pedido-texto');

let enviados = [];
const send = async (texto) => enviados.push(texto);
let id = 0;
function preparar(dados = {}) {
  const s = session.get(`1555700${String(++id).padStart(4, '0')}`);
  Object.assign(s, { lang: 'pt', state: 'ORDER', cart: [] }, dados);
  enviados = []; chamadas = 0; respostas = [];
  return s;
}
function lote(...lista) {
  return { texto: '', chamadas: lista.map(([nome, argumentos], i) => ({ id: `tool-${i}`, nome, argumentos })) };
}
const itens = (s) => s.cart.map((l) => `${l.qty}x ${l.productId || l.id}`).join(', ');
const CONHECIDO = { name: 'Fernando', lastAddress: '6 Main St', lastCityId: 'everett' };
const PEDIDO = 'um x burger pra entrega, pago em cash';
const PULOU_O_PRODUTO = () => lote(['definir_entrega', { tipo: 'delivery' }], ['definir_pagamento', { metodo: 'cash' }]);

const casos = [];
const caso = (nome, fn) => casos.push([nome, fn]);

caso('novo: o sistema registra o produto que o modelo pulou e pede nome e endereço', async () => {
  const s = preparar();
  respostas = [PULOU_O_PRODUTO()];
  await agente.conversar(s, PEDIDO, send);
  assert.equal(itens(s), '1x x_burger');
  assert.equal(s.orderType, 'delivery');
  assert.equal(s.paymentMethod, 'cash');
  assert.deepEqual(enviados, ['Me passa seu nome e endereço de entrega.']);
  assert.ok(!s.aguardandoMaisItens, 'quem já disse como recebe não ouve "Quer algo mais?"');
  assert.equal(chamadas, 1);
});

caso('conhecido: continua confirmando o endereço salvo antes do resumo', async () => {
  const s = preparar(CONHECIDO);
  respostas = [PULOU_O_PRODUTO()];
  await agente.conversar(s, PEDIDO, send);
  assert.equal(itens(s), '1x x_burger');
  assert.deepEqual(enviados, ['Entrego em 6 Main St, Everett?']);
  assert.equal(s.state, 'ORDER', 'não pula para o resumo');

  enviados = [];
  respostas = [lote(['definir_endereco', { endereco: '6 Main St, Everett' }], ['finalizar_pedido', {}])];
  await agente.conversar(s, 'sim', send);
  assert.equal(s.state, 'CONFIRM');
  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /RESUMO/);
  assert.match(enviados[0], /X Burger x1/);
  assert.match(enviados[0], /Everett/);
});

caso('modelo que registra tudo certo não ganha produto em dobro', async () => {
  const s = preparar();
  respostas = [lote(
    ['adicionar_item', { item_id: 'x_burger' }],
    ['definir_entrega', { tipo: 'delivery' }],
    ['definir_pagamento', { metodo: 'cash' }],
  )];
  await agente.conversar(s, PEDIDO, send);
  assert.equal(itens(s), '1x x_burger');
  assert.deepEqual(enviados, ['Me passa seu nome e endereço de entrega.']);
  assert.ok(!s.aguardandoMaisItens);
});

caso('modelo que pula e depois repete o produto na mesma mensagem: continua 1x', async () => {
  const s = preparar();
  respostas = [
    lote(['definir_entrega', { tipo: 'delivery' }], ['definir_cadastro', { nome: 'Cliente' }]),
    lote(['adicionar_item', { item_id: 'x_burger' }]),
    { texto: 'Me passa seu nome e endereço de entrega.' },
  ];
  await agente.conversar(s, PEDIDO, send);
  assert.equal(itens(s), '1x x_burger');
});

caso('produto e pagamento sem dizer como recebe: guarda o cash e pergunta só isso', async () => {
  const s = preparar();
  respostas = [lote(['adicionar_item', { item_id: 'x_burger' }], ['definir_pagamento', { metodo: 'cash' }])];
  await agente.conversar(s, 'um x burger, pago em cash', send);
  assert.equal(s.paymentMethod, 'cash');
  assert.deepEqual(enviados, ['Entrega ou retirada?']);

  enviados = [];
  respostas = [lote(['definir_entrega', { tipo: 'delivery' }])];
  await agente.conversar(s, 'entrega', send);
  assert.deepEqual(enviados, ['Me passa seu nome e endereço de entrega.'], 'não pergunta de novo Zelle ou cash');
});

caso('"2 x-tudo pra retirada, pago no zelle": quantidade e produto do texto', async () => {
  const s = preparar();
  respostas = [lote(['definir_entrega', { tipo: 'pickup' }], ['definir_pagamento', { metodo: 'zelle' }])];
  await agente.conversar(s, '2 x-tudo pra retirada, pago no zelle', send);
  assert.equal(itens(s), '2x x_tudo');
  assert.equal(s.paymentMethod, 'zelle');
  assert.deepEqual(enviados, ['Me passa seu nome.']);
});

caso('o inverso: modelo registra o lanche e pula retirada e pagamento', async () => {
  // Prova real de 11/09: só adicionar_item, e o modelo respondia "Quer algo mais?".
  const s = preparar();
  respostas = [lote(['adicionar_item', { item_id: 'x_tudo', quantidade: 2 }])];
  await agente.conversar(s, '2 x tudo pra retirada, pago no zelle', send);
  assert.equal(itens(s), '2x x_tudo');
  assert.equal(s.orderType, 'pickup');
  assert.equal(s.paymentMethod, 'zelle');
  assert.deepEqual(enviados, ['Me passa seu nome.']);
  assert.equal(chamadas, 1, 'sem outra rodada do modelo para perguntar "Quer algo mais?"');
  const hist = agente.getHistorico(s.phone);
  assert.ok(hist.some((m) => m.role === 'tool' && /Registrado pelo sistema/.test(m.content)),
    'o histórico do modelo sabe o que o sistema registrou');
  assert.ok(!hist.some((m) => m.role === 'tool' && !m.tool_call_id), 'sem resposta de ferramenta que o modelo não chamou');
});

caso('o inverso, conhecido na retirada: vai ao resumo como já ia', async () => {
  const s = preparar({ name: 'Fernando' });
  respostas = [lote(['adicionar_item', { item_id: 'x_tudo', quantidade: 2 }])];
  await agente.conversar(s, '2 x tudo pra retirada, pago no zelle', send);
  assert.equal(s.state, 'CONFIRM');
  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /RESUMO/);
  assert.match(enviados[0], /Retirada/);
});

caso('modelo registra lanche e entrega e pula só o pagamento', async () => {
  const s = preparar();
  respostas = [lote(['adicionar_item', { item_id: 'x_burger' }], ['definir_entrega', { tipo: 'delivery' }])];
  await agente.conversar(s, PEDIDO, send);
  assert.equal(s.paymentMethod, 'cash');
  assert.deepEqual(enviados, ['Me passa seu nome e endereço de entrega.']);
});

caso('pergunta, negação e os dois tipos juntos ficam com o modelo', async () => {
  const s = preparar({ cart: [{ id: 'x_burger', productId: 'x_burger', name: 'X Burger', qty: 1, price: 12 }] });
  assert.deepEqual(tools.logisticaPulada(s, 'um x burger, vocês entregam em everett?'), []);
  assert.deepEqual(tools.logisticaPulada(s, 'um x burger, não é pra entrega'), []);
  assert.deepEqual(tools.logisticaPulada(s, 'um x burger, entrega ou retirada tanto faz'), []);
  assert.deepEqual(tools.logisticaPulada(s, 'um x burger, pode retirar o tomate'), []);
  assert.deepEqual(tools.logisticaPulada(s, 'um x burger pra entrega'), [['definir_entrega', { tipo: 'delivery' }]]);
  assert.deepEqual(tools.logisticaPulada({ ...s, lang: 'en' }, 'one x burger for delivery, cash'), []);
  assert.deepEqual(tools.logisticaPulada({ ...s, cart: [] }, 'pra entrega, cash'), [], 'sem produto, nada');
});

caso('fluxo normal do conhecido: endereço salvo primeiro, pagamento por último', async () => {
  const s = preparar({ ...CONHECIDO, escolhaItensConcluida: true,
    cart: [{ id: 'x_burger', productId: 'x_burger', name: 'X-Burger', qty: 1, price: 11 }] });
  await agente.conversar(s, 'entrega', send);
  assert.deepEqual(enviados, ['Entrego em 6 Main St, Everett?']);

  enviados = [];
  respostas = [lote(['definir_endereco', { endereco: '6 Main St, Everett' }])];
  await agente.conversar(s, 'sim', send);
  assert.deepEqual(enviados, ['Como prefere pagar: *Zelle* ou *cash*?'], 'o pagamento é a última pergunta');

  enviados = [];
  await agente.conversar(s, 'cash', send);
  assert.equal(s.paymentMethod, 'cash');
  assert.equal(s.state, 'CONFIRM');
  assert.match(enviados[0], /RESUMO/);
});

caso('texto que a leitura conservadora não entende: nada é adivinhado', async () => {
  const s = preparar();
  const r = await tools.executar('definir_pagamento', { metodo: 'cash' }, s, send,
    { textoCliente: 'um daqueles lanches pra entrega, pago em cash' });
  assert.equal(s.cart.length, 0);
  assert.ok(r.bloqueiaFluxo);
  assert.match(r.resultado, /carrinho está vazio/);
  assert.match(r.resultado, /adicionar_item/, 'a recusa diz o que fazer');
});

caso('"retirar o tomate" é ingrediente, não retirada: "Quer algo mais?" continua', async () => {
  const s = preparar();
  respostas = [
    lote(['adicionar_item', { item_id: 'x_burger', remover: ['tomate'] }]),
    { texto: 'Anotado! Quer algo mais?' },
  ];
  await agente.conversar(s, 'um x burger, pode retirar o tomate', send);
  assert.equal(s.cart.length, 1);
  assert.ok(s.aguardandoMaisItens);
  assert.ok(!s.escolhaItensConcluida);
});

caso('conversa em inglês fica com o modelo', async () => {
  const s = preparar({ lang: 'en' });
  await tools.executar('definir_entrega', { tipo: 'delivery' }, s, send,
    { textoCliente: 'um x burger pra entrega' });
  assert.equal(s.cart.length, 0);
});

caso('recusas explicam o motivo', async () => {
  const s = preparar();
  for (const nome of ['definir_cidade', 'definir_endereco', 'definir_cadastro']) {
    const r = await tools.executar(nome, { cidade: 'Everett', endereco: '6 Main St', nome: 'Ana' }, s, send);
    assert.match(r.resultado, /carrinho está vazio/, nome);
    assert.match(r.resultado, /adicionar_item/, nome);
  }
  s.cart = [{ id: 'x_burger', productId: 'x_burger', name: 'X-Burger', qty: 1, price: 11 }];
  const invalido = await tools.executar('definir_pagamento', { metodo: 'pix' }, s, send, { textoCliente: 'pix' });
  assert.ok(invalido.bloqueiaFluxo);
  assert.ok(!s.paymentMethod, 'método fora da lista não vira cash');
});

caso('leitura do texto: "2 x tudo" é 2 X-Tudo, "2x tudo" fica com o modelo', async () => {
  const quantos = (texto) => pedidoTexto.interpretar(texto)?.map((p) => `${p.quantidade}x ${p.item.id}`).join(', ') || null;
  assert.equal(quantos('2 x tudo'), '2x x_tudo');
  assert.equal(quantos('2 x-tudo'), '2x x_tudo');
  assert.equal(quantos('2x x-tudo'), '2x x_tudo');
  assert.equal(quantos('2 xtudo'), '2x x_tudo');
  assert.equal(quantos('2x tudo'), null);
});

(async () => {
  for (const [nome, fn] of casos) {
    try {
      await fn();
      console.log(`\x1b[32m   OK: ${nome}\x1b[0m`);
    } catch (err) {
      console.error(`\x1b[31m   FALHOU: ${nome}\n${err.stack || err.message}\x1b[0m`);
      process.exit(1);
    }
  }
  console.log('\n\x1b[32mpedidocompletotest: tudo passou.\x1b[0m');
  process.exit(0);
})();
