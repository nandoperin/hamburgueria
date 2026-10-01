/**
 * Lanche do catálogo + lista com o mesmo lanche em várias linhas (Daniela,
 * 30/09 19h53).
 *
 * 1 X Tudo veio do catálogo; ela escreveu "1 x tudo sem alface e tomate /
 * 1 x tudo sem ovo / 1 X Burguer sem tomate e alface". A regra do catálogo
 * tratava as duas linhas como detalhe do mesmo X Tudo: o "sem ovo" era
 * recusado e o segundo X Tudo sumia sem aviso.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';
process.env.FLUXO_GUIADO = 'on';

const PROJECT = require('path').resolve(__dirname, '..');
const menuProducao = require('./fixtures/menu-producao.json');
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
config.get = (chave) => {
  if (chave === 'menu') return menuProducao;
  // Preço de dia comum: a promoção tem testes próprios.
  if (chave === 'promotions') return { ...getReal('promotions'), automatic: false, manual_active: false };
  return getReal(chave);
};
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
const tools = require(`${PROJECT}/src/ai/tools`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}
const X = (produto, qtd, sem, trecho) => ({ produto, qtd, sem, com: [], salsicha: null, ponto_bife: null,
  ponto_bacon: null, maionese_a_parte: false, trecho });

function comCatalogo(tel, qtd) {
  const s = session.get(tel);
  s.lang = 'pt';
  s.state = 'ORDER';
  tools.carrinho.adicionar(s, { item_id: 'x_tudo', quantidade: qtd });
  s.cart.forEach((l) => { l.doCatalogo = true; });
  return s;
}
async function falar(tel, texto, leitura) {
  proxima = leitura;
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return saidas.join('\n---\n');
}
const unidades = (s, id, f = () => true) => s.cart.filter((l) => l.productId === id && f(l)).reduce((t, l) => t + l.qty, 0);
const sem = (...ids) => (l) => ids.every((i) => (l.removed || []).includes(i));

(async () => {
  // 1. A mensagem real da Daniela, com a leitura real.
  const s = comCatalogo('15557797001', 1);
  const r = await falar('15557797001', 'Eu quero um \n1 x tudo se alface e tomate \n1 x tudo sem ovo \n1 X Burguer sem tomate e alface', {
    itens: [
      X('x_tudo', 1, ['alface', 'tomate'], '1 x tudo se alface e tomate'),
      X('x_tudo', 1, ['ovo'], '1 x tudo sem ovo'),
      X('x_burger', 1, ['tomate', 'alface'], '1 X Burguer sem tomate e alface'),
    ],
  });
  checar(unidades(s, 'x_tudo') === 2, 'ficam 2 X Tudo (o do catálogo + o segundo da lista)');
  checar(unidades(s, 'x_tudo', sem('alface', 'tomate')) === 1, '   o do catálogo sem alface e tomate');
  checar(unidades(s, 'x_tudo', sem('ovo')) === 1, '   o segundo sem ovo');
  checar(unidades(s, 'x_burger', sem('tomate', 'alface')) === 1, 'e o X Burger sem tomate e alface');
  checar(!/Não consegui aplicar/.test(r), 'nada recusado');

  // 2. A regra do dono continua: o lanche do catálogo citado UMA vez é detalhe.
  const s2 = comCatalogo('15557797002', 1);
  await falar('15557797002', 'x tudo sem cebola', { itens: [X('x_tudo', null, ['cebola'], 'x tudo sem cebola')] });
  checar(unidades(s2, 'x_tudo') === 1 && unidades(s2, 'x_tudo', sem('cebola')) === 1,
    'citado uma vez: continua 1 X Tudo, agora sem cebola');

  // 3. 2 do catálogo, duas linhas de 1: cada um com o seu detalhe, total 2.
  const s3 = comCatalogo('15557797003', 2);
  await falar('15557797003', '1 x tudo sem tomate\n1 x tudo sem cebola', {
    itens: [X('x_tudo', 1, ['tomate'], '1 x tudo sem tomate'), X('x_tudo', 1, ['cebola'], '1 x tudo sem cebola')],
  });
  checar(unidades(s3, 'x_tudo') === 2, '2 do catálogo + duas linhas de 1: continuam 2');
  checar(unidades(s3, 'x_tudo', sem('tomate')) === 1 && unidades(s3, 'x_tudo', sem('cebola')) === 1,
    '   um sem tomate, outro sem cebola');

  // 4. "mais 1" continua somando.
  const s4 = comCatalogo('15557797004', 1);
  await falar('15557797004', 'mais um x tudo', { itens: [X('x_tudo', 1, [], 'mais um x tudo')] });
  checar(unidades(s4, 'x_tudo') === 2, '"mais um x tudo" soma');

  // 5. (B) O áudio real: "É dois X tudo e um X-Burg" — o X-Burg é X Burger, não X Tudo.
  const s5 = comCatalogo('15557797005', 1);
  await falar('15557797005', 'Beleza, então. Então, você conseguiu entender, né? É dois X tudo e um X-Burg. Quanto tempo que eu posso ir buscar?', {
    itens: [X('x_tudo', 2, [], 'dois X tudo'), X('x_burger', 1, [], 'um X-Burg')],
    pergunta: 'tempo', refazer_lista: true,
  });
  checar(unidades(s5, 'x_burger') === 1 && unidades(s5, 'x_tudo') === 2, '"um X-Burg" fica X Burger: 2 X Tudo e 1 X Burger');

  // E a regra antiga continua: especificação sem nome é do produto citado.
  const s6 = session.get('15557797006');
  s6.lang = 'pt';
  await falar('15557797006', '3 xtudo 1 sem cebola', {
    itens: [X('x_tudo', 3, [], '3 xtudo'), X('x_tudao', 1, ['cebola'], '1 sem cebola')],
  });
  checar(unidades(s6, 'x_tudao') === 0 && unidades(s6, 'x_tudo') === 3, '"1 sem cebola" continua sendo do X Tudo, não X Tudão');

  // 6. (D) "Tenho mais coisa para pedir" no resumo: convite, e o item seguinte entra.
  const s7 = comCatalogo('15557797007', 1);
  Object.assign(s7, { name: 'Daniela', orderType: 'pickup', paymentMethod: 'cash', escolhaItensConcluida: true });
  await require(`${PROJECT}/src/bot/handlers/order`).mostrarResumo(s7, async () => {});
  checar(s7.state === 'CONFIRM', '(no resumo)');
  const r7 = await falar('15557797007', 'Tenho mais coisa para pedir', {});
  checar(/Pode mandar o que mais vai querer/.test(r7) && !/Confirmar o pedido/.test(r7),
    '"Tenho mais coisa para pedir" ouve "Pode mandar", não a confirmação de novo');
  await falar('15557797007', '1 x burger', { itens: [X('x_burger', 1, [], '1 x burger')] });
  checar(unidades(s7, 'x_burger') === 1 && unidades(s7, 'x_tudo') === 1, '   e o item seguinte entra no pedido');

  const s8 = comCatalogo('15557797008', 1);
  Object.assign(s8, { name: 'Ana', orderType: 'pickup', paymentMethod: 'cash', escolhaItensConcluida: true });
  await require(`${PROJECT}/src/bot/handlers/order`).mostrarResumo(s8, async () => {});
  const r8 = await falar('15557797008', 'sem troco', { troco: null });
  checar(/Confirmar o pedido/.test(r8) && !/Pode mandar/.test(r8), 'outra frase no resumo continua ouvindo a confirmação');

  console.log('\n\x1b[32mcatalogolinhastest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
