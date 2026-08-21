process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.SQUARE_ACCESS_TOKEN = 'faketoken';
process.env.SQUARE_LOCATION_ID = 'FAKELOC';
process.env.BASE_URL = 'https://fake.test';
process.env.FOOD_TRUCK_NAME = 'Passarela Espetinho';
process.env.SUPPORT_PHONE = '18573124606';
process.env.META_CATALOG_ID = 'FAKECAT';

/**
 * Trava a quantidade de mensagens de cada conversa.
 *
 * Cada mensagem é uma notificação no celular do cliente e, desde 01/10/2026,
 * uma cobrança da Meta. O fluxo foi enxugado com uma regra: **o reconhecimento
 * se funde na pergunta seguinte, nunca é apagado** — "Retirada selecionada" vira
 * a primeira linha do cardápio em vez de mensagem própria.
 *
 * Sem esta suíte, reintroduzir um `await send(...)` de confirmação passa
 * despercebido: nada quebra, o teste continua verde, e a conversa engorda de
 * volta um balão por vez. Aqui o número é o contrato.
 */

const PROJECT = require('path').resolve(__dirname, '..');

const schedulePath = require.resolve(`${PROJECT}/src/services/schedule`);
require(schedulePath);
require.cache[schedulePath].exports.isOpen = () => true;

let conhecido = null;
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getCustomerByPhone: async () => conhecido,
  getLastDeliveryOrder: async () =>
    conhecido ? { address: '12 Broadway Apt 3', city: 'Everett' } : null,
  getActiveOrderByPhone: async () => null,
  upsertCustomer: async (c) => ({ id: 1, ...c }),
  createOrder: async (o) => ({ id: 99, ...o }),
  createPayment: async () => ({ id: 1 }),
  listUnavailableItems: async () => [],
};

const squarePath = require.resolve(`${PROJECT}/src/services/square`);
require(squarePath);
require.cache[squarePath].exports = {
  createPaymentLink: async () => ({ url: 'https://sq.link/X', squareOrderId: 'SO' }),
};

const notify = require(`${PROJECT}/src/bot/notify`);
const { route, routeOrder } = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);

const saidas = [];
notify.registerRich({
  sendButtons: async (_p, o) => saidas.push({ tipo: 'BOTOES', corpo: o.body }),
  sendList: async (_p, o) => {
    saidas.push({ tipo: 'LISTA', corpo: o.body });
    return o.sections.flatMap((s) => s.rows);
  },
  sendProductList: async (_p, o) => {
    saidas.push({ tipo: 'CATALOGO', corpo: o.body });
    return true;
  },
  sendCatalog: async (_p, o) => {
    saidas.push({ tipo: 'CATALOGO', corpo: o.body });
    return true;
  },
});
notify.register(async (_p, texto) => saidas.push({ tipo: 'TEXTO', corpo: texto }));

const enviar = async (texto) => notify.send('x', texto);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const titulo = (n) => console.log(`\n\x1b[33m### ${n} ###\x1b[0m`);

async function conversa(passos, recorrente) {
  conhecido = recorrente ? { id: 1, name: 'João Silva', lang: 'pt' } : null;
  saidas.length = 0;
  const TEL = `1555${Math.floor(Math.random() * 9000000)}`;
  session.clear(TEL);

  for (const passo of passos) {
    if (Array.isArray(passo)) await routeOrder(TEL, passo, enviar);
    else await route(TEL, passo, enviar);
  }
  return saidas.slice();
}

const CARRINHO = [{ product_retailer_id: 'espetinho_boi', quantity: 2 }];
const COMBO = [{ product_retailer_id: 'combo_2', quantity: 1 }];

/** Alguma mensagem começa com este texto? */
const abreCom = (msgs, trecho) => msgs.some((m) => m.corpo.startsWith(trecho));
const contem = (msgs, trecho) => msgs.some((m) => m.corpo.includes(trecho));

(async () => {
  // ================================================== recorrente, retirada
  //
  // Config de produção: fase de testes, sem cidades ativas. O bot nem pergunta
  // como o cliente quer receber — não há o que escolher.
  titulo('PRODUCAO (SO RETIRADA) · RECORRENTE · 3 MENSAGENS');

  let m = await conversa(['Oi', CARRINHO, 'sim'], true);
  m.forEach((x, i) => console.log(`      ${i + 1}. [${x.tipo}] ${x.corpo.split('\n')[0].slice(0, 46)}`));

  checar(m.length === 3, `a conversa inteira cabe em ${m.length} mensagens`);
  checar(
    !contem(m, 'Como você quer receber'),
    'sem entrega ativa, a pergunta de entrega/retirada nem aparece'
  );
  checar(
    m[0].tipo === 'CATALOGO' &&
      m[0].corpo.includes('João Silva') &&
      m[0].corpo.includes('Retirada'),
    'saudacao e confirmacao da retirada vem no proprio cardapio'
  );
  checar(
    !contem(m, 'Recebi seu carrinho'),
    'o aviso de carrinho recebido nao existe mais'
  );
  checar(
    m.filter((x) => x.corpo.includes('Espetinho de Boi')).length === 1,
    'os itens aparecem UMA vez — o resumo nao repete o carrinho'
  );
  checar(m[2].corpo.includes('sq.link'), 'e o link de pagamento fecha a conversa');

  // Daqui para baixo, os cenarios de entrega — que o codigo continua servindo,
  // e que voltam a valer quando o delivery comecar.
  require('./comentrega').ligar();

  // ==================================================== recorrente, entrega
  titulo('RECORRENTE · ENTREGA · 4 MENSAGENS');

  m = await conversa(['Oi', 'ot:delivery', CARRINHO, 'sim'], true);
  m.forEach((x, i) => console.log(`      ${i + 1}. [${x.tipo}] ${x.corpo.split('\n')[0].slice(0, 46)}`));

  checar(m.length === 4, `${m.length} mensagens`);
  checar(
    !contem(m, 'Para qual cidade'),
    'a cidade nao e perguntada — o bot ja sabe do pedido anterior'
  );
  checar(
    m[1].tipo === 'CATALOGO' && m[1].corpo.includes('Everett') && m[1].corpo.includes('$5.00'),
    'cidade e taxa vao fundidas no cardapio, para ele conferir'
  );
  checar(
    m[1].corpo.includes('trocar endereço'),
    'e a saida esta ali mesmo, para quem hoje pede em outro lugar'
  );
  checar(
    contem(m, '12 Broadway') && contem(m, 'RESUMO'),
    'o aviso de endereco reaproveitado vai junto do resumo'
  );

  // ============================================ trocar endereco troca a cidade
  titulo('TROCAR ENDERECO PERGUNTA A CIDADE');

  conhecido = { id: 1, name: 'João Silva', lang: 'pt' };
  saidas.length = 0;
  const TEL = '15559990000';
  session.clear(TEL);

  // Com carrinho montado, que e quando o cliente de fato ve o endereco e
  // percebe que hoje quer em outro lugar.
  await route(TEL, 'Oi', enviar);
  await route(TEL, 'ot:delivery', enviar);
  await routeOrder(TEL, CARRINHO, enviar);
  let s = session.get(TEL);
  checar(
    s.city?.id === 'everett' && s.address === '12 Broadway Apt 3',
    'comeca com a cidade e o endereco do pedido anterior'
  );

  saidas.length = 0;
  await route(TEL, 'trocar endereço', enviar);
  s = session.get(TEL);

  checar(
    saidas.some((x) => x.corpo.includes('Para qual cidade')),
    'a troca comeca perguntando a CIDADE, nao so a rua'
  );
  checar(
    !s.address && !s.city,
    'e zera os dois antes de perguntar'
  );

  saidas.length = 0;
  await route(TEL, 'city:chelsea', enviar);
  s = session.get(TEL);
  checar(s.city?.id === 'chelsea', 'a cidade nova vale');
  checar(
    !s.address,
    'e o endereco antigo NAO volta — era o que a taxa errada de Everett esconderia'
  );
  checar(
    s.state === 'ADDRESS',
    'e ai sim ele pede a rua nova, com o carrinho intacto'
  );
  checar(s.cart.length === 1, 'o carrinho sobrevive a troca de endereco');

  saidas.length = 0;
  await route(TEL, '250 Broadway Apt 5', enviar);
  s = session.get(TEL);
  checar(
    s.address === '250 Broadway Apt 5' && s.city.id === 'chelsea',
    'endereco novo com a cidade nova — a taxa cobrada e a de Chelsea'
  );

  // ==================================================== cliente novo
  require('./comentrega').desligar();

  titulo('PRODUCAO (SO RETIRADA) · NOVO · 5 MENSAGENS');

  m = await conversa(['Oi', '1', CARRINHO, 'Joao Silva', 'sim'], false);
  m.forEach((x, i) => console.log(`      ${i + 1}. [${x.tipo}] ${x.corpo.split('\n')[0].slice(0, 46)}`));

  checar(m.length === 5, `${m.length} mensagens`);
  checar(
    abreCom(m, '✅ Obrigado'),
    'o agradecimento pelo nome existe — fundido, nao apagado'
  );
  checar(
    m.find((x) => x.corpo.startsWith('✅ Obrigado')).corpo.includes('RESUMO'),
    'e ele esta dentro da mensagem do resumo, nao numa propria'
  );

  const pedeNome = m.find((x) => x.corpo.includes('me diga seu *nome*'));
  checar(
    pedeNome.corpo.includes('Espetinho de Boi'),
    'o carrinho vem na mesma mensagem que pede o nome, nao numa antes'
  );
  checar(
    m.filter((x) => x.corpo.includes('Carrinho:')).length === 1,
    'e aparece uma vez so na conversa inteira'
  );

  // ==================================================== novo, com combo
  titulo('PRODUCAO (SO RETIRADA) · NOVO COM COMBO 2 · 7 MENSAGENS');

  m = await conversa(
    ['Oi', '1', COMBO, 'carne:espetinho_boi', 'carne:espetinho_costela', 'Joao Silva', 'sim'],
    false
  );
  checar(m.length === 7, `${m.length} mensagens`);
  checar(
    m.filter((x) => x.tipo === 'LISTA').length === 2,
    'as duas perguntas de carne continuam — a lista do WhatsApp e de escolha unica'
  );

  // ============================================ nada de reconhecimento perdido
  titulo('NADA FOI APAGADO, SO FUNDIDO');

  m = await conversa(['Oi', CARRINHO, 'sim'], true);
  const tudo = m.map((x) => x.corpo).join('\n');
  for (const pedaco of ['João Silva', 'Retirada', 'Espetinho de Boi', 'Total']) {
    checar(tudo.includes(pedaco), `"${pedaco}" continua sendo dito ao cliente`);
  }

  console.log('\n\x1b[32mTodos os cenarios passaram.\x1b[0m');
})().catch((e) => {
  console.error('\n\x1b[31mFALHOU:\x1b[0m', e.message);
  process.exit(1);
});
