const { t } = require('../i18n');
const log = require('../log');
const entrada = require('../entrada');
const session = require('./session');
const vazao = require('./vazao');
const schedule = require('../services/schedule');

const welcome = require('./handlers/welcome');
const profile = require('./handlers/profile');
const ordertype = require('./handlers/ordertype');
const menu = require('./handlers/menu');
const order = require('./handlers/order');
const faq = require('./handlers/faq');
const admin = require('./handlers/admin');
const catalogorder = require('./handlers/catalogorder');
const cancel = require('./handlers/cancel');
const db = require('../db/queries');

// "reiniciar" sempre recomeça o pedido em montagem. O "0" entra aqui porque é
// o que as mensagens oferecem ao cliente ("digite 0 para recomeçar") — antes
// ele só reabria o cardápio, o que não era recomeçar coisa nenhuma. Para voltar
// ao cardápio sem perder o carrinho existe "menu".
const RESET_WORDS = [
  '0', 'reiniciar', 'restart', 'reset', 'recomecar', 'recomeçar',
];

// "cancelar" é ambíguo: pode ser desistir do carrinho ou cancelar um pedido já
// fechado, com estorno. Quem decide é existir pedido em aberto no banco.
const CANCEL_WORDS = [
  'cancelar', 'cancel', 'cancelar pedido', 'cancel order', 'cancelar pedido',
];

// Saída para quem não quer o endereço assumido do pedido anterior (ver
// ordertype.js) — só faz sentido para quem já escolheu delivery.
const CHANGE_ADDRESS_WORDS = [
  'trocar endereco', 'trocar endereço', 'mudar endereco', 'mudar endereço',
  'change address', 'cambiar direccion', 'cambiar dirección',
];

// Depois do link de pagamento o pedido está fechado. Uma saudação ou pedido
// explícito de "novo pedido" começa outro, em vez de cair no FAQ.
const NEW_ORDER_WORDS = [
  'oi', 'ola', 'olá', 'bom dia', 'boa tarde', 'boa noite',
  'hi', 'hello', 'hey', 'hola', 'buenas',
  'novo pedido', 'new order', 'nuevo pedido', 'pedir', 'order',
];
const FAQ_WORDS = ['faq', 'ajuda', 'help', 'ayuda', 'duvida', 'dúvida'];

// Tocar na bandeira errada acontece, e antes disto não havia saída — nem o "0"
// desfaz, porque ele preserva o idioma de propósito. Comparação exata, como nas
// listas acima: assim "vocês falam outro idioma?" continua indo para o FAQ.
const LANGUAGE_WORDS = [
  'idioma', 'idiomas', 'language', 'languages', 'lengua', 'lenguaje',
];

// "menu" vale em qualquer estado, e não só navegando.
//
// O rodapé do FAQ promete que ele volta ao cardápio; antes disto, quem digitasse
// "menu" enquanto o bot pedia o nome ficava **chamado Menu**. Toda saída que a
// gente ensina ao cliente precisa funcionar de onde ele estiver quando lê.
//
// Diferente do "0": este preserva o carrinho, é só navegação.
const MENU_WORDS = ['menu', 'cardapio', 'cardápio', 'carta'];

const COMMAND_WORDS = [
  '0', 'menu', 'carrinho', 'cart', 'carrito',
  'finalizar', 'checkout', 'pagar', 'done', 'pay', 'finish', 'listo',
  'sim', 's', 'yes', 'y', 'não', 'nao', 'n', 'sí', 'si',
  'pular', 'skip', 'saltar',
];

/** É texto livre (pergunta) e não um número ou comando do fluxo? */
function isFreeText(body) {
  const lower = body.trim().toLowerCase();
  if (/^[+-]?\d+$/.test(lower)) return false;
  return !COMMAND_WORDS.includes(lower);
}

/** Mensagem de "fechado" nos 3 idiomas — o cliente pode não ter escolhido um ainda. */
function closedMessage() {
  return [t('pt', 'closed'), t('en', 'closed'), t('es', 'closed')].join('\n\n');
}

/**
 * Ponto de entrada de toda mensagem recebida.
 *
 * O escopo de log abre aqui e vale até a resposta sair: daqui para dentro,
 * qualquer linha registrada — de qualquer handler, a qualquer profundidade —
 * já sai com o telefone deste cliente. Ver `src/log.js`.
 *
 * @param {string} phone  número do remetente (só dígitos)
 * @param {string} text   corpo da mensagem
 * @param {Function} send  async (texto) => envia resposta ao cliente
 */
async function route(phone, text, send) {
  return log.contexto({ phone }, () => rotear(phone, text, send));
}

async function rotear(phone, text, send) {
  // Antes do log, e não depois: a linha abaixo escreve o texto do cliente no
  // terminal do dono, e sequência de controle vinda de fora repinta ou apaga o
  // que ele está lendo. Daqui para dentro nenhum handler vê byte de comando —
  // nem o que monta a comanda, onde `ESC` significa "corte o papel". Ver
  // `src/entrada.js`.
  const body = entrada.limpar(text);
  if (!body) return;

  log.info({ evt: 'msg', texto: log.texto(body) }, 'mensagem recebida');

  // Comandos de admin passam antes de tudo — inclusive fora do horário, e sem
  // teto de vazão: o dono conferindo pedido na correria não pode ser calado
  // pela própria defesa.
  if (await admin.handle(phone, body, send)) return;

  if (!admin.isAdminPhone(phone)) {
    const decisao = vazao.avaliar(phone);
    if (decisao === 'silencio') return;
    if (decisao === 'avisar') {
      await send(t(session.get(phone).lang || 'pt', 'too_many_messages'));
      return;
    }
  }

  if (!schedule.isOpen()) {
    log.info({ evt: 'fechado' }, 'fora do horário — respondido e encerrado');
    await send(closedMessage());
    return;
  }

  const sess = session.get(phone);
  const lower = body.toLowerCase();

  // Cancelamento vem antes da escolha de idioma de propósito: a sessão expira
  // em 30 minutos, o pedido dura muito mais. Quem pediu há uma hora e volta
  // para cancelar chega com sessão nova — e cairia no menu de idioma, sem
  // conseguir cancelar nunca.
  if (CANCEL_WORDS.includes(lower)) {
    const aberto = await db.getActiveOrderByPhone(phone);
    const fechado =
      aberto && (aberto.status !== 'pending' || sess.state === 'PAYMENT_PENDING');

    if (fechado) {
      await cancel.handleCustomerCancel(sess, send);
      return;
    }
  }

  if (sess.state === 'LANGUAGE') {
    await welcome.handle(sess, body, send);
    return;
  }

  // Vale em qualquer ponto da conversa, menos na própria escolha de idioma —
  // ali as bandeiras já estão na tela.
  if (LANGUAGE_WORDS.includes(lower)) {
    await welcome.askLanguageAgain(sess, send);
    return;
  }

  if (MENU_WORDS.includes(lower)) {
    await menu.presentMenu(sess, send);
    return;
  }

  if (RESET_WORDS.includes(lower) || CANCEL_WORDS.includes(lower)) {

    const fresh = session.reset(phone);
    await send(t(fresh.lang, 'order_cancelled'));
    await ordertype.ask(fresh, send);
    return;
  }

  // Escape hatch do endereço — e da cidade — assumidos em ordertype.js.
  //
  // Pergunta a cidade antes da rua porque quem se mudou pode ter mudado de
  // cidade, e a taxa muda com ela. Antes daqui só se trocava a rua: a taxa de
  // Everett seguiria valendo para uma entrega em Chelsea, o que passava
  // despercebido enquanto a cidade era sempre perguntada.
  if (CHANGE_ADDRESS_WORDS.includes(lower) && sess.orderType === 'delivery') {
    // Zerar o anterior é o que impede o endereço de ser reassumido se ele
    // escolher a mesma cidade de novo — que anularia o pedido de troca.
    sess.address = null;
    sess.lastAddress = null;
    sess.lastCityId = null;
    sess.city = null;
    await ordertype.askCity(sess, send);
    return;
  }

  if (sess.state === 'PAYMENT_PENDING' && NEW_ORDER_WORDS.includes(lower)) {
    const fresh = session.reset(phone);
    // Fundida na pergunta seguinte, como em toda saudação — este caminho tinha
    // escapado do enxugamento e ainda gastava uma mensagem só para dizer "olá".
    const saudacao = fresh.name
      ? t(fresh.lang, 'welcome_back', { name: fresh.name })
      : null;
    await ordertype.ask(fresh, send, saudacao);
    return;
  }

  if (FAQ_WORDS.includes(lower)) {
    await faq.handle(sess, body, send);
    return;
  }

  // "finalizar" e "carrinho" valem em qualquer ponto da navegação — sem isso
  // o cliente fica preso ao voltar para o cardápio depois de montar o pedido.
  if (['MENU', 'ORDER'].includes(sess.state)) {
    if (order.isCheckoutWord(sess.lang, lower) || menu.isCheckoutShortcut(body)) {
      await order.startCheckout(sess, send);
      return;
    }
    if (['carrinho', 'cart', 'carrito'].includes(lower)) {
      await order.showCart(sess, send);
      return;
    }
    // Letra de categoria salta direto, inclusive vindo do estado ORDER.
    if (menu.categoryByShortcut(body)) {
      await menu.handle(sess, body, send);
      return;
    }
  }

  // Pergunta livre durante a navegação: responde pelo FAQ sem perder o estado.
  // Só vale em MENU/ORDER — nos demais estados o texto é a resposta esperada
  // (endereço, email, confirmação) e não deve ser interceptado.
  if (['MENU', 'ORDER'].includes(sess.state) && isFreeText(body)) {
    const answer = faq.findAnswer(sess.lang, body);
    if (answer) {
      await faq.responder(sess, answer, send);
      return;
    }
  }

  try {
    switch (sess.state) {
      case 'LANGUAGE_SWITCH':
        await welcome.handleSwitch(sess, body, send);
        return;
      case 'PROFILE':
        await profile.handle(sess, body, send);
        return;
      case 'ORDER_TYPE':
        await ordertype.handle(sess, body, send);
        return;
      case 'DELIVERY_CITY':
        await ordertype.handleCity(sess, body, send);
        return;
      case 'ADDRESS':
        await order.handleAddress(sess, body, send);
        return;
      case 'MENU':
        await menu.handle(sess, body, send);
        return;
      case 'CHOOSING_OPTIONS':
        await menu.handleOption(sess, body, send);
        return;
      case 'CATALOG_OPTIONS':
        await catalogorder.handleChoice(sess, body, send);
        return;
      case 'ORDER':
        await order.handle(sess, body, send);
        return;
      case 'CONFIRM':
        await order.handleConfirm(sess, body, send);
        return;
      case 'PAYMENT_PENDING':
        // Aguardando o comprovante do Zelle. Perguntas livres viram FAQ.
        await faq.handle(sess, body, send);
        return;
      default:
        session.reset(phone);
        await menu.sendMainMenu(sess, send);
        return;
    }
  } catch (err) {
    log.error(
      { evt: 'erro', err, estado: sess.state },
      'falha ao processar mensagem'
    );
    await send(t(sess.lang || 'pt', 'error_generic'));
  }
}

/**
 * Carrinho enviado pelo catálogo do WhatsApp.
 *
 * Chega como mensagem `type: "order"`, sem texto — por isso não passa por
 * `route()`. Não há comando de admin possível aqui, mas o horário vale igual.
 *
 * @param {string} phone
 * @param {Array} productItems  product_items do webhook
 * @param {Function} send
 */
async function routeOrder(phone, productItems, send) {
  return log.contexto({ phone }, () => rotearCarrinho(phone, productItems, send));
}

async function rotearCarrinho(phone, productItems, send) {
  log.info(
    { evt: 'carrinho', itens: (productItems || []).length },
    'carrinho recebido do catálogo'
  );

  if (!schedule.isOpen()) {
    log.info({ evt: 'fechado' }, 'fora do horário — respondido e encerrado');
    await send(closedMessage());
    return;
  }

  let sess = session.get(phone);

  // O ícone do catálogo fica no cabeçalho da conversa e no perfil do negócio,
  // então o cliente pode mandar um carrinho a qualquer momento — inclusive
  // depois de já ter fechado um pedido. Nesse caso é pedido novo, e não
  // continuação: sem isso o fluxo seguia com a entrega e o endereço do pedido
  // anterior, e chegava ao resumo sem perguntar nada.
  if (sess.state === 'PAYMENT_PENDING') {
    sess = session.reset(phone);
  }

  try {
    await catalogorder.handleCartOrder(sess, productItems, send);
  } catch (err) {
    log.error({ evt: 'erro', err, estado: sess.state }, 'falha ao processar carrinho');
    await send(t(sess.lang || 'pt', 'error_generic'));
  }
}

module.exports = { route, routeOrder, closedMessage };
