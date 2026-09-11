// Etapa de montagem, não upsell: não sugere produtos e termina quando o
// cliente diz que acabou. Não volta durante a coleta de nome/endereço.
function pendente(sess) {
  return Boolean(sess.cart?.length && (sess.editingCart || (!sess.orderType && !sess.escolhaItensConcluida)));
}

function pergunta(sess) {
  if (!pendente(sess)) return null;
  sess.aguardandoMaisItens = true;
  return comCatalogo(sess, 'Quer algo mais?');
}

function comCatalogo(sess, inicio) {
  const link = require('../bot/notify').catalogLink();
  const lang = sess.lang || 'pt';
  if (!link) {
    const menu = lang === 'en' ? 'Type menu to see the options.'
      : lang === 'es' ? 'Escribe menu para ver las opciones.'
        : 'Digite menu para abrir as opções.';
    return `${inicio} ${menu}`;
  }
  const linha = lang === 'en' ? 'Type menu or open the WhatsApp catalog:'
    : lang === 'es' ? 'Escribe menu o abre el catálogo de WhatsApp:'
      : 'Digite menu ou clique no catálogo para ver as opções:';
  return `${inicio}\n\n*${linha}*\n${link}`;
}

/** Acrescenta o acesso ao catálogo quando a pergunta foi redigida pela IA. */
function garantirCatalogo(sess, fala) {
  if (!sess.aguardandoMaisItens || !/algo mais|mais alguma coisa|what else|anything else|algo más/i.test(fala)) {
    return fala;
  }
  const link = require('../bot/notify').catalogLink();
  if (!link || fala.includes(link)) return fala;
  // Se o modelo já escreveu a instrução curta antiga, troca pelo bloco novo
  // em vez de repetir "digite menu" duas vezes no mesmo balão.
  const semInstrucaoAntiga = fala.trim().replace(
    /\s*(?:Digite|Type|Escribe)\s+\*?menu\*?\s+para\s+(?:abrir|ver)[^\n.!?]*[.!?]?\s*$/i,
    ''
  ).trim();
  return `${semInstrucaoAntiga}\n\n${comCatalogo(sess, '').trim()}`;
}

async function responder(sess, texto, send, opcoes = {}) {
  // Depois de um carrinho nativo, a pergunta é redigida livremente pela IA.
  // "sim" pode significar "quero mais" em "Quer algo mais?", mas significa
  // "terminei" em "Só isso por enquanto?". Uma tabela fixa não conhece a
  // pergunta exibida; deixe o modelo interpretar esse par.
  if (!opcoes.forcar && require('../ai/provider').habilitada() && sess.aguardandoMaisItens) {
    return false;
  }

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
    sess.maisItensViaIaCatalogo = false;
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
    mensagem = comCatalogo(sess, 'O que mais você quer?');
  } else return false;
  await send(mensagem);
  require('../ai/agente').registrarSaudacao(sess, mensagem);
  return true;
}

module.exports = { pendente, pergunta, responder, comCatalogo, garantirCatalogo };
