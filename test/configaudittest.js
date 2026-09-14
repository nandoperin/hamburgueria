const assert = require('node:assert/strict');

process.env.DATABASE_URL = 'postgresql://fake';
const clientPath = require.resolve('../src/db/client');
let falharHistorico = false;
let chamadas = [];
const cliente = {
  query: async (sql, params) => {
    chamadas.push({ sql: String(sql), params });
    if (/select doc from config_docs/.test(sql)) return { rows: [{ doc: { antigo: true } }] };
    if (/insert into config_docs/.test(sql)) return { rows: [{ key: 'menu' }] };
    if (/insert into config_historico/.test(sql) && falharHistorico) throw Error('historico indisponivel');
    return { rows: [] };
  },
  release() { chamadas.push({ sql: 'release' }); },
};
require.cache[clientPath] = {
  id: clientPath, filename: clientPath, loaded: true,
  exports: { connect: async () => cliente, query: async () => ({ rows: [] }) },
};

const db = require('../src/db/queries');

(async () => {
  let r = await db.setConfigDocComHistorico('menu', { novo: true }, '16170000000');
  assert.deepEqual(r.anterior, { antigo: true });
  assert.ok(chamadas.some((c) => c.sql === 'begin'));
  assert.ok(chamadas.some((c) => /insert into config_historico/.test(c.sql)));
  assert.ok(chamadas.some((c) => c.sql === 'commit'));
  assert.ok(!chamadas.some((c) => c.sql === 'rollback'));

  chamadas = [];
  falharHistorico = true;
  await assert.rejects(() => db.setConfigDocComHistorico('menu', { novo: false }, '16170000000'));
  assert.ok(chamadas.some((c) => c.sql === 'rollback'), 'falha no histórico desfaz a configuração');
  assert.ok(!chamadas.some((c) => c.sql === 'commit'), 'não há commit parcial');
  console.log('Configuração e histórico são atômicos.');
})().catch((err) => { console.error(err); process.exit(1); });
