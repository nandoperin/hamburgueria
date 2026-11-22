/**
 * 21/11: "1 xbacon com banana, com 2 acréscimos de banana" (18573334874) saía
 * com 1 banana e "Já está anotado". O carrinho guarda 1 de cada acréscimo;
 * agora o bot avisa. E "2 pudim" com o Pudim fora de venda (19783043035).
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';
process.env.FLUXO_GUIADO = 'on';

const PROJECT = require('path').resolve(__dirname, '..');
const menu = JSON.parse(JSON.stringify(require('./fixtures/menu-producao.json')));
for (const item of menu.categories.flatMap((c) => c.items)) {
  if (item.id === 'xbacon') item.modifiers = { ...(item.modifiers || {}), addable: ['banana', 'ovo'] };
}
menu.categories.push({ id: 'sobremesas', name: { pt: 'Sobremesas', en: 'Desserts', es: 'Postres' },
  items: [{ id: 'pudim', name: { pt: 'Pudim', en: 'Pudim', es: 'Pudim' }, aliases: ['pudin'], price: 6, available: false }] });
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
config.get = (chave) => (chave === 'menu' ? menu : getReal(chave));
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
const X = (produto, qtd, trecho, com = [], sem = []) => ({ produto, qtd, sem, com, salsicha: null, ponto_bife: null,
  ponto_bacon: null, maionese_a_parte: false, trecho });
let n = 0;
let tel = '';
async function falar(texto, leitura = {}, novo = false) {
  if (novo || !tel) tel = `155577993${String(++n).padStart(2, '0')}`;
  proxima = leitura;
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return { r: saidas.join('\n---\n'), s: session.get(tel) };
}
const AVISO = /Por aqui consigo anotar só \*1 acréscimo de Banana\* em cada lanche — ficou 1\./;

(async () => {
  // A conversa da Ingrid.
  await falar('Ola boa noite', {}, true);
  let { r, s } = await falar('Gostaria de fazer um pedido \n1 xbacon com banana \nCom 2 acrescimo de banana e presunto \n C vc puder coloca um dos acrescimo de banana no meio e um em cima pfvv',
    { itens: [X('xbacon', 1, '1 xbacon com banana \nCom 2 acrescimo de banana', ['banana'])] });
  checar(AVISO.test(r), '"2 acréscimos de banana": avisa que fica 1 por lanche');
  checar(s.cart.length === 1 && (s.cart[0].added || []).filter((a) => a === 'banana').length === 1, '   o carrinho segue com 1 banana (nada muda no preço)');
  ({ r } = await falar('Retirada \nMais quero 2 vezes acrescimo de banana', { entrega: 'retirada', itens: [X('banana', 2, '2 vezes acrescimo de banana')] }));
  checar(AVISO.test(r), '"quero 2 vezes acréscimo de banana": avisa de novo, em vez de só "Já está anotado"');

  for (const frase of ['1 xbacon com duas bananas', '1 xbacon com banana dupla', '1 xbacon com dobro de banana']) {
    ({ r } = await falar(frase, { itens: [X('xbacon', 1, frase, ['banana'])] }, true));
    checar(AVISO.test(r), `"${frase}": avisa`);
  }
  for (const frase of ['2 xbacon com banana', '1 xbacon com banana e 2 coca', '2 bacon burger']) {
    ({ r } = await falar(frase, {}, true));
    checar(!/consigo anotar só \*1 acréscimo/.test(r), `"${frase}": sem aviso (não é acréscimo repetido)`);
  }

  // Pudim fora de venda, pelo nome, pelo apelido e no plural.
  for (const frase of ['Quero 2 x tudo e 2 pudim', 'e 2 pudin', 'quero 2 pudins']) {
    ({ r } = await falar(frase, { itens: [X('x_tudo', 2, '2 x tudo')] }, true));
    checar(/\*Pudim\* sem estoque hoje/.test(r), `"${frase}": "Pudim sem estoque hoje"`);
  }

  console.log('\n\x1b[32macrescimorepetidotest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
