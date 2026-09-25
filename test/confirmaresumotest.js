/**
 * "Sim / obrigado" fecha o pedido (dono, 25/09).
 *
 * No resumo só "sim" e "s" exatos fechavam; "sim\nobrigado" ia para a IA, que
 * nem sempre marcava a confirmação, e o pedido ficava sem fechar.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';
process.env.FLUXO_GUIADO = 'on';

const PROJECT = require('path').resolve(__dirname, '..');
require(`${PROJECT}/src/services/schedule`).isOpen = () => true;

let criados = 0;
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({
  upsertCustomer: async (c) => ({ id: 1, ...c }),
  createOrder: async () => ({ id: 500 + (++criados) }),
  createZellePayment: async () => ({ id: 1 }),
}, { get: (alvo, k) => alvo[k] || (async () => null) });
require(`${PROJECT}/src/bot/notify`).send = async () => true;
require(`${PROJECT}/src/services/zelle`).conferir = () => ({ ok: true });

// A IA não é chamada: se for, o teste mostra.
let chamouIA = 0;
const provPath = require.resolve(`${PROJECT}/src/ai/provider`);
const provReal = require(provPath);
require.cache[provPath].exports = {
  ...provReal,
  habilitada: () => true, getProviderName: () => 'mistral', getModelo: () => 'mistral-small-latest',
  get: () => ({
    extrair: async () => { chamouIA += 1; return { texto: '{}', concluida: true, uso: { tokensIn: 1, tokensOut: 1 } }; },
    conversar: async () => { throw new Error('o agente antigo não deveria ser chamado'); },
  }),
};

const order = require(`${PROJECT}/src/bot/handlers/order`);
const router = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);
const pt = require(`${PROJECT}/src/i18n/pt.json`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

// 1. A leitura da resposta.
for (const f of ['sim', 'Sim', 's', 'S', 'sim\nobrigado', 'Sim, obrigada!', 'sim obg', 'Ss', 'ok',
  'Ok 👍', 'pode fechar', 'Pode confirmar por favor', 'isso mesmo', 'Confirmo', 'certo', 'blz', 'sim sim']) {
  checar(order.respostaDoResumo(f) === 'sim', `"${f.replace('\n', '\\n')}" confirma`);
}
for (const f of ['não', 'nao', 'n', 'N', 'Não, obrigado', 'n obrigada']) {
  checar(order.respostaDoResumo(f) === 'nao', `"${f}" recusa`);
}
for (const f of ['não, tira a cebola', 'sim mas sem tomate', 'quanto tempo?', 'quero mais um x tudo', 'simples']) {
  checar(order.respostaDoResumo(f) === null, `"${f}" segue para a IA (não é só sim/não)`);
}

// 2. A pergunta diz as abreviações.
for (const chave of ['confirm_again', 'order_summary', 'order_summary_pickup', 'guiado_confirmar']) {
  checar(pt[chave].includes('*Sim (s)* ou *Não (n)*'), `"${chave}" pede Sim (s) ou Não (n)`);
}

// 3. No fluxo: "sim\nobrigado" no resumo fecha o pedido, sem passar pela IA.
async function noResumo(tel, texto) {
  const s = session.get(tel);
  Object.assign(s, {
    lang: 'pt', state: 'CONFIRM', name: 'Ana', orderType: 'pickup', paymentMethod: 'zelle',
    cart: [{ id: 'x_tudo', productId: 'x_tudo', name: 'X Tudo', qty: 1, price: 20 }],
    subtotal: 20, deliveryFee: 0, total: 20, escolhaItensConcluida: true,
  });
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return { s, saidas };
}

(async () => {
  const antes = criados;
  const { s } = await noResumo('15557795001', 'sim\nobrigado');
  checar(criados === antes + 1 && s.orderId, '"sim\\nobrigado" no resumo cria o pedido');
  checar(chamouIA === 0, '   sem chamar a IA');

  const r2 = await noResumo('15557795002', 'S');
  checar(criados === antes + 2 && r2.s.orderId, '"S" no resumo cria o pedido');

  const r3 = await noResumo('15557795003', 'Não, obrigado');
  checar(criados === antes + 2 && r3.s.state === 'ORDER' && !r3.s.orderId && r3.s.cart.length === 1,
    '"Não, obrigado" volta para alterar, com o carrinho intacto');

  // 4. Pagamento: letra, nome ou "dinheiro", com cortesia.
  for (const [f, m] of [['c', 'cash'], ['C', 'cash'], ['Cash', 'cash'], ['dinheiro', 'cash'], ['Dinheiro, obrigada', 'cash'],
    ['em dinheiro', 'cash'], ['vou pagar em dinheiro', 'cash'], ['pago na entrega', 'cash'], ['dinheito', 'cash'],
    ['z', 'zelle'], ['Z', 'zelle'], ['Zelle', 'zelle'], ['zele', 'zelle'], ['pelo zelle', 'zelle'], ['Zelle por favor', 'zelle']]) {
    checar(order.escolhaDePagamento(f) === m, `"${f}" é ${m}`);
  }
  for (const f of ['aceita cartão?', 'aceita zelle?', 'cartão', 'cash ou zelle', 'a', 'e', 'quanto fica?', 'pode ser']) {
    checar(order.escolhaDePagamento(f) === null, `"${f}" segue para a IA`);
  }
  checar(pt.payment_method_ask.includes('*Cash (c)* ou *Zelle (z)*') && pt.guiado_cartao.includes('*Cash (c)* ou *Zelle (z)*'),
    'a pergunta diz Cash (c) ou Zelle (z)');

  async function naEscolha(tel, texto) {
    const s = session.get(tel);
    Object.assign(s, {
      lang: 'pt', state: 'PAYMENT_METHOD', name: 'Ana', orderType: 'pickup', paymentMethod: null,
      cart: [{ id: 'x_tudo', productId: 'x_tudo', name: 'X Tudo', qty: 1, price: 20 }], escolhaItensConcluida: true,
    });
    const saidas = [];
    await router.route(tel, texto, async (t) => saidas.push(t));
    return { s, saidas };
  }
  const iaAntes = chamouIA;
  const p1 = await naEscolha('15557795011', 'c');
  checar(p1.s.paymentMethod === 'cash' && p1.s.state === 'CONFIRM' && /RESUMO/.test(p1.saidas.join()),
    '"c" escolhe cash e mostra o resumo');
  const p2 = await naEscolha('15557795012', 'Dinheiro obrigado');
  checar(p2.s.paymentMethod === 'cash' && p2.s.state === 'CONFIRM', '"Dinheiro obrigado" escolhe cash');
  const p3 = await naEscolha('15557795013', 'Z');
  checar(p3.s.paymentMethod === 'zelle' && p3.s.state === 'CONFIRM', '"Z" escolhe Zelle');
  checar(chamouIA === iaAntes, '   sem chamar a IA');

  console.log('\n\x1b[32mconfirmaresumotest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
