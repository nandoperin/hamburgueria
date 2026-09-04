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
 * O modelo vem de AI_MODEL; a tabela e os tetos de custo ficam em custo.js.
 * A leitura de comprovante usa o mesmo modelo numa chamada isolada de visao.
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

/** Leitura isolada: nao recebe carrinho, historico, valor esperado nem tools. */
async function lerComprovante({ buffer, mimetype, system, schema }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length ||
      buffer.length > 5 * 1024 * 1024 ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(mimetype)) {
    throw new Error('Imagem invalida para leitura');
  }
  const model = process.env.AI_MODEL || 'mistral-small-latest';
  const res = await getClient().chat.complete({
    model,
    temperature: 0,
    maxTokens: 450,
    responseFormat: {
      type: 'json_schema',
      jsonSchema: { name: 'leitura_comprovante', strict: true, schemaDefinition: schema },
    },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: [
        { type: 'text', text: 'Extraia somente os campos visiveis desta imagem em JSON.' },
        { type: 'image_url', imageUrl: `data:${mimetype};base64,${buffer.toString('base64')}` },
      ] },
    ],
  }, { timeoutMs: 15000, retries: { strategy: 'none' } });
  const choice = res.choices?.[0];
  const content = choice?.message?.content;
  return {
    texto: typeof content === 'string' ? content : (Array.isArray(content)
      ? content.filter(c => c.type === 'text').map(c => c.text || '').join('') : ''),
    concluida: choice?.finishReason === 'stop' || choice?.finish_reason === 'stop',
    uso: extrairUso(res.usage),
    modelo: res.model || model,
  };
}

/**
 * Transcreve um áudio curto recebido pelo WhatsApp.
 *
 * Usa o mesmo cliente e a mesma `MISTRAL_API_KEY` da conversa. O arquivo é
 * enviado como multipart pelo próprio SDK; o nome/extensão existe porque é
 * assim que ele informa o tipo do conteúdo à API.
 */
async function transcreverAudio({ buffer, mimetype, language }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('Audio invalido para transcricao');
  }

  const tipo = String(mimetype || '').split(';')[0].trim().toLowerCase();
  const extensoes = {
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
  };
  const ext = extensoes[tipo] || 'ogg';
  const model = process.env.VOXTRAL_MODEL || 'voxtral-mini-latest';
  // A API recebe context_bias no modo `comma_separated` e recusa termos com
  // espaços ou vírgulas. A primeira versão usava "Point Burger" e fazia toda
  // nota de voz falhar com HTTP 400 antes mesmo da transcrição.
  const contextBias = [
    'Point-Burger', 'X-Burger', 'X-Egg-Burger', 'X-Salada', 'X-Egg-Salada',
    'Bacon-Burger', 'Egg-Bacon', 'X-Calabresa-Bacon', 'X-Tudo', 'X-Tudão',
    'Hot-Especial', 'Hot-Completo', 'Hot-Tudo', 'salsicha', 'mussarela',
  ];
  const res = await getClient().audio.transcriptions.complete({
    model,
    file: { fileName: `audio.${ext}`, content: buffer },
    language: ['pt', 'en', 'es'].includes(language) ? language : undefined,
    temperature: 0,
    contextBias,
  }, { timeoutMs: 60000, retries: { strategy: 'none' } });

  return {
    texto: String(res.text || '').trim(),
    segundos: Number(
      res.usage?.promptAudioSeconds ?? res.usage?.prompt_audio_seconds ?? 0
    ) || 0,
    modelo: res.model || model,
  };
}

module.exports = { conversar, lerComprovante, transcreverAudio };
