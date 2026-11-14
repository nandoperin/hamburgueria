/**
 * Pedido duplicado (13/11, 17815021733): "um eggbacon com banana" virou dois
 * Egg Bacon. A rede de lanches "esquecidos pela leitora" passa a considerar o
 * produto que o trecho cita pelo nome inteiro, como a validação faz depois.
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
const provPath = require.resolve(`${PROJECT}/src/ai/provider`);
const provReal = require(provPath);
require.cache[provPath].exports = {
  ...provReal,
  habilitada: () => true, getProviderName: () => 'mistral', getModelo: () => 'mistral-small-latest',
  get: () => ({
    extrair: async () => ({ texto: JSON.stringify({ ...VAZIA, ...proxima }), concluida: true, uso: { tokensIn: 1, tokensOut: 1 } }),
    conversar: async () => { throw new Error('o agente antigo não deveria ser chamado'); },
  }),
};

const router = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}
const X = (produto, qtd, trecho) => ({ produto, qtd, sem: [], com: [], salsicha: null, ponto_bife: null,
  ponto_bacon: null, maionese_a_parte: false, trecho });
let n = 0;
async function falar(texto, itens) {
  const tel = `155577997${String(++n).padStart(2, '0')}`;
  proxima = { itens };
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return { r: saidas.join('\n---\n'), s: session.get(tel) };
}
const comBanana = (produto, trecho) => ({ ...X(produto, 1, trecho), com: ['banana'] });
const linhas = (s) => s.cart.map((l) => `${l.qty}x ${l.id}`).join(' | ');

(async () => {
  // 13/11 (17815021733): a leitora leu "eggbacon" como X Egg Bacon; o nome
  // inteiro corrigiu para Egg Bacon e a rede de "esquecidos" punha outro.
  let { s } = await falar('Quero um eggbacon com banana', [comBanana('xeggbacon', 'um eggbacon com banana')]);
  checar(linhas(s) === '1x egg_bacon:+banana', '"um eggbacon com banana" lido como X Egg Bacon: 1 Egg Bacon com banana, sem duplicar');

  // A rede de "esquecidos" continua pegando o produto que a leitora não leu.
  ({ s } = await falar('Quero um x tudo\nUm macarrão na chapa', [X('x_tudo', 1, 'um x tudo')]));
  checar(s.cart.some((l) => l.productId === 'x_tudo') && s.cart.some((l) => l.productId === 'macarrao_chapa'),
    'linha esquecida pela leitora continua entrando');

  // Leitura certa de primeira: igual a antes.
  ({ s } = await falar('Quero um x egg bacon', [X('xeggbacon', 1, 'um x egg bacon')]));
  checar(linhas(s) === '1x xeggbacon', '"um x egg bacon": 1 X Egg Bacon, como antes');

  console.log('\n\x1b[32meggbacontest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
