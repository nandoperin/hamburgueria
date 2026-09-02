const express = require('express');
const crypto = require('crypto');

const log = require('../../log');
const { route, routeOrder } = require('../../bot/router');
const meta = require('../../bot/meta');

const router = express.Router();

/**
 * Webhook da Meta Cloud API.
 *
 *   GET  /meta/webhook  → handshake de verificação (feito uma vez no painel)
 *   POST /meta/webhook  → mensagens recebidas dos clientes
 */

// A Meta reenvia o mesmo evento se não responder rápido. Guardamos os ids
// já processados para não responder duas vezes ao cliente.
const seenMessages = new Set();
const SEEN_LIMIT = 1000;

function alreadyHandled(id) {
  if (seenMessages.has(id)) return true;

  seenMessages.add(id);
  if (seenMessages.size > SEEN_LIMIT) {
    // Descarta os mais antigos — Set preserva ordem de inserção.
    const excess = seenMessages.size - SEEN_LIMIT;
    let i = 0;
    for (const key of seenMessages) {
      if (i++ >= excess) break;
      seenMessages.delete(key);
    }
  }
  return false;
}

/**
 * Confere a assinatura X-Hub-Signature-256 contra o app secret.
 *
 * ## O que a assinatura sustenta aqui
 *
 * Mais do que "a mensagem veio mesmo da Meta". O corpo do webhook carrega o
 * número do remetente, e `admin.handle` decide o que é comando de dono olhando
 * **só** para esse número. Sem assinatura válida, qualquer um que conheça a URL
 * forja um POST com o telefone do dono e executa `!cancelar 42` — que estorna
 * dinheiro de verdade — ou `!emails`, que lista a base de clientes. A assinatura
 * é o que faz `ADMIN_PHONE` significar alguma coisa.
 *
 * ## Por que a falta do segredo agora fecha
 *
 * A versão anterior devolvia `true` quando `META_APP_SECRET` não estava
 * configurado, e aceitava tudo. O segredo está lá hoje, na Railway — o problema
 * é que "está lá hoje" não é garantia nenhuma: uma variável apagada por engano,
 * ou um ambiente novo criado sem ela, abriria a porta inteira sem emitir sinal.
 *
 * Fechar é a falha que aparece na hora e no log. Abrir é a que ninguém vê até
 * o estorno chegar. Só cede em desenvolvimento declarado — e a
 * palavra "declarado" carrega peso aqui, ver `src/ambiente.js`.
 */
function isValidSignature(req, rawBody) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    if (require('../../ambiente').exigeSegredos()) {
      log.error(
        { evt: 'webhook' },
        'META_APP_SECRET ausente — webhook recusado por seguranca'
      );
      return false;
    }
    return true; // desenvolvimento declarado: segue sem validar
  }

  const header = req.headers['x-hub-signature-256'];
  if (!header) return false;

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Verificação do webhook — a Meta chama isto ao cadastrar a URL no painel.
router.get('/meta/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    log.info({ evt: 'webhook' }, 'webhook da Meta verificado');
    return res.status(200).send(challenge);
  }

  log.warn({ evt: 'webhook' }, 'verificação do webhook da Meta recusada (token divergente)');
  res.sendStatus(403);
});

router.post(
  '/meta/webhook',
  // Teto explícito em vez do padrão do Express: um webhook da Meta tem alguns
  // kilobytes, e não há motivo para gastar memória validando a assinatura de um
  // corpo que já se sabe grande demais para ser legítimo.
  express.raw({ type: 'application/json', limit: '256kb' }),
  async (req, res) => {
    if (!isValidSignature(req, req.body)) {
      log.warn({ evt: 'webhook' }, 'webhook da Meta com assinatura inválida — ignorado');
      return res.sendStatus(401);
    }

    // A Meta espera 200 em poucos segundos; processamos depois de responder.
    res.sendStatus(200);

    try {
      const payload = JSON.parse(req.body.toString('utf8'));
      await handlePayload(payload);
    } catch (err) {
      log.error({ evt: 'webhook', err }, 'falha ao processar webhook da Meta');
    }
  }
);

async function handlePayload(payload) {
  if (payload.object !== 'whatsapp_business_account') return;

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value;
      if (!value?.messages) continue;

      for (const message of value.messages) {
        await handleMessage(message);
      }
    }
  }
}

async function handleMessage(message) {
  if (alreadyHandled(message.id)) return;

  const phone = message.from;
  const send = (reply) => meta.sendMessage(phone, reply);

  // Carrinho montado no catálogo — não tem texto, vai por outro caminho.
  if (message.type === 'order') {
    meta.markAsRead(message.id);
    try {
      await routeOrder(phone, message.order?.product_items || [], send);
    } catch (err) {
      log.error({ evt: 'erro', phone, err }, 'falha ao tratar carrinho recebido');
    }
    return;
  }

  const text = extractText(message);
  if (!text) return;

  meta.markAsRead(message.id);

  try {
    await route(phone, text, send);
  } catch (err) {
    log.error({ evt: 'erro', phone, err }, 'falha ao tratar mensagem recebida');
  }
}

/**
 * Extrai texto de mensagem simples ou de resposta a botão/lista.
 *
 * Em listas usamos o `id` da linha, não o rótulo: o id é estável e já carrega
 * o identificador do item (`carne:espetinho_boi`), enquanto o título muda com
 * o idioma do cliente.
 */
function extractText(message) {
  switch (message.type) {
    case 'text':
      return message.text?.body || '';
    case 'interactive':
      return (
        message.interactive?.list_reply?.id ||
        message.interactive?.button_reply?.id ||
        message.interactive?.button_reply?.title ||
        message.interactive?.list_reply?.title ||
        ''
      );
    case 'button':
      return message.button?.text || '';
    default:
      return '';
  }
}

module.exports = router;
