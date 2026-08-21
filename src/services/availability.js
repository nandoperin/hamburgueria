const log = require('../log');
const db = require('../db/queries');

/**
 * Disponibilidade de itens em tempo real.
 *
 * O `menu.json` define o cardápio, mas não serve para "acabou a costela às 20h":
 * mudá-lo exige deploy. Então o que está esgotado vive no banco, e este módulo
 * mantém uma cópia em memória.
 *
 * A cópia existe porque `getAvailableItems` é chamado a cada mensagem e é
 * síncrono — consultar o banco ali obrigaria a tornar assíncrona metade dos
 * handlers. Como só o dono altera, e ele altera pelo próprio bot, a memória é
 * atualizada na hora da mudança; o recarregamento periódico cobre o caso de
 * haver mais de uma instância no ar.
 */

const RECARGA_MS = 60 * 1000;

let esgotados = new Set();
let carregado = false;

/** Recarrega do banco. Falha aqui não derruba o atendimento. */
async function recarregar() {
  try {
    const ids = await db.listUnavailableItems();
    esgotados = new Set(ids);
    carregado = true;
  } catch (err) {
    log.error({ evt: 'estoque', err }, 'falha ao carregar disponibilidade');
  }
}

function isAvailable(itemId) {
  return !esgotados.has(itemId);
}

function listarEsgotados() {
  return [...esgotados];
}

/** Marca esgotado ou disponível, no banco e na memória. */
async function setAvailable(itemId, available) {
  await db.setItemAvailability(itemId, available);

  if (available) esgotados.delete(itemId);
  else esgotados.add(itemId);
}

async function start() {
  await recarregar();
  setInterval(recarregar, RECARGA_MS).unref();

  if (carregado && esgotados.size) {
    log.info(
      { evt: 'estoque', itens: [...esgotados] },
      `itens esgotados: ${[...esgotados].join(', ')}`
    );
  }
}

module.exports = { start, isAvailable, listarEsgotados, setAvailable, recarregar };
