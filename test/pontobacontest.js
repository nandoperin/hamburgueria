/**
 * Ponto do bacon (pedido do dono, 18/09): "bacon bem passado" / "bacon mal
 * passado" é observação da cozinha, como o ponto do bife — não custa nada e
 * não é bacon a mais. Não se valida se o lanche leva bacon: a cozinha resolve.
 * Só a cobrança muda: "X-Bacon com bacon bem passado" é o bacon que já vem;
 * "X-Burger com bacon bem passado" é bacon a mais, e cobra.
 *
 * Cardápio semente (config/menu.json): tem descrição e adicionais com preço.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.AI_ENABLED = 'on';
process.env.FLUXO_GUIADO = 'on';

const PROJECT = require('path').resolve(__dirname, '..');
require(`${PROJECT}/src/services/schedule`).isOpen = () => true;
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({ upsertCustomer: async (c) => ({ id: 1, ...c }) },
  { get: (alvo, k) => alvo[k] || (async () => null) });

const VAZIA = {
  itens: [], ambiguos: [], correcoes: [], refazer_lista: false, concluiu_itens: false,
  entrega: null, cidade: null, endereco: null, nome: null, pagamento: null, troco: null,
  confirma_resumo: null, pergunta: null, cancelar: false,
};
const item = (produto, extra = {}) => ({
  produto, qtd: 1, sem: [], com: [], salsicha: null, ponto_bife: null, ponto_bacon: null,
  maionese_a_parte: false, trecho: '', ...extra,
});
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
const tools = require(`${PROJECT}/src/ai/tools`);
const modifiers = require(`${PROJECT}/src/services/modifiers`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}
let seq = 0;
async function pedir(texto, leitura) {
  const tel = `15557790${String(400 + ++seq)}`;
  proxima = leitura;
  let resp = '';
  await router.route(tel, texto, async (t) => { resp += t; });
  return { cart: session.get(tel).cart, resp };
}

(async () => {
  checar(tools.pontoBaconDoTexto('x bacon com bacon bem passado') === 'bem_passado' &&
    tools.pontoBaconDoTexto('bem passado o bacon') === 'bem_passado' &&
    tools.pontoBaconDoTexto('bacon mau passado') === 'mal_passado', 'lê o ponto do bacon na fala');
  checar(tools.pontoBifeDoTexto('x tudo com bacon bem passado') === null &&
    tools.pontoBifeDoTexto('bife mal passado e bacon bem passado') === 'mal_passado',
    '"bacon bem passado" não vira ponto do bife');

  let r = await pedir('x bacon com bacon bem passado', { itens: [item('x_bacon', {
    com: ['bacon'], ponto_bacon: 'bem_passado', trecho: 'x bacon com bacon bem passado' })] });
  let l = r.cart[0];
  checar(l?.pontoBacon === 'bem_passado' && !l.added.includes('bacon') && l.price === 15,
    'X-Bacon com bacon bem passado: observação, sem cobrar bacon extra ($15)');
  checar(l.choicesCozinha.includes('bacon bem passado') && /bacon bem passado/.test(l.name),
    'sai na comanda e no resumo');

  r = await pedir('x burger com bacon bem passado', { itens: [item('x_burger', {
    com: ['bacon'], ponto_bacon: 'bem_passado', trecho: 'x burger com bacon bem passado' })] });
  l = r.cart[0];
  checar(l?.pontoBacon === 'bem_passado' && l.added.includes('bacon') && l.price > 12,
    'X-Burger com bacon bem passado: bacon a mais cobrado, e o ponto anotado');

  r = await pedir('x burger bacon mal passado', { itens: [item('x_burger', { trecho: 'x burger bacon mal passado' })] });
  checar(r.cart[0]?.pontoBacon === 'mal_passado' && !/não leva/i.test(r.resp),
    'sem validar: o ponto do bacon fica mesmo em lanche sem bacon (a cozinha resolve)');

  r = await pedir('x tudo bacon bem passado', { itens: [item('x_tudo', {
    ponto_bife: 'bem_passado', trecho: 'x tudo bacon bem passado' })] });
  l = r.cart[0];
  checar(l?.pontoBacon === 'bem_passado' && !l.pontoBife, 'leitora pôs no bife: o ponto volta para o bacon');

  r = await pedir('x tudo bife mal passado e bacon bem passado', { itens: [item('x_tudo', {
    ponto_bife: 'mal_passado', trecho: 'x tudo bife mal passado e bacon bem passado' })] });
  l = r.cart[0];
  checar(l?.pontoBife === 'mal_passado' && l.pontoBacon === 'bem_passado' &&
    l.choicesCozinha.includes('bife mal passado') && l.choicesCozinha.includes('bacon bem passado'),
    'bife e bacon com pontos diferentes, os dois na comanda');

  // Teste do dono (18/09): a leitura exata do log. Virou bife extra cobrado e
  // só o bacon mal passado; o certo são os dois pontos, sem cobrar.
  checar(tools.pontoBifeDoTexto('xbacon com bife e bacon mal passado') === 'mal_passado' &&
    tools.pontoBaconDoTexto('xbacon com bife e bacon mal passado') === 'mal_passado', '"bife e bacon mal passado" vale para os dois');
  r = await pedir('Xbacon com bife e bacon mal passado', { itens: [item('x_bacon', {
    com: ['bife'], ponto_bacon: 'mal_passado', trecho: 'Xbacon com bife e bacon mal passado' })] });
  l = r.cart[0];
  checar(l?.pontoBife === 'mal_passado' && l.pontoBacon === 'mal_passado' && !l.added.includes('bife') && l.price === 15,
    'X bacon com bife e bacon mal passado: dois pontos, sem bife extra ($15)');
  r = await pedir('x salada bife bem passado', { itens: [item('x_salada', { ponto_bife: 'bem_passado', trecho: 'x salada bife bem passado' })] });
  checar(r.cart[0]?.pontoBife === 'bem_passado', 'ponto do bife segue normal em lanche com bife');

  // Leitura ruim da DeepSeek na prova (18/09): o "3 sem maionese" foi para o X
  // bacon e o total "4 xtudo" veio em duas linhas.
  r = await pedir('Ola\n4 xtudo 3 sem maionese\nXbacon com bife e bacon mal passado', { itens: [
    item('x_tudo', { qtd: 4, trecho: '4 xtudo' }),
    item('x_bacon', { qtd: 3, sem: ['maionese'], trecho: '3 sem maionese' }),
    item('x_bacon', { qtd: null, ponto_bacon: 'mal_passado', trecho: 'Xbacon com bife e bacon mal passado' }),
    item('x_tudo', { qtd: 4, trecho: '4 xtudo 3 sem maionese' }),
  ] });
  const xt = r.cart.filter((x) => x.productId === 'x_tudo');
  const xb = r.cart.filter((x) => x.productId === 'x_bacon');
  checar(xt.reduce((t, x) => t + x.qty, 0) === 4 && xt.filter((x) => x.removed.includes('maionese')).reduce((t, x) => t + x.qty, 0) === 3,
    'o "3 sem maionese" é do X Tudo (a linha dele), e são 4 X Tudo');
  checar(xb.reduce((t, x) => t + x.qty, 0) === 1 && xb[0].pontoBife === 'mal_passado' && xb[0].pontoBacon === 'mal_passado',
    '1 X bacon com bife e bacon mal passados');

  // Bife adicional (dono, 18/09): cobra; com mais de um lanche, pergunta qual.
  const TELB = '15557790499';
  proxima = { itens: [item('x_burger', { trecho: 'x burger' }), item('x_salada', { trecho: 'x salada' })] };
  await router.route(TELB, 'x burger e x salada', async () => {});
  proxima = { itens: [item('bife', { trecho: 'add bife' })] };
  let rb = '';
  await router.route(TELB, 'add bife', async (t) => { rb += t; });
  checar(/Em qual/.test(rb) && !session.get(TELB).cart.some((x) => x.added.includes('bife')),
    '"add bife" com 2 lanches: pergunta em qual, sem cobrar ainda');
  proxima = { itens: [item('x_salada', { trecho: 'no x salada' })] };
  await router.route(TELB, 'no x salada', async () => {});
  const xs = session.get(TELB).cart.find((x) => x.productId === 'x_salada');
  checar(xs?.added.includes('bife') && xs.price > 13 && !session.get(TELB).cart.find((x) => x.productId === 'x_burger').added.length,
    'a resposta põe o bife (cobrado) só no X Salada');
  r = await pedir('x tudo com bife adicional', { itens: [item('x_tudo', { com: ['bife'], trecho: 'x tudo com bife adicional' })] });
  checar(r.cart[0]?.added.includes('bife'), '"bife adicional" num lanche só: cobra o bife');
  r = await pedir('x tudo com bife adicional bem passado', { itens: [item('x_tudo', { com: ['bife'], ponto_bife: 'bem_passado', trecho: 'x tudo com bife adicional bem passado' })] });
  checar(r.cart[0]?.added.includes('bife') && r.cart[0].pontoBife === 'bem_passado', 'bife adicional com ponto: cobra e anota o ponto');

  checar(modifiers.cartId({ id: 'x_tudo' }, { pontoBacon: 'bem_passado' }) !==
    modifiers.cartId({ id: 'x_tudo' }, { pontoBacon: 'mal_passado' }), 'pontos diferentes são linhas diferentes');

  console.log('\n\x1b[32mpontobacontest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
