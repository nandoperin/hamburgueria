/**
 * Convite para o site nas falas do bot e contagem site × WhatsApp (dono,
 * 09/10/2026). Só acréscimo: com o site desligado, as falas ficam iguais.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';
process.env.FLUXO_GUIADO = 'on';
process.env.LOG_LEVEL = 'silent';

const PROJECT = require('path').resolve(__dirname, '..');
const menuProducao = require('./fixtures/menu-producao.json');
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
config.get = (chave) => (chave === 'menu' ? menuProducao : getReal(chave));
require(`${PROJECT}/src/services/schedule`).isOpen = () => true;

const settings = new Map();
let idsDoPeriodo = [];
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({
  getSetting: async (k) => settings.get(k) ?? null,
  setSetting: async (k, v) => { settings.set(k, v); },
  getIdsPedidosPagos: async () => idsDoPeriodo,
  upsertCustomer: async (c) => ({ id: 1, ...c }),
  createOrder: async (o) => ({ id: 777, total: o.total, order_type: o.orderType }),
}, { get: (alvo, k) => alvo[k] || (async () => null) });
const notify = require(`${PROJECT}/src/bot/notify`);
notify.send = async () => true;
const ricos = [];
notify.sendButtons = async (_tel, m) => { ricos.push(m.body); return true; };
notify.sendList = async (_tel, m) => { ricos.push(m.body); return true; };

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
const order = require(`${PROJECT}/src/bot/handlers/order`);
const siteLink = require(`${PROJECT}/src/services/site-link`);
const origem = require(`${PROJECT}/src/services/origem-pedidos`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}
let n = 0;
async function falar(texto, leitura = {}, mesmo = false) {
  const tel = `155577993${String(mesmo ? n : ++n).padStart(2, '0')}`;
  proxima = leitura;
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return saidas.join('\n---\n');
}
async function confirmarPedido(method) {
  const saidas = [];
  const sess = { phone: '15557799999', lang: 'pt', orderType: 'pickup', name: 'Ana', cart: [{ id: 'x_burger', productId: 'x_burger', name: 'X Burger', qty: 1, price: 12 }],
    subtotal: 12, deliveryFee: 0, total: 12, state: 'CONFIRM' };
  await order.createOrderAndPay(sess, async (t) => saidas.push(t), method);
  return saidas.join('\n');
}
const LINK = 'https://pointburgerjg.com/pedido.html?origem=whatsapp';

(async () => {
  // Site desligado: nada muda.
  delete process.env.PEDIR_ATIVO;
  checar(siteLink.acrescentar('Oi', 'boas_vindas') === 'Oi', 'sem PEDIR_ATIVO: texto igual, sem link');
  checar(!(await falar('Boa noite')).includes('pedido.html'), 'sem PEDIR_ATIVO: boas-vindas sem convite');
  checar(!(await confirmarPedido('cash')).includes('pedido.html'), 'sem PEDIR_ATIVO: confirmação sem convite');

  // Site ligado: o convite entra no fim, e o texto de antes continua.
  process.env.PEDIR_ATIVO = 'on';
  let r = await falar('Boa noite');
  checar(r.includes('O que vai querer hoje?') && r.includes(LINK) && r.indexOf(LINK) > r.indexOf('O que vai querer hoje?'),
    'boas-vindas: texto de sempre e o convite do site no fim');
  await falar('Boa noite');
  ricos.length = 0;
  await falar('cardápio', {}, true);
  r = ricos.join(' | ');
  checar(r.includes('Veja o cardápio completo e peça pelo site') && r.includes(LINK), 'pedido de cardápio: lista de categorias com o convite do site');
  checar(siteLink.acrescentar('Cardápio:', 'cardapio').includes(LINK), 'pergunta de cardápio no meio do pedido: convite do site');
  r = await confirmarPedido('cash');
  checar(/#777/.test(r) && r.includes('Da próxima vez, você também pode pedir pelo site') && r.includes(LINK),
    'pedido em dinheiro: confirmação de sempre + convite no fim');
  r = await confirmarPedido('zelle');
  checar(/#777/.test(r) && r.includes(LINK), 'pedido Zelle: confirmação de sempre + convite no fim');
  checar(siteLink.acrescentar('Não consegui abrir o carrinho agora.', 'catalogo_falhou').endsWith(`Ou monte seu pedido pelo site:\n${LINK}`),
    'catálogo que falhou: convite do site no fim');

  // Contagem por canal.
  await origem.anotar(10, 'whatsapp');
  await origem.anotar(11, 'site');
  await Promise.all([origem.anotar(12, 'whatsapp'), origem.anotar(13, 'site')]);
  idsDoPeriodo = [1, 2, 3, 10, 11, 12, 13, 14];
  const c = await origem.contar('2026-10-01', '2026-10-31');
  checar(c.total === 8 && c.site === 4 && c.whatsapp === 4 && c.viaConvite === 2,
    'contagem: 8 pedidos = 4 WhatsApp + 4 site (2 pelo convite), sem perder anotação simultânea');
  checar(/WhatsApp: 4 \(50%\)/.test(origem.linhas(c)) && /Site: 4 \(50%\) — 2 pelo convite/.test(origem.linhas(c)),
    'linha do !relatorio com WhatsApp e site');

  console.log('\n\x1b[32msitelinktest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
