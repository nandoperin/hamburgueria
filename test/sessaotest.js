/**
 * Apagar a sessão revogada sem arrancar o ponto de montagem.
 *
 * Esta suíte existe por um erro que só apareceu em produção:
 *
 *     err.code: EBUSY  err.syscall: rmdir  err.path: /app/auth_info_baileys
 *
 * `/app/auth_info_baileys` é o **ponto de montagem** do volume do Railway.
 * `fs.rmSync(dir)` tenta remover o diretório em si, e o kernel recusa — não se
 * desmonta um volume apagando a pasta. Localmente o teste nunca pegaria isso
 * por acidente: ali é um diretório comum e o `rmSync` funciona.
 *
 * A diferença é entre **esvaziar a gaveta** e **arrancar a gaveta do móvel**.
 * Só a primeira é possível quando o móvel é o sistema de arquivos — e é
 * exatamente essa distinção que os cenários abaixo travam.
 *
 * Por que vale uma suíte para quatro linhas de código: isto roda uma vez por
 * ano, no pior momento possível (sessão caiu, ninguém olhando), e é onde um
 * erro fica escondido por meses. Foi o que aconteceu.
 */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const { apagarSessao } = require(`${PROJECT}/src/bot/index`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

/** Um diretório de sessão de mentira, parecido com o que o Baileys deixa. */
function montarSessaoFalsa() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-teste-'));
  fs.writeFileSync(path.join(dir, 'creds.json'), '{"registered":true}');
  fs.writeFileSync(path.join(dir, 'app-state-sync-key-AAAA.json'), '{}');
  fs.writeFileSync(path.join(dir, 'session-15551234567.0.json'), '{}');
  // O Baileys também cria subpastas em algumas versões — o apagador tem que
  // dar conta das duas formas.
  fs.mkdirSync(path.join(dir, 'pre-keys'));
  fs.writeFileSync(path.join(dir, 'pre-keys', '1.json'), '{}');
  return dir;
}

(async () => {
  // ------------------------------------ 1. o conteúdo some, a pasta fica
  console.log('\n\x1b[36m### 1. ESVAZIA A GAVETA, NAO ARRANCA A GAVETA ###\x1b[0m');
  const dir = montarSessaoFalsa();
  checar(fs.readdirSync(dir).length === 4, 'a sessão de mentira começa com 4 entradas');

  apagarSessao(dir);

  checar(
    fs.existsSync(dir),
    'o DIRETORIO continua existindo — em produção ele é o ponto de montagem do volume'
  );
  checar(
    fs.readdirSync(dir).length === 0,
    'e está vazio: credencial revogada não sobra nem em subpasta'
  );

  fs.rmSync(dir, { recursive: true, force: true });

  // ------------------------------------------- 2. rodar duas vezes é seguro
  console.log('\n\x1b[36m### 2. APAGAR DUAS VEZES NAO QUEBRA ###\x1b[0m');
  const dir2 = montarSessaoFalsa();
  apagarSessao(dir2);
  apagarSessao(dir2); // já está vazio
  checar(fs.existsSync(dir2), 'a segunda chamada não derruba nada');
  checar(fs.readdirSync(dir2).length === 0, 'e o diretório segue vazio');
  fs.rmSync(dir2, { recursive: true, force: true });

  // --------------------------- 3. diretório inexistente é sucesso, não erro
  console.log('\n\x1b[36m### 3. SEM DIRETORIO, NAO HA O QUE APAGAR ###\x1b[0m');
  const inexistente = path.join(os.tmpdir(), 'auth-que-nunca-existiu-' + Date.now());
  let lancou = false;
  try {
    apagarSessao(inexistente);
  } catch {
    lancou = true;
  }
  checar(
    !lancou,
    'diretório ausente não lança — é o caso do primeiro boot, e não é falha'
  );

  console.log('\n\x1b[32msessaotest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
