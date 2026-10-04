/**
 * "Quero um x-burger para entregar" (dono, 04/10): o bot anotava o lanche e
 * perguntava "Entrega ou retirada?" de novo — a trava de `definirEntrega` só
 * aceitava "entrega", não o verbo.
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
async function falar(texto, leitura) {
  const tel = `155577991${String(++n).padStart(2, '0')}`;
  proxima = leitura;
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return { r: saidas.join('\n---\n'), s: session.get(tel) };
}
const PERGUNTA_TIPO = /Entrega ou retirada\?/;

(async () => {
  for (const frase of ['Quero um x-burger para entregar', 'quero 1 x burger pra entregar', 'Um x burger, entregue por favor',
    'vcs entregam? quero um x burger', 'um x burger pra entrega']) {
    const { r, s } = await falar(frase, { itens: [X('x_burger', 1, frase)], entrega: 'entrega' });
    checar(s.orderType === 'delivery' && !PERGUNTA_TIPO.test(r), `"${frase}": entrega registrada, sem perguntar de novo`);
  }

  // A trava continua: sem falar em entrega, a leitora não decide sozinha.
  const { r, s } = await falar('quero um x burger', { itens: [X('x_burger', 1, 'um x burger')], entrega: 'entrega' });
  checar(!s.orderType && PERGUNTA_TIPO.test(r), '"quero um x burger" (leitora inventou entrega): continua perguntando');

  // Retirada segue igual.
  const p = await falar('um x burger pra retirar', { itens: [X('x_burger', 1, 'um x burger')], entrega: 'retirada' });
  checar(p.s.orderType === 'pickup', '"pra retirar": retirada, como antes');

  console.log('\n\x1b[32mentregartest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
