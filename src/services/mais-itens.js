// Etapa de montagem, não upsell: não sugere produtos e termina quando o
// cliente diz que acabou. Não volta durante a coleta de nome/endereço.
function pendente(sess) {
  return Boolean(sess.cart?.length && (sess.editingCart || (!sess.orderType && !sess.escolhaItensConcluida)));
}

function pergunta(sess) {
  if (!pendente(sess)) return null;
  sess.aguardandoMaisItens = true;
  return 'Quer algo mais? Digite menu para abrir as opções.';
}

async function responder(sess, texto, send) {
  if (!sess.aguardandoMaisItens || !pendente(sess) ||
      !['MENU', 'ORDER'].includes(sess.state) ||
      require('./preparo-salsicha').pendente(sess)) return false;
  const resposta = String(texto).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[.!?,]/g, '').trim().replace(/\s+/g, ' ');
  const terminou = ['nao', 'nao obrigado', 'nao obrigada', 'so isso', 'e so isso',
    'somente isso', 'nada mais', 'pode fechar', 'fechar', 'finalizar', 'checkout'];
  let mensagem;
  if (terminou.includes(resposta)) {
    sess.escolhaItensConcluida = true;
    sess.aguardandoMaisItens = false;
    sess.editingCart = false;
    sess.menuSelection = null;
    if (!require('../ai/provider').habilitada()) {
      await require('../bot/handlers/order').startCheckout(sess, send);
      return true;
    }
    mensagem = require('../ai/tools').mensagemColeta(sess);
    if (!mensagem) {
      await require('../bot/handlers/order').mostrarResumo(sess, send);
      return true;
    }
  } else if (['sim', 'quero', 'quero sim'].includes(resposta)) {
    sess.menuSelection = null;
    mensagem = 'O que mais você quer? Digite menu para abrir as opções.';
  } else return false;
  await send(mensagem);
  require('../ai/agente').registrarSaudacao(sess, mensagem);
  return true;
}

module.exports = { pendente, pergunta, responder };
