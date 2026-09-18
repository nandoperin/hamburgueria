/**
 * Fluxo guiado (Fase 2): a IA só lê, o código decide e responde.
 *
 * A leitora é simulada — cada frase real devolve o formulário que ela deveria
 * devolver (e, em alguns casos, o formulário ERRADO que o modelo poderia
 * devolver), para provar que o validador segura. Router, validador, carrinho e
 * respostas rodam de verdade. As frases são das conversas de 13/09 e 17/09.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';
process.env.FLUXO_GUIADO = 'on';
process.env.ADMIN_PHONE = '15550009999';

const PROJECT = require('path').resolve(__dirname, '..');
require(`${PROJECT}/src/services/schedule`).isOpen = () => true;

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getCustomerByPhone: async () => null, getLastDeliveryOrder: async () => null,
  getUltimoPedidoFeito: async () => null, getActiveOrderByPhone: async () => null,
  upsertCustomer: async (c) => ({ id: 1, ...c }), registrarUsoIA: async () => null,
  getUsoIA: async () => null, registrarConversa: async () => null,
};

// ------------------------------------------------------ a leitora simulada
const VAZIA = {
  itens: [], ambiguos: [], correcoes: [], refazer_lista: false, concluiu_itens: false,
  entrega: null, cidade: null, endereco: null, nome: null, pagamento: null, troco: null,
  confirma_resumo: null, pergunta: null, cancelar: false,
};
const item = (produto, qtd, extra = {}) => ({
  produto, qtd, sem: [], com: [], salsicha: null, ponto_bife: null, maionese_a_parte: false,
  trecho: extra.trecho || produto, ...extra,
});
const RESPOSTAS = new Map();
let leituras = 0;
let conversasDoAgente = 0;
let leitoraFora = false;

const provPath = require.resolve(`${PROJECT}/src/ai/provider`);
const provReal = require(provPath);
require.cache[provPath].exports = {
  ...provReal,
  habilitada: () => true, getProviderName: () => 'mistral', getModelo: () => 'mistral-small-latest',
  get: () => ({
    extrair: async ({ mensagens }) => {
      leituras += 1;
      if (leitoraFora) throw new Error('503');
      const texto = mensagens[0].content.split('Mensagem do cliente:\n')[1];
      const r = RESPOSTAS.has(texto) ? RESPOSTAS.get(texto) : {};
      return { texto: JSON.stringify({ ...VAZIA, ...r }), concluida: true, uso: { tokensIn: 1, tokensOut: 1 } };
    },
    conversar: async () => { conversasDoAgente += 1; return { texto: 'agente', chamadas: [], uso: { tokensIn: 1, tokensOut: 1 } }; },
  }),
};

const notify = require(`${PROJECT}/src/bot/notify`);
const aosAdmins = [];
notify.register(async (phone, texto) => { aosAdmins.push({ phone, texto }); });

const router = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

async function falar(tel, texto) {
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return saidas.join('\n---\n');
}

const linhas = (tel) => session.get(tel).cart.map((l) => `${l.qty}x ${l.productId}`);

(async () => {
  // ---------------------------------- 1. primeira mensagem com pedido inteiro
  console.log('\n\x1b[36m### 1. PEDIDO NA PRIMEIRA MENSAGEM, COM "2 HOT DOG" ###\x1b[0m');
  const A = '15557780001';
  RESPOSTAS.set('boa noite\n1 xtudo\n2 hot dog\n1 coca\npara entrega', {
    itens: [item('x_tudo', 1, { trecho: '1 xtudo' }), item('coca_cola', 1, { trecho: '1 coca' })],
    ambiguos: [{ trecho: '2 hot dog', qtd: 2, opcoes: ['hot_plain', 'hot_simples', 'hot_duplo', 'hot_completo', 'hot_especial', 'hot_tudo'] }],
    entrega: 'entrega',
  });
  let r = await falar(A, 'boa noite\n1 xtudo\n2 hot dog\n1 coca\npara entrega');
  checar(/Bem-vindo/.test(r) && !/O que vai querer hoje/.test(r), 'saudação curta, sem perguntar o que ele já disse');
  checar(/Anotei/.test(r) && /X Tudo/.test(r) && /Coca/.test(r), 'mostra o que anotou');
  checar(/Qual você quer em "2 hot dog"\?/.test(r) && /Hot completo/.test(r), 'pergunta qual hot dog, sem escolher sozinho (R4)');
  checar(linhas(A).join() === '1x x_tudo,1x coca_cola' && session.get(A).orderType === 'delivery',
    'X-Tudo e coca no carrinho, entrega registrada; nenhum hot dog inventado');

  RESPOSTAS.set('completo', { itens: [item('hot_completo', null, { trecho: 'completo' })] });
  r = await falar(A, 'completo');
  checar(linhas(A).includes('2x hot_completo'), 'a resposta "completo" vale os 2 hot dogs perguntados');
  checar(/endereço/i.test(r), 'e a próxima pergunta é o endereço');

  // -------------------------------------- 2. #155: lista reenviada substitui
  console.log('\n\x1b[36m### 2. LISTA REENVIADA SUBSTITUI (#155) ###\x1b[0m');
  const B = '15557780002';
  RESPOSTAS.set('3 x tudo, 2 sem tomate e 1 com banana', {
    itens: [item('x_tudo', 2, { sem: ['tomate'], trecho: '2 sem tomate' }), item('x_tudo', 1, { com: ['banana'], trecho: '1 com banana' })],
  });
  await falar(B, '3 x tudo, 2 sem tomate e 1 com banana');
  checar(linhas(B).join() === '2x x_tudo,1x x_tudo', 'as três unidades, com as variações certas');
  RESPOSTAS.set('não, é 3 x tudo: 2 sem tomate e 1 com banana', {
    refazer_lista: true,
    itens: [item('x_tudo', 2, { sem: ['tomate'], trecho: '2 sem tomate' }), item('x_tudo', 1, { com: ['banana'], trecho: '1 com banana' })],
  });
  await falar(B, 'não, é 3 x tudo: 2 sem tomate e 1 com banana');
  const total = session.get(B).cart.reduce((s, l) => s + l.qty, 0);
  checar(total === 3, 'reenviar a lista não soma: continuam 3 lanches, não 6');

  // ------------------------------------------- 3. #154: "3x bacon" repetido
  console.log('\n\x1b[36m### 3. "3X BACON" NÃO VIRA BACON EXTRA (#154) ###\x1b[0m');
  const C = '15557780003';
  RESPOSTAS.set('3 x bacon', { itens: [item('x_bacon', 3, { trecho: '3 x bacon' })] });
  await falar(C, '3 x bacon');
  // O formulário ERRADO que o modelo poderia devolver: "bacon" como ingrediente.
  RESPOSTAS.set('3x bacon', { itens: [item('bacon', 3, { trecho: '3x bacon' })] });
  await falar(C, '3x bacon');
  const xb = session.get(C).cart.find((l) => l.productId === 'x_bacon');
  checar(xb.qty === 3 && !(xb.added || []).includes('bacon'), 'o nome do lanche repetido não cobra bacon extra');
  const leiturasAntes = leituras;
  r = await falar(C, '3x bacon');
  checar(leituras === leiturasAntes && /Já está anotado/.test(r), 'a mesma mensagem de novo nem chega à IA (R9)');

  // ------------------------------------------ 4. ovo: acréscimo, nunca porção
  console.log('\n\x1b[36m### 4. "COM DOIS OVOS" É ACRÉSCIMO (R1) ###\x1b[0m');
  const D = '15557780004';
  RESPOSTAS.set('2 macarrao na chapa com dois ovos', {
    itens: [item('macarrao_chapa', 2, { trecho: '2 macarrao na chapa' }), item('ovo', 2, { trecho: 'com dois ovos' })],
  });
  await falar(D, '2 macarrao na chapa com dois ovos');
  const mac = session.get(D).cart.find((l) => l.productId === 'macarrao_chapa');
  checar(linhas(D).length === 1 && mac.added.includes('ovo'), 'ovo vai no macarrão; nenhuma porção de ovo avulsa');

  // ---------------------------------------------- 5. cartão e troca de forma
  console.log('\n\x1b[36m### 5. CARTÃO E TROCA DE PAGAMENTO (R3, R11) ###\x1b[0m');
  const E = '15557780005';
  RESPOSTAS.set('1 x burger pra retirar', { itens: [item('x_burger', 1, { trecho: '1 x burger' })], entrega: 'retirada' });
  await falar(E, '1 x burger pra retirar');
  RESPOSTAS.set('vai ser cartão', { pagamento: 'cartao' });
  r = await falar(E, 'vai ser cartão');
  checar(/Não aceitamos cartão/.test(r) && !session.get(E).paymentMethod, 'cartão ouve "cash ou Zelle?" e nada é registrado');
  checar(!/Como prefere pagar/.test(r), 'e a pergunta do pagamento não sai duas vezes');
  session.get(E).name = 'Bia';
  RESPOSTAS.set('zelle', { pagamento: 'zelle' });
  await falar(E, 'zelle');
  checar(session.get(E).paymentMethod === 'zelle', 'Zelle registrado');
  RESPOSTAS.set('pensando bem, vou pagar em dinheiro', { pagamento: 'cash' });
  await falar(E, 'pensando bem, vou pagar em dinheiro');
  checar(session.get(E).paymentMethod === 'cash', 'antes de confirmar, trocar para cash vale');
  RESPOSTAS.set('troco pra 100', { troco: 100 });
  r = await falar(E, 'troco pra 100');
  checar(r === 'Ok 👍' && session.get(E).changeFor == null, 'troco: responde só "Ok", sem registrar nada');

  // -------------------------------------------------- 6. nome inventado
  console.log('\n\x1b[36m### 6. NOME SÓ SE ESTÁ ESCRITO (R10) ###\x1b[0m');
  const F = '15557780006';
  RESPOSTAS.set('1 x tudo retirada', { itens: [item('x_tudo', 1, { trecho: '1 x tudo' })], entrega: 'retirada' });
  await falar(F, '1 x tudo retirada');
  RESPOSTAS.set('Ok', { nome: 'Ana' });
  await falar(F, 'Ok');
  checar(!session.get(F).name, '"Ok" não vira "Ana"');

  // ------------------------------------- 7. maionese à parte, de graça (R13)
  console.log('\n\x1b[36m### 7. MAIONESE À PARTE (R13) ###\x1b[0m');
  const G = '15557780007';
  RESPOSTAS.set('1 x tudo com a maionese a parte', {
    itens: [item('x_tudo', 1, { maionese_a_parte: true, trecho: '1 x tudo com a maionese a parte' })],
  });
  r = await falar(G, '1 x tudo com a maionese a parte');
  const xt = session.get(G).cart[0];
  checar(xt.maioneseAParte && xt.price === 20 && xt.choicesCozinha.includes('maionese à parte'),
    'maionese à parte sai na comanda, sem cobrar nada');
  checar(/maionese à parte/.test(r), 'e aparece no que o cliente lê');

  // --------------------------------------- 8. pergunta fora da lista → equipe
  console.log('\n\x1b[36m### 8. FIADO VAI PARA A EQUIPE ###\x1b[0m');
  const H = '15557780008';
  RESPOSTAS.set('posso pagar amanha?', { pergunta: 'fiado' });
  aosAdmins.length = 0;
  r = await falar(H, 'posso pagar amanha?');
  checar(/chamei a equipe/.test(r) && aosAdmins.some((m) => /pagar amanha/.test(m.texto)),
    'o bot não improvisa: repassa aos admins e avisa o cliente');

  // ------------------------------------------ 9. leitora fora → agente antigo
  console.log('\n\x1b[36m### 9. LEITORA FORA DO AR ###\x1b[0m');
  const I = '15557780009';
  await falar(I, 'oi');
  leitoraFora = true;
  const antes = conversasDoAgente;
  await falar(I, 'quero um x tudo');
  checar(conversasDoAgente > antes, 'sem leitura, o agente de sempre assume — a rede continua armada');
  leitoraFora = false;

  // ------------------------------------------------- 10. interruptor desligado
  console.log('\n\x1b[36m### 10. FLUXO_GUIADO=off ###\x1b[0m');
  process.env.FLUXO_GUIADO = 'off';
  const J = '15557780010';
  await falar(J, 'oi');
  const lidas = leituras;
  await falar(J, 'quero um x tudo');
  checar(leituras === lidas, 'desligado, a leitora não é chamada: produção segue como hoje');

  // ---------------------------------------- 11. troco: só "Ok", sem IA
  console.log('\n\x1b[36m### 11. TROCO RESPONDE OK (QUALQUER FLUXO) ###\x1b[0m');
  const K = '15557780011';
  await falar(K, 'oi');
  for (const frase of ['troco pra 60', 'traz troco pra 50', 'preciso de troco', 'Troco de 100 por favor']) {
    const chamadas = leituras + conversasDoAgente;
    r = await falar(K, frase);
    checar(r === 'Ok 👍' && leituras + conversasDoAgente === chamadas, `"${frase}" → "Ok 👍", sem chamar IA`);
  }

  console.log('\n\x1b[32mguiadotest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
