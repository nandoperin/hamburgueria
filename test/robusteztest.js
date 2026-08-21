process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.SQUARE_ACCESS_TOKEN = 'faketoken';
process.env.SQUARE_LOCATION_ID = 'FAKELOC';
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
  // ==================================== combos: cenario que nao existe mais
  //
  // O projeto irmao tinha "Combo 1 (1 carne)" e "Combo 2 (2 carnes)", que
  // abriam uma lista de escolha por unidade. A Point Burger nao tem combos: a
  // personalizacao virou remover/acrescentar INGREDIENTE, que e outra logica
  // (services/modifiers.js) e outro caminho.
  //
  // Os blocos que provavam a fila de combos sairam daqui em vez de serem
  // adaptados, porque nenhum item do menu.json tem `options.picks` — eles
  // testariam codigo que nada mais alcanca.
  //
  // O QUE FICOU DESCOBERTO: nao existe handler deterministico de ingredientes.
  // Com AI_ENABLED=off o cliente pede o sanduiche, mas nao consegue tirar a
  // cebola. Quem cobre isso hoje e src/ai/tools.js. Ver HANDOFF.md.

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
