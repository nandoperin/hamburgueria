const log = require('../log');

/**
 * Teto de mensagens por telefone.
 *
 * ## O que isto protege
 *
 * Não é CPU — o bot é leve e o Railway aguenta. É **dinheiro e atenção**. Cada
 * mensagem recebida provoca pelo menos uma resposta, e a partir de 01/10/2026 a
 * Meta cobra por mensagem enviada. Um número em laço, de graça, vira fatura.
 *
 * E antes da fatura vem o ruído: uma rajada enterra no log as linhas que
 * importam — a comanda que não imprimiu, o pagamento que não fechou — bem no
 * momento em que alguém precisaria encontrá-las.
 *
 * ## Por que responder uma vez, e depois calar
 *
 * Responder a cada mensagem da rajada é exatamente o que a rajada quer: dobra o
 * custo e não muda nada. Calar de primeira é pior de outro jeito — cliente que
 * digita rápido, ou que tocou seis vezes no botão achando que travou, ficaria
 * sem entender por que o bot morreu.
 *
 * Então o primeiro estouro avisa, e o resto da janela é silêncio. Quem estava
 * com pressa lê o aviso; quem estava em laço fala sozinho.
 *
 * ## O teto
 *
 * Vinte por minuto é folgado de sobra. Uma conversa inteira do cardápio à
 * confirmação gasta menos de dez mensagens do cliente — o enxugamento do fluxo
 * está medido em `enxutotest`. Ninguém navegando de verdade encosta nisto.
 */

const JANELA_MS = 60 * 1000;
const TETO = 20;

/** phone → instantes das mensagens dentro da janela. */
const registros = new Map();

/**
 * O que fazer com esta mensagem.
 *
 * @returns {'ok'|'avisar'|'silencio'}
 */
function avaliar(phone) {
  const agora = Date.now();
  const marcas = (registros.get(phone) || []).filter((t) => agora - t < JANELA_MS);

  marcas.push(agora);
  registros.set(phone, marcas);

  if (marcas.length <= TETO) return 'ok';

  if (marcas.length === TETO + 1) {
    log.warn(
      { evt: 'vazao', phone, mensagens: marcas.length },
      `teto de ${TETO} mensagens por minuto estourado — avisando e silenciando`
    );
    return 'avisar';
  }

  return 'silencio';
}

/**
 * Descarta quem parou de falar.
 *
 * Sem isto o Map cresce um registro por telefone que já escreveu ao bot e nunca
 * encolhe — um vazamento de memória dentro da própria defesa contra abuso.
 */
function varrer() {
  const agora = Date.now();
  for (const [phone, marcas] of registros) {
    if (!marcas.some((t) => agora - t < JANELA_MS)) registros.delete(phone);
  }
}

setInterval(varrer, 5 * 60 * 1000).unref();

/** Só para os testes: esquece tudo entre cenários. */
function zerar() {
  registros.clear();
}

module.exports = { avaliar, varrer, zerar, TETO, JANELA_MS };
