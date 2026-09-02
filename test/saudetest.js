process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.WHATSAPP_PROVIDER = 'meta';

const http = require('http');
const PROJECT = require('path').resolve(__dirname, '..');

// Se o health tentar consultar qualquer dependencia externa, a suite falha.
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  ping: async () => {
    throw new Error('o health nao deve consultar o banco');
  },
  getUnprintedPaidOrders: async () => [],
};

const printwatchPath = require.resolve(`${PROJECT}/src/services/printwatch`);
require(printwatchPath);
require.cache[printwatchPath].exports = {
  status: () => {
    throw new Error('o health nao deve consultar a impressora');
  },
};

global.fetch = async () => {
  throw new Error('o health nao deve consultar o WhatsApp');
};

const { app } = require(`${PROJECT}/src/api`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

function consultar(servidor) {
  const { port } = servidor.address();
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
        let corpo = '';
        res.on('data', (c) => (corpo += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(corpo) }));
      })
      .on('error', reject);
  });
}

(async () => {
  const servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));

  const r = await consultar(servidor);

  checar(r.status === 200, 'responde 200 sem depender de servicos externos');
  checar(r.body.ok === true, 'confirma que o processo esta vivo');
  checar(typeof r.body.uptime === 'number', 'informa ha quanto tempo esta de pe');
  checar(
    Object.keys(r.body).sort().join(', ') === 'ok, uptime',
    'nao consulta nem publica banco, WhatsApp ou impressora'
  );

  servidor.close();
  console.log('\n\x1b[32mTodos os cenarios passaram.\x1b[0m');
})().catch((e) => {
  console.error('\n\x1b[31mFALHOU:\x1b[0m', e.message);
  process.exit(1);
});
