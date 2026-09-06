/** Verificação real e recuperável da camada PostgreSQL. */
require('dotenv').config({ quiet: true });

const assert = require('node:assert/strict');
const db = require('../src/db/queries');
const pool = require('../src/db/client');

const phone = '19999990000';
const setting = 'teste_migracao_postgres';
const item = 'teste_migracao_item';

async function limpar() {
  await pool.query('delete from payments where order_id in (select id from orders where phone = $1)', [phone]);
  await pool.query('delete from orders where phone = $1', [phone]);
  await pool.query('delete from customers where phone = $1', [phone]);
  await pool.query('delete from bot_settings where key = $1', [setting]);
  await pool.query('delete from item_availability where item_id = $1', [item]);
}

async function main() {
  await limpar();
  await db.ping();

  await db.setSetting(setting, 'ok');
  assert.equal(await db.getSetting(setting), 'ok');

  await db.setItemAvailability(item, false);
  assert.ok((await db.listUnavailableItems()).includes(item));

  const customer = await db.upsertCustomer({ phone, lang: 'pt', name: 'Teste PostgreSQL' });
  assert.equal(typeof customer.id, 'number');

  const order = await db.createOrder({
    customerId: customer.id,
    phone,
    lang: 'pt',
    orderType: 'pickup',
    customerName: 'Teste PostgreSQL',
    items: [{ id: 'teste', name: 'Teste', qty: 1, price: 1 }],
    city: 'Everett',
    address: 'Teste',
    subtotal: 1,
    deliveryFee: 0,
    total: 1,
  });
  assert.equal(order.total, 1);

  await db.createPayment({ orderId: order.id, amount: 1 });
  assert.equal((await db.getOrderAwaitingProof(phone)).id, order.id);

  const proof = await db.markProofReceived(order.id);
  assert.equal(proof.status, 'awaiting_review');
  assert.equal(typeof proof.proof_received_at, 'string');
  assert.ok((await db.getOrdersAwaitingReview()).some((row) => row.id === order.id));

  await db.approvePayment(order.id, phone);
  await db.updateOrderStatus(order.id, 'paid');
  // Garante que o pedido temporário seja o próximo da fila mesmo quando o
  // banco já contém pedidos reais migrados aguardando impressão.
  await pool.query("update orders set created_at = timestamp '2000-01-01 00:00:00' where id = $1", [order.id]);
  assert.equal((await db.getNextPrintableOrder()).id, order.id);
  await db.markOrderPrinted(order.id);
  assert.equal((await db.getOrder(order.id)).status, 'printed');

  console.log('PostgreSQL verificado: leitura, gravação, comprovante sem arquivo e fila de impressão.');
}

main().catch((err) => {
  console.error(`Erro: ${err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  try { await limpar(); } finally { await pool.end(); }
});
