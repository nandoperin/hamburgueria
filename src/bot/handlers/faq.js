const { t, suporte, emailSuporte } = require('../../i18n');
const faqs = require('../../../config/faq.json');

/**
 * Perguntas frequentes, respondidas sem tirar o cliente do lugar.
 *
 * O FAQ é um parêntese: o router responde e retorna sem tocar no estado, então
 * o carrinho, a cidade e o ponto da conversa ficam intactos. Quem pergunta
 * sobre glúten no meio do cardápio volta a tocar no catálogo como se nada
 * tivesse acontecido.
 *
 * O que faltava era o cliente **saber disso**. As respostas mandavam "digite
 * *0*", e o `0` é o reinício — apagava o carrinho de quem só queria tirar uma
 * dúvida. Agora todas terminam com o mesmo rodapé, dizendo o que cada saída faz.
 */

/**
 * Compara sem acento — cliente no celular quase nunca acentua.
 *
 * A palavra-chave é "horário"; o cliente escreve "qual o horario?". Antes disso
 * a pergunta não casava com nada e ele recebia "não encontrei resposta", com o
 * FAQ tendo a resposta pronta ali do lado. O mesmo tratamento que os comandos
 * do admin já usavam, pelo mesmo motivo.
 */
const { ascii } = require('../../texto');
const chave = (texto) => ascii(texto).toLowerCase();

function findAnswer(lang, text) {
  const procurado = chave(text);
  for (const faq of faqs) {
    const keywords = faq.keywords[lang] || faq.keywords.en || [];
    if (keywords.some((kw) => procurado.includes(chave(kw)))) {
      return faq.answer[lang] || faq.answer.en;
    }
  }
  return null;
}

/** As respostas vivem em `faq.json`, fora do alcance do `t()`. */
function preencher(texto) {
  return String(texto)
    .replace(/\{contact\}/g, suporte())
    .replace(/\{email\}/g, emailSuporte());
}

/** Envia uma resposta do FAQ com o rodapé que ensina como seguir. */
async function responder(session, resposta, send) {
  const lang = session.lang || 'en';
  await send(preencher(resposta) + t(lang, 'faq_footer'));
}

async function handle(session, text, send) {
  const lang = session.lang || 'en';
  const answer = findAnswer(lang, text);

  // Sem resposta específica, o cliente recebe o índice — que é também o que
  // "ajuda" devolve. Antes isto era um beco: "não encontrei resposta para isso".
  await responder(session, answer || t(lang, 'faq_not_found'), send);
}

module.exports = { handle, findAnswer, responder };
