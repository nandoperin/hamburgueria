/**
 * A pergunta "isto aqui é produção?", feita de um jeito só.
 *
 * ## Por que ela vem invertida
 *
 * O reflexo é escrever `NODE_ENV === 'production'`. Num controle de segurança
 * isso está errado, e o motivo é o mesmo que fez este módulo existir.
 *
 * Perguntar "é produção?" faz a **ausência** da variável significar "não é" — e
 * portanto "pode abrir". Uma variável esquecida, um host novo, um `npm start`
 * sem `.env`, e o comportamento permissivo volta sozinho, em silêncio,
 * exatamente onde não deveria. É a mesma armadilha do `if (!secret) return true`
 * que `webhooks/meta.js` e `cloudprnt.js` tinham: o caso não previsto caindo do
 * lado aberto.
 *
 * Perguntando "alguém **disse** que isto é desenvolvimento?", o caso não
 * previsto cai do lado fechado. Quem esquece a variável em produção não perde
 * nada; quem esquece na máquina local descobre na primeira requisição, com o
 * log dizendo o nome do que falta.
 *
 * ## O custo disso
 *
 * Rodar o bot na máquina sem `NODE_ENV` passa a exigir os segredos. É por isso
 * que `.env.example` já traz `NODE_ENV=development` e `test/run.js` fixa `test`
 * para as suítes. Uma linha de configuração, uma vez, contra uma classe inteira
 * de falha silenciosa em produção.
 */

const AMBIENTES_ABERTOS = ['development', 'test'];

/** Alguém declarou explicitamente que este processo não é produção? */
function ehDesenvolvimento() {
  return AMBIENTES_ABERTOS.includes((process.env.NODE_ENV || '').toLowerCase());
}

/**
 * Os segredos de autenticação são obrigatórios aqui?
 *
 * Onde isto responde `true`, a falta de um segredo **fecha a porta** em vez de
 * liberar: 401 no webhook da Meta, 503 no CloudPRNT, e o `/health` reprovando
 * com o nome da variável que sumiu. Ver `docs/SEGURANCA.md`.
 */
function exigeSegredos() {
  return !ehDesenvolvimento();
}

module.exports = { ehDesenvolvimento, exigeSegredos };
