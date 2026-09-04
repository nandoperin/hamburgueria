// Antes do Baileys: o `libsignal` que vem com ele escreve chave privada no
// console, por fora do logger. Ver `silencio.js`.
require('./silencio').aplicar();

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
const { t } = require('../i18n');
const { route, routeOrder, routeImagem, routeAudio } = require('./router');
const session = require('./session');
const {
  fromBaileys,
  CatalogInputError,
  publicErrorKey,
  safeCatalogCode,
} = require('./catalog/adapters');
const catalogorder = require('./handlers/catalogorder');
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
 * O telefone de quem mandou a mensagem — não o endereço em que ela chegou.
 *
 * O WhatsApp passou a endereçar contas por **LID** (`189807607161040@lid`), um
 * identificador de privacidade que **não é** um número de telefone. Quando isso
 * acontece, o Baileys põe a forma com telefone em `remoteJidAlt`.
 *
 * O código antigo fazia `jid.replace('@s.whatsapp.net', '')`, que num JID de
 * LID não substitui nada — e o "telefone" virava `189807607161040@lid`. Isso
 * não quebrava nada de forma visível, porque `toJid()` devolve qualquer coisa
 * com `@` intacta e a resposta chegava normalmente. O estrago era silencioso,
 * em tudo que usa o telefone como **identidade**:
 *
 *   - `isAdminPhone()` nunca casava — os comandos do dono simplesmente não
 *     existiam, e `!painel` era respondido pela IA como se fosse pedido
 *   - `getCustomerByPhone()` nunca achava ninguém — nome, endereço e último
 *     pedido não eram reconhecidos, e todo cliente parecia novo
 *   - o pedido era gravado com o LID na coluna `phone`, então `!buscar <numero>`
 *     não encontrava
 *
 * Nada disso dá erro. Tudo isso é o sistema funcionando com a pessoa errada.
 *
 * Devolve `null` quando não há forma com telefone — quem chama decide o que
 * fazer, em vez de receber um LID disfarçado de número.
 */
function telefoneDoRemetente(key) {
  for (const jid of [key?.remoteJid, key?.remoteJidAlt]) {
    if (typeof jid === 'string' && jid.endsWith('@s.whatsapp.net')) {
      // O sufixo `:12` de multi-dispositivo não faz parte do número.
      return jid.replace('@s.whatsapp.net', '').split(':')[0];
    }
  }
  return null;
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

function duracaoDeclarada(audio) {
  const bruto = audio?.seconds;
  if (bruto == null) return 0;
  if (typeof bruto === 'number') return bruto;
  if (typeof bruto.toNumber === 'function') return bruto.toNumber();
  const n = Number(bruto);
  return Number.isFinite(n) ? n : 0;
}

/** Confere o envelope antes de baixar e entrega a nota de voz ao roteador. */
async function receberAudio(msg, audio, phone, send) {
  const regras = require('../services/audio').regrasAudio();
  const declarado = tamanhoDeclarado(audio);
  const segundos = duracaoDeclarada(audio);
  const lang = session.get(phone).lang || 'pt';

  if (declarado > regras.maxBytes) {
    await send(t(lang, 'audio_too_big'));
    return;
  }
  if (segundos > regras.maxSeconds) {
    await send(t(lang, 'audio_too_long'));
    return;
  }

  const buffer = await downloadMediaMessage(
    msg,
    'buffer',
    {},
    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
  );
  await routeAudio(phone, buffer, audio.mimetype || 'audio/ogg', segundos, send);
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

/**
 * O último QR emitido, para `/pareamento` poder mostrá-lo.
 *
 * Vive só em memória e por pouco tempo: o WhatsApp troca o QR a cada ~20s e o
 * anterior deixa de valer. Guardar o instante junto é o que permite à página
 * dizer "este expirou" em vez de mostrar um quadrado morto que não escaneia —
 * o mesmo engano que os códigos de pareamento vencidos causaram a noite toda.
 *
 * É credencial: quem escaneia vira o WhatsApp da casa. Por isso a rota que o
 * serve exige token e ele é esquecido assim que a conexão abre.
 */
let qrAtual = null;

function guardarQr(qr) {
  qrAtual = { valor: qr, em: Date.now() };
}

function esquecerQr() {
  qrAtual = null;
}

/** O QR de agora, ou null se não há pareamento pendente. */
function qrPendente() {
  return qrAtual;
}

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
function apagarSessao(dir = AUTH_DIR) {
  try {
    // Apaga o CONTEÚDO, nunca o diretório.
    //
    // Em produção `/app/auth_info_baileys` é o **ponto de montagem** do volume
    // do Railway, e `rmdir` num mount point devolve EBUSY — o kernel recusa,
    // com razão. A primeira versão disto fazia `rmSync(AUTH_DIR)` e falhava
    // exatamente assim; localmente passava, porque ali é um diretório comum.
    //
    // É a diferença entre "esvaziar a gaveta" e "arrancar a gaveta do móvel".
    // Só a primeira é possível quando o móvel é o sistema de arquivos.
    for (const entrada of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, entrada), { recursive: true, force: true });
    }
    log.warn(
      { evt: 'conexao' },
      'sessao revogada apagada — o proximo boot vai pedir pareamento novo'
    );
  } catch (err) {
    // Diretório inexistente é sucesso, não falha: não há sessão para apagar.
    if (err.code === 'ENOENT') return;
    log.contexto({}, () => log.error(
      { evt: 'conexao', origem: 'baileys', code: 'sessao_revogada_falhou' },
      'nao consegui apagar a sessao revogada — apague o conteudo de auth_info_baileys/ na mao'
    ));
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
    const codigo = String(await sock.requestPairingCode(telefone));
    codigoEmitido = true;

    // O codigo vai CRU, sem o hifen que ficava aqui para "facilitar a leitura".
    //
    // O hifen nunca existiu do lado do WhatsApp: o codigo tem oito caracteres
    // corridos, e o campo do celular nao aceita o traco. Quem lia o log digitava
    // exatamente o que via, o WhatsApp respondia "codigo incorreto", e o log
    // parecia estar certo — o defeito ficava invisivel de dentro.
    //
    // Custou uma noite de pareamento: onze codigos recusados seguidos, com o
    // diagnostico indo parar em ban de numero e limite de tentativas, enquanto
    // a causa era um caractere que este arquivo inventava.
    //
    // A licao vale alem daqui: formatacao aplicada a um valor que alguem vai
    // COPIAR nao e cosmetica, e sim uma alteracao do dado.
    log.info(
      { evt: 'boot', codigo, telefone },
      `CODIGO DE PAREAMENTO: ${codigo}  (oito caracteres, digite sem espaco e ` +
        `sem traco)  → no WhatsApp do numero ${telefone}: ` +
        'Aparelhos conectados → Conectar aparelho → "Conectar com numero de telefone"'
    );
  } catch (_err) {
    // Falhar aqui não pode derrubar o boot nem deixar o dono sem saída: soltar
    // o QR de volta é o que garante que ainda existe uma forma de parear.
    codigoEmitido = false;
    log.contexto({}, () => log.error(
      { evt: 'boot', origem: 'baileys', code: 'pareamento_falhou' },
      'nao foi possivel pedir o codigo — voltando ao QR'
    ));
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
  notify.registerRich({ sendImage, catalogLink: () => {
    // Identidade da sessão conectada, nunca ADMIN_PHONE nem PAIR_PHONE.
    const phone = telefoneDoRemetente({ remoteJid: sock.user?.id || state.creds.me?.id });
    return phone && /^\d{8,15}$/.test(phone) ? `https://wa.me/c/${phone}` : null;
  } });

  const catalogSocket = sock;
  let catalogOnline = false;
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    // O evento `qr` é o sinal de que o socket está pronto para parear — e é
    // por isso que o pedido do código mora aqui, e não num `setTimeout` depois
    // do boot. A versão anterior esperava 4 segundos no escuro: quando a
    // sessão gravada estava revogada, a conexão caía em ~600ms e o pedido
    // chegava num socket já morto, falhando por um motivo que nada tinha a ver
    // com o código. Amarrado ao evento, ele só é feito quando pode dar certo.
    if (qr) {
      // Guardado SEMPRE, mesmo quando o pareamento é por código.
      //
      // Os dois caminhos nascem do mesmo evento, e antes o QR era descartado
      // quando `PAIR_PHONE` estava preenchido — o que deixava o dono com uma
      // saída só. Numa noite em que o código de pareamento simplesmente não
      // era aceito (Baileys 7.0.0-rc13), não havia como cair para o QR sem
      // editar variável e esperar dois deploys.
      //
      // Agora ele fica disponível em `/pareamento`, que é onde o QR é
      // legível: no log do Railway ele sai como 33 linhas de arte ASCII que o
      // visualizador quebra.
      guardarQr(qr);

      if (usandoCodigo()) {
        // O evento se repete a cada QR novo; `codigoEmitido` garante um pedido só.
        if (codigoEmitido === null) pedirCodigoDePareamento(state);
      } else {
        log.info({ evt: 'boot' }, 'escaneie o QR code abaixo com o WhatsApp');
        qrcode.generate(qr, { small: true });
      }
    }

    if (connection === 'open') {
      catalogOnline = true;
      require('../services/catalogo-importacao').registrar({
        online: () => catalogOnline,
        phone: () => telefoneDoRemetente({ remoteJid: catalogSocket.user?.id || state.creds.me?.id }),
        backupDir: path.join(AUTH_DIR, 'catalog-backups'),
        getCatalog: require('./catalog/leitura-business').criarLeitura({
          socket: catalogSocket,
          phone: () => telefoneDoRemetente({ remoteJid: catalogSocket.user?.id || state.creds.me?.id }),
          registrar: dados => log.info({ evt: 'catalogo_leitura', ...dados }, 'diagnostico de leitura do catalogo'),
        }),
        lerColecoes: require('./catalog/leitura-colecoes').criarLeituraColecoes({
          socket: catalogSocket,
          phone: () => telefoneDoRemetente({ remoteJid: catalogSocket.user?.id || state.creds.me?.id }),
          registrar: dados => log.info({ evt: 'catalogo_leitura', ...dados }, 'diagnostico independente de colecoes'),
        }),
        productCreate: args => catalogSocket.productCreate(args),
        productUpdate: (id, args) => catalogSocket.productUpdate(id, args),
        productDelete: ids => catalogSocket.productDelete(ids),
      });
      reconnectAttempts = 0;
      // Conectado, o QR guardado é credencial sem uso — some da memória e da
      // página no mesmo instante.
      esquecerQr();
      log.info({ evt: 'conexao' }, 'WhatsApp conectado');
    }

    if (connection === 'close') {
      catalogOnline = false;
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

      // Duas coisas diferentes, separadas de propósito:
      //
      //   `phone` — a IDENTIDADE. Vale para admin, cadastro, sessão e comanda.
      //   `jid`   — o ENDEREÇO. A resposta volta por onde a mensagem veio, que
      //             é o caminho garantido de funcionar seja LID ou telefone.
      //
      // Confundir os dois foi o defeito que fez `!painel` cair na IA.
      // Sem forma com telefone, cai no LID: atender com identidade degradada é
      // melhor que não atender. O cliente conversa e pede normalmente; o que se
      // perde é o reconhecimento (admin, cadastro) e um telefone discável na
      // comanda. O aviso existe para isso não passar despercebido.
      const telefone = telefoneDoRemetente(msg.key);
      if (!telefone) {
        log.warn(
          { evt: 'msg', jid },
          'contato sem numero de telefone (so LID) — admin e cadastro nao vao ' +
            'reconhece-lo, e a comanda sai sem telefone discavel'
        );
      }
      const phone = telefone || jid.replace(/@.*$/, '');
      const send = (reply) => sendMessage(jid, reply);

      const orderMessage = msg.message?.orderMessage;
      if (orderMessage) {
        try {
          const catalogOrder = await fromBaileys(sock, orderMessage);
          await routeOrder(phone, catalogOrder, send);
        } catch (err) {
          const catalogError = err instanceof CatalogInputError;
          const code = safeCatalogCode(catalogError ? err.code : null, 'leitura_falhou');
          const products = catalogError ? err.products : [];
          log.contexto({}, () => log.warn(
            { evt: 'carrinho', origem: 'baileys', code, itens: products.length },
            'carrinho Baileys recusado'
          ));
          if (['produto_desconhecido', 'produto_ambiguo'].includes(code)) {
            await catalogorder.avisarDono(code, products);
          }
          await send(t(
            session.get(phone).lang || 'pt',
            publicErrorKey(code),
            { items: products.join(', ') }
          ));
        }
        continue;
      }

      // Imagem antes do texto: o comprovante do Zelle chega assim, e a legenda
      // (quando existe) é "paguei" — não é o que interessa. Antes daqui, toda
      // mensagem sem texto era descartada em silêncio, e o comprovante do
      // cliente sumia sem nunca chegar a lugar nenhum.
      const imagem = msg.message?.imageMessage;
      if (imagem) {
        try {
          await receberImagem(msg, imagem, phone, send);
        } catch (_err) {
          log.contexto({}, () => log.error(
            { evt: 'imagem', origem: 'baileys', code: 'recebimento_falhou' },
            'falha ao tratar imagem recebida'
          ));
        }
        continue;
      }

      // Nota de voz antes do texto: o Voxtral transcreve, e o pedido segue
      // pelo mesmo fluxo de conversa usado para uma mensagem digitada.
      const audio = msg.message?.audioMessage;
      if (audio) {
        try {
          await receberAudio(msg, audio, phone, send);
        } catch (_err) {
          log.contexto({}, () => log.error(
            { evt: 'audio', origem: 'baileys', code: 'recebimento_falhou' },
            'falha ao tratar audio recebido'
          ));
          await send(t(session.get(phone).lang || 'pt', 'audio_not_understood'));
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
      } catch (_err) {
        log.contexto({}, () => log.error(
          { evt: 'msg', origem: 'baileys', code: 'roteamento_falhou' },
          'falha ao tratar mensagem recebida'
        ));
      }
    }
  });
}

// `apagarSessao` sai exportada para ser testável: ela é a peça que roda uma vez
// por ano, no pior momento possível, e é onde um erro fica escondido por meses.
module.exports = {
  start,
  apagarSessao,
  telefoneDoRemetente,
  qrPendente,
  tamanhoDeclarado,
  duracaoDeclarada,
};
