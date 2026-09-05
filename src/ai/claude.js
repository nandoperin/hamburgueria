/**
 * Implementação da Anthropic (Claude) para o dispatcher `ai/provider.js`.
 *
 * Interface idêntica a `mistral.js`: `conversar({ system, mensagens, ferramentas })`
 * devolve `{ texto, chamadas: [{ id, nome, argumentos }], uso: { tokensIn, tokensOut, ... } }`.
 *
 * ## Como ligar
 *
 *   AI_PROVIDER=claude
 *   AI_MODEL=claude-haiku-4-5
 *   ANTHROPIC_API_KEY=<sua-chave>
 *
 * ## Por que Haiku 4.5 como padrão
 *
 * É o modelo atual mais barato da Anthropic ($1 entrada / $5 saída por milhão de
 * tokens — confira sempre contra a página de billing, preço muda). Existe para
 * comparar com o `mistral-small-latest` de produção: mesma pergunta —
 * `scripts/prova-conversa.js --provedor=claude --modelo=claude-haiku-4-5` — sem
 * mudar mais nada no bot.
 */
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

let client = null;
function getClient() {
  if (!client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        'ANTHROPIC_API_KEY não configurada. ' +
          'Coloque no .env — cadastro em https://console.anthropic.com'
      );
    }
    client = new Anthropic({ apiKey: key });
  }
  return client;
}

/**
 * Converte o histórico do projeto para o formato de mensagens da Anthropic.
 *
 * Duas diferenças de forma em relação ao Mistral, as duas exigidas pela API,
 * não escolha de estilo:
 *
 * 1. **Tool result não é papel próprio.** A Anthropic não tem `role: 'tool'` —
 *    o resultado vira um bloco `tool_result` dentro de uma mensagem `user`.
 *    Cada entrada do histórico (`{role:'tool', ...}`) vira uma mensagem `user`
 *    separada; a API funde mensagens consecutivas do mesmo papel num turno só
 *    ("Consecutive same-role messages are allowed — the API combines them
 *    into a single turn"), então N chamadas de ferramenta na mesma rodada
 *    chegam como um turno `user` só, sem precisar agrupar aqui.
 * 2. **A chamada de ferramenta é um bloco de conteúdo, não um campo à parte.**
 *    `chamadas` vira `tool_use` dentro do `content` do turno `assistant`,
 *    junto do texto que o modelo tiver dito antes de chamar.
 */
function converterMensagens(mensagens) {
  const msgs = [];
  for (const m of mensagens) {
    if (m.role === 'tool') {
      msgs.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }],
      });
    } else if (m.role === 'assistant' && m.chamadas?.length) {
      const blocos = [];
      if (m.content) blocos.push({ type: 'text', text: m.content });
      for (const c of m.chamadas) {
        blocos.push({ type: 'tool_use', id: c.id, name: c.nome, input: c.argumentos || {} });
      }
      msgs.push({ role: 'assistant', content: blocos });
    } else {
      msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' });
    }
  }
  return msgs;
}

/**
 * A chave de prompt caching — mesma ideia de `mistral.js#chaveDeCache`, mas
 * aqui não é um parâmetro que se manda: é um marcador (`cache_control`) posto
 * no próprio bloco do `system`. Não depende de hash, então esta função não
 * existe para gerar chave — existe só para deixar explícito, no ponto de uso,
 * por que o `system` vira um array de um bloco só em vez de string solta.
 *
 * Prefixo mínimo cacheável da Anthropic é ~1024 tokens; o system prompt deste
 * bot (instruções + cardápio + esquema das ferramentas)
 * está bem acima disso. TTL padrão do marcador é 5 minutos — não fixei um
 * valor maior (`ttl: '1h'`) por não ter necessidade demonstrada: um pedido
 * inteiro, do "oi" ao "sim", termina bem dentro dessa janela.
 */
function blocoDeSystem(system) {
  if (!system) return undefined;
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

/**
 * @param {{ system: string, mensagens: Array, ferramentas?: Array, model?: string }} args
 * @returns {Promise<{ texto: string, chamadas: Array, uso: object }>}
 */
async function conversar({ system, mensagens, ferramentas = [], model: modelo }) {
  const client_ = getClient();
  const model = modelo || process.env.AI_MODEL || 'claude-haiku-4-5';

  // tools.js já declara {name, description, input_schema} — o formato nativo
  // da Anthropic. Ao contrário do Mistral, não há conversão para fazer aqui.
  const res = await client_.messages.create({
    model,
    max_tokens: 16000,
    system: blocoDeSystem(system),
    messages: converterMensagens(mensagens),
    tools: ferramentas.length ? ferramentas : undefined,
  });

  let texto = '';
  const chamadas = [];
  for (const block of res.content) {
    if (block.type === 'text') texto += block.text;
    else if (block.type === 'tool_use') {
      chamadas.push({ id: block.id, nome: block.name, argumentos: block.input || {} });
    }
  }

  return { texto, chamadas, uso: extrairUso(res.usage) };
}

/**
 * Os tokens da chamada, normalizados para o mesmo contrato que `custo.js`
 * espera de qualquer provedor — e é aqui que a Anthropic exige cuidado.
 *
 * A Mistral (e a OpenAI) tratam `cached_tokens` como **subconjunto** de
 * `tokensIn`: o total já inclui o que veio do cache. A Anthropic faz o
 * contrário — `input_tokens` já vem **excluindo** o que foi lido ou escrito no
 * cache; são três baldes separados que somados dão o prompt inteiro. Some-os
 * sem ajustar e o total sairia subcontado; trate `cache_read` como
 * subconjunto (copiando a lógica do Mistral sem pensar) e ele sairia
 * subcontado de novo, na direção errada.
 *
 * `tokensCacheEscrita` é o campo que o Mistral não tem: a Anthropic cobra
 * **mais** (não menos) para escrever num prefixo novo no cache — é o preço de
 * ficar rápido na próxima chamada. `custo.js#calcular` aplica o prêmio de 25%
 * só nessa fatia; provedor sem isso (Mistral) recebe `undefined`, que vira 0.
 */
function extrairUso(usage) {
  const semCache = usage?.input_tokens || 0;
  const lidoDoCache = usage?.cache_read_input_tokens || 0;
  const escritoNoCache = usage?.cache_creation_input_tokens || 0;

  return {
    tokensIn: semCache + lidoDoCache + escritoNoCache,
    tokensOut: usage?.output_tokens || 0,
    tokensCacheados: lidoDoCache,
    tokensCacheEscrita: escritoNoCache,
  };
}

module.exports = { conversar };
