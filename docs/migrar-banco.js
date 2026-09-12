#!/usr/bin/env node
/**
 * Cria o schema e carrega os dados no banco novo, numa transação só.
 *
 * Feito para rodar com a CLI do Railway injetando as variáveis:
 *
 *   railway link                          # escolha o projeto e o servico Postgres
 *   railway run node scripts/migrar-banco.js
 *
 * Assim a senha do banco nunca é digitada, exibida nem colada em lugar nenhum —
 * ela existe só dentro do processo.
 *
 * É seguro rodar de novo: o schema usa `CREATE TABLE IF NOT EXISTS`, e a carga
 * de dados é pulada se as tabelas já tiverem conteúdo. Nada é sobrescrito.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const RAIZ = path.resolve(__dirname, '..');
const SCHEMA = path.join(RAIZ, 'src', 'db', 'schema.sql');
const DADOS = path.join(RAIZ, 'backups', 'dados-2026-08-22.sql');

const { resolver } = require('./conexao');

let conexao;
try {
  conexao = resolver();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const client = new Client({
  connectionString: conexao.url,
  ssl: conexao.ssl,
  connectionTimeoutMillis: 15_000,
});

async function contar(tabela) {
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${tabela}`);
  return rows[0].n;
}

async function main() {
  console.log(`Conectando pelo ${conexao.via}...`);
  await client.connect();
  console.log('Conectado.\n');

  // ------------------------------------------------------------------ schema
  console.log('1) Aplicando o schema...');
  await client.query(fs.readFileSync(SCHEMA, 'utf8'));
  console.log('   tabelas, índices e RLS no lugar.\n');

  // ------------------------------------------------------------------- dados
  const jaTem = await contar('orders');
  if (jaTem > 0) {
    console.log(`2) Dados: pulando — a tabela orders já tem ${jaTem} registro(s).`);
    console.log('   (esvazie o banco primeiro se quiser recarregar do zero)\n');
  } else if (!fs.existsSync(DADOS)) {
    console.log(`2) Dados: arquivo não encontrado em ${DADOS} — seguindo com o banco vazio.\n`);
  } else {
    console.log('2) Carregando os dados...');
    // Transação: ou entra tudo, ou não entra nada. Um banco meio carregado
    // seria pior que um vazio — os pedidos referenciam clientes.
    await client.query('BEGIN');
    try {
      await client.query(fs.readFileSync(DADOS, 'utf8'));
      await client.query('COMMIT');
      console.log('   carregados.\n');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`carga desfeita (rollback): ${err.message}`);
    }
  }

  // ------------------------------------------------------------ sequências
  //
  // Ids inseridos explicitamente não avançam o contador. Sem isto, o próximo
  // pedido nasceria com id 1 e colidiria com o pedido 1 — e o cliente receberia
  // "payment_error" sem ninguém entender por quê.
  console.log('3) Ajustando as sequências...');
  for (const t of ['customers', 'orders', 'payments']) {
    await client.query(
      `SELECT setval('${t}_id_seq', (SELECT COALESCE(MAX(id), 1) FROM ${t}))`
    );
  }
  const { rows: prox } = await client.query(
    `SELECT last_value FROM orders_id_seq`
  );
  console.log(`   próximo pedido nasce depois do id ${prox[0].last_value}.\n`);

  // ------------------------------------------------------------ conferência
  console.log('4) Conferência:');
  for (const t of ['customers', 'orders', 'payments', 'bot_settings', 'item_availability']) {
    console.log(`   ${t.padEnd(18)} ${await contar(t)}`);
  }

  const { rows: ref } = await client.query(
    'SELECT count(*)::int AS n FROM payments WHERE square_payment_id IS NOT NULL'
  );
  console.log(`   ${'com id do Square'.padEnd(18)} ${ref[0].n}`);
}

main()
  .then(() => console.log('\n\x1b[32mMigração concluída.\x1b[0m'))
  .catch((err) => {
    console.error(`\n\x1b[31mFALHOU: ${err.message}\x1b[0m`);
    process.exitCode = 1;
  })
  .finally(() => client.end());
