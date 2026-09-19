/**
 * Comanda que falha na impressora não trava a fila.
 *
 * 18/09: a #162 falhou no Android e voltou para a frente da fila a cada 20 s,
 * por meia hora — e a #163, paga, ficou presa atrás dela. Agora:
 *
 * - Até a 3ª falha: volta na hora e tenta de novo, como sempre (falha
 *   passageira: papel, Bluetooth) — pedido do dono, 19/09.
 * - Da 4ª em diante: espera 30 s, 60 s, 120 s… até 5 min, e continua tentando
 *   sempre (nunca é abandonada). Enquanto espera, as seguintes imprimem.
 * - Na 5ª falha: avisa o dono uma vez.
 * - Qualquer comanda impressa com sucesso libera as que estavam esperando: a
 *   impressora voltou, tenta de novo já.
 *
 * A espera usa a coluna que já existe (`print_claimed_at` no futuro), sem
 * mudança no banco. A contagem fica na memória: um restart zera, e a comanda
 * volta a ter as tentativas imediatas — nada se perde.
 */

const ESPERA_MAX_S = 300;
const TENTATIVAS_NA_HORA = 3;
const AVISAR_NA_FALHA = 5;
const MAX_PEDIDOS = 500;

const falhas = new Map();
const avisados = new Set();

function registrarFalha(pedidoId) {
  if (falhas.size >= MAX_PEDIDOS) { falhas.clear(); avisados.clear(); }
  const n = (falhas.get(pedidoId) || 0) + 1;
  falhas.set(pedidoId, n);
  return n;
}

/** Segundos até a próxima tentativa; 0 = volta para a fila na hora. */
function esperaSegundos(n) {
  if (n <= TENTATIVAS_NA_HORA) return 0;
  return Math.min(ESPERA_MAX_S, 30 * 2 ** (n - TENTATIVAS_NA_HORA - 1));
}

/** Verdadeiro uma vez só por comanda, na 5ª falha. */
function deveAvisar(pedidoId, n) {
  if (n < AVISAR_NA_FALHA || avisados.has(pedidoId)) return false;
  avisados.add(pedidoId);
  return true;
}

function impressa(pedidoId) {
  falhas.delete(pedidoId);
  avisados.delete(pedidoId);
}

function _zerar() {
  falhas.clear();
  avisados.clear();
}

module.exports = { registrarFalha, esperaSegundos, deveAvisar, impressa, AVISAR_NA_FALHA, TENTATIVAS_NA_HORA, _zerar };
