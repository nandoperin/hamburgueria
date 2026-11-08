/**
 * Categoria nova criada no painel — Sobremesas (dono, 07/11/2026). Não pode
 * atrapalhar as de sempre: entra no menu, no site e no pedido, sem herdar as
 * regras de lanche (maionese, ponto do bife, salsicha), e "uma sobremesa"
 * sem o nome vira a pergunta "qual?", como "um refri".
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';
process.env.FLUXO_GUIADO = 'on';
process.env.LOG_LEVEL = 'silent';

const PROJECT = require('path').resolve(__dirname, '..');
const base = require('./fixtures/menu-producao.json');
// O cardápio como fica depois do "+ categoria" do painel: código do nome,
// nome nos 3 idiomas, itens sem ingredientes.
let nomeCategoria = 'Sobremesas';
const menuCom = () => {
  const menu = JSON.parse(JSON.stringify(base));
  const id = nomeCategoria.toLowerCase();
  menu.categories.push({ id, emoji: '🍰', name: { pt: nomeCategoria, en: nomeCategoria, es: nomeCategoria }, items: [
    { id: 'pudim', name: { pt: 'Pudim' }, description: { pt: '' }, price: 6, available: true, tags: [], allergens: [],
      modifiers: { removable: [], addable: [] } },
    { id: 'brownie', name: { pt: 'Brownie' }, description: { pt: '' }, price: 7, available: true, tags: [], allergens: [],
      modifiers: { removable: [], addable: [] } },
  ] });
  return menu;
};
let menuAtual = menuCom();
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
config.get = (chave) => {
  if (chave === 'menu') return menuAtual;
  if (chave === 'promotions') return { ...getReal(chave), automatic: false, manual_active: false, disabled_date: null };
  return getReal(chave);
};
require(`${PROJECT}/src/services/schedule`).isOpen = () => true;

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({ upsertCustomer: async (c) => ({ id: 1, ...c }) }, { get: (a, k) => a[k] || (async () => null) });
const notify = require(`${PROJECT}/src/bot/notify`);
notify.send = async () => true;
const ricos = [];
notify.sendButtons = async () => false;
notify.sendList = async (_tel, m) => { ricos.push(m); return true; };

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
  if (novo || !tel) tel = `155577994${String(++n).padStart(2, '0')}`;
  proxima = leitura;
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return { r: saidas.join('\n---\n'), s: session.get(tel) };
}

(async () => {
  // A config do painel aceita a categoria nova, vazia ou com itens.
  checar(config.validar ? config.validar('menu', menuCom()).length === 0 : true, 'o painel salva o cardápio com a categoria nova');

  // "uma sobremesa" sem o nome: pergunta qual, com as opções da categoria.
  await falar('Boa noite', {}, true);
  let { r } = await falar('quero uma sobremesa');
  checar(/Pudim/.test(r) && /Brownie/.test(r), '"quero uma sobremesa": pergunta qual, com Pudim e Brownie');

  // "1 pudim": entra no carrinho sem regra de lanche.
  await falar('Boa noite', {}, true);
  let s;
  ({ r, s } = await falar('1 pudim', { itens: [X('pudim', 1, '1 pudim')] }));
  const linha = s.cart.find((l) => l.productId === 'pudim');
  checar(linha && linha.price === 6 && !/maionese|ponto|salsicha/i.test(r), '"1 pudim": anotado a $6, sem pergunta de lanche');

  // Lanche e sobremesa juntos: o lanche continua com as regras dele.
  await falar('Boa noite', {}, true);
  ({ r, s } = await falar('1 x tudo e 1 brownie', { itens: [X('x_tudo', 1, '1 x tudo'), X('brownie', 1, '1 brownie')] }));
  checar(s.cart.some((l) => l.productId === 'x_tudo') && s.cart.some((l) => l.productId === 'brownie'),
    'X Tudo e Brownie no mesmo pedido');

  // Menu do WhatsApp: a categoria aparece e "sobremesa" abre a lista dela.
  ricos.length = 0;
  await falar('Boa noite', {}, true);
  await falar('menu');
  const lista = JSON.stringify(ricos.at(-1) || {});
  checar(/Sobremesas/.test(lista) && /Sanduíches/.test(lista), 'menu do WhatsApp: Sobremesas aparece junto das de sempre');
  ricos.length = 0;
  const sel = await falar('sobremesa');
  const texto = sel.r + JSON.stringify(ricos);
  checar(/Pudim/.test(texto) && /Brownie/.test(texto), 'menu: "sobremesa" abre a lista com Pudim e Brownie');

  // Site: aba própria, sem "customizar".
  const site = require(`${PROJECT}/src/services/pedidoweb`).cardapioPublico();
  const aba = site.categorias.find((c) => c.id === 'sobremesas');
  checar(aba && aba.nome === 'Sobremesas' && aba.itens.length === 2 && aba.itens.every((i) => !i.opcoes),
    'site: aba Sobremesas com 2 itens, sem customizar');
  checar(site.categorias[0].id === 'sanduiches', 'site: as abas de sempre continuam na frente');

  // Nome "Doces": a família acha pelo nome que o dono deu.
  nomeCategoria = 'Doces';
  menuAtual = menuCom();
  await falar('Boa noite', {}, true);
  ({ r } = await falar('me ve um doce'));
  checar(/Pudim/.test(r) && /Brownie/.test(r), 'categoria chamada "Doces": "um doce" também pergunta qual');

  // Sem categoria de sobremesa, nada muda.
  menuAtual = JSON.parse(JSON.stringify(base));
  await falar('Boa noite', {}, true);
  ({ r } = await falar('quero uma sobremesa'));
  checar(!/Pudim|Brownie/.test(r), 'sem categoria de sobremesa, o bot segue como antes');

  console.log('\n\x1b[32msobremesatest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
