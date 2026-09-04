process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.AI_ENABLED = 'on';
process.env.LOG_LEVEL = 'silent';
const path = require('path');
const PROJECT = path.resolve(__dirname, '..');
const pedidosCriados = [];
const pagamentosCriados = [];

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  registrarUsoIA: async () => null,
  upsertCustomer: async () => ({ id: 501 }),
  createOrder: async (dados) => {
    const order = { id: 701, ...JSON.parse(JSON.stringify(dados)) };
    pedidosCriados.push(order);
    return order;
  },
  createPayment: async (dados) => pagamentosCriados.push({ ...dados }),
};

let chamadas = 0;
let entrada;
let respostas = [];
const respostaPadrao = {
  texto: 'Recebi seu X-Bacon. Quer algo mais? Digite menu para abrir as opções.',
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
  checar(/algo mais/i.test(saidas.join(' ')), 'a IA redige a etapa de continuar escolhendo');
  const conteudo = JSON.stringify(entrada.mensagens);
  checar(conteudo.includes('EVENTO_INTERNO_CARRINHO'), 'marca a origem interna');
  checar(
    !/quer retirar|quer acrescentar|personaliza|adiciona(?:l|is)|bebida|upsell/i.test(saidas.join(' ')),
    'não oferece personalização, adicionais nem bebida'
  );

  const falaProibida = session.get('15550000010');
  falaProibida.lang = 'pt';
  falaProibida.cart = [
    { id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 },
  ];
  respostas = [{
    texto: 'Recebi seu X-Bacon. Quer acrescentar bacon ou pedir uma bebida?',
    chamadas: [],
    uso: {},
  }];
  const falasProibidas = [];
  const bloqueouFala = await agente.receberCarrinho(
    falaProibida,
    async (text) => falasProibidas.push(text)
  );
  checar(bloqueouFala === false, 'política determinística rejeita oferta pós-catálogo');
  checar(falasProibidas.length === 0, 'fala rejeitada não é enviada ao cliente');

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

  respostas = [Object.assign(new Error('segredo-no-corpo-do-provedor'), { statusCode: 429 })];
  const log = require('../src/log');
  const logOriginal = log.error;
  const errosSeguros = [];
  log.error = (...args) => errosSeguros.push(args);
  const caiu = await agente.receberCarrinho(s, async () => {});
  log.error = logOriginal;
  checar(caiu === false, 'falha devolve controle ao checkout determinístico');
  checar(errosSeguros.some(([dados]) => dados.statusHTTP === 429), 'falha da IA registra status HTTP');
  checar(!JSON.stringify(errosSeguros).includes('segredo-no-corpo'), 'diagnóstico não expõe corpo da falha');

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
    tratada.escolhaItensConcluida = true; // Exercita continuação após "só isso".
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

    const completa = session.get('15550000011');
    Object.assign(completa, {
      lang: 'pt',
      state: 'CONFIRM',
      orderType: 'pickup',
      name: 'Cliente Completo',
      cart: [{ id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 }],
    });
    chamadasAoAgente = 0;
    chamadasAoCheckout = 0;
    await catalogorder.continueAfterCart(completa, async () => {});
    verificar(chamadasAoAgente === 0, 'dados completos não chamam IA após catálogo');
    verificar(chamadasAoCheckout === 1, 'dados completos recalculam pelo checkout determinístico');

    const fallback = session.get('15550000008');
    fallback.escolhaItensConcluida = true;
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
    desabilitada.escolhaItensConcluida = true;
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

  const schedulePath = require.resolve(`${PROJECT}/src/services/schedule`);
  require(schedulePath);
  require.cache[schedulePath].exports.isOpen = () => true;
  const { route, routeOrder } = require(`${PROJECT}/src/bot/router`);

  // Um carrinho pode ser a primeira mensagem da sessão. A pergunta da IA só
  // pode sair depois que LANGUAGE deixou de ser o estado ativo; do contrário,
  // a resposta do cliente é capturada pelo welcome.
  const telefoneLanguage = '15550000012';
  session.clear(telefoneLanguage);
  respostas = [
    { texto: 'Recebi seu X-Bacon. Vai ser entrega ou retirada?', chamadas: [], uso: {} },
    { texto: 'Perfeito, retirada.', chamadas: [], uso: {} },
  ];
  chamadas = 0;
  await routeOrder(telefoneLanguage, {
    source: 'meta',
    externalOrderId: 'language-primeiro-carrinho',
    items: [{ productId: 'x_bacon', quantity: 1, externalProductId: 'x_bacon' }],
  }, async () => {});
  verificar(session.get(telefoneLanguage).state !== 'LANGUAGE', 'carrinho tira sessão de LANGUAGE antes da fala');
  const chamadasDepoisDoCarrinho = chamadas;
  await route(telefoneLanguage, 'retirada', async () => {});
  verificar(chamadas === chamadasDepoisDoCarrinho + 1, 'resposta após routeOrder volta à IA, não ao welcome');

  // Resumo antigo → novo catálogo → novo resumo. Com todos os dados presentes,
  // a mutação não chama IA e só permite criar o pedido com o total recalculado.
  const telefoneConfirm = '15550000013';
  session.clear(telefoneConfirm);
  const emConfirmacao = session.get(telefoneConfirm);
  Object.assign(emConfirmacao, {
    lang: 'pt',
    state: 'ORDER',
    orderType: 'pickup',
    name: 'Cliente Confirmado',
    cart: [
      { id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 },
    ],
  });
  const falasConfirmacao = [];
  await orderHandler.mostrarResumo(emConfirmacao, async (text) => falasConfirmacao.push(text));
  verificar(emConfirmacao.total === 14, 'resumo inicial fixa total de $14');
  verificar(falasConfirmacao.join('\n').includes('$14.00'), 'cliente recebe o resumo inicial de $14');

  chamadas = 0;
  const inicioNovoResumo = falasConfirmacao.length;
  await routeOrder(telefoneConfirm, {
    source: 'meta',
    externalOrderId: 'confirm-adiciona-guarana',
    items: [{ productId: 'guarana', quantity: 1, externalProductId: 'guarana' }],
  }, async (text) => falasConfirmacao.push(text));
  const novoResumo = falasConfirmacao.slice(inicioNovoResumo).join('\n');
  verificar(chamadas === 0, 'mutação em CONFIRM com dados completos não chama IA');
  verificar(emConfirmacao.state === 'CONFIRM' && emConfirmacao.total === 17, 'mutação recalcula total para $17');
  verificar(/X-Bacon[\s\S]*Guaraná|Guaraná[\s\S]*X-Bacon/.test(novoResumo), 'novo resumo contém os dois itens');
  verificar(novoResumo.includes('$17.00'), 'novo resumo com total correto sai antes da confirmação');
  verificar(pedidosCriados.length === 0, 'nenhum pedido é criado antes do novo resumo ser confirmado');

  const zelle = require(`${PROJECT}/src/services/zelle`);
  const conferirOriginal = zelle.conferir;
  const instrucoesOriginal = zelle.instrucoes;
  zelle.conferir = () => ({ ok: true, faltando: [] });
  zelle.instrucoes = (order) => `PAGAMENTO TOTAL $${Number(order.total).toFixed(2)}`;
  try {
    await route(telefoneConfirm, 'sim', async (text) => falasConfirmacao.push(text));
  } finally {
    zelle.conferir = conferirOriginal;
    zelle.instrucoes = instrucoesOriginal;
  }
  verificar(pedidosCriados.length === 1, 'confirmação posterior cria um pedido');
  verificar(pedidosCriados[0]?.total === 17, 'pedido usa somente o total novo de $17');
  verificar(pedidosCriados[0]?.items.length === 2, 'pedido confirmado contém os dois itens');
  verificar(pagamentosCriados[0]?.amount === 17, 'pagamento usa o total novo de $17');
  verificar(emConfirmacao.state === 'PAYMENT_PENDING', 'pedido correto avança para pagamento');

  checar(
    falhasFixRound1.length === 0,
    `fix round 1:\n- ${falhasFixRound1.join('\n- ')}`
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
