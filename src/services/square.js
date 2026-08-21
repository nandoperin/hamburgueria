/**
 * Provedor de pagamento Square — ESQUELETO para a migração futura.
 *
 * O projeto usa Zelle hoje (`src/services/zelle.js`). Quando a migração para o
 * Square acontecer, este arquivo ganha corpo e `PAGAMENTO_PROVIDER=square` passa
 * a valer, sem tocar em `cancel.js` nem no resto do fluxo — é esse o ponto da
 * interface em `src/services/pagamento.js`.
 *
 * Existe já, vazio, para que a costura de portabilidade seja visível e o mapa da
 * migração fique no código, não na memória de alguém. Cada função abaixo recusa
 * em tempo de execução: enquanto não for implementada de verdade, ninguém liga o
 * Square por engano e recebe um silêncio.
 *
 * ## O que o Square muda em relação ao Zelle
 *
 * | | Zelle (hoje) | Square (aqui) |
 * |---|---|---|
 * | Confirmação de pagamento | manual (`!liberar`) | webhook automático |
 * | Estorno | manual, pelo app do banco | API (`refundPayment`) |
 *
 * ## O que falta para ligar
 *
 * 1. `npm i squareup` (SDK v45; ver o `projeto atendimento` como referência de
 *    uso — `client.checkout.paymentLinks.create()`, valores em `Money.amount`
 *    como BigInt de centavos).
 * 2. Implementar `estornar()` com `client.refunds.refundPayment(...)`.
 * 3. Acrescentar a coluna `square_payment_id` a `payments` no `schema.sql` e a
 *    função `markPaymentRefunded` em `db/queries.js` (removidas na migração para
 *    Zelle — o Zelle não tem id de transação nem estado `refunded`).
 * 4. Reativar o webhook de confirmação (`api/webhooks/square.js`, a criar) e as
 *    variáveis SQUARE_* no `.env`.
 * 5. Trocar os textos de pagamento no i18n de volta para o fluxo de link.
 */

const NAO_IMPLEMENTADO =
  'Provedor Square ainda não implementado. ' +
  'Use PAGAMENTO_PROVIDER=zelle ou implemente src/services/square.js — ver o cabeçalho do arquivo.';

/** O Square estorna por API — mas só quando este módulo existir de verdade. */
function estornoAutomatico() {
  throw new Error(NAO_IMPLEMENTADO);
}

// eslint-disable-next-line no-unused-vars
async function estornar(args) {
  throw new Error(NAO_IMPLEMENTADO);
}

module.exports = { estornoAutomatico, estornar };
