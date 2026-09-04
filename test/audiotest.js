process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';
process.env.MISTRAL_API_KEY = 'fake-mistral-key';
process.env.AI_MAX_USD_DIA = '10';

const path = require('path');
const fs = require('fs');
const PROJECT = path.resolve(__dirname, '..');

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
  console.log(`\x1b[32m   OK: ${mensagem}\x1b[0m`);
}

const gravacoes = [];
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  registrarUsoIA: async (delta) => {
    gravacoes.push(delta);
    return null;
  },
};

let pedidoAoSdk = null;
let opcoesDoSdk = null;
const sdkPath = require.resolve('@mistralai/mistralai');
require(sdkPath);
require.cache[sdkPath].exports = {
  Mistral: class {
    constructor() {
      this.audio = {
        transcriptions: {
          complete: async (pedido, opcoes) => {
            pedidoAoSdk = pedido;
            opcoesDoSdk = opcoes;
            return {
              model: 'voxtral-mini-2607',
              text: 'dois x tudo sem batata',
              usage: { promptAudioSeconds: 30 },
            };
          },
        },
      };
    }
  },
};

const custo = require(`${PROJECT}/src/ai/custo`);
const audio = require(`${PROJECT}/src/services/audio`);
const mistral = require(`${PROJECT}/src/ai/mistral`);

(async () => {
  custo._zerar();

  checar(
    audio.validar({
      buffer: Buffer.from('voz'),
      mimetype: 'audio/ogg; codecs=opus',
      seconds: 10,
    }).ok,
    'aceita a nota de voz OGG/Opus enviada pelo WhatsApp'
  );
  checar(
    audio.validar({
      buffer: Buffer.from('voz'),
      mimetype: 'video/mp4',
      seconds: 10,
    }).motivo === 'tipo',
    'recusa mídia que não é áudio'
  );
  checar(
    audio.validar({
      buffer: Buffer.from('voz'),
      mimetype: 'audio/ogg',
      seconds: 121,
    }).motivo === 'duracao',
    'recusa áudio acima de dois minutos'
  );

  const direto = await mistral.transcreverAudio({
    buffer: Buffer.from('voz'),
    mimetype: 'audio/ogg; codecs=opus',
    language: 'pt',
  });
  checar(direto.texto === 'dois x tudo sem batata', 'Voxtral devolve a transcrição limpa');
  checar(
    pedidoAoSdk.model === 'voxtral-mini-latest' &&
      pedidoAoSdk.file.fileName === 'audio.ogg' &&
      Buffer.isBuffer(pedidoAoSdk.file.content),
    'envia o arquivo ao endpoint de transcrição com o modelo correto'
  );
  checar(pedidoAoSdk.language === 'pt', 'informa o idioma da conversa ao Voxtral');
  checar(opcoesDoSdk.timeoutMs === 30000, 'a chamada de áudio tem timeout de 30 segundos');

  pedidoAoSdk = null;
  const sess = {};
  const resultado = await audio.transcrever({
    buffer: Buffer.from('voz'),
    mimetype: 'audio/ogg; codecs=opus',
    seconds: 28,
    lang: 'pt',
    sess,
  });
  checar(resultado.ok && resultado.texto === 'dois x tudo sem batata', 'serviço entrega texto ao bot');
  checar(custo.estado().chamadas === 1, 'transcrição entra na contagem de chamadas do !ia');
  checar(
    Math.abs(custo.estado().custoUsd - 0.0015) < 1e-9,
    '30 segundos entram no teto diário pelo preço de US$0.003/minuto'
  );
  checar(sess.aiAudioSeconds === 30, 'duração faturada fica registrada na sessão');

  await new Promise((resolve) => setTimeout(resolve, 20));
  checar(
    gravacoes.length === 1 && Math.abs(gravacoes[0].custoUsd - 0.0015) < 1e-9,
    'custo da transcrição é gravado no acumulado diário do banco'
  );

  const fonteIndex = fs.readFileSync(`${PROJECT}/src/bot/index.js`, 'utf8');
  checar(
    fonteIndex.includes('msg.message?.audioMessage') && fonteIndex.includes('routeAudio('),
    'Baileys encaminha mensagens de áudio ao novo fluxo'
  );

  console.log('\n\x1b[32maudiotest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
