const configService = require('./config');

/** A config vigente. Funcao, e nao constante: o dono edita em execucao. */
const config = () => configService.get('delivery');

/** Cidades ativas, na ordem em que aparecem no menu. */
function getCities() {
  return (config().cities || []).filter((c) => c.active !== false);
}

/** Resolve a cidade pelo número digitado pelo cliente (1-based). */
function getCityByIndex(index) {
  const cities = getCities();
  if (!Number.isInteger(index) || index < 1 || index > cities.length) return null;
  return cities[index - 1];
}

function getCityById(id) {
  return getCities().find((c) => c.id === id) || null;
}

/**
 * Taxa de entrega da cidade, considerando a regra de entrega grátis
 * acima de um valor de subtotal.
 */
function getDeliveryFee(city, subtotal) {
  if (!city) return 0;
  const threshold = config().free_delivery_above || 0;
  if (threshold > 0 && subtotal >= threshold) return 0;
  return city.delivery_fee;
}

function getMinOrder() {
  return config().min_order || 0;
}

/**
 * Endereco da retirada, ou null quando ainda nao foi preenchido.
 *
 * O `config/delivery.json` nasce com "PREENCHER: rua, numero..." — e esse texto
 * ia direto para o resumo que o cliente confirma, para a mensagem de retirada e
 * para a **comanda impressa** (`order.js` grava o endereco de retirada no
 * pedido). Placeholder que vaza para o cliente e pior que campo vazio: parece
 * defeito do sistema, e some no meio de um texto que ninguem rele.
 */
const NAO_PREENCHIDO = /^PREENCHER:/i;

function enderecoRetirada() {
  const bruto = String(getPickup().address || '').trim();
  if (!bruto || NAO_PREENCHIDO.test(bruto)) return null;
  return bruto;
}

function getPickup() {
  return config().pickup || { enabled: false };
}

function isPickupEnabled() {
  return getPickup().enabled === true;
}

/** Lista formatada das cidades para exibir no WhatsApp. */
function formatCityList() {
  return getCities()
    .map((c, i) => `${i + 1}️⃣ ${c.label} — $${c.delivery_fee.toFixed(2)}`)
    .join('\n');
}

module.exports = {
  getCities,
  getCityByIndex,
  getCityById,
  getDeliveryFee,
  getMinOrder,
  formatCityList,
  getPickup,
  enderecoRetirada,
  isPickupEnabled,
};
