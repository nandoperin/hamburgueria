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

  return {
    texto,
    chamadas,
    uso: {
      tokensIn: res.usage?.prompt_tokens || 0,
      tokensOut: res.usage?.completion_tokens || 0,
    },
  };
}

module.exports = { conversar };
