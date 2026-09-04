const log = require('../log');

/**
 * O teto de gasto da IA.
 *
 * Este arquivo nasceu de uma lacuna concreta: o `.env.example` documentava
 * `AI_MAX_TOKENS_CONVERSA` e `AI_MAX_USD_DIA` desde o primeiro dia, a tabela
 * `ai_usage` existia no schema, `db.registrarUsoIA` existia em `queries.js` —
 * e **nada chamava nada disso**. O agente somava tokens em `sess.aiTokens`, e
 * ninguém lia esse número.
 *
 * O efeito é pior que não ter teto nenhum: quem lê o `.env.example` acredita
 * que há um limite diário protegendo a conta. Não havia. Um modelo em
 * laço, ou um cliente mandando mensagem sem parar, viraria fatura sem que nada
 * avisasse — e sem registro nenhum para descobrir depois quanto custou.
 *
 * ## O desenho
 *
 * Dois tetos, porque são dois riscos diferentes:
 *
 * - **Por conversa** (`AI_MAX_TOKENS_CONVERSA`): um telefone só. Protege do
 *   cliente que conversa sem fechar pedido, e do laço de ferramentas que não
 *   converge. `vazao.js` já limita a **frequência** (20 msg/min); este limita
 *   o **total**.
 * - **Por dia** (`AI_MAX_USD_DIA`): a casa toda. É o que impede que cem
 *   conversas dentro do teto individual somem uma fatura fora do orçamento.
 *
 * Estourou qualquer um dos dois, o bot **cai no fluxo numerado** — a mesma
 * rede de `AI_ENABLED=off`, só que automática. Feio, e funcionando: o cliente
 * ainda consegue pedir.
 *
 * ## A contagem do dia sobrevive a restart
 *
 * O acumulado fica em memória (o corte precisa ser síncrono — não dá para
 * esperar uma ida ao banco antes de cada chamada ao modelo), mas cada registro
 * escreve em `ai_usage` e **adota de volta o total que o banco devolve**. Isso
 * resolve dois casos de uma vez: o processo que reiniciou no meio do dia
 * recupera o gasto anterior, e duas instâncias no ar convergem para a mesma
 * soma em vez de gastarem o teto cada uma.
 */

// --------------------------------------------------------------- preço

/**
 * Preço por 1 milhão de tokens, em dólar.
 *
 * **Estes números são ponto de partida, não autoridade.** Preço de modelo muda,
 * e a verdade é a página de billing do provedor. Para fixar o valor exato sem
 * mexer em código, use `AI_PRECO_IN` / `AI_PRECO_OUT` no `.env` — eles
 * sobrescrevem a tabela inteira.
 *
 * A busca é por prefixo, para `mistral-small-latest` e `mistral-small-2506`
 * caírem na mesma linha sem precisar de entrada nova a cada versão.
 */
const PRECOS = [
  // Mistral Small 4: valores standard conferidos em 2026-09-03.
  // https://docs.mistral.ai/inference/pricing — snapshots antigos ficam abaixo.
  ['mistral-small-latest', { in: 0.15, out: 0.6 }],
  ['mistral-small-2603', { in: 0.15, out: 0.6 }],
  ['ministral-3b', { in: 0.04, out: 0.04 }],
  ['ministral-8b', { in: 0.1, out: 0.1 }],
  ['mistral-small', { in: 0.1, out: 0.3 }],
  ['mistral-medium', { in: 0.4, out: 2.0 }],
  ['mistral-large', { in: 2.0, out: 6.0 }],
  ['claude-haiku', { in: 1.0, out: 5.0 }],
  ['claude-sonnet', { in: 3.0, out: 15.0 }],
  // Opus 5 e 4.x sao $5/$25. A entrada anterior dizia $15/$75 — preco da
  // geracao antiga, que teria inflado a conta em 3x e disparado o teto cedo.
  // Exemplo de por que a linha abaixo da tabela existe: isto envelhece.
  ['claude-opus', { in: 5.0, out: 25.0 }],
  ['claude-fable', { in: 10.0, out: 50.0 }],
  // Precos da OpenAI NAO foram verificados contra a pagina de billing deles —
  // sao estimativa. Se for usar, confirme e fixe com AI_PRECO_IN/OUT.
  ['gpt-5-mini', { in: 0.25, out: 2.0 }],
  ['gpt-5', { in: 1.25, out: 10.0 }],
];

/**
 * Modelo fora da tabela custa o mais caro que conhecemos.
 *
 * A alternativa — assumir zero — reproduziria exatamente o defeito que este
 * arquivo conserta: um teto que nunca dispara. Errar para cima faz o teto
 * disparar cedo demais, que é chato e visível; errar para baixo faz ele nunca
 * disparar, que é caro e invisível. Entre as duas, a barulhenta.
 */
const DESCONHECIDO = { in: 15.0, out: 75.0 };

const jaAvisou = new Set();

function precoDoModelo(modelo) {
  const envIn = parseFloat(process.env.AI_PRECO_IN);
  const envOut = parseFloat(process.env.AI_PRECO_OUT);
  if (Number.isFinite(envIn) && Number.isFinite(envOut)) {
    return { in: envIn, out: envOut };
  }

  const nome = String(modelo || '').toLowerCase();
  const achado = PRECOS.find(([prefixo]) => nome.startsWith(prefixo));
  if (achado) return achado[1];

  if (!jaAvisou.has(nome)) {
    jaAvisou.add(nome);
    log.warn(
      { evt: 'ia_custo', modelo: nome },
      `modelo "${nome}" fora da tabela de preços — contando pelo mais caro. ` +
        'Fixe AI_PRECO_IN e AI_PRECO_OUT com o valor da sua página de billing.'
    );
  }
  return DESCONHECIDO;
}

/**
 * Prompt caching: ler do cache custa 10% do preço normal.
 *
 * É o número que a Mistral documenta para o `prompt_cache_key`
 * (`mistral.js#chaveDeCache`) e também o que a Anthropic cobra por
 * `cache_read_input_tokens` — as duas convergem nesse valor, por acaso ou não.
 */
const DESCONTO_CACHE_LEITURA = 0.1;

/**
 * Escrever num prefixo novo no cache custa 25% A MAIS, não menos.
 *
 * Só a Anthropic tem essa cobrança hoje (`cache_creation_input_tokens` —
 * ver `claude.js#extrairUso`); o Mistral não documenta prêmio de escrita, e
 * `tokensCacheEscrita` chega `undefined` para ele, que vira 0 abaixo.
 */
const PREMIO_CACHE_ESCRITA = 1.25;

/**
 * Custo em dólar de uma chamada.
 *
 * `tokensIn` é o **contrato comum**: o total de tokens de entrada, não
 * importa a convenção de billing do provedor. É trabalho de cada adaptador
 * normalizar para isso — a Mistral trata `cached` como subconjunto do total;
 * a Anthropic separa `input`/`cache_read`/`cache_creation` em três baldes que
 * juntos formam o total (`claude.js#extrairUso` documenta o porquê). Aqui só
 * importa que `tokensCacheados` e `tokensCacheEscrita`, somados, nunca passem
 * de `tokensIn` — dali para baixo é só aplicar o preço de cada fatia.
 */
function calcular(uso, modelo) {
  const p = precoDoModelo(modelo);
  const tokensIn = uso?.tokensIn || 0;
  const precoPorToken = p.in / 1e6;

  // Math.min em cascata por segurança: um valor de API estranho não pode
  // fazer a conta dar fatia "normal" negativa.
  const lidos = Math.min(uso?.tokensCacheados || 0, tokensIn);
  const escritos = Math.min(uso?.tokensCacheEscrita || 0, tokensIn - lidos);
  const normais = tokensIn - lidos - escritos;

  const entrada =
    normais * precoPorToken +
    lidos * precoPorToken * DESCONTO_CACHE_LEITURA +
    escritos * precoPorToken * PREMIO_CACHE_ESCRITA;
  const saida = (uso?.tokensOut || 0) * (p.out / 1e6);
  return entrada + saida;
}

// ---------------------------------------------------------------- tetos

/**
 * Lê um teto do ambiente.
 *
 * Ausente cai no padrão documentado no `.env.example`, e **não** em "sem
 * teto": a variável que some por descuido não pode reabrir o buraco que este
 * arquivo fecha. Zero explícito desliga — é uma decisão que alguém precisa
 * digitar de propósito, não um esquecimento.
 */
function teto(nome, padrao) {
  const bruto = process.env[nome];
  if (bruto === undefined || bruto === '') return padrao;
  const n = parseFloat(bruto);
  return Number.isFinite(n) && n >= 0 ? n : padrao;
}

const maxTokensConversa = () => teto('AI_MAX_TOKENS_CONVERSA', 120000);
const LIMITE_MAXIMO_USD_DIA = 10;
const maxUsdDia = () => {
  const configurado = teto('AI_MAX_USD_DIA', LIMITE_MAXIMO_USD_DIA);
  // Zero continua sendo a decisão explícita de desligar o teto. Qualquer outro
  // valor pode reduzir a trava, mas não ultrapassar os US$10 aprovados.
  return configurado === 0 ? 0 : Math.min(configurado, LIMITE_MAXIMO_USD_DIA);
};

// ------------------------------------------------------- acumulado do dia

function diaDeHoje() {
  return new Date().toISOString().slice(0, 10);
}

function zerado(dia) {
  return { dia, chamadas: 0, tokensIn: 0, tokensOut: 0, custoUsd: 0 };
}

let hoje = zerado(diaDeHoje());

/** Vira o dia sozinho — um processo que fica dias no ar não acumula para sempre. */
function acumulador() {
  const dia = diaDeHoje();
  if (hoje.dia !== dia) hoje = zerado(dia);
  return hoje;
}

// ------------------------------------------------------------- a pergunta

/**
 * Pode chamar o modelo agora?
 *
 * Síncrona de propósito: é consultada antes de cada chamada paga, e uma ida ao
 * banco aqui dobraria a latência de toda mensagem para proteger de um caso que
 * acontece uma vez por mês.
 *
 * @returns {{ ok: boolean, motivo?: 'conversa'|'dia', detalhe?: string }}
 */
function podeChamar(sess) {
  const tokens = sess?.aiTokens || 0;
  const tetoConversa = maxTokensConversa();
  if (tetoConversa > 0 && tokens >= tetoConversa) {
    return {
      ok: false,
      motivo: 'conversa',
      detalhe: `${tokens} tokens nesta conversa (teto ${tetoConversa})`,
    };
  }

  const acc = acumulador();
  const tetoDia = maxUsdDia();
  if (tetoDia > 0 && acc.custoUsd >= tetoDia) {
    return {
      ok: false,
      motivo: 'dia',
      detalhe: `$${acc.custoUsd.toFixed(2)} gastos hoje (teto $${tetoDia.toFixed(2)})`,
    };
  }

  return { ok: true };
}

// ------------------------------------------------------------- o registro

/**
 * Contabiliza uma chamada ao modelo.
 *
 * Soma na sessão e no acumulador do dia **na hora** (o corte depende disso), e
 * grava no banco em segundo plano. A gravação nunca derruba a conversa: banco
 * fora do ar é motivo para perder o histórico de custo, não para o cliente
 * deixar de ser atendido — e o teto continua valendo pelo número em memória.
 */
function registrar(sess, uso, modelo) {
  if (!uso) return 0;

  const tokensIn = uso.tokensIn || 0;
  const tokensOut = uso.tokensOut || 0;
  const custoUsd = calcular(uso, modelo);

  if (sess) sess.aiTokens = (sess.aiTokens || 0) + tokensIn + tokensOut;

  const acc = acumulador();
  acc.chamadas += 1;
  acc.tokensIn += tokensIn;
  acc.tokensOut += tokensOut;
  acc.custoUsd += custoUsd;

  // Só para o log: prova visível de que o prompt caching está funcionando,
  // sem exigir coluna nova em `ai_usage` — o que a tabela precisa registrar é
  // o dólar já com o desconto aplicado, e `custoUsd` acima já é esse número.
  const cacheados = Math.min(uso.tokensCacheados || 0, tokensIn);
  const escritos = Math.min(uso.tokensCacheEscrita || 0, tokensIn - cacheados);
  const partes = [];
  if (cacheados) partes.push(`${cacheados} lidos do cache`);
  if (escritos) partes.push(`${escritos} escritos no cache`);
  const cacheTxt = partes.length ? `, ${partes.join(', ')}` : '';

  log.info(
    {
      evt: 'ia_custo',
      modelo,
      tokensIn,
      tokensOut,
      tokensCacheados: cacheados,
      tokensCacheEscrita: escritos,
      custoUsd: Number(custoUsd.toFixed(6)),
      diaUsd: Number(acc.custoUsd.toFixed(4)),
    },
    `IA: ${tokensIn}+${tokensOut} tok${cacheTxt}, $${custoUsd.toFixed(4)} (dia: $${acc.custoUsd.toFixed(2)})`
  );

  gravar({ tokensIn, tokensOut, custoUsd });
  return custoUsd;
}

/**
 * A transcrição do Voxtral é cobrada por duração, não por token.
 * Ela entra no mesmo acumulador e na mesma linha diária do banco para o teto
 * de US$10 continuar representando todo o gasto de IA do bot.
 */
function registrarAudio(sess, segundos, modelo = 'voxtral-mini-latest') {
  const duracao = Math.max(0, Number(segundos) || 0);
  const configurado = parseFloat(process.env.VOXTRAL_PRECO_MINUTO);
  const precoMinuto = Number.isFinite(configurado) && configurado >= 0
    ? configurado
    : 0.003;
  const custoUsd = (duracao / 60) * precoMinuto;

  if (sess) sess.aiAudioSeconds = (sess.aiAudioSeconds || 0) + duracao;

  const acc = acumulador();
  acc.chamadas += 1;
  acc.custoUsd += custoUsd;

  log.info(
    {
      evt: 'ia_custo',
      tipo: 'audio',
      modelo,
      segundos: duracao,
      custoUsd: Number(custoUsd.toFixed(6)),
      diaUsd: Number(acc.custoUsd.toFixed(4)),
    },
    `IA áudio: ${duracao}s, $${custoUsd.toFixed(4)} (dia: $${acc.custoUsd.toFixed(2)})`
  );

  gravar({ tokensIn: 0, tokensOut: 0, custoUsd });
  return custoUsd;
}

/**
 * A ida ao banco, isolada e sem `await` de quem chama.
 *
 * O `require` é preguiçoso porque `queries.js` monta o cliente do Supabase ao
 * ser carregado, e este módulo é exercitado em suíte que não tem banco.
 */
function gravar(delta) {
  let db;
  try {
    db = require('../db/queries');
  } catch {
    return;
  }
  if (typeof db.registrarUsoIA !== 'function') return;

  Promise.resolve(db.registrarUsoIA(delta))
    .then((linha) => {
      // O banco é a soma de todas as instâncias e de antes do restart. Adotar o
      // total dele fecha a diferença sem uma consulta a mais: o upsert já lê.
      if (!linha) return;
      const acc = acumulador();
      if (linha.dia && linha.dia !== acc.dia) return;
      acc.custoUsd = Math.max(acc.custoUsd, Number(linha.custo_usd) || 0);
      acc.tokensIn = Math.max(acc.tokensIn, Number(linha.tokens_in) || 0);
      acc.tokensOut = Math.max(acc.tokensOut, Number(linha.tokens_out) || 0);
      acc.chamadas = Math.max(acc.chamadas, Number(linha.chamadas) || 0);
    })
    .catch((err) => {
      log.warn({ evt: 'ia_custo', err }, 'falha ao gravar ai_usage (teto segue em memória)');
    });
}

/**
 * Recupera o gasto de hoje do banco.
 *
 * Chamado uma vez no boot: sem isto, o processo que reinicia às 14h começa o
 * dia do zero e o teto diário vale o dobro. Falha em silêncio — não ter o
 * histórico é ruim, não subir o bot é pior.
 */
async function semear() {
  try {
    const db = require('../db/queries');
    if (typeof db.getUsoIA !== 'function') return;
    const linha = await db.getUsoIA();
    if (!linha) return;
    const acc = acumulador();
    if (linha.dia && linha.dia !== acc.dia) return;
    acc.chamadas = Number(linha.chamadas) || 0;
    acc.tokensIn = Number(linha.tokens_in) || 0;
    acc.tokensOut = Number(linha.tokens_out) || 0;
    acc.custoUsd = Number(linha.custo_usd) || 0;
    log.info(
      { evt: 'ia_custo', diaUsd: acc.custoUsd },
      `gasto de IA já registrado hoje: $${acc.custoUsd.toFixed(2)}`
    );
  } catch (err) {
    log.warn({ evt: 'ia_custo', err }, 'não foi possível ler o gasto de IA do dia');
  }
}

/** O acumulado de hoje, para o painel e para o `!conferir` do dono. */
function estado() {
  const acc = acumulador();
  return {
    dia: acc.dia,
    chamadas: acc.chamadas,
    tokensIn: acc.tokensIn,
    tokensOut: acc.tokensOut,
    custoUsd: acc.custoUsd,
    tetoUsdDia: maxUsdDia(),
    tetoTokensConversa: maxTokensConversa(),
  };
}

/** Só para as suítes: recomeça o dia. */
function _zerar() {
  hoje = zerado(diaDeHoje());
}

module.exports = {
  calcular,
  podeChamar,
  registrar,
  registrarAudio,
  semear,
  estado,
  precoDoModelo,
  _zerar,
};
