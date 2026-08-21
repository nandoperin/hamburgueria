const { t } = require('../../i18n');
const log = require('../../log');
const entrada = require('../../entrada');
const delivery = require('../../services/delivery');
const zelle = require('../../services/zelle');
const db = require('../../db/queries');
const notify = require('../notify');

const CONFIRM_YES = {
  pt: ['sim', 's'],
  en: ['yes', 'y'],
  es: ['sí', 'si', 's'],
};
const CONFIRM_NO = {
  pt: ['não', 'nao', 'n'],
  en: ['no', 'n'],
  es: ['no', 'n'],
};
// Ids literais que CONFIRM_YES/CONFIRM_NO já reconhecem — o botão é só outro
// jeito de mandar a mesma palavra, sem exigir nenhuma mudança no matches().
// "Sim" e "Não" sozinhos não diziam o que cada um faz — e o "Não" parecia
// desistir do pedido, quando na verdade devolve ao cardápio com o carrinho
// intacto. O rótulo agora conta o resultado. Limite de 20 caracteres.
const CONFIRM_BUTTONS = {
  pt: [
    { id: 'sim', title: '✅ Sim, finalizar' },
    { id: 'não', title: '➕ Não, add itens' },
  ],
  en: [
    { id: 'yes', title: '✅ Yes, checkout' },
    { id: 'no', title: '➕ No, add items' },
  ],
  es: [
    { id: 'sí', title: '✅ Sí, finalizar' },
    { id: 'no', title: '➕ No, agregar mas' },
  ],
};
const CHECKOUT_WORDS = {
  pt: ['finalizar', 'checkout', 'pagar'],
  en: ['checkout', 'done', 'pay', 'finish'],
  es: ['pagar', 'finalizar', 'listo'],
};
function formatPrice(p) {
  return `$${p.toFixed(2)}`;
}

function cartLines(cart) {
  return cart
    .map((i) => `• ${i.name} x${i.qty} — ${formatPrice(i.price * i.qty)}`)
    .join('\n');
}

function subtotalOf(cart) {
  return cart.reduce((sum, i) => sum + i.price * i.qty, 0);
}

function matches(dict, lang, input) {
  return dict[lang]?.includes(input) || dict.en.includes(input);
}

async function showCart(session, send) {
  const lang = session.lang;
  if (!session.cart.length) {
    await send(t(lang, 'cart_empty'));
    return;
  }
  await send(
    t(lang, 'cart_summary', {
      items: cartLines(session.cart),
      subtotal: subtotalOf(session.cart).toFixed(2),
    })
  );
}

function renderSummary(session) {
  if (session.orderType === 'pickup') {
    const pickup = delivery.getPickup();
    return t(session.lang, 'order_summary_pickup', {
      items: cartLines(session.cart),
      total: session.total.toFixed(2),
      pickup_address: pickup.address,
      ready_in: pickup.ready_in_minutes,
    });
  }

  return t(session.lang, 'order_summary', {
    items: cartLines(session.cart),
    subtotal: session.subtotal.toFixed(2),
    delivery_fee: session.deliveryFee.toFixed(2),
    total: session.total.toFixed(2),
    city: session.city.label,
    address: session.address,
  });
}

/** Calcula os totais e leva o pedido ao resumo de confirmação. */
function prepareConfirmation(session) {
  const subtotal = subtotalOf(session.cart);
  const fee =
    session.orderType === 'pickup'
      ? 0
      : delivery.getDeliveryFee(session.city, subtotal);

  session.subtotal = subtotal;
  session.deliveryFee = fee;
  session.total = subtotal + fee;
  session.state = 'CONFIRM';
}

/**
 * Teto do corpo de uma mensagem interativa na Cloud API.
 *
 * Estourar faz a Meta recusar a mensagem inteira — o cliente ficaria sem o
 * resumo. Por isso o aviso que vem fundido só entra se couber; se não couber,
 * ele sai numa mensagem própria, que é o comportamento antigo.
 */
const CORPO_MAX = 1024;

// Mensagem de texto simples aguenta bem mais que o corpo interativo — o
// carrinho fundido na pergunta do nome cabe com folga.
const TEXTO_MAX = 4096;

/**
 * Junta o aviso ao corpo da próxima mensagem, em vez de gastar uma mensagem só
 * para ele. Ver `docs/FLOW.md` — é a regra que rege todo o enxugamento: o
 * reconhecimento se funde na pergunta seguinte, nunca é apagado.
 */
function fundir(aviso, corpo, limite = CORPO_MAX) {
  if (!aviso) return { corpo, sobrou: null };
  const junto = `${aviso}\n\n${corpo}`;
  return junto.length <= limite
    ? { corpo: junto, sobrou: null }
    : { corpo, sobrou: aviso };
}

/**
 * Texto simples com o aviso fundido.
 *
 * Se não couber, o aviso sai numa mensagem própria — nunca é descartado. Foi
 * quase o erro aqui: usar só o corpo devolvido por `fundir` faria o carrinho
 * sumir em silêncio num pedido grande.
 */
async function enviarComAviso(send, aviso, corpo) {
  const { corpo: junto, sobrou } = fundir(aviso, corpo, TEXTO_MAX);
  if (sobrou) await send(sobrou);
  await send(junto);
}

/** Manda o resumo com botões Sim/Não; sem suporte a rich, cai no texto de sempre. */
async function sendConfirmPrompt(session, send, aviso = null) {
  const buttons = CONFIRM_BUTTONS[session.lang] || CONFIRM_BUTTONS.en;
  const { corpo, sobrou } = fundir(aviso, renderSummary(session));

  if (sobrou) await send(sobrou);

  const sentButtons = await notify.sendButtons(session.phone, {
    body: corpo,
    buttons,
  });
  if (!sentButtons) await send(corpo);
}

// ---------------------------------------------------------------- checkout

function isCheckoutWord(lang, input) {
  return matches(CHECKOUT_WORDS, lang, input.trim().toLowerCase());
}

/**
 * Fecha o pedido, coletando pelo caminho o que ainda faltar.
 *
 * É aqui que o cadastro e o endereço são pedidos, e não antes do cardápio.
 * O motivo é de funil: tudo que exige **digitação** fica depois do carrinho,
 * quando o cliente já escolheu o que quer e tem motivo para terminar. Antes do
 * cardápio sobram só toques — idioma, entrega/retirada e cidade —, que custam
 * pouco e respondem cedo a pergunta que mataria a experiência se viesse tarde:
 * "vocês entregam aqui?".
 *
 * Cada etapa que falta interrompe e volta para cá quando respondida, então a
 * ordem vale igual para o fluxo de texto e para o carrinho do catálogo.
 */
/**
 * O que ainda falta para fechar — `null` quando o próximo passo é confirmar.
 *
 * Existe para que outros saibam, **antes** de chamar o checkout, se ele vai
 * interromper com uma pergunta ou ir direto ao resumo. O carrinho vindo do
 * catálogo usa isso para não exibir a lista de itens logo antes do resumo, que
 * já traz a mesma lista.
 *
 * É a mesma sequência que `startCheckout` executa, num lugar só — as duas
 * saindo de sincronia seria um jeito silencioso de o carrinho reaparecer.
 */
function oQueFalta(session) {
  if (!session.orderType) return 'orderType';
  if (session.orderType === 'delivery' && !session.address) return 'address';
  if (!session.name) return 'name';
  return null;
}

async function startCheckout(session, send, aviso = null) {
  const lang = session.lang;

  if (!session.cart.length) {
    await send(t(lang, 'cart_empty'));
    return;
  }

  const subtotal = subtotalOf(session.cart);
  const min = delivery.getMinOrder();
  if (subtotal < min) {
    await send(
      t(lang, 'below_minimum', {
        min: min.toFixed(2),
        current: subtotal.toFixed(2),
      })
    );
    return;
  }

  // Só falta quando o carrinho chegou pelo catálogo antes de qualquer pergunta.
  if (!session.orderType) {
    await require('./ordertype').ask(session, send, aviso);
    return;
  }

  if (session.orderType === 'delivery' && !session.address) {
    session.state = 'ADDRESS';
    await enviarComAviso(send, aviso, t(lang, 'ask_address'));
    return;
  }

  // Endereço herdado do pedido anterior: avisa uma vez, aqui, onde ainda dá
  // para trocar antes de confirmar. Vai junto do que vier a seguir em vez de
  // sozinho — o endereço já aparece no resumo, e o que a mensagem realmente
  // acrescenta é ensinar o "trocar endereço", que cabe no mesmo balão.
  let acumulado = aviso;
  if (
    session.orderType === 'delivery' &&
    session.address === session.lastAddress &&
    !session.avisouEndereco
  ) {
    session.avisouEndereco = true;
    const reuso = t(lang, 'address_reused', { address: session.address });
    acumulado = acumulado ? `${acumulado}\n\n${reuso}` : reuso;
  }

  if (!session.name) {
    session.state = 'PROFILE';
    await enviarComAviso(send, acumulado, t(lang, 'ask_profile'));
    return;
  }

  prepareConfirmation(session);
  await sendConfirmPrompt(session, send, acumulado);
}

/**
 * Retoma o fluxo depois de definir tipo de entrega e endereço.
 *
 * No fluxo de texto o carrinho ainda está vazio aqui, então seguimos para o
 * cardápio. Vindo do catálogo ele já chegou montado — nesse caso mandar o
 * cardápio de novo faria o cliente refazer o pedido, então vamos direto pagar.
 */
async function resumeAfterDelivery(session, send, aviso = null) {
  if (session.cart.length) {
    await startCheckout(session, send, aviso);
    return;
  }

  await require('./menu').presentMenu(session, send, aviso);
}

// ------------------------------------------------------------- estado ORDER

async function handle(session, text, send) {
  const lang = session.lang;
  const input = text.trim().toLowerCase();

  const addMatch = input.match(/^\+(\d+)$/);
  const removeMatch = input.match(/^-(\d+)$/);

  if (addMatch) {
    const idx = parseInt(addMatch[1], 10) - 1;
    if (session.cart[idx]) session.cart[idx].qty += 1;
    await showCart(session, send);
    return;
  }

  if (removeMatch) {
    const idx = parseInt(removeMatch[1], 10) - 1;
    if (session.cart[idx]) {
      session.cart[idx].qty -= 1;
      if (session.cart[idx].qty <= 0) session.cart.splice(idx, 1);
    }
    await showCart(session, send);
    return;
  }

  if (['carrinho', 'cart', 'carrito'].includes(input)) {
    await showCart(session, send);
    return;
  }

  if (isCheckoutWord(lang, input)) {
    await startCheckout(session, send);
    return;
  }

  const menu = require('./menu');

  // Número dentro de uma categoria = adicionar outro item dela.
  if (/^\d+$/.test(input) && input !== '0' && session.currentCategory != null) {
    await menu.handle(session, input, send);
    return;
  }

  await menu.sendMainMenu(session, send);
}

// ----------------------------------------------------------- estado ADDRESS

/**
 * O endereço é pedido no checkout, com o carrinho pronto — então daqui se
 * volta para lá, que segue cobrando o que ainda faltar.
 *
 * `resumeAfterDelivery` cobre o caso raro de o endereço ter sido informado com
 * o carrinho vazio (cliente que digita "trocar endereço" antes de escolher):
 * aí ele leva ao cardápio em vez de tentar fechar um pedido sem itens.
 */
async function handleAddress(session, text, send) {
  const lang = session.lang;
  // O mínimo já existia; o teto faltava. O endereço é a linha que o entregador
  // lê no papel, e ela sai em caixa alta e fonte ampliada — sem limite, um
  // endereço longo empurra o total da comanda para a segunda página.
  const address = entrada.curto(text, entrada.LIMITES.endereco);

  if (address.length < 5) {
    await send(t(lang, 'address_too_short'));
    return;
  }

  session.address = address;
  await resumeAfterDelivery(session, send);
}

// ----------------------------------------------------------- estado CONFIRM

async function handleConfirm(session, text, send) {
  const lang = session.lang;
  const input = text.trim().toLowerCase();

  // "Não" não é desistir: é querer mexer no pedido. Devolve o cardápio com o
  // carrinho intacto, e oferece o 0 para quem realmente quer começar de novo.
  if (matches(CONFIRM_NO, lang, input)) {
    session.currentCategory = null;
    await send(t(lang, 'order_declined'));
    // presentMenu, não sendMainMenu: quem tem catálogo configurado deve receber
    // o cartão de novo, e não a lista de categorias em texto.
    await require('./menu').presentMenu(session, send);
    return;
  }

  if (!matches(CONFIRM_YES, lang, input)) {
    await sendConfirmPrompt(session, send);
    return;
  }

  await createOrderAndPay(session, send);
}

// ------------------------------------------- criação do pedido + pagamento

async function createOrderAndPay(session, send) {
  const lang = session.lang;

  /**
   * Sem Zelle configurado, o pedido não fecha.
   *
   * É a mesma inversão de `ambiente.js`: o caso não previsto cai do lado
   * fechado. Deixar passar mandaria o cliente transferir dinheiro para
   * `PREENCHER: nome do destinatário` — e quem descobriria seria ele, com o
   * dinheiro já fora. Recusar custa uma venda; o outro custa a confiança e o
   * dinheiro de alguém.
   *
   * O boot já grita sobre isso (`index.js#conferirConfig`) e o `/health`
   * reprova. Aqui é a última barreira, no ponto em que o dano aconteceria.
   */
  const pronto = zelle.conferir();
  if (!pronto.ok) {
    log.error(
      { evt: 'pagamento', faltando: pronto.faltando },
      'pedido recusado: config/pagamento.json incompleto'
    );
    await send(t(lang, 'payment_error'));
    return;
  }

  try {
    const customer = await db.upsertCustomer({
      phone: session.phone,
      lang,
      name: session.name,
      email: session.email,
    });
    session.customerId = customer.id;

    const isPickup = session.orderType === 'pickup';
    const pickup = delivery.getPickup();

    const order = await db.createOrder({
      customerId: customer.id,
      phone: session.phone,
      lang,
      orderType: session.orderType,
      customerName: session.name,
      items: session.cart,
      city: isPickup ? pickup.label : session.city.label,
      address: isPickup ? pickup.address : session.address,
      subtotal: session.subtotal,
      deliveryFee: session.deliveryFee,
      total: session.total,
    });
    session.orderId = order.id;

    // A partir daqui toda linha desta conversa leva o número do pedido — é o
    // que liga o relato do cliente ("o #31 não chegou") ao que aconteceu antes.
    log.marcar({ pedido: order.id });
    log.info(
      {
        evt: 'pedido',
        tipo: session.orderType,
        itens: session.cart.length,
        total: session.total,
        cidade: isPickup ? null : session.city?.label,
      },
      `pedido #${order.id} criado`
    );

    await db.createPayment({ orderId: order.id, amount: session.total });

    // Guarda o destino para o próximo pedido reaproveitar sem redigitar.
    if (!isPickup) {
      session.lastAddress = session.address;
      session.lastCityId = session.city.id;
    }

    // O carrinho existia para montar este pedido, que agora está no banco.
    // Mantê-lo fazia os itens reaparecerem no pedido seguinte.
    session.cart = [];
    session.state = 'PAYMENT_PENDING';

    log.info(
      { evt: 'pagamento', fase: 'instrucoes_enviadas', metodo: 'zelle' },
      'instruções de pagamento enviadas'
    );

    // O texto sai do i18n, não de um modelo: é a mensagem que carrega para
    // onde mandar dinheiro e quanto. Gerar isso por LLM seria pôr o valor e o
    // destinatário na mão de quem pode alucinar os dois.
    await send(zelle.instrucoes(order, lang));
  } catch (err) {
    log.error({ evt: 'erro', err }, 'falha ao criar pedido');
    await send(t(lang, 'payment_error'));
  }
}

module.exports = {
  handle,
  handleAddress,
  handleConfirm,
  startCheckout,
  resumeAfterDelivery,
  isCheckoutWord,
  showCart,
  oQueFalta,
};
