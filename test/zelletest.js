/**
 * Os comandos do Zelle: `!liberar` e `!recusar`.
 *
 * Esta suíte existe porque a cadeia inteira já esteve **morta** sem ninguém
 * perceber: `comprovante.js` existia, `db.approvePayment` existia, e nenhum
 * dos dois era chamado por lugar nenhum. O bot mostrava as instruções do Zelle
 * ao cliente, recebia o comprovante — e o pedido ficava `pending` para sempre,
 * porque `getNextPrintableOrder()` procura `paid` e nada escrevia `paid`.
 *
 * Hoje o comprovante manda a comanda para a cozinha sozinho, e o `!liberar`
 * passou a ser a conferência do banco, depois. Os cenários 1 a 8 cobrem os
 * pedidos antigos (`awaiting_review`) e a liberação sem comprovante; do 9 em
 * diante, o fluxo novo. Os testes não conferem mensagens bonitas — conferem
 * **quem escreve `paid`**, e que conferir não mexe na cozinha.
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
  // Espelha a consulta real: comprovante chegou e o dinheiro não foi conferido.
  getOrdersAwaitingReview: async () =>
    Object.values(pedidos).filter((o) =>
      !['cancelled', 'rejected'].includes(o.status) &&
      ['awaiting_review', 'review_reminded'].includes(pagamentos[o.id]?.status)),
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

function novoPedido(id, status = 'awaiting_review', pagamento = 'awaiting_review', method = 'zelle') {
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
  pagamentos[id] = { order_id: id, method, status: pagamento, amount: 41 };
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
  novoPedido(44, 'pending', 'pending');
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

  // ------------------------------- 9. comprovante chegou: cozinha sem esperar
  console.log('\n\x1b[36m### 9. COMPROVANTE CHEGOU — COMANDA JA SAIU ###\x1b[0m');
  pedidos = {};
  pagamentos = {};
  novoPedido(50, 'paid', 'awaiting_review');
  checar(
    (await db.getNextPrintableOrder())?.id === 50,
    'com o comprovante, a impressora recebe o pedido antes de qualquer !liberar'
  );
  const conferir = await comando('!conferir');
  checar(/#50/.test(conferir.resposta), '!conferir lista o Zelle que ainda falta conferir');

  // ------------------------------------ 10. !liberar agora so confere o banco
  console.log('\n\x1b[36m### 10. !liberar 50 — CONFERENCIA DEPOIS ###\x1b[0m');
  enviados = [];
  const confere = await comando('!liberar 50');
  console.log(confere.resposta);
  checar(/CONFERIDO/.test(confere.resposta), 'a resposta diz que o pagamento foi conferido');
  checar(pagamentos[50].status === 'paid' && pagamentos[50].approved_by === DONO,
    'fica registrado quem conferiu');
  checar(pedidos[50].status === 'paid', 'e o pedido nao muda — a comanda ja tinha saido');
  checar(enviados.length === 0, 'o cliente nao recebe mensagem de novo');
  checar(!(await comando('!conferir')).resposta.includes('#50'), 'e sai da lista de conferencia');

  const denovo = await comando('!liberar 50');
  checar(/ja estava liberado|já estava liberado/.test(denovo.resposta), 'conferir duas vezes so avisa');

  // ------------------------- 11. !recusar com a comanda ja impressa, a conferir
  console.log('\n\x1b[36m### 11. !recusar 51 DEPOIS DE IMPRESSO ###\x1b[0m');
  const printqueue = require(`${PROJECT}/src/services/printqueue`);
  printqueue.limpar();
  novoPedido(51, 'printed', 'review_reminded');
  enviados = [];
  const naoCaiu = await comando('!recusar 51 o Zelle nao caiu');
  console.log(naoCaiu.resposta);
  checar(pedidos[51].status === 'rejected', 'a recusa vale enquanto o banco nao foi conferido');
  checar(enviados.some((e) => e.phone === CLIENTE && e.texto.includes('o Zelle nao caiu')),
    'o cliente recebe o motivo');
  checar(printqueue.tamanho() === 1 && printqueue.proximo().conteudo.includes('CANCELADO'),
    'e a cozinha recebe no papel o aviso para nao preparar');
  checar(/impressora/.test(naoCaiu.resposta), 'o dono sabe que o aviso foi para a impressora');

  // ----------------------------- 12. recusar depois de conferido continua fora
  console.log('\n\x1b[36m### 12. !recusar 50 DEPOIS DE CONFERIDO ###\x1b[0m');
  const tardeDemais = await comando('!recusar 50 mudei de ideia');
  checar(pedidos[50].status === 'paid', 'recusar nao desfaz uma conferencia');
  checar(tardeDemais.resposta.includes('!cancelar 50'), 'e aponta o !cancelar');

  // ---------------------------------------------- 13. cash nao tem comprovante
  console.log('\n\x1b[36m### 13. !recusar EM PEDIDO CASH ###\x1b[0m');
  novoPedido(52, 'cash_due', 'cash_due', 'cash');
  const cash = await comando('!recusar 52 teste');
  checar(pedidos[52].status === 'cash_due', 'pedido cash nao e recusado como Zelle');
  checar(cash.resposta.includes('!cancelar 52'), 'e o dono e levado ao !cancelar');

  // ----------------------------------------- 14. o papel nao afirma o que nao viu
  console.log('\n\x1b[36m### 14. COMANDA COM COMPROVANTE A CONFERIR ###\x1b[0m');
  const printer = require(`${PROJECT}/src/services/printer`);
  const aConferir = printer.buildTicket(pedidos[50], { method: 'zelle', status: 'awaiting_review' });
  checar(aConferir.includes('COMPROVANTE RECEBIDO') && !aConferir.includes('CONFIRMADO'),
    'antes da conferencia a comanda diz comprovante recebido, nao confirmado');
  const conferida = printer.buildTicket(pedidos[50], pagamentos[50]);
  checar(conferida.includes('CONFIRMADO'), 'a segunda via depois da conferencia diz confirmado');

  // ------------------------------------ 15. caiu tudo no banco: !liberar todos
  console.log('\n\x1b[36m### 15. !liberar todos ###\x1b[0m');
  pedidos = {};
  pagamentos = {};
  novoPedido(60, 'paid', 'awaiting_review');
  novoPedido(61, 'printed', 'review_reminded');
  novoPedido(62, 'awaiting_review', 'awaiting_review'); // fluxo antigo: ainda nao foi para a cozinha
  novoPedido(63, 'delivered', 'paid');                  // ja conferido antes
  novoPedido(64, 'rejected', 'rejected');
  enviados = [];
  const todos = await comando('!liberar todos');
  console.log(todos.resposta);
  checar(/3 ZELLE CONFERIDO/.test(todos.resposta), 'confere os tres que estavam a conferir, numa etapa so');
  checar(/#60/.test(todos.resposta) && /#61/.test(todos.resposta) && /#62/.test(todos.resposta),
    'e a resposta lista cada um');
  checar([60, 61, 62].every((id) => pagamentos[id].status === 'paid' && pagamentos[id].approved_by === DONO),
    'fica registrado quem conferiu cada um');
  checar(pedidos[60].status === 'paid' && pedidos[61].status === 'printed',
    'o que ja estava na cozinha nao muda de status');
  checar(pedidos[62].status === 'paid', 'o pedido antigo, que esperava liberacao, vai para a cozinha');
  checar(enviados.filter((e) => e.phone === CLIENTE).length === 1,
    'so o cliente do pedido antigo recebe aviso — os outros ja sabiam');
  checar(pagamentos[63].approved_by === undefined && pagamentos[64].status === 'rejected',
    'conferido e recusado ficam como estavam');

  const nada = await comando('!liberar tudo');
  checar(/NADA PARA CONFERIR/.test(nada.resposta), 'rodar de novo nao faz nada');

  console.log('\n\x1b[32mzelletest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
