/**
 * "No macarrão" como resposta ao preparo da salsicha (08/10, 17816057607): o
 * bot repetiu "vai à parte ou junto?" oito vezes. Citar o próprio produto que
 * leva a salsicha é "junto".
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
const A = (linha, com, trecho) => ({ acao: 'alterar', linha, com, sem: [], trecho });
let n = 0;
const PERGUNTA = /A salsicha adicional do .+ vai à parte ou junto/;

// Monta o carrinho até a pergunta do preparo e devolve a resposta à `resposta`.
async function responder(produto, pedido, resposta) {
  const tel = `155577992${String(++n).padStart(2, '0')}`;
  const falar = async (texto, leitura) => {
    proxima = leitura;
    const saidas = [];
    await router.route(tel, texto, async (t) => saidas.push(t));
    return saidas.join('\n---\n');
  };
  await falar(pedido, { itens: [X(produto, 1, pedido)] });
  const pergunta = await falar('com salsicha extra', { correcoes: [A(produto, ['salsicha'], 'com salsicha extra')] });
  checar(PERGUNTA.test(pergunta), `${produto}: pergunta o preparo da salsicha`);
  const r = await falar(resposta, {});
  return { r, s: session.get(tel) };
}
const junto = (s) => s.cart.some((l) => l.preparoSalsicha?.modo === 'junto');

(async () => {
  // As respostas da cliente de 08/10.
  for (const frase of ['No macarrão', 'No macarrão na chapa', 'Adiciona no macarrão', 'junto com o macarrao', 'no macarrão por favor']) {
    const { r, s } = await responder('macarrao_chapa', 'Macarrão na chapa', frase);
    checar(junto(s) && !PERGUNTA.test(r), `"${frase}": salsicha junto, sem repetir a pergunta`);
  }
  const xt = await responder('x_tudo', 'um x tudo', 'no x-tudo');
  checar(junto(xt.s) && !PERGUNTA.test(xt.r), '"no x-tudo" no X Tudo: junto');

  // O que já funcionava continua igual.
  const parte = await responder('macarrao_chapa', 'Macarrão na chapa', 'à parte');
  checar(parte.s.cart.some((l) => l.preparoSalsicha?.modo === 'a_parte'), '"à parte": continua à parte');
  const j = await responder('macarrao_chapa', 'Macarrão na chapa', 'junto');
  checar(junto(j.s), '"junto": continua junto');

  // Outro produto, ou o nome sozinho, não é resposta.
  const outro = await responder('macarrao_chapa', 'Macarrão na chapa', 'no x bacon');
  checar(!junto(outro.s) && PERGUNTA.test(outro.r), '"no x bacon" com salsicha no macarrão: continua perguntando');
  const so = await responder('macarrao_chapa', 'Macarrão na chapa', 'macarrão');
  checar(!junto(so.s), '"macarrão" sozinho não decide');

  console.log('\n\x1b[32msalsichanoprodutotest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
