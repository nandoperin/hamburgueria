const log = require('../log');
const notify = require('./notify');

const API_VERSION = process.env.META_API_VERSION || 'v22.0';
const GRAPH = 'https://graph.facebook.com';

/**
 * Camada WhatsApp via Meta Cloud API (oficial).
 *
 * Diferente do Baileys, aqui não existe conexão contínua: a Meta faz POST
 * no nosso webhook quando chega mensagem, e nós fazemos POST na Graph API
 * para responder. Por isso este módulo não tem `start()` — apenas registra
 * a função de envio e deixa o webhook (src/api/webhooks/meta.js) rotear.
 */

function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} é obrigatório quando WHATSAPP_PROVIDER=meta`);
  }
  return value;
}

/** POST em /messages com o envelope comum. `payload` traz `type` e o corpo. */
async function post(phone, payload) {
  const phoneNumberId = requireEnv('META_PHONE_NUMBER_ID');
  const token = requireEnv('META_ACCESS_TOKEN');

  const res = await fetch(`${GRAPH}/${API_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      ...payload,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`Meta API ${res.status}: ${detail}`);
    // Quem tenta de novo precisa saber se vale a pena: 4xx repete igual.
    err.status = res.status;
    throw err;
  }

  return res.json();
}

/** Envia uma mensagem de texto para um número (só dígitos, com código do país). */
async function sendMessage(phone, text) {
  return post(phone, {
    type: 'text',
    text: { preview_url: false, body: text },
  });
}

// ------------------------------------------------------- mensagens interativas

// Limites da Meta. Estourar qualquer um faz a API recusar a mensagem inteira,
// então cortamos aqui em vez de deixar quebrar em produção.
const LIST_BUTTON_MAX = 20;
const ROW_TITLE_MAX = 24;
const ROW_DESCRIPTION_MAX = 72;
const LIST_ROWS_MAX = 10;
const BUTTON_TITLE_MAX = 20;
const BUTTONS_MAX = 3;

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : value.slice(0, max - 1) + '…';
}

/**
 * Lista tocável — o cliente escolhe sem digitar.
 *
 * `sections[].rows[].id` volta no webhook como `interactive.list_reply.id`,
 * então é ali que vai o identificador estável (id do item), não o rótulo.
 */
async function sendList(phone, { body, button, sections, header, footer }) {
  let remaining = LIST_ROWS_MAX;
  const trimmed = [];

  for (const section of sections) {
    if (remaining <= 0) break;
    const rows = section.rows.slice(0, remaining).map((row) => ({
      id: row.id,
      title: truncate(row.title, ROW_TITLE_MAX),
      ...(row.description
        ? { description: truncate(row.description, ROW_DESCRIPTION_MAX) }
        : {}),
    }));
    remaining -= rows.length;
    trimmed.push({ title: truncate(section.title, ROW_TITLE_MAX), rows });
  }

  return post(phone, {
    type: 'interactive',
    interactive: {
      type: 'list',
      ...(header ? { header: { type: 'text', text: header } } : {}),
      body: { text: body },
      ...(footer ? { footer: { text: footer } } : {}),
      action: { button: truncate(button, LIST_BUTTON_MAX), sections: trimmed },
    },
  });
}

/** Cartão do catálogo completo, com botão "Ver catálogo". */
async function sendCatalog(phone, { body, footer, thumbnailRetailerId }) {
  return post(phone, {
    type: 'interactive',
    interactive: {
      type: 'catalog_message',
      body: { text: body },
      ...(footer ? { footer: { text: footer } } : {}),
      action: {
        name: 'catalog_message',
        ...(thumbnailRetailerId
          ? { parameters: { thumbnail_product_retailer_id: thumbnailRetailerId } }
          : {}),
      },
    },
  });
}

/** Seleção curada de produtos, agrupada em seções (até 30 itens). */
async function sendProductList(phone, { header, body, footer, sections }) {
  const catalogId = requireEnv('META_CATALOG_ID');

  return post(phone, {
    type: 'interactive',
    interactive: {
      type: 'product_list',
      header: { type: 'text', text: header },
      body: { text: body },
      ...(footer ? { footer: { text: footer } } : {}),
      action: {
        catalog_id: catalogId,
        sections: sections.map((section) => ({
          title: truncate(section.title, ROW_TITLE_MAX),
          product_items: section.retailerIds.map((id) => ({
            product_retailer_id: id,
          })),
        })),
      },
    },
  });
}

/** Até 3 botões de resposta rápida — o cliente escolhe sem digitar. */
async function sendButtons(phone, { body, buttons, header, footer }) {
  return post(phone, {
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(header ? { header: { type: 'text', text: header } } : {}),
      body: { text: body },
      ...(footer ? { footer: { text: footer } } : {}),
      action: {
        buttons: buttons.slice(0, BUTTONS_MAX).map((btn) => ({
          type: 'reply',
          reply: { id: btn.id, title: truncate(btn.title, BUTTON_TITLE_MAX) },
        })),
      },
    },
  });
}

/** Imagem avulsa por URL pública — usada só para a arte de marca na saudação. */
async function sendImage(phone, { link, caption }) {
  return post(phone, {
    type: 'image',
    image: { link, ...(caption ? { caption } : {}) },
  });
}

/**
 * Marca a mensagem como lida (as duas checks azuis).
 * Falha aqui é silenciosa — é cosmético e não deve travar o atendimento.
 */
async function markAsRead(messageId) {
  try {
    const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
    const token = process.env.META_ACCESS_TOKEN;
    if (!phoneNumberId || !token) return;

    await fetch(`${GRAPH}/${API_VERSION}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    });
  } catch (err) {
    log.debug({ evt: 'envio', err }, 'falha ao marcar mensagem como lida');
  }
}

async function start() {
  requireEnv('META_PHONE_NUMBER_ID');
  requireEnv('META_ACCESS_TOKEN');
  requireEnv('META_VERIFY_TOKEN');

  notify.register(sendMessage);
  notify.registerRich({ sendList, sendCatalog, sendProductList, sendButtons, sendImage });

  log.info(
    {
      evt: 'boot',
      webhook: `${process.env.BASE_URL}/meta/webhook`,
      catalogo: process.env.META_CATALOG_ID || null,
    },
    process.env.META_CATALOG_ID
      ? 'WhatsApp via Meta Cloud API, com catálogo'
      : 'WhatsApp via Meta Cloud API — sem META_CATALOG_ID, cardápio em texto'
  );
}

module.exports = {
  start,
  sendMessage,
  markAsRead,
  sendList,
  sendCatalog,
  sendProductList,
  sendButtons,
  sendImage,
};
