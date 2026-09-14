// Sem WhatsApp, IA ou banco reais. O decodificador e o gerador de miniaturas
// do Baileys são reais: trocar apenas a versão no manifesto não basta.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.AI_ENABLED = 'off';
process.env.BASE_URL = 'https://fake.test';
process.env.ADMIN_PHONE = '15550001111,15550002222';
process.env.PROOF_MAX_MB = '5';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sharp = require('sharp');
const validacao = require('../src/services/imagem-repasse');
const comprovante = require('../src/services/comprovante');
const db = require('../src/db/queries');
const notify = require('../src/bot/notify');
const atendimento = require('../src/services/atendimento');
const session = require('../src/bot/session');
const schedule = require('../src/services/schedule');
const vazao = require('../src/bot/vazao');
const router = require('../src/bot/router');
const CLIENTE = '15559990000';
const fotos = [], textos = [], respostas = [];
let comprovantes = 0, falharPrimeiro = false;

// Falhar explicitamente se a nova validação tentar alterar pedido/pagamento.
for (const nome of ['createOrder', 'updateOrderStatus', 'approvePayment', 'markProofReceived']) {
  db[nome] = async () => { throw new Error(`não deve chamar ${nome}`); };
}
db.getUltimoPedidoDoTelefone = async () => null;
comprovante.receber = async () => { comprovantes++; return true; };
schedule.isOpen = () => true;
notify.register(async (phone, texto) => { textos.push({ phone, texto }); return true; });

async function iniciar(lang = 'pt') {
  atendimento.zerar(); session.clear(CLIENTE); vazao.zerar();
  const sess = session.get(CLIENTE);
  Object.assign(sess, { lang, cart: [], name: 'Teste', state: 'ORDER_COMPLETE' });
  await atendimento.tratar({ phone: CLIENTE, texto: 'quero falar com atendente', sess, send: async () => {} });
  assert(atendimento.aberto(CLIENTE));
  fotos.length = textos.length = respostas.length = 0;
  comprovantes = 0; falharPrimeiro = false;
}
async function repassar(buffer, mimetype) {
  vazao.zerar();
  await router.routeImagem(CLIENTE, buffer, mimetype, async mensagem => respostas.push(mensagem));
}

(async () => {
  assert.equal(sharp.versions.sharp, '0.35.4');
  const lock = require('../package-lock.json');
  for (const [nome, pacote] of Object.entries(lock.packages)) {
    if (nome.endsWith('/sharp')) assert.equal(pacote.version, '0.35.4', 'nenhuma cópia antiga de sharp');
  }
  // O lock também precisa instalar o binário corrigido no Railway/Linux.
  assert.equal(lock.packages['node_modules/@img/sharp-linux-x64'].version, '0.35.4');
  assert.equal(lock.packages['node_modules/@img/sharp-libvips-linux-x64'].version, '1.3.3');
  const biblioteca = path.join(path.dirname(require.resolve('@whiskeysockets/baileys')), 'Utils/messages-media.js');
  const { extractImageThumb } = await import(pathToFileURL(biblioteca).href);
  notify.registerRich({
    sendImage: async (phone, options) => {
      // Mesmo processamento local de miniatura usado pelo envio do Baileys.
      // Não abrir socket nem fazer upload a serviços externos.
      const thumb = await extractImageThumb(options.buffer);
      assert.equal((await sharp(thumb.buffer).metadata()).format, 'jpeg');
      fotos.push({ phone, ...options, thumb });
      if (falharPrimeiro && phone === '15550001111') throw new Error('falha simulada no primeiro admin');
    },
  });

  const imagens = {};
  for (const [formato, mime] of [['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]) {
    const buffer = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#ffcc88' } })
      .toFormat(formato).toBuffer();
    imagens[formato] = buffer;
    assert((await validacao.validar(buffer, mime)).ok, `${formato} válido é aceito`);
    await iniciar();
    await repassar(buffer, mime);
    assert.deepEqual(fotos.map(f => f.phone).sort(), ['15550001111', '15550002222']);
    assert(fotos.every(f => f.mimetype === mime && f.buffer.equals(buffer)), 'original sem alteração');
    assert(fotos.every(f => f.thumb.original.width === 64 && f.thumb.original.height === 48));
    assert.equal(respostas.length, 0, 'foto normal não acrescenta resposta ao cliente');
    assert.equal(comprovantes, 0, 'foto de atendimento não vira comprovante');
  }

  // O tipo normalizado vem da verificação, não do envelope que o cliente informou.
  await iniciar();
  await repassar(imagens.png, 'IMAGE/PNG; charset=binary');
  assert(fotos.every(f => f.mimetype === 'image/png'));

  const grande = Buffer.concat([imagens.jpeg, Buffer.alloc(5 * 1024 * 1024)]);
  const pixelsDemais = await sharp({ create: { width: 5001, height: 5000, channels: 3, background: '#fff' } }).png().toBuffer();
  const casos = [
    ['vazio', Buffer.alloc(0), 'image/jpeg'],
    ['não buffer', 'https://example.invalid/foto.jpg', 'image/jpeg'],
    ['MIME divergente', imagens.png, 'image/jpeg'],
    ['lixo', Buffer.from('foto teste'), 'image/jpeg'],
    ['JPEG apenas cabeçalho', Buffer.from('ffd8ff0000000000000000000000', 'hex'), 'image/jpeg'],
    ['JPEG truncado', imagens.jpeg.subarray(0, imagens.jpeg.length - 10), 'image/jpeg'],
    ['PNG truncado', imagens.png.subarray(0, 40), 'image/png'],
    ['WebP truncado', imagens.webp.subarray(0, 20), 'image/webp'],
    ['SVG disfarçado', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>texto</script></svg>'), 'image/jpeg'],
    ['PDF disfarçado', Buffer.from('%PDF-1.7 conteúdo que não é imagem'), 'image/jpeg'],
    ['AVIF disfarçado', Buffer.from('0000002066747970617669660000000061766966', 'hex'), 'image/jpeg'],
    ['HEIF disfarçado', Buffer.from('0000002066747970686569630000000068656963', 'hex'), 'image/jpeg'],
    ['bytes acima do teto', grande, 'image/jpeg'],
    ['pixels acima do teto', pixelsDemais, 'image/png'],
  ];
  for (const [nome, buffer, mime] of casos) {
    assert(!(await validacao.validar(buffer, mime)).ok, `${nome} deve ser recusado`);
    await iniciar();
    await repassar(buffer, mime);
    assert.equal(fotos.length, 0, `${nome} não chega à miniatura nem aos admins`);
    assert.equal(textos.length, 0, `${nome} não vai como alternativa em texto`);
    assert.equal(respostas.length, 1, 'cliente recebe uma orientação para reenviar');
    assert.equal(comprovantes, 0, 'recusa não cai no fluxo de comprovante');
    assert(atendimento.aberto(CLIENTE), 'recusa preserva atendimento humano');
    assert.equal(atendimento.aberto(CLIENTE).repasses, 1, 'tentativa conta no limite existente');
  }

  for (const lang of ['pt', 'en', 'es']) {
    await iniciar(lang);
    await repassar(Buffer.from('inválido'), 'image/jpeg');
    assert(!respostas[0].includes('atendimento_imagem_'), 'tradução de recusa existe');
    await repassar(imagens.jpeg, 'image/jpeg');
    assert.equal(fotos.length, 2, 'reenvio válido funciona sem reiniciar a conversa');
  }

  // Falha de um destinatário mantém a alternativa em texto e o outro admin.
  await iniciar(); falharPrimeiro = true;
  await repassar(imagens.jpeg, 'image/jpeg');
  assert.equal(fotos.length, 2);
  assert.equal(textos.length, 1);
  assert.equal(textos[0].phone, '15550001111');
  assert.match(textos[0].texto, /foto não pôde/);
  assert.equal(respostas.length, 0);
  assert(atendimento.aberto(CLIENTE));

  await iniciar(); atendimento.aberto(CLIENTE).repasses = 20;
  await repassar(imagens.jpeg, 'image/jpeg');
  assert.equal(fotos.length, 0, 'limite de repasses continua valendo');

  // Fora de atendimento, o caminho existente de comprovante continua intacto.
  atendimento.encerrar(CLIENTE);
  await repassar(imagens.jpeg, 'image/jpeg');
  assert.equal(comprovantes, 1);

  console.log('Sharp corrigido, imagens reais, miniaturas Baileys, recusas e repasse aos dois admins: passaram.');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
