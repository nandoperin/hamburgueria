/**
 * Implementação do Mistral.ai para o dispatcher `ai/provider.js`.
 *
 * O dispatcher já sabe de `claude` e `openai`; este módulo acrescenta `mistral`.
 * Interface idêntica: `conversar({ system, mensagens, ferramentas })` devolve
 *   { texto, chamadas: [{ id, nome, argumentos }], uso: { tokensIn, tokensOut } }
 *
 * ## Como ligar
 *
 *   AI_PROVIDER=mistral
 *   AI_MODEL=mistral-small-latest
 *   MISTRAL_API_KEY=<sua-chave>
 *
 * ## Cadastro
 *
 * 1. Acesse https://mistral.ai/build
 * 2. "Sign up" com um email profissional.
 * 3. Console → API Keys → Create new key → copie. ✅
 * 4. Coloque no `.env`: `MISTRAL_API_KEY=***`
 *
 * ## Por que Mistral Small 4
 *
 * $0.10 entrada / $0.30 saída — cerca de US$25-50/mês para 100 pedidos/dia de
 * atendimento de hamburgueria, e entende português de verdade. É a melhor
 * relação QA/preço disponível hoje. `ministral-3b-latest` é mais barata ainda,
 * mas de borda — use se o orçamento estiver muito apertado.
 */
const crypto = require('crypto');
const { Mistral } = require('@mistralai/mistralai');

let client = null;
function getClient() {
  if (!client) {
    const key = process.env.MISTRAL_API_KEY;
    if (!key) {
      throw new Error(
        'MISTRAL_API_KEY não configurada. ' +
          'Coloque no .env — cadastro em https://mistral.ai/build'
      );
    }
    client = new Mistral({ apiKey: key });
  }
  return client;
}

/**
 * A chave de prompt caching.
 *
 * O Mistral não usa marcador por bloco como a Anthropic (`cache_control`) — é
 * uma string só, reaproveitada entre chamadas que compartilham prefixo. A doc
 * deles: "use the same key for requests with shared prompt prefixes, such as
 * multi-turn conversations or repeated system prompts".
 *
 * A chave é o hash do próprio `system`, e não um valor fixo por idioma. Duas
 * consequências, as duas de propósito:
 *
 * 1. **Rotaciona sozinha quando o cardápio muda.** `system` inclui o cardápio
 *    e o FAQ preenchidos (`agente.js#systemPrompt`); o dono edita um preço no
 *    painel, o hash muda, e a primeira chamada depois disso paga cheio de
 *    novo — correto, porque o que estaria em cache seria o preço velho.
 * 2. **Já separa por idioma sem precisar saber disso aqui.** `system` termina
 *    com "Responda sempre em português/inglês/espanhol", então PT/EN/ES já
 *    saem com hashes diferentes — este módulo não precisa receber `lang`.
 *
 * `system` inteiro (não só os primeiros bytes) porque o hash tem que mudar se
 * qualquer parte mudar — é prefixo igual ou não é, não existe "quase igual"
 * aqui.
 */
function chaveDeCache(system) {
  return crypto.createHash('sha256').update(system).digest('hex').slice(0, 32);
}

/** Converte a assinatura de ferramentas do projeto para o formato Mistral. */
function toolSchema(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  };
}

/**
 * @param {{ system: string, mensagens: Array, ferramentas?: Array, model?: string }} args
 * @returns {Promise<{ texto: string, chamadas: Array, uso: { tokensIn: number, tokensOut: number } }>}
 */
async function conversar({ system, mensagens, ferramentas = [], model: modelo }) {
  const client_ = getClient();
  const model = modelo || process.env.AI_MODEL || 'mistral-small-latest';

  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  for (const m of mensagens) {
    if (m.role === 'tool') {
      // Resultado de ferramenta: o Mistral espera role 'tool' com o id da
      // chamada que o gerou, para casar com o tool_call do assistant anterior.
      msgs.push({
        role: 'tool',
        toolCallId: m.tool_call_id,
        name: m.nome,
        content: m.content,
      });
    } else if (m.role === 'assistant' && m.chamadas?.length) {
      // Fala do assistant que pediu ferramentas: remonta os tool_calls no
      // formato do Mistral para o histórico ficar coerente na próxima rodada.
      msgs.push({
        role: 'assistant',
        content: m.content || '',
        toolCalls: m.chamadas.map((c) => ({
          id: c.id,
          type: 'function',
          function: {
            name: c.nome,
            arguments: JSON.stringify(c.argumentos || {}),
          },
        })),
      });
    } else {
      msgs.push({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content || '',
      });
    }
  }

  const payload = {
    model,
    messages: msgs,
    tools: ferramentas.length ? ferramentas.map(toolSchema) : undefined,
    promptCacheKey: system ? chaveDeCache(system) : undefined,
  };

  const res = await client_.chat.complete(payload);
  const msg = res.choices?.[0]?.message;

  // O SDK v2 pode devolver content como string ou array de chunks de texto.
  let texto = '';
  if (typeof msg?.content === 'string') {
    texto = msg.content;
  } else if (Array.isArray(msg?.content)) {
    texto = msg.content
      .map((c) => (typeof c === 'string' ? c : c.text || ''))
      .join('');
  }

  const chamadas = (msg?.toolCalls || msg?.tool_calls || []).map((tc) => ({
    id: tc.id,
    nome: tc.function?.name,
    argumentos:
      typeof tc.function?.arguments === 'string'
        ? JSON.parse(tc.function.arguments || '{}')
        : tc.function?.arguments || {},
  }));

  return { texto, chamadas, uso: extrairUso(res.usage) };
}

/**
 * Os tokens da chamada — a matéria-prima do teto de gasto.
 *
 * Esta função existe por causa de um bug que só apareceu quando alguém foi
 * medir: o código lia `prompt_tokens` / `completion_tokens`, e o SDK v2 do
 * Mistral devolve **`promptTokens` / `completionTokens`**. O resultado era um
 * medidor que marcava zero em toda chamada — e zero num contador de custo é o
 * pior valor possível, porque é indistinguível de "ainda não gastou nada".
 *
 * Daí as duas decisões abaixo:
 *
 * 1. **Aceita as duas grafias.** A API REST documenta snake_case, o SDK
 *    normaliza para camelCase, e qual das duas chega depende da versão do
 *    pacote. Ler as duas custa uma linha e sobrevive ao próximo upgrade.
 * 2. **Zero reclama alto.** Se nem uma nem outra vier, o teto de gasto está
 *    cego, e isso precisa aparecer no log em vez de virar silêncio. Um teto
 *    que não conta é o mesmo que não ter teto.
 *
 * `tokensCacheados` é a fatia de `tokensIn` que veio do cache — **subconjunto**
 * do total, não somado a ele; é assim que a Mistral e a OpenAI documentam o
 * campo `prompt_tokens_details.cached_tokens` (o nome do campo já é o mesmo da
 * OpenAI de propósito). Chega como `usage.prompt_tokens_details.cached_tokens`
 * porque `UsageInfo$inboundSchema` do SDK só mapeia os campos que conhece —
 * este passa direto, sem virar camelCase. `custo.js#calcular` é quem usa isso
 * para precificar essa fatia a 10% em vez do preço cheio.
 */
function extrairUso(usage) {
  const tokensIn = Number(usage?.promptTokens ?? usage?.prompt_tokens ?? 0) || 0;
  const tokensOut = Number(usage?.completionTokens ?? usage?.completion_tokens ?? 0) || 0;
  const tokensCacheados = Number(
    usage?.promptTokensDetails?.cachedTokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0
  ) || 0;

  if (!tokensIn && !tokensOut) {
    require('../log').warn(
      { evt: 'ia_custo', campos: usage ? Object.keys(usage) : null },
      'Mistral respondeu sem contagem de tokens — o teto de gasto está cego nesta chamada'
    );
  }

  return { tokensIn, tokensOut, tokensCacheados };
}

module.exports = { conversar };
