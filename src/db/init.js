/**
 * Verifica a conexão com o PostgreSQL e se as tabelas existem.
 */
require('dotenv').config();

const db = require('./client');

const TABLES = [
  'customers', 'orders', 'payments', 'bot_settings', 'item_availability',
  'ai_usage', 'config_docs', 'config_historico', 'conversas_log',
  'printer_devices', 'printer_pairing_codes',
];

async function main() {
  console.log('Verificando conexão com o PostgreSQL...\n');

  let allOk = true;

  for (const table of TABLES) {
    try {
      await db.query(`select 1 from ${table} limit 1`);
      console.log(`  ✓ ${table}`);
    } catch (error) {
      allOk = false;
      console.log(`  ✗ ${table} — ${error.message}`);
    }
  }

  if (allOk) {
    console.log('\nTudo certo. O banco está pronto para uso.');
    return;
  }

  console.log('\nAlguma tabela está faltando. Aplique src/db/schema.sql e tente novamente.');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('Erro ao conectar:', err.message);
  process.exitCode = 1;
}).finally(() => {
  db.end();
});
