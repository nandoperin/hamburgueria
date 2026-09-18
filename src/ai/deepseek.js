/**
 * DeepSeek — só a IA leitora do fluxo guiado (`extrair`), em teste.
 *
 * Liga com LEITOR_PROVIDER=deepseek e DEEPSEEK_API_KEY. O resto (agente
 * antigo, áudio, comprovante) continua na Mistral, e a leitura cai na Mistral
 * se a DeepSeek falhar (ver `leitor.js#ler`).
 *
 * Diferença que importa: a DeepSeek tem "modo JSON" (`json_object`), sem
 * esquema estrito. O esquema vai no prompt, e `leitor.js#normalizar` descarta
 * o que não bate — a saída do modelo é entrada não confiável de qualquer jeito.
 *
 * API compatível com OpenAI: https://api-docs.deepseek.com
 */
const URL_API = 'https://api.deepseek.com/chat/completions';

function modelo() {
  return process.env.LEITOR_MODEL || 'deepseek-flash';
}

async function extrair({ system, mensagens, schema, maxTokens = 900 }) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY não configurada');
  const model = modelo();
  // O modo JSON exige a palavra "json" no prompt e um exemplo do formato.
  const systemJson = `${system}\n\n# Formato da resposta\nResponda SOMENTE com um objeto json que siga ` +
    `exatamente este JSON Schema (todos os campos, sem campos a mais):\n${JSON.stringify(schema)}`;

  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), 20000);
  let res;
  try {
    res = await fetch(URL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: systemJson },
          ...mensagens.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' })),
        ],
      }),
      signal: controle.signal,
    });
  } finally {
    clearTimeout(prazo);
  }
  if (!res.ok) {
    const erro = new Error(`DeepSeek respondeu ${res.status}`);
    erro.status = res.status;
    erro.corpo = (await res.text().catch(() => '')).slice(0, 300);
    throw erro;
  }
  const dados = await res.json();
  const choice = dados.choices?.[0];
  const usage = dados.usage || {};
  return {
    texto: choice?.message?.content || '',
    concluida: choice?.finish_reason === 'stop',
    uso: {
      tokensIn: Number(usage.prompt_tokens || 0),
      tokensOut: Number(usage.completion_tokens || 0),
      tokensCacheados: Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0),
    },
    modelo: dados.model || model,
  };
}

module.exports = { extrair, modelo };
