process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';

const assert = require('assert');
const path = require('path');
const PROJECT = path.resolve(__dirname, '..');

require('./comentrega').ligar();

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
const orders = [];
const cashPayments = [];
require.cache[dbPath].exports = {
  upsertCustomer: async (c) => ({ id: 7, ...c }),
  createOrder: async (o) => {
    const created = { id: 70 + orders.length, status: 'pending', ...o };
    orders.push(created);
    return created;
  },
  createPayment: async () => { throw new Error('cash não pode criar Zelle'); },
  createCashPayment: async (p) => { cashPayments.push(p); return { ...p, method: 'cash', status: 'cash_due' }; },
};

const order = require(`${PROJECT}/src/bot/handlers/order`);
const tools = require(`${PROJECT}/src/ai/tools`);
const printer = require(`${PROJECT}/src/services/printer`);

function ready(phone) {
  return {
    phone,
    lang: 'pt',
    state: 'ORDER',
    orderType: 'pickup',
    name: 'Cliente Teste',
    city: null,
    address: null,
    subtotal: 20,
    deliveryFee: 0,
    total: 20,
    cart: [{ id: 'x_tudo', productId: 'x_tudo', name: 'X Tudo', qty: 1, price: 20 }],
  };
}

(async () => {
  const sent = [];
  const s = ready('15550001111');

  await order.startCheckout(s, async (m) => sent.push(m));
  assert.equal(s.state, 'PAYMENT_METHOD');
  assert.equal(orders.length, 0, 'escolher entrega/retirada ainda não cria pedido');

  await tools.executar('definir_pagamento', { metodo: 'cash' }, s,
    async (m) => sent.push(m), { textoCliente: 'vou pagar em dinheiro na retirada' });
  assert.equal(s.state, 'CONFIRM');
  assert.equal(orders.length, 0, 'cash segue ao resumo sem perguntar sobre troco');
  assert(!sent.join('\n').includes('troco'));

  await order.handleConfirm(s, 'sim', async (m) => sent.push(m));
  assert.equal(s.state, 'ORDER_COMPLETE');
  assert.equal(orders.length, 1);
  assert.equal(cashPayments[0].changeFor, null);
  assert.equal(s.cart.length, 0);
  assert(!sent.join('\n').includes('devolver'));

  const ticket = printer.buildTicket(orders[0], {
    method: 'cash', amount: 20, change_for: null,
  });
  assert(ticket.includes('PAGAMENTO: CASH'));
  assert(ticket.includes('COBRAR: $20.00'));
  assert(!ticket.includes('TROCO PARA'));
  assert(!ticket.includes('DEVOLVER'));

  const respostaNao = ready('15550003333');
  await order.startCheckout(respostaNao, async () => {});
  await order.handlePayment(respostaNao, 'dinheiro', async () => {});
  assert.equal(respostaNao.state, 'CONFIRM');
  await order.handleConfirm(respostaNao, 'sim', async () => {});
  assert.equal(respostaNao.state, 'ORDER_COMPLETE');
  assert.equal(cashPayments[1].changeFor, null);

  console.log('Fluxo cash sem pergunta de troco e impressão passaram.');
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
