/**
 * Lembrete de confirmação (dono, 03/10): parado no resumo há 10 minutos,
 * uma vez só, sem mudar nada no fluxo.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'off';

const PROJECT = require('path').resolve(__dirname, '..');
const schedule = require(`${PROJECT}/src/services/schedule`);
let aberta = true;
schedule.isOpen = () => aberta;

let criados = 0;
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({
  upsertCustomer: async (c) => ({ id: 1, ...c }),
  createOrder: async () => ({ id: 900 + (++criados) }),
  createCashPayment: async () => ({ id: 1 }),
}, { get: (alvo, k) => alvo[k] || (async () => null) });

const enviados = [];
const notify = require(`${PROJECT}/src/bot/notify`);
notify.send = async (phone, texto) => { enviados.push({ phone, texto }); return true; };

const atendimento = require(`${PROJECT}/src/services/atendimento`);
const comAtendente = new Set();
atendimento.aberto = (phone) => (comAtendente.has(phone) ? { ate: Date.now() + 1 } : null);

const session = require(`${PROJECT}/src/bot/session`);
const lembrete = require(`${PROJECT}/src/services/lembrete-confirmacao`);
const router = require(`${PROJECT}/src/bot/router`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}
const MIN = 60 * 1000;

function noResumo(tel, minutosParado) {
  const s = session.get(tel);
  Object.assign(s, {
    lang: 'pt', state: 'CONFIRM', name: 'Ana', orderType: 'pickup', paymentMethod: 'cash',
    cart: [{ id: 'x_tudo', productId: 'x_tudo', name: 'X Tudo', qty: 1, price: 20 }],
    subtotal: 20, deliveryFee: 0, total: 20,
  });
  s.lastActivity = Date.now() - minutosParado * MIN;
  return s;
}
const para = (tel) => enviados.filter((e) => e.phone === tel);

(async () => {
  const A = '15557798001';
  noResumo(A, 11);
  await lembrete.verificar();
  checar(para(A).length === 1 && /não foi confirmado/.test(para(A)[0].texto) && /Sim \(s\)/.test(para(A)[0].texto),
    '11 minutos parado no resumo: lembra, pedindo Sim (s) ou Não (n)');
  await lembrete.verificar();
  await lembrete.verificar(Date.now() + 20 * MIN);
  checar(para(A).length === 1, '   uma vez só');

  const B = '15557798002';
  noResumo(B, 5);
  await lembrete.verificar();
  checar(!para(B).length, '5 minutos: ainda não lembra');

  const C = '15557798003';
  const sc = noResumo(C, 15);
  sc.state = 'PAYMENT_METHOD';
  await lembrete.verificar();
  checar(!para(C).length, 'fora do resumo (Cash ou Zelle): não lembra');

  const D = '15557798004';
  noResumo(D, 15);
  aberta = false;
  await lembrete.verificar();
  checar(!para(D).length, 'loja fechada: não lembra');
  aberta = true;

  const E = '15557798005';
  noResumo(E, 15);
  comAtendente.add(E);
  await lembrete.verificar();
  checar(!para(E).length, 'cliente com atendente humano: não lembra');

  const F = '15557798006';
  noResumo(F, 40);
  await lembrete.verificar();
  checar(!para(F).length, 'conversa já expirada (30 min): não lembra');

  // Depois do lembrete, o fluxo é o de sempre.
  const G = '15557798007';
  const sg = noResumo(G, 12);
  await lembrete.verificar();
  checar(para(G).length === 1, '(lembrado)');
  const respostas = [];
  await router.route(G, 's', async (t) => respostas.push(t));
  checar(criados === 1 && sg.orderId, 'respondendo "s" depois do lembrete, o pedido fecha como sempre');

  // Lembrete não mexe em nada da conversa além da marca.
  const H = '15557798008';
  const sh = noResumo(H, 12);
  const antes = JSON.stringify({ ...sh, lembreteConfirmacao: undefined, lastActivity: undefined });
  await lembrete.verificar();
  checar(JSON.stringify({ ...sh, lembreteConfirmacao: undefined, lastActivity: undefined }) === antes &&
    sh.state === 'CONFIRM', 'o lembrete não muda carrinho, etapa nem prazo da conversa');

  console.log('\n\x1b[32mlembreteconfirmacaotest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
