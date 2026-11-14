/**
 * "Retirar" com produto do carrinho é tirar do pedido, e "me manda o valor"
 * mostra o total (13/11, 17815021733).
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
let tel = '';
async function falar(texto, leitura = {}, novo = false) {
  if (novo || !tel) tel = `155577998${String(++n).padStart(2, '0')}`;
  proxima = leitura;
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return { r: saidas.join('\n---\n'), s: session.get(tel) };
}
const linhas = (s) => s.cart.map((l) => `${l.qty}x ${l.id}`).join(' | ');

(async () => {
  // 13/11 (17815021733): "Quero retirar 2 eggbacon" virou retirada no balcão
  // e mais 2 lanches. Com o produto no carrinho, "retirar" é tirar.
  await falar('Boa noite', {}, true);
  await falar('3 egg bacon', { itens: [X('egg_bacon', 3, '3 egg bacon')] });
  let { r, s } = await falar('Quero retirar 2 eggbacon', { entrega: 'retirada' });
  checar(linhas(s) === '1x egg_bacon' && !s.orderType, '"retirar 2 eggbacon" com 3: fica 1, e não vira retirada no balcão');
  ({ r, s } = await falar('retira o egg bacon', { entrega: 'retirada' }));
  checar(!s.cart.length && /ficou vazio/.test(r), '"retira o egg bacon" sem número: tira todos');

  // Com e sem banana: tira primeiro o que não tem alteração.
  await falar('Boa noite', {}, true);
  await falar('2 egg bacon, 1 com banana', { itens: [X('egg_bacon', 1, '2 egg bacon'), { ...X('egg_bacon', 1, '1 com banana'), com: ['banana'] }] });
  ({ s } = await falar('retirar 1 egg bacon', { entrega: 'retirada' }));
  checar(linhas(s) === '1x egg_bacon:+banana', '"retirar 1" com um normal e um com banana: sai o normal');

  // "vou retirar" continua sendo retirada no balcão; carrinho vazio também.
  await falar('Boa noite', {}, true);
  await falar('1 x tudo', { itens: [X('x_tudo', 1, '1 x tudo')] });
  ({ s } = await falar('vou retirar 1 x tudo', { entrega: 'retirada' }));
  checar(s.orderType === 'pickup' && s.cart.some((l) => l.productId === 'x_tudo'), '"vou retirar 1 x tudo": retirada no balcão, como antes');
  await falar('Boa noite', {}, true);
  ({ s } = await falar('quero retirar 1 x tudo', { entrega: 'retirada', itens: [X('x_tudo', 1, '1 x tudo')] }));
  checar(s.orderType === 'pickup' && linhas(s) === '1x x_tudo', 'carrinho vazio: "quero retirar 1 x tudo" é pedido com retirada');

  // "Me manda o valor": o total escrito pelo código.
  await falar('Boa noite', {}, true);
  await falar('2 x tudo', { itens: [X('x_tudo', 2, '2 x tudo')] });
  ({ r } = await falar('Me manda o valor', { pergunta: 'outra' }));
  const sub = (session.get(tel).cart || []).reduce((t, l) => t + l.price * l.qty, 0);
  checar(/Seu pedido até agora:/.test(r) && r.includes(`*Total: $${sub.toFixed(2)}*`) && /Entrega ou retirada\?/.test(r),
    '"Me manda o valor": resumo com total e a próxima etapa');
  ({ r } = await falar('quanto custa o x burger?', { pergunta: 'outra' }));
  checar(!/Seu pedido até agora/.test(r), '"quanto custa o x burger?" cita produto: não é o total do pedido');

  console.log('\n\x1b[32mretirartest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
