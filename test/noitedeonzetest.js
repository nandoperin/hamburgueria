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

caso('o "responder" do WhatsApp vai ao modelo marcado, e não vira pedido', async () => {
  const s = preparar({ cart: [linha('x_burger', 'X Burger', 11)], name: 'Fernando' });
  respostas = [{ texto: 'Certo!' }];
  await agente.conversar(s, 'pode ser', send, { citada: 'Entrega ou retirada? — 2 X Tudão e 1 Coca cola' });
  const fala = agente.getHistorico(s.phone).find((m) => m.role === 'user' && m.content.includes('pode ser'));
  assert.equal(fala.content,
    '[O CLIENTE RESPONDEU CITANDO ESTA MENSAGEM: "Entrega ou retirada? — 2 X Tudão e 1 Coca cola"]\npode ser');
  assert.equal(s.cart.length, 1, 'o texto citado não vira produto');
  assert.ok(!s.orderType, 'a citação sozinha não registra nada; quem decide é o modelo');
});

caso('sem citação, a fala vai limpa', async () => {
  const s = preparar({ cart: [linha('x_burger', 'X Burger', 11)] });
  respostas = [{ texto: 'Oi!' }];
  await agente.conversar(s, 'tudo bem?', send);
  assert.ok(agente.getHistorico(s.phone).some((m) => m.role === 'user' && m.content === 'tudo bem?'));
});

caso('"tira esse" com dois lanches pergunta qual; com o nome, tira', async () => {
  const s = preparar({ cart: [linha('x_tudo', 'X Tudo', 20), linha('coca_cola', 'Coca cola', 2)] });
  const vago = await tools.executar('remover_item', { item_id: 'x_tudo' }, s, send, { textoCliente: 'tira esse' });
  assert.ok(vago.bloqueiaFluxo);
  assert.match(vago.resultado, /Pergunte qual/);
  assert.equal(s.cart.length, 2, 'nada saiu do carrinho');

  const claro = await tools.executar('remover_item', { item_id: 'coca_cola' }, s, send, { textoCliente: 'tira a coca' });
  assert.match(claro.resultado, /Removido/);
  assert.equal(s.cart.length, 1);

  const unico = await tools.executar('remover_item', { item_id: 'x_tudo' }, s, send, { textoCliente: 'tira esse' });
  assert.match(unico.resultado, /Removido/, 'com um item só, "tira esse" não é ambíguo');
});

caso('"entrega na verdade, rua tal": corrige o tipo e o endereço junto vale', async () => {
  // Prova real: o modelo chamava só definir_endereco, que era recusado porque
  // o pedido ainda era retirada — e o bot respondia "Retirada, então!".
  const s = preparar({
    cart: [linha('x_tudo', 'X Tudo', 20)], escolhaItensConcluida: true,
    orderType: 'pickup', paymentMethod: 'zelle', name: 'Fernando',
  });
  respostas = [lote(['definir_endereco', { endereco: '17 Fairmount st Everett' }], ['finalizar_pedido', {}])];
  await agente.conversar(s, 'entrega na verdade, 17 Fairmount st Everett', send,
    { citada: 'Entrega ou retirada?' });
  assert.equal(s.orderType, 'delivery');
  assert.equal(s.address, '17 Fairmount st Everett');
  assert.equal(s.city?.label, 'Everett');
  assert.match(enviados.join('\n'), /RESUMO/);
});

caso('"pago na entrega" não vira entrega num pedido de retirada', async () => {
  const s = preparar({ cart: [linha('x_tudo', 'X Tudo', 20)], orderType: 'pickup' });
  assert.equal(tools.tipoCorrigido(s, 'vou pagar na entrega'), null);
  assert.equal(tools.tipoCorrigido(s, 'quanto custa a entrega?'), null);
  assert.equal(tools.tipoCorrigido(s, 'não é entrega'), null);
  assert.equal(tools.tipoCorrigido(s, 'entrega na verdade'), 'delivery');
  assert.equal(tools.tipoCorrigido({ ...s, orderType: 'delivery' }, 'vou retirar aí'), 'pickup');
  assert.equal(tools.tipoCorrigido({ ...s, orderType: 'delivery' }, 'pode mandar'), null);
});

caso('nome citando a pergunta do nome é registrado pelo sistema', async () => {
  const s = preparar({
    cart: [linha('x_tudo', 'X Tudo', 20)], escolhaItensConcluida: true,
    orderType: 'pickup', paymentMethod: 'cash',
  });
  await agente.conversar(s, 'Fernanda', send, { citada: 'Me passa seu nome.' });
  assert.equal(chamadas, 0, 'não gasta o modelo');
  assert.equal(s.name, 'Fernanda');
  assert.equal(s.state, 'CONFIRM');
  assert.match(enviados[0], /RESUMO/);

  // Nome com endereço junto, ou citação de outra pergunta: fica com o modelo.
  const s2 = preparar({ cart: [linha('x_tudo', 'X Tudo', 20)], orderType: 'pickup', paymentMethod: 'cash' });
  respostas = [{ texto: 'Anotado!' }];
  await agente.conversar(s2, 'Fernanda, 17 Fairmount st', send, { citada: 'Me passa seu nome.' });
  assert.ok(!s2.name);

  const s3 = preparar({ cart: [linha('x_tudo', 'X Tudo', 20)], orderType: 'pickup', paymentMethod: 'cash' });
  respostas = [{ texto: 'Anotado!' }];
  await agente.conversar(s3, 'Fernanda', send, { citada: 'Quer algo mais?' });
  assert.ok(!s3.name);
});

caso('"qual o valor do delivery?" com a cidade definida: valor e segue de onde parou', async () => {
  // Caso real: cliente conhecido confirmou o endereço salvo, perguntou o valor
  // da entrega — e o bot jogou o resumo do pedido na tela outra vez.
  const s = preparar({
    cart: [linha('x_tudo', 'X Tudo', 20)], escolhaItensConcluida: true,
    orderType: 'delivery', paymentMethod: 'cash', name: 'Fernando',
    address: '6 Main St', city: { id: 'everett', label: 'Everett', delivery_fee: 5, active: true },
    state: 'CONFIRM',
  });
  await agente.conversar(s, 'qual o valor do delivery?', send);
  assert.equal(chamadas, 0, 'o valor não passa pelo modelo');
  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /A entrega para \*Everett\* é \*\$5\.00\*/);
  assert.match(enviados[0], /confirmar o pedido/i, 'e retoma de onde parou');
  assert.doesNotMatch(enviados[0], /RESUMO DO PEDIDO/);
  assert.equal(s.state, 'CONFIRM');
});

caso('sem cidade, pergunta qual — e o valor sai junto do próximo passo', async () => {
  const s = preparar({ cart: [linha('x_tudo', 'X Tudo', 20)], escolhaItensConcluida: true, orderType: 'delivery', paymentMethod: 'cash' });
  await agente.conversar(s, 'quanto fica a entrega?', send);
  assert.equal(chamadas, 0);
  assert.deepEqual(enviados, ['Qual a cidade?']);
  assert.ok(s.taxaPedida);

  enviados = [];
  await agente.conversar(s, 'Malden', send);
  assert.equal(chamadas, 0, 'a cidade sozinha é registrada pelo código');
  assert.equal(s.city?.label, 'Malden');
  assert.match(enviados[0], /A entrega para \*Malden\* é \*\$7\.00\*/);
  assert.match(enviados[0], /nome e endereço/i, 'com a próxima pergunta junto');
  assert.ok(!s.taxaPedida, 'uma vez só');
});

caso('perguntar o preço de uma cidade não coloca o pedido nela', async () => {
  const s = preparar({ cart: [linha('x_tudo', 'X Tudo', 20)], escolhaItensConcluida: true, orderType: 'delivery', paymentMethod: 'cash', name: 'Ana' });
  await agente.conversar(s, 'quanto é a entrega pra Chelsea?', send);
  assert.equal(chamadas, 0);
  assert.match(enviados[0], /A entrega para \*Chelsea\* é \*\$7\.00\*/);
  assert.match(enviados[0], /Continuamos com \*Chelsea\*\?/);
  assert.ok(!s.city, 'a cidade ainda NÃO entrou no pedido');

  // "não" volta o fluxo para a pergunta anterior.
  enviados = [];
  await agente.conversar(s, 'não', send);
  assert.equal(chamadas, 0);
  assert.ok(!s.city);
  assert.deepEqual(enviados, ['Qual a cidade?']);

  // "sim" registra e o pedido segue.
  enviados = [];
  await agente.conversar(s, 'quanto é a entrega pra Malden?', send);
  assert.match(enviados[0], /Continuamos com \*Malden\*\?/);
  enviados = [];
  await agente.conversar(s, 'sim', send);
  assert.equal(chamadas, 0);
  assert.equal(s.city?.label, 'Malden');
  assert.match(enviados[0], /endereço/i, 'segue pedindo o que falta');
});

caso('cidade nova troca a taxa e pede o endereço de novo', async () => {
  const s = preparar({
    cart: [linha('x_tudo', 'X Tudo', 20)], escolhaItensConcluida: true, orderType: 'delivery',
    paymentMethod: 'cash', name: 'Ana', address: '6 Main St',
    city: { id: 'everett', label: 'Everett', delivery_fee: 5, active: true }, state: 'CONFIRM',
  });
  await agente.conversar(s, 'quanto fica a entrega pra Chelsea?', send);
  assert.match(enviados[0], /Continuamos com \*Chelsea\*\?/);
  enviados = [];
  await agente.conversar(s, 'sim', send);
  assert.equal(s.city?.label, 'Chelsea');
  assert.ok(!s.address, 'endereço de Everett não vale para Chelsea');
  assert.match(enviados[0], /endereço/i);
});

caso('cidade fora da área na pergunta: o modelo recusa', async () => {

  // Cidade que não atendemos não é respondida pelo código: vai para o modelo,
  // que tem a ferramenta de cobertura (e a recusa sai dela).
  const s2 = preparar({ cart: [linha('x_tudo', 'X Tudo', 20)], escolhaItensConcluida: true, orderType: 'delivery', paymentMethod: 'cash', name: 'Ana' });
  respostas = [lote(['definir_cidade', { cidade: 'Boston' }])];
  await agente.conversar(s2, 'quanto é a entrega pra Boston?', send);
  assert.match(enviados.join('\n'), /Ainda não atendemos Boston/);
});

caso('"quanto é a entrega e quanto demora?" fica com o modelo', async () => {
  const s = preparar({
    cart: [linha('x_tudo', 'X Tudo', 20)], orderType: 'delivery', paymentMethod: 'cash',
    city: { id: 'everett', label: 'Everett', delivery_fee: 5, active: true },
  });
  respostas = [{ texto: 'A entrega para Everett é $5.00 e leva cerca de 1h.' }];
  await agente.conversar(s, 'quanto é a entrega e quanto tempo demora pra chegar aqui?', send);
  assert.equal(chamadas, 1, 'pergunta composta: quem responde é o modelo');
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
