/**
 * Zelle sem espera: o comprovante manda a comanda para a cozinha na hora.
 *
 * Antes, o print ficava parado até o dono dar `!liberar`. Agora o pedido vira
 * `paid` quando a imagem chega — é o que a impressora procura, e o banco a
 * avisa na mesma hora — e a conferência do dinheiro fica para depois, com o
 * dono olhando o banco. Esta suíte trava as pontas que isso mexe: a query que
 * solta a comanda, a conversa do cliente depois do print, a fila de impressão,
 * o cancelamento e o estorno.
 */

process.env.DATABASE_URL = 'postgresql://fake';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.ADMIN_PHONE = '15550001111';
process.env.AI_ENABLED = 'off';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PROJECT = path.resolve(__dirname, '..');

const schedulePath = require.resolve(`${PROJECT}/src/services/schedule`);
require(schedulePath);
require.cache[schedulePath].exports.isOpen = () => true;

const db = require(`${PROJECT}/src/db/queries`);
const notify = require(`${PROJECT}/src/bot/notify`);
const leitura = require(`${PROJECT}/src/services/leitura-comprovante`);
const session = require(`${PROJECT}/src/bot/session`);
const router = require(`${PROJECT}/src/bot/router`);
const admin = require(`${PROJECT}/src/bot/handlers/admin`);
const printwatch = require(`${PROJECT}/src/services/printwatch`);
const zelle = require(`${PROJECT}/src/services/zelle`);

const DONO = '15550001111';
const CLIENTE = '15550002222';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const pedido = {
  id: 88,
  status: 'pending',
  total: 24,
  phone: CLIENTE,
  lang: 'pt',
  customer_name: 'Ana',
  order_type: 'pickup',
  city: 'Everett',
  address: 'Retirada',
  items_json: [{ name: 'X Tudo', nomeCozinha: 'X Tudo', qty: 1, price: 24 }],
  created_at: new Date().toISOString(),
};
let pagamento = { order_id: 88, method: 'zelle', status: 'pending', amount: 24 };

db.getOrderAwaitingProof = async (phone) =>
  phone === CLIENTE && pedido.status === 'pending' ? { ...pedido } : null;
db.markProofReceived = async (id) => {
  if (id !== pedido.id || pedido.status !== 'pending') return null;
  pedido.status = 'paid';
  pagamento = { ...pagamento, status: 'awaiting_review', proof_received_at: new Date().toISOString() };
  return pagamento;
};
db.approvePayment = async () => {
  throw new Error('o comprovante nao pode se passar pela conferencia do dono');
};
db.getActiveOrderByPhone = async () => ({ ...pedido });
db.getOrder = async (id) => (id === pedido.id ? { ...pedido } : null);
db.getPaymentByOrderId = async () => ({ ...pagamento });
db.getUltimoPedidoDoTelefone = async () => ({ ...pedido });

const aoDono = [];
notify.admins = () => [DONO];
notify.sendImage = async (_phone, { caption }) => { aoDono.push(caption); return true; };
notify.send = async (_phone, texto) => { aoDono.push(texto); return true; };
leitura.analisar = async () => ({ ok: false });

(async () => {
  // ------------------------------------------ 1. a query que solta a comanda
  console.log('\n\x1b[36m### 1. markProofReceived ###\x1b[0m');
  const fonte = fs.readFileSync(`${PROJECT}/src/db/queries.js`, 'utf8');
  const trecho = fonte.slice(
    fonte.indexOf('async function markProofReceived'),
    fonte.indexOf('async function markReviewReminderSent')
  );
  checar(
    /update orders\s+set status = 'paid'\s+where id = \$1 and status = 'pending'/.test(trecho),
    'o comprovante poe o pedido em paid, e so a partir de pending'
  );
  checar(/method = 'zelle'/.test(trecho), 'so pagamento Zelle avanca com uma foto');
  checar(
    /set status = 'awaiting_review', proof_received_at = now\(\)/.test(trecho),
    'o pagamento fica a conferir'
  );
  checar(!/approved_by|paid_at/.test(trecho), 'e ninguem aparece como quem conferiu');

  // ----------------------------------- 2. a foto chega pelo WhatsApp de verdade
  console.log('\n\x1b[36m### 2. FOTO DO COMPROVANTE ###\x1b[0m');
  const sess = session.get(CLIENTE);
  Object.assign(sess, {
    lang: 'pt', greeted: true, state: 'PAYMENT_PENDING', orderId: 88, paymentMethod: 'zelle', total: 24,
  });

  const ditas = [];
  const enviar = async (m) => { ditas.push(m); };
  await router.routeImagem(CLIENTE, PNG, 'image/png', enviar);

  checar(pedido.status === 'paid', 'a foto manda o pedido para a fila da impressora');
  checar(/sendo feito/.test(ditas.join('\n')), 'o cliente ouve que o pedido esta sendo feito');
  checar(session.get(CLIENTE).state === 'ORDER_COMPLETE', 'a conversa sai da espera do comprovante');
  checar(aoDono.some((m) => /JA NA COZINHA/.test(m) && /!liberar 88/.test(m)),
    'o dono recebe o print sabendo que a comanda ja saiu');

  // -------------------------------------- 3. o cliente continua conversando
  console.log('\n\x1b[36m### 3. DEPOIS DO COMPROVANTE ###\x1b[0m');
  ditas.length = 0;
  await router.route(CLIENTE, 'que horas fica pronto?', enviar);
  const resposta = ditas.join('\n');
  checar(/chamei a equipe/.test(resposta) && aoDono.some(m => /#88/.test(m) && /que horas fica pronto/.test(m)),
    'a equipe recebe a pergunta de prazo, sem inventar o andamento do pedido');
  checar(!/cash/i.test(resposta) && !/envie/i.test(resposta),
    'e nao confunde com cash nem pede o comprovante de novo');

  // Encerrado o atendimento humano, cancelar mantém a proteção anterior.
  require('../src/services/atendimento').encerrar(CLIENTE);
  ditas.length = 0;
  await router.route(CLIENTE, 'cancelar', enviar);
  checar(/em preparo/.test(ditas.join('\n')),
    'com a comanda na cozinha, o cliente nao cancela sozinho');

  // ------------------------------- 4. a fila conta da chegada do comprovante
  console.log('\n\x1b[36m### 4. VIGIA DA IMPRESSORA ###\x1b[0m');
  db.getUnprintedPaidOrders = async () => [{
    ...pedido,
    created_at: new Date(Date.now() - 20 * 60000).toISOString(),
    payments: [{ status: 'awaiting_review', paid_at: null,
      proof_received_at: new Date(Date.now() - 30000).toISOString() }],
  }];
  const fila = await printwatch.fila();
  checar(fila[0].esperandoMs < 60000,
    'pedido criado ha 20 min com print de 30s atras nao dispara alerta falso');

  // -------------------------------------------- 5. cancelar e estornar depois
  console.log('\n\x1b[36m### 5. CANCELAR COM ZELLE A CONFERIR ###\x1b[0m');
  const resp = [];
  await admin.handle(DONO, '!cancelar 88', async (m) => resp.push(m));
  checar(/ainda nao conferido/.test(resp.join('\n')),
    'o !cancelar avisa que o comprovante nao foi conferido');
  checar((await zelle.estornar({ payment: { status: 'awaiting_review' } })).manual,
    'comprovante recebido conta como pagamento a devolver a mao');
  checar((await zelle.estornar({ payment: { status: 'review_reminded' } })).manual,
    'inclusive depois do lembrete ao dono');
  checar((await zelle.estornar({ payment: { status: 'paid' } })).manual, 'conferido tambem');
  checar(!(await zelle.estornar({ payment: { status: 'pending' } })).manual,
    'sem comprovante nao ha o que estornar');

  printwatch.stop();
  console.log('\n\x1b[32mzelleimediatotest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
