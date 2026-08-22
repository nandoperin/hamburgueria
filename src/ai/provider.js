/**
 * Escolhe o provedor de IA conforme AI_PROVIDER.
 *
 *   claude → Anthropic (padrão)
 *   openai → OpenAI
 *
 * Espelha `bot/provider.js` de propósito: é o mesmo problema — duas
 * implementações de uma interface, escolhidas por variável de ambiente — e
 * resolver igual poupa quem for ler os dois.
 *
 * Cada um expõe `conversar({ system, mensagens, ferramentas })` e devolve
 * sempre a mesma forma:
 *
 *   { texto, chamadas: [{ id, nome, argumentos }], uso: { tokensIn, tokensOut } }
 *
 * O `agente.js` não sabe qual está ativo, e nenhuma ferramenta muda com a
 * troca. Trocar de provedor não mexe em regra de negócio.
 */

/**
 * Os provedores que existem **de verdade**.
 *
 * `claude` e `openai` estavam nesta lista antes dos arquivos serem escritos, e
 * o efeito era mudo do pior jeito: `AI_PROVIDER=claude` (que era o padrão, e o
 * que o `.env.example` trazia) passava pelo `checkEnv` do boot, subia o bot
 * satisfeito, e só quebrava no `require` da primeira mensagem de cliente —
 * dentro do `try` do agente, que devolve `false` e cai no cardápio numerado.
 * O dono via um bot funcionando e nunca sabia que a IA jamais respondera.
 *
 * A lista agora enumera o que está implementado. Provedor novo entra aqui no
 * mesmo commit em que o arquivo dele nasce, e não antes.
 */
const PROVIDERS = {
  mistral: () => require('./mistral'),
};

const MODELO_PADRAO = {
  mistral: 'mistral-small-latest',
};

function getProviderName() {
  const name = (process.env.AI_PROVIDER || 'mistral').toLowerCase();

  // Lançar aqui é de propósito: `index.js` chama isto no `checkEnv` do boot,
  // então provedor errado derruba o deploy com o nome do erro na tela. A
  // alternativa — descobrir na primeira mensagem de cliente — vira degradação
  // silenciosa para o cardápio numerado, que é o defeito que esta lista teve.
  if (!PROVIDERS[name]) {
    const valid = Object.keys(PROVIDERS).join(' | ');
    throw new Error(
      `AI_PROVIDER inválido: "${name}". Implementados hoje: ${valid}. ` +
        'Para acrescentar outro, escreva `src/ai/<nome>.js` com a mesma ' +
        'interface de `mistral.js` e registre-o em PROVIDERS.'
    );
  }
  return name;
}

function getModelo() {
  return process.env.AI_MODEL || MODELO_PADRAO[getProviderName()];
}

/**
 * A conversa por IA está ligada?
 *
 * `AI_ENABLED=off` é o interruptor: com ele o bot cai na máquina de estados
 * (cardápio numerado, carrinho, checkout). Feio, e funcionando. Existe para
 * provedor fora do ar, cota estourada, ou comportamento estranho no meio do
 * serviço — a mesma filosofia de `PRINTER_FORMAT=plain` e `BAILEYS_RICH=off`:
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
  return PROVIDERS[getProviderName()]();
}

module.exports = { get, getProviderName, getModelo, habilitada };
