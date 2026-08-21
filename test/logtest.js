/**
 * O log é testado num processo separado — e por um motivo específico.
 *
 * O pino escreve direto no descritor 1, sem passar pelo `process.stdout.write`
 * que dá para substituir de dentro. Então a suíte roda a si mesma como filha,
 * com a saída capturada, e o pai lê as linhas JSON que saíram de verdade. É o
 * mesmo caminho que a Railway enxerga.
 */

const { spawnSync } = require('child_process');

const FILHO = 'LOGTEST_FILHO';

// ------------------------------------------------------------------ o filho

if (process.env[FILHO]) {
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
  process.env.SQUARE_ACCESS_TOKEN = 'faketoken';
  process.env.SQUARE_LOCATION_ID = 'FAKELOC';
  process.env.BASE_URL = 'https://fake.test';
  process.env.FOOD_TRUCK_NAME = 'Passarela Espetinho';

  const PROJECT = require('path').resolve(__dirname, '..');

  const schedulePath = require.resolve(`${PROJECT}/src/services/schedule`);
  require(schedulePath);
  require.cache[schedulePath].exports.isOpen = () => true;

  const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
  require(dbPath);
  let sequencia = 0;
  require.cache[dbPath].exports = {
    getCustomerByPhone: async () => null,
    getLastDeliveryOrder: async () => null,
    getActiveOrderByPhone: async () => null,
    upsertCustomer: async (c) => ({ id: 1, ...c }),
    createOrder: async (o) => ({ id: ++sequencia, ...o }),
    createPayment: async () => ({ id: 1 }),
  };

  const squarePath = require.resolve(`${PROJECT}/src/services/square`);
  require(squarePath);
  require.cache[squarePath].exports = {
    createPaymentLink: async () => ({ url: 'https://sq.link/X', squareOrderId: 'SO' }),
  };

  const log = require(`${PROJECT}/src/log`);
  const notify = require(`${PROJECT}/src/bot/notify`);
  const { route } = require(`${PROJECT}/src/bot/router`);

  notify.registerRich({ sendButtons: async () => {}, sendList: async () => [] });
  notify.register(async () => {});
  const enviar = async () => {};

  (async () => {
    const TEL = '15557770001';
    await route(TEL, 'Oi', enviar);
    await route(TEL, '1', enviar); // português
    await route(TEL, 'ot:pickup', enviar);
    await route(TEL, 'E', enviar); // Espetinhos
    await route(TEL, '1', enviar);
    await route(TEL, 'finalizar', enviar);
    await route(TEL, 'Fernando Perin', enviar);
    await route(TEL, 'sim', enviar);

    log.base.flush();
  })().catch((e) => {
    process.stderr.write(String(e.stack));
    process.exit(1);
  });

  return;
}

// -------------------------------------------------------------------- o pai

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const titulo = (n) => console.log(`\n\x1b[33m### ${n} ###\x1b[0m`);

/** Roda a conversa numa cópia isolada e devolve as linhas de log já parseadas. */
function conversar(extra = {}) {
  const r = spawnSync(process.execPath, [__filename], {
    encoding: 'utf8',
    env: {
      ...process.env,
      [FILHO]: '1',
      LOG_LEVEL: 'info',
      LOG_FORMAT: 'json',
      ...extra,
    },
  });

  if (r.status !== 0) {
    throw new Error(`a conversa de teste falhou:\n${r.stderr}`);
  }

  return r.stdout
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l));
}

try {
  titulo('CONTEXTO EM TODA LINHA');

  const linhas = conversar();
  checar(linhas.length > 0, `a conversa produziu ${linhas.length} linhas de log`);

  const semTelefone = linhas.filter((l) => !l.phone);
  checar(
    semTelefone.length === 0,
    'toda linha nascida no atendimento leva o telefone — nenhuma órfã'
  );

  const recebidas = linhas.filter((l) => l.evt === 'msg');
  checar(recebidas.length === 8, 'as 8 mensagens do cliente foram registradas');
  checar(
    recebidas.some((l) => l.texto === 'Fernando Perin'),
    'o texto do cliente aparece — é o que reconstrói o relato depois'
  );

  titulo('TRANSICOES DE ESTADO');

  const estados = linhas.filter((l) => l.evt === 'estado');
  checar(estados.length >= 5, `${estados.length} transições registradas`);
  checar(
    estados.every((l) => l.de && l.para && l.de !== l.para),
    'cada transição diz de onde veio e para onde foi'
  );

  const trilha = estados.map((l) => l.para);
  checar(
    trilha.includes('MENU') && trilha.includes('CONFIRM') && trilha.includes('PAYMENT_PENDING'),
    `a conversa inteira sai lida na sequência: ${trilha.join(' → ')}`
  );

  titulo('NUMERO DO PEDIDO A PARTIR DO FECHAMENTO');

  const criado = linhas.find((l) => l.evt === 'pedido');
  checar(criado?.pedido === 1, 'o pedido criado sai identificado');
  checar(criado.total > 0 && criado.itens === 1, 'com total e quantidade de itens');

  const depois = linhas.slice(linhas.indexOf(criado) + 1);
  checar(
    depois.length > 0 && depois.every((l) => l.pedido === 1),
    'e daí em diante toda linha da conversa carrega o número do pedido'
  );

  titulo('LOG_TEXTO=off');

  const discretas = conversar({ LOG_TEXTO: 'off' });
  checar(
    discretas.some((l) => l.evt === 'msg'),
    'as mensagens continuam registradas'
  );
  checar(
    discretas.every((l) => l.texto === undefined),
    'mas sem o conteúdo — endereço do cliente fora do log'
  );

  console.log('\n\x1b[32mTodos os cenarios passaram.\x1b[0m');
} catch (e) {
  console.error('\n\x1b[31mFALHOU:\x1b[0m', e.message);
  process.exit(1);
}
