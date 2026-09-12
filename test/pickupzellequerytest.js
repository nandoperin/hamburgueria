// Exercita as queries reais com conexão isolada: nunca acessa o banco da loja.
process.env.DATABASE_URL = 'postgresql://fake';
const assert = require('node:assert/strict');
const pool = require('../src/db/client');
const db = require('../src/db/queries');

let consultas = [], liberado = true, falhaPagamento = false, soltou = false;
pool.connect = async () => ({
  query: async (sql, params) => {
    const texto = sql.replace(/\s+/g, ' ').trim();
    consultas.push({ texto, params });
    if (['begin', 'commit', 'rollback'].includes(texto)) return {};
    if (texto.startsWith('update orders')) {
      assert.match(texto, /set status = 'paid'/);
      assert.match(texto, /where id = \$1 and order_type = 'pickup' and status = 'pending'/);
      assert.deepEqual(params, [88]);
      return { rowCount: liberado ? 1 : 0, rows: liberado ? [{ id: 88 }] : [] };
    }
    assert.match(texto, /^insert into payments/);
    assert.match(texto, /values \(\$1, 'zelle', \$2, 'pending'\)/);
    assert.doesNotMatch(texto, /approved_|paid_at|proof_received_at/);
    assert.deepEqual(params, [88, 20]);
    if (falhaPagamento) throw new Error('falha simulada');
    return { rows: [{ order_id: 88, method: 'zelle', amount: 20, status: 'pending' }] };
  },
  release: () => { soltou = true; },
});
pool.query = async (sql, params) => {
  consultas.push({ texto: sql.replace(/\s+/g, ' ').trim(), params });
  return { rows: [] };
};

(async () => {
  const p = await db.createPickupZellePayment({ orderId: 88, amount: 20 });
  assert.equal(p.method, 'zelle');
  assert.equal(p.status, 'pending', 'cozinha liberada não significa dinheiro recebido');
  assert.equal(consultas[0].texto, 'begin');
  assert.equal(consultas.at(-1).texto, 'commit');
  assert.equal(consultas.length, 4);
  assert(soltou);

  // Recusa de entrega, cancelado ou repetição: a condição protegida não altera linha.
  liberado = false;
  consultas = []; soltou = false;
  await assert.rejects(db.createPickupZellePayment({ orderId: 88, amount: 20 }), /não está disponível/);
  assert.equal(consultas.at(-1).texto, 'rollback');
  assert(!consultas.some(q => q.texto.startsWith('insert')));
  assert(soltou);

  // Falha no registro do pagamento desfaz também a liberação da impressão.
  liberado = true; falhaPagamento = true;
  consultas = []; soltou = false;
  await assert.rejects(db.createPickupZellePayment({ orderId: 88, amount: 20 }), /falha simulada/);
  assert.equal(consultas.at(-1).texto, 'rollback');
  assert(!consultas.some(q => q.texto === 'commit'));
  assert(soltou);

  consultas = [];
  await db.getOrdersAwaitingReview();
  const revisao = consultas[0].texto;
  assert.match(revisao, /p.status = any\(array\['awaiting_review', 'review_reminded'\]/);
  assert.match(revisao, /p.method = 'zelle' and p.status = 'pending' and o.order_type = 'pickup'/);
  assert.match(revisao, /o.status = any\(array\['paid', 'printed', 'delivered'\]/);
  assert.match(revisao, /o.status <> all\(array\['cancelled', 'rejected'\]/);

  consultas = [];
  await db.getStalePendingOrders(30);
  assert.match(consultas[0].texto, /where status = 'pending'/,
    'retirada liberada não expira por falta de comprovante');
  consultas = [];
  await db.getOrderAwaitingProof('15550001111');
  assert.match(consultas[0].texto, /status = 'pending'/,
    'foto depois de liberar a retirada não deve gerar outra impressão');
  consultas = [];
  await db.getNextPrintableOrder();
  assert(consultas.some(q => /paid/.test(q.texto) || q.params?.flat().includes('paid')),
    'a fila já aceita a retirada liberada');
  console.log('Retirada Zelle: transação, bloqueios e queries passaram.');
})().catch(err => { console.error(err); process.exitCode = 1; });
