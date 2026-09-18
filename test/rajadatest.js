/**
 * Pedido digitado em vários balões seguidos, na primeira conversa.
 *
 * 17/09: "boa noite" / "1 xtudo" / "2 hot dog" / "1 coca" / "para entrega",
 * cada um num balão. O bot atendia os cinco ao mesmo tempo — três boas-vindas
 * seguidas, histórico da IA embaralhado, X-Tudo perdido e "Não entendi" no fim.
 * Para o cliente, o bot "entendeu como saudação".
 *
 * Banco com a latência de uma consulta real e IA simulada: nada aqui depende
 * de modelo, é tudo ordem de execução.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';

const PROJECT = require('path').resolve(__dirname, '..');
require(`${PROJECT}/src/services/schedule`).isOpen = () => true;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
const lento = (v) => async () => { await espera(120); return v; };
require.cache[dbPath].exports = {
  getCustomerByPhone: lento(null), getLastDeliveryOrder: lento(null), getUltimoPedidoFeito: lento(null),
  getActiveOrderByPhone: lento(null), upsertCustomer: async (c) => ({ id: 1, ...c }),
  registrarUsoIA: async () => null, getUsoIA: async () => null, registrarConversa: async () => null,
};

const vistas = [];
const provPath = require.resolve(`${PROJECT}/src/ai/provider`);
const provReal = require(provPath);
require.cache[provPath].exports = {
  ...provReal,
  habilitada: () => true, getProviderName: () => 'mistral', getModelo: () => 'mistral-small-latest',
  get: () => ({
    conversar: async ({ mensagens, ferramentas }) => {
      await espera(150);
      const ultima = [...mensagens].reverse()
        .find((m) => m.role === 'user' && !String(m.content).startsWith('['));
      const texto = String(ultima?.content || '');
      const jaExecutou = mensagens[mensagens.length - 1]?.role === 'tool';
      if (!jaExecutou) vistas.push(texto);
      if (!jaExecutou && ferramentas?.length && /xtudo/i.test(texto)) {
        return { texto: '', chamadas: [{ id: 'c1', nome: 'adicionar_item', argumentos: { item_id: 'x_tudo' } }],
          uso: { tokensIn: 1, tokensOut: 1 } };
      }
      return { texto: 'Anotado!', chamadas: [], uso: { tokensIn: 1, tokensOut: 1 } };
    },
  }),
};

const router = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const FALAS = ['boa noite', '1 xtudo', '2 hot dog', '1 coca', 'para entrega'];

async function rajada(tel) {
  const saidas = [];
  const send = async (t) => { saidas.push(t); };
  const pendentes = [];
  for (const fala of FALAS) {
    pendentes.push(router.route(tel, fala, send));
    await espera(40);
  }
  await Promise.all(pendentes);
  return saidas;
}

const boasVindas = (saidas) => saidas.filter((s) => /Bem-vindo/.test(s)).length;
const temXTudo = (tel) => session.get(tel).cart.some((l) => l.productId === 'x_tudo');

(async () => {
  // ------------------------------------------- 1. só a fila, sem agrupar
  console.log('\n\x1b[36m### 1. UMA MENSAGEM DE CADA VEZ ###\x1b[0m');
  process.env.AGRUPAR_MS = '0';
  vistas.length = 0;
  let saidas = await rajada('15557770001');
  checar(boasVindas(saidas) === 1, 'uma boas-vindas só, não uma por balão');
  // Repetições seguidas são rodadas internas do próprio agente, não atropelo.
  const lidas = vistas.filter((v, i) => v !== vistas[i - 1]);
  const posicoes = lidas.map((v) => FALAS.indexOf(v));
  checar(posicoes.every((p, i) => p > 0 && (i === 0 || p > posicoes[i - 1])) && lidas[0] === '1 xtudo',
    'a IA lê os balões na ordem em que chegaram, sem misturar um com outro');
  checar(temXTudo('15557770001'), 'o X-Tudo do segundo balão não se perde');

  // --------------------------------- 2. a rajada inicial vira uma mensagem
  console.log('\n\x1b[36m### 2. RAJADA AGRUPADA ###\x1b[0m');
  process.env.AGRUPAR_MS = '100';
  vistas.length = 0;
  saidas = await rajada('15557770002');
  checar(vistas.length === 1 && vistas[0] === FALAS.join('\n'),
    'os cinco balões chegam à IA como um pedido só');
  checar(saidas.length === 1 && boasVindas(saidas) === 1,
    'uma resposta só, com a saudação colada');
  checar(!/O que vai querer hoje/.test(saidas[0]) && !/menu digital/.test(saidas[0]),
    'quem já pediu não ouve "O que vai querer hoje?" nem o convite ao menu');
  checar(temXTudo('15557770002'), 'e o pedido entra');

  // ------------------------------ 3. "oi" sozinho continua como sempre
  console.log('\n\x1b[36m### 3. SÓ SAUDAÇÃO ###\x1b[0m');
  process.env.AGRUPAR_MS = '0';
  const soOi = [];
  await router.route('15557770003', 'boa noite', async (t) => soOi.push(t));
  checar(soOi.length === 1 && /O que vai querer hoje/.test(soOi[0]),
    'quem só cumprimenta recebe a saudação completa, com a pergunta');

  // --------------------- 4. com pedido em andamento, balões não se juntam
  console.log('\n\x1b[36m### 4. DEPOIS QUE O PEDIDO COMEÇOU ###\x1b[0m');
  process.env.AGRUPAR_MS = '100';
  vistas.length = 0;
  const tel = '15557770002';
  const send = async () => {};
  await Promise.all([router.route(tel, 'mais uma coca', send), router.route(tel, 'obrigado', send)]);
  const lidas4 = vistas.filter((v, i) => v !== vistas[i - 1]);
  checar(lidas4.length === 2 && lidas4[0] === 'mais uma coca' && lidas4[1] === 'obrigado',
    'com carrinho montado, cada balão é atendido sozinho — "sim" + "obrigado" não viram outra frase');

  delete process.env.AGRUPAR_MS;
  console.log('\n\x1b[32mrajadatest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
