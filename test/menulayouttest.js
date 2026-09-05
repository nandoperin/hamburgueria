process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.LOG_LEVEL = 'silent';

const assert = require('node:assert/strict');
const notify = require('../src/bot/notify');
const menu = require('../src/bot/handlers/menu');

let enviada = '';
notify.register(async (_phone, text) => {
  enviada = text;
});
// Simula Baileys: há envio de texto, mas não existe lista interativa nativa.
notify.registerRich(null);

(async () => {
  const categories = menu.getAvailableCategories();
  assert.ok(categories.length > 1, 'o cardápio de teste deve ter várias categorias');

  for (const category of categories) {
    enviada = '';
    const session = { phone: '15555550123', lang: 'pt', state: 'MENU' };
    await menu.sendCategoryMenu(session, category, async () => {});

    const expected = session.menuSelection.ids.length;
    const block = enviada.split('```')[1].trim();
    const rows = block.split('\n');
    assert.equal(rows.length, expected, `${category.id}: uma linha por produto, sem linhas vazias`);
    for (const row of rows) assert.match(row, /^\d+\. .+ {2,}\$\d+\.\d{2}$/);
    assert.equal(new Set(rows.map(row => Array.from(row).length)).size, 1,
      `${category.id}: preços terminam na mesma coluna`);

    assert.match(enviada, /número ou nome do produto/, `${category.id}: instrução aceita número e nome`);
  }

  console.log('Categorias em texto com nome, preço e espaçamento para celular: OK.');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
