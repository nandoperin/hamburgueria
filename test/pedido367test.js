/**
 * Pedido #367 (03/10 18h10): 2 X Egg Burger, cada um com a sua observação.
 *
 * "Um sem tomate sem milho e sem batata" ia para os dois; "Outro sem milho e
 * sem tomate" virava "Não entendi"; "1 sem milho / Sem tomate" não mostrava
 * nada. A comanda saiu com os dois sem batata palha. Leituras reais do log.
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
const X = (produto, qtd, sem, trecho) => ({ produto, qtd, sem, com: [], salsicha: null, ponto_bife: null,
  ponto_bacon: null, maionese_a_parte: false, trecho });
const alterar = (linha, sem, trecho) => ({ acao: 'alterar', linha, qtd: null, sem, com: [], ponto_bife: null, ponto_bacon: null, trecho });
const linhas = (tel, id) => session.get(tel).cart.filter((l) => l.productId === id);
const comSem = (tel, id, sem) => linhas(tel, id).filter((l) =>
  [...(l.removed || [])].sort().join() === [...sem].sort().join()).reduce((t, l) => t + l.qty, 0);
const total = (tel, id) => linhas(tel, id).reduce((t, l) => t + l.qty, 0);

(async () => {
  // A conversa real.
  const T = '15557793671';
  await falar(T, 'Quero 2 x egg burguer', { itens: [X('x_egg_burger', 2, [], '2 x egg burguer')] });
  let r = await falar(T, 'Um sem tomate sem milho e sem batata', {
    correcoes: [alterar('x_egg_burger', ['tomate', 'milho', 'batata_palha'], 'Um sem tomate sem milho e sem batata')] });
  checar(total(T, 'x_egg_burger') === 2 && comSem(T, 'x_egg_burger', ['tomate', 'milho', 'batata_palha']) === 1 &&
    comSem(T, 'x_egg_burger', []) === 1, '"Um sem tomate, milho e batata": só um muda, o outro fica normal');

  r = await falar(T, 'Outro sem milho e sem tomate', { itens: [X('x_egg_burger', 1, ['milho', 'tomate'], 'Outro sem milho e sem tomate')] });
  checar(!/Não entendi/.test(r), '"Outro sem milho e sem tomate" é entendido');
  checar(total(T, 'x_egg_burger') === 2 && comSem(T, 'x_egg_burger', ['milho', 'tomate']) === 1 &&
    comSem(T, 'x_egg_burger', ['tomate', 'milho', 'batata_palha']) === 1, '   e vale para o outro: continuam 2, cada um com o seu');

  r = await falar(T, '1 sem milho \nSem tomate', {
    correcoes: [alterar('x_egg_burger:-batata_palha,milho,tomate', ['milho', 'tomate'], '1 sem milho \nSem tomate')] });
  checar(/Já está anotado/.test(r) && /sem Milho, Tomate/.test(r) && !/Em qual item/.test(r),
    '"1 sem milho / Sem tomate" (já está assim) mostra o carrinho, sem perguntar qual');
  checar(total(T, 'x_egg_burger') === 2, '   e nada muda');

  // O que continua igual.
  const T2 = '15557793672';
  await falar(T2, '2 x tudo', { itens: [X('x_tudo', 2, [], '2 x tudo')] });
  await falar(T2, 'os dois sem cebola', { correcoes: [alterar('x_tudo', ['cebola'], 'os dois sem cebola')] });
  checar(total(T2, 'x_tudo') === 2 && comSem(T2, 'x_tudo', ['cebola']) === 2, '"os dois sem cebola" vale para os dois');

  const T3 = '15557793673';
  await falar(T3, '2 x tudo', { itens: [X('x_tudo', 2, [], '2 x tudo')] });
  await falar(T3, 'sem cebola', { correcoes: [alterar('x_tudo', ['cebola'], 'sem cebola')] });
  checar(comSem(T3, 'x_tudo', ['cebola']) === 2, '"sem cebola" sem número vale para a linha inteira, como antes');

  const T4 = '15557793674';
  await falar(T4, '1 x tudo', { itens: [X('x_tudo', 1, [], '1 x tudo')] });
  r = await falar(T4, 'outro sem cebola', { itens: [X('x_tudo', 1, ['cebola'], 'outro sem cebola')] });
  checar(total(T4, 'x_tudo') === 1, 'com um lanche só, "outro sem cebola" não mexe nele (segue a regra de antes)');

  console.log('\n\x1b[32mpedido367test: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
