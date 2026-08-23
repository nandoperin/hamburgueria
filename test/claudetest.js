/**
 * O adaptador da Anthropic: a conversão de mensagens, e a extração de uso.
 *
 * `cachingtest.js` prova o mecanismo de cache do Mistral. Esta suíte prova o
 * mesmo tipo de coisa para `claude.js` — mas o risco aqui é outro: a Anthropic
 * não tem `role: 'tool'`, e conta cache de um jeito **oposto** ao do Mistral
 * (baldes separados, não subconjunto). Um erro de qualquer um dos dois não
 * quebra a conversa (a API aceitaria e responderia) — quebra silenciosamente
 * a contagem de tokens ou o histórico que o modelo vê, o que é pior: parece
 * funcionar, e não funciona direito.
 *
 * Mocka o SDK na fronteira (a classe `Anthropic`), do mesmo jeito que
 * `cachingtest.js` mocka a classe `Mistral` — o que importa é o payload que
 * sairia pela rede, não uma função interna.
 */

process.env.ANTHROPIC_API_KEY = 'fake-key-de-teste';

const PROJECT = require('path').resolve(__dirname, '..');

let ultimoPayload = null;
let proximaResposta = null;

const sdkPath = require.resolve(`${PROJECT}/node_modules/@anthropic-ai/sdk`);
require(sdkPath);
require.cache[sdkPath].exports = class {
  constructor() {
    this.messages = {
      create: async (payload) => {
        ultimoPayload = payload;
        return (
          proximaResposta || {
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 100, output_tokens: 10 },
          }
        );
      },
    };
  }
};

const claude = require(`${PROJECT}/src/ai/claude`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  // -------------------------------------- 1. system vira bloco com cache
  console.log('\n\x1b[36m### 1. O SYSTEM PROMPT VAI COM cache_control ###\x1b[0m');
  await claude.conversar({ system: 'Você é o atendente da Point Burger.', mensagens: [] });

  checar(Array.isArray(ultimoPayload.system), 'system virou array de blocos, não string solta');
  checar(
    ultimoPayload.system[0].cache_control?.type === 'ephemeral',
    'o bloco carrega cache_control — sem isso não há caching nenhum'
  );
  checar(
    ultimoPayload.system[0].text === 'Você é o atendente da Point Burger.',
    'e o texto é exatamente o que foi passado, sem alteração'
  );

  // -------------------------------- 2. sem system, sem quebrar o payload
  console.log('\n\x1b[36m### 2. SEM SYSTEM, O CAMPO SOME ###\x1b[0m');
  await claude.conversar({ system: '', mensagens: [] });
  checar(ultimoPayload.system === undefined, 'system vazio não manda array de bloco vazio');

  // ------------------------------------ 3. ferramentas passam quase cruas
  console.log('\n\x1b[36m### 3. O ESQUEMA DE FERRAMENTAS NAO E REESCRITO ###\x1b[0m');
  const ferramenta = { name: 'definir_cidade', description: 'x', input_schema: { type: 'object' } };
  await claude.conversar({ system: 'x', mensagens: [], ferramentas: [ferramenta] });
  checar(
    ultimoPayload.tools[0] === ferramenta,
    'tools.js já usa o formato nativo da Anthropic — nenhuma conversão por cima'
  );

  // ---------------------------------------- 4. historico: usuario e assistant
  console.log('\n\x1b[36m### 4. HISTORICO SIMPLES VIRA MENSAGENS SIMPLES ###\x1b[0m');
  await claude.conversar({
    system: 'x',
    mensagens: [
      { role: 'user', content: 'quero um x-burger' },
      { role: 'assistant', content: 'beleza!' },
    ],
  });
  checar(
    ultimoPayload.messages[0].role === 'user' && ultimoPayload.messages[0].content === 'quero um x-burger',
    'mensagem de usuário passa direto'
  );
  checar(
    ultimoPayload.messages[1].role === 'assistant' && ultimoPayload.messages[1].content === 'beleza!',
    'mensagem de assistant sem chamada também passa direto'
  );

  // --------------------------- 5. chamada de ferramenta vira tool_use
  console.log('\n\x1b[36m### 5. CHAMADA DE FERRAMENTA VIRA BLOCO tool_use ###\x1b[0m');
  await claude.conversar({
    system: 'x',
    mensagens: [
      {
        role: 'assistant',
        content: 'vou verificar',
        chamadas: [{ id: 'call_1', nome: 'definir_cidade', argumentos: { cidade: 'Chelsea' } }],
      },
    ],
  });
  const turnoAssistant = ultimoPayload.messages[0];
  checar(turnoAssistant.role === 'assistant', 'ainda é um turno assistant');
  checar(
    turnoAssistant.content[0].type === 'text' && turnoAssistant.content[0].text === 'vou verificar',
    'o texto que o modelo disse antes de chamar a ferramenta não se perde'
  );
  checar(
    turnoAssistant.content[1].type === 'tool_use' &&
      turnoAssistant.content[1].id === 'call_1' &&
      turnoAssistant.content[1].name === 'definir_cidade' &&
      turnoAssistant.content[1].input.cidade === 'Chelsea',
    'e a chamada virou um bloco tool_use, com id/nome/argumentos corretos'
  );

  // -------------------------- 6. resultado de ferramenta vira tool_result
  console.log('\n\x1b[36m### 6. RESULTADO DE FERRAMENTA VIRA tool_result NUM TURNO user ###\x1b[0m');
  await claude.conversar({
    system: 'x',
    mensagens: [
      { role: 'tool', tool_call_id: 'call_1', nome: 'definir_cidade', content: 'Chelsea aceita.' },
    ],
  });
  const turnoTool = ultimoPayload.messages[0];
  checar(
    turnoTool.role === 'user',
    'a Anthropic não tem role "tool" — o resultado vira turno "user" com um bloco tool_result'
  );
  checar(
    turnoTool.content[0].type === 'tool_result' &&
      turnoTool.content[0].tool_use_id === 'call_1' &&
      turnoTool.content[0].content === 'Chelsea aceita.',
    'com o tool_use_id certo, casando com a chamada que o gerou'
  );

  // ----------------------- 7. resposta com tool_use vira "chamadas"
  console.log('\n\x1b[36m### 7. A RESPOSTA COM tool_use VIRA "chamadas" ###\x1b[0m');
  proximaResposta = {
    content: [
      { type: 'text', text: 'já registrei' },
      { type: 'tool_use', id: 'call_2', name: 'definir_entrega', input: { tipo: 'delivery' } },
    ],
    usage: { input_tokens: 50, output_tokens: 20 },
  };
  const r7 = await claude.conversar({ system: 'x', mensagens: [] });
  checar(r7.texto === 'já registrei', 'o texto sai concatenado dos blocos type:text');
  checar(
    r7.chamadas.length === 1 &&
      r7.chamadas[0].id === 'call_2' &&
      r7.chamadas[0].nome === 'definir_entrega' &&
      r7.chamadas[0].argumentos.tipo === 'delivery',
    'e o tool_use vira uma chamada, no mesmo formato que o resto do projeto espera'
  );

  // ---------------------------- 8. uso: os baldes da Anthropic, normalizados
  console.log('\n\x1b[36m### 8. tokensIn E O TOTAL, NAO SO A FATIA "sem cache" ###\x1b[0m');
  proximaResposta = {
    content: [{ type: 'text', text: 'oi' }],
    usage: {
      input_tokens: 26,
      output_tokens: 40,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 0,
    },
  };
  const r8 = await claude.conversar({ system: 'x', mensagens: [] });
  checar(
    r8.uso.tokensIn === 826,
    `tokensIn soma os três baldes (26+800=826), não só input_tokens (achou ${r8.uso.tokensIn})`
  );
  checar(r8.uso.tokensCacheados === 800, 'tokensCacheados é a fatia lida do cache');
  checar(r8.uso.tokensCacheEscrita === 0, 'sem escrita nesta chamada, o campo é 0, não undefined');

  // ---------------------------- 9. escrita no cache também soma no total
  console.log('\n\x1b[36m### 9. CACHE_CREATION TAMBEM SOMA NO tokensIn ###\x1b[0m');
  proximaResposta = {
    content: [{ type: 'text', text: 'oi' }],
    usage: { input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: 2858 },
  };
  const r9 = await claude.conversar({ system: 'x', mensagens: [] });
  checar(r9.uso.tokensIn === 2878, 'input_tokens + cache_creation — os dois compõem o total real');
  checar(r9.uso.tokensCacheEscrita === 2858, 'e a fatia escrita fica marcada, para custo.js precificar 25% a mais');

  console.log('\n\x1b[32mclaudetest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
