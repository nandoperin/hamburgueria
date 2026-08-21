/**
 * A porta de upload do comprovante.
 *
 * É o único ponto do sistema em que um estranho faz o servidor **gravar um
 * arquivo**. Sem estas checagens o bucket vira depósito de qualquer coisa que
 * alguém queira hospedar no nosso Supabase — e a conta é nossa.
 *
 * `validar()` é testado direto, sem Supabase, sem WhatsApp e sem pedido no
 * banco. É de propósito: teste de segurança que precisa de infraestrutura é
 * teste que ninguém roda.
 */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';
process.env.PROOF_MAX_MB = '5';

const PROJECT = require('path').resolve(__dirname, '..');
const comprovante = require(`${PROJECT}/src/services/comprovante`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

/** Monta um buffer com a assinatura pedida e enchimento até `bytes`. */
function arquivo(assinatura, bytes = 64) {
  const corpo = Buffer.alloc(Math.max(0, bytes - assinatura.length), 0x20);
  return Buffer.concat([Buffer.from(assinatura), corpo]);
}

const JPEG = arquivo([0xff, 0xd8, 0xff, 0xe0]);
const PNG = arquivo([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBP'),
  Buffer.alloc(52),
]);
const PDF = arquivo(Buffer.from('%PDF-1.7'));

(async () => {
  // ------------------------------------------------------ 1. o que deve passar
  console.log('\n\x1b[36m### 1. IMAGENS DE VERDADE ###\x1b[0m');

  const jpg = comprovante.validar(JPEG, 'image/jpeg');
  checar(jpg.ok && jpg.ext === 'jpg', 'JPEG passa e vira .jpg');

  const png = comprovante.validar(PNG, 'image/png');
  checar(png.ok && png.ext === 'png', 'PNG passa e vira .png');

  const webp = comprovante.validar(WEBP, 'image/webp');
  checar(webp.ok && webp.ext === 'webp', 'WEBP passa e vira .webp');

  // O WhatsApp às vezes manda o mimetype com parâmetro junto.
  checar(
    comprovante.validar(JPEG, 'image/jpeg; codecs=baseline').ok,
    'mimetype com parametro extra ainda passa'
  );

  // Sem mimetype declarado, o conteúdo decide sozinho — não é motivo de recusa.
  checar(comprovante.validar(JPEG, undefined).ok, 'sem mimetype declarado, o conteudo decide');

  // ------------------------------------------------- 2. o que NAO deve passar
  console.log('\n\x1b[36m### 2. O QUE A PORTA BARRA ###\x1b[0m');

  const vazio = comprovante.validar(Buffer.alloc(0), 'image/jpeg');
  checar(!vazio.ok && vazio.motivo === 'vazio', 'arquivo vazio e recusado');

  const pdf = comprovante.validar(PDF, 'application/pdf');
  checar(!pdf.ok && pdf.motivo === 'nao_e_imagem', 'PDF e recusado');

  const lixo = comprovante.validar(Buffer.from('nao sou imagem nenhuma!!'), 'image/png');
  checar(!lixo.ok && lixo.motivo === 'nao_e_imagem', 'texto disfarcado de PNG e recusado');

  // ------------------------------------------------------- 3. o mentiroso
  console.log('\n\x1b[36m### 3. QUANDO O ENVELOPE MENTE ###\x1b[0m');

  const mentira = comprovante.validar(PDF, 'image/jpeg');
  checar(
    !mentira.ok && mentira.motivo === 'nao_e_imagem',
    'PDF anunciado como JPEG e recusado pelo CONTEUDO, nao pelo rotulo'
  );

  const divergente = comprovante.validar(PNG, 'image/jpeg');
  checar(
    !divergente.ok && divergente.motivo === 'tipo_divergente',
    'PNG anunciado como JPEG e recusado — os dois estao na lista, mas mentir e sinal ruim'
  );

  // ------------------------------------------------------------ 4. o teto
  console.log('\n\x1b[36m### 4. TETO DE TAMANHO ###\x1b[0m');

  const gigante = Buffer.concat([JPEG, Buffer.alloc(6 * 1024 * 1024)]);
  const grande = comprovante.validar(gigante, 'image/jpeg');
  checar(
    !grande.ok && grande.motivo === 'grande_demais',
    '6 MB com PROOF_MAX_MB=5 e recusado'
  );

  checar(
    comprovante.validar(Buffer.concat([JPEG, Buffer.alloc(1024 * 1024)]), 'image/jpeg').ok,
    '1 MB passa'
  );

  // --------------------------------------------------------- 5. o caminho
  console.log('\n\x1b[36m### 5. O CAMINHO E NOSSO ###\x1b[0m');

  const c1 = comprovante.caminho(42, 'jpg');
  const c2 = comprovante.caminho(42, 'jpg');

  checar(c1.startsWith('comprovantes/42/'), 'o caminho fica sob o id do pedido');
  checar(c1.endsWith('.jpg'), 'a extensao vem do tipo conferido');
  checar(c1 !== c2, 'dois envios do mesmo pedido nao se sobrescrevem');
  checar(
    !c1.includes('..') && !/[^a-zA-Z0-9/.-]/.test(c1),
    'nada de .. nem caractere estranho — nada do cliente entra aqui'
  );

  // O nome que o cliente manda simplesmente não é consultado: `caminho()` só
  // recebe id e extensão. Este teste trava essa assinatura.
  checar(
    comprovante.caminho.length === 2,
    'caminho() recebe SO id e extensao — nao ha por onde um nome de fora entrar'
  );

  // ------------------------------------------------ 6. tipoReal isolado
  console.log('\n\x1b[36m### 6. LEITURA DOS PRIMEIROS BYTES ###\x1b[0m');

  checar(comprovante.tipoReal(JPEG) === 'image/jpeg', 'reconhece JPEG');
  checar(comprovante.tipoReal(PNG) === 'image/png', 'reconhece PNG');
  checar(comprovante.tipoReal(WEBP) === 'image/webp', 'reconhece WEBP');
  checar(comprovante.tipoReal(PDF) === null, 'nao reconhece PDF');
  checar(comprovante.tipoReal(Buffer.alloc(4)) === null, 'buffer curto demais nao quebra');
  checar(comprovante.tipoReal(null) === null, 'null nao quebra');

  console.log('\n\x1b[32mcomprovantetest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
