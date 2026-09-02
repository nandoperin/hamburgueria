process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.AI_ENABLED = 'on';
process.env.LOG_LEVEL = 'silent';
const path = require('path');
const PROJECT = path.resolve(__dirname, '..');

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  registrarUsoIA: async () => null,
};

let chamadas = 0;
let entrada;
let respostas = [];
const respostaPadrao = {
  texto: 'Recebi seu X-Bacon. Vai ser entrega ou retirada?',
  chamadas: [],
  uso: {},
};
const providerPath = require.resolve(`${PROJECT}/src/ai/provider`);
require(providerPath);
require.cache[providerPath].exports = {
  habilitada: () => true,
  getModelo: () => 'mistral-small-latest',
  get: () => ({
    conversar: async (args) => {
      chamadas += 1;
      entrada = args;
      const resposta = respostas.length ? respostas.shift() : respostaPadrao;
      if (resposta instanceof Error) throw resposta;
      return resposta;
    },
  }),
};

const session = require(`${PROJECT}/src/bot/session`);
delete require.cache[require.resolve(`${PROJECT}/src/ai/agente`)];
const agente = require(`${PROJECT}/src/ai/agente`);
const tools = require(`${PROJECT}/src/ai/tools`);
const orderHandler = require(`${PROJECT}/src/bot/handlers/order`);
const catalogorder = require(`${PROJECT}/src/bot/handlers/catalogorder`);
const ia = require(providerPath);

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
}

(async () => {
  const s = session.get('15550000003');
  s.lang = 'pt';
  s.cart = [{ id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 }];
  const saidas = [];
  const tratou = await agente.receberCarrinho(s, async (text) => saidas.push(text));
  checar(tratou && chamadas === 1, 'faz uma chamada quando basta perguntar o próximo dado');
  const conteudo = JSON.stringify(entrada.mensagens);
  checar(conteudo.includes('EVENTO_INTERNO_CARRINHO'), 'marca a origem interna');
  checar(
    !/quer retirar|quer acrescentar|personaliza|adiciona(?:l|is)|bebida|upsell/i.test(saidas.join(' ')),
    'não oferece personalização, adicionais nem bebida'
  );

  entrada = null;
  const conhecido = session.get('15550000004');
  Object.assign(conhecido, {
    lang: 'pt',
    name: 'Fernando',
    lastAddress: '6 Main St',
    lastCityId: 'everett',
    cart: [{ id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 }],
  });
  const falasConhecido = [];
  await agente.receberCarrinho(conhecido, async (text) => falasConhecido.push(text));
  const contextoConhecido = JSON.stringify(entrada.mensagens);
  checar(contextoConhecido.includes('Fernando'), 'evento leva o nome já conhecido');
  checar(contextoConhecido.includes('6 Main St'), 'evento leva o endereço já conhecido');
  checar(
    !/qual.*nome|seu nome|Fernando|6 Main St/i.test(falasConhecido.join(' ')),
    'não pede nem repete nome ou endereço conhecidos'
  );

  respostas = [new Error('indisponível')];
  const caiu = await agente.receberCarrinho(s, async () => {});
  checar(caiu === false, 'falha devolve controle ao checkout determinístico');

  const falhasFixRound1 = [];
  const verificar = (condicao, mensagem) => {
    if (!condicao) falhasFixRound1.push(mensagem);
  };

  // Uma resposta com tool call nunca pode executar a ferramenta nem comprar
  // uma segunda rodada: este evento só pede uma fala curta.
  const comTool = session.get('15550000005');
  comTool.lang = 'pt';
  comTool.cart = [{ id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 }];
  const carrinhoAntesDaTool = JSON.stringify(comTool.cart);
  const executarOriginal = tools.executar;
  let ferramentasExecutadas = 0;
  tools.executar = async () => {
    ferramentasExecutadas += 1;
    return { resultado: 'ok', atualizarFluxo: true };
  };
  chamadas = 0;
  entrada = null;
  respostas = [
    {
      texto: 'Vou registrar a entrega.',
      chamadas: [{ id: 'tool-1', nome: 'definir_entrega', argumentos: { tipo: 'delivery' } }],
      uso: { tokensIn: 100, tokensOut: 10 },
    },
    { texto: 'Segunda resposta indevida.', chamadas: [], uso: {} },
  ];
  const falasComTool = [];
  const recusouTool = await agente.receberCarrinho(
    comTool,
    async (text) => falasComTool.push(text)
  );
  tools.executar = executarOriginal;
  verificar(recusouTool === false, 'tool call interna transfere ao checkout');
  verificar(chamadas === 1, 'tool call interna não compra segunda chamada');
  verificar(ferramentasExecutadas === 0, 'tool call interna não executa ferramenta');
  verificar(falasComTool.length === 0, 'tool call interna não envia fala parcial');
  verificar(JSON.stringify(comTool.cart) === carrinhoAntesDaTool, 'tool call interna preserva carrinho');
  verificar(
    Array.isArray(entrada?.ferramentas) && entrada.ferramentas.length === 0,
    'evento interno não oferece ferramentas ao provedor'
  );

  // Fala vazia também não conta como atendimento: o checkout precisa assumir.
  const semFala = session.get('15550000006');
  semFala.lang = 'pt';
  semFala.cart = [{ id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 }];
  chamadas = 0;
  respostas = [{ texto: '   ', chamadas: [], uso: { tokensIn: 50, tokensOut: 0 } }];
  const falasVazias = [];
  const tratouVazio = await agente.receberCarrinho(semFala, async (text) => falasVazias.push(text));
  verificar(tratouVazio === false, 'fala vazia transfere ao checkout');
  verificar(chamadas === 1, 'fala vazia faz somente uma chamada');
  verificar(falasVazias.length === 0, 'fala vazia não envia mensagem');

  // Integração do desvio: usa o handler real e substitui apenas suas bordas.
  const receberOriginal = agente.receberCarrinho;
  const checkoutOriginal = orderHandler.startCheckout;
  const habilitadaOriginal = ia.habilitada;
  try {
    const tratada = session.get('15550000007');
    tratada.lang = 'pt';
    tratada.cart = [{ id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 }];
    let chamadasAoAgente = 0;
    let chamadasAoCheckout = 0;
    ia.habilitada = () => true;
    agente.receberCarrinho = async () => {
      chamadasAoAgente += 1;
      return true;
    };
    orderHandler.startCheckout = async () => {
      chamadasAoCheckout += 1;
    };
    await catalogorder.continueAfterCart(tratada, async () => {});
    verificar(chamadasAoAgente === 1, 'retorno true chama o agente uma vez');
    verificar(chamadasAoCheckout === 0, 'retorno true impede startCheckout');

    const fallback = session.get('15550000008');
    fallback.lang = 'pt';
    chamadasAoAgente = 0;
    chamadasAoCheckout = 0;
    let carrinhoNoAgente = null;
    let carrinhoNoCheckout = null;
    let idMarcadoNoAgente = false;
    agente.receberCarrinho = async (sess) => {
      chamadasAoAgente += 1;
      carrinhoNoAgente = JSON.stringify(sess.cart);
      idMarcadoNoAgente = sess.catalogOrderIds.includes('ord-ia-fallback');
      return false;
    };
    orderHandler.startCheckout = async (sess) => {
      chamadasAoCheckout += 1;
      carrinhoNoCheckout = JSON.stringify(sess.cart);
    };
    const resultadoFallback = await catalogorder.handleCartOrder(
      fallback,
      {
        source: 'baileys',
        externalOrderId: 'ord-ia-fallback',
        items: [{ productId: 'x_bacon', quantity: 2, externalProductId: 'wa-x-bacon' }],
      },
      async () => {}
    );
    const carrinhoDepoisDoFallback = JSON.stringify(fallback.cart);
    verificar(resultadoFallback.status === 'applied', 'fallback mantém status aplicado');
    verificar(chamadasAoAgente === 1, 'fallback consulta o agente uma vez');
    verificar(chamadasAoCheckout === 1, 'retorno false chama startCheckout exatamente uma vez');
    verificar(idMarcadoNoAgente, 'externalOrderId é marcado antes da continuação');
    verificar(
      carrinhoNoAgente === carrinhoNoCheckout && carrinhoNoCheckout === carrinhoDepoisDoFallback,
      'fallback entrega ao checkout o mesmo carrinho intacto'
    );
    verificar(fallback.cart[0]?.qty === 2, 'fallback preserva quantidade aplicada internamente');

    const desabilitada = session.get('15550000009');
    desabilitada.lang = 'pt';
    desabilitada.cart = [{ id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 }];
    chamadasAoAgente = 0;
    chamadasAoCheckout = 0;
    ia.habilitada = () => false;
    agente.receberCarrinho = async () => {
      chamadasAoAgente += 1;
      return true;
    };
    await catalogorder.continueAfterCart(desabilitada, async () => {});
    verificar(chamadasAoAgente === 0, 'IA desabilitada não chama agente');
    verificar(chamadasAoCheckout === 1, 'IA desabilitada chama checkout uma vez');
  } finally {
    agente.receberCarrinho = receberOriginal;
    orderHandler.startCheckout = checkoutOriginal;
    ia.habilitada = habilitadaOriginal;
  }

  checar(
    falhasFixRound1.length === 0,
    `fix round 1:\n- ${falhasFixRound1.join('\n- ')}`
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
