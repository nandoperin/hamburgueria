const assert = require('assert/strict');

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';

const antigo = {
  automatic: true,
  manual_active: false,
  weekday: 4,
  timezone: 'America/New_York',
  category: {
    id: 'promocao',
    name: { pt: 'Promoção' },
    items: [{
      id: 'promo_quintou_x_tudo',
      base_item_id: 'x_tudo',
      bundle_quantity: 1,
      name: { pt: 'Promo Quintou — X Tudo' },
      description: { pt: 'Somente quinta.' },
      price: 17,
      available: false,
    }],
  },
};

const dbPath = require.resolve('../src/db/queries');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    getConfigDocs: async () => [{ key: 'promotions', doc: antigo }],
    setConfigDoc: async () => {},
  },
};

(async () => {
  const config = require('../src/services/config');
  assert.equal(await config.recarregar(), true);

  const migrado = config.get('promotions');
  assert.equal(migrado.schema_version, 2);
  assert.deepEqual(migrado.weekdays, [2, 3]);
  assert.equal(migrado.weekday, undefined);
  assert.ok(Array.isArray(migrado.category.items));
  assert.equal(migrado.category.items.length, 9);

  const xTudo = migrado.category.items.find((item) =>
    item.base_item_id === 'x_tudo' && item.bundle_quantity === 1);
  assert.equal(xTudo.price, 17, 'preserva o preço que estava no banco');
  assert.equal(xTudo.available, false, 'preserva a disponibilidade que estava no banco');
  assert.ok(
    migrado.category.items.some((item) => item.base_item_id === 'macarrao_chapa'),
    'acrescenta as ofertas novas durante a migração'
  );

  console.log('Migração da promoção antiga carregada do banco passou.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
