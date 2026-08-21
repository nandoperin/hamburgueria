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
  createOrder: async (o) => ({ id: 99, ...o }),
  createPayment: async () => ({ id: 1 }),
};

const zellePath = require.resolve(`${PROJECT}/src/services/zelle`);
require(zellePath);
require.cache[zellePath].exports = {
  // Config de verdade fica em config/pagamento.json, que vem com PREENCHER —
  // e `order.js` se recusa a fechar pedido com ela pela metade, de proposito.
  // Aqui a trocamos por uma valida, para exercitar o fluxo e nao a config.
  conferir: () => ({ ok: true, faltando: [] }),
  configurado: () => true,
  destinatario: () => ({ nome: 'Point Burger', email: 'pay@pointburger.test', telefone: '' }),
  instrucoes: (order) =>
    `Pedido #${order.id} registrado! Total: $${Number(order.total).toFixed(2)}. ` +
    `Envie por Zelle e mande o print do comprovante.`,
  regrasComprovante: () => ({
    exigir: true,
    maxBytes: 5 * 1024 * 1024,
    mimetypes: ['image/jpeg', 'image/png', 'image/webp'],
    bucket: 'comprovantes',
  }),
  prazos: () => ({ lembrete: 10, expira: 30 }),
  estornoAutomatico: () => false,
  estornar: async () => ({ estornou: false, manual: false }),
};

const notify = require(`${PROJECT}/src/bot/notify`);
const { route } = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);

const TEL = '15551111111';
let saidas = [];

notify.registerRich({
  sendButtons: async (phone, o) => {
    saidas.push({ tipo: 'botoes', texto: o.body, botoes: o.buttons.map((b) => b.title) });
    console.log(`   \x1b[35m${o.body.split('\n')[0]}\x1b[0m`);
    console.log('   ' + o.buttons.map((b) => `[ ${b.title} ]`).join('  '));
  },
  sendList: async (phone, o) => {
    saidas.push({ tipo: 'lista', texto: o.body });
    console.log(`   \x1b[36m${o.body.split('\n')[0]} (lista)\x1b[0m`);
  },
  sendImage: async (phone, o) => {
    saidas.push({ tipo: 'imagem', texto: o.link });
    console.log(`   \x1b[31m[IMAGEM] ${o.link}\x1b[0m`);
  },
  sendCatalog: async () => { throw new Error('catalogo indisponivel'); },
});

const enviar = async (texto) => {
  saidas.push({ tipo: 'texto', texto });
  console.log(`   ${texto.split('\n')[0]}`);
};
notify.register(async (phone, texto) => enviar(texto));

async function run(script) {
  for (const input of script) {
    console.log(`\n\x1b[36m> ${input.replace(/\n/g, ' | ')}\x1b[0m`);
    await route(TEL, input, enviar);
  }
}

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const tudo = () => saidas.map((s) => s.texto).join('\n');
const titulo = (n) => console.log(`\n\x1b[33m######### ${n} #########\x1b[0m`);

(async () => {
  // ------------------------------------------------------- 1. saudacao enxuta
  titulo('1. SAUDACAO');
  saidas = [];
  session.clear(TEL);
  await run(['Oi']);

  checar(!saidas.some((s) => s.tipo === 'imagem'), 'nao manda a logo (economiza mensagem)');
  checar(saidas.length === 1, 'a saudacao gasta uma unica mensagem');
  // A tela anterior a escolha vai em portugues: a clientela e brasileira. Quem
  // nao le portugues acha a saida na propria mensagem, que pergunta o idioma
  // nas tres linguas.
  checar(/Bem-vindo ao/.test(tudo()), 'primeira mensagem em portugues');
  checar(
    /Choose your language/.test(tudo()) && /Elige tu idioma/.test(tudo()),
    'mas a pergunta de idioma sai nas tres, para ninguem ficar preso'
  );
  // A primeira mensagem ja responde "voces entregam aqui?" — a pergunta que
  // arruina a experiencia se vier tarde. As cidades saem do delivery.json, e
  // por isso a assercao confere uma delas, nao um texto fixo: a versao anterior
  // travava a frase "fase de testes, so retirada" do projeto irmao, e ela
  // continuou passando por meses depois de a entrega ser ligada.
  checar(
    /Entregamos em/i.test(tudo()) && /Everett/.test(tudo()),
    'e ja lista as cidades de entrega, com a taxa'
  );

  // ------------------------------------------------ 2. idioma nao confirma
  titulo('2. IDIOMA');
  saidas = [];
  await run(['1']);
  checar(!/Ótimo|Atendimento em/.test(tudo()), 'nao confirma o idioma escolhido');
  checar(
    saidas.length === 1 && saidas[0].tipo === 'botoes',
    'vai direto para entrega/retirada, numa mensagem so'
  );
  checar(!/nome|endere/i.test(tudo()), 'nenhuma digitacao antes do cardapio');

  // ------------------------------------------- 3. cardapio antes do cadastro
  titulo('3. CARDAPIO PRIMEIRO');
  saidas = [];
  await run(['ot:pickup']);
  checar(session.get(TEL).state === 'MENU', 'retirada leva direto ao cardapio');
  checar(!/nome/i.test(tudo()), 'cadastro ainda nao foi pedido');

  // --------------------------------------------- 4. carrinho sem a linha morta
  titulo('4. CARRINHO');
  saidas = [];
  await run(['1', '1']);
  checar(
    !/outro \*número\*|Digite outro/.test(tudo()),
    'sumiu o "digite outro numero para adicionar"'
  );
  checar(/Carrinho/.test(tudo()), 'o carrinho continua aparecendo');

  // ------------------------------------------- 5. checkout cobra o cadastro
  titulo('5. CHECKOUT PEDE O CADASTRO');
  saidas = [];
  await run(['finalizar']);
  checar(/nome/i.test(tudo()), 'so agora pede o nome');

  saidas = [];
  await run(['Fernando Perin']);
  checar(
    saidas.some((s) => s.tipo === 'botoes' && s.botoes.some((b) => /finalizar/i.test(b))),
    'com o nome, chega ao resumo com Sim/Nao'
  );

  // ------------------------------------------- 6. "nao" reabre o cardapio
  titulo('6. RECUSAR A CONFIRMACAO');
  saidas = [];
  await run(['não']);
  checar(/Sem problema/.test(tudo()), 'responde sem falar em cancelamento');
  checar(/recomeçar do zero/.test(tudo()), 'oferece o 0 para recomecar');
  checar(
    saidas.some((s) => s.tipo === 'lista' || s.tipo === 'botoes' || /Cardápio/.test(s.texto)),
    'reabre o cardapio'
  );
  checar(session.get(TEL).cart.length > 0, 'o carrinho sobrevive — "nao" e ajustar');

  // ------------------------------------------------ 7. "0" reinicia de verdade
  titulo('7. ZERO REINICIA');
  saidas = [];
  await run(['0']);
  const s7 = session.get(TEL);
  checar(s7.cart.length === 0, 'o 0 esvazia o carrinho');
  checar(s7.name === 'Fernando Perin', 'mas preserva o cadastro');
  checar(s7.lang === 'pt', 'e o idioma');
  // Com as quatro cidades ativas, o reinicio volta a PERGUNTAR como o cliente
  // quer receber — e e isso que tem que acontecer. A versao anterior desta
  // assercao esperava a retirada assumida porque no projeto irmao nao havia
  // cidade ativa nenhuma; ela passava por causa da config, nao do codigo.
  checar(
    s7.state === 'ORDER_TYPE',
    'volta perguntando entrega ou retirada — ha o que escolher'
  );
  checar(!/Digite \*0\*/.test(tudo()), 'a mensagem nao manda digitar 0 de novo');

  // ------------------------------------------- 8. "menu" preserva o carrinho
  titulo('8. MENU PRESERVA CARRINHO');
  await run(['ot:pickup', '1', '1']);
  const antes = session.get(TEL).cart.length;
  saidas = [];
  await run(['menu']);
  checar(
    antes > 0 && session.get(TEL).cart.length === antes,
    '"menu" reabre o cardapio sem esvaziar o carrinho'
  );

  console.log('\n\x1b[32mTodos os cenarios passaram.\x1b[0m');
})().catch((e) => {
  console.error('\n\x1b[31mFALHOU:\x1b[0m', e.message);
  process.exit(1);
});
