const log = require('../log');

/**
 * Guarda as últimas 6 conversas por IA para o dono revisar no painel.
 *
 * O histórico que `ai/agente.js` mantém por telefone mistura fala real do
 * cliente com mensagens internas — contexto semeado, correções, o carrinho
 * validado pelo sistema. Nada disso é "conversa" para quem está revisando;
 * é ruído de implementação. Este módulo filtra para o que o cliente de fato
 * disse e o que o bot de fato respondeu, e só grava se sobrar alguma coisa.
 */

// Prefixos das mensagens que agente.js injeta no histórico sem o cliente ter
// escrito nada. Preso aqui, e não em agente.js, porque o formato de log é
// decisão deste módulo — agente.js não devia saber que existe.
const MARCADOR_INTERNO = /^(?:CONTEXTO DO SISTEMA|\[EVENTO_INTERNO_|\[CORRECAO_INTERNA_|Última lista exibida|Itens registrados pelo sistema:)/;

// As duas respostas fixas que `agente.js` usa só para fechar um turno de
// contexto interno — nunca foram lidas pelo cliente.
const RESPOSTA_INTERNA = new Set([
  'Entendido.',
  'Entendido. O resumo está aguardando a decisão do cliente.',
]);

function transcrever(historico) {
  const linhas = [];
  for (const msg of historico || []) {
    if (msg.role === 'user') {
      const texto = String(msg.content || '').trim();
      if (!texto || MARCADOR_INTERNO.test(texto)) continue;
      linhas.push({ de: 'cliente', texto });
    } else if (msg.role === 'assistant') {
      const texto = String(msg.content || '').trim();
      if (RESPOSTA_INTERNA.has(texto)) continue;
      const ferramentas = (msg.chamadas || []).map((c) => c.nome);
      if (!texto && !ferramentas.length) continue;
      const linha = { de: 'bot' };
      if (texto) linha.texto = texto;
      if (ferramentas.length) linha.ferramentas = ferramentas;
      linhas.push(linha);
    }
  }
  return linhas;
}

/**
 * Registra uma conversa encerrada. Best-effort: falhar aqui nunca pode
 * derrubar o fluxo real do cliente, que já terminou de qualquer forma.
 */
async function registrar(phone, historico) {
  const mensagens = transcrever(historico);
  if (!mensagens.some((m) => m.de === 'cliente')) return; // nada de real pra guardar

  try {
    await require('../db/queries').registrarConversa(phone, mensagens);
  } catch (err) {
    log.error({ evt: 'conversas_log', err }, 'falha ao registrar conversa');
  }
}

module.exports = { registrar, transcrever };
