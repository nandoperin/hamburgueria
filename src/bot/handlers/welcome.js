const { t } = require('../../i18n');
const log = require('../../log');
const delivery = require('../../services/delivery');
const db = require('../../db/queries');
const notify = require('../notify');

const LANG_MAP = { 1: 'pt', 2: 'en', 3: 'es' };

/**
 * Idioma das telas anteriores à escolha.
 *
 * Era inglês, por ser a língua do estado. Passou a português porque a clientela
 * é brasileira — quem mais pede lia a primeira mensagem numa língua que não é a
 * dele, incluindo o aviso de que hoje só há retirada.
 *
 * Quem não lê português não fica de fora: a pergunta de idioma nesta tela sai
 * nas três línguas, as bandeiras dispensam tradução, e da escolha em diante
 * tudo chega traduzido.
 */
const PRE_LANG = 'pt';
const LANG_BUTTONS = [
  { id: '1', title: '🇧🇷 Português' },
  { id: '2', title: '🇺🇸 English' },
  { id: '3', title: '🇪🇸 Español' },
];

/** Áreas de entrega com preços — mostradas já na primeira mensagem. */
function buildAreas(lang) {
  const cities = delivery
    .getCities()
    .map((c) => `• ${c.label} — $${c.delivery_fee.toFixed(2)}`)
    .join('\n');

  return t(lang, 'welcome_areas', {
    cities,
    pickup_address: delivery.getPickup().address,
  });
}

function buildWelcome(lang) {
  return t(lang, 'welcome', {
    truck: process.env.BUSINESS_NAME || 'nossa hamburgueria',
    areas: buildAreas(lang),
  });
}

/** Mesmo texto de `welcome`, sem o parágrafo numerado — os botões o substituem. */
function buildWelcomeButtons(lang) {
  return t(lang, 'welcome_buttons', {
    truck: process.env.BUSINESS_NAME || 'nossa hamburgueria',
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

  if (!session.greeted) {
    session.greeted = true;

    if (await loadKnownCustomer(session)) {
      // Cliente conhecido: com IA ligada, ela saúda pelo nome e conduz; o
      // checkout depois reaproveita cadastro e endereço. Sem IA, o fluxo de
      // sempre pergunta entrega/retirada.
      if (ia.habilitada()) {
        session.state = 'MENU';
        if (await agente.saudar(session, send)) return;
      }
      // A saudação vai fundida na pergunta seguinte: sozinha ela não pede nada
      // e custa uma mensagem em todo pedido de quem já é cliente.
      await ordertype.ask(
        session,
        send,
        t(session.lang, 'welcome_back', { name: session.name })
      );
      return;
    }

    // Sem imagem de marca aqui de propósito: a partir de 01/10/2026 a Meta
    // cobra a mensagem de serviço, e uma arte decorativa dobraria o custo da
    // saudação — a mensagem que todo cliente recebe.
    const sentButtons = await notify.sendButtons(session.phone, {
      body: buildWelcomeButtons(PRE_LANG),
      buttons: LANG_BUTTONS,
    });
    if (!sentButtons) await send(buildWelcome(PRE_LANG));
    return;
  }

  const lang = LANG_MAP[text.trim()];
  if (!lang) {
    await send(buildWelcome(PRE_LANG));
    return;
  }

  session.lang = lang;

  // Conversa humanizada: com IA ligada, ela abre a conversa apresentando as
  // categorias, e o estado passa a MENU para o texto livre seguinte cair no
  // agente (ver router.js). O checkout — entrega, endereço, nome, pagamento —
  // continua na máquina de estados, acionado por `finalizar_pedido`.
  if (ia.habilitada()) {
    session.state = 'MENU';
    if (await agente.saudar(session, send)) return;
  }

  // Sem confirmar a escolha ("Ótimo, atendimento em Português"): o próprio
  // idioma da próxima pergunta já confirma, e seria uma mensagem cobrada só
  // para dizer o óbvio.
  //
  // Daqui vai direto para entrega/retirada, não para o cadastro: nome e
  // endereço são digitação, e digitação antes do cardápio é onde o cliente
  // desiste. Ver `order.startCheckout`.
  await ordertype.ask(session, send);
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
