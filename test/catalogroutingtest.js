require('./menu-legado');
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.AI_ENABLED = 'off';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const PROJECT = path.resolve(__dirname, '..');
const {
  fromBaileys,
  fromMeta,
  CatalogInputError,
} = require(`${PROJECT}/src/bot/catalog/adapters`);

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
}

const FIX_ROUND_2_CHILD = 'CATALOG_ROUTING_LOG_CHILD';
const FIX_ROUND_2_RESULT = '__CATALOG_ROUTING_RESULT__';

if (process.env[FIX_ROUND_2_CHILD]) {
  const schedulePath = require.resolve(`${PROJECT}/src/services/schedule`);
  require(schedulePath);
  require.cache[schedulePath].exports.isOpen = () => true;

  const comprovante = require(`${PROJECT}/src/services/comprovante`);
  comprovante.receber = async () => {
    throw new Error('SEGREDO-COMPROVANTE-REAL');
  };

  const log = require(`${PROJECT}/src/log`);
  const { routeImagem } = require(`${PROJECT}/src/bot/router`);
  const respostas = [];

  (async () => {
    await routeImagem(
      '15550000006',
      Buffer.from('DADOS-DO-CLIENTE-REAL'),
      'image/jpeg',
      async (text) => respostas.push(text)
    );
    log.base.flush();
    process.stdout.write(`${FIX_ROUND_2_RESULT}${JSON.stringify(respostas)}\n`);
  })().catch((err) => {
    process.stderr.write(String(err.stack));
    process.exit(1);
  });

  return;
}

(async () => {
  const sock = {
    getOrderDetails: async () => ({
      products: [{ id: 'wa-1', name: 'X-Bacon', quantity: 1, price: 0.01 }],
      price: 0.01,
    }),
  };
  const b = await fromBaileys(sock, { orderId: 'b-1', token: Buffer.from('token') });
  const m = fromMeta({
    id: 'm-1',
    order: { product_items: [{ product_retailer_id: 'x_bacon', quantity: 1 }] },
  });
  checar(JSON.stringify(b.items) === JSON.stringify(m.items.map((i) => ({
    ...i,
    externalProductId: 'wa-1',
  }))), 'provedores produzem o mesmo produto e quantidade');

  let falhaSigilosa;
  try {
    await fromBaileys({
      getOrderDetails: async () => {
        throw new Error('SEGREDO-DO-PROVEDOR');
      },
    }, { orderId: 'b-sigiloso', token: Buffer.from('TOKEN-SIGILOSO') });
  } catch (err) {
    falhaSigilosa = err;
  }
  checar(
    falhaSigilosa instanceof CatalogInputError && falhaSigilosa.code === 'leitura_falhou',
    'rejeição do Baileys vira código público conhecido'
  );
  checar(
    !JSON.stringify(falhaSigilosa).includes('SEGREDO-DO-PROVEDOR') &&
      !JSON.stringify(falhaSigilosa).includes('TOKEN-SIGILOSO'),
    'rejeição do Baileys não carrega erro nem token secretos'
  );

  const catalog = require(`${PROJECT}/src/services/catalog`);
  const resolverOriginal = catalog.resolverNomePt;
  catalog.resolverNomePt = () => ({ ok: false, erro: 'ambiguo' });
  let falhaAmbigua;
  try {
    await fromBaileys(sock, { orderId: 'b-ambiguo', token: Buffer.from('token') });
  } catch (err) {
    falhaAmbigua = err;
  } finally {
    catalog.resolverNomePt = resolverOriginal;
  }
  checar(
    falhaAmbigua instanceof CatalogInputError && falhaAmbigua.code === 'produto_ambiguo',
    'ambiguidade do Baileys recebe classificação direta'
  );

  const schedulePath = require.resolve(`${PROJECT}/src/services/schedule`);
  require(schedulePath);
  require.cache[schedulePath].exports.isOpen = () => true;
  const { routeOrder } = require(`${PROJECT}/src/bot/router`);
  const session = require(`${PROJECT}/src/bot/session`);
  const phone = '15550000004';
  session.clear(phone);
  const pending = session.get(phone);
  pending.lang = 'pt';
  pending.state = 'PAYMENT_PENDING';
  pending.orderId = 77;
  pending.catalogOrderIds = Array.from({ length: 20 }, (_value, i) => `antigo-${i + 1}`);
  const fotografia = JSON.stringify({
    state: pending.state,
    orderId: pending.orderId,
    cart: pending.cart,
    catalogOrderIds: pending.catalogOrderIds,
  });
  const respostas = [];
  const send = async (text) => respostas.push(text);
  const retransmissao = {
    source: 'meta',
    externalOrderId: 'antigo-20',
    items: [{ productId: 'x_bacon', quantity: 1, externalProductId: 'x_bacon' }],
  };

  await routeOrder(phone, retransmissao, send);
  checar(session.get(phone) === pending, 'retransmissão pendente mantém a mesma sessão');
  checar(JSON.stringify({
    state: pending.state,
    orderId: pending.orderId,
    cart: pending.cart,
    catalogOrderIds: pending.catalogOrderIds,
  }) === fotografia, 'retransmissão pendente não altera a sessão');
  checar(respostas.length === 1, 'retransmissão pendente recebe somente confirmação curta');

  Object.assign(pending, {
    customerId: 91,
    subtotal: 14,
    deliveryFee: 0,
    total: 14,
    orderType: 'pickup',
    name: 'Cliente Preservado',
  });
  const fotografiaPagamento = () => JSON.stringify({
    state: pending.state,
    orderId: pending.orderId,
    customerId: pending.customerId,
    cart: pending.cart,
    subtotal: pending.subtotal,
    deliveryFee: pending.deliveryFee,
    total: pending.total,
    orderType: pending.orderType,
    name: pending.name,
    catalogOrderIds: pending.catalogOrderIds,
  });
  const antesDasRecusas = fotografiaPagamento();
  const recusasPendentes = [
    {
      source: 'meta',
      externalOrderId: 'novo-invalido-quantidade',
      items: [{ productId: 'x_bacon', quantity: 0, externalProductId: 'x_bacon' }],
    },
    {
      source: 'meta',
      externalOrderId: 'novo-invalido-produto',
      items: [{ productId: 'produto_inexistente', quantity: 1, externalProductId: 'sigiloso' }],
    },
  ];
  for (const pedidoInvalido of recusasPendentes) {
    const inicioRespostas = respostas.length;
    await routeOrder(phone, pedidoInvalido, send);
    checar(session.get(phone) === pending, 'ID novo inválido mantém a mesma sessão pendente');
    checar(fotografiaPagamento() === antesDasRecusas, 'recusa mantém pagamento e carrinho byte a byte');
    checar(respostas.length === inicioRespostas + 1, 'recusa pendente responde uma vez');
  }

  const cardapio = require(`${PROJECT}/src/services/cardapio`);
  const disponibilidadeOriginal = cardapio.disponivel;
  cardapio.disponivel = (item) => item.id !== 'agua';
  const inicioEsgotado = respostas.length;
  await routeOrder(phone, {
    source: 'meta',
    externalOrderId: 'novo-invalido-esgotado',
    items: [{ productId: 'agua', quantity: 1, externalProductId: 'agua' }],
  }, send);
  cardapio.disponivel = disponibilidadeOriginal;
  checar(session.get(phone) === pending, 'produto esgotado mantém a mesma sessão pendente');
  checar(fotografiaPagamento() === antesDasRecusas, 'esgotado preserva pagamento e IDs byte a byte');
  checar(respostas.length === inicioEsgotado + 1, 'esgotado pendente recebe recusa');

  await routeOrder(phone, {
    ...retransmissao,
    externalOrderId: 'novo-1',
  }, send);
  const reiniciada = session.get(phone);
  checar(reiniciada !== pending, 'ID novo reinicia a sessão pendente');
  checar(
    reiniciada.cart.length === 1 && reiniciada.cart[0].productId === 'x_bacon',
    'ID novo inicia carrinho determinístico'
  );
  checar(reiniciada.catalogOrderIds.length === 20, 'novo carrinho mantém teto de 20 IDs');
  checar(
    reiniciada.catalogOrderIds[0] === 'antigo-2' &&
      reiniciada.catalogOrderIds[19] === 'novo-1',
    'novo carrinho preserva os IDs recentes após reset'
  );

  const catalogorder = require(`${PROJECT}/src/bot/handlers/catalogorder`);
  const log = require(`${PROJECT}/src/log`);
  const handleOriginal = catalogorder.handleCartOrder;
  const logErrorOriginal = log.error;
  let registro;
  const respostasErro = [];
  catalogorder.handleCartOrder = async () => {
    throw new Error('SEGREDO-INTERNO-DO-CARRINHO');
  };
  log.error = (dados, mensagem) => {
    registro = { dados, mensagem };
  };
  try {
    await routeOrder('15550000005', {
      source: 'meta',
      externalOrderId: 'erro-1',
      items: [{ productId: 'x_bacon', quantity: 1, externalProductId: 'x_bacon' }],
    }, async (text) => respostasErro.push(text));
  } finally {
    catalogorder.handleCartOrder = handleOriginal;
    log.error = logErrorOriginal;
  }
  checar(
    registro && !Object.prototype.hasOwnProperty.call(registro.dados, 'err'),
    'falha interna do roteador não registra erro bruto'
  );
  checar(
    !JSON.stringify(registro).includes('SEGREDO-INTERNO-DO-CARRINHO') &&
      !respostasErro.join('\n').includes('SEGREDO-INTERNO-DO-CARRINHO'),
    'falha interna não vaza mensagem secreta no log nem ao cliente'
  );

  const falhasDeSigilo = [];
  const conferirRegistro = (nome, atual, esperado, proibidos) => {
    if (JSON.stringify(atual?.dados) !== JSON.stringify(esperado)) {
      falhasDeSigilo.push(`${nome}: registra somente evt e code fixos`);
    }
    const valores = [
      atual?.mensagem,
      ...Object.values(atual?.dados || {}).map((valor) =>
        valor instanceof Error ? `${valor.message}\n${valor.stack}` : JSON.stringify(valor)
      ),
    ].join('\n');
    for (const proibido of proibidos) {
      if (valores.includes(proibido)) {
        falhasDeSigilo.push(`${nome}: não registra ${proibido}`);
      }
    }
  };

  const provaLogReal = spawnSync(process.execPath, [__filename], {
    encoding: 'utf8',
    env: {
      ...process.env,
      [FIX_ROUND_2_CHILD]: '1',
      LOG_LEVEL: 'info',
      LOG_FORMAT: 'json',
    },
  });
  checar(
    provaLogReal.status === 0,
    `subprocesso do logger real termina sem erro: ${provaLogReal.stderr}`
  );
  const linhasReais = provaLogReal.stdout
    .split('\n')
    .filter((linha) => linha.trim().startsWith('{'))
    .map((linha) => JSON.parse(linha));
  const imagemRecebida = linhasReais.find(
    (linha) => linha.evt === 'imagem' && linha.code === undefined
  );
  const falhaImagem = linhasReais.find(
    (linha) => linha.evt === 'imagem' && linha.code === 'processamento_falhou'
  );
  const linhaFalhaImagem = JSON.stringify(falhaImagem || {});
  checar(
    imagemRecebida?.phone === '15550000006',
    'routeImagem mantém telefone no log operacional de imagem recebida'
  );
  checar(
    falhaImagem && falhaImagem.phone === undefined,
    'logger real remove telefone do registro de falha do comprovante'
  );
  checar(
    !Object.prototype.hasOwnProperty.call(falhaImagem || {}, 'err') &&
      !Object.prototype.hasOwnProperty.call(falhaImagem || {}, 'stack') &&
      !/SEGREDO-COMPROVANTE-REAL|DADOS-DO-CLIENTE-REAL/.test(linhaFalhaImagem),
    'logger real não registra erro bruto nem dados externos do comprovante'
  );
  const respostasImagem = JSON.parse(
    provaLogReal.stdout
      .split('\n')
      .find((linha) => linha.startsWith(FIX_ROUND_2_RESULT))
      .slice(FIX_ROUND_2_RESULT.length)
  );
  checar(
    respostasImagem.length === 1 &&
      respostasImagem[0] === require(`${PROJECT}/src/i18n`).t('pt', 'error_generic'),
    'routeImagem preserva a resposta pública genérica'
  );

  const baileysPath = require.resolve('@whiskeysockets/baileys');
  const routerPath = require.resolve(`${PROJECT}/src/bot/router`);
  const indexPath = require.resolve(`${PROJECT}/src/bot/index`);
  const zelle = require(`${PROJECT}/src/services/zelle`);
  const baileysCacheOriginal = require.cache[baileysPath];
  const indexCacheOriginal = require.cache[indexPath];
  const routerExportsOriginal = require.cache[routerPath].exports;
  const regrasOriginal = zelle.regrasComprovante;
  const listeners = {};
  const enviadasPeloSocket = [];
  const registrosIndex = [];
  const fakeSock = {
    ev: { on: (evento, handler) => { listeners[evento] = handler; } },
    sendMessage: async (...args) => enviadasPeloSocket.push(args),
    updateMediaMessage: async () => {},
  };
  require.cache[baileysPath] = {
    id: baileysPath,
    filename: baileysPath,
    loaded: true,
    exports: {
      default: () => fakeSock,
      useMultiFileAuthState: async () => ({
        state: { creds: { registered: true } },
        saveCreds: async () => {},
      }),
      DisconnectReason: { loggedOut: 401, restartRequired: 515 },
      fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
      downloadMediaMessage: async () => Buffer.from('IMAGEM-EXTERNA'),
    },
  };
  require.cache[routerPath].exports = {
    ...routerExportsOriginal,
    route: async () => { throw new Error('SEGREDO-TEXTO-BAILEYS'); },
    routeImagem: async () => { throw new Error('SEGREDO-IMAGEM-BAILEYS'); },
  };
  zelle.regrasComprovante = () => ({ maxBytes: 1024 });
  log.error = (dados, mensagem) => registrosIndex.push({ dados, mensagem });
  delete require.cache[indexPath];
  try {
    const bot = require(indexPath);
    await bot.start();
    await listeners['messages.upsert']({
      type: 'notify',
      messages: [{
        key: { fromMe: false, remoteJid: '15550000007@s.whatsapp.net' },
        message: { imageMessage: { fileLength: 10, mimetype: 'image/jpeg' } },
      }],
    });
    await listeners['messages.upsert']({
      type: 'notify',
      messages: [{
        key: { fromMe: false, remoteJid: '15550000008@s.whatsapp.net' },
        message: { conversation: 'CONTEUDO-DO-CLIENTE' },
      }],
    });
  } finally {
    log.error = logErrorOriginal;
    zelle.regrasComprovante = regrasOriginal;
    require.cache[routerPath].exports = routerExportsOriginal;
    if (baileysCacheOriginal) require.cache[baileysPath] = baileysCacheOriginal;
    else delete require.cache[baileysPath];
    if (indexCacheOriginal) require.cache[indexPath] = indexCacheOriginal;
    else delete require.cache[indexPath];
  }
  conferirRegistro(
    'index imagem',
    registrosIndex[0],
    { evt: 'imagem', origem: 'baileys', code: 'recebimento_falhou' },
    ['SEGREDO-IMAGEM-BAILEYS', '15550000007', 'IMAGEM-EXTERNA']
  );
  conferirRegistro(
    'index texto',
    registrosIndex[1],
    { evt: 'msg', origem: 'baileys', code: 'roteamento_falhou' },
    ['SEGREDO-TEXTO-BAILEYS', '15550000008', 'CONTEUDO-DO-CLIENTE']
  );
  checar(enviadasPeloSocket.length === 0, 'falhas externas preservam ausência de resposta adicional');
  checar(
    falhasDeSigilo.length === 0,
    `fix round 1:\n- ${falhasDeSigilo.join('\n- ')}`
  );

  const baileysSource = fs.readFileSync(`${PROJECT}/src/bot/index.js`, 'utf8');
  checar(
    baileysSource.indexOf('msg.message?.orderMessage') >= 0 &&
      baileysSource.indexOf('msg.message?.orderMessage') < baileysSource.indexOf('msg.message?.imageMessage'),
    'pedido do catálogo é tratado antes de imagem e texto'
  );

  const metaSource = fs.readFileSync(`${PROJECT}/src/api/webhooks/meta.js`, 'utf8');
  checar(
    /routeOrder\(phone,\s*fromMeta\(message\),\s*send\)/.test(metaSource),
    'webhook Meta usa o mesmo contrato antes do roteador'
  );
  checar(
    !/log\.(?:warn|error)\(\s*\{[^}]*\berr\b/.test(metaSource),
    'webhook Meta não registra erro bruto em nenhum caminho'
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
