/**
 * Verifica a conexão com o Supabase e se as tabelas existem.
 *
 * O schema (src/db/schema.sql) deve ser aplicado manualmente uma vez
 * no SQL Editor do Supabase — este script apenas confirma que funcionou.
 */
require('dotenv').config();

const path = require('path');
const supabase = require('./client');

const TABLES = ['customers', 'orders', 'payments'];

async function main() {
  console.log('Verificando conexão com o Supabase...\n');

  let allOk = true;

  for (const table of TABLES) {
    const { error } = await supabase.from(table).select('id').limit(1);

    if (error) {
      allOk = false;
      console.log(`  ✗ ${table} — ${error.message}`);
    } else {
      console.log(`  ✓ ${table}`);
    }
  }

  if (allOk) {
    console.log('\nTudo certo. O banco está pronto para uso.');
    return;
  }

  const schemaPath = path.join(__dirname, 'schema.sql');
  console.log('\nAlguma tabela está faltando. Para criar:');
  console.log('  1. Acesse seu projeto em supabase.com');
  console.log('  2. Abra o SQL Editor');
  console.log(`  3. Cole o conteúdo de ${schemaPath}`);
  console.log('  4. Execute e rode este script novamente');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('Erro ao conectar:', err.message);
  process.exitCode = 1;
});
