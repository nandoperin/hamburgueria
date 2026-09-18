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

  checar(modifiers.cartId({ id: 'x_tudo' }, { pontoBacon: 'bem_passado' }) !==
    modifiers.cartId({ id: 'x_tudo' }, { pontoBacon: 'mal_passado' }), 'pontos diferentes são linhas diferentes');

  console.log('\n\x1b[32mpontobacontest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
