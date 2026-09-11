const log = require('../log');
const notify = require('../bot/notify');
const { paraAdmin } = require('../texto');
const { t } = require('../i18n');

/**
 * Cliente que precisa de uma pessoa: reclamação, estorno ou "falar com
 * atendente".
 *
 * Na primeira noite real (10/09) isso ia para a IA, que respondia qualquer
 * coisa e ninguém da loja ficava sabendo: uma cliente pediu estorno de um
 * pedido que chegou incompleto e passou meia hora mandando "ainda não recebi
 * o retorno"; outro escreveu "Falar com atendente" e recebeu resposta de robô.
 *
 * Agora o bot sai da frente:
 *
 *   1. os admins recebem a mensagem, com o último pedido do cliente;
 *   2. o cliente ouve que uma pessoa vai responder;
 *   3. por 30 minutos o bot fica em silêncio com esse cliente — o que ele
 *      mandar (texto ou foto) vai direto para os admins. A janela renova a
 *      cada mensagem e acaba sozinha, com `!bot <pedido>`, ou quando ele manda
 *      um carrinho do catálogo (aí ele quer pedir).
 *
 * Em memória, de propósito: um deploy devolve o cliente ao bot, e isso é o
 * lado seguro — nunca um cliente preso no silêncio.
 */

const JANELA_MS = 30 * 60 * 1000;
// Teto de mensagens repassadas por atendimento: ninguém enche o WhatsApp dos
// admins só escrevendo sem parar.
const MAX_REPASSES = 20;
const TRECHO_MAX = 500;

/** phone → { ate, repasses, motivo, pedidoId } */
const abertos = new Map();

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, ' ')
    .trim();
}

const PADROES = {
  atendente: new RegExp(
    '\\b(?:atendente|atendimento humano|humano|pessoa de verdade|gerente|' +
    'falar com (?:alguem|uma pessoa|a pessoa|o dono|a dona|o responsavel|a responsavel|voces)|' +
    'real person|human|manager|speak to (?:someone|a person)|' +
    'hablar con (?:alguien|una persona)|persona real)\\b'
  ),
  estorno: new RegExp(
    '\\b(?:estorno|estornar|estorna|reembolso|reembolsar|devolucao|' +
    'devolver (?:o |meu )?dinheiro|dinheiro de volta|' +
    'retornar o (?:zelle|dinheiro|pagamento)|retorno do (?:zelle|dinheiro|pagamento)|' +
    'nao recebi (?:o |meu )?(?:retorno|estorno|reembolso|dinheiro)|' +
    '(?:paguei|cobrou|cobrado|cobraram) (?:duas|2) vezes|refund|money back)\\b'
  ),
  reclamacao: new RegExp(
    // "veio com" sozinho pegaria elogio ("veio com tudo certinho"); a queixa
    // vem como "pedi sem cebola e veio com cebola".
    '\\b(?:veio errado|veio trocado|pedido errado|lanche errado|veio sem|pedi sem [a-z ]{0,40}veio|' +
    'faltou|faltando|faltaram|nao veio|so veio|veio so|veio somente|veio apenas|' +
    'veio frio|chegou frio|esta frio|ta frio|estava frio|cru|queimado|estragado|' +
    'reclama\\w*|pessimo|horrivel|nojo|cabelo|' +
    'demorando (?:demais|muito)|demora demais|muita demora|' +
    'ja passou (?:demais )?da hora|atrasad[oa]s? demais|muito atrasad[oa]|' +
    'wrong order|missing|cold food|pedido equivocado|falto)\\b'
  ),
};

// Durante a montagem, "faltou o guaraná" é sobre o carrinho, não sobre um
// pedido entregue: aí só vale pedido explícito de atendente ou de estorno.
const MONTANDO = ['PAYMENT_PENDING', 'ORDER_COMPLETE'];

/** O motivo do atendimento, ou null. */
function detectar(texto, sess) {
  const n = normalizar(texto);
  if (!n) return null;
  if (PADROES.atendente.test(n)) return 'atendente';
  if (PADROES.estorno.test(n)) return 'estorno';
  const montando = (sess?.cart || []).length > 0 && !MONTANDO.includes(sess?.state);
  if (!montando && PADROES.reclamacao.test(n)) return 'reclamacao';
  return null;
}

function aberto(phone) {
  const at = abertos.get(phone);
  if (!at) return null;
  if (Date.now() > at.ate) {
    abertos.delete(phone);
    return null;
  }
  return at;
}

/** Esta mensagem vai para uma pessoa? (atendimento aberto, ou pedido de um) */
function precisa(phone, texto, sess) {
  return Boolean(aberto(phone) || detectar(texto, sess));
}

function trecho(texto) {
  const limpo = String(texto || '').trim();
  return limpo.length <= TRECHO_MAX ? limpo : `${limpo.slice(0, TRECHO_MAX)}…`;
}

function money(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

const ROTULO_MOTIVO = {
  atendente: 'pediu para falar com uma pessoa',
  estorno: 'estorno',
  reclamacao: 'reclamação',
};

async function paraAdmins(texto) {
  for (const admin of notify.admins()) {
    await notify.send(admin, paraAdmin(texto)).catch(() => false);
  }
}

async function ultimoPedido(phone) {
  try {
    return await require('../db/queries').getUltimoPedidoDoTelefone(phone);
  } catch (err) {
    log.warn({ evt: 'atendimento', err }, 'não consegui ler o último pedido do cliente');
    return null;
  }
}

function linhaPedido(pedido) {
  if (!pedido) return 'Sem pedido registrado.';
  const { STATUS_LABEL } = require('../bot/handlers/admin');
  const quando = new Date(pedido.created_at).toLocaleString('pt-BR', {
    timeZone: 'America/New_York',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Último pedido: #${pedido.id} — ${money(pedido.total)} — ` +
    `${STATUS_LABEL[pedido.status] || pedido.status} — ${quando}`;
}

/**
 * Trata a mensagem se ela for de atendimento humano. Devolve true quando o
 * bot não deve seguir com ela.
 */
async function tratar({ phone, texto, send, sess }) {
  const at = aberto(phone);
  if (at) {
    at.ate = Date.now() + JANELA_MS;
    if (at.repasses < MAX_REPASSES) {
      at.repasses += 1;
      const quem = at.nome ? `${at.nome} (+${phone})` : `+${phone}`;
      await paraAdmins(`💬 *${quem}* — em atendimento${at.pedidoId ? ` (#${at.pedidoId})` : ''}:\n"${trecho(texto)}"`);
    }
    log.info({ evt: 'atendimento', fase: 'repasse' }, 'mensagem do cliente repassada aos admins');
    return true;
  }

  const motivo = detectar(texto, sess);
  if (!motivo) return false;

  const pedido = await ultimoPedido(phone);
  const nome = pedido?.customer_name || sess?.name || null;
  abertos.set(phone, { ate: Date.now() + JANELA_MS, repasses: 0, motivo, pedidoId: pedido?.id || null, nome });

  const devolver = pedido ? `!bot ${pedido.id}` : `!bot ${phone}`;
  await paraAdmins(
    `🙋 *CLIENTE PEDINDO ATENDIMENTO* — ${ROTULO_MOTIVO[motivo]}\n\n` +
      `${nome || 'sem nome'} · +${phone}\n` +
      `${linhaPedido(pedido)}\n\n` +
      `"${trecho(texto)}"\n\n` +
      `Responda pelo WhatsApp da loja ou ligue para o cliente.\n` +
      `_O bot fica em silêncio com esse cliente por 30 min; o que ele mandar chega aqui. ` +
      `Para devolver ao bot antes: *${devolver}*_`
  );

  await send(t(sess?.lang || 'pt', 'atendimento_humano'));

  log.info({ evt: 'atendimento', motivo, pedido: pedido?.id }, 'cliente encaminhado para atendimento humano');
  return true;
}

/** Foto de cliente em atendimento (pedido errado, embalagem): vai aos admins. */
async function repassarImagem({ phone, buffer, mimetype }) {
  const at = aberto(phone);
  if (!at) return false;
  at.ate = Date.now() + JANELA_MS;
  if (at.repasses >= MAX_REPASSES) return true;
  at.repasses += 1;

  const legenda = paraAdmin(
    `📷 Foto de ${at.nome || `+${phone}`} — em atendimento${at.pedidoId ? ` (#${at.pedidoId})` : ''}`
  );
  for (const admin of notify.admins()) {
    const foi = await notify.sendImage(admin, { buffer, mimetype, caption: legenda }).catch(() => false);
    if (!foi) await notify.send(admin, legenda).catch(() => false);
  }
  log.info({ evt: 'atendimento', fase: 'foto' }, 'foto do cliente repassada aos admins');
  return true;
}

/** Devolve o cliente ao bot. true se havia atendimento aberto. */
function encerrar(phone) {
  const havia = Boolean(aberto(phone));
  abertos.delete(phone);
  return havia;
}

/** Só para os testes. */
function zerar() {
  abertos.clear();
}

module.exports = { detectar, precisa, tratar, repassarImagem, encerrar, aberto, zerar, JANELA_MS };
