/**
 * Escolhe a camada de WhatsApp conforme WHATSAPP_PROVIDER.
 *
 *   baileys → conexão via WhatsApp Web (QR code). Precisa de processo 24h.
 *   meta    → Meta Cloud API oficial. Funciona por webhook, sem processo fixo.
 *
 * Os dois expõem `start()` e registram a função de envio em notify.js, então
 * o resto do sistema (router, handlers, agente de IA) não muda.
 */

const PROVIDERS = {
  baileys: () => require('./index'),
  meta: () => require('./meta'),
};

function getProviderName() {
  const name = (process.env.WHATSAPP_PROVIDER || 'baileys').toLowerCase();

  if (!PROVIDERS[name]) {
    const valid = Object.keys(PROVIDERS).join(' | ');
    throw new Error(`WHATSAPP_PROVIDER inválido: "${name}". Use: ${valid}`);
  }
  return name;
}

function get() {
  return PROVIDERS[getProviderName()]();
}

async function start() {
  const name = getProviderName();
  require('../log').info({ evt: 'boot', provider: name }, `provider de WhatsApp: ${name}`);
  return PROVIDERS[name]().start();
}

module.exports = { start, get, getProviderName };
