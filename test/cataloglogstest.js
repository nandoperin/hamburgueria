process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const CHILD_MODE = process.env.CATALOG_LOG_CHILD;

async function childRouteOrder() {
  const schedulePath = require.resolve(`${PROJECT}/src/services/schedule`);
  require(schedulePath);
  require.cache[schedulePath].exports.isOpen = () => true;

  const catalogorder = require(`${PROJECT}/src/bot/handlers/catalogorder`);
  catalogorder.handleCartOrder = async () => {
    throw new Error('ERRO-SEGREDO-ROUTE-ORDER token=TOKEN-ROUTE');
  };

  const { routeOrder } = require(`${PROJECT}/src/bot/router`);
  await routeOrder('15550000101', {
    source: 'meta',
    externalOrderId: 'route-order-secreto',
    token: 'TOKEN-ROUTE',
    payload: 'PAYLOAD-ROUTE',
    cliente: 'CLIENTE-ROUTE',
    items: [{ productId: 'x_bacon', quantity: 1, externalProductId: 'externo-secreto' }],
  }, async () => {});
}

async function childAgent() {
  process.env.AI_ENABLED = 'on';
  process.env.AI_MAX_USD_DIA = '0';
  process.env.AI_MAX_TOKENS_CONVERSA = '0';

  const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
  require(dbPath);
  require.cache[dbPath].exports = { registrarUsoIA: async () => null };

  const providerPath = require.resolve(`${PROJECT}/src/ai/provider`);
  require(providerPath);
  require.cache[providerPath].exports = {
    habilitada: () => true,
    getModelo: () => 'modelo-teste',
    get: () => ({
      conversar: async () => {
        throw new Error('ERRO-SEGREDO-AGENTE token=TOKEN-AGENTE payload=PAYLOAD-AGENTE');
      },
    }),
  };

  delete require.cache[require.resolve(`${PROJECT}/src/ai/agente`)];
  const agente = require(`${PROJECT}/src/ai/agente`);
  const session = require(`${PROJECT}/src/bot/session`);
  const log = require(`${PROJECT}/src/log`);
  const sess = session.get('15550000102');
  Object.assign(sess, {
    lang: 'pt',
    state: 'ORDER',
    cart: [{ id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 }],
  });

  await log.contexto(
    { phone: '15550000102', cliente: 'CLIENTE-AGENTE', payload: 'PAYLOAD-CONTEXTO' },
    async () => agente.conversar(sess, 'CONTEUDO-CLIENTE-AGENTE', async () => {})
  );
  await log.contexto(
    { phone: '15550000102', cliente: 'CLIENTE-AGENTE', payload: 'PAYLOAD-CONTEXTO' },
    async () => agente.saudar(sess, async () => {})
  );
}

async function childBaileys() {
  const baileysPath = require.resolve('@whiskeysockets/baileys');
  const routerPath = require.resolve(`${PROJECT}/src/bot/router`);
  const zelle = require(`${PROJECT}/src/services/zelle`);
  const listeners = {};
  const fakeSock = {
    ev: { on: (evento, handler) => { listeners[evento] = handler; } },
    sendMessage: async () => {},
    updateMediaMessage: async () => {},
    getOrderDetails: async () => ({
      products: [{ id: 'produto-externo', name: 'CLIENTE-SEGREDO-BAILEYS', quantity: 1 }],
    }),
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
      downloadMediaMessage: async () => Buffer.from('CONTEUDO-IMAGEM-BAILEYS'),
    },
  };

  require(routerPath);
  require.cache[routerPath].exports = {
    ...require.cache[routerPath].exports,
    route: async () => { throw new Error('ERRO-SEGREDO-TEXTO-BAILEYS'); },
    routeImagem: async () => { throw new Error('ERRO-SEGREDO-IMAGEM-BAILEYS'); },
  };
  zelle.regrasComprovante = () => ({ maxBytes: 1024 });

  const bot = require(`${PROJECT}/src/bot/index`);
  await bot.start();
  await listeners['messages.upsert']({
    type: 'notify',
    messages: [{
      key: { fromMe: false, remoteJid: '15550000103@s.whatsapp.net' },
      message: {
        orderMessage: {
          orderId: 'ORDER-SEGREDO-BAILEYS',
          token: Buffer.from('TOKEN-SEGREDO-BAILEYS'),
        },
      },
    }],
  });
  await listeners['messages.upsert']({
    type: 'notify',
    messages: [{
      key: { fromMe: false, remoteJid: '15550000104@s.whatsapp.net' },
      message: { imageMessage: { fileLength: 10, mimetype: 'image/jpeg' } },
    }],
  });
  await listeners['messages.upsert']({
    type: 'notify',
    messages: [{
      key: { fromMe: false, remoteJid: '15550000105@s.whatsapp.net' },
      message: { conversation: 'CONTEUDO-CLIENTE-BAILEYS' },
    }],
  });
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/meta/webhook',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function childMeta() {
  const routerPath = require.resolve(`${PROJECT}/src/bot/router`);
  require(routerPath);
  require.cache[routerPath].exports = {
    ...require.cache[routerPath].exports,
    routeOrder: async () => { throw new Error('ERRO-SEGREDO-ORDER-META'); },
    route: async () => { throw new Error('ERRO-SEGREDO-TEXTO-META'); },
  };

  const meta = require(`${PROJECT}/src/bot/meta`);
  meta.sendMessage = async () => {};
  meta.markAsRead = async () => {};

  const express = require('express');
  const app = express();
  app.use(require(`${PROJECT}/src/api/webhooks/meta`));
  const server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  const port = server.address().port;
  try {
    await post(port, '{"PAYLOAD-SEGREDO-META"');
    await post(port, JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { messages: [{
        id: 'META-ORDER-1',
        from: '15550000106',
        type: 'order',
        order: { product_items: [{ product_retailer_id: 'x_bacon', quantity: 1 }] },
      }] } }] }],
    }));
    await post(port, JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { messages: [{
        id: 'META-TEXTO-1',
        from: '15550000107',
        type: 'text',
        text: { body: 'CONTEUDO-CLIENTE-META' },
      }] } }] }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const children = {
  route: childRouteOrder,
  agent: childAgent,
  baileys: childBaileys,
  meta: childMeta,
};

function jsonLines(output) {
  return String(output || '')
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line));
}

function assertSafeLine(line, expected) {
  assert(line, `linha ausente: ${JSON.stringify(expected)}`);
  const safe = { ...line };
  delete safe.level;
  delete safe.time;
  delete safe.msg;
  assert.deepStrictEqual(safe, expected);
  for (const key of ['phone', 'err', 'stack', 'token', 'payload', 'content', 'conteudo', 'cliente', 'products']) {
    assert(!Object.prototype.hasOwnProperty.call(line, key), `campo proibido ${key}`);
  }
  assert(!/SEGREDO|TOKEN-|PAYLOAD-|CLIENTE-|1555000010|CONTEUDO-CLIENTE/.test(JSON.stringify(line)));
}

async function parent() {
  const resultados = {};
  for (const mode of Object.keys(children)) {
    const run = spawnSync(process.execPath, [__filename], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CATALOG_LOG_CHILD: mode,
        LOG_LEVEL: 'info',
        LOG_FORMAT: 'json',
        LOG_TEXTO: 'off',
        NODE_ENV: 'test',
      },
    });
    assert.strictEqual(run.status, 0, `${mode}: ${run.stderr || run.stdout}`);
    resultados[mode] = jsonLines(run.stdout);
  }

  assertSafeLine(
    resultados.route.find((line) => line.code === 'carrinho_falhou'),
    { evt: 'carrinho', origem: 'meta', code: 'carrinho_falhou', itens: 1 }
  );
  assertSafeLine(
    resultados.agent.find((line) => line.code === 'conversa_falhou'),
    { evt: 'ia', origem: 'agente', code: 'conversa_falhou' }
  );
  assertSafeLine(
    resultados.agent.find((line) => line.code === 'saudacao_falhou'),
    { evt: 'ia', origem: 'agente', code: 'saudacao_falhou' }
  );
  assertSafeLine(
    resultados.baileys.find((line) => line.code === 'produto_desconhecido'),
    { evt: 'carrinho', origem: 'baileys', code: 'produto_desconhecido', itens: 1 }
  );
  assertSafeLine(
    resultados.baileys.find((line) => line.code === 'recebimento_falhou'),
    { evt: 'imagem', origem: 'baileys', code: 'recebimento_falhou' }
  );
  assertSafeLine(
    resultados.baileys.find((line) => line.code === 'roteamento_falhou'),
    { evt: 'msg', origem: 'baileys', code: 'roteamento_falhou' }
  );
  assertSafeLine(
    resultados.meta.find((line) => line.code === 'payload_invalido'),
    { evt: 'webhook', origem: 'meta', code: 'payload_invalido' }
  );
  assertSafeLine(
    resultados.meta.find((line) => line.code === 'leitura_falhou'),
    { evt: 'carrinho', origem: 'meta', code: 'leitura_falhou', itens: 1 }
  );
  assertSafeLine(
    resultados.meta.find((line) => line.code === 'mensagem_falhou'),
    { evt: 'msg', origem: 'meta', code: 'mensagem_falhou' }
  );

  console.log('Logs JSON reais dos catches de catálogo passaram.');
}

if (CHILD_MODE) {
  children[CHILD_MODE]()
    .then(() => require(`${PROJECT}/src/log`).base.flush())
    .catch((err) => {
      process.stderr.write(String(err.stack || err));
      process.exit(1);
    });
} else {
  parent().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
