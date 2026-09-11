/**
 * O caixa: cash, Zelle conferido e Zelle a conferir, separados.
 *
 * Com a comanda saindo no comprovante, "vendido" deixou de querer dizer
 * "recebido". Esta suíte trava as duas pontas que mostram a diferença ao dono:
 * o `!relatorio`, e o resumo que chega sozinho quando o dia fecha — uma vez,
 * sem cobrança no dia seguinte (decisão do dono).
 */

process.env.DATABASE_URL = 'postgresql://fake';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.ADMIN_PHONE = '15550001111,15550002222';

const PROJECT = require('path').resolve(__dirname, '..');

let aberto = true;
const schedulePath = require.resolve(`${PROJECT}/src/services/schedule`);
require(schedulePath);
require.cache[schedulePath].exports.isOpen = () => aberto;

let linhas = [];
const consultas = [];
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getPagamentosDoPeriodo: async (de, ate) => {
    consultas.push({ de, ate });
    return linhas;
  },
  getReport: async () => ({
    orderCount: linhas.length,
    revenue: linhas.reduce((s, l) => s + l.total, 0),
    deliveryFees: 0,
    avgTicket: 0,
    topItems: [],
  }),
  getRevenueByDay: async () => [],
};

const notify = require(`${PROJECT}/src/bot/notify`);
const enviadas = [];
notify.register(async (phone, texto) => {
  enviadas.push({ phone, texto });
  return true;
});

const caixa = require(`${PROJECT}/src/services/caixa`);
const watch = require(`${PROJECT}/src/services/fechamentowatch`);
const admin = require(`${PROJECT}/src/bot/handlers/admin`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

async function comando(texto) {
  const ditas = [];
  await admin.handle('15550001111', texto, async (x) => ditas.push(x));
  return ditas.join('\n');
}

const DIA = [
  { id: 80, total: 20, customer_name: 'Ana', order_status: 'cash_due', method: 'cash', payment_status: 'cash_due' },
  { id: 81, total: 14.5, customer_name: 'Bia', order_status: 'printed', method: 'zelle', payment_status: 'paid' },
  { id: 82, total: 30, customer_name: 'Caio', order_status: 'printed', method: 'zelle', payment_status: 'awaiting_review' },
  { id: 83, total: 12, customer_name: 'Dani', order_status: 'delivered', method: 'zelle', payment_status: 'review_reminded' },
  { id: 84, total: 25, customer_name: 'Edu', order_status: 'rejected', method: 'zelle', payment_status: 'rejected' },
];

(async () => {
  // ------------------------------------------------------ 1. a classificação
  console.log('\n\x1b[36m### 1. SEPARANDO O CAIXA ###\x1b[0m');
  const c = caixa.classificar(DIA);
  checar(c.cash.qtd === 1 && c.cash.total === 20, 'cash fica separado');
  checar(c.conferido.qtd === 1 && c.conferido.total === 14.5, 'Zelle conferido e o que o dono marcou');
  checar(c.aConferir.qtd === 2 && c.aConferir.total === 42, 'comprovante sem conferencia e a conferir, com ou sem lembrete');
  checar(c.recusado.qtd === 1 && c.recusado.total === 25, 'recusado aparece a parte');

  // ------------------------------------------------------ 2. o !relatorio
  console.log('\n\x1b[36m### 2. !relatorio ###\x1b[0m');
  linhas = DIA;
  const hoje = await comando('!relatorio hoje');
  console.log(hoje);
  checar(/Cash: 1 - \$20\.00/.test(hoje), 'o relatorio de hoje mostra o cash');
  checar(/Zelle conferido: 1 - \$14\.50/.test(hoje), 'o Zelle conferido');
  checar(/Zelle a conferir: 2 - \$42\.00/.test(hoje), 'e o Zelle a conferir');
  checar(/#82/.test(hoje) && /#83/.test(hoje) && !/#81/.test(hoje), 'listando so quem falta conferir');
  checar(/Recusado: 1 - \$25\.00/.test(hoje), 'e o recusado');

  const semana = await comando('!relatorio semana');
  checar(/Zelle a conferir: 2/.test(semana) && !/#82/.test(semana), 'na semana, so a conta — sem lista');

  // ---------------------------------------------- 3. o dia fecha: um resumo
  console.log('\n\x1b[36m### 3. FECHAMENTO ###\x1b[0m');
  enviadas.length = 0;
  aberto = true;
  await watch.verificar();
  checar(enviadas.length === 0, 'a primeira volta so observa — restart nao vira fechamento');

  aberto = false;
  const agora = new Date('2026-09-12T04:00:30Z');
  await watch.verificar(agora);
  checar(enviadas.length === 2, 'fechou: os dois admins recebem o caixa do Zelle');
  checar(enviadas.map((e) => e.phone).join() === '15550001111,15550002222', 'um em cada numero');
  const msg = enviadas[0].texto;
  console.log(msg);
  checar(/CAIXA ZELLE DO DIA/.test(msg), 'com titulo proprio');
  checar(/Conferido: 1 - \$14\.50/.test(msg) && /A conferir: 2 - \$42\.00/.test(msg), 'conferido e a conferir');
  checar(/#82/.test(msg) && /#83/.test(msg), 'os pendentes listados, pedido a pedido');
  checar(/!liberar todos/.test(msg) && /!recusar/.test(msg), 'com os comandos prontos');
  checar(!/Cash/.test(msg), 'o caixa do fechamento e so do Zelle');
  checar(!/[^\x00-\x7F]/.test(msg), 'sem acento e sem emoji, como todo aviso ao dono');
  const janela = consultas[consultas.length - 1];
  checar(new Date(janela.ate) - new Date(janela.de) === 24 * 60 * 60 * 1000,
    'o periodo e das ultimas 24 horas — o expediente inteiro, mesmo fechando a meia-noite');

  // ------------------------------ 4. nada de cobrança depois do fechamento
  console.log('\n\x1b[36m### 4. DEPOIS DO FECHAMENTO ###\x1b[0m');
  enviadas.length = 0;
  await watch.verificar();
  await watch.verificar();
  checar(enviadas.length === 0, 'fechado, nao repete o resumo');
  aberto = true;
  await watch.verificar();
  checar(enviadas.length === 0, 'e a abertura do dia seguinte nao cobra o que ficou pendente');

  // ------------------------------------------------ 5. dia sem Zelle, tudo ok
  console.log('\n\x1b[36m### 5. SEM ZELLE / TUDO CONFERIDO ###\x1b[0m');
  linhas = [DIA[0]];
  aberto = false;
  await watch.verificar();
  checar(enviadas.length === 0, 'dia so com cash nao gera mensagem');

  linhas = [DIA[1]];
  aberto = true;
  await watch.verificar();
  aberto = false;
  await watch.verificar();
  checar(/Todos os Zelle do dia foram conferidos/.test(enviadas[0]?.texto || ''),
    'tudo conferido: o resumo diz isso');
  checar(!/!liberar todos/.test(enviadas[0].texto), 'e nao sugere comando a toa');

  watch.stop();
  console.log('\n\x1b[32mcaixatest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
