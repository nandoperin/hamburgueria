/**
 * Quem atende a mensagem: a IA ou a máquina de estados?
 *
 * Esta suíte nasceu de um defeito que passou por 20 outras suítes verdes,
 * porque todas rodam com `AI_ENABLED=off` — e com a IA fora o comportamento
 * estava certo. O defeito só existia com ela **ligada**.
 *
 * ## O que acontecia
 *
 * O router mandava para a IA só nos estados `MENU` e `ORDER`. Era a lista certa
 * quando a IA apenas montava o carrinho e entregava o checkout para o fluxo
 * numerado. Depois que ela ganhou `definir_entrega`, `definir_cidade`,
 * `definir_endereco` e `definir_cadastro`, a lista virou armadilha:
 *
 *   1. o cliente digita "finalizar"
 *   2. o router intercepta ANTES da IA e chama `order.startCheckout`
 *   3. `startCheckout` muda o estado para ORDER_TYPE / ADDRESS / PROFILE
 *   4. `sess.state` não é mais MENU/ORDER → a IA **nunca mais é chamada**
 *
 * Da quarta linha em diante o cliente conversa com um formulário: "Para qual
 * cidade é a entrega?", depois "Informe seu endereço completo" — um campo por
 * vez, ignorando que ele respondeu os dois na mesma frase. Quem reportou
 * resumiu bem: "ele está um bot burro".
 *
 * ## Por que testar aqui, e não na prova contra o modelo
 *
 * Porque isto não é qualidade de modelo — é **roteamento**, e roteamento é
 * determinístico. O provedor abaixo é um espião que conta chamadas; nenhuma
 * linha desta suíte custa dinheiro nem depende do que uma IA respondeu.
 */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';

const PROJECT = require('path').resolve(__dirname, '..');

const schedulePath = require.resolve(`${PROJECT}/src/services/schedule`);
require(schedulePath);
require.cache[schedulePath].exports.isOpen = () => true;

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getCustomerByPhone: async () => null,
  getLastDeliveryOrder: async () => null,
  getActiveOrderByPhone: async () => null,
  upsertCustomer: async (c) => ({ id: 1, ...c }),
  createOrder: async (o) => ({ id: 99, ...o }),
  createPayment: async () => ({ id: 1 }),
  registrarUsoIA: async () => null,
  getUsoIA: async () => null,
};

require('./comentrega').ligar();

// ------------------------------------------------------ o provedor espião

let chamadasAoModelo = 0;
let ultimoTextoVisto = null;

const provPath = require.resolve(`${PROJECT}/src/ai/provider`);
const provReal = require(provPath);
require.cache[provPath].exports = {
  ...provReal,
  habilitada: () => process.env.AI_ENABLED !== 'off',
  getProviderName: () => 'mistral',
  getModelo: () => 'mistral-small-latest',
  get: () => ({
    conversar: async ({ mensagens }) => {
      chamadasAoModelo += 1;
      const ultima = [...mensagens].reverse().find((m) => m.role === 'user');
      ultimoTextoVisto = ultima?.content ?? null;
      return { texto: 'ok', chamadas: [], uso: { tokensIn: 10, tokensOut: 2 } };
    },
  }),
};

const notify = require(`${PROJECT}/src/bot/notify`);
const { route } = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);

const TEL = '15552223333';
let saidas = [];
const send = async (t) => saidas.push(t);

// Handlers que avisam fora do fluxo (ordertype, order) usam o notify direto.
notify.register(async (_phone, texto) => saidas.push(texto));

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

/** Sessão pronta, com carrinho, no estado pedido. */
function preparar(estado = 'MENU') {
  session.clear(TEL);
  const s = session.get(TEL);
  s.lang = 'pt';
  s.greeted = true;
  s.name = 'Maria';
  s.cart = [{ id: 'x_burger', name: 'X-Burger', price: 11, qty: 1 }];
  s.state = estado;
  saidas = [];
  chamadasAoModelo = 0;
  ultimoTextoVisto = null;
  return s;
}

/** O texto do fluxo numerado, que não pode aparecer com a IA ligada. */
const PERGUNTA_DE_FORMULARIO = /Para qual cidade|Informe seu \*endereço|endereço completo/i;

(async () => {
  // ------------------------------------- 1. o defeito relatado
  console.log('\n\x1b[36m### 1. "finalizar" NAO SEQUESTRA A CONVERSA ###\x1b[0m');
  process.env.AI_ENABLED = 'on';

  const s = preparar('MENU');
  await route(TEL, 'finalizar', send);

  checar(chamadasAoModelo === 1, 'a IA foi chamada — "finalizar" chegou ao modelo');
  checar(
    ultimoTextoVisto === 'finalizar',
    'e chegou inteiro, sem o router ter engolido a mensagem'
  );
  checar(
    !saidas.some((t) => PERGUNTA_DE_FORMULARIO.test(t)),
    'nenhuma pergunta de formulário foi enviada ao cliente'
  );
  checar(
    ['MENU', 'ORDER'].includes(s.state),
    `o estado continua conversável (${s.state}) — a IA não foi expulsa`
  );

  // ------------------------------- 2. os estados de coleta também são da IA
  console.log('\n\x1b[36m### 2. A IA CONDUZ OS ESTADOS DE COLETA ###\x1b[0m');
  for (const estado of ['ORDER_TYPE', 'DELIVERY_CITY', 'ADDRESS', 'PROFILE']) {
    preparar(estado);
    await route(TEL, 'é pra Chelsea, rua tal 123, sou a Maria', send);
    checar(
      chamadasAoModelo === 1,
      `em ${estado}, a mensagem vai para a IA — que sabe ler os três campos de uma frase`
    );
  }

  // --------------------------- 3. o compromisso continua sendo do código
  console.log('\n\x1b[36m### 3. CONFIRM E PAGAMENTO NAO SAO DA IA ###\x1b[0m');
  for (const estado of ['CONFIRM', 'PAYMENT_PENDING']) {
    preparar(estado);
    await route(TEL, 'sim', send);
    checar(
      chamadasAoModelo === 0,
      `em ${estado} a IA NAO é chamada — o "sim" sobre o resumo é compromisso, não conversa`
    );
  }

  // ------------------------------------ 4. com a IA fora, tudo como antes
  console.log('\n\x1b[36m### 4. AI_ENABLED=off MANTEM O FLUXO NUMERADO ###\x1b[0m');
  process.env.AI_ENABLED = 'off';

  const s4 = preparar('MENU');
  s4.orderType = 'delivery';
  await route(TEL, 'finalizar', send);

  checar(chamadasAoModelo === 0, 'a IA não foi chamada');
  checar(
    saidas.some((t) => PERGUNTA_DE_FORMULARIO.test(t)) || s4.state !== 'MENU',
    'e o checkout numerado assumiu — a rede de segurança continua armada'
  );

  process.env.AI_ENABLED = 'on';
  console.log('\n\x1b[32mroteamentotest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
