process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.SQUARE_ACCESS_TOKEN = 'faketoken';
process.env.SQUARE_LOCATION_ID = 'FAKELOC';
process.env.BASE_URL = 'https://fake.test';
process.env.ADMIN_PHONE = '16174449612';
process.env.PRINT_ALERT_MINUTES = '2';

const PROJECT = require('path').resolve(__dirname, '..');

const agora = Date.now();
const min = (n) => new Date(agora - n * 60000).toISOString();

let fila = [];
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getUnprintedPaidOrders: async () => fila,
};

const notify = require(`${PROJECT}/src/bot/notify`);
let enviados = [];
notify.register(async (phone, texto) => {
  enviados.push({ phone, texto });
  console.log(`\n\x1b[33m--- WhatsApp para ${phone} ---\x1b[0m`);
  console.log(texto);
});

const pw = require(`${PROJECT}/src/services/printwatch`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const pedido = (id, minutosPago, total = 22) => ({
  id,
  customer_name: 'Fer',
  phone: '16178667738',
  total,
  created_at: min(minutosPago + 5),
  payments: [{ paid_at: min(minutosPago), status: 'paid' }],
});

(async () => {
  // ------------------------------------------- 1. fila vazia, impressora viva
  console.log('\n\x1b[36m### 1. TUDO CERTO ###\x1b[0m');
  pw.registrarPolling();
  fila = [];
  console.log(await pw.resumo());
  enviados = [];
  await pw.verificar();
  checar(enviados.length === 0, 'nao avisa quando nao ha nada esperando');

  // ------------------------------------------- 2. pago ha pouco, sem alerta
  console.log('\n\x1b[36m### 2. PAGO HA 30 SEGUNDOS ###\x1b[0m');
  fila = [{ ...pedido(30, 0), payments: [{ paid_at: new Date(agora - 30000).toISOString() }] }];
  enviados = [];
  await pw.verificar();
  checar(enviados.length === 0, 'nao avisa dentro da janela de 2 min');
  console.log(await pw.resumo());

  // ------------------------------------------- 3. atrasado -> alerta
  console.log('\n\x1b[36m### 3. PAGO HA 5 MIN, NAO IMPRESSO ###\x1b[0m');
  fila = [pedido(31, 5)];
  enviados = [];
  await pw.verificar();
  checar(enviados.length === 1, 'avisa o admin uma vez');
  checar(/#31/.test(enviados[0].texto), 'o aviso cita o numero do pedido');
  checar(enviados[0].phone === '16174449612', 'vai para o ADMIN_PHONE');
  checar(
    /consultando normalmente/.test(enviados[0].texto),
    'diagnostica que a impressora esta viva (papel/tampa)'
  );

  // ------------------------------------------- 4. nao repete
  console.log('\n\x1b[36m### 4. NAO REPETE O MESMO AVISO ###\x1b[0m');
  enviados = [];
  await pw.verificar();
  await pw.verificar();
  checar(enviados.length === 0, 'nao avisa de novo pelo mesmo pedido');

  // ------------------------------------------- 5. impressora muda
  console.log('\n\x1b[36m### 5. IMPRESSORA SEM SINAL ###\x1b[0m');
  pw.stop();
  const pwPath = require.resolve(`${PROJECT}/src/services/printwatch`);
  delete require.cache[pwPath];
  const pw2 = require(pwPath);
  // sem registrarPolling: nunca falou
  fila = [pedido(32, 5)];
  enviados = [];
  await pw2.verificar();
  checar(enviados.length === 1, 'avisa mesmo sem nunca ter tido polling');
  checar(
    /sem dar sinal/.test(enviados[0].texto),
    'diagnostica que a impressora esta fora (energia/rede)'
  );
  console.log(await pw2.resumo());

  // ------------------------------------------- 6. so status pago
  console.log('\n\x1b[36m### 6. SO OLHA STATUS PAGO ###\x1b[0m');
  const fonte = require('fs').readFileSync(`${PROJECT}/src/db/queries.js`, 'utf8');
  const trecho = fonte.slice(fonte.indexOf('async function getUnprintedPaidOrders'));
  checar(
    /\.eq\('status',\s*'paid'\)/.test(trecho.slice(0, 400)),
    'a query filtra exatamente status = paid'
  );

  console.log('\n\x1b[32mTodos os cenarios passaram.\x1b[0m');
})().catch((e) => {
  console.error('\n\x1b[31mFALHOU:\x1b[0m', e.message);
  process.exit(1);
});
