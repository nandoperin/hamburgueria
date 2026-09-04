const assert = require('assert/strict');
const vm = require('vm');

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';

const config = require('../src/services/config');
const promotions = require('../src/services/promotions');
const cardapio = require('../src/services/cardapio');
const catalog = require('../src/services/catalog');
const pagina = require('../src/api/painel-page');

const doc = config.get('promotions');
const estadoOriginal = { automatic: doc.automatic, manual_active: doc.manual_active };

try {
  assert.equal(promotions.ativa(new Date('2026-09-03T03:59:59Z')), false,
    'ainda e quarta-feira em Nova York');
  assert.equal(promotions.ativa(new Date('2026-09-03T04:00:00Z')), true,
    'ativa quinta-feira a meia-noite em Nova York');
  assert.equal(promotions.ativa(new Date('2026-09-04T03:59:59Z')), true,
    'continua ativa ate o fim da quinta-feira');
  assert.equal(promotions.ativa(new Date('2026-09-04T04:00:00Z')), false,
    'desativa sexta-feira a meia-noite em Nova York');

  doc.automatic = false;
  doc.manual_active = true;
  assert.equal(promotions.ativa(), true, 'modo manual pode liberar fora da quinta');
  doc.manual_active = false;
  assert.equal(promotions.ativa(), false, 'modo manual tambem pode bloquear');

  const categorias = cardapio.categorias();
  assert.equal(categorias[0].id, 'sanduiches');
  assert.equal(categorias[1].id, 'promocao', 'promocao fica ao lado de sanduiches');
  const promo = categorias[1];
  assert.equal(promo.items.length, 7);
  assert.deepEqual(promo.items.map(i => [i.id, i.price]), [
    ['promo_quintou_x_tudo', 18],
    ['promo_quintou_3_x_tudo', 50],
    ['promo_quintou_hot_especial', 10],
    ['promo_quintou_hot_completo', 10],
    ['promo_quintou_hot_tudo', 13],
    ['promo_quintou_x_bacon', 16],
    ['promo_quintou_3_x_bacon', 45],
  ]);
  assert.equal(promo.items.every(i => i.catalogVisible === false), true,
    'promocoes nao entram no catalogo permanente do WhatsApp');
  assert.equal(promo.items.find(i => i.bundleQuantity === 3).modifiers, undefined,
    'pacote de tres nao cobra uma alteracao ambigua nas tres unidades');

  doc.manual_active = true;
  assert.equal(cardapio.categoriasDisponiveis().some(c => c.id === 'promocao'), true);
  doc.manual_active = false;
  assert.equal(cardapio.categoriasDisponiveis().some(c => c.id === 'promocao'), false);
  assert.match(cardapio.mensagemIndisponivel(promo.items[0], 'pt'), /não está ativa/);

  assert.equal(catalog.feedRows({
    siteUrl: 'https://loja.test', brand: 'Point Burger',
  }).length, 28, 'feed do WhatsApp continua apenas com os 28 produtos regulares');

  assert.deepEqual(config.validar('promotions', doc), []);
  const html = pagina.render('sessao', 30);
  assert.match(html, /🔥 Promoção/);
  assert.match(html, /Ativar automaticamente toda quinta-feira/);
  assert.match(html, /desativa sexta-feira às 00h/);
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  new vm.Script(script);

  console.log('Promo Quintou cadastrada, agendada e fora do catálogo permanente.');
} finally {
  doc.automatic = estadoOriginal.automatic;
  doc.manual_active = estadoOriginal.manual_active;
}
