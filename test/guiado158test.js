/**
 * O teste do dono de 18/09 (pedido #158), mensagem por mensagem.
 *
 * Com o cardápio real de produção (test/fixtures/menu-producao.json, tirado de
 * /cardapio) e com os formulários que a leitora REALMENTE devolveu naquela
 * hora — copiados do log, erros incluídos. O que se prova aqui é que o
 * validador segura cada erro da leitura antes de ele virar carrinho:
 *
 *   "2 x egg bacon"          → leitora: Egg Bacon ($16)   → vira X Egg Bacon ($18)
 *   "bife bem passado"       → leitora: com bife          → não cobra bife extra
 *   "tira tomate egg bacon"  → leitora: tirar o X-TUDO    → tira o tomate do X Egg Bacon
 *   "um maionese à parte"    → leitora: sachê de $1       → pergunta em qual lanche
 *   "são 2 xegg bacon"       → leitora: "eggburger" x2    → quantidade final 2
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

const VAZIA = {
  itens: [], ambiguos: [], correcoes: [], refazer_lista: false, concluiu_itens: false,
  entrega: null, cidade: null, endereco: null, nome: null, pagamento: null, troco: null,
  confirma_resumo: null, pergunta: null, cancelar: false,
};
const item = (produto, qtd, extra = {}) => ({
  produto, qtd, sem: [], com: [], salsicha: null, ponto_bife: null, maionese_a_parte: false, trecho: '', ...extra,
});
const correcao = (acao, linha, extra = {}) => ({ acao, linha, qtd: null, sem: [], com: [], ponto_bife: null, trecho: '', ...extra });
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
const TEL = '15557790158';

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}
async function falar(texto, leitura) {
  proxima = leitura;
  const saidas = [];
  await router.route(TEL, texto, async (t) => saidas.push(t));
  return saidas.join('\n---\n');
}
const cart = () => session.get(TEL).cart;
const linha = (id) => cart().find((l) => l.productId === id);

(async () => {
  let r = await falar('Ola boa noite\nQuero um xtudo sem tomate \n2 x egg bacon 1 com maionese a parte', {
    itens: [
      item('x_tudo', 1, { sem: ['tomate'], trecho: 'um xtudo sem tomate' }),
      item('egg_bacon', 2, { maionese_a_parte: true, trecho: '2 x egg bacon 1 com maionese a parte' }),
    ],
  });
  const xeb = () => cart().filter((l) => l.productId === 'xeggbacon');
  checar(xeb().reduce((t, l) => t + l.qty, 0) === 2 && !linha('egg_bacon'), '"x egg bacon" é X Egg Bacon ($18), não Egg Bacon ($16)');
  checar(xeb().filter((l) => l.maioneseAParte).reduce((t, l) => t + l.qty, 0) === 1, 'dos 2, só 1 com maionese à parte');
  checar(linha('x_tudo')?.removed.includes('tomate'), 'X-Tudo sem tomate');

  r = await falar('Hamburguer com bife bem passado', {
    itens: [item('hamburger', null, { com: ['bife'], ponto_bife: 'bem_passado', trecho: 'Hamburguer com bife bem passado' })],
  });
  const h = linha('hamburger');
  checar(h && h.pontoBife === 'bem_passado' && !h.added.includes('bife') && h.price === 10,
    'bife bem passado sem cobrar bife extra ($10, não $12)');

  r = await falar('Tira tomate egg bacon', {
    correcoes: [correcao('tirar', 'x_tudo:-tomate', { sem: ['tomate'], trecho: 'Tira tomate egg bacon' })],
  });
  checar(linha('x_tudo'), 'o X-Tudo continua no carrinho (a leitora mandou tirá-lo)');
  checar(xeb().length === 2 && xeb().every((l) => l.removed.includes('tomate')), 'o tomate sai dos dois X Egg Bacon');

  r = await falar('Sao 2 e um maionese a oarte', {
    itens: [item('sache_maionese', 1, { maionese_a_parte: true, trecho: 'um maionese a oarte' })],
  });
  checar(!linha('sache_maionese'), 'maionese à parte não vira sachê de $1');
  checar(/Em qual lanche vai a maionese à parte/.test(r), 'com três lanches, pergunta em qual vai a maionese à parte');

  const antes = xeb().reduce((t, l) => t + l.qty, 0);
  r = await falar('Sao 2 xegg bacon', { itens: [item('eggburger', 2, { trecho: 'Sao 2 xegg bacon' })] });
  checar(xeb().reduce((t, l) => t + l.qty, 0) === 2 && antes === 2 && !linha('eggburger'),
    '"são 2 xegg bacon" é quantidade final 2 — nem Egg Burger, nem mais dois');

  const semLinha = await falar('tira o hot dog', { correcoes: [correcao('tirar', 'x_tudo', { trecho: 'tira o hot dog' })] });
  checar(linha('x_tudo') && /Em qual item/.test(semLinha), 'tirar exige que a fala cite o item; senão pergunta qual');

  // A saída que a leitora REAL deu na prova de 18/09 para a primeira frase:
  // id inventado ("x_egg_bacon") e o total somado com a especificação (2 + 1).
  const TEL2 = '15557790159';
  proxima = {
    itens: [
      item('x_egg_bacon', 2, { trecho: '2 x egg bacon' }),
      item('x_egg_bacon', 1, { maionese_a_parte: true, com: ['maionese'], trecho: '1 com maionese a parte' }),
    ],
  };
  await router.route(TEL2, 'Quero 2 x egg bacon 1 com maionese a parte', async () => {});
  const eb = session.get(TEL2).cart.filter((l) => l.productId === 'xeggbacon');
  checar(eb.reduce((t, l) => t + l.qty, 0) === 2, 'id inventado vira X Egg Bacon, e são 2 — não 3');
  checar(eb.filter((l) => l.maioneseAParte).reduce((t, l) => t + l.qty, 0) === 1 &&
    eb.every((l) => !l.added.includes('maionese')), 'só um com maionese à parte, e sem cobrar maionese extra');

  // Teste de 18/09 de manhã: a leitora pôs "sem maionese" nos dois.
  const TEL3 = '15557790160';
  proxima = {
    itens: [
      item('x_burger', 1, { trecho: 'Xburguer' }),
      item('x_egg_burger', 2, { sem: ['maionese'], trecho: '2 xegg burguer 1 sem maionese' }),
      item('coca_cola', 1, { trecho: 'Coca' }),
    ],
  };
  await router.route(TEL3, 'Bom dia\nXburguer\n2 xegg burguer 1 sem maionese\nCoca', async () => {});
  const xe = session.get(TEL3).cart.filter((l) => l.productId === 'x_egg_burger');
  checar(xe.reduce((t, l) => t + l.qty, 0) === 2, 'continuam 2 X Egg Burger');
  checar(xe.filter((l) => l.removed.includes('maionese')).reduce((t, l) => t + l.qty, 0) === 1,
    '"2 ..., 1 sem maionese": só um sai sem maionese');

  // "Salsicha a parte" sem lanche citado: a leitora mandou pôr no X Egg Burger.
  proxima = { correcoes: [correcao('alterar', 'x_egg_burger:-maionese', { sem: ['maionese'], com: ['salsicha'], trecho: 'Salsicha a parte' })] };
  await router.route(TEL3, 'Salsicha a parte', async () => {});
  checar(session.get(TEL3).cart.some((l) => l.productId === 'salsicha') &&
    session.get(TEL3).cart.filter((l) => l.productId === 'x_egg_burger').every((l) => !l.added.includes('salsicha')),
    '"salsicha a parte" é a salsicha avulsa, não salsicha no lanche');

  // "Hamburguer": Hamburger (1 letra) e não Hamburgão. Não pergunta.
  const TEL4 = '15557790161';
  let r4 = '';
  proxima = { ambiguos: [{ trecho: 'Hamburguer', qtd: null, opcoes: ['hamburger', 'hamburgao'] }] };
  await router.route(TEL4, 'Hamburguer', async (t) => { r4 += t; });
  checar(session.get(TEL4).cart.some((l) => l.productId === 'hamburger') && !/Qual/.test(r4),
    '"Hamburguer" é Hamburger, sem perguntar');
  const TEL5 = '15557790162';
  let r5 = '';
  proxima = { ambiguos: [{ trecho: 'hot dog', qtd: null, opcoes: ['hot_simples', 'hot_duplo', 'hot_tudo'] }] };
  await router.route(TEL5, 'quero um hot dog', async (t) => { r5 += t; });
  checar(/Qual/.test(r5) && !session.get(TEL5).cart.length, '"hot dog" continua perguntando qual');

  console.log('\n\x1b[32mguiado158test: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
