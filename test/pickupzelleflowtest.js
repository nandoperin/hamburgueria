process.env.DATABASE_URL = 'postgresql://fake';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.ADMIN_PHONE = '15550001111';
process.env.AI_ENABLED = 'off';

const assert = require('node:assert/strict');
require('./comentrega').ligar();
require('../src/services/schedule').isOpen = () => true;

const db = require('../src/db/queries');
const pedidos = [], pagamentos = new Map(), avisos = [];
let aprovacoes = 0, mudancasStatus = 0;
const achar = id => pedidos.find(o => o.id === id);
Object.assign(db, {
  upsertCustomer: async c => ({ id: 1, ...c }),
  createOrder: async o => {
    const salvo = { id: 80 + pedidos.length, status: 'pending', phone: o.phone,
      lang: o.lang, customer_name: o.customerName, order_type: o.orderType,
      city: o.city, address: o.address, total: o.total, subtotal: o.subtotal,
      delivery_fee: o.deliveryFee, items_json: structuredClone(o.items), created_at: new Date().toISOString() };
    pedidos.push(salvo);
    return { ...salvo };
  },
  createPayment: async p => {
    assert.equal(achar(p.orderId).order_type, 'delivery');
    pagamentos.set(p.orderId, { method: 'zelle', status: 'pending', amount: p.amount });
  },
  createPickupZellePayment: async p => {
    assert.equal(achar(p.orderId).order_type, 'pickup');
    achar(p.orderId).status = 'paid';
    pagamentos.set(p.orderId, { method: 'zelle', status: 'pending', amount: p.amount });
  },
  createCashPayment: async p => {
    achar(p.orderId).status = 'cash_due';
    pagamentos.set(p.orderId, { method: 'cash', status: 'cash_due', amount: p.amount });
  },
  getOrder: async id => ({ ...achar(id) }),
  getPaymentByOrderId: async id => ({ ...pagamentos.get(id) }),
  getActiveOrderByPhone: async phone => pedidos.find(o => o.phone === phone) || null,
  approvePayment: async (id, por) => {
    aprovacoes++;
    pagamentos.set(id, { ...pagamentos.get(id), status: 'paid', approved_by: por });
  },
  updateOrderStatus: async (id, status) => { mudancasStatus++; achar(id).status = status; },
  getOrdersAwaitingReview: async () => pedidos.filter(o => o.order_type === 'pickup' &&
    ['paid', 'printed', 'delivered'].includes(o.status) && pagamentos.get(o.id)?.status === 'pending')
    .map(o => ({ ...o, payments: [{ ...pagamentos.get(o.id) }] })),
  getStalePendingOrders: async () => [],
  markReviewReminderSent: async () => { throw new Error('retirada não recebeu comprovante'); },
});
const notify = require('../src/bot/notify');
notify.send = async (phone, text) => { avisos.push({ phone, text }); return true; };
require('../src/services/zelle').conferir = () => ({ ok: true });

const order = require('../src/bot/handlers/order');
const tools = require('../src/ai/tools');
const session = require('../src/bot/session');
const router = require('../src/bot/router');
const printer = require('../src/services/printer');
const admin = require('../src/bot/handlers/admin');

function pronto(tipo, lang = 'pt') {
  const sess = session.get(`15559990${String(pedidos.length).padStart(3, '0')}`);
  Object.assign(sess, { lang, greeted: true, state: 'ORDER', orderType: tipo,
    name: 'Cliente Teste', city: tipo === 'delivery' ? { id: 'everett', label: 'Everett', delivery_fee: 5 } : null,
    address: tipo === 'delivery' ? '100 Main St' : null,
    cart: [{ id: 'x_tudo', productId: 'x_tudo', name: 'X Tudo', qty: 1, price: 20 }] });
  return sess;
}
async function comando(texto) {
  const respostas = [];
  await admin.handle('15550001111', texto, async t => respostas.push(t));
  return respostas.join('\n');
}

(async () => {
  let retirada;
  for (const tipo of ['pickup', 'delivery']) {
    for (const metodo of ['zelle', 'cash']) {
      const sess = pronto(tipo), respostas = [], antes = pedidos.length;
      const send = async t => respostas.push(t);
      await order.startCheckout(sess, send);
      assert.equal(sess.state, 'PAYMENT_METHOD');
      await order.handlePayment(sess, metodo, send);
      assert.equal(sess.state, 'CONFIRM');
      assert.match(respostas.join('\n'), /RESUMO DO PEDIDO/);
      assert.equal(pedidos.length, antes, 'nunca imprimir antes de confirmar o resumo');
      respostas.length = 0;
      const r = await tools.executar('confirmar_resumo', {}, sess, send);
      assert.equal(r.entregouAoFluxo, true);
      assert.equal(pedidos.length, antes + 1);
      assert.equal(sess.cart.length, 0);
      const espera = tipo === 'delivery' && metodo === 'zelle';
      assert.equal(sess.state, espera ? 'PAYMENT_PENDING' : 'ORDER_COMPLETE');
      assert.equal(achar(sess.orderId).status, espera ? 'pending' : metodo === 'cash' ? 'cash_due' : 'paid');
      assert.equal(pagamentos.get(sess.orderId).method, metodo);
      assert.equal(pagamentos.get(sess.orderId).status, metodo === 'cash' ? 'cash_due' : 'pending');
      if (espera) {
        assert.match(respostas[0], /Aguardo o print do comprovante/);
        assert.match(respostas[0], /Envie por \*Zelle\*/);
      } else {
        assert.match(respostas[0], /enviado para a cozinha/);
        assert.match(respostas[0], tipo === 'pickup' ? /Média de 25 minutos/ : /1h/);
        assert.doesNotMatch(respostas[0], /comprovante|troco|pagamento confirmado/i);
      }
      if (tipo === 'pickup' && metodo === 'zelle') {
        retirada = sess;
        assert.match(respostas[0], /caixa confere o pagamento na retirada/);
        const salvo = achar(sess.orderId), pg = pagamentos.get(sess.orderId);
        for (const formatar of [printer.buildTicket, printer.buildTicketMarkup, printer.buildTicketStarprnt]) {
          const comanda = String(formatar(salvo, pg));
          assert.match(comanda, /PAGAMENTO: ZELLE/);
          assert.match(comanda, /CONFERIR NO CAIXA NA RETIRADA/);
          assert.doesNotMatch(comanda, /CONFIRMADO|COMPROVANTE RECEBIDO|PAGAMENTO: CASH/);
        }
        respostas.length = 0;
        await router.route(sess.phone, 'obrigado', send);
        assert.match(respostas.join('\n'), /caixa confere o Zelle na retirada/);
        assert.doesNotMatch(respostas.join('\n'), /comprovante|cash|aguardo/i);
        await tools.executar('confirmar_resumo', {}, sess, send);
        assert.equal(pedidos.length, antes + 1, 'confirmar de novo não duplica pedido');
      }
    }
  }

  assert.equal(aprovacoes, 0, 'nenhuma escolha de pagamento é tratada como dinheiro recebido');
  const caixa = require('../src/services/caixa').classificar([{
    id: retirada.orderId, total: 20, order_status: 'printed', method: 'zelle', payment_status: 'pending',
  }]);
  assert.equal(caixa.aConferir.total, 20);
  assert.equal(caixa.conferido.total, 0);
  assert.match(await comando('!conferir'), /conferir no caixa na retirada/);
  await require('../src/services/pagamentowatch').verificar();
  assert.equal(avisos.length, 0, 'retirada sem comprovante não recebe lembrete nem expira');
  assert.equal(achar(retirada.orderId).status, 'paid');

  achar(retirada.orderId).status = 'printed';
  assert.match(await comando(`!liberar ${retirada.orderId}`), /CONFERIDO/);
  assert.equal(aprovacoes, 1);
  assert.equal(pagamentos.get(retirada.orderId).status, 'paid');
  assert.equal(achar(retirada.orderId).status, 'printed');
  assert.equal(mudancasStatus, 0, 'conferir no caixa não recoloca o pedido na impressora');
  assert.equal(avisos.length, 0, 'conferência não repete a mensagem de preparo ao cliente');
  await comando(`!liberar ${retirada.orderId}`);
  assert.equal(aprovacoes, 1, 'conferência repetida não faz nova alteração');

  for (const lang of ['en', 'es']) {
    const sess = pronto('pickup', lang), respostas = [];
    sess.paymentMethod = 'zelle';
    await order.mostrarResumo(sess, async () => {});
    const r = await tools.executar('confirmar_resumo', {}, sess, async t => respostas.push(t));
    assert.equal(r.entregouAoFluxo, true);
    assert.equal(sess.state, 'ORDER_COMPLETE');
    assert.match(respostas[0], /Zelle/);
    assert.doesNotMatch(respostas[0], /screenshot|comprobante|\{\w+\}/i);
  }
  console.log('Retirada/entrega × Zelle/cash, comanda e conferência no caixa passaram.');
})().catch(err => { console.error(err); process.exitCode = 1; });
