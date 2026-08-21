const config = require('../../config/delivery.json');

/** Cidades ativas, na ordem em que aparecem no menu. */
function getCities() {
  return (config.cities || []).filter((c) => c.active !== false);
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
  const threshold = config.free_delivery_above || 0;
  if (threshold > 0 && subtotal >= threshold) return 0;
  return city.delivery_fee;
}

function getMinOrder() {
  return config.min_order || 0;
}

function getPickup() {
  return config.pickup || { enabled: false };
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
  isPickupEnabled,
};
