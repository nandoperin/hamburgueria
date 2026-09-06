// Importação pontual autorizada pelo dono. Nunca executado no boot/deploy.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const db = require('../src/db/client');
const config = require('../src/services/config');
const cardapio = require('../src/services/cardapio');
const novos = {
  menu: require('../config/menu.json'),
  ingredientes: require('../config/ingredientes.json'),
};
const faqFonte = require('../config/faq.json');
const QUEM = 'cardapio-real-2026-09-03';

async function run() {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL ausente');
  const { rows: atuais } = await db.query(
    `select key, doc from config_docs where key = any($1::text[])`,
    [['menu', 'ingredientes', 'faq']]
  );
  assert.equal(atuais.length, 3, 'Faltam configurações; não aplicar importação parcial.');
  // Preserva demais respostas que o proprietário possa ter editado no painel.
  novos.faq = atuais.find(d => d.key === 'faq').doc.map(item =>
    ['vegan','gluten_free'].includes(item.id) ? {...item, answer:faqFonte.find(i=>i.id===item.id).answer} : item);
  for (const [key, doc] of Object.entries(novos)) assert.deepEqual(config.validar(key,doc), []);
  assert.deepEqual(cardapio.conferir(), []);
  console.log('Point Burger confirmado: 28 produtos, ingredientes reais, duas respostas do FAQ corrigidas.');
  if (!process.argv.includes('--apply')) { console.log('Somente conferência. Nenhuma alteração.'); return; }
  const alterados = atuais.filter(row => !isDeepStrictEqual(row.doc, novos[row.key]));
  if (!alterados.length) { console.log('Dados já correspondem à versão enviada.'); return; }
  const client = await db.connect();
  try {
    await client.query('begin');
    for (const row of alterados) {
      await client.query(
        `insert into config_historico (key, doc_antes, mudou_quem, resumo)
         values ($1, $2::jsonb, $3, $4)`,
        [row.key, JSON.stringify(row.doc), QUEM,
          'Cardápio real enviado pelo proprietário; cópia anterior preservada.']
      );
      await client.query(
        `insert into config_docs (key, doc, updated_by, updated_at)
         values ($1, $2::jsonb, $3, now())
         on conflict (key) do update set doc=excluded.doc,
           updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
        [row.key, JSON.stringify(novos[row.key]), QUEM]
      );
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
  const { rows: leitura } = await db.query(
    `select key, doc from config_docs where key = any($1::text[])`,
    [alterados.map(r => r.key)]
  );
  for (const row of leitura) assert.deepEqual(row.doc, novos[row.key]);
  console.log('Atualizado e relido: ' + alterados.map(r=>r.key).join(', ') + '. Pedidos e pagamentos preservados.');
}
run().catch(err => { console.error(err.message); process.exitCode = 1; }).finally(() => db.end());
