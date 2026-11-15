/**
 * "Boa noite / Gostaria de fazer um pedido", sem lanche (14/11, 16174068211 e
 * 17815266637): boas-vindas completas ou convite, nunca "Não entendi".
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';
process.env.FLUXO_GUIADO = 'on';

const PROJECT = require('path').resolve(__dirname, '..');
const menuProducao = require('./fixtures/menu-producao.json');
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
config.get = (chave) => (chave === 'menu' ? menuProducao : getReal(chave));
require(`${PROJECT}/src/services/schedule`).isOpen = () => true;

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({}, { get: () => async () => null });
require(`${PROJECT}/src/bot/notify`).send = async () => true;

const VAZIA = {
  itens: [], ambiguos: [], correcoes: [], refazer_lista: false, concluiu_itens: false,
  entrega: null, cidade: null, endereco: null, nome: null, pagamento: null, troco: null,
  confirma_resumo: null, pergunta: null, cancelar: false,
};
let proxima = VAZIA;
let leituras = 0;
const provPath = require.resolve(`${PROJECT}/src/ai/provider`);
const provReal = require(provPath);
require.cache[provPath].exports = {
  ...provReal,
  habilitada: () => true, getProviderName: () => 'mistral', getModelo: () => 'mistral-small-latest',
  get: () => ({
    extrair: async () => {
      leituras += 1;
      return { texto: JSON.stringify({ ...VAZIA, ...proxima }), concluida: true, uso: { tokensIn: 1, tokensOut: 1 } };
    },
    conversar: async () => { throw new Error('o agente antigo não deveria ser chamado'); },
  }),
};

const router = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);
const welcome = require(`${PROJECT}/src/bot/handlers/welcome`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}
const X = (produto, qtd, trecho) => ({ produto, qtd, sem: [], com: [], salsicha: null, ponto_bife: null,
  ponto_bacon: null, maionese_a_parte: false, trecho });
let n = 0;
let tel = '';
async function falar(texto, leitura = {}, novo = false) {
  if (novo || !tel) tel = `155577997${String(++n).padStart(2, '0')}`;
  proxima = leitura;
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return { r: saidas.join('\n---\n'), s: session.get(tel) };
}

(async () => {
  const boasVindas = welcome.buildWelcome('pt').split('\n')[0];

  // Primeira mensagem: a do cliente de 14/11.
  let antes = leituras;
  let { r } = await falar('Boa noite \nGostaria de fazer um pedido', {}, true);
  checar(r.includes(boasVindas) && !/Não entendi/.test(r), '"Boa noite / Gostaria de fazer um pedido": boas-vindas completas, sem "Não entendi"');
  checar(leituras === antes, '   sem chamada à IA');
  ({ r } = await falar('Queria fazer um pedido', {}, true));
  checar(r.includes(boasVindas) && !/Não entendi/.test(r), '"Queria fazer um pedido" (17815266637): idem');

  // Depois do "oi": convite.
  await falar('oi', {}, true);
  ({ r } = await falar('quero fazer um pedido'));
  checar(/Claro! Pode mandar seu pedido/.test(r) && !/Não entendi/.test(r), '"oi" e depois "quero fazer um pedido": "Pode mandar seu pedido"');

  // Com lanche: como antes.
  let s;
  ({ r, s } = await falar('Boa noite eu queria fazer o pedido de um xtudo', { itens: [X('x_tudo', 1, 'um xtudo')] }, true));
  checar(s.cart.some((l) => l.productId === 'x_tudo') && !/Claro! Pode mandar seu pedido/.test(r), 'com lanche: entra no pedido, como antes');

  // Texto que não é pedido continua "Não entendi".
  await falar('oi', {}, true);
  ({ r } = await falar('asdfgh'));
  checar(/Não entendi/.test(r), 'texto sem sentido: "Não entendi", como antes');

  console.log('\n\x1b[32mintencaopedidotest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
