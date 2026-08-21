const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const path = require('path');

const log = require('../log');
const { route, routeImagem } = require('./router');
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

/**
 * Tamanho declarado da imagem, em bytes.
 *
 * `fileLength` chega como Long do protobuf, número ou string, dependendo da
 * versão e do caminho — daí as três formas. Devolve 0 quando não dá para
 * saber, e quem chama trata 0 como "não sei", nunca como "é pequena".
 */
function tamanhoDeclarado(imagem) {
  const bruto = imagem?.fileLength;
  if (bruto == null) return 0;
  if (typeof bruto === 'number') return bruto;
  if (typeof bruto.toNumber === 'function') return bruto.toNumber();
  const n = Number(bruto);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Baixa a imagem e entrega ao router.
 *
 * **O teto é conferido antes do download**, contra o tamanho que o WhatsApp
 * declara no envelope. Baixar para depois medir seria deixar quem manda
 * escolher quanta banda e memória o servidor gasta — e um arquivo de 2 GB não
 * precisa ser malicioso para derrubar o processo no meio do serviço.
 *
 * O valor declarado não é confiável (é do remetente), mas ele só pode **subir**
 * o risco mentindo para menos — e nesse caso `comprovante.validar` mede o
 * buffer de verdade e recusa. As duas checagens se cobrem: esta protege a
 * memória, aquela protege o bucket.
 */
async function receberImagem(msg, imagem, phone, send) {
  const teto = require('../services/zelle').regrasComprovante().maxBytes;
  const declarado = tamanhoDeclarado(imagem);

  if (declarado > teto) {
    log.warn(
      { evt: 'imagem', phone, bytes: declarado, teto },
      'imagem recusada antes do download — acima do teto'
    );
    const lang = require('./session').get(phone).lang || 'pt';
    await send(require('../i18n').t(lang, 'zelle_proof_too_big'));
    return;
  }

  const buffer = await downloadMediaMessage(
    msg,
    'buffer',
    {},
    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
  );

  await routeImagem(phone, buffer, imagem.mimetype, send);
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

  /**
   * Envio de imagem — hoje serve ao comprovante que vai para o dono e às artes
   * do cardápio.
   *
   * Aceita `buffer` (imagem que já está na memória, como o comprovante que
   * acabou de chegar) ou `link` (arte servida pelo nosso `/img`). O buffer
   * ganha, porque reenviar sem baixar de novo é mais rápido e não depende de a
   * `BASE_URL` estar de pé.
   */
  const sendImage = async (phone, { buffer, link, caption }) => {
    const image = buffer || { url: link };
    await sock.sendMessage(toJid(phone), {
      image,
      ...(caption ? { caption } : {}),
    });
  };

  notify.register(sendMessage);

  // Só `sendImage`. `notify.sendButtons`/`sendList` conferem cada função
  // separadamente (`rich?.sendButtons`), então registrar parcial não faz o
  // resto do sistema achar que há botão — ele continua caindo no texto
  // numerado. Botões e listas no Baileys são trabalho à parte, e arriscado:
  // ver BAILEYS_RICH em .env.example.
  notify.registerRich({ sendImage });

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
      const send = (reply) => sendMessage(phone, reply);

      // Imagem antes do texto: o comprovante do Zelle chega assim, e a legenda
      // (quando existe) é "paguei" — não é o que interessa. Antes daqui, toda
      // mensagem sem texto era descartada em silêncio, e o comprovante do
      // cliente sumia sem nunca chegar a lugar nenhum.
      const imagem = msg.message?.imageMessage;
      if (imagem) {
        try {
          await receberImagem(msg, imagem, phone, send);
        } catch (err) {
          log.error({ evt: 'erro', phone, err }, 'falha ao tratar imagem recebida');
        }
        continue;
      }

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      if (!text.trim()) continue;

      try {
        await route(phone, text, send);
      } catch (err) {
        log.error({ evt: 'erro', phone, err }, 'falha ao tratar mensagem recebida');
      }
    }
  });
}

module.exports = { start };
