const assert = require('assert/strict');
const vm = require('vm');

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';

const config = require('../src/services/config');
const promotions = require('../src/services/promotions');
const cardapio = require('../src/services/cardapio');
const catalog = require('../src/services/catalog');
const pagina = require('../src/api/painel-page');
const tools = require('../src/ai/tools');

const doc = config.get('promotions');
const estadoOriginal = {
  automatic: doc.automatic,
  manual_active: doc.manual_active,
  disabled_date: doc.disabled_date,
};

(async () => {
  try {
    assert.equal(promotions.ativa(new Date('2026-09-01T03:59:59Z')), false,
      'ainda e segunda-feira em Nova York');
    assert.equal(promotions.ativa(new Date('2026-09-01T04:00:00Z')), true,
      'ativa terca-feira a meia-noite em Nova York');
    assert.equal(promotions.ativa(new Date('2026-09-02T16:00:00Z')), true,
      'continua ativa durante a quarta-feira');
    assert.equal(promotions.ativa(new Date('2026-09-03T03:59:59Z')), true,
      'continua ativa ate o fim da quarta-feira');
    assert.equal(promotions.ativa(new Date('2026-09-03T04:00:00Z')), false,
      'desativa quinta-feira a meia-noite em Nova York');

    doc.disabled_date = '2026-09-01';
    assert.equal(promotions.ativa(new Date('2026-09-01T16:00:00Z')), false,
      'botao do painel pausa somente o dia escolhido');
    assert.equal(promotions.ativa(new Date('2026-09-02T16:00:00Z')), true,
      'a pausa de um dia nao impede a promocao do dia seguinte');
    doc.disabled_date = null;

    const xTudo = cardapio.itemById('x_tudo');
    const terca = new Date('2026-09-01T16:00:00Z');
    const sexta = new Date('2026-09-04T16:00:00Z');
    assert.equal(promotions.precificar(xTudo, 1, terca).total, 18);
    assert.equal(promotions.precificar(xTudo, 3, terca).total, 50);
    assert.equal(promotions.precificar(xTudo, 4, terca).total, 68,
      'quatro X Tudo usam o pacote de tres mais uma unidade');
    assert.equal(promotions.precificar(xTudo, 3, sexta).total, 60,
      'fora dos dias usa o preço normal');
    const macarrao = cardapio.itemById('macarrao_chapa');
    assert.equal(promotions.precificar(macarrao, 2, terca).total, 25);
    assert.equal(promotions.precificar(macarrao, 3, terca).total, 39,
      'tres macarroes usam o pacote de dois mais uma unidade');

    doc.automatic = false;
    doc.manual_active = true;
    assert.equal(promotions.ativa(), true, 'modo manual pode liberar fora dos dias automáticos');
    const sess = { lang: 'pt', state: 'MENU', cart: [] };
    await tools.executar('adicionar_item', {
      item_id: 'x_tudo', quantidade: 3, remover: [], acrescentar: [],
    }, sess, async () => {});
    assert.equal(sess.cart[0].price * sess.cart[0].qty, 50,
      'pedido comum de 3 X Tudo recebe o combo automaticamente');
    assert.match(sess.cart[0].name, /preço promocional/);
    await tools.executar('adicionar_item', {
      item_id: 'x_tudo', quantidade: 1, remover: [], acrescentar: [],
    }, sess, async () => {});
    assert.equal(sess.cart[0].price * sess.cart[0].qty, 68,
      'acrescentar outra unidade recalcula o menor preço');

    doc.manual_active = false;
    assert.equal(promotions.ativa(), false, 'modo manual tambem pode bloquear');

    const categorias = cardapio.categorias();
    assert.equal(categorias[0].id, 'sanduiches');
    assert.equal(categorias[1].id, 'promocao', 'promocao fica ao lado de sanduiches');
    const promo = categorias[1];
    assert.equal(promo.name.pt, 'Promo Terça e Quarta');
    assert.equal(promo.items.length, 9);
    assert.deepEqual(promo.items.map(i => [i.baseItemId, i.bundleQuantity, i.price]), [
      ['x_tudo', 1, 18],
      ['x_tudo', 3, 50],
      ['hot_especial', 1, 10],
      ['hot_completo', 1, 10],
      ['hot_tudo', 1, 13],
      ['x_bacon', 1, 16],
      ['x_bacon', 3, 45],
      ['macarrao_chapa', 1, 14],
      ['macarrao_chapa', 2, 25],
    ]);
    assert.equal(promo.items.every(i => i.catalogVisible === false), true,
      'promocoes nao entram no catalogo permanente do WhatsApp');

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
    assert.match(html, /🔥 Promo Terça e Quarta/);
    assert.match(html, /Ativar automaticamente toda terça e quarta/);
    assert.match(html, /Desativar promoção hoje/);
    assert.match(html, /Cadastrar outro produto na promoção/);
    assert.match(html, /desativa quinta-feira às 00h/);
    const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
    new vm.Script(script);

    console.log('Promo de terça e quarta cadastrada, automática e editável no painel.');
  } finally {
    doc.automatic = estadoOriginal.automatic;
    doc.manual_active = estadoOriginal.manual_active;
    doc.disabled_date = estadoOriginal.disabled_date;
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
