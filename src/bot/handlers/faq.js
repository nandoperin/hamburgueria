const { t, suporte, emailSuporte } = require('../../i18n');
const config = require('../../services/config');

/** As perguntas vigentes. Funcao: o dono edita em execucao. */
function faqs() {
  return config.get('faq') || [];
}

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
  for (const faq of faqs()) {
    const keywords = faq.keywords[lang] || faq.keywords.en || [];
    if (keywords.some((kw) => procurado.includes(chave(kw)))) {
      return faq.answer[lang] || faq.answer.en;
    }
  }
  return null;
}

/**
 * Área de entrega, montada do `delivery.json` na hora de responder.
 *
 * Existe por causa de um bug real do projeto irmão: o FAQ dele prometia Chelsea
 * a $6,00 e Malden a $10,00 enquanto a cobrança era $7,00 nas duas. Ninguém
 * mentiu — a taxa mudou no `delivery.json` e a resposta do FAQ, escrita à mão,
 * ficou para trás. Duas fontes para o mesmo número sempre divergem; a questão é
 * só quando.
 *
 * Com `{cities}` na resposta, acrescentar cidade ou mudar preço continua sendo
 * uma linha no `delivery.json` — e o FAQ acompanha sozinho.
 */
function areaDeEntrega() {
  const delivery = require('../../services/delivery');
  const cidades = delivery.getCities();
  const pickup = delivery.getPickup();

  const linhas = cidades.map(
    (c) => `• ${c.label} — $${Number(c.delivery_fee).toFixed(2)}`
  );

  if (pickup?.enabled) {
    linhas.push(`• ${pickup.label} — sem taxa`);
  }

  return linhas.join('\n');
}

/**
 * As respostas vivem em `faq.json`, fora do alcance do `t()`.
 *
 * `{cities}` e `{hours}` sao gerados da configuracao na hora de responder — nao
 * escritos a mao aqui. Ver `areaDeEntrega()`.
 */
function preencher(texto, lang = 'pt') {
  return String(texto)
    .replace(/\{contact\}/g, suporte())
    .replace(/\{email\}/g, emailSuporte())
    .replace(/\{cities\}/g, areaDeEntrega())
    .replace(/\{pickup_address\}/g, require('../../services/delivery').enderecoRetirada() || '')
    .replace(/\{hours\}/g, require('../../services/schedule').horarioTexto(lang));
}

/**
 * O FAQ como **fatos**, para o bloco do system prompt.
 *
 * Este é o uso principal do `faq.json` desde que a IA passou a conduzir: o
 * cliente pergunta e quem responde é o modelo, com as palavras dele. O arquivo
 * deixou de ser uma lista de respostas prontas e virou o que impede o modelo de
 * inventar — ele não tem como saber que o pagamento é Zelle, quanto custa a
 * entrega em Medford ou o que leva glúten.
 *
 * O mesmo arquivo continua servindo de resposta enlatada quando a IA está
 * desligada (`AI_ENABLED=off`) ou fora do ar. Uma fonte, dois usos — e nunca
 * duas versões do mesmo fato para divergirem.
 *
 * `{cities}`, `{hours}` e `{contact}` já vão preenchidos: o modelo recebe os
 * números prontos, não a instrução de buscá-los.
 */
function paraModelo(lang = 'pt') {
  return faqs()
    .map((faq) => {
      const resposta = preencher(faq.answer[lang] || faq.answer.pt, lang);
      return `### ${faq.id}\n${resposta}`;
    })
    .join('\n\n');
}

/** Envia uma resposta do FAQ com o rodapé que ensina como seguir. */
async function responder(session, resposta, send) {
  const lang = session.lang || 'en';
  await send(preencher(resposta, lang) + t(lang, 'faq_footer'));
}

async function handle(session, text, send) {
  const lang = session.lang || 'en';
  const answer = findAnswer(lang, text);

  // Sem resposta específica, o cliente recebe o índice — que é também o que
  // "ajuda" devolve. Antes isto era um beco: "não encontrei resposta para isso".
  await responder(session, answer || t(lang, 'faq_not_found'), send);
}

module.exports = { handle, findAnswer, responder, paraModelo };
