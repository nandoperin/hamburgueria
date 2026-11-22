/**
 * Conversa de 21/11 (18572103133): três perguntas foram para a equipe.
 *  - "Vc vender Burger hoje" pôs 1 Hamburger no carrinho;
 *  - "...quanto que ficaria?" junto com os lanches;
 *  - "Posso pergunta alguma coisa".
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';
process.env.FLUXO_GUIADO = 'on';
process.env.ADMIN_PHONE = '18573531025';

const PROJECT = require('path').resolve(__dirname, '..');
const menuProducao = require('./fixtures/menu-producao.json');
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
config.get = (chave) => (chave === 'menu' ? menuProducao : getReal(chave));
require(`${PROJECT}/src/services/schedule`).isOpen = () => true;
const availability = require(`${PROJECT}/src/services/availability`);
let esgotados = new Set();
availability.isAvailable = (id) => !esgotados.has(id);

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({}, { get: () => async () => null });
const paraEquipe = [];
require(`${PROJECT}/src/bot/notify`).send = async (tel, msg) => { if (tel === '18573531025') paraEquipe.push(msg); return true; };

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
  habilitada: () => true, getProviderName: () => 'mistral', getModelo: () => 'mistral-small-latest', leitora: () => null,
  get: () => ({
    extrair: async (pedido) => {
      if (pedido.nome === 'pergunta_cadastrada') return { texto: JSON.stringify({ numero: null }), concluida: true, uso: { tokensIn: 1, tokensOut: 1 } };
      return { texto: JSON.stringify({ ...VAZIA, ...proxima }), concluida: true, uso: { tokensIn: 1, tokensOut: 1 } };
    },
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
  if (novo || !tel) tel = `155577994${String(++n).padStart(2, '0')}`;
  proxima = leitura;
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return { r: saidas.join('\n---\n'), s: session.get(tel) };
}
const linhas = (s) => s.cart.map((l) => `${l.qty}x ${l.productId || l.id}`).join(' | ');

(async () => {
  // 1. "Vc vender Burger hoje": pergunta, não item.
  let { r, s } = await falar('Vc vender Burger hoje', { pergunta: 'horario' }, true);
  checar(!s.cart.length, '"Vc vender Burger hoje": nada no carrinho');
  checar(/Temos sim! Pode mandar seu pedido 🍔/.test(r) && !/Não entendi/.test(r) && paraEquipe.length === 0,
    '   responde "Temos sim! Pode mandar seu pedido" e não o horário nem a equipe');
  ({ r, s } = await falar('Se vc vender', { pergunta: 'outra' }));
  checar(/Temos sim!/.test(r) && paraEquipe.length === 0, '"Se vc vender": "Temos sim", sem ir para a equipe');
  ({ r } = await falar('vcs vendem x tudo hoje?', { pergunta: 'cardapio' }, true));
  checar(/Temos sim, \*X Tudo\*! Pode mandar seu pedido/.test(r), '"vcs vendem x tudo hoje?": "Temos sim, X Tudo!"');
  ({ s } = await falar('vcs vendem x tudo?', { itens: [X('x_tudo', 1, 'x tudo')], pergunta: 'cardapio' }, true));
  checar(!s.cart.length, '"vcs vendem x tudo?" com a leitora pondo o X Tudo: não entra');
  esgotados = new Set(['hamburger']);
  ({ r } = await falar('vc vende hamburger hoje?', { pergunta: 'outra' }, true));
  checar(/Hamburger\* sem estoque hoje/.test(r) && !/Temos sim/.test(r), 'produto esgotado: avisa que acabou');
  esgotados = new Set();
  ({ s } = await falar('quero 1 hamburger, vcs vendem coca?', { itens: [X('hamburger', 1, '1 hamburger')], pergunta: 'cardapio' }, true));
  checar(linhas(s) === '1x hamburger', '"quero 1 hamburger, vcs vendem coca?": o pedido entra, como antes');

  // 2. "Quanto que ficaria?" junto com os lanches.
  paraEquipe.length = 0;
  ({ r, s } = await falar('Oi, boa noite. Eu queria fazer um pedido de um hambúrguer e dois x bacon. Eu poderia saber quanto que ficaria?',
    { itens: [X('hamburger', 1, 'um hambúrguer'), X('xbacon', 2, 'dois x bacon')], pergunta: 'outra' }, true));
  checar(linhas(s) === '1x hamburger | 2x xbacon' && /Seu pedido até agora:/.test(r) && r.includes('*Total: $44.00*') && paraEquipe.length === 0,
    '"...quanto que ficaria?" com os lanches: o total, sem ir para a equipe');
  ({ r } = await falar('quanto custa o x burger?', { pergunta: 'outra' }));
  checar(!/Seu pedido até agora/.test(r), '"quanto custa o x burger?": continua não sendo o total do pedido');

  // 3. "Posso pergunta alguma coisa".
  paraEquipe.length = 0;
  ({ r } = await falar('Posso pergunta alguma coisa', { pergunta: 'outra' }, true));
  checar(/Claro, pode perguntar!/.test(r) && paraEquipe.length === 0, '"Posso pergunta alguma coisa": convite, sem ir para a equipe');
  ({ r } = await falar('tenho uma dúvida', {}, true));
  checar(/Claro, pode perguntar!/.test(r) && !/Não entendi/.test(r), '"tenho uma dúvida" sem a leitora marcar pergunta: convite também');
  ({ r } = await falar('posso perguntar se vocês entregam em Boston?', { pergunta: 'cidades' }, true));
  checar(!/Claro, pode perguntar!/.test(r), 'com a pergunta junto: responde a pergunta');

  // 4. "Tá fazendo entrega ?" (21/11, 18572515777): "Sim! 🛵" antes da lista.
  await falar('Boa noite', {}, true);
  ({ r } = await falar('Tá fazendo entrega ?', { pergunta: 'taxa_entrega' }));
  checar(/Sim! 🛵 Entregamos nestas cidades:/.test(r), '"Tá fazendo entrega ?": "Sim! 🛵" e a lista');
  ({ r } = await falar('vcs entregam em Boston?', { pergunta: 'cidades' }, true));
  checar(!/Sim! 🛵/.test(r) && /Entregamos nestas cidades:/.test(r), '"entregam em Boston?": só a lista, sem "Sim!"');
  ({ r } = await falar('quanto é a taxa de entrega?', { pergunta: 'taxa_entrega' }, true));
  checar(!/Sim! 🛵/.test(r), '"quanto é a taxa de entrega?": sem "Sim!"');

  console.log('\n\x1b[32mperguntasclientetest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
