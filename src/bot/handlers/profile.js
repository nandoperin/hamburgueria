const { t } = require('../../i18n');
const { curto, LIMITES } = require('../../entrada');

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;

/**
 * Extrai nome e email de uma mensagem só.
 *
 * Aceita as duas informações em qualquer ordem, separadas por linha,
 * vírgula ou espaço — é como as pessoas escrevem naturalmente.
 */
function parseProfile(text) {
  const emailMatch = text.match(EMAIL_RE);
  const email = emailMatch ? emailMatch[0].toLowerCase() : null;

  const name = text
    .replace(EMAIL_RE, ' ')
    .split(/[\n,;]+/)
    .map((part) => part.trim())
    .find((part) => part.length >= 2);

  // O corte é aqui, e não no `handle`, porque o nome sai daqui para três
  // lugares que não têm como se defender sozinhos: a comanda impressa (onde um
  // nome absurdo consome o rolo inteiro) e o banco.
  return {
    name: name ? curto(name, LIMITES.nome) : null,
    email: email ? curto(email, LIMITES.email) : null,
  };
}

/**
 * Estado PROFILE — cliente novo informa o nome, e o email se quiser.
 *
 * Só o nome é obrigatório. Quem não mandar email segue direto para a entrega:
 * insistir custava uma mensagem cobrada e travava quem só quer comprar. O email
 * serve para a lista de promoções, não para o pedido.
 */
async function handle(session, text, send) {
  const lang = session.lang;
  const { name, email } = parseProfile(text);

  if (!name) {
    await send(t(lang, 'profile_need_name'));
    return;
  }

  session.name = name;
  session.email = email;

  // O agradecimento vai junto do resumo, que é a próxima mensagem — sozinho
  // ele só confirma o que o cliente acabou de digitar.
  const obrigado = t(lang, 'profile_saved', { name });

  // O cadastro agora é pedido no checkout, com o carrinho já montado — então
  // daqui se volta para lá. Carrinho vazio só acontece em fluxo interrompido;
  // nesse caso recomeça pela entrega.
  if (session.cart.length) {
    await require('./order').startCheckout(session, send, obrigado);
    return;
  }
  await require('./ordertype').ask(session, send, obrigado);
}

module.exports = { handle, parseProfile };
