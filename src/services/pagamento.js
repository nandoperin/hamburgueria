/**
 * Escolhe o provedor de pagamento conforme PAGAMENTO_PROVIDER.
 *
 *   zelle  → confirmação e estorno manuais (padrão hoje)
 *   square → confirmação por webhook e estorno por API (futuro)
 *
 * Espelha `bot/provider.js` e `ai/provider.js` de propósito: é o mesmo problema
 * — duas implementações de uma interface, escolhidas por variável de ambiente —
 * e resolver igual poupa quem for ler os três.
 *
 * ## Por que a costura existe
 *
 * O projeto usa Zelle hoje e vai migrar para Square. Zelle e Square não são
 * simétricos: o Zelle não tem webhook de confirmação nem API de estorno, e o
 * Square tem os dois. A interface **declara** essa diferença em vez de escondê-la,
 * para que quem chama saiba se uma ação é automática ou pede a mão do dono:
 *
 *   estornoAutomatico()            → false (Zelle) | true (Square)
 *   estornar({ order, payment })   → { estornou, manual }
 *
 * `cancel.js` fala só com esta camada. Trocar `PAGAMENTO_PROVIDER=square` no dia
 * da migração não mexe em regra de cancelamento — só na implementação do estorno.
 *
 * A pergunta "foi escolhido?" cai em `zelle` quando a variável está ausente
 * porque esse é o provedor em uso hoje; o esqueleto `square.js` existe para a
 * migração e recusa em tempo de execução até ser implementado de verdade.
 */

const PROVIDERS = {
  zelle: () => require('./zelle'),
  square: () => require('./square'),
};

function getProviderName() {
  const name = (process.env.PAGAMENTO_PROVIDER || 'zelle').toLowerCase();

  if (!PROVIDERS[name]) {
    const valid = Object.keys(PROVIDERS).join(' | ');
    throw new Error(`PAGAMENTO_PROVIDER inválido: "${name}". Use: ${valid}`);
  }
  return name;
}

function get() {
  return PROVIDERS[getProviderName()]();
}

/** O provedor devolve dinheiro sozinho, ou o estorno é do dono? */
function estornoAutomatico() {
  return get().estornoAutomatico();
}

/**
 * Estorna (ou sinaliza estorno manual) de um pedido.
 *
 * @param {{order: object, payment: object, motivo: string}} args
 * @returns {Promise<{estornou: boolean, manual: boolean}>}
 *   estornou: o dinheiro voltou por API agora; manual: o dono precisa devolver
 *   à mão. Os dois nunca são true juntos.
 */
async function estornar(args) {
  return get().estornar(args);
}

module.exports = { get, getProviderName, estornoAutomatico, estornar };
