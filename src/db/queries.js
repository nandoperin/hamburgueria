const db = require('./client');

const STATUS_ENTREGUE = ['paid', 'cash_due', 'printed', 'delivered'];
const STATUS_ATIVO = ['pending', 'awaiting_review', 'paid', 'cash_due', 'printed'];

async function primeira(sql, params = []) {
  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

async function ping() {
  await db.query('select id from orders limit 1');
  return true;
}

// ----------------------------------------------------------------- settings

async function getSetting(key) {
  const row = await primeira('select value from bot_settings where key = $1', [key]);
  return row?.value ?? null;
}

async function setSetting(key, value) {
  if (value === null) {
    await db.query('delete from bot_settings where key = $1', [key]);
    return;
  }
  await db.query(
    `insert into bot_settings (key, value, updated_at)
     values ($1, $2, now())
     on conflict (key) do update
       set value = excluded.value, updated_at = excluded.updated_at`,
    [key, value]
  );
}

// ------------------------------------------------------------- config editável

async function getConfigDocs() {
  const { rows } = await db.query('select key, doc, updated_at from config_docs');
  return rows;
}

async function setConfigDoc(key, doc, quem = null) {
  return primeira(
    `insert into config_docs (key, doc, updated_by, updated_at)
     values ($1, $2::jsonb, $3, now())
     on conflict (key) do update set
       doc = excluded.doc,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at
     returning *`,
    [key, JSON.stringify(doc), quem]
  );
}

async function registrarHistoricoConfig(key, docAntes, quem = null, resumo = null) {
  await db.query(
    `insert into config_historico (key, doc_antes, mudou_quem, resumo)
     values ($1, $2::jsonb, $3, $4)`,
    [key, JSON.stringify(docAntes), quem, resumo]
  );
}

async function getHistoricoConfig(key, limite = 20) {
  const { rows } = await db.query(
    `select id, key, mudou_em, mudou_quem, resumo
       from config_historico
      where key = $1
      order by mudou_em desc
      limit $2`,
    [key, limite]
  );
  return rows;
}

// ------------------------------------------------------------ conversas_log

const LIMITE_CONVERSAS = 6;

/**
 * Grava uma conversa encerrada e apaga o que sobrar além das 6 mais
 * recentes. As duas operações num só `await` (sem transação) são aceitáveis
 * aqui: na pior hipótese, uma gravação concorrente atrasa a limpeza por um
 * ciclo — não há corrupção de dado, só uma sétima linha por um instante.
 */
async function registrarConversa(phone, mensagens) {
  await db.query(
    'insert into conversas_log (phone, mensagens) values ($1, $2::jsonb)',
    [phone, JSON.stringify(mensagens)]
  );
  await db.query(
    `delete from conversas_log
      where id not in (select id from conversas_log order by criada_em desc limit ${LIMITE_CONVERSAS})`
  );
}

async function getConversasRecentes() {
  const { rows } = await db.query(
    `select id, phone, criada_em, mensagens
       from conversas_log
      order by criada_em desc
      limit ${LIMITE_CONVERSAS}`
  );
  return rows;
}

// ---------------------------------------------------------------- customers

async function upsertCustomer({ phone, lang, email = null, name = null }) {
  return primeira(
    `insert into customers (phone, lang, email, name, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (phone) do update set
       lang = excluded.lang,
       email = coalesce(excluded.email, customers.email),
       name = coalesce(excluded.name, customers.name),
       updated_at = excluded.updated_at
     returning *`,
    [phone, lang, email, name]
  );
}

async function getCustomerByPhone(phone) {
  return primeira('select * from customers where phone = $1', [phone]);
}

async function listCustomerEmails() {
  const { rows } = await db.query(
    `select phone, email, lang, created_at
       from customers
      where email is not null`
  );
  return rows;
}

// ------------------------------------------------------------------- orders

async function createOrder({
  customerId,
  phone,
  lang,
  orderType = 'delivery',
  customerName = null,
  items,
  city,
  address,
  subtotal,
  deliveryFee,
  total,
}) {
  return primeira(
    `insert into orders (
       customer_id, phone, lang, order_type, customer_name, items_json,
       city, address, subtotal, delivery_fee, total, status
     ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, 'pending')
     returning *`,
    [customerId, phone, lang, orderType, customerName, JSON.stringify(items),
      city, address, subtotal, deliveryFee, total]
  );
}

async function getLastDeliveryOrder(phone) {
  return primeira(
    `select city, address, created_at
       from orders
      where phone = $1 and order_type = 'delivery'
      order by created_at desc
      limit 1`,
    [phone]
  );
}

async function getUltimoPedidoFeito(phone) {
  return primeira(
    `select items_json, city, address, order_type, created_at
       from orders
      where phone = $1 and status = any($2::text[])
      order by created_at desc
      limit 1`,
    [phone, STATUS_ENTREGUE]
  );
}

async function getOrder(id) {
  return primeira('select * from orders where id = $1', [id]);
}

async function updateOrderStatus(id, status) {
  return primeira('update orders set status = $2 where id = $1 returning *', [id, status]);
}

async function getNextPrintableOrder() {
  return primeira(
    `select * from orders
      where status = any(array['paid', 'cash_due']::text[])
        and (print_claimed_at is null or print_claimed_at < now() - interval '45 seconds')
      order by created_at asc limit 1`
  );
}

async function markOrderPrinted(id) {
  return updateOrderStatus(id, 'printed');
}

// -------------------------------------------------------- agente de impressão

async function savePrinterPairingCode(codeHash, expiresAt, createdBy) {
  await db.query(
    `insert into printer_pairing_codes (id, code_hash, expires_at, created_at, created_by)
     values (1, $1, $2, now(), $3)
     on conflict (id) do update set
       code_hash = excluded.code_hash,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at,
       created_by = excluded.created_by`,
    [codeHash, expiresAt, createdBy]
  );
}

async function consumePrinterPairingCode(codeHash, device) {
  const client = await db.connect();
  try {
    await client.query('begin');
    const code = await client.query(
      `delete from printer_pairing_codes
        where id = 1 and code_hash = $1 and expires_at > now()
        returning id`,
      [codeHash]
    );
    if (!code.rowCount) {
      await client.query('rollback');
      return null;
    }

    // Um aparelho por vez: impede duplicidade e revoga um celular perdido.
    await client.query(
      `update printer_devices
          set active = false, revoked_at = now()
        where active = true`
    );
    const result = await client.query(
      `insert into printer_devices (id, name, token_hash)
       values ($1, $2, $3)
       returning id, name, created_at`,
      [device.id, device.name, device.tokenHash]
    );
    await client.query('commit');
    return result.rows[0];
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

async function authenticatePrinterDevice(tokenHash) {
  return primeira(
    `update printer_devices
        set last_seen_at = now()
      where token_hash = $1 and active = true
      returning id, name, created_at, last_seen_at`,
    [tokenHash]
  );
}

async function listPrinterDevices() {
  const { rows } = await db.query(
    `select id, name, active, created_at, last_seen_at, revoked_at
       from printer_devices order by created_at desc`
  );
  return rows;
}

async function revokePrinterDevices() {
  const result = await db.query(
    `update printer_devices set active = false, revoked_at = now()
      where active = true`
  );
  await db.query(
    `update orders set print_claim_token_hash = null, print_claim_device = null,
                       print_claimed_at = null
      where status = any(array['paid', 'cash_due']::text[])
        and print_claim_device is not null`
  );
  return result.rowCount;
}

async function claimNextPrintableOrder(deviceId, claimTokenHash) {
  return primeira(
    `with candidato as (
       select id from orders
        where status = any(array['paid', 'cash_due']::text[])
          and (print_claimed_at is null or print_claimed_at < now() - interval '45 seconds')
        order by created_at asc
        for update skip locked
        limit 1
     )
     update orders o
        set print_claim_token_hash = $2,
            print_claim_device = $1,
            print_claimed_at = now()
       from candidato c
      where o.id = c.id
      returning o.*`,
    [deviceId, claimTokenHash]
  );
}

async function completeClaimedPrint(orderId, deviceId, claimTokenHash) {
  return primeira(
    `update orders
        set status = 'printed', print_claim_token_hash = null,
            print_claim_device = null, print_claimed_at = null
      where id = $1 and status = any(array['paid', 'cash_due']::text[])
        and print_claim_device = $2
        and print_claim_token_hash = $3
      returning id, status`,
    [orderId, deviceId, claimTokenHash]
  );
}

async function releaseClaimedPrint(orderId, deviceId, claimTokenHash) {
  return primeira(
    `update orders
        set print_claim_token_hash = null, print_claim_device = null,
            print_claimed_at = null
      where id = $1 and status = any(array['paid', 'cash_due']::text[])
        and print_claim_device = $2
        and print_claim_token_hash = $3
      returning id`,
    [orderId, deviceId, claimTokenHash]
  );
}

// ----------------------------------------------------------------- payments

async function createPayment({ orderId, amount, method = 'zelle' }) {
  return primeira(
    `insert into payments (order_id, method, amount, status)
     values ($1, $2, $3, 'pending') returning *`,
    [orderId, method, amount]
  );
}

/** Registra cash a cobrar e libera a impressão na mesma transação curta. */
async function createCashPayment({ orderId, amount, changeFor = null }) {
  const client = await db.connect();
  try {
    await client.query('begin');
    const payment = await client.query(
      `insert into payments (order_id, method, amount, status, change_for)
       values ($1, 'cash', $2, 'cash_due', $3) returning *`,
      [orderId, amount, changeFor]
    );
    const order = await client.query(
      `update orders set status = 'cash_due'
        where id = $1 and status = 'pending' returning id`,
      [orderId]
    );
    if (!order.rowCount) throw new Error('pedido não está disponível para cash');
    await client.query('commit');
    return payment.rows[0];
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** Registra a chegada sem guardar o arquivo enviado pelo cliente. */
async function markProofReceived(orderId) {
  return primeira(
    `with pagamento as (
       update payments
          set status = 'awaiting_review', proof_received_at = now()
        where order_id = $1
        returning *
     ), pedido as (
       update orders
          set status = 'awaiting_review'
        where id = $1 and exists (select 1 from pagamento)
        returning id
     )
     select pagamento.* from pagamento join pedido on true`,
    [orderId]
  );
}

async function markReviewReminderSent(orderId) {
  return primeira(
    `update payments
        set status = 'review_reminded'
      where order_id = $1 and status = 'awaiting_review'
      returning *`,
    [orderId]
  );
}

async function approvePayment(orderId, approvedBy) {
  return primeira(
    `update payments
        set status = 'paid', approved_by = $2, approved_at = now(), paid_at = now()
      where order_id = $1
      returning *`,
    [orderId, approvedBy]
  );
}

async function rejectPayment(orderId, reason) {
  return primeira(
    `update payments
        set status = 'rejected', rejected_reason = $2
      where order_id = $1
      returning *`,
    [orderId, reason || null]
  );
}

async function getPaymentByOrderId(orderId) {
  return primeira(
    `select * from payments where order_id = $1 order by id desc limit 1`,
    [orderId]
  );
}

async function getActiveOrderByPhone(phone) {
  return primeira(
    `select * from orders
      where phone = $1 and status = any($2::text[])
      order by id desc limit 1`,
    [phone, STATUS_ATIVO]
  );
}

async function getOrderAwaitingProof(phone) {
  return primeira(
    `select * from orders
      where phone = $1 and status = 'pending'
      order by id desc limit 1`,
    [phone]
  );
}

async function getOrdersAwaitingReview() {
  const { rows } = await db.query(
    `select o.*,
            coalesce((
              select jsonb_agg(jsonb_build_object(
                'status', p.status,
                'proof_received_at', p.proof_received_at
              ) order by p.id desc)
              from payments p where p.order_id = o.id
            ), '[]'::jsonb) as payments
       from orders o
      where o.status = 'awaiting_review'
      order by o.created_at asc`
  );
  return rows;
}

async function getStalePendingOrders(minutos) {
  const { rows } = await db.query(
    `select * from orders
      where status = 'pending'
        and created_at < now() - ($1 * interval '1 minute')
      order by created_at asc`,
    [minutos]
  );
  return rows;
}

// ----------------------------------------------------------------- consumo IA

/** Incremento atômico para duas instâncias nunca sobrescreverem o consumo. */
async function registrarUsoIA({ tokensIn = 0, tokensOut = 0, custoUsd = 0 }) {
  return primeira(
    `insert into ai_usage (dia, chamadas, tokens_in, tokens_out, custo_usd, updated_at)
     values ((now() at time zone 'UTC')::date, 1, $1, $2, $3, now())
     on conflict (dia) do update set
       chamadas = ai_usage.chamadas + 1,
       tokens_in = ai_usage.tokens_in + excluded.tokens_in,
       tokens_out = ai_usage.tokens_out + excluded.tokens_out,
       custo_usd = ai_usage.custo_usd + excluded.custo_usd,
       updated_at = excluded.updated_at
     returning *`,
    [tokensIn, tokensOut, custoUsd]
  );
}

async function getUsoIA(dia = new Date().toISOString().slice(0, 10)) {
  return primeira('select * from ai_usage where dia = $1::date', [dia]);
}

// ----------------------------------------------------- disponibilidade

async function listUnavailableItems() {
  const { rows } = await db.query(
    'select item_id from item_availability where available = false'
  );
  return rows.map((row) => row.item_id);
}

async function setItemAvailability(itemId, available) {
  await db.query(
    `insert into item_availability (item_id, available, updated_at)
     values ($1, $2, now())
     on conflict (item_id) do update set
       available = excluded.available, updated_at = excluded.updated_at`,
    [itemId, available]
  );
}

// ------------------------------------------------------- busca de pedidos

async function getOrdersByPhone(phone, limit = 5) {
  const { rows } = await db.query(
    'select * from orders where phone = $1 order by id desc limit $2',
    [phone, limit]
  );
  return rows;
}

async function getRecentOrders(limit = 10) {
  const { rows } = await db.query('select * from orders order by id desc limit $1', [limit]);
  return rows;
}

// --------------------------------------------------------------- relatórios

async function pedidosPagos(from, to, colunas) {
  const { rows } = await db.query(
    `select ${colunas} from orders
      where created_at >= $1 and created_at < $2
        and status = any($3::text[])`,
    [from, to, STATUS_ENTREGUE]
  );
  return rows;
}

async function getReport(from, to) {
  const orders = await pedidosPagos(
    from, to, 'id, total, subtotal, delivery_fee, items_json, status, created_at'
  );
  const revenue = orders.reduce((sum, o) => sum + Number(o.total), 0);
  const deliveryFees = orders.reduce((sum, o) => sum + Number(o.delivery_fee), 0);
  const itemCounts = {};
  for (const order of orders) {
    const items = Array.isArray(order.items_json) ? order.items_json : [];
    for (const item of items) {
      const key = item.name || item.id;
      if (!itemCounts[key]) itemCounts[key] = { name: key, qty: 0, revenue: 0 };
      itemCounts[key].qty += item.qty;
      itemCounts[key].revenue += item.qty * Number(item.price);
    }
  }
  return {
    orderCount: orders.length,
    revenue,
    deliveryFees,
    avgTicket: orders.length ? revenue / orders.length : 0,
    topItems: Object.values(itemCounts).sort((a, b) => b.qty - a.qty).slice(0, 5),
  };
}

async function getRevenueByDay(from, to) {
  const orders = await pedidosPagos(from, to, 'total, created_at');
  const byDay = {};
  for (const order of orders) {
    const day = order.created_at.slice(0, 10);
    if (!byDay[day]) byDay[day] = { day, count: 0, revenue: 0 };
    byDay[day].count += 1;
    byDay[day].revenue += Number(order.total);
  }
  return Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));
}

async function getReportByCity(from, to) {
  const orders = await pedidosPagos(from, to, 'city, order_type, total, delivery_fee');
  const porCidade = {};
  for (const o of orders) {
    const chave = o.order_type === 'pickup' ? '(retirada)' : o.city || '(sem cidade)';
    if (!porCidade[chave]) porCidade[chave] = { cidade: chave, pedidos: 0, receita: 0, taxas: 0 };
    porCidade[chave].pedidos += 1;
    porCidade[chave].receita += Number(o.total);
    porCidade[chave].taxas += Number(o.delivery_fee);
  }
  return Object.values(porCidade).sort((a, b) => b.receita - a.receita);
}

async function getReportByHour(from, to, tz = 'America/New_York') {
  const orders = await pedidosPagos(from, to, 'created_at, total');
  const horas = Array.from({ length: 24 }, (_, h) => ({ hora: h, pedidos: 0, receita: 0 }));
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false });
  for (const o of orders) {
    const h = Number(fmt.format(new Date(o.created_at))) % 24;
    horas[h].pedidos += 1;
    horas[h].receita += Number(o.total);
  }
  return horas;
}

async function getReportClientes(from, to) {
  const orders = await pedidosPagos(from, to, 'phone, customer_name, total, created_at');
  const porFone = {};
  for (const o of orders) {
    if (!porFone[o.phone]) {
      porFone[o.phone] = { phone: o.phone, nome: o.customer_name, pedidos: 0, total: 0 };
    }
    porFone[o.phone].pedidos += 1;
    porFone[o.phone].total += Number(o.total);
    if (o.customer_name) porFone[o.phone].nome = o.customer_name;
  }
  const todos = Object.values(porFone).sort((a, b) => b.total - a.total);
  return {
    total: todos.length,
    recorrentes: todos.filter((c) => c.pedidos > 1).length,
    top: todos.slice(0, 10),
  };
}

async function getPendingOrders() {
  const { rows } = await db.query(
    `select * from orders where status = any($1::text[]) order by created_at asc`,
    [['paid', 'cash_due', 'printed']]
  );
  return rows;
}

async function getUnprintedPaidOrders() {
  const { rows } = await db.query(
    `select o.*,
            coalesce((
              select jsonb_agg(jsonb_build_object('paid_at', p.paid_at, 'status', p.status)
                               order by p.id desc)
              from payments p where p.order_id = o.id
            ), '[]'::jsonb) as payments
       from orders o
      where o.status = any(array['paid', 'cash_due']::text[])
      order by o.created_at asc`
  );
  return rows;
}

module.exports = {
  ping,
  getSetting,
  setSetting,
  getConfigDocs,
  setConfigDoc,
  registrarHistoricoConfig,
  getHistoricoConfig,
  registrarConversa,
  getConversasRecentes,
  upsertCustomer,
  getCustomerByPhone,
  listCustomerEmails,
  createOrder,
  getOrder,
  getLastDeliveryOrder,
  getUltimoPedidoFeito,
  updateOrderStatus,
  getNextPrintableOrder,
  markOrderPrinted,
  savePrinterPairingCode,
  consumePrinterPairingCode,
  authenticatePrinterDevice,
  listPrinterDevices,
  revokePrinterDevices,
  claimNextPrintableOrder,
  completeClaimedPrint,
  releaseClaimedPrint,
  createPayment,
  createCashPayment,
  markProofReceived,
  markReviewReminderSent,
  approvePayment,
  rejectPayment,
  getPaymentByOrderId,
  getActiveOrderByPhone,
  getOrderAwaitingProof,
  getOrdersAwaitingReview,
  getStalePendingOrders,
  registrarUsoIA,
  getUsoIA,
  listUnavailableItems,
  setItemAvailability,
  getOrdersByPhone,
  getRecentOrders,
  getReport,
  getRevenueByDay,
  getReportByCity,
  getReportByHour,
  getReportClientes,
  getPendingOrders,
  getUnprintedPaidOrders,
};
