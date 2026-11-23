/**
 * Só retirada / só entrega pelo painel (dono, 23/11). Antes, com todas as
 * cidades desmarcadas, o bot perguntava "Entrega ou retirada?" sem parar.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';
process.env.FLUXO_GUIADO = 'on';
process.env.PAINEL_SECRET = 'x'.repeat(40);

const PROJECT = require('path').resolve(__dirname, '..');
const menuProducao = require('./fixtures/menu-producao.json');
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
const deliveryReal = JSON.parse(JSON.stringify(getReal('delivery')));
let entregaDoc = deliveryReal;
config.get = (chave) => (chave === 'menu' ? menuProducao : chave === 'delivery' ? entregaDoc : getReal(chave));
require(`${PROJECT}/src/services/schedule`).isOpen = () => true;

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({
  upsertCustomer: async (c) => ({ id: 1, ...c }),
  createOrder: async (o) => ({ id: 900, status: 'pending', ...o, order_type: o.orderType, total: o.total }),
  createCashPayment: async (p) => ({ ...p, status: 'cash_due' }),
}, { get: (alvo, k) => alvo[k] || (async () => null) });
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
const delivery = require(`${PROJECT}/src/services/delivery`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}
const X = (produto, qtd, trecho) => ({ produto, qtd, sem: [], com: [], salsicha: null, ponto_bife: null,
  ponto_bacon: null, maionese_a_parte: false, trecho });
let n = 0;
let tel = '';
async function falar(texto, leitura = {}, novo = false) {
  if (novo || !tel) tel = `155577991${String(++n).padStart(2, '0')}`;
  proxima = leitura;
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return { r: saidas.join('\n---\n'), s: session.get(tel) };
}
const PERGUNTA_TIPO = /Entrega ou retirada\?/;

(async () => {
  const comPickup = (on) => ({ ...(deliveryReal.pickup || {}), enabled: on, address: '2021 Revere Beach Parkway, Everett, MA' });

  // ---------------------------------------- só retirada (entrega desligada)
  entregaDoc = { ...deliveryReal, delivery_enabled: false, pickup: comPickup(true) };
  checar(!delivery.isDeliveryEnabled() && delivery.tipoUnico() === 'pickup' && delivery.getCities().length === 0,
    'entrega desligada: sem cidades, só retirada');
  await falar('Boa noite', {}, true);
  let { r, s } = await falar('1 x tudo', { itens: [X('x_tudo', 1, '1 x tudo')] });
  checar(!PERGUNTA_TIPO.test(r) && s.orderType === 'pickup', '"1 x tudo": não pergunta "entrega ou retirada", vira retirada');
  checar(/nome/i.test(r), '   e já segue para o nome');
  ({ r, s } = await falar('quero entrega', { entrega: 'entrega' }));
  checar(/só com \*retirada no balcão\*: 2021 Revere Beach Parkway/.test(r) && s.orderType === 'pickup' && !PERGUNTA_TIPO.test(r),
    '"quero entrega": avisa que é só retirada, com o endereço');
  ({ r } = await falar('Tá fazendo entrega?', { pergunta: 'taxa_entrega' }));
  checar(/só com \*retirada no balcão\*/.test(r) && !/Sim! 🛵/.test(r) && !/Entregamos nestas cidades/.test(r),
    '"Tá fazendo entrega?": só retirada, sem "Sim!" e sem lista vazia');
  ({ r } = await falar('vocês entregam em Everett?', { pergunta: 'cidades', cidade: 'Everett' }));
  checar(/só com \*retirada no balcão\*/.test(r), '"entregam em Everett?": só retirada');
  ({ r, s } = await falar('Fernando', { nome: 'Fernando' }));
  checar(s.name === 'Fernando' && s.state === 'PAYMENT_METHOD', 'nome: segue para o pagamento');
  ({ r, s } = await falar('cash'));
  ({ r, s } = await falar('sim'));
  checar(s.orderId === 900 && s.orderType === 'pickup', 'pedido fechado como retirada');

  // Primeira mensagem "delivery", sem carrinho.
  ({ r } = await falar('delivery', { entrega: 'entrega' }, true));
  checar(/só com \*retirada no balcão\*/.test(r), '"delivery" na primeira mensagem: avisa que é só retirada');

  // ---------------------------------------- todas as cidades desmarcadas
  entregaDoc = { ...deliveryReal, cities: deliveryReal.cities.map((c) => ({ ...c, active: false })), pickup: comPickup(true) };
  checar(delivery.tipoUnico() === 'pickup', 'todas as cidades desmarcadas: vale como entrega desligada');
  await falar('Boa noite', {}, true);
  ({ r, s } = await falar('1 x tudo', { itens: [X('x_tudo', 1, '1 x tudo')] }));
  checar(!PERGUNTA_TIPO.test(r) && s.orderType === 'pickup', '   "1 x tudo": vira retirada sem perguntar');

  // ---------------------------------------- só entrega (retirada desligada)
  entregaDoc = { ...deliveryReal, pickup: comPickup(false) };
  checar(delivery.tipoUnico() === 'delivery', 'retirada desligada: só entrega');
  await falar('Boa noite', {}, true);
  ({ r, s } = await falar('1 x tudo', { itens: [X('x_tudo', 1, '1 x tudo')] }));
  checar(!PERGUNTA_TIPO.test(r) && s.orderType === 'delivery', '"1 x tudo": vira entrega sem perguntar');
  ({ r } = await falar('vou retirar', { entrega: 'retirada' }));
  checar(/só com \*entrega\*/.test(r), '"vou retirar": avisa que é só entrega');

  // ---------------------------------------- os dois ligados: como antes
  entregaDoc = { ...deliveryReal, pickup: comPickup(true) };
  checar(delivery.tipoUnico() === null && delivery.isDeliveryEnabled(), 'os dois ligados: o cliente escolhe');
  await falar('Boa noite', {}, true);
  ({ r, s } = await falar('1 x tudo', { itens: [X('x_tudo', 1, '1 x tudo')] }));
  checar(PERGUNTA_TIPO.test(r) && !s.orderType, '"1 x tudo": pergunta "Entrega ou retirada?", como antes');
  ({ r } = await falar('Tá fazendo entrega?', { pergunta: 'taxa_entrega' }));
  checar(/Sim! 🛵 Entregamos nestas cidades/.test(r), '   "Tá fazendo entrega?": "Sim!" e a lista, como antes');

  // ---------------------------------------- painel e site
  const erros = config.validar('delivery', { ...deliveryReal, delivery_enabled: false, pickup: { enabled: false } });
  checar(erros.some((e) => /marque entrega ou retirada/.test(e)), 'painel: entrega e retirada desligadas não salva');
  checar(!config.validar('delivery', { ...deliveryReal, delivery_enabled: false, pickup: comPickup(true) }).length,
    'painel: só retirada salva');
  const pagina = require(`${PROJECT}/src/api/painel-page`).render(15, 'nonce');
  const script = [...pagina.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  checar((() => { try { new Function(script); return true; } catch { return false; } })() && /Como o cliente recebe/.test(script),
    'painel: bloco "Como o cliente recebe", JavaScript válido');
  entregaDoc = { ...deliveryReal, delivery_enabled: false, pickup: comPickup(true) };
  const site = require(`${PROJECT}/src/services/pedidoweb`).cardapioPublico();
  checar(site.entrega === false && site.cidades.length === 0 && site.retirada, 'site: entrega false, sem cidades, com retirada');

  console.log('\n\x1b[32msoretiradatest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
