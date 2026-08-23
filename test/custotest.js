/**
 * O teto de gasto da IA.
 *
 * Esta suíte existe por causa de uma lacuna que durou o projeto inteiro: o
 * `.env.example` documentava `AI_MAX_TOKENS_CONVERSA` e `AI_MAX_USD_DIA`, a
 * tabela `ai_usage` estava no schema, `db.registrarUsoIA` estava escrito em
 * `queries.js` — e nada chamava nada. Quem lesse a configuração acreditaria
 * que havia um limite de US$25/dia protegendo a conta. Não havia nenhum.
 *
 * É o pior tipo de defeito: **silencioso e caro**. Não quebra nada, não aparece
 * no log, e só se descobre na fatura. Por isso os testes abaixo não conferem
 * texto bonito — conferem se a chamada paga **deixa de acontecer**.
 *
 * Nada aqui bate na rede: o provedor é substituído por um espião que conta
 * quantas vezes foi chamado, que é exatamente a grandeza em questão.
 */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';

const PROJECT = require('path').resolve(__dirname, '..');

// ------------------------------------------------------- banco de faz de conta

let gravacoes = [];
let linhaDoDia = null;

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  registrarUsoIA: async (delta) => {
    gravacoes.push(delta);
    const dia = new Date().toISOString().slice(0, 10);
    linhaDoDia = {
      dia,
      chamadas: (linhaDoDia?.chamadas || 0) + 1,
      tokens_in: (linhaDoDia?.tokens_in || 0) + delta.tokensIn,
      tokens_out: (linhaDoDia?.tokens_out || 0) + delta.tokensOut,
      custo_usd: (linhaDoDia?.custo_usd || 0) + delta.custoUsd,
    };
    return linhaDoDia;
  },
  getUsoIA: async () => linhaDoDia,
  getReport: async () => ({ orderCount: 0 }),
};

// ------------------------------------------------------- provedor espião

let chamadasAoModelo = 0;

const provPath = require.resolve(`${PROJECT}/src/ai/provider`);
const provReal = require(provPath);
require.cache[provPath].exports = {
  ...provReal,
  habilitada: () => true,
  getProviderName: () => 'mistral',
  getModelo: () => 'mistral-small-latest',
  get: () => ({
    conversar: async () => {
      chamadasAoModelo += 1;
      return { texto: 'oi!', chamadas: [], uso: { tokensIn: 3000, tokensOut: 200 } };
    },
  }),
};

const custo = require(`${PROJECT}/src/ai/custo`);
const agente = require(`${PROJECT}/src/ai/agente`);
const session = require(`${PROJECT}/src/bot/session`);

const TEL = '15551110000';

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

/** Zera tudo entre cenários — teto, acumulado, sessão e o espião. */
function limpar() {
  custo._zerar();
  gravacoes = [];
  linhaDoDia = null;
  chamadasAoModelo = 0;
  session.clear(TEL);
  delete process.env.AI_MAX_USD_DIA;
  delete process.env.AI_MAX_TOKENS_CONVERSA;
  delete process.env.AI_PRECO_IN;
  delete process.env.AI_PRECO_OUT;
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // -------------------------------------------------------- 1. o preço
  console.log('\n\x1b[36m### 1. A CONTA DO CUSTO ###\x1b[0m');
  limpar();

  // mistral-small: $0.10 entrada / $0.30 saída por 1M.
  const c1 = custo.calcular({ tokensIn: 1e6, tokensOut: 0 }, 'mistral-small-latest');
  checar(Math.abs(c1 - 0.1) < 1e-9, '1M de tokens de entrada em mistral-small = $0.10');

  const c2 = custo.calcular({ tokensIn: 0, tokensOut: 1e6 }, 'mistral-small-2506');
  checar(Math.abs(c2 - 0.3) < 1e-9, 'a busca é por prefixo — "-2506" cai na mesma linha');

  // ------------------------------------------- 2. modelo desconhecido
  console.log('\n\x1b[36m### 2. MODELO FORA DA TABELA ###\x1b[0m');
  const desconhecido = custo.calcular({ tokensIn: 1e6, tokensOut: 0 }, 'modelo-que-nao-existe');
  checar(
    desconhecido > 0,
    'modelo desconhecido NAO custa zero — teto que nunca dispara é o defeito original'
  );
  checar(desconhecido >= c1, 'e custa pelo menos o que o mais barato conhecido custa');

  // --------------------------------------------- 3. o .env manda mais
  console.log('\n\x1b[36m### 3. AI_PRECO_IN/OUT SOBRESCREVEM A TABELA ###\x1b[0m');
  process.env.AI_PRECO_IN = '2';
  process.env.AI_PRECO_OUT = '8';
  const c3 = custo.calcular({ tokensIn: 1e6, tokensOut: 1e6 }, 'mistral-small-latest');
  checar(Math.abs(c3 - 10) < 1e-9, 'o preço do .env vale mesmo para modelo que está na tabela');
  delete process.env.AI_PRECO_IN;
  delete process.env.AI_PRECO_OUT;

  // ------------------------------------- 3b. o desconto do prompt caching
  console.log('\n\x1b[36m### 3b. TOKENS CACHEADOS CUSTAM 10% ###\x1b[0m');
  process.env.AI_PRECO_IN = '1';
  process.env.AI_PRECO_OUT = '1';

  // 1000 tokens normais + 1000 cacheados: sem desconto seria $0.002; com o
  // desconto de 90% na fatia cacheada, só ela deveria custar $0.0001.
  const semCache = custo.calcular({ tokensIn: 1000, tokensOut: 0 }, 'x');
  const comCache = custo.calcular(
    { tokensIn: 2000, tokensOut: 0, tokensCacheados: 1000 },
    'x'
  );
  checar(
    Math.abs(comCache - (semCache + semCache * 0.1)) < 1e-9,
    'a fatia cacheada custa exatamente 10% do preço normal, a outra fatia custa cheio'
  );
  checar(comCache < semCache * 2, 'no total, custa menos que dobrar o preço de 1000 tokens');

  const tudoCacheado = custo.calcular(
    { tokensIn: 1000, tokensOut: 0, tokensCacheados: 1000 },
    'x'
  );
  checar(
    Math.abs(tudoCacheado - semCache * 0.1) < 1e-9,
    'e se TUDO veio do cache, o custo é 10% do preço cheio, não o preço cheio'
  );

  // tokensCacheados maior que tokensIn não pode gerar entrada "normal" negativa.
  const cacheMaiorQueTotal = custo.calcular(
    { tokensIn: 500, tokensOut: 0, tokensCacheados: 999999 },
    'x'
  );
  checar(
    cacheMaiorQueTotal > 0 && cacheMaiorQueTotal <= semCache * 0.1,
    'valor de cache maior que o total não gera custo negativo — trava no Math.min'
  );

  delete process.env.AI_PRECO_IN;
  delete process.env.AI_PRECO_OUT;

  // ------------------------------- 4. teto ausente NAO significa sem teto
  console.log('\n\x1b[36m### 4. VARIAVEL AUSENTE CAI NO PADRAO, NAO NO INFINITO ###\x1b[0m');
  limpar();
  const est = custo.estado();
  checar(est.tetoUsdDia === 25, 'sem AI_MAX_USD_DIA, o teto do dia é $25 — o do .env.example');
  checar(
    est.tetoTokensConversa === 120000,
    'sem AI_MAX_TOKENS_CONVERSA, o teto da conversa é 120000'
  );

  process.env.AI_MAX_USD_DIA = '';
  checar(
    custo.estado().tetoUsdDia === 25,
    'variável vazia também cai no padrão — apagar o valor não abre a porteira'
  );
  delete process.env.AI_MAX_USD_DIA;

  // ------------------------------------------ 5. zero desliga de propósito
  console.log('\n\x1b[36m### 5. ZERO EXPLICITO DESLIGA ###\x1b[0m');
  process.env.AI_MAX_USD_DIA = '0';
  custo.registrar(null, { tokensIn: 1e9, tokensOut: 1e9 }, 'claude-opus-4');
  checar(
    custo.estado().custoUsd > 1000,
    `o dia acumulou uma fortuna ($${custo.estado().custoUsd.toFixed(0)})`
  );
  checar(
    custo.podeChamar({ aiTokens: 0 }).ok === true,
    'e mesmo assim passa — com AI_MAX_USD_DIA=0 o teto do dia está desligado de propósito'
  );
  delete process.env.AI_MAX_USD_DIA;
  checar(
    custo.podeChamar({ aiTokens: 0 }).motivo === 'dia',
    'tirando o 0, o mesmo gasto volta a barrar — era o teto, não a contagem'
  );

  // ----------------------------------------- 6. teto da conversa barra
  console.log('\n\x1b[36m### 6. TETO POR CONVERSA ###\x1b[0m');
  limpar();
  process.env.AI_MAX_TOKENS_CONVERSA = '5000';

  const sess = session.get(TEL);
  sess.lang = 'pt';
  checar(custo.podeChamar(sess).ok, 'sessão zerada pode chamar');

  custo.registrar(sess, { tokensIn: 4000, tokensOut: 900 }, 'mistral-small-latest');
  checar(sess.aiTokens === 4900, 'os tokens somam na sessão');
  checar(custo.podeChamar(sess).ok, '4900 ainda passa (teto 5000)');

  custo.registrar(sess, { tokensIn: 200, tokensOut: 0 }, 'mistral-small-latest');
  const v = custo.podeChamar(sess);
  checar(!v.ok && v.motivo === 'conversa', '5100 barra, e o motivo é "conversa"');

  // ------------------------------ 7. o que importa: a chamada NAO acontece
  console.log('\n\x1b[36m### 7. TETO ESTOURADO = NENHUMA CHAMADA PAGA ###\x1b[0m');
  chamadasAoModelo = 0;
  const enviados = [];
  const tratou = await agente.conversar(sess, 'quero um x-bacon', async (t) => enviados.push(t));

  checar(chamadasAoModelo === 0, 'o provedor NAO foi chamado — nenhum centavo gasto');
  checar(tratou === false, 'conversar devolve false: o router cai no fluxo numerado');
  checar(enviados.length === 0, 'e nada foi dito ao cliente pela IA — quem responde é o fluxo');

  // ------------------------------------------ 8. abaixo do teto, chama
  console.log('\n\x1b[36m### 8. ABAIXO DO TETO, A CONVERSA ACONTECE ###\x1b[0m');
  limpar();
  process.env.AI_MAX_TOKENS_CONVERSA = '120000';
  const s2 = session.get(TEL);
  s2.lang = 'pt';

  const ditos = [];
  const ok = await agente.conversar(s2, 'oi', async (t) => ditos.push(t));
  checar(ok === true, 'a IA tratou a mensagem');
  checar(chamadasAoModelo === 1, 'o provedor foi chamado exatamente uma vez');
  checar(ditos.length === 1 && ditos[0] === 'oi!', 'e a fala do modelo chegou ao cliente');
  checar(s2.aiTokens === 3200, 'os tokens da chamada foram contados na sessão');

  // ------------------------------------------------- 9. gravou no banco
  console.log('\n\x1b[36m### 9. ai_usage DEIXA DE FICAR VAZIA ###\x1b[0m');
  await espera(20); // a gravação é assíncrona de propósito
  checar(gravacoes.length === 1, 'registrarUsoIA foi chamado — era o elo que faltava');
  checar(gravacoes[0].tokensIn === 3000 && gravacoes[0].tokensOut === 200, 'com os tokens certos');
  checar(gravacoes[0].custoUsd > 0, 'e com um custo em dólar, não zero');

  // -------------------------------------- 10. teto do dia corta a casa
  console.log('\n\x1b[36m### 10. TETO DO DIA ###\x1b[0m');
  limpar();
  process.env.AI_MAX_USD_DIA = '1';

  // Gasta $1.60 com um modelo caro (Opus 5, $5/1M), numa sessão que não
  // estoura o teto dela. 320k tokens é acima de qualquer conversa real — é só
  // o jeito mais direto de passar de $1 sem depender do preço exato da tabela.
  custo.registrar(null, { tokensIn: 320000, tokensOut: 0 }, 'claude-opus-5');
  checar(custo.estado().custoUsd >= 1, `gasto do dia passou de $1 ($${custo.estado().custoUsd.toFixed(2)})`);

  const s3 = session.get(TEL);
  s3.lang = 'pt';
  checar(s3.aiTokens === undefined, 'a sessão é nova — o teto dela está intacto');

  chamadasAoModelo = 0;
  const tratou3 = await agente.conversar(s3, 'oi', async () => {});
  checar(chamadasAoModelo === 0, 'mesmo com a sessão zerada, o teto do DIA barra a chamada');
  checar(tratou3 === false, 'e o bot cai no fluxo numerado');

  const v3 = custo.podeChamar(s3);
  checar(v3.motivo === 'dia', 'o motivo é "dia", e não "conversa"');

  // --------------------------------- 11. a saudação obedece o mesmo teto
  console.log('\n\x1b[36m### 11. A SAUDACAO NAO ESCAPA DO TETO ###\x1b[0m');
  chamadasAoModelo = 0;
  const saudou = await agente.saudar(s3, async () => {});
  checar(chamadasAoModelo === 0, 'saudar tambem consulta o teto antes de gastar');
  checar(saudou === false, 'e devolve false para o welcome cair no fluxo de sempre');

  console.log('\n\x1b[32mcustotest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
