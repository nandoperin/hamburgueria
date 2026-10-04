/**
 * Refrigerante só em lata (dono, 03/10): "2 xtudo e uma coca 2 litros" anotou
 * a lata — certo —, mas o cliente não ficou sabendo. Agora avisa, e o resto
 * segue igual.
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
  const tel = `155577990${String(++n).padStart(2, '0')}`;
  proxima = { itens };
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return { r: saidas.join('\n---\n'), s: session.get(tel) };
}
const LATA = /Refrigerante só temos em \*lata\*/;

(async () => {
  // A mensagem do print.
  let { r, s } = await falar('2 xtudo e uma coca 2 litros', [X('x_tudo', 2, '2 xtudo'), X('coca_cola', 1, 'uma coca 2 litros')]);
  checar(LATA.test(r), '"uma coca 2 litros": avisa que refrigerante é só lata');
  checar(s.cart.some((l) => l.productId === 'coca_cola') && s.cart.some((l) => l.productId === 'x_tudo') && /Anotei/.test(r),
    '   e anota a coca (lata) e os X Tudo, como antes');

  for (const frase of ['1 guarana 2L', 'coca litrão', 'uma coca KS', 'coca de garrafa', 'uma garrafinha de fanta', 'refri 600ml', 'coca 1,5 litro']) {
    ({ r } = await falar(frase, [X('coca_cola', 1, frase)]));
    checar(LATA.test(r), `"${frase}" avisa`);
  }

  // O que não é tamanho de refrigerante não avisa.
  for (const [frase, itens] of [
    ['uma coca', [X('coca_cola', 1, 'uma coca')]],
    ['2 coca lata', [X('coca_cola', 2, '2 coca lata')]],
    ['um x tudo', [X('x_tudo', 1, 'um x tudo')]],
    ['um lanche e uma coca', [X('coca_cola', 1, 'uma coca')]],
  ]) {
    ({ r } = await falar(frase, itens));
    checar(!LATA.test(r), `"${frase}" não avisa`);
  }

  console.log('\n\x1b[32msolatatest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
