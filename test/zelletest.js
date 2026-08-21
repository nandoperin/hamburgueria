/**
 * O gate do Zelle: nada vai para a cozinha sem o dono liberar.
 *
 * Esta suíte existe porque a cadeia inteira já esteve **morta** sem ninguém
 * perceber: `comprovante.js` existia, `db.approvePayment` existia, e nenhum
 * dos dois era chamado por lugar nenhum. O bot mostrava as instruções do Zelle
 * ao cliente, recebia o comprovante — e o pedido ficava `pending` para sempre,
 * porque `getNextPrintableOrder()` procura `paid` e nada escrevia `paid`.
 *
 * O sintoma disso em produção é o pior tipo: tudo parece funcionar até a hora
 * em que a comida deveria sair, e não sai. Por isso os testes abaixo não
 * conferem mensagens bonitas — conferem **quem escreve `paid`**.
 */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';
process.env.ADMIN_PHONE = '16174449612';

const PROJECT = require('path').resolve(__dirname, '..');

// ------------------------------------------------------------- banco de faz de conta

let pedidos = {};
let pagamentos = {};

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getOrder: async (id) => pedidos[id] || null,
  updateOrderStatus: async (id, status) => {
    pedidos[id].status = status;
    return pedidos[id];
  },
  getNextPrintableOrder: async () =>
    Object.values(pedidos)
      .filter((o) => o.status === 'paid')
      .sort((a, b) => a.id - b.id)[0] || null,
  approvePayment: async (orderId, quem) => {
    pagamentos[orderId] = {
      ...(pagamentos[orderId] || {}),
      status: 'paid',
      approved_by: quem,
      approved_at: new Date().toISOString(),
    };
    return pagamentos[orderId];
  },
  rejectPayment: async (orderId, motivo) => {
    pagamentos[orderId] = {
      ...(pagamentos[orderId] || {}),
      status: 'rejected',
      rejected_reason: motivo,
    };
    return pagamentos[orderId];
  },
  getPaymentByOrderId: async (orderId) => pagamentos[orderId] || null,
  getOrdersAwaitingReview: async () =>
    Object.values(pedidos).filter((o) => o.status === 'awaiting_review'),
  // O admin.js toca nestes em outros comandos; devolver vazio basta.
  getRecentOrders: async () => [],
  listUnavailableItems: async () => [],
};

// --------------------------------------------------------------- WhatsApp falso

const notify = require(`${PROJECT}/src/bot/notify`);
let enviados = [];
notify.register(async (phone, texto) => {
  enviados.push({ phone, texto });
});

const admin = require(`${PROJECT}/src/bot/handlers/admin`);

const DONO = '16174449612';
const CLIENTE = '16178667738';

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

/** Roda um comando de admin e devolve o que ele respondeu ao dono. */
async function comando(texto, phone = DONO) {
  const respostas = [];
  const tratou = await admin.handle(phone, texto, async (t) => respostas.push(t));
  return { tratou, resposta: respostas.join('\n') };
}

function novoPedido(id, status = 'awaiting_review') {
  pedidos[id] = {
    id,
    status,
    phone: CLIENTE,
    lang: 'pt',
    customer_name: 'Maria Souza',
    total: 41,
    city: 'Everett',
    address: 'Rua Tal, 123',
    order_type: 'delivery',
    items_json: [{ name: 'X-Bacon', nomeCozinha: 'X-Bacon', qty: 2, price: 14 }],
    created_at: new Date().toISOString(),
  };
  pagamentos[id] = { order_id: id, status: 'awaiting_review', amount: 41 };
}

(async () => {
  // ---------------------------------------------- 1. o gate, antes de liberar
  console.log('\n\x1b[36m### 1. COMPROVANTE RECEBIDO, AINDA NAO LIBERADO ###\x1b[0m');
  pedidos = {};
  pagamentos = {};
  novoPedido(42);

  const db = require(`${PROJECT}/src/db/queries`);
  let paraImprimir = await db.getNextPrintableOrder();
  checar(
    paraImprimir === null,
    'pedido em awaiting_review NAO e servido a impressora'
  );

  // ---------------------------------------------- 2. !liberar move para paid
  console.log('\n\x1b[36m### 2. !liberar 42 ###\x1b[0m');
  enviados = [];
  const lib = await comando('!liberar 42');
  console.log(lib.resposta);

  checar(lib.tratou, '!liberar e reconhecido como comando de admin');
  checar(pedidos[42].status === 'paid', 'o pedido virou paid');
  checar(pagamentos[42].approved_by === DONO, 'ficou registrado QUEM liberou');
  checar(
    lib.resposta.includes('Maria Souza') && lib.resposta.includes('41'),
    'a resposta ecoa nome e valor — id errado aparece na hora'
  );

  paraImprimir = await db.getNextPrintableOrder();
  checar(paraImprimir?.id === 42, 'agora sim a impressora recebe o pedido');

  const aoCliente = enviados.find((e) => e.phone === CLIENTE);
  checar(Boolean(aoCliente), 'o cliente foi avisado da liberacao');

  // ---------------------------------------------- 3. liberar duas vezes
  console.log('\n\x1b[36m### 3. !liberar 42 DE NOVO ###\x1b[0m');
  enviados = [];
  const dedo = await comando('!liberar 42');
  console.log(dedo.resposta);
  checar(
    dedo.resposta.includes('ja estava liberado') || dedo.resposta.includes('já estava liberado'),
    'liberar duas vezes nao repete nada — so avisa'
  );
  checar(enviados.length === 0, 'e nao manda mensagem ao cliente de novo');

  // ---------------------------------------------- 4. recusar
  console.log('\n\x1b[36m### 4. !recusar 43 valor nao confere ###\x1b[0m');
  novoPedido(43);
  enviados = [];
  const rec = await comando('!recusar 43 o valor nao confere');
  console.log(rec.resposta);

  checar(pedidos[43].status === 'rejected', 'o pedido virou rejected');
  checar(
    pagamentos[43].rejected_reason === 'o valor nao confere',
    'o motivo foi gravado'
  );
  const recusaCliente = enviados.find((e) => e.phone === CLIENTE);
  checar(
    recusaCliente?.texto.includes('o valor nao confere'),
    'o motivo chegou ao cliente'
  );
  checar(
    (await db.getNextPrintableOrder())?.id !== 43,
    'pedido recusado nunca vai para a impressora'
  );

  // ---------------------------------------------- 5. recusar depois de liberar
  console.log('\n\x1b[36m### 5. !recusar 42 DEPOIS DE LIBERADO ###\x1b[0m');
  const tarde = await comando('!recusar 42 mudei de ideia');
  console.log(tarde.resposta);
  checar(pedidos[42].status === 'paid', 'recusar nao desfaz uma liberacao');
  checar(
    tarde.resposta.includes('!cancelar 42'),
    'e aponta o caminho certo (!cancelar), em vez de so recusar'
  );

  // ---------------------------------------------- 6. liberar sem comprovante
  console.log('\n\x1b[36m### 6. !liberar 44 SEM COMPROVANTE ###\x1b[0m');
  novoPedido(44, 'pending');
  const sem = await comando('!liberar 44');
  console.log(sem.resposta);
  checar(pedidos[44].status === 'paid', 'o dono pode liberar sem o print');
  checar(
    sem.resposta.includes('SEM COMPROVANTE'),
    'mas a resposta diz isso em voz alta — e o que ninguem lembraria depois'
  );

  // ---------------------------------------------- 7. cliente nao e admin
  console.log('\n\x1b[36m### 7. CLIENTE MANDANDO !liberar ###\x1b[0m');
  novoPedido(45);
  const intruso = await comando('!liberar 45', CLIENTE);
  checar(
    intruso.tratou === false,
    'numero nao autorizado nao e tratado como admin'
  );
  checar(
    pedidos[45].status === 'awaiting_review',
    'e o pedido dele continua esperando — ninguem se autolibera'
  );

  // ---------------------------------------------- 8. pedido inexistente
  console.log('\n\x1b[36m### 8. !liberar 999 ###\x1b[0m');
  const fantasma = await comando('!liberar 999');
  console.log(fantasma.resposta);
  checar(
    fantasma.resposta.includes('nao encontrado') || fantasma.resposta.includes('não encontrado'),
    'pedido inexistente responde sem quebrar'
  );

  console.log('\n\x1b[32mzelletest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
