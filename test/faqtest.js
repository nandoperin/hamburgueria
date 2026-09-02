process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.SQUARE_ACCESS_TOKEN = 'faketoken';
process.env.SQUARE_LOCATION_ID = 'FAKELOC';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.SUPPORT_PHONE = '18573124606';
process.env.SUPPORT_EMAIL = 'passarelaespetinho@gmail.com';
process.env.META_CATALOG_ID = 'FAKECAT';

/**
 * O FAQ, e o caminho de volta.
 *
 * O FAQ é um parêntese: responde sem tocar no estado, então o carrinho e o
 * ponto da conversa ficam intactos. O que faltava era o cliente saber disso —
 * as respostas mandavam "digite *0*", e o `0` é o reinício. Quem só queria
 * tirar uma dúvida sobre glúten perdia o pedido inteiro seguindo a instrução
 * do próprio bot.
 */

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
  listUnavailableItems: async () => [],
};

const notify = require(`${PROJECT}/src/bot/notify`);
const { route, routeOrder } = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);
const faqs = require(`${PROJECT}/config/faq.json`);

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
  const TEL = '15552223333';

  // ============================== nenhuma resposta manda apagar o carrinho
  titulo('NENHUMA RESPOSTA MANDA DIGITAR 0');

  const comZero = faqs.filter((q) =>
    ['pt', 'en', 'es'].some((l) => /\*0\*/.test(q.answer[l] || ''))
  );
  checar(
    comZero.length === 0,
    'o "digite *0*" saiu de todas — ele reinicia e apagaria o carrinho'
  );

  // ============================================ acento nao pode barrar
  titulo('CLIENTE NO CELULAR NAO ACENTUA');

  const faq = require(`${PROJECT}/src/bot/handlers/faq`);
  const paresAcentuados = [
    ['qual o horario?', 'qual o horário?'],
    ['tem opcao sem gluten', 'tem opção sem glúten'],
    ['quanto tempo demora a entrega', 'quanto tempo demora a entrega'],
  ];
  for (const [sem, com] of paresAcentuados) {
    checar(
      faq.findAnswer('pt', sem) !== null && faq.findAnswer('pt', sem) === faq.findAnswer('pt', com),
      `"${sem}" acha a mesma resposta que a versao acentuada`
    );
  }

  // ==================================================== o indice
  titulo('"AJUDA" DEVOLVE O INDICE, NAO UM BECO');

  session.clear(TEL);
  await route(TEL, 'Oi', enviar);
  saidas = [];
  await route(TEL, 'ajuda', enviar);

  checar(!/não encontrei/i.test(tudo()), 'nao responde mais "nao encontrei resposta"');
  checar(/Posso ajudar com/.test(tudo()), 'lista os assuntos');
  checar(/857/.test(tudo()), 'com o telefone para quem tem pressa');
  checar(
    /passarelaespetinho@gmail\.com/.test(tudo()),
    'e o e-mail para o que nao e urgente'
  );

  // ============================================ o rodape ensina as saidas
  titulo('O RODAPE ENSINA AS DUAS SAIDAS');

  checar(
    /\*menu\*/.test(tudo()) && /\*0\*/.test(tudo()),
    'toda resposta do FAQ termina dizendo o que menu e 0 fazem'
  );

  saidas = [];
  await route(TEL, 'tem opcao sem gluten?', enviar);
  // Casa com o assunto, nao com a frase: a resposta sobre gluten ja foi
  // reescrita uma vez (para parar de prometer ausencia de contato cruzado) e
  // uma assercao presa ao texto exato quebra a cada melhoria de redacao.
  checar(/gl[úu]ten/i.test(tudo()), 'a pergunta livre e respondida');
  checar(/\*menu\* volta/.test(tudo()), 'com o mesmo rodape');

  // ======================================= o FAQ nao move o cliente
  titulo('O FAQ E UM PARENTESE');

  // Com itens no carrinho e navegando — o router so intercepta pergunta livre
  // em MENU/ORDER, porque nos outros estados o texto e a resposta esperada
  // (nome, endereco) e nao deve ser confundido com duvida.
  session.clear(TEL);
  await route(TEL, 'Oi', enviar);
  // Com as quatro cidades ativas, o bot pergunta como o cliente quer receber
  // antes de abrir o cardapio. A retirada pula a escolha de cidade.
  await route(TEL, 'ot:pickup', enviar);
  await route(TEL, 'S', enviar); // Sanduíches
  await route(TEL, '1', enviar); // um item no carrinho

  const antes = session.get(TEL);
  const estadoAntes = antes.state;
  const itensAntes = antes.cart.length;
  checar(itensAntes > 0, `carrinho montado, estado ${estadoAntes}`);

  saidas = [];
  await route(TEL, 'qual o horario?', enviar);

  const depois = session.get(TEL);
  // Nao casa com "17h": o horario agora e gerado do config/schedule.json, e
  // `always_open` (modo de teste) muda o texto inteiro. Casar com a hora exata
  // faria a suite quebrar no dia em que alguem ajustar o expediente.
  checar(/hor[áa]rio/i.test(tudo()), 'respondeu o horario');
  checar(depois.state === estadoAntes, `o estado nao mudou (${estadoAntes})`);
  checar(depois.cart.length === itensAntes, 'e o carrinho continua intacto');

  // =========================================== "menu" leva ao catalogo
  titulo('"MENU" ABRE O CATALOGO, NAO A LISTA DE TEXTO');

  session.clear(TEL);
  await route(TEL, 'Oi', enviar);
  await routeOrder(TEL, {
    source: 'meta',
    externalOrderId: 'faq-menu',
    items: [{ productId: 'x_burger', quantity: 1, externalProductId: 'x_burger' }],
  }, enviar);

  saidas = [];
  await route(TEL, 'menu', enviar);

  checar(
    /Toque abaixo para ver o cardápio/.test(tudo()),
    'devolve o cartao do catalogo com fotos'
  );
  checar(
    !/escolha uma categoria/i.test(tudo()),
    'e nao a lista de categorias em texto, que era o que fazia antes'
  );
  checar(session.get(TEL).cart.length === 1, 'sem esvaziar o carrinho');

  // ========================================= a dica aparece no cardapio
  titulo('O CLIENTE FICA SABENDO QUE O FAQ EXISTE');

  checar(
    /Escreva \*ajuda\*/.test(tudo()),
    'o proprio cartao do catalogo ensina o "ajuda" — sem gastar mensagem'
  );

  // ============================ a saida ensinada tem que funcionar de onde ele le
  titulo('"MENU" VALE ATE QUANDO O BOT PEDE O NOME');

  session.clear(TEL);
  await route(TEL, 'Oi', enviar);
  await routeOrder(TEL, {
    source: 'meta',
    externalOrderId: 'faq-profile',
    items: [{ productId: 'x_burger', quantity: 1, externalProductId: 'x_burger' }],
  }, enviar);
  // Carrinho pronto, mas ainda falta como receber — o checkout cobra isso antes
  // do cadastro. Respondida a retirada, ele segue para o nome.
  await route(TEL, 'ot:pickup', enviar);
  checar(session.get(TEL).state === 'PROFILE', 'o bot esta pedindo o nome');

  saidas = [];
  await route(TEL, 'menu', enviar);
  const s = session.get(TEL);

  checar(s.name !== 'menu', 'o cliente NAO passa a se chamar Menu');
  checar(s.state === 'MENU', 'ele volta ao cardapio, como o rodape do FAQ promete');
  checar(s.cart.length === 1, 'com o carrinho intacto');

  console.log('\n\x1b[32mTodos os cenarios passaram.\x1b[0m');
})().catch((e) => {
  console.error('\n\x1b[31mFALHOU:\x1b[0m', e.message);
  process.exit(1);
});
