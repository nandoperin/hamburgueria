#!/usr/bin/env node
/**
 * Exercita as 25 funções de `src/db/queries.js` contra o banco de verdade.
 *
 * ## Por que este script existe
 *
 * As 18 suítes de `test/` substituem a camada de banco por uma falsa — elas
 * passam idênticas com o `queries.js` certo ou errado. Ou seja: **nenhum teste
 * do projeto cobre uma linha do SQL real.** Isso não incomodava enquanto o
 * arquivo não mudava; passou a incomodar no dia em que ele foi reescrito
 * inteiro do Supabase para o `pg`.
 *
 * Aqui é o contrário: nada é falso. Cria cliente, pedido e pagamento de
 * verdade, confere os formatos de retorno, e apaga tudo no fim.
 *
 * ## O que ele confere além de "não deu erro"
 *
 * Os tipos. O PostgREST devolvia `total` como número, `id` como número e
 * `created_at` como string ISO; o `pg` devolveria string, string e `Date`. Os
 * handlers foram escritos contra o primeiro formato — `created_at.slice(0,10)`
 * quebra com Date, e o estorno faz conta com `total`. Por isso cada asserção
 * abaixo olha o **tipo**, não só o valor.
 *
 * Uso:  node scripts/verificar-banco.js
 */
require('dotenv').config();

// Resolve a conexão ANTES de carregar o cliente do bot: ele lê `DATABASE_URL`
// no momento em que é importado, e da máquina do dono o caminho é o túnel.
// Assim este script exercita exatamente o mesmo `client.js` que roda em
// produção — inclusive os parsers de tipo, que são o que mais importa aqui.
const { resolver } = require('./conexao');
const conexao = resolver();
process.env.DATABASE_URL = conexao.url;

const db = require('../src/db/queries');
const { pool, q } = require('../src/db/client');

// Telefone fora de qualquer faixa real, para o caso de algo escapar da limpeza.
const FONE = '99999999001';

let falhas = 0;
let criados = { pedidos: [], pagamentos: [], clientes: [] };

function ok(cond, msg) {
  if (cond) {
    console.log(`\x1b[32m  OK  \x1b[0m ${msg}`);
  } else {
    falhas += 1;
    console.log(`\x1b[31m FALHA\x1b[0m ${msg}`);
  }
}

const titulo = (t) => console.log(`\n\x1b[33m### ${t} ###\x1b[0m`);

async function main() {
  titulo('CONEXAO');
  ok((await db.ping()) === true, 'ping responde');

  titulo('SETTINGS');
  await db.setSetting('__teste__', 'valor-1');
  ok((await db.getSetting('__teste__')) === 'valor-1', 'grava e le');
  await db.setSetting('__teste__', 'valor-2');
  ok((await db.getSetting('__teste__')) === 'valor-2', 'sobrescreve (upsert)');
  await db.setSetting('__teste__', null);
  ok((await db.getSetting('__teste__')) === null, 'null apaga a chave');
  ok((await db.getSetting('__inexistente__')) === null, 'chave ausente devolve null');

  titulo('CLIENTES');
  const c1 = await db.upsertCustomer({ phone: FONE, lang: 'pt', name: 'Teste QA' });
  criados.clientes.push(c1.id);
  ok(c1 && c1.phone === FONE, 'cria cliente');
  ok(typeof c1.id === 'number', `id vem como number (veio ${typeof c1.id})`);
  ok(typeof c1.created_at === 'string', `created_at vem como string ISO (veio ${typeof c1.created_at})`);

  // O cliente informa o nome uma vez; no pedido seguinte o bot nao manda nome.
  // Se o upsert sobrescrevesse com null, o nome sumiria do cadastro.
  const c2 = await db.upsertCustomer({ phone: FONE, lang: 'en' });
  ok(c2.name === 'Teste QA', 'upsert sem nome PRESERVA o nome anterior');
  ok(c2.lang === 'en', 'mas atualiza o idioma');
  ok(c2.id === c1.id, 'e continua sendo o mesmo cliente');

  const achado = await db.getCustomerByPhone(FONE);
  ok(achado?.phone === FONE, 'busca por telefone');
  ok((await db.getCustomerByPhone('00000000000')) === null, 'telefone ausente devolve null');
  ok(Array.isArray(await db.listCustomerEmails()), 'lista de emails devolve array');

  titulo('PEDIDOS');
  const itens = [{ id: 'espetinho_boi', name: 'Espetinho de Boi', qty: 2, price: 9 }];
  const pedido = await db.createOrder({
    customerId: c1.id,
    phone: FONE,
    lang: 'pt',
    orderType: 'pickup',
    customerName: 'Teste QA',
    items: itens,
    city: 'Everett',
    address: 'Rua de Teste',
    subtotal: 18,
    deliveryFee: 0,
    total: 18,
  });
  criados.pedidos.push(pedido.id);

  ok(pedido && pedido.status === 'pending', 'cria pedido em pending');
  ok(typeof pedido.id === 'number', `id do pedido e number (veio ${typeof pedido.id})`);
  ok(typeof pedido.total === 'number', `total e number, nao string (veio ${typeof pedido.total})`);
  ok(pedido.total === 18, `total tem o valor certo (${pedido.total})`);
  ok(Array.isArray(pedido.items_json), 'items_json volta como array, ja desserializado');
  ok(pedido.items_json[0]?.name === 'Espetinho de Boi', 'com o conteudo intacto');
  ok(typeof pedido.created_at === 'string', 'created_at e string ISO');
  ok(
    /^\d{4}-\d{2}-\d{2}T/.test(pedido.created_at),
    `no formato que o relatorio fatia com slice(0,10): ${pedido.created_at}`
  );

  ok((await db.getOrder(pedido.id))?.id === pedido.id, 'busca por id');
  ok((await db.getOrder(999999999)) === null, 'pedido ausente devolve null');

  const ativo = await db.getActiveOrderByPhone(FONE);
  ok(ativo?.id === pedido.id, 'acha o pedido ativo do telefone');

  titulo('PAGAMENTOS');
  const pag = await db.createPayment({
    orderId: pedido.id,
    squareOrderId: 'SQ_TESTE_ORDER',
    amount: 18,
  });
  criados.pagamentos.push(pag.id);
  ok(pag && pag.status === 'pending', 'cria pagamento pendente');
  ok(typeof pag.amount === 'number', `amount e number (veio ${typeof pag.amount})`);
  ok(pag.square_payment_id === null, 'sem id de pagamento ainda — so vem com o webhook');

  const pago = await db.markPaymentPaid('SQ_TESTE_ORDER', 'SQ_TESTE_PAYMENT');
  ok(pago?.status === 'paid', 'webhook marca como pago');
  ok(pago?.square_payment_id === 'SQ_TESTE_PAYMENT', 'e grava o id que o estorno exige');
  ok(typeof pago.paid_at === 'string', 'paid_at e string ISO');

  const buscado = await db.getPaymentByOrderId(pedido.id);
  ok(buscado?.id === pag.id, 'acha o pagamento pelo pedido');

  titulo('FLUXO DE IMPRESSAO');
  await db.updateOrderStatus(pedido.id, 'paid');

  // A fila é FIFO por `created_at`, e o banco pode ter pedidos pagos de verdade
  // esperando — mais velhos que este. Então a asserção certa não é "devolve o
  // meu", e sim "devolve o mais antigo dos pagos", que é o contrato real.
  const proximo = await db.getNextPrintableOrder();
  const pagos = await db.getUnprintedPaidOrders();
  const maisAntigo = pagos
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];

  ok(proximo?.status === 'paid', 'CloudPRNT acha um pedido pago aguardando impressao');
  ok(
    proximo?.id === maisAntigo?.id,
    `e devolve o mais antigo da fila (#${proximo?.id}), nao um qualquer`
  );

  const naFila = pagos;
  const meu = naFila.find((o) => o.id === pedido.id);
  ok(Boolean(meu), 'aparece na fila de nao impressos');
  ok(Array.isArray(meu?.payments), 'com payments aninhado como array (formato do printwatch)');
  ok(
    Boolean(meu?.payments?.find((p) => p.paid_at)),
    'e o paid_at chega dentro dele — e dele que se mede o atraso'
  );

  await db.markOrderPrinted(pedido.id);
  ok((await db.getOrder(pedido.id))?.status === 'printed', 'marca como impresso');
  const depois = await db.getNextPrintableOrder();
  ok(depois?.id !== pedido.id, 'e sai da fila de impressao');

  titulo('ESTORNO');
  const estornado = await db.markPaymentRefunded(pag.id);
  ok(estornado?.status === 'refunded', 'marca o pagamento como estornado');
  await db.updateOrderStatus(pedido.id, 'cancelled');
  ok((await db.getActiveOrderByPhone(FONE)) === null, 'pedido cancelado sai dos ativos');

  titulo('DISPONIBILIDADE');
  await db.setItemAvailability('__item_teste__', false);
  ok((await db.listUnavailableItems()).includes('__item_teste__'), 'marca item como esgotado');
  await db.setItemAvailability('__item_teste__', true);
  ok(!(await db.listUnavailableItems()).includes('__item_teste__'), 'e devolve ao cardapio');

  titulo('BUSCA E RELATORIOS');
  ok(Array.isArray(await db.getOrdersByPhone(FONE, 5)), 'pedidos por telefone');
  ok(Array.isArray(await db.getRecentOrders(10)), 'pedidos recentes');
  ok(Array.isArray(await db.getPendingOrders()), 'pedidos pendentes');

  const ontem = new Date(Date.now() - 864e5).toISOString();
  const amanha = new Date(Date.now() + 864e5).toISOString();

  const rel = await db.getReport(ontem, amanha);
  ok(typeof rel.orderCount === 'number', 'relatorio traz contagem');
  ok(typeof rel.revenue === 'number', 'e receita como number');
  ok(Array.isArray(rel.topItems), 'com top itens');

  const porDia = await db.getRevenueByDay(ontem, amanha);
  ok(Array.isArray(porDia), 'receita por dia devolve array');
  ok(
    porDia.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day)),
    'agrupada por dia no formato certo — e aqui que Date quebraria'
  );
}

/** Apaga o que este script criou. Roda mesmo se algo falhar no meio. */
async function limpar() {
  titulo('LIMPEZA');
  try {
    for (const id of criados.pagamentos) await q('DELETE FROM payments WHERE id = $1', [id]);
    for (const id of criados.pedidos) await q('DELETE FROM orders WHERE id = $1', [id]);
    for (const id of criados.clientes) await q('DELETE FROM customers WHERE id = $1', [id]);
    await q(`DELETE FROM item_availability WHERE item_id = '__item_teste__'`);
    await q(`DELETE FROM bot_settings WHERE key = '__teste__'`);
    console.log(
      `  removidos: ${criados.pedidos.length} pedido(s), ` +
        `${criados.pagamentos.length} pagamento(s), ${criados.clientes.length} cliente(s)`
    );
  } catch (err) {
    console.log(`\x1b[31m  falha ao limpar: ${err.message}\x1b[0m`);
    console.log(`  remova a mao: telefone ${FONE}`);
  }
}

main()
  .catch((err) => {
    falhas += 1;
    console.error(`\n\x1b[31mERRO: ${err.message}\x1b[0m`);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  })
  .then(limpar)
  .finally(async () => {
    await pool.end();
    console.log();
    if (falhas) {
      console.log(`\x1b[31m${falhas} verificacao(oes) falharam.\x1b[0m`);
      process.exit(1);
    }
    console.log('\x1b[32mTodas as verificacoes passaram — o banco responde como o codigo espera.\x1b[0m');
  });
