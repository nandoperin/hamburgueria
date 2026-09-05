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
  // Na conversa com IA, entrega/retirada pode ter sido informada na mesma
  // mensagem em que ela perguntou "Quer algo mais?". Nesse instante
  // `pendente()` ja fica falso, mas a pergunta que o cliente esta respondendo
  // continua sendo a de mais itens. Respeite a pergunta exibida e nao devolva
  // o "nao" ao modelo para ele mostrar o carrinho e perguntar outra vez.
  const etapaDaIa = require('../ai/provider').habilitada() && sess.aguardandoMaisItens;
  if (!sess.aguardandoMaisItens || (!pendente(sess) && !etapaDaIa) ||
      !['MENU', 'ORDER'].includes(sess.state) ||
      require('./preparo-salsicha').pendente(sess)) return false;
  const resposta = String(texto).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[.!?,]/g, '').trim().replace(/\s+/g, ' ');
  const terminou = ['nao', 'nao obrigado', 'nao obrigada', 'so isso', 'e so isso',
    'somente isso', 'nada mais', 'pode fechar', 'fechar', 'finalizar', 'checkout'];
  if (etapaDaIa) terminou.push('n');
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
