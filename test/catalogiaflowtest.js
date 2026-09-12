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
  createPickupZellePayment: async (dados) => pagamentosCriados.push({ ...dados, method: 'zelle', status: 'pending' }),
};

let chamadas = 0;
let entrada;
let entradas = [];
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
      entradas.push(args);
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

// O link do catálogo no "não entendi" vem do número CONECTADO, nunca de um
// número fixo no texto — na troca de número do WhatsApp, é isto que impede o
// cliente de ser mandado ao catálogo antigo.
require(`${PROJECT}/src/bot/notify`).registerRich({ catalogLink: () => 'https://wa.me/c/15550000000' });

(async () => {
  const aleatorio = session.get('15550000019');
  aleatorio.lang = 'pt';
  aleatorio.state = 'MENU';
  chamadas = 0;
  respostas = [];
  const falasAleatorias = [];
  await agente.conversar(aleatorio, 'qzxwpl rrrt',
    async (text) => falasAleatorias.push(text));
  checar(chamadas === 0, 'texto aleatório com carrinho vazio não é entregue ao modelo');
  checar(falasAleatorias.length === 1 && /Não entendi/i.test(falasAleatorias[0]) &&
    /\*menu\*/i.test(falasAleatorias[0]) && /wa\.me\/c\/15550000000/.test(falasAleatorias[0]) &&
    !/16175188432/.test(falasAleatorias[0]),
  'texto aleatório recebe somente a saída com menu e o catálogo do número conectado');

  const invencao = session.get('15550000020');
  invencao.lang = 'pt';
  invencao.state = 'MENU';
  respostas = [
    {
      texto: '',
      chamadas: [
        { id: 'inventou-item', nome: 'adicionar_item', argumentos: { item_id: 'x_tudo' } },
        { id: 'inventou-entrega', nome: 'definir_entrega', argumentos: { tipo: 'delivery' } },
      ],
      uso: {},
    },
    { texto: 'Não entendi. Para ver as opções, escreva menu.', chamadas: [], uso: {} },
  ];
  chamadas = 0;
  const falasInvencao = [];
  await agente.conversar(invencao, 'vocês estão abertos?',
    async (text) => falasInvencao.push(text));
  checar(chamadas === 2, 'invenção do modelo é recusada e devolvida para correção');
  checar(invencao.cart.length === 0 && !invencao.orderType,
    'modelo não consegue inventar produto nem entrega');

  const typoProduto = session.get('15550000021');
  typoProduto.lang = 'pt';
  typoProduto.state = 'MENU';
  respostas = [
    {
      texto: '',
      chamadas: [{ id: 'typo-item', nome: 'adicionar_item', argumentos: { item_id: 'x_bacon' } }],
      uso: {},
    },
    { texto: 'Bacon Burger adicionado. Quer algo mais?', chamadas: [], uso: {} },
  ];
  chamadas = 0;
  await agente.conversar(typoProduto, 'quero um banconburger', async () => {});
  checar(typoProduto.cart.some((line) => line.productId === 'x_bacon'),
    'erro comum em banconburger continua sendo entendido');

  const apelidoCoca = session.get('15550000022');
  apelidoCoca.lang = 'pt';
  apelidoCoca.state = 'MENU';
  respostas = [
    { texto: 'Você quer Coca-Cola ou Guaraná?', chamadas: [], uso: {} },
    {
      texto: '',
      chamadas: [{ id: 'coca-direta', nome: 'adicionar_item', argumentos: { item_id: 'coca_cola' } }],
      uso: {},
    },
    { texto: 'Coca-Cola adicionada. Quer algo mais?', chamadas: [], uso: {} },
  ];
  chamadas = 0;
  const falasCoca = [];
  await agente.conversar(apelidoCoca, 'coca', async (text) => falasCoca.push(text));
  checar(chamadas === 3 && apelidoCoca.cart.some((line) => line.productId === 'coca_cola'),
    'coca registra diretamente Coca-Cola mesmo se o modelo tentar perguntar');
  checar(falasCoca.length === 1 && !/ou Guaraná/i.test(falasCoca[0]),
    'pergunta ambígua sobre coca não chega ao cliente');

  /**
   * O bug real: "coca" dentro de um pedido maior, não sozinha.
   *
   * A primeira versão do apelido direto só reconhecia a mensagem "coca"
   * inteira. Um cliente de verdade escreveu "2 sanduíches e uma coca" — o
   * modelo registrou os sanduíches (o carrinho MUDOU) e ainda assim perguntou
   * "Coca-Cola ou outros?" pra bebida. A correção antiga nunca disparava
   * porque comparava o carrinho inteiro antes/depois, e o carrinho não estava
   * mais igual (os sanduíches já tinham entrado).
   */
  const cocaEmFraseComposta = session.get('15550000023');
  cocaEmFraseComposta.lang = 'pt';
  cocaEmFraseComposta.state = 'MENU';
  respostas = [
    {
      texto: '',
      chamadas: [
        { id: 's1', nome: 'adicionar_item', argumentos: { item_id: 'x_bacon' } },
        { id: 's2', nome: 'adicionar_item', argumentos: { item_id: 'x_tudo' } },
      ],
      uso: {},
    },
    { texto: 'Anotei os dois sanduíches! Coca-Cola ou outro refrigerante?', chamadas: [], uso: {} },
    {
      texto: '',
      chamadas: [{ id: 'coca-composta', nome: 'adicionar_item', argumentos: { item_id: 'coca_cola' } }],
      uso: {},
    },
    { texto: 'Coca-Cola adicionada também. Quer algo mais?', chamadas: [], uso: {} },
  ];
  chamadas = 0;
  const falasComposta = [];
  await agente.conversar(
    cocaEmFraseComposta,
    'um bacon burger, um x tudo e uma coca',
    async (text) => falasComposta.push(text)
  );
  checar(
    cocaEmFraseComposta.cart.some((line) => line.productId === 'x_bacon') &&
      cocaEmFraseComposta.cart.some((line) => line.productId === 'x_tudo'),
    'os dois sanduíches da frase composta continuam no carrinho'
  );
  checar(
    cocaEmFraseComposta.cart.some((line) => line.productId === 'coca_cola'),
    'a coca da mesma frase também foi registrada, mesmo com o carrinho já alterado'
  );
  checar(
    !falasComposta.some((f) => /ou outro refrigerante/i.test(f)),
    'a pergunta ambígua sobre a coca não chega ao cliente mesmo dentro de pedido maior'
  );

  /** "não quero coca" não pode virar pedido de coca só por conter a palavra. */
  const recusaCoca = session.get('15550000024');
  recusaCoca.lang = 'pt';
  recusaCoca.state = 'MENU';
  respostas = [
    {
      texto: '',
      chamadas: [{ id: 'so-bacon', nome: 'adicionar_item', argumentos: { item_id: 'x_bacon' } }],
      uso: {},
    },
    { texto: 'Certo, só o X-Bacon então. Mais alguma coisa?', chamadas: [], uso: {} },
  ];
  chamadas = 0;
  await agente.conversar(recusaCoca, 'quero um x-bacon, sem coca', async () => {});
  checar(
    !recusaCoca.cart.some((line) => line.productId === 'coca_cola'),
    '"sem coca" não força a coca a ser adicionada'
  );

  chamadas = 0;
  respostas = [];
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

  const montagemSemCarrinho = session.get('15550000018');
  montagemSemCarrinho.lang = 'pt';
  montagemSemCarrinho.cart = [
    { id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 },
  ];
  respostas = [
    { texto: 'Seu carrinho tem 1 X-Bacon. Subtotal: $14.', chamadas: [], uso: {} },
    { texto: 'X-Bacon adicionado. Quer algo mais?', chamadas: [], uso: {} },
  ];
  chamadas = 0;
  const falasMontagem = [];
  await agente.receberCarrinho(montagemSemCarrinho,
    async (text) => falasMontagem.push(text));
  checar(chamadas === 2, 'fala de carrinho durante a montagem é retida e refeita');
  checar(falasMontagem.length === 1 && /X-Bacon adicionado/i.test(falasMontagem[0]),
    'cliente recebe somente a confirmação curta do item');
  checar(!/carrinho|subtotal|resumo/i.test(falasMontagem[0]),
    'montagem inicial não exibe carrinho nem resumo');

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

  // O ultimo dado obrigatorio encerra a etapa da IA imediatamente. Mesmo que
  // o provedor tenha preparado uma segunda resposta prometendo um link, ela
  // nao pode ser chamada nem enviada: o resumo vem sempre do checkout.
  const fechamentoGarantido = session.get('15550000014');
  Object.assign(fechamentoGarantido, {
    lang: 'pt',
    state: 'PROFILE',
    orderType: 'pickup',
    paymentMethod: 'zelle',
    cashChangeAnswered: true,
    escolhaItensConcluida: true,
    name: null,
    cart: [
      { id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 15 },
    ],
  });
  chamadas = 0;
  respostas = [
    {
      texto: '',
      chamadas: [
        { id: 'nome-final', nome: 'definir_cadastro', argumentos: { nome: 'Giovanna' } },
      ],
      uso: {},
    },
    {
      texto: 'Ok, Giovanna! Vou enviar um link para confirmar.',
      chamadas: [],
      uso: {},
    },
  ];
  const falasFechamento = [];
  const fechou = await agente.conversar(
    fechamentoGarantido,
    'Giovanna',
    async (text) => falasFechamento.push(text)
  );
  const textoFechamento = falasFechamento.join('\n');
  verificar(fechou === true, 'ultimo dado entrega a conversa ao checkout');
  verificar(chamadas === 1, 'ultimo dado nao compra uma segunda chamada de IA');
  verificar(fechamentoGarantido.state === 'CONFIRM', 'resumo oficial muda o estado para CONFIRM');
  verificar(/RESUMO DO PEDIDO/i.test(textoFechamento), 'cliente recebe o resumo oficial');
  verificar(!/vou enviar um link|quase pronto/i.test(textoFechamento), 'fala inventada nao chega ao cliente');

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
      paymentMethod: 'zelle',
      cashChangeAnswered: true,
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
  // "retirada" sozinho é registrado pelo sistema, sem gastar o modelo — e
  // não é capturado pelo welcome.
  verificar(chamadas === chamadasDepoisDoCarrinho && session.get(telefoneLanguage).orderType === 'pickup',
    'resposta após routeOrder é registrada pelo sistema, não capturada pelo welcome');

  // A IA pode perguntar "Só isso por enquanto?". Nesse contexto, "sim"
  // significa que acabou. O antigo atalho lia como "sim, quero mais" e
  // repetia "Quer algo mais?".
  const telefoneFimCatalogo = '15550000015';
  session.clear(telefoneFimCatalogo);
  const fimCatalogo = session.get(telefoneFimCatalogo);
  Object.assign(fimCatalogo, {
    lang: 'pt',
    state: 'ORDER',
    cart: [{ id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 }],
    aguardandoMaisItens: true,
    maisItensViaIaCatalogo: true,
  });
  agente.registrarSaudacao(fimCatalogo, 'Só isso por enquanto?');
  respostas = [{
    texto: '',
    chamadas: [{ id: 'fim-itens', nome: 'concluir_escolha_itens', argumentos: {} }],
    uso: {},
  }];
  chamadas = 0;
  const falasFimCatalogo = [];
  await route(telefoneFimCatalogo, 'sim', async (text) => falasFimCatalogo.push(text));
  verificar(chamadas === 1, 'sim após "só isso?" é interpretado pela IA');
  verificar(fimCatalogo.escolhaItensConcluida, 'IA registra que a escolha do catálogo terminou');
  verificar(!fimCatalogo.aguardandoMaisItens && !fimCatalogo.maisItensViaIaCatalogo,
    'etapa pós-catálogo é encerrada');
  verificar(!/quer algo mais|o que mais/i.test(falasFimCatalogo.join(' ')),
    'não repete a pergunta de mais itens');
  verificar(/entrega|retirada/i.test(falasFimCatalogo.join(' ')),
    'segue diretamente para o próximo dado obrigatório');

  // Resumo antigo → novo catálogo → novo resumo. Com todos os dados presentes,
  // a mutação não chama IA e só permite criar o pedido com o total recalculado.
  const telefoneConfirm = '15550000013';
  session.clear(telefoneConfirm);
  const emConfirmacao = session.get(telefoneConfirm);
  Object.assign(emConfirmacao, {
    lang: 'pt',
    state: 'ORDER',
    orderType: 'pickup',
    paymentMethod: 'zelle',
    cashChangeAnswered: true,
    name: 'Cliente Confirmado',
    cart: [
      { id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 },
    ],
  });
  const falasConfirmacao = [];
  await orderHandler.mostrarResumo(emConfirmacao, async (text) => falasConfirmacao.push(text));
  const totalInicial = emConfirmacao.total;
  verificar(totalInicial > 0, 'resumo inicial calcula o preço vigente');
  verificar(falasConfirmacao.join('\n').includes(`$${totalInicial.toFixed(2)}`),
    'cliente recebe o total vigente no resumo inicial');

  chamadas = 0;
  const inicioNovoResumo = falasConfirmacao.length;
  await routeOrder(telefoneConfirm, {
    source: 'meta',
    externalOrderId: 'confirm-adiciona-guarana',
    items: [{ productId: 'guarana', quantity: 1, externalProductId: 'guarana' }],
  }, async (text) => falasConfirmacao.push(text));
  const novoResumo = falasConfirmacao.slice(inicioNovoResumo).join('\n');
  verificar(chamadas === 0, 'mutação em CONFIRM com dados completos não chama IA');
  const totalComGuarana = totalInicial + 3;
  verificar(emConfirmacao.state === 'CONFIRM' && emConfirmacao.total === totalComGuarana,
    'mutação soma o Guaraná ao preço vigente');
  verificar(/X-Bacon[\s\S]*Guaraná|Guaraná[\s\S]*X-Bacon/.test(novoResumo), 'novo resumo contém os dois itens');
  verificar(novoResumo.includes(`$${totalComGuarana.toFixed(2)}`),
    'novo resumo com total correto sai antes da confirmação');
  verificar(pedidosCriados.length === 0, 'nenhum pedido é criado antes do novo resumo ser confirmado');

  const zelle = require(`${PROJECT}/src/services/zelle`);
  const conferirOriginal = zelle.conferir;
  const instrucoesOriginal = zelle.instrucoes;
  zelle.conferir = () => ({ ok: true, faltando: [] });
  zelle.instrucoes = (order) => `PAGAMENTO TOTAL $${Number(order.total).toFixed(2)}`;
  try {
    await route(telefoneConfirm, 'sim', async (text) => falasConfirmacao.push(text));
    verificar(emConfirmacao.state === 'ORDER_COMPLETE', 'confirmação libera a retirada com o pagamento já escolhido');
  } finally {
    zelle.conferir = conferirOriginal;
    zelle.instrucoes = instrucoesOriginal;
  }
  verificar(pedidosCriados.length === 1, 'confirmação posterior cria um pedido');
  verificar(pedidosCriados[0]?.total === totalComGuarana, 'pedido usa somente o total novo');
  verificar(pedidosCriados[0]?.items.length === 2, 'pedido confirmado contém os dois itens');
  verificar(pagamentosCriados[0]?.amount === totalComGuarana, 'pagamento usa o total novo');
  verificar(emConfirmacao.state === 'ORDER_COMPLETE', 'retirada correta avança para cozinha');

  // No resumo, perguntas e confirmações naturais pertencem à IA. O modelo
  // conversa, mas a criação continua passando exclusivamente pela ferramenta
  // protegida, que chama o mesmo código da confirmação exata.
  const telefoneResumoNatural = '15550000016';
  session.clear(telefoneResumoNatural);
  const resumoNatural = session.get(telefoneResumoNatural);
  Object.assign(resumoNatural, {
    lang: 'pt',
    state: 'ORDER',
    orderType: 'pickup',
    paymentMethod: 'zelle',
    cashChangeAnswered: true,
    name: 'Cliente Natural',
    cart: [
      { id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 },
    ],
  });
  const falasResumoNatural = [];
  await orderHandler.mostrarResumo(resumoNatural, async (text) => falasResumoNatural.push(text));
  respostas = [{ texto: 'Há 1 X-Bacon no seu pedido.', chamadas: [], uso: {} }];
  chamadas = 0;
  const pedidosAntesDaPergunta = pedidosCriados.length;
  await route(telefoneResumoNatural, 'o que tem no meu pedido?',
    async (text) => falasResumoNatural.push(text));
  verificar(chamadas === 1, 'pergunta sobre o resumo passa pela IA');
  verificar(resumoNatural.state === 'CONFIRM', 'pergunta não confirma nem reabre o pedido');
  verificar(pedidosCriados.length === pedidosAntesDaPergunta,
    'responder uma dúvida não cria pedido');

  respostas = [{
    texto: '',
    chamadas: [{
      id: 'corrige-resumo',
      nome: 'personalizar_item',
      argumentos: { item_id: 'x_bacon', quantidade: 1, remover: ['tomate'] },
    }],
    uso: {},
  }];
  const inicioCorrecao = falasResumoNatural.length;
  await route(telefoneResumoNatural, 'tira o tomate e pode finalizar',
    async (text) => falasResumoNatural.push(text));
  const saidaCorrecao = falasResumoNatural.slice(inicioCorrecao).join('\n');
  verificar(resumoNatural.cart[0].removed?.includes('tomate'),
    'correção natural altera o item existente sem duplicá-lo');
  verificar(resumoNatural.cart.length === 1 && resumoNatural.state === 'CONFIRM',
    'correção mostra um novo resumo e aguarda nova confirmação');
  verificar(pedidosCriados.length === pedidosAntesDaPergunta,
    'correção nunca confirma o mesmo resumo automaticamente');
  verificar(/RESUMO DO PEDIDO/i.test(saidaCorrecao),
    'alteração completa volta diretamente ao resumo oficial');
  verificar(!/carrinho|mais alguma coisa|quer algo mais|escreva.*finalizar/i.test(saidaCorrecao),
    'correção não mostra carrinho nem abre outra etapa de mais itens');

  respostas = [{
    texto: '',
    chamadas: [{ id: 'confirma-natural', nome: 'confirmar_resumo', argumentos: {} }],
    uso: {},
  }];
  zelle.conferir = () => ({ ok: true, faltando: [] });
  zelle.instrucoes = (order) => `PAGAMENTO TOTAL $${Number(order.total).toFixed(2)}`;
  try {
    await route(telefoneResumoNatural, 'pode mandar, está tudo certo',
      async (text) => falasResumoNatural.push(text));
    verificar(resumoNatural.state === 'ORDER_COMPLETE',
      'confirmação natural libera a retirada com a forma já escolhida');
  } finally {
    zelle.conferir = conferirOriginal;
    zelle.instrucoes = instrucoesOriginal;
  }
  verificar(chamadas === 3, 'correção e confirmação naturais passam pela IA');
  verificar(pedidosCriados.length === pedidosAntesDaPergunta + 1,
    'ferramenta protegida cria exatamente um pedido');
  verificar(resumoNatural.state === 'ORDER_COMPLETE',
    'confirmação natural libera a retirada pelo código');

  // Com mais de um lanche, "adiciona salsicha" não autoriza escolher o
  // primeiro. A ferramenta recusa a suposição e a IA reúne destino e preparo
  // em uma única pergunta.
  const telefoneSalsichaAmbigua = '15550000017';
  session.clear(telefoneSalsichaAmbigua);
  const salsichaAmbigua = session.get(telefoneSalsichaAmbigua);
  Object.assign(salsichaAmbigua, {
    lang: 'pt',
    state: 'ORDER',
    orderType: 'pickup',
    paymentMethod: 'zelle',
    cashChangeAnswered: true,
    name: 'Cliente Salsicha',
    cart: [
      { id: 'x_tudo:-tomate', productId: 'x_tudo', name: 'X Tudo (sem Tomate)', qty: 1, price: 20, removed: ['tomate'], added: [] },
      { id: 'x_bacon', productId: 'x_bacon', name: 'Bacon Burger', qty: 1, price: 15, removed: [], added: [] },
      { id: 'coca_cola', productId: 'coca_cola', name: 'Coca cola', qty: 1, price: 2, removed: [], added: [] },
      { id: 'hot_plain', productId: 'hot_plain', name: 'Hot plain', qty: 1, price: 6, removed: [], added: [] },
    ],
  });
  await orderHandler.mostrarResumo(salsichaAmbigua, async () => {});
  respostas = [
    {
      texto: '',
      chamadas: [{
        id: 'suposicao-x-tudo',
        nome: 'personalizar_item',
        argumentos: { item_id: 'x_tudo', acrescentar: ['salsicha'] },
      }],
      uso: {},
    },
    {
      texto: 'Em qual lanche você quer a salsicha?',
      chamadas: [],
      uso: {},
    },
    {
      texto: 'Em qual lanche quer a salsicha — X Tudo, Bacon Burger ou Hot plain — e ela vai junto ou à parte?',
      chamadas: [],
      uso: {},
    },
  ];
  chamadas = 0;
  entradas = [];
  const falasSalsicha = [];
  await route(telefoneSalsichaAmbigua, 'adiciona salsicha',
    async (text) => falasSalsicha.push(text));
  verificar(chamadas === 3, 'pergunta incompleta é retida e a IA a refaz completa');
  verificar(falasSalsicha.length === 1 && !falasSalsicha[0].includes('\n'),
    'destino e preparo são perguntados na mesma linha');
  verificar(/X Tudo/i.test(falasSalsicha[0]) && /Bacon Burger/i.test(falasSalsicha[0]) &&
    /Hot plain/i.test(falasSalsicha[0]) && /junto/i.test(falasSalsicha[0]) &&
    /à parte/i.test(falasSalsicha[0]),
  'a pergunta da IA mostra todos os lanches e as duas formas de preparo');
  verificar(!salsichaAmbigua.cart.some(line => (line.added || []).includes('salsicha')),
    'nenhum lanche recebe a salsicha antes da escolha do cliente');
  verificar(JSON.stringify(entradas[1]?.mensagens).includes('Não escolha o lanche por conta própria'),
    'a recusa protegida orienta a segunda resposta da IA');

  respostas = [{
    texto: '',
    chamadas: [{
      id: 'salsicha-no-bacon',
      nome: 'personalizar_item',
      argumentos: {
        item_id: 'x_bacon',
        acrescentar: ['salsicha'],
        preparo_salsicha: 'junto',
      },
    }],
    uso: {},
  }];
  chamadas = 0;
  falasSalsicha.length = 0;
  await route(telefoneSalsichaAmbigua, 'Bacon Burger, junto',
    async (text) => falasSalsicha.push(text));
  verificar(chamadas === 1, 'resposta completa registra destino e preparo em uma chamada');
  verificar(salsichaAmbigua.cart.find(line => line.productId === 'x_bacon')
    ?.preparoSalsicha?.modo === 'junto', 'salsicha fica no Bacon Burger escolhido');
  verificar(!(salsichaAmbigua.cart.find(line => line.productId === 'x_tudo')?.added || [])
    .includes('salsicha'), 'X Tudo permanece sem salsicha');
  verificar(falasSalsicha.length === 1 && /RESUMO DO PEDIDO/i.test(falasSalsicha[0]),
    'depois da escolha, envia somente o novo resumo');
  verificar(!/carrinho|mais alguma coisa|quer algo mais/i.test(falasSalsicha[0]),
    'não mostra carrinho nem pergunta se quer mais depois da correção');

  // Com um único lanche não há motivo para perguntar o destino. A primeira
  // resposta mostra só as duas formas de preparo e a escolha curta precisa ser
  // registrada, mesmo se o modelo tentar reperguntar.
  const telefoneSalsichaUnica = '15550000023';
  session.clear(telefoneSalsichaUnica);
  const salsichaUnica = session.get(telefoneSalsichaUnica);
  Object.assign(salsichaUnica, {
    lang: 'pt', state: 'ORDER', editingCart: true, escolhaItensConcluida: true,
    orderType: 'pickup', paymentMethod: 'zelle', cashChangeAnswered: true,
    name: 'Cliente Único',
    cart: [{
      id: 'x_tudo', productId: 'x_tudo', name: 'X Tudo', qty: 1, price: 20,
      removed: [], added: [],
    }],
  });
  respostas = [
    {
      texto: '',
      chamadas: [{
        id: 'adiciona-salsicha-unica', nome: 'personalizar_item',
        argumentos: { item_id: 'x_tudo', acrescentar: ['salsicha'] },
      }],
      uso: {},
    },
    { texto: 'Salsicha adicionada por $1. Ela vai junto ou à parte?', chamadas: [], uso: {} },
    { texto: 'A salsicha vai junto ou à parte?', chamadas: [], uso: {} },
  ];
  chamadas = 0;
  const falasSalsichaUnica = [];
  await route(telefoneSalsichaUnica, 'adiciona salsicha',
    async (text) => falasSalsichaUnica.push(text));
  verificar(chamadas === 3 && falasSalsichaUnica.length === 1,
    'pergunta com valor é retida e refeita uma única vez');
  verificar(/junto/i.test(falasSalsichaUnica[0]) && /à parte/i.test(falasSalsichaUnica[0]) &&
    !/\$|valor|preço|X Tudo/i.test(falasSalsichaUnica[0]),
  'com um lanche pergunta somente junto ou à parte, sem valor nem destino');

  const linhaSalsichaUnica = salsichaUnica.cart.find((line) =>
    (line.added || []).includes('salsicha'));
  respostas = [
    { texto: 'Junto com o X Tudo?', chamadas: [], uso: {} },
    {
      texto: '',
      chamadas: [{
        id: 'preparo-salsicha-unica', nome: 'definir_preparo_salsicha',
        argumentos: { item_id: linhaSalsichaUnica.id, modo: 'junto' },
      }],
      uso: {},
    },
  ];
  chamadas = 0;
  falasSalsichaUnica.length = 0;
  await route(telefoneSalsichaUnica, 'junto',
    async (text) => falasSalsichaUnica.push(text));
  verificar(chamadas === 2 && linhaSalsichaUnica.preparoSalsicha?.modo === 'junto',
    'junto registra o preparo sem repetir a pergunta');
  verificar(falasSalsichaUnica.length === 1 && /RESUMO DO PEDIDO/i.test(falasSalsichaUnica[0]) &&
    !/não entendi|junto com o X Tudo\?/i.test(falasSalsichaUnica[0]),
  'depois do preparo segue direto ao novo resumo');

  checar(
    falhasFixRound1.length === 0,
    `fix round 1:\n- ${falhasFixRound1.join('\n- ')}`
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
