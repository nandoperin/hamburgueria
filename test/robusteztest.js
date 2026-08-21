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
require.cache[dbPath].exports = {
  getCustomerByPhone: async () => null,
  getLastDeliveryOrder: async () => null,
  getActiveOrderByPhone: async () => null,
  upsertCustomer: async (c) => ({ id: 1, ...c }),
};

const notify = require(`${PROJECT}/src/bot/notify`);
const { route } = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const titulo = (n) => console.log(`\n\x1b[33m### ${n} ###\x1b[0m`);

(async () => {
  // ============================================================ combos em fila
  titulo('DOIS COMBOS NA MESMA SELECAO');

  notify.registerRich({
    sendButtons: async () => {},
    sendList: async () => [],
  });
  notify.register(async () => {});

  const TEL = '15559990001';
  session.clear(TEL);
  const enviar = async () => {};

  await route(TEL, 'Oi', enviar);
  await route(TEL, '1', enviar); // português
  await route(TEL, 'ot:pickup', enviar);
  await route(TEL, 'R', enviar); // categoria Refeições

  // Combo 1 (1 carne) e Combo 2 (2 carnes) numa tacada só.
  await route(TEL, '1 2', enviar);

  const s = session.get(TEL);
  checar(s.state === 'CHOOSING_OPTIONS', 'abre a escolha de carnes do primeiro combo');
  checar(
    (s.pendingItemQueue || []).length === 1,
    'o segundo combo fica na fila, em vez de sumir'
  );

  await route(TEL, '1', enviar); // carne do Combo 1
  checar(s.cart.length === 1, 'Combo 1 entrou no carrinho');
  checar(
    s.state === 'CHOOSING_OPTIONS',
    'e o segundo combo abre sozinho, sem o cliente pedir'
  );

  await route(TEL, '1 2', enviar); // as duas carnes do Combo 2

  checar(s.cart.length === 2, 'os DOIS combos entraram — nenhum foi descartado');
  checar((s.pendingItemQueue || []).length === 0, 'fila esvaziada ao final');
  console.log('   carrinho: ' + s.cart.map((i) => i.name).join(' | '));

  // ======================================================== retry no envio
  titulo('RETRY NO ENVIO DE MENSAGEM');

  const erroRede = () => new Error('socket hang up');
  const erro500 = () => Object.assign(new Error('Meta API 500'), { status: 500 });
  const erro400 = () => Object.assign(new Error('Meta API 400'), { status: 400 });

  async function comFalhas(falhas, fabricaErro) {
    let chamadas = 0;
    notify.register(async () => {
      chamadas += 1;
      if (chamadas <= falhas) throw fabricaErro();
    });
    const ok = await notify.send('1555', 'oi');
    return { ok, chamadas };
  }

  const rede = await comFalhas(1, erroRede);
  checar(rede.ok && rede.chamadas === 2, 'falha de rede: repete e entrega na 2a');

  const servidor = await comFalhas(2, erro500);
  checar(servidor.ok && servidor.chamadas === 3, 'erro 500: repete ate a 3a e entrega');

  const recusa = await comFalhas(1, erro400);
  checar(
    !recusa.ok && recusa.chamadas === 1,
    'erro 400 nao repete — a requisicao seria recusada igual'
  );

  const insistente = await comFalhas(99, erro500);
  checar(
    !insistente.ok && insistente.chamadas === 3,
    'desiste apos 3 tentativas, sem laco infinito'
  );

  console.log('\n\x1b[32mTodos os cenarios passaram.\x1b[0m');
})().catch((e) => {
  console.error('\n\x1b[31mFALHOU:\x1b[0m', e.message);
  process.exit(1);
});
