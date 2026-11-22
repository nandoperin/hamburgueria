/**
 * 22/11: dois brigadeiros com o apelido "brigadeiro". Fora de venda, o cliente
 * mandou "brigadeiro" e, além do "sem estoque", ouviu "Essa eu não sei
 * responder". À venda, a leitora escolhia um sozinha.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';
process.env.FLUXO_GUIADO = 'on';
process.env.ADMIN_PHONE = '18573531025';

const PROJECT = require('path').resolve(__dirname, '..');
const menu = JSON.parse(JSON.stringify(require('./fixtures/menu-producao.json')));
const B1 = 'x_brigadeiro_de_leite_ninho_trufado_com_';
const B2 = 'x_brigadeiro_de_leite_ninho_c_mousse_de_';
const sobremesas = { id: 'sobremesas', name: { pt: 'Sobremesas' }, items: [
  { id: B1, name: { pt: 'brigadeiro de leite ninho Trufado com uva, Nutella e chocolate' }, aliases: ['brigadeiro'], price: 7, available: false },
  { id: B2, name: { pt: 'Brigadeiro de leite ninho c/mousse de maracuja' }, aliases: ['brigadeiro'], price: 7, available: false }] };
menu.categories.push(sobremesas);
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
config.get = (k) => (k === 'menu' ? menu : getReal(k));
require(`${PROJECT}/src/services/schedule`).isOpen = () => true;

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
  if (novo || !tel) tel = `155577992${String(++n).padStart(2, '0')}`;
  proxima = leitura;
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return { r: saidas.join('\n---\n'), s: session.get(tel) };
}

(async () => {
  // Fora de venda: o print do dono.
  await falar('Oi', {}, true);
  let { r, s } = await falar('brigadeiro', { pergunta: 'outra' });
  checar(/Trufado com uva, Nutella e chocolate\* sem estoque hoje/.test(r) && /mousse de maracuja\* sem estoque hoje/.test(r),
    '"brigadeiro" com os dois fora de venda: "sem estoque" dos dois');
  checar(!/não sei responder/.test(r) && paraEquipe.length === 0, '   sem "Essa eu não sei responder" e sem ir para a equipe');
  ({ r } = await falar('vocês tem brigadeiro hoje?', { pergunta: 'outra' }, true));
  checar(/sem estoque hoje/.test(r), 'com "?": o "sem estoque" também aparece');

  // À venda: o apelido dos dois vira "qual?".
  for (const i of sobremesas.items) i.available = true;
  ({ r, s } = await falar('brigadeiro', { itens: [X(B1, 1, 'brigadeiro')] }, true));
  checar(/Qual você quer em "brigadeiro"\?/.test(r) && !s.cart.length, '"brigadeiro" com a leitora escolhendo um: pergunta qual, não anota sozinho');
  ({ r, s } = await falar('o de maracuja', { itens: [X(B2, 1, 'o de maracuja')] }));
  checar(s.cart.length === 1 && s.cart[0].productId === B2, '   "o de maracuja": anota o de maracujá');
  ({ s } = await falar('1 brigadeiro de leite ninho c/mousse de maracuja', { itens: [X(B2, 1, '1 brigadeiro de leite ninho c/mousse de maracuja')] }, true));
  checar(s.cart.length === 1 && s.cart[0].productId === B2, 'pelo nome completo: anota direto, sem perguntar');
  paraEquipe.length = 0;
  ({ r } = await falar('brigadeiro', { pergunta: 'outra' }, true));
  checar(/Qual você quer em "brigadeiro"\?/.test(r) && paraEquipe.length === 0, '"brigadeiro" lido como pergunta: só o "qual?", sem a equipe');

  console.log('\n\x1b[32mapelidocompartilhadotest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
