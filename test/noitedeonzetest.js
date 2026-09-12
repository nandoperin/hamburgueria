/**
 * A noite de 11/09, em três conversas reais.
 *
 * 1. Valentina e Larissa (catálogo): "Retirada" e "Zelle"/"Cash" não viraram
 *    ferramenta — o modelo só conversou — e no nome ele chamou finalizar_pedido
 *    com tudo vazio; o pedido morreu num "Quer algo mais?". Larissa ainda
 *    ouviu "Feito! Seu pedido está pronto" sem pedido nenhum.
 * 2. Herik (8 lanches numa lista): "sem maionese" recusado seis vezes, "3 x
 *    bacon" virou porção de bacon, o teto de rodadas virou "Não entendi" com o
 *    carrinho cheio, e o corte do histórico deixou resultado de ferramenta
 *    órfão — dali em diante toda chamada dava HTTP 400 e ele ouviu "Não
 *    entendi" até desistir.
 */
const assert = require('node:assert/strict');
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';
process.env.LOG_LEVEL = 'silent';
// Curto de propósito: é o corte do histórico que se quer exercitar.
process.env.AI_MAX_TURNOS = '6';

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
  assert.ok(resposta, 'chamada ao modelo que não deveria acontecer');
  if (resposta instanceof Error) throw resposta;
  return { uso: { tokensIn: 1, tokensOut: 1 }, ...resposta };
} });
const session = require('../src/bot/session');
const agente = require('../src/ai/agente');
const tools = require('../src/ai/tools');

let enviados = [];
const send = async (texto) => enviados.push(texto);
let id = 0;
function preparar(dados = {}) {
  const s = session.get(`1555600${String(++id).padStart(4, '0')}`);
  Object.assign(s, { lang: 'pt', state: 'ORDER', cart: [] }, dados);
  enviados = []; chamadas = 0; respostas = [];
  return s;
}
function lote(...lista) {
  return { texto: '', chamadas: lista.map(([nome, argumentos], i) => ({ id: `tool-${i}`, nome, argumentos })) };
}
const linha = (productId, name, price) => ({ id: productId, productId, name, qty: 1, price });
const itens = (s) => s.cart.map((l) => `${l.qty}x ${l.productId || l.id}`).join(', ');
const doCatalogo = (...linhas) => ({ cart: linhas, aguardandoMaisItens: true, maisItensViaIaCatalogo: true });

/** Todo resultado de ferramenta responde a uma chamada ainda no histórico. */
function historicoCoerente(hist) {
  let pendentes = new Set();
  for (const m of hist) {
    if (m.role === 'assistant') pendentes = new Set((m.chamadas || []).map((c) => c.id));
    else if (m.role === 'tool') { if (!pendentes.has(m.tool_call_id)) return false; }
    else pendentes = new Set();
  }
  return true;
}

const casos = [];
const caso = (nome, fn) => casos.push([nome, fn]);

caso('Valentina: "Retirada" e "Zelle" são registrados pelo sistema, sem o modelo', async () => {
  const s = preparar(doCatalogo(linha('x_tudo', 'X Tudo', 20)));
  await agente.conversar(s, 'Retirada', send);
  assert.equal(chamadas, 0);
  assert.equal(s.orderType, 'pickup');
  assert.deepEqual(enviados, ['Como prefere pagar: *Zelle* ou *cash*?']);
  assert.ok(s.escolhaItensConcluida && !s.aguardandoMaisItens, 'quem disse como recebe terminou de escolher');

  enviados = [];
  await agente.conversar(s, 'Zelle', send);
  assert.equal(chamadas, 0);
  assert.equal(s.paymentMethod, 'zelle');
  assert.deepEqual(enviados, ['Me passa seu nome.']);

  enviados = [];
  respostas = [lote(['definir_cadastro', { nome: 'Valentina' }])];
  await agente.conversar(s, 'Valentina', send);
  assert.equal(s.state, 'CONFIRM');
  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /RESUMO/);
  assert.match(enviados[0], /Retirada/);
});

caso('Larissa: "Cash" curto, e "Feito! seu pedido está pronto" não passa sem pedido', async () => {
  const s = preparar(doCatalogo(linha('x_calabresa_bacon', 'X Calabresa Bacon', 19), linha('hot_completo', 'Hot completo', 13)));
  await agente.conversar(s, 'Retirada', send);
  enviados = [];
  await agente.conversar(s, 'Cash', send);
  assert.equal(chamadas, 0);
  assert.equal(s.paymentMethod, 'cash');
  assert.deepEqual(enviados, ['Me passa seu nome.']);

  // O modelo "fecha" de boca, com o nome ainda faltando.
  enviados = [];
  respostas = [{ texto: 'Feito! Seu pedido está pronto pra retirada em cerca de 25 minutos.' }];
  await agente.conversar(s, 'Queria retirar o milho nos dois', send);
  assert.deepEqual(enviados, ['Me passa seu nome.'], 'o sistema pergunta o que falta em vez de repetir a invenção');
  assert.notEqual(s.state, 'CONFIRM');

  // Pergunta de prazo continua sendo respondida.
  enviados = [];
  respostas = [{ texto: 'Seu pedido fica pronto em uns 25 minutos.' }];
  await agente.conversar(s, 'quanto tempo?', send);
  assert.deepEqual(enviados, ['Seu pedido fica pronto em uns 25 minutos.']);
});

caso('resposta curta com outra coisa junto fica com o modelo', async () => {
  const s = preparar(doCatalogo(linha('x_tudo', 'X Tudo', 20)));
  respostas = [{ texto: 'Anotado!' }];
  await agente.conversar(s, 'retirada, e me vê um x tudo', send);
  assert.equal(chamadas, 1);
  assert.ok(!s.orderType, 'nada registrado por fora do modelo');
});

caso('sem produto no carrinho, "retirada" não registra nada', async () => {
  const s = preparar({ state: 'MENU' });
  respostas = [{ texto: 'O que vai querer?' }];
  await agente.conversar(s, 'retirada', send);
  assert.ok(!s.orderType);
});

caso('"retirada e cash" numa mensagem só', async () => {
  const s = preparar({ cart: [linha('x_burger', 'X Burger', 11)], name: 'Fernando' });
  await agente.conversar(s, 'retirada e cash', send);
  assert.equal(chamadas, 0);
  assert.equal(s.orderType, 'pickup');
  assert.equal(s.paymentMethod, 'cash');
  assert.equal(s.state, 'CONFIRM', 'conhecido na retirada vai direto ao resumo');
  assert.match(enviados[0], /RESUMO/);
});

caso('Herik: "sem maionese" não é erro, e "3 x bacon" não é porção de bacon', async () => {
  const s = preparar();
  const r = await tools.executar('adicionar_item', { item_id: 'x_tudao', quantidade: 1, remover: ['maionese', 'tomate'] }, s, send,
    { textoCliente: '1 x tudao (sem maionese e sem tomate)' });
  assert.match(r.resultado, /^Adicionado: 1x X Tudão \(sem Tomate\)/);
  assert.match(r.resultado, /Obs.: maionese não faz parte deste lanche/);
  assert.deepEqual(s.cart[0].removed, ['tomate']);

  const bacon = await tools.executar('adicionar_item', { item_id: 'bacon', quantidade: 3 }, s, send,
    { textoCliente: '3 x bacon (sem maionese)' });
  assert.ok(bacon.bloqueiaFluxo);
  assert.match(bacon.resultado, /ADICIONAL/);
  assert.match(bacon.resultado, /x_bacon \(Bacon Burger\)/);
  assert.equal(itens(s), '1x x_tudao', 'nenhuma porção de bacon entrou');

  const porcao = await tools.executar('adicionar_item', { item_id: 'bacon', quantidade: 1 }, s, send,
    { textoCliente: 'e uma porção de bacon à parte' });
  assert.match(porcao.resultado, /^Adicionado: 1x Bacon/);
});

caso('teto de rodadas com carrinho cheio: "Anotei" e a próxima pergunta, não "Não entendi"', async () => {
  const s = preparar();
  respostas = [
    lote(['adicionar_item', { item_id: 'x_burger' }]),
    ...Array.from({ length: 5 }, () => lote(['definir_entrega', { tipo: 'delivery' }])),
  ];
  await agente.conversar(s, 'um x burger', send);
  assert.equal(chamadas, 6);
  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /^Anotei:\n1x X Burger — \$/);
  assert.match(enviados[0], /Quer algo mais\?/);
  assert.doesNotMatch(enviados[0], /Não entendi/);
});

caso('lista de nomes sem preço é aceita; com preço, a correção é feita uma vez só', async () => {
  const s = preparar();
  respostas = [
    lote(['adicionar_item', { item_id: 'x_burger' }], ['adicionar_item', { item_id: 'coca_cola' }]),
    { texto: 'Anotei:\n- X Burger\n- Coca cola\n\nQuer algo mais?' },
  ];
  await agente.conversar(s, 'um x burger e uma coca', send);
  assert.equal(chamadas, 2);
  assert.match(enviados[0], /^Anotei:\n- X Burger\n- Coca cola/);

  const s2 = preparar();
  respostas = [
    lote(['adicionar_item', { item_id: 'x_burger' }], ['adicionar_item', { item_id: 'coca_cola' }]),
    { texto: 'Anotei:\n- X Burger $11.00\n- Coca cola $2.00\n\nQuer algo mais?' },
    { texto: 'Anotei:\n- X Burger $11.00\n- Coca cola $2.00\n\nQuer algo mais?' },
  ];
  await agente.conversar(s2, 'um x burger e uma coca', send);
  assert.equal(chamadas, 3, 'uma correção, depois aceita');
  assert.equal(enviados.length, 1);
});

caso('o corte do histórico nunca deixa resultado de ferramenta órfão', async () => {
  const s = preparar();
  for (const item of ['x_burger', 'x_tudo', 'coca_cola', 'guarana', 'hot_simples']) {
    respostas = [lote(['adicionar_item', { item_id: item }]), { texto: 'Anotado. Quer algo mais?' }];
    await agente.conversar(s, `quero um ${item.replace('_', ' ')}`, send);
    const hist = agente.getHistorico(s.phone);
    assert.ok(hist.length <= 6, `histórico respeita o teto (${hist.length})`);
    assert.ok(historicoCoerente(hist), `histórico coerente após ${item}`);
  }
  assert.equal(s.cart.length, 5);
});

caso('HTTP 400 descarta o histórico e tenta de novo uma vez', async () => {
  const s = preparar({ cart: [linha('x_burger', 'X Burger', 11)] });
  respostas = [lote(['adicionar_item', { item_id: 'coca_cola' }]), { texto: 'Coca anotada. Quer algo mais?' }];
  await agente.conversar(s, 'uma coca', send);
  const erro = new Error('Bad Request');
  erro.statusCode = 400;
  enviados = []; chamadas = 0;
  respostas = [erro, { texto: 'X Tudo anotado. Quer algo mais?' }];
  const tratou = await agente.conversar(s, 'e um x tudo', send);
  assert.ok(tratou);
  assert.equal(chamadas, 2);
  assert.deepEqual(enviados, ['X Tudo anotado. Quer algo mais?']);
  assert.equal(agente.getHistorico(s.phone).length, 2, 'histórico começou do zero: pergunta e resposta');

  const erro2 = new Error('Bad Request');
  erro2.statusCode = 400;
  enviados = []; chamadas = 0;
  respostas = [erro2, erro2];
  assert.equal(await agente.conversar(s, 'e uma fanta', send), false, 'duas vezes seguidas: desiste desta mensagem');
  assert.equal(chamadas, 2);
});

caso('"Esse" não é nome', async () => {
  const s = preparar({ cart: [linha('x_burger', 'X Burger', 11)], orderType: 'pickup', paymentMethod: 'zelle' });
  const r = await tools.executar('definir_cadastro', { nome: 'Esse' }, s, send, { textoCliente: 'Esse' });
  assert.ok(r.bloqueiaFluxo);
  assert.ok(!s.name);
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
  console.log('\n\x1b[32mnoitedeonzetest: tudo passou.\x1b[0m');
  process.exit(0);
})();
