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

/**
 * Quem faz a leitura do fluxo guiado quando não é a Mistral.
 * AI_PROVIDER=deepseek (ou LEITOR_PROVIDER=deepseek), desde 18/09: a leitora
 * vai para a DeepSeek; conversa antiga, áudio e comprovante seguem na
 * Mistral. Sem reserva automática — o dono troca de volta pela variável.
 * Sem a variável, null — a leitora usa `get()`.
 */
function nomeDaLeitora() {
  // Em teste, só a escolha explícita (a prova usa LEITOR_PROVIDER): o
  // AI_PROVIDER do .env local não pode fazer a suíte chamar a API de verdade.
  const geral = process.env.NODE_ENV === 'test' ? '' : process.env.AI_PROVIDER;
  const escolha = String(process.env.LEITOR_PROVIDER || geral || '').toLowerCase();
  return escolha === 'deepseek' ? 'deepseek' : 'mistral';
}

function leitora() {
  return nomeDaLeitora() === 'deepseek' ? require('./deepseek') : null;
}

module.exports = { get, getModelo, habilitada, leitora, nomeDaLeitora };
