const { t } = require('../../i18n');
const log = require('../../log');
const delivery = require('../../services/delivery');
const db = require('../../db/queries');
const notify = require('../notify');

const LANG_MAP = { 1: 'pt', 2: 'en', 3: 'es' };

/**
 * O idioma padrão. Não há tela de escolha.
 *
 * A clientela é brasileira e a pergunta de idioma custava caro: ela abria o
 * atendimento e **prendia** quem não respondesse exatamente "1", "2" ou "3" —
 * o estado só saía de LANGUAGE com um desses, e qualquer outra coisa devolvia
 * a saudação. Quem escrevia "quero um x-bacon" de cara entrava em laço.
 *
 * Quem precisar de outro idioma continua tendo saída: o comando `idioma` /
 * `language` refaz a pergunta a qualquer momento (`askLanguageAgain`), e a
 * escolha fica gravada no cadastro. O que saiu foi a barreira na entrada, não
 * o suporte a três línguas.
 */
const PRE_LANG = 'pt';
const LANG_BUTTONS = [
  { id: '1', title: '🇧🇷 Português' },
  { id: '2', title: '🇺🇸 English' },
  { id: '3', title: '🇪🇸 Español' },
];

/** Áreas de entrega com preços — mostradas já na primeira mensagem. */
function buildAreas(lang) {
  const cities = delivery.getCities();

  // Sem cidade ativa o `{cities}` sairia vazio e a frase ficaria solta
  // ("Entregamos em:" seguido de nada). Cenário próprio, texto próprio.
  if (!cities.length) return t(lang, 'welcome_areas_pickup');

  return t(lang, 'welcome_areas', {
    cities: cities.map((c) => `• ${c.label} — $${c.delivery_fee.toFixed(2)}`).join('\n'),
  });
}

/**
 * A primeira mensagem foi só um "oi", ou já trazia o pedido?
 *
 * Importa porque a saudação e a resposta saem na mesma passagem: quem escreve
 * "quero um x-bacon" de cara não pode ter a mensagem engolida pelas boas-vindas
 * e precisar repetir. Quem escreve "oi" não precisa que a IA responda a um
 * cumprimento — a saudação já respondeu.
 */
const SAUDACOES = [
  'oi', 'ola', 'olá', 'oii', 'opa', 'eai', 'e ai', 'eae',
  'bom dia', 'boa tarde', 'boa noite', 'menu', 'cardapio', 'cardápio',
  'hi', 'hello', 'hey', 'hola', 'buenas', 'buenos dias',
];

function ehSoSaudacao(texto) {
  const limpo = String(texto || '')
    .toLowerCase()
    .replace(/[!?.,]/g, '')
    .trim();
  return !limpo || SAUDACOES.includes(limpo);
}

function buildWelcome(lang) {
  return t(lang, 'welcome', {
    nome: process.env.BUSINESS_NAME || 'nossa hamburgueria',
    areas: buildAreas(lang),
  });
}

/** Mesmo texto de `welcome`, sem o parágrafo numerado — os botões o substituem. */
function buildWelcomeButtons(lang) {
  return t(lang, 'welcome_buttons', {
    nome: process.env.BUSINESS_NAME || 'nossa hamburgueria',
    areas: buildAreas(lang),
  });
}

/**
 * Carrega o cadastro do cliente pelo telefone.
 * Retorna false se for a primeira vez que esse número escreve.
 */
async function loadKnownCustomer(session) {
  let customer = null;
  try {
    customer = await db.getCustomerByPhone(session.phone);
  } catch (err) {
    log.error({ evt: 'erro', err }, 'falha ao buscar cliente no banco');
  }

  if (!customer?.name) return false;

  session.customerId = customer.id;
  session.lang = customer.lang || 'pt';
  session.name = customer.name;
  session.email = customer.email;

  try {
    const last = await db.getLastDeliveryOrder(session.phone);
    if (last) {
      session.lastAddress = last.address;
      session.lastCityId = delivery.getCities().find(
        (c) => c.label === last.city
      )?.id;
    }
  } catch (err) {
    log.error({ evt: 'erro', err }, 'falha ao buscar o último pedido');
  }

  // O que ele comeu da última vez — para o bot poder oferecer "o de sempre?".
  // Falha em silêncio de propósito: não saber o pedido anterior custa uma
  // sugestão, e não atender o cliente custa a venda.
  try {
    const feito = await db.getUltimoPedidoFeito(session.phone);
    const itens = Array.isArray(feito?.items_json) ? feito.items_json : [];
    if (itens.length) session.lastItems = itens;
  } catch (err) {
    log.error({ evt: 'erro', err }, 'falha ao buscar os itens do último pedido');
  }

  return true;
}

/**
 * Estado LANGUAGE.
 *
 * Na primeira mensagem tenta reconhecer o cliente: se já comprou antes,
 * pula idioma e cadastro e vai direto à escolha de entrega.
 */
async function handle(session, text, send) {
  const ordertype = require('./ordertype');
  const ia = require('../../ai/provider');
  const agente = require('../../ai/agente');

  session.greeted = true;
  session.lang = session.lang || PRE_LANG;

  const conhecido = await loadKnownCustomer(session);
  const lang = session.lang;

  // ------------------------------------------------------------- sem IA
  //
  // Fluxo numerado: a saudação vai fundida na pergunta seguinte, porque
  // sozinha ela não pede nada e custaria uma mensagem em todo pedido.
  if (!ia.habilitada()) {
    await ordertype.ask(
      session,
      send,
      conhecido ? t(lang, 'welcome_back', { name: session.name }) : buildWelcome(lang)
    );
    return;
  }

  // ------------------------------------------------------------- com IA
  //
  // Daqui em diante quem conduz é o agente, e é `MENU` que faz o router
  // entregar o texto livre a ele.
  session.state = 'MENU';

  // A saudação é determinística, e não do modelo, por um motivo de funil: ela
  // abre com as áreas de entrega, que respondem "vocês entregam aqui?" antes de
  // o cliente montar um carrinho de $30 e descobrir que não. Deixar isso a
  // cargo do modelo tornaria a resposta mais importante da conversa opcional.
  await send(
    conhecido
      ? t(lang, 'welcome_back_ia', { name: session.name })
      : buildWelcome(lang)
  );

  // A primeira mensagem raramente é só "oi" — muita gente já chega pedindo. Sem
  // isto, o pedido dela seria engolido pela saudação e ela teria que repetir,
  // que é o tipo de atrito que faz desistir.
  if (ehSoSaudacao(text)) return;

  await agente.conversar(session, text, send);
}

// ------------------------------------------------- trocar de idioma depois

/**
 * Refaz a pergunta de idioma no meio da conversa.
 *
 * Sem isto, quem tocasse na bandeira errada não tinha saída: o `0` preserva o
 * idioma de propósito, e depois do primeiro pedido a escolha fica gravada em
 * `customers.lang` — o erro acompanhava o cliente em todos os pedidos
 * seguintes. A única alternativa era esperar a sessão expirar, o que não serve
 * para alguém em pé na frente do truck.
 */
async function askLanguageAgain(session, send) {
  session.state = 'LANGUAGE_SWITCH';

  const corpo = t(session.lang || PRE_LANG, 'language_switch');
  const enviou = await notify.sendButtons(session.phone, {
    body: corpo,
    buttons: LANG_BUTTONS,
  });

  if (!enviou) {
    await send(
      [corpo, '', ...LANG_BUTTONS.map((b, i) => `${i + 1}. ${b.title}`)].join('\n')
    );
  }
}

/**
 * Estado LANGUAGE_SWITCH — a resposta da troca.
 *
 * Depois de trocar, a conversa retoma pelo mesmo caminho de sempre: com
 * carrinho vai ao checkout, que cobra o que faltar já no idioma novo; sem
 * carrinho, volta ao cardápio. Não se tenta reconstruir a tela exata onde ele
 * estava — a próxima pergunta chega traduzida, que é o que ele pediu.
 */
async function handleSwitch(session, text, send) {
  const lang = LANG_MAP[text.trim()];

  if (!lang) {
    await askLanguageAgain(session, send);
    return;
  }

  session.lang = lang;

  // Combo pela metade não sobrevive à troca: a pergunta da carne já foi feita
  // no idioma antigo, e retomá-la traduzida no meio confundiria mais que
  // refazer. O que já estava no carrinho fica.
  const tinhaPendente = Boolean(session.pendingItem) || (session.pendingCombos || []).length > 0;
  session.pendingItem = null;
  session.pendingCombos = [];
  session.pendingItemQueue = [];

  if (tinhaPendente) {
    await require('./menu').presentMenu(session, send);
    return;
  }

  await require('./order').resumeAfterDelivery(session, send);
}

module.exports = { handle, buildWelcome, askLanguageAgain, handleSwitch };
