const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const path = require('path');

const log = require('../log');
const { route } = require('./router');
const notify = require('./notify');

const AUTH_DIR = path.join(__dirname, '../../auth_info_baileys');

// Reconexão com backoff exponencial. Sem isso, uma falha persistente vira
// um loop de tentativas por segundo — o WhatsApp responde bloqueando o IP (405).
const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;
const RECONNECT_MAX_ATTEMPTS = 8;

let sock;
let reconnectAttempts = 0;

function nextReconnectDelay() {
  const delay = Math.min(
    RECONNECT_BASE_MS * 2 ** reconnectAttempts,
    RECONNECT_MAX_MS
  );
  // Jitter de ±20% para não sincronizar tentativas entre reinícios.
  return Math.round(delay * (0.8 + Math.random() * 0.4));
}

function toJid(phone) {
  return phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  const sendMessage = async (phone, text) => {
    await sock.sendMessage(toJid(phone), { text });
  };

  notify.register(sendMessage);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      log.info({ evt: 'boot' }, 'escaneie o QR code abaixo com o WhatsApp');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      log.info({ evt: 'conexao' }, 'WhatsApp conectado');
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;

      if (status === DisconnectReason.loggedOut) {
        log.warn(
          { evt: 'conexao' },
          'sessão encerrada — apague auth_info_baileys/ e reinicie para escanear o QR'
        );
        return;
      }

      if (status === 405) {
        log.error(
          { evt: 'conexao', status },
          'WhatsApp recusou a conexão (405) — normalmente é bloqueio temporário ' +
            'de IP por excesso de tentativas. Aguarde algumas horas, ou tente ' +
            'por outra rede (hotspot do celular).'
        );
        return;
      }

      // 515 (restartRequired) é esperado logo após parear o QR: o WhatsApp
      // pede que o cliente reabra a conexão. Reconecta na hora, sem backoff,
      // e sem consumir tentativa — atrasar aqui derruba o pareamento.
      if (status === DisconnectReason.restartRequired) {
        log.info({ evt: 'conexao' }, 'pareamento concluído — reiniciando a conexão');
        setTimeout(start, 500);
        return;
      }

      if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
        log.error(
          { evt: 'conexao', tentativas: RECONNECT_MAX_ATTEMPTS },
          `desisti após ${RECONNECT_MAX_ATTEMPTS} tentativas — reinicie manualmente`
        );
        return;
      }

      const delay = nextReconnectDelay();
      reconnectAttempts += 1;
      log.warn(
        {
          evt: 'conexao',
          status: status ?? null,
          tentativa: reconnectAttempts,
          emSegundos: Math.round(delay / 1000),
        },
        `conexão caiu — tentativa ${reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS} em ${Math.round(delay / 1000)}s`
      );
      setTimeout(start, delay);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const jid = msg.key.remoteJid || '';
      if (jid.endsWith('@g.us') || jid.endsWith('@broadcast')) continue;

      const phone = jid.replace('@s.whatsapp.net', '');
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      if (!text.trim()) continue;

      const send = (reply) => sendMessage(phone, reply);

      try {
        await route(phone, text, send);
      } catch (err) {
        log.error({ evt: 'erro', phone, err }, 'falha ao tratar mensagem recebida');
      }
    }
  });
}

module.exports = { start };
