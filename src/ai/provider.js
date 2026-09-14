const mistral = require('./mistral');

function getModelo() {
  return process.env.AI_MODEL || 'mistral-small-latest';
}

/**
 * A conversa por IA está ligada?
 *
 * `AI_ENABLED=off` é o interruptor: com ele o bot cai na máquina de estados
 * (cardápio numerado, carrinho, checkout). Feio, e funcionando. Existe para
 * provedor fora do ar, cota estourada, ou comportamento estranho no meio do
 * serviço — a mesma filosofia de `BAILEYS_RICH=off`:
 * todo caminho novo tem volta sem deploy.
 *
 * A pergunta é "foi ligada?", e não "foi desligada?": a variável ausente cai
 * no lado **ligado** porque este é o comportamento pretendido do projeto, e
 * porque cair no fluxo numerado por engano seria uma degradação silenciosa —
 * o oposto do caso dos segredos, onde o silêncio é que é perigoso.
 */
function habilitada() {
  return (process.env.AI_ENABLED || 'on').toLowerCase() !== 'off';
}

function get() {
  return mistral;
}

module.exports = { get, getModelo, habilitada };
