/**
 * Fluxo guiado sem "Quer algo mais?" (pedido do dono, 18/09).
 *
 * Depois dos itens o bot pergunta a entrega; item novo continua entrando em
 * qualquer etapa antes da confirmação. E o carrinho do catálogo segue pelo
 * fluxo guiado com a pergunta fixa — antes o agente antigo perguntava em texto
 * livre, a leitora não sabia o que tinha sido perguntado e o "Não" seguinte
 * ficava sem resposta.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.AI_ENABLED = 'on';
process.env.FLUXO_GUIADO = 'on';

const PROJECT = require('path').resolve(__dirname, '..');
const menuProducao = require('./fixtures/menu-producao.json');
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
config.get = (chave) => (chave === 'menu' ? menuProducao : getReal(chave));
require(`${PROJECT}/src/services/schedule`).isOpen = () => true;

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({ upsertCustomer: async (c) => ({ id: 1, ...c }) },
  { get: (alvo, k) => alvo[k] || (async () => null) });

const VAZIA = {
  itens: [], ambiguos: [], correcoes: [], refazer_lista: false, concluiu_itens: false,
  entrega: null, cidade: null, endereco: null, nome: null, pagamento: null, troco: null,
  confirma_resumo: null, pergunta: null, cancelar: false,
};
const item = (produto, qtd, trecho) => ({
  produto, qtd, sem: [], com: [], salsicha: null, ponto_bife: null, maionese_a_parte: false, trecho,
});
let proxima = VAZIA;
const provPath = require.resolve(`${PROJECT}/src/ai/provider`);
const provReal = require(provPath);
require.cache[provPath].exports = {
  ...provReal,
  habilitada: () => true, getProviderName: () => 'mistral', getModelo: () => 'mistral-small-latest',
  get: () => ({
    extrair: async () => ({ texto: JSON.stringify({ ...VAZIA, ...proxima }), concluida: true, uso: { tokensIn: 1, tokensOut: 1 } }),
    conversar: async () => { throw new Error('o agente antigo não deveria ser chamado'); },
  }),
};

const router = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}
async function falar(tel, texto, leitura) {
  proxima = { ...VAZIA, ...leitura };
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return saidas.join('\n---\n');
}

(async () => {
  // Texto: itens → direto para entrega ou retirada.
  const TEL = '15557790300';
  let r = await falar(TEL, 'boa noite\n1 xtudo', { itens: [item('x_tudo', 1, '1 xtudo')] });
  checar(!/algo mais/i.test(r) && /Entrega ou retirada\?/.test(r), 'depois dos itens pergunta entrega, sem "Quer algo mais?"');

  r = await falar(TEL, 'retirada e uma coca', { entrega: 'retirada', itens: [item('coca_cola', 1, 'uma coca')] });
  const s = session.get(TEL);
  checar(s.orderType === 'pickup' && s.cart.some((l) => l.productId === 'coca_cola'),
    'item novo no meio da coleta continua entrando');
  checar(!/algo mais/i.test(r), 'e nada de "Quer algo mais?" depois');

  // Catálogo: o fluxo guiado responde, com a pergunta fixa.
  const TEL2 = '15557790301';
  await falar(TEL2, 'À parte', {});
  const saidas = [];
  await router.routeOrder(TEL2, {
    source: 'meta', externalOrderId: 'guiado-catalogo-1',
    items: [{ productId: 'x_tudo', quantity: 2, externalProductId: 'x_tudo' }],
  }, async (t) => saidas.push(t));
  const s2 = session.get(TEL2);
  checar(/Anotei/.test(saidas.join('\n')) && /Entrega ou retirada\?/.test(saidas.join('\n')),
    'carrinho do catálogo: "Anotei" e a pergunta de entrega');
  checar(s2.state === 'ORDER' && s2.guiado?.ultimaPergunta === 'Entrega ou retirada?',
    'estado ORDER e a leitora sabe o que foi perguntado');

  r = await falar(TEL2, 'retirada', { entrega: 'retirada' });
  checar(session.get(TEL2).orderType === 'pickup', '"retirada" depois do catálogo é entendido');

  console.log('\n\x1b[32mguiadosemmaistest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
