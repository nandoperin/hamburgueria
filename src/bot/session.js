const log = require('../log');

const TIMEOUT_MS =
  (parseInt(process.env.SESSION_TIMEOUT_MINUTES, 10) || 30) * 60 * 1000;

const STATES = {
  LANGUAGE: 'LANGUAGE',
  LANGUAGE_SWITCH: 'LANGUAGE_SWITCH', // trocou de idioma no meio da conversa
  PROFILE: 'PROFILE', // nome obrigatório, email opcional
  ORDER_TYPE: 'ORDER_TYPE', // entrega ou retirada, em botões
  DELIVERY_CITY: 'DELIVERY_CITY', // cidade da entrega, em botões
  ADDRESS: 'ADDRESS',
  MENU: 'MENU',
  CHOOSING_OPTIONS: 'CHOOSING_OPTIONS',
  CATALOG_OPTIONS: 'CATALOG_OPTIONS', // carnes dos combos vindos do catálogo
  ORDER: 'ORDER',
  CONFIRM: 'CONFIRM',
  PAYMENT_PENDING: 'PAYMENT_PENDING',
};

const sessions = new Map();

/**
 * Registra a mudança de estado no log.
 *
 * Fica num acessador, e não numa função `setState` chamada em cada handler,
 * porque `session.state = 'X'` acontece em dezoito lugares — e o décimo nono,
 * escrito daqui a um mês, sairia do log sem ninguém notar. Aqui não existe como
 * mudar de estado sem registrar.
 *
 * É a linha que responde "onde ele estava quando travou": lida em sequência,
 * a sucessão de estados de um telefone é a conversa inteira reconstruída.
 */
function definirEstadoObservado(session, inicial) {
  let estado = inicial;

  Object.defineProperty(session, 'state', {
    enumerable: true,
    get: () => estado,
    set(novo) {
      if (novo === estado) return;
      const anterior = estado;
      estado = novo;
      log.info(
        { evt: 'estado', phone: session.phone, de: anterior, para: novo },
        `estado: ${anterior} → ${novo}`
      );
    },
  });
}

function createSession(phone) {
  const session = {
    phone,
    lang: null,
    greeted: false, // já mandamos boas-vindas nesta sessão?
    orderType: null, // 'delivery' | 'pickup'
    currentCategory: null,
    pendingItem: null, // combo aguardando escolha das carnes
    pendingItemQueue: [], // demais combos da mesma seleção ("1 2" em Refeições)
    pendingCombos: [], // fila de combos do catálogo, uma entrada por unidade
    pendingChoiceRows: null, // linhas da última lista, para o fallback em texto
    cart: [],
    city: null,
    address: null,
    name: null,
    email: null,
    lastAddress: null, // endereço do pedido anterior, para reaproveitar
    lastCityId: null,
    lastItems: null, // itens do último pedido PAGO, para oferecer "o de sempre?"
    upsellFeito: false, // a sugestão de bebida já foi feita neste pedido?
    customerId: null,
    orderId: null,
    subtotal: 0,
    deliveryFee: 0,
    total: 0,
    lastActivity: Date.now(),
  };

  definirEstadoObservado(session, STATES.LANGUAGE);
  return session;
}

/** Retorna a sessão do número, criando ou reiniciando se expirou. */
function get(phone) {
  const existing = sessions.get(phone);

  if (existing && Date.now() - existing.lastActivity < TIMEOUT_MS) {
    existing.lastActivity = Date.now();
    return existing;
  }

  // Expirada é diferente de nova: explica por que um cliente que estava no meio
  // do pedido reapareceu na escolha de idioma.
  const minutos = existing
    ? Math.round((Date.now() - existing.lastActivity) / 60000)
    : null;
  log.info(
    { evt: 'sessao', phone, motivo: existing ? 'expirada' : 'nova', minutos },
    existing ? `sessão expirada após ${minutos} min` : 'sessão nova'
  );

  const fresh = createSession(phone);
  sessions.set(phone, fresh);
  return fresh;
}

/** Reinicia o pedido. Por padrão preserva o idioma já escolhido. */
function reset(phone, keepLang = true) {
  const previous = sessions.get(phone);
  const fresh = createSession(phone);

  log.info(
    { evt: 'sessao', phone, motivo: 'reiniciada', de: previous?.state || null },
    'pedido reiniciado'
  );

  // Um novo pedido reaproveita o cadastro e volta à escolha de entrega.
  if (keepLang && previous?.lang) {
    Object.assign(fresh, {
      lang: previous.lang,
      greeted: true,
      name: previous.name,
      email: previous.email,
      customerId: previous.customerId,
      lastAddress: previous.lastAddress,
      lastCityId: previous.lastCityId,
      lastItems: previous.lastItems,
      state: STATES.ORDER_TYPE,
    });
  }

  sessions.set(phone, fresh);
  return fresh;
}

function clear(phone) {
  sessions.delete(phone);
}

// ------------------------------------------------------------------ carrinho

function addItem(session, item) {
  const existing = session.cart.find((i) => i.id === item.id);
  if (existing) {
    existing.qty += 1;
  } else {
    session.cart.push({ ...item, qty: 1 });
  }
}

function removeItem(session, itemId) {
  const index = session.cart.findIndex((i) => i.id === itemId);
  if (index === -1) return false;

  const item = session.cart[index];
  if (item.qty > 1) {
    item.qty -= 1;
  } else {
    session.cart.splice(index, 1);
  }
  return true;
}

function getSubtotal(session) {
  return session.cart.reduce((sum, i) => sum + i.price * i.qty, 0);
}

function sweepExpired() {
  const now = Date.now();
  for (const [phone, session] of sessions) {
    if (now - session.lastActivity >= TIMEOUT_MS) {
      sessions.delete(phone);
    }
  }
}

setInterval(sweepExpired, 10 * 60 * 1000).unref();

module.exports = {
  STATES,
  get,
  reset,
  clear,
  addItem,
  removeItem,
  getSubtotal,
  sweepExpired,
  // aliases usados pelos handlers
  getOrCreate: get,
  resetSession: reset,
};
