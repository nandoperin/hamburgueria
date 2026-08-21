process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.WHATSAPP_PROVIDER = 'meta';
process.env.META_PHONE_NUMBER_ID = 'FAKEPHONE';
process.env.META_ACCESS_TOKEN = 'faketoken';

const http = require('http');
const PROJECT = require('path').resolve(__dirname, '..');

// O banco e a Graph API são trocados por interruptores que cada cenário liga
// e desliga — é a falha de cada um que se quer testar, não o sucesso.
let bancoResponde = true;
let metaResponde = true;

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  ping: async () => {
    if (!bancoResponde) throw new Error('conexao recusada');
    return true;
  },
  getUnprintedPaidOrders: async () => [],
};

global.fetch = async () => {
  if (!metaResponde) {
    return { ok: false, status: 401, json: async () => ({ error: { message: 'token expirado' } }) };
  }
  return { ok: true, status: 200, json: async () => ({ id: 'FAKEPHONE' }) };
};

const health = require(`${PROJECT}/src/services/health`);
const { app } = require(`${PROJECT}/src/api`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const titulo = (n) => console.log(`\n\x1b[33m### ${n} ###\x1b[0m`);

/** Sobe o app numa porta livre e faz um GET /health de verdade. */
function consultar(servidor) {
  const { port } = servidor.address();
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
        let corpo = '';
        res.on('data', (c) => (corpo += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: JSON.parse(corpo) })
        );
      })
      .on('error', reject);
  });
}

(async () => {
  const servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));

  // ============================================================== tudo bem
  titulo('TUDO NO AR');

  health.limparCache();
  let r = await consultar(servidor);

  checar(r.status === 200, 'responde 200 quando banco e WhatsApp respondem');
  checar(r.body.ok === true && r.body.falhas.length === 0, 'sem falhas apontadas');
  checar(typeof r.body.uptime === 'number', 'informa ha quanto tempo esta de pe');

  // ========================================================== banco fora
  titulo('BANCO FORA DO AR');

  bancoResponde = false;
  health.limparCache();
  r = await consultar(servidor);

  checar(r.status === 503, 'responde 503 — e o codigo que faz o monitor tocar');
  checar(
    r.body.falhas.includes('banco'),
    'e diz qual parte caiu, para o alerta chegar util'
  );

  // ==================================================== token da Meta morto
  titulo('TOKEN DA META EXPIRADO');

  bancoResponde = true;
  metaResponde = false;
  health.limparCache();
  r = await consultar(servidor);

  checar(
    r.status === 503 && r.body.falhas.includes('whatsapp'),
    'token vencido derruba a saude — antes o bot ficava mudo parecendo vivo'
  );
  checar(!r.body.falhas.includes('banco'), 'sem culpar o banco, que esta bem');

  // ================================================================ cache
  titulo('CACHE');

  metaResponde = true;
  health.limparCache();
  await consultar(servidor);

  bancoResponde = false; // quebra o banco sem limpar o cache
  r = await consultar(servidor);
  checar(
    r.status === 200,
    'a segunda consulta em seguida reaproveita o resultado, sem bater no banco de novo'
  );

  health.limparCache();
  r = await consultar(servidor);
  checar(r.status === 503, 'passado o cache, a falha aparece');

  // ============================== o bot mudo com o token valido
  titulo('ENVIO BLOQUEADO, TOKEN AINDA VALIDO');

  const notify = require(`${PROJECT}/src/bot/notify`);
  process.env.ADMIN_PHONE = '15550001111';

  bancoResponde = true;
  metaResponde = true; // a consulta do token continua respondendo 200
  notify.zerarEnvio();

  const recebidasPeloDono = [];
  notify.register(async (phone, texto) => {
    if (phone === '15550001111' && /nao esta conseguindo|não está conseguindo/i.test(texto)) {
      recebidasPeloDono.push(texto);
      return;
    }
    // Toda mensagem a cliente e recusada — e o que um bloqueio de conta faz.
    throw Object.assign(new Error('account restricted'), { status: 403 });
  });

  health.limparCache();
  r = await consultar(servidor);
  checar(r.status === 200, 'uma falha isolada nao derruba a saude');

  await notify.send('15551112222', 'oi');
  await notify.send('15553334444', 'oi');
  await notify.send('15555556666', 'oi');

  health.limparCache();
  r = await consultar(servidor);

  checar(
    r.status === 503 && r.body.falhas.includes('envio'),
    'tres falhas seguidas derrubam — mesmo com banco e token respondendo'
  );
  checar(
    !r.body.falhas.includes('whatsapp'),
    'e o token continua passando: sao checagens diferentes, de propositos diferentes'
  );
  checar(
    recebidasPeloDono.length === 1,
    'o dono recebe um aviso pelo WhatsApp — um so, nao um por falha'
  );

  notify.register(async () => {}); // o envio volta
  await notify.send('15551112222', 'oi');
  health.limparCache();
  r = await consultar(servidor);
  checar(r.status === 200, 'e um envio que funciona zera a contagem');

  notify.zerarEnvio();

  // ======================================================== nada vazando
  titulo('O QUE O ENDPOINT PUBLICO REVELA');

  bancoResponde = true;
  health.limparCache();
  r = await consultar(servidor);

  const campos = Object.keys(r.body).sort().join(', ');
  checar(
    campos === 'falhas, impressora, ok, uptime',
    `so os campos previstos: ${campos}`
  );

  const bruto = JSON.stringify(r.body);
  checar(
    !bruto.includes('faketoken') && !bruto.includes('fake.supabase.co'),
    'nenhum segredo nem URL de servico no corpo publico'
  );

  servidor.close();
  console.log('\n\x1b[32mTodos os cenarios passaram.\x1b[0m');
})().catch((e) => {
  console.error('\n\x1b[31mFALHOU:\x1b[0m', e.message);
  process.exit(1);
});
