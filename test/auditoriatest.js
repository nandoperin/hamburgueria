/**
 * Achados da auditoria de segurança do food truck (10/2026) que valiam para a
 * hamburgueria — decisão do dono, 23/10/2026: A a H.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.LOG_LEVEL = 'silent';
process.env.ADMIN_PHONE = '18573531025';
delete process.env.META_VERIFY_TOKEN;

const PROJECT = require('path').resolve(__dirname, '..');
const menuProducao = require('./fixtures/menu-producao.json');
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
let cidadesAtivas = null; // null = as do arquivo
let taxaEverett = null;
config.get = (chave) => {
  if (chave === 'menu') return menuProducao;
  if (chave === 'promotions') return { ...getReal(chave), automatic: false, manual_active: false, disabled_date: null };
  if (chave === 'delivery') {
    const d = getReal(chave);
    return {
      ...d,
      cities: d.cities.map((c) => ({
        ...c,
        ...(c.id === 'everett' && taxaEverett != null ? { delivery_fee: taxaEverett } : {}),
        ...(cidadesAtivas && !cidadesAtivas.includes(c.id) ? { active: false } : {}),
      })),
    };
  }
  return getReal(chave);
};
require(`${PROJECT}/src/services/schedule`).isOpen = () => true;

const chamadas = [];
const settings = new Map();
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({
  getSetting: async (k) => settings.get(k) ?? null,
  setSetting: async (k, v) => { settings.set(k, v); },
  getCustomerByPhone: async (p) => (p === '18575551111' ? { id: 3, name: 'Maria', lang: 'pt' } : null),
  upsertCustomer: async (c) => { chamadas.push(['upsertCustomer', c]); return { id: 9, ...c }; },
  createOrder: async (o) => { chamadas.push(['createOrder', o]); return { id: 700, total: o.total, order_type: o.orderType }; },
  createCashPayment: async (p) => { chamadas.push(['cash', p]); },
  createZellePayment: async (p) => { chamadas.push(['zelle', p]); },
  getLastDeliveryOrderDoWhatsapp: async (phone, excluir) => { chamadas.push(['ultimoEndereco', excluir]); return null; },
}, { get: (alvo, k) => alvo[k] || (async () => null) });
require(`${PROJECT}/src/bot/notify`).send = async () => true;

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}
const linha = (id, qty, extra = {}) => ({ id, productId: id, name: id, nomeCozinha: id, qty, price: 12, ...extra });

(async () => {
  const { app } = require(`${PROJECT}/src/api`);
  const servidor = app.listen(0);
  const url = `http://127.0.0.1:${servidor.address().port}`;

  // A — verificação da Meta sem token configurado.
  let r = await fetch(`${url}/meta/webhook?hub.mode=subscribe&hub.challenge=%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
  checar(r.status === 403 && !(await r.text()).includes('<script>'), 'A: sem META_VERIFY_TOKEN, a verificação recusa (403) e não devolve o texto do link');
  process.env.META_VERIFY_TOKEN = 'token-certo';
  r = await fetch(`${url}/meta/webhook?hub.mode=subscribe&hub.verify_token=token-certo&hub.challenge=123`);
  checar(r.status === 200 && /text\/plain/.test(r.headers.get('content-type')) && (await r.text()) === '123',
    'A: com o token certo, devolve o challenge em texto puro');
  delete process.env.META_VERIFY_TOKEN;

  // D — admin pelo número completo.
  const admin = require(`${PROJECT}/src/bot/handlers/admin`);
  checar(admin.isAdminPhone('18573531025') && admin.isAdminPhone('8573531025'), 'D: o número do dono, com ou sem o 1, é admin');
  checar(!admin.isAdminPhone('5518573531025') && !admin.isAdminPhone('4418573531025'),
    'D: número de outro país terminado nos mesmos dígitos não é admin');

  // B — pedido do site não cria cadastro.
  process.env.PEDIR_ATIVO = 'on';
  const base = { nome: 'Fulano Inventado', pagamento: 'cash', entrega: { tipo: 'pickup' }, itens: [{ id: 'x_burger', qtd: 1 }] };
  r = await fetch(`${url}/pedir/pedido`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, telefone: '8575550123' }) });
  const pedidoSite = chamadas.find(([k]) => k === 'createOrder')?.[1];
  checar(r.status === 201 && !chamadas.some(([k]) => k === 'upsertCustomer') && pedidoSite.customerId === null &&
    pedidoSite.customerName === 'Fulano Inventado', 'B: telefone novo pelo site não ganha cadastro; o nome fica só no pedido');

  // C — endereço reoferecido no WhatsApp ignora pedidos do site.
  settings.set('pedidos_site', JSON.stringify([{ id: 501, origem: 'site', em: new Date().toISOString() }]));
  const welcome = require(`${PROJECT}/src/bot/handlers/welcome`);
  const sess = require(`${PROJECT}/src/bot/session`).get('18575551111');
  await welcome.handle(sess, 'Oi', async () => true);
  const consulta = chamadas.find(([k]) => k === 'ultimoEndereco');
  checar(consulta && consulta[1].includes(501), 'C: o último endereço do WhatsApp exclui os pedidos feitos pelo site');

  // E — limites: 10 do mesmo item, 30 no pedido.
  const limites = require(`${PROJECT}/src/services/limites`);
  checar(limites.excede([linha('x_burger', 6), linha('x_burger:-tomate', 5)])?.tipo === 'item', 'E: 11 X Burger em duas linhas passa do limite por item');
  checar(limites.excede([linha('x_burger', 10)]) === null, 'E: 10 do mesmo item passa');
  checar(limites.excede([linha('x_burger', 10), linha('x_tudo', 10), linha('hot_tudo', 10), linha('coca_cola', 1)])?.tipo === 'pedido',
    'E: 31 itens no pedido passa do limite');
  const pedidoweb = require(`${PROJECT}/src/services/pedidoweb`);
  const recusa = (itens) => { try { pedidoweb.orcar({ itens }); return null; } catch (e) { return e.codigo; } };
  checar(recusa([{ id: 'x_burger', qtd: 6 }, { id: 'x_burger', qtd: 5, remover: ['tomate'] }]) === 'limite_item', 'E: o site recusa 11 do mesmo item');
  checar(recusa([{ id: 'x_burger', qtd: 10 }, { id: 'x_tudo', qtd: 10 }, { id: 'hot_tudo', qtd: 10 }, { id: 'coca_cola', qtd: 1 }]) === 'limite_pedido',
    'E: o site recusa 31 itens');
  const order = require(`${PROJECT}/src/bot/handlers/order`);
  chamadas.length = 0;
  let saidas = [];
  const sessGrande = { phone: '15550001', lang: 'pt', orderType: 'pickup', name: 'Ana', state: 'CONFIRM',
    cart: [linha('x_burger', 11)], subtotal: 132, deliveryFee: 0, total: 132 };
  await order.createOrderAndPay(sessGrande, async (t) => saidas.push(t), 'cash');
  checar(!chamadas.some(([k]) => k === 'createOrder') && /até 10 unidades do mesmo item/.test(saidas.join()) && sessGrande.state === 'ORDER',
    'E: no WhatsApp, 11 do mesmo item não vira pedido; volta para ajustar');

  // F — taxa e cidade mudadas no painel no meio do pedido.
  const delivery = require(`${PROJECT}/src/services/delivery`);
  const cidadeVelha = { ...delivery.getCityById('everett') }; // copiada na escolha
  taxaEverett = 9;
  saidas = [];
  const sessTaxa = { phone: '15550002', lang: 'pt', orderType: 'delivery', name: 'Ana', state: 'CONFIRM', address: '1 Main St',
    city: cidadeVelha, cart: [linha('x_burger', 1)], subtotal: 12, deliveryFee: cidadeVelha.delivery_fee, total: 12 + cidadeVelha.delivery_fee, paymentMethod: 'cash' };
  await order.createOrderAndPay(sessTaxa, async (t) => saidas.push(t), 'cash');
  checar(!chamadas.some(([k]) => k === 'createOrder') && /taxa de entrega foi atualizada para \$9\.00/.test(saidas.join()) && sessTaxa.total === 21,
    'F: taxa mudou depois do resumo: o cliente vê o resumo novo com $9 antes de fechar');
  taxaEverett = null;
  cidadesAtivas = ['chelsea'];
  saidas = [];
  const sessCidade = { ...sessTaxa, phone: '15550003', city: { ...cidadeVelha }, deliveryFee: cidadeVelha.delivery_fee, state: 'CONFIRM' };
  await order.createOrderAndPay(sessCidade, async (t) => saidas.push(t), 'cash');
  checar(!chamadas.some(([k]) => k === 'createOrder') && /entrega para Everett não está disponível agora/.test(saidas.join()) && sessCidade.city === null,
    'F: cidade desligada no painel: o pedido não fecha e volta à pergunta da cidade');
  cidadesAtivas = null;

  // G — IP do cliente pelo X-Real-IP da Railway.
  const { ipDe } = require(`${PROJECT}/src/api/limite`);
  checar(ipDe({ headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '1.1.1.1, 9.9.9.9' }, ip: '9.9.9.9' }) === '203.0.113.7',
    'G: vale o X-Real-IP da Railway');
  checar(ipDe({ headers: {}, ip: '9.9.9.9' }) === '9.9.9.9', 'G: sem ele, o req.ip de sempre');

  // H — carrinho do catálogo passa pelo teto de mensagens.
  const vazao = require(`${PROJECT}/src/bot/vazao`);
  const avaliarReal = vazao.avaliar;
  vazao.avaliar = () => 'avisar';
  saidas = [];
  await require(`${PROJECT}/src/bot/router`).routeOrder('15550004', { items: [{ productId: 'x_burger', quantity: 1 }] }, async (t) => saidas.push(t));
  checar(saidas.length === 1 && !/Anotei/.test(saidas[0]), 'H: carrinho do catálogo acima do teto recebe só o aviso de excesso');
  vazao.avaliar = avaliarReal;

  servidor.close();
  console.log('\n\x1b[32mauditoriatest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
