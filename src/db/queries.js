const supabase = require('./client');

/**
 * Consulta mínima só para saber se o banco responde.
 *
 * Usada pelo `/health`: o processo pode estar de pé, servindo HTTP, e ainda
 * assim incapaz de gravar um pedido — chave rotacionada, projeto pausado,
 * Supabase fora do ar. Do lado de fora isso é indistinguível de tudo bem.
 */
async function ping() {
  const { error } = await supabase.from('orders').select('id').limit(1);
  if (error) throw error;
  return true;
}

// ----------------------------------------------------------------- settings

/**
 * Estado do bot que precisa sobreviver a um deploy — hoje só o encerramento
 * manual do atendimento.
 *
 * Em memória não serviria: um deploy no meio da noite reabriria a loja
 * sozinho, com a cozinha já desmontada e ninguém percebendo.
 */
async function getSetting(key) {
  const { data, error } = await supabase
    .from('bot_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (error) throw error;
  return data?.value ?? null;
}

async function setSetting(key, value) {
  if (value === null) {
    const { error } = await supabase.from('bot_settings').delete().eq('key', key);
    if (error) throw error;
    return;
  }

  const { error } = await supabase
    .from('bot_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });

  if (error) throw error;
}

// ------------------------------------------------------------- config editável

/**
 * Documentos de configuração que o dono edita pelo painel.
 *
 * Guardados como JSONB inteiro, e não em tabelas normalizadas, porque o formato
 * do `menu.json` — categorias com itens, itens com modificadores — já é o que
 * `cardapio.js`, o prompt da IA e os testes consomem. Normalizar exigiria
 * reescrever tudo isso por um ganho que ninguém usa: os relatórios consultam
 * `orders.items_json`, nunca o cardápio.
 *
 * Ver `src/services/config.js` para o porquê de a config sair dos arquivos.
 */
async function getConfigDocs() {
  const { data, error } = await supabase.from('config_docs').select('key, doc, updated_at');
  if (error) throw error;
  return data || [];
}

async function setConfigDoc(key, doc, quem = null) {
  const { data, error } = await supabase
    .from('config_docs')
    .upsert(
      { key, doc, updated_by: quem, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Guarda o documento ANTERIOR a uma mudanca.
 *
 * O anterior, e nao o novo: o novo ja esta em `config_docs`, e e o anterior que
 * permite desfazer. Registro, nao caminho critico — falhar aqui nao pode
 * desfazer uma gravacao que ja aconteceu.
 */
async function registrarHistoricoConfig(key, docAntes, quem = null, resumo = null) {
  const { error } = await supabase
    .from('config_historico')
    .insert({ key, doc_antes: docAntes, mudou_quem: quem, resumo });

  if (error) throw error;
}

async function getHistoricoConfig(key, limite = 20) {
  const { data, error } = await supabase
    .from('config_historico')
    .select('id, key, mudou_em, mudou_quem, resumo')
    .eq('key', key)
    .order('mudou_em', { ascending: false })
    .limit(limite);

  if (error) throw error;
  return data || [];
}

/**
 * Faturamento por cidade.
 *
 * Serve a uma decisao concreta: manter ou nao uma area de entrega. Uma cidade
 * com dois pedidos no mes e taxa que nao paga a gasolina aparece aqui, e em
 * lugar nenhum mais — o relatorio geral a dilui no total.
 */
async function getReportByCity(from, to) {
  const { data, error } = await supabase
    .from('orders')
    .select('city, order_type, total, delivery_fee')
    .gte('created_at', from)
    .lt('created_at', to)
    .in('status', ['paid', 'printed', 'delivered']);

  if (error) throw error;

  const porCidade = {};
  for (const o of data || []) {
    const chave = o.order_type === 'pickup' ? '(retirada)' : o.city || '(sem cidade)';
    if (!porCidade[chave]) porCidade[chave] = { cidade: chave, pedidos: 0, receita: 0, taxas: 0 };
    porCidade[chave].pedidos += 1;
    porCidade[chave].receita += Number(o.total);
    porCidade[chave].taxas += Number(o.delivery_fee);
  }

  return Object.values(porCidade).sort((a, b) => b.receita - a.receita);
}

/**
 * Pedidos por hora do dia.
 *
 * Decide escala de equipe. A hora sai no fuso do estabelecimento, e nao em UTC:
 * um pico das 19h apareceria como meia-noite e ninguem entenderia o grafico.
 */
async function getReportByHour(from, to, tz = 'America/New_York') {
  const { data, error } = await supabase
    .from('orders')
    .select('created_at, total')
    .gte('created_at', from)
    .lt('created_at', to)
    .in('status', ['paid', 'printed', 'delivered']);

  if (error) throw error;

  const horas = Array.from({ length: 24 }, (_, h) => ({ hora: h, pedidos: 0, receita: 0 }));
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false });

  for (const o of data || []) {
    const h = Number(fmt.format(new Date(o.created_at))) % 24;
    horas[h].pedidos += 1;
    horas[h].receita += Number(o.total);
  }

  return horas;
}

/**
 * Clientes: quantos voltaram.
 *
 * Recorrencia e o numero que diz se o negocio esta funcionando — mais barato
 * que trazer cliente novo, e invisivel no faturamento do dia.
 */
async function getReportClientes(from, to) {
  const { data, error } = await supabase
    .from('orders')
    .select('phone, customer_name, total, created_at')
    .gte('created_at', from)
    .lt('created_at', to)
    .in('status', ['paid', 'printed', 'delivered']);

  if (error) throw error;

  const porFone = {};
  for (const o of data || []) {
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

// ---------------------------------------------------------------- customers

async function upsertCustomer({ phone, lang, email = null, name = null }) {
  const patch = { phone, lang, updated_at: new Date().toISOString() };
  if (email) patch.email = email;
  if (name) patch.name = name;

  const { data, error } = await supabase
    .from('customers')
    .upsert(patch, { onConflict: 'phone' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getCustomerByPhone(phone) {
  const { data, error } = await supabase
    .from('customers')
    .select()
    .eq('phone', phone)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function listCustomerEmails() {
  const { data, error } = await supabase
    .from('customers')
    .select('phone, email, lang, created_at')
    .not('email', 'is', null);

  if (error) throw error;
  return data || [];
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
  const { data, error } = await supabase
    .from('orders')
    .insert({
      customer_id: customerId,
      phone,
      lang,
      order_type: orderType,
      customer_name: customerName,
      items_json: items,
      city,
      address,
      subtotal,
      delivery_fee: deliveryFee,
      total,
      status: 'pending',
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** Último pedido de entrega do cliente — usado para reoferecer o endereço. */
async function getLastDeliveryOrder(phone) {
  const { data, error } = await supabase
    .from('orders')
    .select('city, address, created_at')
    .eq('phone', phone)
    .eq('order_type', 'delivery')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getOrder(id) {
  const { data, error } = await supabase
    .from('orders')
    .select()
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function updateOrderStatus(id, status) {
  const { data, error } = await supabase
    .from('orders')
    .update({ status })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** Próximo pedido pago aguardando impressão — usado pelo CloudPRNT. */
async function getNextPrintableOrder() {
  const { data, error } = await supabase
    .from('orders')
    .select()
    .eq('status', 'paid')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function markOrderPrinted(id) {
  return updateOrderStatus(id, 'printed');
}

// ----------------------------------------------------------------- payments

/**
 * Zelle não tem webhook nem API de estorno.
 *
 * Nada externo confirma o pagamento e nada o desfaz — a confirmação é humana,
 * e por isso fica registrada: quem liberou e quando. É o registro que
 * transforma "o pedido saiu" em "fulano mandou sair".
 */
async function createPayment({ orderId, amount, method = 'zelle' }) {
  const { data, error } = await supabase
    .from('payments')
    .insert({
      order_id: orderId,
      method,
      amount,
      status: 'pending',
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Comprovante chegou. Move o pagamento para conferência.
 *
 * Não mexe no status do pedido — quem faz isso é `comprovante.js`, numa
 * chamada própria. Separado de propósito: gravar o caminho da imagem e liberar
 * a comanda são decisões diferentes, e a segunda é do dono.
 */
async function attachProof(orderId, proofPath) {
  const { data, error } = await supabase
    .from('payments')
    .update({
      status: 'awaiting_review',
      proof_path: proofPath,
      proof_received_at: new Date().toISOString(),
    })
    .eq('order_id', orderId)
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** O dono liberou. É o único caminho que leva um pedido a `paid`. */
async function approvePayment(orderId, approvedBy) {
  const agora = new Date().toISOString();
  const { data, error } = await supabase
    .from('payments')
    .update({
      status: 'paid',
      approved_by: approvedBy,
      approved_at: agora,
      paid_at: agora,
    })
    .eq('order_id', orderId)
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function rejectPayment(orderId, reason) {
  const { data, error } = await supabase
    .from('payments')
    .update({ status: 'rejected', rejected_reason: reason || null })
    .eq('order_id', orderId)
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getPaymentByOrderId(orderId) {
  const { data, error } = await supabase
    .from('payments')
    .select()
    .eq('order_id', orderId)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Pedido em aberto mais recente do cliente — o que um "cancelar" se refere.
 *
 * `delivered`, `cancelled` e `rejected` ficam de fora: nenhum deles se cancela.
 */
async function getActiveOrderByPhone(phone) {
  const { data, error } = await supabase
    .from('orders')
    .select()
    .eq('phone', phone)
    .in('status', ['pending', 'awaiting_review', 'paid', 'printed'])
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Pedido deste cliente esperando o comprovante.
 *
 * É o que decide se uma imagem recebida é comprovante ou foto solta. Sem esta
 * consulta, o bucket viraria depósito de foto de quem quisesse.
 */
async function getOrderAwaitingProof(phone) {
  const { data, error } = await supabase
    .from('orders')
    .select()
    .eq('phone', phone)
    .eq('status', 'pending')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** Fila de conferência do dono — comprovante recebido, ainda não liberado. */
async function getOrdersAwaitingReview() {
  const { data, error } = await supabase
    .from('orders')
    .select('*, payments(proof_path, proof_received_at)')
    .eq('status', 'awaiting_review')
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

/**
 * Pedidos criados há mais de N minutos e ainda sem comprovante.
 *
 * Alimenta o `pagamentowatch`: um cobra o cliente, o outro desiste. Sem isso o
 * pedido fica `pending` para sempre e o cliente some sem saber que faltou algo.
 */
async function getStalePendingOrders(minutos) {
  const limite = new Date(Date.now() - minutos * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('orders')
    .select()
    .eq('status', 'pending')
    .lt('created_at', limite)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

// ----------------------------------------------------------------- consumo IA

/**
 * Soma o consumo do dia e devolve o acumulado.
 *
 * Upsert com leitura de volta porque o teto é comparado contra o total, e duas
 * instâncias no ar somariam em cima do mesmo dia.
 */
async function registrarUsoIA({ tokensIn = 0, tokensOut = 0, custoUsd = 0 }) {
  const dia = new Date().toISOString().slice(0, 10);
  const atual = await getUsoIA(dia);

  const { data, error } = await supabase
    .from('ai_usage')
    .upsert(
      {
        dia,
        chamadas: (atual?.chamadas || 0) + 1,
        tokens_in: (atual?.tokens_in || 0) + tokensIn,
        tokens_out: (atual?.tokens_out || 0) + tokensOut,
        custo_usd: Number(atual?.custo_usd || 0) + custoUsd,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'dia' }
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getUsoIA(dia = new Date().toISOString().slice(0, 10)) {
  const { data, error } = await supabase
    .from('ai_usage')
    .select()
    .eq('dia', dia)
    .maybeSingle();

  if (error) throw error;
  return data;
}

// ----------------------------------------------------- disponibilidade

/**
 * Ids marcados como esgotados. Só guardamos as exceções: item ausente da
 * tabela está disponível, que é o caso da maioria quase o tempo todo.
 */
async function listUnavailableItems() {
  const { data, error } = await supabase
    .from('item_availability')
    .select('item_id')
    .eq('available', false);

  if (error) throw error;
  return (data || []).map((r) => r.item_id);
}

async function setItemAvailability(itemId, available) {
  const { error } = await supabase
    .from('item_availability')
    .upsert(
      { item_id: itemId, available, updated_at: new Date().toISOString() },
      { onConflict: 'item_id' }
    );

  if (error) throw error;
}

// ------------------------------------------------------- busca de pedidos

/** Últimos pedidos de um número — para o dono achar o que precisa cancelar. */
async function getOrdersByPhone(phone, limit = 5) {
  const { data, error } = await supabase
    .from('orders')
    .select()
    .eq('phone', phone)
    .order('id', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

/** Últimos pedidos de todos, independente de status. */
async function getRecentOrders(limit = 10) {
  const { data, error } = await supabase
    .from('orders')
    .select()
    .order('id', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

// --------------------------------------------------------------- relatórios

/** Agrega os pedidos pagos num intervalo. `from`/`to` são strings ISO. */
async function getReport(from, to) {
  const { data, error } = await supabase
    .from('orders')
    .select('id, total, subtotal, delivery_fee, items_json, status, created_at')
    .gte('created_at', from)
    .lt('created_at', to)
    .in('status', ['paid', 'printed', 'delivered']);

  if (error) throw error;

  const orders = data || [];
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

  const topItems = Object.values(itemCounts)
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 5);

  return {
    orderCount: orders.length,
    revenue,
    deliveryFees,
    avgTicket: orders.length ? revenue / orders.length : 0,
    topItems,
  };
}

/** Receita por dia num intervalo — usado no relatório semanal. */
async function getRevenueByDay(from, to) {
  const { data, error } = await supabase
    .from('orders')
    .select('total, created_at')
    .gte('created_at', from)
    .lt('created_at', to)
    .in('status', ['paid', 'printed', 'delivered']);

  if (error) throw error;

  const byDay = {};
  for (const order of data || []) {
    const day = order.created_at.slice(0, 10);
    if (!byDay[day]) byDay[day] = { day, count: 0, revenue: 0 };
    byDay[day].count += 1;
    byDay[day].revenue += Number(order.total);
  }

  return Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));
}

async function getPendingOrders() {
  const { data, error } = await supabase
    .from('orders')
    .select()
    .in('status', ['paid', 'printed'])
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

/**
 * Pedidos pagos que ainda não saíram no papel.
 *
 * Traz o `paid_at` do pagamento junto porque é dele que se mede o atraso: o
 * `created_at` do pedido é de antes do link de pagamento, e um cliente que
 * demora dez minutos para pagar faria a comanda parecer atrasada no instante
 * em que entra na fila.
 */
async function getUnprintedPaidOrders() {
  const { data, error } = await supabase
    .from('orders')
    .select('*, payments(paid_at, status)')
    .eq('status', 'paid')
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

module.exports = {
  ping,
  getSetting,
  setSetting,
  getConfigDocs,
  setConfigDoc,
  registrarHistoricoConfig,
  getHistoricoConfig,
  upsertCustomer,
  getCustomerByPhone,
  listCustomerEmails,
  createOrder,
  getOrder,
  getLastDeliveryOrder,
  updateOrderStatus,
  getNextPrintableOrder,
  markOrderPrinted,
  createPayment,
  attachProof,
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
