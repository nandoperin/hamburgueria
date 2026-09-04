const config = require('./config');

const DIA_QUINTA = 4;

const doc = () => config.get('promotions');

function diaNoFuso(quando = new Date(), timezone = 'America/New_York') {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  }).format(quando);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday];
}

/**
 * A disponibilidade é calculada na hora da mensagem. Não depende de cron nem
 * de um timer sobreviver a deploy: quinta às 00h entra; sexta às 00h sai.
 */
function ativa(quando = new Date()) {
  const promocao = doc();
  if (promocao.automatic === true) {
    return diaNoFuso(quando, promocao.timezone) === (promocao.weekday ?? DIA_QUINTA);
  }
  return promocao.manual_active === true;
}

function itemBase(id) {
  return (config.get('menu').categories || [])
    .flatMap((categoria) => categoria.items || [])
    .find((item) => item.id === id) || null;
}

function expandirItem(item) {
  const base = itemBase(item.base_item_id);
  const quantidade = Number(item.bundle_quantity) || 1;
  return {
    ...(base || {}),
    ...item,
    name: { ...(base?.name || {}), ...(item.name || {}) },
    description: { ...(base?.description || {}), ...(item.description || {}) },
    // Em pacote de três, uma alteração precisaria indicar em qual unidade vai.
    // Não cobrar um adicional uma vez e aplicá-lo silenciosamente nas três.
    modifiers: quantidade === 1 ? base?.modifiers : undefined,
    ingredientQuantities: quantidade === 1 ? base?.ingredientQuantities : undefined,
    promotionId: 'quintou',
    baseItemId: item.base_item_id,
    bundleQuantity: quantidade,
    catalogVisible: false,
  };
}

function categoria() {
  const categoriaPromocao = doc().category;
  return {
    ...categoriaPromocao,
    items: (categoriaPromocao.items || []).map(expandirItem),
  };
}

function itemDaPromocao(item) {
  return item?.promotionId === 'quintou';
}

function itemLiberado(item, quando = new Date()) {
  return !itemDaPromocao(item) || ativa(quando);
}

function mensagemIndisponivel(lang = 'pt') {
  const promocao = doc();
  if (promocao.automatic === true) {
    if (lang === 'en') return 'The Thursday special is available on Thursdays only.';
    if (lang === 'es') return 'La promoción del jueves está disponible solamente los jueves.';
    return 'A Promo Quintou é válida somente às quintas-feiras.';
  }
  if (lang === 'en') return 'The Thursday special is not active right now.';
  if (lang === 'es') return 'La promoción del jueves no está activa en este momento.';
  return 'A Promo Quintou não está ativa no momento.';
}

function mencionada(texto) {
  const normalizado = String(texto || '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /\bquintou\b|\bpromo(?:cao)?\s+(?:de\s+)?quinta\b/.test(normalizado);
}

module.exports = {
  DIA_QUINTA,
  ativa,
  categoria,
  diaNoFuso,
  itemDaPromocao,
  itemLiberado,
  mensagemIndisponivel,
  mencionada,
};
