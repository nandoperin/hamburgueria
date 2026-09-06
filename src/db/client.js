const { Pool, types } = require('pg');

// Mantém o formato que o restante do bot já consumia pelo Supabase: valores
// numéricos como Number e datas como ISO/string. IDs deste projeto ficam muito
// abaixo do limite seguro de Number.
types.setTypeParser(20, (value) => Number(value)); // int8 / bigint
types.setTypeParser(1700, (value) => Number(value)); // numeric
types.setTypeParser(1114, (value) => value); // timestamp
types.setTypeParser(1184, (value) => value); // timestamptz

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 10,
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS) || 10_000,
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS) || 30_000,
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 20_000,
  application_name: 'point-burger-bot',
});

pool.on('error', (err) => {
  require('../log').error({ evt: 'banco', err }, 'conexão ociosa do PostgreSQL falhou');
});

module.exports = pool;
