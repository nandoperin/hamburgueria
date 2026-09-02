process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.SQUARE_ACCESS_TOKEN = 'faketoken';
process.env.SQUARE_LOCATION_ID = 'FAKELOC';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.SUPPORT_PHONE = '18573124606';
process.env.META_CATALOG_ID = 'FAKECAT';

/**
 * Trocar de idioma depois de ter escolhido errado.
 *
 * Antes disto não havia saída: o `0` preserva o idioma de propósito, e depois
 * do primeiro pedido a escolha ficava gravada em `customers.lang` — o erro
 * acompanhava o cliente para sempre. A única alternativa era esperar a sessão
 * expirar, o que não serve para quem está em pé na frente do truck.
 */

const PROJECT = require('path').resolve(__dirname, '..');

const schedulePath = require.resolve(`${PROJECT}/src/services/schedule`);
require(schedulePath);
require.cache[schedulePath].exports.isOpen = () => true;

let gravado = null;
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getCustomerByPhone: async () => null,
  getLastDeliveryOrder: async () => null,
  getActiveOrderByPhone: async () => null,
  upsertCustomer: async (c) => { gravado = c; return { id: 1, ...c }; },
  createOrder: async (o) => ({ id: 99, ...o }),
  createPayment: async () => ({ id: 1 }),
  listUnavailableItems: async () => [],
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
const { route, routeOrder } = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);

let saidas = [];
notify.registerRich({
  sendButtons: async (_p, o) => saidas.push(o.body),
  sendList: async (_p, o) => { saidas.push(o.body); return o.sections.flatMap((s) => s.rows); },
  sendProductList: async (_p, o) => { saidas.push(o.body); return true; },
});
notify.register(async (_p, texto) => saidas.push(texto));
const enviar = async (t) => notify.send('x', t);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const titulo = (n) => console.log(`\n\x1b[33m### ${n} ###\x1b[0m`);
const tudo = () => saidas.join('\n');

(async () => {
  const TEL = '15554443333';

  // ======================================= o recorrente tambem precisa saber
  titulo('CLIENTE RECORRENTE VE A SAIDA');

  require.cache[dbPath].exports.getCustomerByPhone = async () => ({
    id: 1,
    name: 'João Silva',
    lang: 'es', // salvo errado — e o caso que a dica existe para resolver
  });

  session.clear('15557778888');
  saidas = [];
  await route('15557778888', 'Oi', enviar);

  checar(
    /\*idioma\*/.test(tudo()) && /\*language\*/.test(tudo()),
    'a saudacao do recorrente ensina a trocar, nas duas palavras'
  );
  checar(
    saidas.length === 1,
    'e sem gastar mensagem a mais — vai fundida na primeira'
  );

  saidas = [];
  await route('15557778888', 'idioma', enviar);
  await route('15557778888', '1', enviar);
  checar(
    session.get('15557778888').lang === 'pt',
    'e o recorrente preso em espanhol consegue sair'
  );

  require.cache[dbPath].exports.getCustomerByPhone = async () => null;

  // ================================== a saudacao nao pergunta mais o idioma
  //
  // A tela de escolha saiu da entrada: ela prendia quem nao respondesse
  // exatamente 1, 2 ou 3, e a clientela e brasileira. O suporte a tres linguas
  // continua inteiro — o que mudou foi deixar de cobrar a escolha de todo mundo
  // para atender a minoria.
  titulo('A SAUDACAO NAO PERGUNTA IDIOMA');

  session.clear(TEL);
  saidas = [];
  await route(TEL, 'Oi', enviar);

  checar(
    !/Choose your language|Elige tu idioma/.test(tudo()),
    'a primeira mensagem nao pede escolha de idioma'
  );
  checar(session.get(TEL).lang === 'pt', 'o padrao e portugues');
  checar(
    session.get(TEL).state !== 'LANGUAGE',
    'e o estado nao fica preso em LANGUAGE — era o laco que travava o bot'
  );

  // ============================== mas quem precisa de outro idioma tem saida
  titulo('O COMANDO IDIOMA CONTINUA VALENDO');

  saidas = [];
  await route(TEL, 'idioma', enviar);
  checar(
    session.get(TEL).state === 'LANGUAGE_SWITCH',
    '"idioma" abre a troca a qualquer momento'
  );
  await route(TEL, '3', enviar); // espanhol
  checar(session.get(TEL).lang === 'es', 'ficou em espanhol');

  saidas = [];
  await route(TEL, 'idioma', enviar);

  checar(
    session.get(TEL).state === 'LANGUAGE_SWITCH',
    'a palavra "idioma" reabre a escolha em qualquer ponto'
  );
  checar(/Choose your language/.test(tudo()), 'com as tres bandeiras de novo');

  saidas = [];
  await route(TEL, '1', enviar); // portugues
  const s = session.get(TEL);
  checar(s.lang === 'pt', 'agora esta em portugues');
  checar(s.state !== 'LANGUAGE_SWITCH', 'e a conversa continua, nao trava na escolha');
  checar(/Cardápio|cardápio|Toque/.test(tudo()), 'caiu no cardapio, ja traduzido');

  // ======================================= o carrinho sobrevive a troca
  titulo('COM CARRINHO MONTADO');

  session.clear(TEL);
  await route(TEL, 'Oi', enviar);
  // Ingles agora se escolhe pelo comando, nao por uma tela na entrada.
  await route(TEL, 'language', enviar);
  await route(TEL, '2', enviar);
  await routeOrder(TEL, {
    source: 'meta',
    externalOrderId: 'idioma-carrinho',
    items: [{ productId: 'x_burger', quantity: 2, externalProductId: 'x_burger' }],
  }, enviar);
  // Com entrega ativa o checkout cobra como receber antes do cadastro; a
  // retirada resolve isso e leva ao nome, que e onde a troca de idioma retoma.
  await route(TEL, 'ot:pickup', enviar);

  const antes = session.get(TEL).cart.length;
  checar(antes === 1, 'carrinho montado em ingles');

  saidas = [];
  await route(TEL, 'language', enviar);
  await route(TEL, '1', enviar); // portugues

  const s2 = session.get(TEL);
  checar(s2.lang === 'pt', 'trocou para portugues');
  checar(s2.cart.length === antes, 'o carrinho sobreviveu inteiro');
  checar(
    /nome/i.test(tudo()),
    'e o checkout retoma de onde estava, ja em portugues'
  );

  // ================================== a correcao vai para o banco no pedido
  titulo('A TROCA FICA GRAVADA');

  await route(TEL, 'Fernando Perin', enviar);
  await route(TEL, 'sim', enviar);
  checar(
    gravado?.lang === 'pt',
    'o pedido grava o idioma NOVO — o proximo pedido dele ja vem certo'
  );

  // ============================================== pergunta livre nao dispara
  titulo('PERGUNTA LIVRE NAO DISPARA A TROCA');

  session.clear(TEL);
  await route(TEL, 'Oi', enviar);
  saidas = [];
  await route(TEL, 'vocês falam outro idioma?', enviar);

  checar(
    session.get(TEL).state !== 'LANGUAGE_SWITCH',
    'a comparacao e exata — a frase inteira nao vira troca de idioma'
  );

  console.log('\n\x1b[32mTodos os cenarios passaram.\x1b[0m');
})().catch((e) => {
  console.error('\n\x1b[31mFALHOU:\x1b[0m', e.message);
  process.exit(1);
});
