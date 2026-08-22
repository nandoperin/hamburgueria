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
 * que há um limite de US$25/dia protegendo a conta. Não havia. Um modelo em
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
  ['ministral-3b', { in: 0.04, out: 0.04 }],
  ['ministral-8b', { in: 0.1, out: 0.1 }],
  ['mistral-small', { in: 0.1, out: 0.3 }],
  ['mistral-medium', { in: 0.4, out: 2.0 }],
  ['mistral-large', { in: 2.0, out: 6.0 }],
  ['claude-haiku', { in: 1.0, out: 5.0 }],
  ['claude-sonnet', { in: 3.0, out: 15.0 }],
  ['claude-opus', { in: 15.0, out: 75.0 }],
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

/** Custo em dólar de uma chamada. */
function calcular(uso, modelo) {
  const p = precoDoModelo(modelo);
  const entrada = (uso?.tokensIn || 0) * (p.in / 1e6);
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
const maxUsdDia = () => teto('AI_MAX_USD_DIA', 25);

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

  log.info(
    {
      evt: 'ia_custo',
      modelo,
      tokensIn,
      tokensOut,
      custoUsd: Number(custoUsd.toFixed(6)),
      diaUsd: Number(acc.custoUsd.toFixed(4)),
    },
    `IA: ${tokensIn}+${tokensOut} tok, $${custoUsd.toFixed(4)} (dia: $${acc.custoUsd.toFixed(2)})`
  );

  gravar({ tokensIn, tokensOut, custoUsd });
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

module.exports = { calcular, podeChamar, registrar, semear, estado, precoDoModelo, _zerar };
