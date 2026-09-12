const log = require('../log');
const notify = require('../bot/notify');
const { paraAdmin } = require('../texto');
const { t } = require('../i18n');

/**
 * Reclamação, estorno e dúvida sobre pedido já feito vão para uma pessoa.
 * Não há rastreamento da cozinha/motoboy: nunca inventar uma atualização.
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
    'demorando|demora demais|muita demora|atrasad[oa]s?|atraso|atrasou|' +
    'ja passou (?:demais )?da hora|ainda (?:estou |to |estamos |tamos )?(?:esperando|aguardando)|' +
    '(?:nao|n|ainda nao) (?:chegou|recebi (?:o |meu |o meu )?(?:pedido|lanche|comida))|' +
    'wrong order|missing|cold food|order is late|hasn t arrived|has not arrived|didn t arrive|' +
    'pedido equivocado|falto|no (?:ha llegado|llego)|pedido retrasado)\\b'
  ),
  andamento: new RegExp(
    '\\b(?:(?:cade|kd|onde (?:esta|ta|fica)|como (?:esta|ta)|status|situacao|andamento)' +
    '(?: d[oa])? (?:o |a |meu |minha |o meu |a minha )?(?:pedido|lanche|entrega)|' +
    '(?:sobre|saber d[oa]|previsao d[oa]|noticias d[oa]|novidades d[oa]) (?:o |a |meu |minha )?(?:pedido|lanche|entrega)|' +
    '(?:qual (?:e )?(?:o )?)?numero d[oa] (?:meu |minha )?(?:pedido|entrega)|' +
    '(?:meu |o )?(?:pedido|lanche|entrega)(?: (?:numero |n )?#?\\d+)? (?:ja |ainda |nao )*' +
    '(?:saiu|esta pronto|ta pronto|ficou pronto|esta como|ta como|vai chegar|chega quando)|' +
    'ja (?:saiu|ficou pronto|esta pronto|ta pronto)|(?:esta|ta|ficou) pronto|' +
    '(?:posso|pode|podemos) (?:ir )?(?:buscar|retirar)|' +
    'quando (?:chega|vai chegar)|(?:cade|kd|onde esta|onde ta) (?:o )?(?:motoboy|entregador)|' +
    'where (?:is|s) my (?:order|food)|is (?:my order|it) ready|can i (?:pick up|collect)|' +
    'donde esta mi pedido|puedo (?:recoger|retirar)|ya (?:salio|esta listo))\\b'
  ),
};

// Durante a montagem, "faltou o guaraná" é sobre o carrinho, não sobre um
// pedido entregue: aí só vale pedido explícito de atendente ou de estorno.
const PEDIDO_FECHADO = ['PAYMENT_PENDING', 'ORDER_COMPLETE'];

/** IDs explicitamente citados, nunca quantidade de produto ou opção do menu. */
function referencias(texto, sess) {
  const n = normalizar(texto);
  const ids = [...n.matchAll(/(?:\b(?:pedido|order|orden)\s*(?:numero\s*|n\s*)?#?\s*|#)(\d{1,9})\b/g)]
    .map(m => Number(m[1])).filter(id => id > 0);
  if (PEDIDO_FECHADO.includes(sess?.state) && !sess?.menuSelection && /^\d{1,9}$/.test(n)) {
    ids.push(Number(n));
  }
  return [...new Set(ids.filter(id => id > 0))];
}

/** O motivo do atendimento, ou null. */
function detectar(texto, sess) {
  const n = normalizar(texto);
  if (!n) return null;
  if (PADROES.atendente.test(n)) return 'atendente';
  if (PADROES.estorno.test(n)) return 'estorno';
  const fechado = PEDIDO_FECHADO.includes(sess?.state);
  const montando = (sess?.cart || []).length > 0 && !fechado;
  const anterior = /\b(?:pedido anterior|ultimo pedido|pedido de ontem|pedido que recebi)\b/.test(n);
  // Atraso do próprio cliente não é uma reclamação sobre a cozinha.
  const atrasoDoCliente = /\b(?:vou (?:me )?atrasar|vou chegar atrasad[oa]|estou atrasad[oa]|to atrasad[oa])\b/.test(n);
  if ((!montando || anterior) && !atrasoDoCliente && PADROES.reclamacao.test(n)) return 'reclamacao';
  if ((!montando || anterior) && PADROES.andamento.test(n)) return 'andamento';
  // "Quanto tempo?" na compra continua sendo prazo médio. Depois de fechar,
  // quem sabe responder sobre a espera desse pedido é a equipe, não o bot.
  if (fechado && !sess?.menuSelection &&
      /\b(?:quanto tempo|qto tempo|que horas (?:fica|vai ficar|chega|vai chegar|sai|vai sair|posso buscar|posso retirar)|quando fica pronto|quando vai ficar pronto|previsao|vai demorar|vai demora|falta muito|ta pronto|esta pronto|saiu|nao recebi|how long|cuanto falta)\b/.test(n)) {
    return 'andamento';
  }
  if (!montando && referencias(n, sess).length &&
      !/\b(?:quero|pedir|adiciona|acrescenta|fazer|novo|repetir|igual)\b/.test(n)) return 'andamento';
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
  andamento: 'dúvida sobre pedido já feito — verificar com o cliente',
};

/** Um destinatário falhar não impede os demais. Aceito não significa lido. */
async function enviarParaAdmins(enviar, tipo) {
  const admins = notify.admins();
  const resultados = await Promise.all(admins.map(async admin => {
    let aceito = false;
    try { aceito = Boolean(await enviar(admin)); } catch (_) { /* registrado abaixo */ }
    log[aceito ? 'info' : 'warn'](
      { evt: 'atendimento', fase: 'envio_admin', tipo, adminFinal: admin.slice(-4), aceito },
      aceito ? 'repasse aceito pelo WhatsApp do admin' : 'falha no repasse para admin'
    );
    return aceito;
  }));
  if (!admins.length) log.error({ evt: 'atendimento', fase: 'sem_admin' }, 'nenhum admin configurado para atendimento');
  return resultados.some(Boolean);
}

async function paraAdmins(texto) {
  const mensagem = paraAdmin(texto);
  return enviarParaAdmins(admin => notify.send(admin, mensagem), 'texto');
}

/** Não deixe o cliente em silêncio acreditando que a equipe recebeu. */
async function falhaNoRepasse(phone, send, lang) {
  abertos.delete(phone);
  if (send) await send(t(lang || 'pt', 'atendimento_indisponivel'));
}

async function limiteDeRepasses(at, send, lang) {
  if (at.repasses < MAX_REPASSES) return false;
  if (!at.limiteAvisado) {
    at.limiteAvisado = true;
    log.warn({ evt: 'atendimento', fase: 'limite_repasses' }, 'limite de repasses do atendimento atingido');
    if (send) await send(t(lang || 'pt', 'atendimento_limite'));
  }
  return true;
}

async function ultimoPedido(phone) {
  try {
    return await require('../db/queries').getUltimoPedidoDoTelefone(phone);
  } catch (err) {
    log.warn({ evt: 'atendimento', err }, 'não consegui ler o último pedido do cliente');
    return null;
  }
}

async function contextoPedido(phone, texto, sess) {
  const ids = referencias(texto, sess);
  if (!ids.length) return { pedido: await ultimoPedido(phone), informado: false };
  if (ids.length > 1) return { pedido: null, aviso: `Pedidos citados: ${ids.map(id => `#${id}`).join(', ')} — conferir com o cliente.` };
  const id = ids[0];
  try {
    const pedido = await require('../db/queries').getOrder(id);
    // Não associe nome, valor ou pedido de outro telefone à reclamação.
    if (pedido && String(pedido.phone).replace(/\D/g, '') === String(phone).replace(/\D/g, '')) {
      return { pedido, informado: true };
    }
    return { pedido: null, aviso: `Pedido citado: #${id} — não localizado para este telefone; confirmar com o cliente.` };
  } catch (_) {
    log.warn({ evt: 'atendimento', fase: 'consulta_pedido_falhou' }, 'não consegui conferir o pedido citado');
    return { pedido: null, aviso: `Pedido citado: #${id} — consulta indisponível; conferir com o cliente.` };
  }
}

function linhaPedido(pedido, informado = false) {
  if (!pedido) return 'Sem pedido registrado.';
  const { STATUS_LABEL } = require('../bot/handlers/admin');
  const quando = new Date(pedido.created_at).toLocaleString('pt-BR', {
    timeZone: 'America/New_York',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${informado ? 'Pedido informado' : 'Último pedido'}: #${pedido.id} — ${money(pedido.total)} — ` +
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
    if (await limiteDeRepasses(at, send, sess?.lang)) return true;
    at.repasses += 1;
    let referencia = '';
    if (referencias(texto, sess).length) {
      const contexto = await contextoPedido(phone, texto, sess);
      at.pedidoId = contexto.pedido?.id || null;
      referencia = `\n${contexto.aviso || linhaPedido(contexto.pedido, contexto.informado)}`;
    }
    const quem = at.nome ? `${at.nome} (+${phone})` : `+${phone}`;
    const foi = await paraAdmins(`💬 *${quem}* — em atendimento${at.pedidoId ? ` (#${at.pedidoId})` : ''}:${referencia}\n"${trecho(texto)}"`);
    if (!foi) await falhaNoRepasse(phone, send, sess?.lang);
    return true;
  }

  const motivo = detectar(texto, sess);
  if (!motivo) return false;

  const contexto = await contextoPedido(phone, texto, sess);
  const { pedido } = contexto;
  const nome = pedido?.customer_name || sess?.name || null;

  const devolver = pedido ? `!bot ${pedido.id}` : `!bot ${phone}`;
  const foi = await paraAdmins(
    `🙋 *CLIENTE PEDINDO ATENDIMENTO* — ${ROTULO_MOTIVO[motivo]}\n\n` +
      `${nome || 'sem nome'} · +${phone}\n` +
      `${contexto.aviso || linhaPedido(pedido, contexto.informado)}\n\n` +
      `"${trecho(texto)}"\n\n` +
      `Responda pelo WhatsApp da loja ou ligue para o cliente. Não há rastreamento automático.\n` +
      `_O bot fica em silêncio com esse cliente por 30 min; o que ele mandar chega aqui. ` +
      `Para devolver ao bot antes: *${devolver}*_`
  );

  if (!foi) {
    await falhaNoRepasse(phone, send, sess?.lang);
    return true;
  }
  abertos.set(phone, { ate: Date.now() + JANELA_MS, repasses: 0, motivo, pedidoId: pedido?.id || null, nome });
  await send(t(sess?.lang || 'pt', 'atendimento_humano'));

  log.info({ evt: 'atendimento', motivo, pedido: pedido?.id }, 'cliente encaminhado para atendimento humano');
  return true;
}

/** Foto de cliente em atendimento (pedido errado, embalagem): vai aos admins. */
async function repassarImagem({ phone, buffer, mimetype, send }) {
  const at = aberto(phone);
  if (!at) return false;
  at.ate = Date.now() + JANELA_MS;
  const lang = require('../bot/session').get(phone).lang;
  if (await limiteDeRepasses(at, send, lang)) return true;
  at.repasses += 1;

  const legenda = paraAdmin(
    `📷 Foto de ${at.nome || `+${phone}`} — em atendimento${at.pedidoId ? ` (#${at.pedidoId})` : ''}`
  );
  const foi = await enviarParaAdmins(async admin => {
    const foi = await notify.sendImage(admin, { buffer, mimetype, caption: legenda }).catch(() => false);
    if (foi) return true;
    return notify.send(admin, `${legenda}\nA foto não pôde ser repassada. Veja a conversa no WhatsApp da loja.`);
  }, 'foto');
  if (!foi) await falhaNoRepasse(phone, send, lang);
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
