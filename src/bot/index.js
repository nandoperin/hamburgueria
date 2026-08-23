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
const fs = require('fs');

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

/**
 * O número do próprio bot, em dígitos, para o pareamento por código.
 *
 * Só isso: não é segredo (é o número que o cliente disca) e não autoriza nada —
 * quem autoriza comando de dono é `ADMIN_PHONE`, que é outro campo de
 * propósito. Ausente, o bot volta ao QR.
 */
function telefoneDePareamento() {
  return String(process.env.PAIR_PHONE || '').replace(/\D/g, '');
}

/**
 * Estado do pedido de código nesta tentativa de conexão.
 *
 *   null  — ainda não tentou
 *   true  — código emitido, está na tela do log
 *   false — o pedido falhou; o QR volta como alternativa
 *
 * **Zerado a cada `start()`**, e isso não é detalhe. Antes era módulo-global e
 * nunca voltava: uma única falha (por exemplo pedir o código num socket que já
 * tinha caído) fixava `false` para sempre, e todas as reconexões seguintes
 * caíam no QR mesmo quando o código funcionaria. O bot ficava preso no modo
 * ilegível justamente por causa de uma falha transitória.
 */
let codigoEmitido = null;

/** O QR deve ficar calado nesta tentativa? */
function usandoCodigo() {
  return Boolean(telefoneDePareamento()) && codigoEmitido !== false;
}

/**
 * Apaga a sessão gravada, para o próximo boot poder parear do zero.
 *
 * Chamado **só** em `loggedOut` (401), que é o WhatsApp dizendo que revogou
 * esta sessão — não é queda de rede, não é reconexão, é definitivo. A partir
 * dali a credencial no disco não vale mais nada: mantê-la só impede o bot de
 * se recuperar sozinho.
 *
 * Antes do volume isso se resolvia sozinho, porque todo deploy zerava o disco
 * efêmero. Com o volume, a credencial morta **persiste** — e o bot ficava
 * eternamente pedindo que alguém rodasse `railway volume browse` para apagar
 * na mão. Para um dono que não acompanha o projeto, isso é o bot morto até
 * alguém perceber.
 */
function apagarSessao() {
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    log.warn(
      { evt: 'conexao' },
      'sessao revogada apagada — o proximo boot vai pedir pareamento novo'
    );
  } catch (err) {
    log.error(
      { evt: 'conexao', err },
      'nao consegui apagar a sessao revogada — apague auth_info_baileys/ na mao'
    );
  }
}

/**
 * Pede o código de 8 caracteres em vez de desenhar o QR.
 *
 * Existe por um motivo prático que só aparece hospedado: o QR sai no log como
 * **33 linhas** de arte ASCII, e o visualizador do Railway põe cada linha numa
 * raia própria, com coluna de horário e de serviço comendo a largura. O
 * desenho quebra, exige rolar a tela, e não há celular que leia aquilo. Já
 * estava em `{ small: true }` — não dá para encolher mais.
 *
 * O código cabe em **uma linha**. É a mesma credencial de pareamento por outro
 * caminho: no celular, Aparelhos conectados → Conectar aparelho → "Conectar
 * com número de telefone".
 *
 * Vale para qualquer log difícil de ler, não só o do Railway — e some sozinho
 * quando a sessão já está registrada, porque aí não há nada a parear.
 */
async function pedirCodigoDePareamento(state) {
  const telefone = telefoneDePareamento();

  // Sessão já registrada não tem o que parear — e o volume faz isso ser o caso
  // comum a partir do segundo boot.
  if (!telefone || state.creds?.registered) return;

  if (telefone.length < 10) {
    log.error(
      { evt: 'boot', digitos: telefone.length },
      'PAIR_PHONE com menos de 10 digitos — ignorado, voltando ao QR'
    );
    codigoEmitido = false;
    return;
  }

  try {
    const codigo = await sock.requestPairingCode(telefone);
    const legivel = String(codigo).replace(/(.{4})(.{4})/, '$1-$2');
    codigoEmitido = true;
    log.info(
      { evt: 'boot', codigo: legivel, telefone },
      `CODIGO DE PAREAMENTO: ${legivel}  → no WhatsApp do numero ${telefone}: ` +
        'Aparelhos conectados → Conectar aparelho → "Conectar com numero de telefone"'
    );
  } catch (err) {
    // Falhar aqui não pode derrubar o boot nem deixar o dono sem saída: soltar
    // o QR de volta é o que garante que ainda existe uma forma de parear.
    codigoEmitido = false;
    log.error({ evt: 'boot', err }, 'nao foi possivel pedir o codigo — voltando ao QR');
  }
}

async function start() {
  // Cada tentativa de conexão começa sem veredito sobre o código. Sem este
  // reset, uma falha isolada prendia o bot no QR para sempre (ver `codigoEmitido`).
  codigoEmitido = null;

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
    // O evento `qr` é o sinal de que o socket está pronto para parear — e é
    // por isso que o pedido do código mora aqui, e não num `setTimeout` depois
    // do boot. A versão anterior esperava 4 segundos no escuro: quando a
    // sessão gravada estava revogada, a conexão caía em ~600ms e o pedido
    // chegava num socket já morto, falhando por um motivo que nada tinha a ver
    // com o código. Amarrado ao evento, ele só é feito quando pode dar certo.
    if (qr) {
      if (usandoCodigo()) {
        // O evento se repete a cada QR novo; `codigoEmitido` garante um pedido só.
        if (codigoEmitido === null) pedirCodigoDePareamento(state);
      } else {
        log.info({ evt: 'boot' }, 'escaneie o QR code abaixo com o WhatsApp');
        qrcode.generate(qr, { small: true });
      }
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      log.info({ evt: 'conexao' }, 'WhatsApp conectado');
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;

      // 401: o WhatsApp revogou a sessão. Não adianta reconectar com esta
      // credencial — ela morreu. Apaga e reinicia, para o próximo boot pedir
      // pareamento novo em vez de tentar a vida toda com um crachá cancelado.
      if (status === DisconnectReason.loggedOut) {
        log.warn({ evt: 'conexao' }, 'sessão encerrada pelo WhatsApp (401)');
        apagarSessao();
        reconnectAttempts = 0;
        setTimeout(start, 2000);
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
