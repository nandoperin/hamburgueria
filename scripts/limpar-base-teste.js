require('dotenv').config();

/**
 * Remove somente os dados de atendimento usados nos testes.
 *
 * Mantem cardapio, promocoes, configuracoes, itens esgotados e consumo da IA.
 * A ordem respeita as chaves estrangeiras: pagamentos -> pedidos -> clientes.
 * Sem `--apply`, apenas mostra quantos registros seriam removidos.
 */

const aplicar = process.argv.includes('--apply');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log([
    'Conferir: node scripts/limpar-base-teste.js',
    'Apagar:   node scripts/limpar-base-teste.js --apply',
    '',
    'Apaga somente: payments, orders e customers.',
  ].join('\n'));
  process.exit(0);
}

const db = require('../src/db/client');
const TABELAS = ['payments', 'orders', 'customers'];

async function contar(tabela) {
  const { rows } = await db.query(`select count(*)::bigint as total from ${tabela}`);
  return Number(rows[0].total);
}

async function apagarTudo(tabela) {
  // O filtro explicito e obrigatorio: evita um DELETE sem alvo por acidente.
  await db.query(`delete from ${tabela} where id is not null`);
}

async function main() {
  const antes = {};
  for (const tabela of TABELAS) antes[tabela] = await contar(tabela);

  console.log('Base de atendimento:');
  for (const tabela of TABELAS) console.log(`  ${tabela}: ${antes[tabela]}`);

  if (!aplicar) {
    console.log('\nNada foi apagado. Use --apply para executar a limpeza.');
    return;
  }

  for (const tabela of TABELAS) await apagarTudo(tabela);

  const depois = {};
  for (const tabela of TABELAS) depois[tabela] = await contar(tabela);
  const restantes = Object.values(depois).reduce((total, quantidade) => total + quantidade, 0);
  if (restantes) {
    throw new Error(`Limpeza incompleta: ${JSON.stringify(depois)}`);
  }

  console.log('\nLimpeza concluida e conferida. Os telefones voltarao como clientes novos.');
  console.log('Reinicie o bot para apagar tambem as sessoes que ainda estejam em memoria.');
}

main().catch((err) => {
  console.error(`Erro: ${err.message}`);
  process.exit(1);
}).finally(() => {
  db.end();
});
