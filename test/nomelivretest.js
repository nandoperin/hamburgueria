/**
 * A resposta a "Me passa seu nome." é o nome, livre (dono, 26/09).
 *
 * 25/09 21h57: "Ingred" duas vezes, a leitora devolveu nome vazio e o bot
 * repetiu a pergunta até a cliente desistir. Reproduzido com as leituras reais.
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
require.cache[dbPath].exports = new Proxy({ upsertCustomer: async (c) => ({ id: 1, ...c }) },
  { get: (alvo, k) => alvo[k] || (async () => null) });
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
async function falar(tel, texto, leitura) {
  proxima = leitura;
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return saidas.join('\n---\n');
}
const X = (produto, qtd, trecho) => ({ produto, qtd, sem: [], com: [], salsicha: null, ponto_bife: null,
  ponto_bacon: null, maionese_a_parte: false, trecho });

// Até a pergunta do nome, como na conversa real.
async function ateONome(tel) {
  await falar(tel, 'X bacon', { itens: [X('xbacon', 1, 'X bacon')] });
  const r = await falar(tel, 'Ja vou ai fazer a retirada', { entrega: 'retirada' });
  checar(/Me passa seu nome/.test(r), `${tel}: o bot pede o nome`);
}

(async () => {
  // A conversa real: a leitora não leu "Ingred" como nome.
  await ateONome('15557796001');
  let r = await falar('15557796001', 'Ingred', {});
  checar(session.get('15557796001').name === 'Ingred', '"Ingred" é o nome, mesmo com a leitora vazia');
  checar(!/Me passa seu nome/.test(r) && /Cash \(c\)/.test(r), '   e o bot segue para o pagamento');

  // Livre: nome que as travas de palavra recusavam.
  for (const [n, nome] of [[2, 'Stefany'], [3, 'Chelsea'], [4, 'Maria da Silva'], [5, 'Jô'], [6, 'Ap Costa']]) {
    const tel = `1555779600${n}`;
    await ateONome(tel);
    await falar(tel, nome, { nome });
    checar(session.get(tel).name === nome, `"${nome}" é aceito como nome`);
  }

  // Única exceção: o que não é tentativa de nome.
  for (const [n, fala] of [[7, 'Ok'], [8, 'sim'], [9, '??']]) {
    const tel = `1555779601${n}`;
    await ateONome(tel);
    await falar(tel, fala, {});
    checar(!session.get(tel).name, `"${fala}" não vira nome`);
  }

  // Mensagem com outra coisa não é tomada inteira como nome.
  await ateONome('15557796010');
  await falar('15557796010', 'mais uma coca', { itens: [X('coca_cola', 1, 'mais uma coca')] });
  const s = session.get('15557796010');
  checar(!s.name && s.cart.some((l) => l.productId === 'coca_cola'), 'pedido de item no lugar do nome continua sendo item');

  // Fora da pergunta do nome, a regra não age.
  const tel = '15557796011';
  await falar(tel, 'X bacon', { itens: [X('xbacon', 1, 'X bacon')] });
  await falar(tel, 'Ingred', {});
  checar(!session.get(tel).name, 'sem ter perguntado o nome, "Ingred" não vira nome');

  console.log('\n\x1b[32mnomelivretest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
