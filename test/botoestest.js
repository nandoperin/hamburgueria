process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.SQUARE_ACCESS_TOKEN = 'faketoken';
process.env.SQUARE_LOCATION_ID = 'FAKELOC';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';

const PROJECT = require('path').resolve(__dirname, '..');

// A entrega esta desligada em producao (fase de testes, so retirada). Esta
// suite prova o caminho dela, entao liga as cidades de proposito.
require('./comentrega').ligar();


const schedulePath = require.resolve(`${PROJECT}/src/services/schedule`);
require(schedulePath);
require.cache[schedulePath].exports.isOpen = () => true;

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getCustomerByPhone: async () => null,
  getLastDeliveryOrder: async () => null,
  upsertCustomer: async (c) => ({ id: 1, ...c }),
  getActiveOrderByPhone: async () => null,
};

const notify = require(`${PROJECT}/src/bot/notify`);
const { route } = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);
const delivery = require(`${PROJECT}/src/services/delivery`);

let capturado = [];

function ligarBotoes() {
  notify.registerRich({
    sendButtons: async (phone, opts) => {
      capturado.push({ tipo: 'botoes', ...opts });
      const rotulos = opts.buttons.map((b) => `[ ${b.title} ]`).join('  ');
      console.log(`   \x1b[35m${opts.body}\x1b[0m`);
      console.log(`   \x1b[32m${rotulos}\x1b[0m`);
    },
    sendList: async (phone, opts) => {
      capturado.push({ tipo: 'lista', ...opts });
      console.log(`   \x1b[35m${opts.body}\x1b[0m`);
      opts.sections[0].rows.forEach((r) =>
        console.log(`   \x1b[36m• ${r.title} — ${r.description}\x1b[0m`)
      );
    },
  });
}

function desligarBotoes() {
  notify.registerRich(null);
}

notify.register(async (phone, texto) => {
  capturado.push({ tipo: 'texto', texto });
  console.log(`   ${texto.replace(/\n/g, '\n   ')}`);
});

async function run(phone, script) {
  for (const input of script) {
    console.log(`\n\x1b[36m> ${input.replace(/\n/g, ' | ')}\x1b[0m`);
    await route(phone, input, async (r) => {
      capturado.push({ tipo: 'texto', texto: r });
      console.log(`   ${r.replace(/\n/g, '\n   ')}`);
    });
  }
}

function ultimo(tipo) {
  return [...capturado].reverse().find((c) => c.tipo === tipo);
}

function checar(condicao, msg) {
  if (!condicao) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  // ---------------------------------------------- 1. entrega, por botao
  console.log('\n\x1b[33m########## 1. ENTREGA (botoes) ##########\x1b[0m');
  ligarBotoes();
  capturado = [];
  session.reset('15551111111');
  await run('15551111111', ['Oi']);

  const tela1 = ultimo('botoes');
  checar(tela1?.buttons.length === 2, 'tela 1 tem exatamente 2 botoes');
  checar(
    tela1.buttons.map((b) => b.id).join(',') === 'ot:delivery,ot:pickup',
    'ids da tela 1 sao estaveis (ot:delivery, ot:pickup)'
  );

  capturado = [];
  await run('15551111111', ['ot:delivery']);

  // A QUARTA CIDADE.
  //
  // O WhatsApp aceita no maximo 3 botoes por mensagem, e `sendButtons` corta o
  // excedente **em silencio**. A Point Burger tem quatro cidades, entao a tela
  // 2 precisa virar lista tocavel — senao Medford sumiria do bot sem erro
  // nenhum, e ninguem descobriria ate um cliente reclamar.
  //
  // Esta assercao existe para travar exatamente isso: se alguem trocar a lista
  // por botoes de novo, a quarta cidade cai aqui e nao no papel.
  const cidades = require('../src/services/delivery').getCities();
  checar(cidades.length === 4, `sao ${cidades.length} cidades ativas`);
  checar(ultimo('botoes') === null || ultimo('lista') !== null,
    'com mais de 3 cidades a tela 2 e lista, nao botao');

  const tela2 = ultimo('lista');
  const linhas = tela2.sections.flatMap((sec) => sec.rows);
  checar(
    linhas.length === cidades.length,
    `a lista traz TODAS as ${cidades.length} cidades — nenhuma cortada em silencio`
  );
  checar(
    linhas.some((r) => r.id === 'city:medford'),
    'inclusive a quarta, que nao caberia em botao'
  );
  checar(
    linhas.some((r) => `${r.title} ${r.description || ''}`.includes('$7.00')),
    'a taxa aparece na linha da lista'
  );

  capturado = [];
  await run('15551111111', ['city:chelsea']);
  checar(
    session.get('15551111111').city?.id === 'chelsea',
    'clicar no botao seleciona Chelsea'
  );
  checar(
    session.get('15551111111').state === 'MENU',
    'avanca direto para o cardapio (endereco so no checkout)'
  );

  // ---------------------------------------------- 2. retirada pula cidades
  console.log('\n\x1b[33m########## 2. RETIRADA (pula tela 2) ##########\x1b[0m');
  capturado = [];
  session.reset('15552222222');
  await run('15552222222', ['Oi', 'ot:pickup']);
  checar(
    session.get('15552222222').orderType === 'pickup',
    'retirada selecionada'
  );
  checar(
    session.get('15552222222').state !== 'DELIVERY_CITY',
    'nao passa pela tela de cidades'
  );

  // ---------------------------------------------- 3. fallback em texto
  console.log('\n\x1b[33m########## 3. FALLBACK EM TEXTO (Baileys) ##########\x1b[0m');
  desligarBotoes();
  capturado = [];
  session.reset('15553333333');
  await run('15553333333', ['Oi']);
  checar(
    ultimo('texto').texto.includes('1.') && ultimo('texto').texto.includes('2.'),
    'sem botoes, cai para lista numerada'
  );

  capturado = [];
  await run('15553333333', ['1']);
  checar(
    ultimo('texto').texto.includes('3.'),
    'digitar 1 (entrega) abre as 3 cidades numeradas'
  );

  capturado = [];
  await run('15553333333', ['2']);
  checar(
    session.get('15553333333').city?.id === 'chelsea',
    'digitar 2 escolhe a segunda cidade (Chelsea)'
  );

  // ---------------------------------------------- 4. entrada invalida
  console.log('\n\x1b[33m########## 4. ENTRADA INVALIDA ##########\x1b[0m');
  ligarBotoes();
  capturado = [];
  session.reset('15554444444');
  await run('15554444444', ['Oi', 'blablabla']);
  checar(
    session.get('15554444444').state === 'ORDER_TYPE',
    'texto sem sentido nao avanca o estado'
  );

  // ---------------------------------------------- 5. mais de 3 cidades
  console.log('\n\x1b[33m########## 5. CIDADE NOVA NAO SOME ##########\x1b[0m');
  const originais = delivery.getCities();
  delivery.getCities = () => [
    ...originais,
    { id: 'revere', label: 'Revere', delivery_fee: 8.0, active: true },
  ];

  capturado = [];
  session.reset('15555555555');
  await run('15555555555', ['Oi', 'ot:delivery']);

  const quarta = ultimo('lista');
  checar(!!quarta, 'com uma cidade nova segue como lista tocavel');
  checar(
    quarta.sections[0].rows.length === originais.length + 1,
    `as ${originais.length + 1} cidades aparecem — nenhuma cortada em silencio`
  );

  capturado = [];
  await run('15555555555', ['city:revere']);
  checar(
    session.get('15555555555').city?.id === 'revere',
    'e a cidade recem-aberta e selecionavel'
  );

  delivery.getCities = () => originais;
  console.log('\n\x1b[32mTodos os cenarios passaram.\x1b[0m');
})().catch((e) => {
  console.error('\n\x1b[31mFALHOU:\x1b[0m', e.message);
  process.exit(1);
});
