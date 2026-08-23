/**
 * Prompt caching do Mistral: a chave que sai no fio, e o desconto que volta.
 *
 * `custotest.js` prova a matemática do desconto (10% na fatia cacheada).
 * Esta suíte prova a outra ponta, que `custotest` não alcança: o que
 * `mistral.js` de fato manda para a API, e o que ele sabe ler de volta.
 *
 * Sem isto, um erro de digitação em `promptCacheKey` (o SDK usa camelCase;
 * `prompt_cache_key` sairia sem efeito nenhum, silenciosamente) só apareceria
 * como uma conta que nunca fica mais barata — dias depois, difícil de
 * rastrear até aqui. E um erro na extração do `cached_tokens` de volta faria
 * o desconto nunca ser aplicado, mesmo com o cache funcionando do lado do
 * Mistral.
 *
 * Mocka o SDK na fronteira (a classe `Mistral`), não `chaveDeCache` por
 * dentro — o que importa é o payload que sai pela rede, não a função que o
 * gerou.
 */

process.env.MISTRAL_API_KEY = 'fake-key-de-teste';

const PROJECT = require('path').resolve(__dirname, '..');

let ultimoPayload = null;
let proximaResposta = null;

const sdkPath = require.resolve(`${PROJECT}/node_modules/@mistralai/mistralai`);
require(sdkPath);
require.cache[sdkPath].exports = {
  Mistral: class {
    constructor() {
      this.chat = {
        complete: async (payload) => {
          ultimoPayload = payload;
          return (
            proximaResposta || {
              choices: [{ message: { content: 'ok', toolCalls: [] } }],
              usage: { promptTokens: 100, completionTokens: 10 },
            }
          );
        },
      };
    }
  },
};

const mistral = require(`${PROJECT}/src/ai/mistral`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  // ------------------------------------------ 1. a chave sai no payload
  console.log('\n\x1b[36m### 1. A CHAVE VAI NO CAMPO CERTO ###\x1b[0m');
  await mistral.conversar({ system: 'Você é o atendente da Point Burger.', mensagens: [] });

  checar(typeof ultimoPayload.promptCacheKey === 'string', 'promptCacheKey foi enviado');
  checar(ultimoPayload.promptCacheKey.length > 0, 'e não é uma string vazia');
  checar(
    ultimoPayload.prompt_cache_key === undefined,
    'só na grafia do SDK (camelCase) — não manda as duas, o SDK cuida da conversão'
  );

  // ------------------------------------- 2. mesmo prompt, mesma chave
  console.log('\n\x1b[36m### 2. MESMO PROMPT, MESMA CHAVE ###\x1b[0m');
  const chave1 = ultimoPayload.promptCacheKey;

  await mistral.conversar({ system: 'Você é o atendente da Point Burger.', mensagens: [] });
  const chave2 = ultimoPayload.promptCacheKey;

  checar(chave1 === chave2, 'chamadas com o mesmo system prompt reaproveitam a chave — é o que gera o hit');

  // ------------------------------ 3. prompt diferente, chave diferente
  console.log('\n\x1b[36m### 3. CARDAPIO EDITADO MUDA A CHAVE ###\x1b[0m');
  await mistral.conversar({
    system: 'Você é o atendente da Point Burger. Cardápio: X-Bacon $15.',
    mensagens: [],
  });
  const chave3 = ultimoPayload.promptCacheKey;

  checar(
    chave3 !== chave1,
    'um system prompt diferente (ex.: preço editado no painel) gera outra chave — sem isso o cliente veria preço velho "em cache"'
  );

  // ---------------------------------------- 4. sem system, sem chave
  console.log('\n\x1b[36m### 4. SEM SYSTEM PROMPT, SEM CHAVE ###\x1b[0m');
  await mistral.conversar({ system: '', mensagens: [] });
  checar(
    ultimoPayload.promptCacheKey === undefined,
    'system vazio não gera chave — nada de cachear string vazia'
  );

  // -------------------------------- 5. tokens cacheados voltam pro custo
  console.log('\n\x1b[36m### 5. O DESCONTO VOLTA NO uso ###\x1b[0m');
  proximaResposta = {
    choices: [{ message: { content: 'oi', toolCalls: [] } }],
    usage: {
      promptTokens: 2900,
      completionTokens: 40,
      promptTokensDetails: { cachedTokens: 2858 },
    },
  };
  const r1 = await mistral.conversar({ system: 'x', mensagens: [] });
  checar(r1.uso.tokensCacheados === 2858, 'camelCase (promptTokensDetails.cachedTokens) é lido');

  // A API REST documenta snake_case; o SDK pode devolver qualquer um dos dois
  // dependendo da versão — a mesma cautela que already existe para tokensIn/Out.
  proximaResposta = {
    choices: [{ message: { content: 'oi', toolCalls: [] } }],
    usage: {
      prompt_tokens: 2900,
      completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 2858 },
    },
  };
  const r2 = await mistral.conversar({ system: 'x', mensagens: [] });
  checar(r2.uso.tokensCacheados === 2858, 'snake_case (prompt_tokens_details.cached_tokens) também é lido');

  proximaResposta = {
    choices: [{ message: { content: 'oi', toolCalls: [] } }],
    usage: { promptTokens: 50, completionTokens: 5 },
  };
  const r3 = await mistral.conversar({ system: 'x', mensagens: [] });
  checar(r3.uso.tokensCacheados === 0, 'resposta sem detalhe de cache não quebra — cai em 0, não undefined');

  console.log('\n\x1b[32mcachingtest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
