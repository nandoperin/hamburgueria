/**
 * Migração única: PostgreSQL do Supabase -> PostgreSQL Railway.
 *
 * Não lê nem copia o bucket de comprovantes. A coluna antiga `proof_path`
 * também é descartada; somente `proof_received_at` acompanha o pagamento.
 */
require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const aplicar = process.argv.includes('--apply');
const sourceDatabaseUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;

const TABELAS = [
  { nome: 'customers', colunas: ['id', 'phone', 'name', 'email', 'lang', 'created_at', 'updated_at'] },
  { nome: 'orders', colunas: ['id', 'customer_id', 'phone', 'lang', 'items_json', 'order_type',
    'customer_name', 'city', 'address', 'subtotal', 'delivery_fee', 'total', 'status', 'created_at'] },
  { nome: 'payments', colunas: ['id', 'order_id', 'method', 'amount', 'status',
    'proof_received_at', 'approved_by', 'approved_at', 'rejected_reason', 'paid_at'] },
  { nome: 'bot_settings', colunas: ['key', 'value', 'updated_at'] },
  { nome: 'item_availability', colunas: ['item_id', 'available', 'updated_at'] },
  { nome: 'ai_usage', colunas: ['dia', 'chamadas', 'tokens_in', 'tokens_out', 'custo_usd', 'updated_at'] },
  { nome: 'config_docs', colunas: ['key', 'doc', 'updated_at', 'updated_by'] },
  { nome: 'config_historico', colunas: ['id', 'key', 'doc_antes', 'mudou_em', 'mudou_quem', 'resumo'] },
];

function exigirAmbiente() {
  const faltando = [];
  if (!sourceDatabaseUrl) faltando.push('SOURCE_DATABASE_URL');
  if (!targetUrl && aplicar) faltando.push('TARGET_DATABASE_URL');
  if (faltando.length) throw new Error(`Variáveis ausentes: ${faltando.join(', ')}`);
}

async function lerOrigem() {
  const source = new Pool({
    connectionString: sourceDatabaseUrl,
    max: 2,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
  });
  const dados = {};
  try {
    for (const tabela of TABELAS) {
      // A lista explícita é também a garantia de que `proof_path` nunca sai da
      // origem, mesmo que continue existindo na tabela antiga.
      const { rows } = await source.query(
        `select ${tabela.colunas.join(', ')} from ${tabela.nome}`
      );
      dados[tabela.nome] = rows;
      console.log(`  origem ${tabela.nome}: ${rows.length}`);
    }
  } finally {
    await source.end();
  }
  return dados;
}

async function inserirLotes(client, tabela, linhas) {
  if (!linhas.length) return;
  const tamanho = 250;
  for (let inicio = 0; inicio < linhas.length; inicio += tamanho) {
    const lote = linhas.slice(inicio, inicio + tamanho);
    const valores = [];
    const grupos = lote.map((linha) => {
      const marcadores = tabela.colunas.map((coluna) => {
        let valor = linha[coluna];
        if ((coluna === 'items_json' || coluna === 'doc' || coluna === 'doc_antes') && valor !== null) {
          valor = JSON.stringify(valor);
        }
        valores.push(valor);
        const indice = valores.length;
        return ['items_json', 'doc', 'doc_antes'].includes(coluna) ? `$${indice}::jsonb` : `$${indice}`;
      });
      return `(${marcadores.join(', ')})`;
    });
    await client.query(
      `insert into ${tabela.nome} (${tabela.colunas.join(', ')}) values ${grupos.join(', ')}`,
      valores
    );
  }
}

async function conferirVazio(client) {
  for (const tabela of TABELAS) {
    const { rows } = await client.query(`select count(*)::bigint as total from ${tabela.nome}`);
    if (Number(rows[0].total) !== 0) {
      throw new Error(`Destino não está vazio: ${tabela.nome} tem ${rows[0].total} registro(s)`);
    }
  }
}

async function ajustarIdentidades(client) {
  for (const nome of ['customers', 'orders', 'payments', 'config_historico']) {
    await client.query(
      `select setval(
         pg_get_serial_sequence('${nome}', 'id'),
         coalesce((select max(id) from ${nome}), 1),
         exists(select 1 from ${nome})
       )`
    );
  }
}

async function migrar(dados) {
  const pool = new Pool({ connectionString: targetUrl, max: 2, connectionTimeoutMillis: 15_000 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
    await client.query(schema);
    await conferirVazio(client);
    for (const tabela of TABELAS) {
      await inserirLotes(client, tabela, dados[tabela.nome]);
    }
    await ajustarIdentidades(client);
    await client.query('commit');

    for (const tabela of TABELAS) {
      const { rows } = await client.query(`select count(*)::bigint as total from ${tabela.nome}`);
      const total = Number(rows[0].total);
      if (total !== dados[tabela.nome].length) {
        throw new Error(`Conferência falhou em ${tabela.nome}: origem ${dados[tabela.nome].length}, destino ${total}`);
      }
      console.log(`  destino ${tabela.nome}: ${total}`);
    }
  } catch (err) {
    try { await client.query('rollback'); } catch (_rollbackErr) {}
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  exigirAmbiente();
  console.log('Lendo tabelas do Supabase (arquivos de comprovante não são acessados):');
  const dados = await lerOrigem();
  if (!aplicar) {
    console.log('\nSomente conferência. Use --apply para gravar no Railway.');
    return;
  }
  console.log('\nGravando no PostgreSQL Railway:');
  await migrar(dados);
  console.log('\nMigração concluída e quantidades conferidas.');
}

main().catch((err) => {
  console.error(`Erro: ${err.message}`);
  process.exitCode = 1;
});
