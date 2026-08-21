process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.SQUARE_ACCESS_TOKEN = 'faketoken';
process.env.SQUARE_LOCATION_ID = 'FAKELOC';
process.env.BASE_URL = 'https://fake.test';
process.env.FOOD_TRUCK_NAME = 'Passarela Espetinho';
process.env.SUPPORT_PHONE = '18573124606';

const PROJECT = require('path').resolve(__dirname, '..');

// A entrega esta desligada em producao (fase de testes, so retirada). Esta
// suite prova o caminho dela, entao liga as cidades de proposito.
require('./comentrega').ligar();


const schedulePath = require.resolve(`${PROJECT}/src/services/schedule`);
require(schedulePath);
require.cache[schedulePath].exports.isOpen = () => true;

let cliente = null;
let ultimoPedido = null;
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getCustomerByPhone: async () => cliente,
  getLastDeliveryOrder: async () => ultimoPedido,
  getActiveOrderByPhone: async () => null,
  upsertCustomer: async (c) => ({ id: 1, ...c }),
  createOrder: async (o) => ({ id: 90, ...o }),
  createPayment: async () => ({ id: 1 }),
};

const squarePath = require.resolve(`${PROJECT}/src/services/square`);
require(squarePath);
require.cache[squarePath].exports = {
  createPaymentLink: async () => ({ url: 'https://sq.link/X', squareOrderId: 'SO' }),
};

const notify = require(`${PROJECT}/src/bot/notify`);
const { route } = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);

let passos = [];

notify.registerRich({
  sendButtons: async (p, o) => {
    passos.push({ tipo: 'botoes', texto: o.body, opcoes: o.buttons.map((b) => b.title) });
    console.log(`   \x1b[35m${o.body.split('\n')[0]}\x1b[0m`);
    console.log('   ' + o.buttons.map((b) => `[ ${b.title} ]`).join('  '));
  },
  sendList: async (p, o) => {
    passos.push({ tipo: 'lista', texto: o.body });
    console.log(`   \x1b[36m${o.body.split('\n')[0]} (lista)\x1b[0m`);
  },
  sendProductList: async (p, o) => {
    passos.push({ tipo: 'catalogo', texto: o.body });
    console.log(`   \x1b[36m[CATALOGO] ${o.sections.map((s) => s.title).join(' | ')}\x1b[0m`);
  },
});

const enviar = async (texto) => {
  passos.push({ tipo: 'texto', texto });
  console.log(`   ${texto.split('\n')[0]}`);
};
notify.register(async (p, t) => enviar(t));

async function run(phone, script) {
  for (const input of script) {
    console.log(`\n\x1b[36m> ${input.replace(/\n/g, ' | ')}\x1b[0m`);
    await route(phone, input, enviar);
  }
}

const digitou = () => passos.filter((p) => p.tipo === 'texto' && /nome|endere/i.test(p.texto));

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  // ---------------------------------------- cliente novo, entrega
  console.log('\n\x1b[33m######## CLIENTE NOVO ########\x1b[0m');
  cliente = null; ultimoPedido = null;
  session.clear('15551111111');
  passos = [];

  await run('15551111111', ['Oi', '1']);
  checar(
    passos.filter((p) => p.tipo === 'botoes').length === 2,
    'idioma e entrega/retirada: dois toques, nenhuma digitacao'
  );
  checar(!digitou().length, 'nao pede nome nem endereco antes do cardapio');

  passos = [];
  await run('15551111111', ['ot:delivery', 'city:everett']);
  checar(
    passos.some((p) => p.tipo === 'lista' || p.tipo === 'catalogo' || /Card/i.test(p.texto || '')),
    'escolher a cidade leva direto ao cardapio'
  );
  checar(!digitou().length, 'ainda sem pedir endereco');
  checar(session.get('15551111111').state === 'MENU', 'estado MENU');

  // monta carrinho
  passos = [];
  await run('15551111111', ['1', '1']);
  checar(session.get('15551111111').cart.length > 0, 'carrinho montado');

  // agora sim: checkout cobra o que falta
  passos = [];
  await run('15551111111', ['finalizar']);
  checar(
    passos.some((p) => /endere/i.test(p.texto || '')),
    'so no checkout pede o endereco'
  );

  passos = [];
  await run('15551111111', ['Rua Teste, 123']);
  checar(
    passos.some((p) => /nome/i.test(p.texto || '')),
    'depois do endereco pede o nome'
  );

  passos = [];
  await run('15551111111', ['Fernando Perin']);
  checar(
    passos.some((p) => p.tipo === 'botoes' && p.opcoes.some((o) => /finalizar/i.test(o))),
    'com tudo preenchido, chega ao resumo com Sim/Nao'
  );

  passos = [];
  await run('15551111111', ['sim']);
  checar(
    passos.some((p) => /sq\.link|pagar|Pedido #/i.test(p.texto || '')),
    'confirma e gera o link de pagamento'
  );

  // ---------------------------------------- retirada nao pede endereco
  console.log('\n\x1b[33m######## RETIRADA ########\x1b[0m');
  session.clear('15552222222');
  passos = [];
  await run('15552222222', ['Oi', '1', 'ot:pickup', '1', '1', 'finalizar']);
  checar(
    !passos.some((p) => /endere/i.test(p.texto || '')),
    'retirada nunca pede endereco'
  );
  checar(
    passos.some((p) => /nome/i.test(p.texto || '')),
    'mas pede o nome no checkout'
  );

  // ---------------------------------------- recorrente pula tudo
  console.log('\n\x1b[33m######## CLIENTE RECORRENTE ########\x1b[0m');
  cliente = { id: 7, name: 'Fernando Perin', email: 'f@x.com', lang: 'pt' };
  ultimoPedido = { address: 'Rua Antiga, 9', city: 'Everett' };
  session.clear('15553333333');
  passos = [];
  await run('15553333333', ['Oi']);
  checar(
    passos.some((p) => /Que bom te ver/i.test(p.texto || '')),
    'reconhece o cliente'
  );
  checar(!digitou().length, 'nao repete cadastro');

  passos = [];
  await run('15553333333', ['ot:delivery', 'city:everett', '1', '1', 'finalizar']);
  checar(
    passos.some((p) => /Rua Antiga/.test(p.texto || '')),
    'reaproveita o endereco anterior, avisando no checkout'
  );
  checar(
    passos.some((p) => p.tipo === 'botoes' && p.opcoes.some((o) => /finalizar/i.test(o))),
    'vai direto ao resumo, sem redigitar nada'
  );

  console.log('\n\x1b[32mTodos os cenarios passaram.\x1b[0m');
})().catch((e) => {
  console.error('\n\x1b[31mFALHOU:\x1b[0m', e.message);
  process.exit(1);
});
