/**
 * Tirar o único item do carrinho (07/11, +16038586854: "Não precisa da coca
 * não"): o bot tirava certo e respondia "Não entendi. Me diz o nome do
 * lanche". Agora avisa que tirou e que o pedido ficou vazio.
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
async function conversa(passos) {
  const tel = `155577995${String(++n).padStart(2, '0')}`;
  let r = '';
  for (const [texto, leitura] of passos) {
    proxima = leitura;
    const saidas = [];
    await router.route(tel, texto, async (t) => saidas.push(t));
    r = saidas.join('\n---\n');
  }
  return { r, s: session.get(tel) };
}
const tirarCoca = ['Nao precisa da coca nao', { correcoes: [{ acao: 'tirar', linha: 'coca_cola', sem: [], com: [], trecho: 'Nao precisa da coca nao' }] }];

(async () => {
  // 07/11 (+16038586854): a coca era o único item; o bot tirou e respondeu "Não entendi".
  let { r, s } = await conversa([
    ['Boa noite', {}],
    ['Vou querer uma coca tambem', { itens: [X('coca_cola', 1, 'uma coca')] }],
    tirarCoca,
  ]);
  checar(!s.cart.length && /Pronto, tirei\. Seu pedido ficou vazio/.test(r) && !/Não entendi/.test(r),
    'tirar o único item: avisa que tirou e que o pedido ficou vazio, sem "Não entendi"');

  // Com outro item, segue como sempre: mostra o carrinho que sobrou.
  ({ r, s } = await conversa([
    ['Boa noite', {}],
    ['1 x burger e uma coca', { itens: [X('x_burger', 1, '1 x burger'), X('coca_cola', 1, 'uma coca')] }],
    tirarCoca,
  ]));
  checar(s.cart.length === 1 && /Anotei/.test(r) && /X Burger/.test(r) && !/ficou vazio/.test(r),
    'tirar um de dois itens: mostra o carrinho como antes');

  // Mensagem sem nada entendido continua com o "Não entendi" de sempre.
  ({ r } = await conversa([['Boa noite', {}], ['blablabla', {}]]));
  checar(/Não entendi/.test(r) && !/ficou vazio/.test(r), 'mensagem sem pedido: "Não entendi" como antes');

  console.log('\n\x1b[32mesvaziartest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
