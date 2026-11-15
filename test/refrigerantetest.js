/**
 * Conversa de 14/11 (17747322339): "Um Tudo não bacon e duas cocas" com a Coca
 * esgotada virou "Não entendi"; "Retira" fez o bot perguntar de novo
 * "Entrega ou retirada?". E plural de refrigerante ("2 fantas").
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
const availability = require(`${PROJECT}/src/services/availability`);
let esgotados = new Set();
availability.isAvailable = (id) => !esgotados.has(id);

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
const X = (produto, qtd, trecho, sem = []) => ({ produto, qtd, sem, com: [], salsicha: null, ponto_bife: null,
  ponto_bacon: null, maionese_a_parte: false, trecho });
let n = 0;
let tel = '';
async function falar(texto, leitura = {}, novo = false) {
  if (novo || !tel) tel = `155577995${String(++n).padStart(2, '0')}`;
  proxima = leitura;
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return { r: saidas.join('\n---\n'), s: session.get(tel) };
}
const linhas = (s) => s.cart.map((l) => `${l.qty}x ${l.productId || l.id}`).join(' | ');

(async () => {
  // A conversa do print: Coca em falta, a leitora chutou Guaraná.
  esgotados = new Set(['coca_cola']);
  await falar('Oi', {}, true);
  let { r, s } = await falar('Um.  Tudo não bacon e duas cocas',
    { itens: [X('x_tudo', 1, 'Um.  Tudo não bacon', ['bacon']), X('guarana', 2, 'duas cocas')] });
  checar(/Coca-cola\* sem estoque hoje/.test(r) && !/Não entendi/.test(r), 'Coca esgotada: "sem estoque hoje", não "Não entendi"');
  checar(/Temos: Guarana Antártica, Fanta Laranja\./.test(r), '   e as outras bebidas');
  checar(linhas(s) === '1x x_tudo' && !s.cart.some((l) => l.productId === 'guarana'), '   o X Tudo entra, o Guaraná chutado não');

  ({ r, s } = await falar('Retira', { entrega: 'retirada' }));
  checar(s.orderType === 'pickup' && !/Entrega ou retirada\?/.test(r), '"Retira": retirada no balcão, sem perguntar de novo');

  // Coca disponível: plural entra.
  esgotados = new Set();
  await falar('Oi', {}, true);
  ({ s } = await falar('duas cocas', { itens: [X('coca_cola', 2, 'duas cocas')] }));
  checar(linhas(s) === '2x coca_cola', '"duas cocas" com Coca no estoque: 2 Coca-cola');
  await falar('Oi', {}, true);
  ({ s } = await falar('2 fantas', { itens: [X('fanta_laranja', 2, '2 fantas')] }));
  checar(linhas(s) === '2x fanta_laranja', '"2 fantas": 2 Fanta Laranja');

  // Continua barrando o que o cliente não disse.
  await falar('Oi', {}, true);
  ({ r, s } = await falar('duas águas', { itens: [X('guarana', 2, 'duas águas')] }));
  checar(!s.cart.length, '"duas águas" lido como Guaraná: continua não entrando');

  console.log('\n\x1b[32mrefrigerantetest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
