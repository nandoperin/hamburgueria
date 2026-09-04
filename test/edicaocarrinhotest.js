const assert = require('assert/strict');

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.AI_ENABLED = 'off';

const tools = require('../src/ai/tools');
const cardapio = require('../src/services/cardapio');

function sessaoCom(qtd = 2) {
  const item = cardapio.itemById('x_tudo');
  return {
    phone: '15550000999',
    lang: 'pt',
    state: 'ORDER',
    editingCart: true,
    cart: [{
      id: item.id,
      productId: item.id,
      name: item.name.pt,
      nomeCozinha: item.name.pt,
      choicesCozinha: [],
      removed: [],
      added: [],
      qty: qtd,
      price: item.price,
    }],
  };
}

(async () => {
  const definir = tools.SCHEMA.find((f) => f.name === 'definir_quantidade_item');
  assert.ok(definir, 'existe ferramenta para definir a quantidade final');
  assert.deepEqual(Object.keys(definir.input_schema.properties).sort(), ['item_id', 'quantidade']);

  const sess = sessaoCom(2);
  let resposta = await tools.executar(
    'definir_quantidade_item',
    { item_id: 'x_tudo', quantidade: 1 },
    sess,
    async () => {}
  );
  assert.equal(sess.cart.length, 1, 'não cria outra linha');
  assert.equal(sess.cart[0].qty, 1, 'substitui 2 pela quantidade final 1');
  assert.match(resposta.resultado, /de 2 para 1/);

  resposta = await tools.executar(
    'personalizar_item',
    { item_id: 'x_tudo', quantidade: 1, remover: ['tomate'] },
    sess,
    async () => {}
  );
  assert.equal(sess.cart.reduce((total, line) => total + line.qty, 0), 1,
    'personalizar o item preserva a quantidade total');
  assert.ok(sess.cart[0].removed.includes('tomate'));
  assert.match(resposta.resultado, /Alterado/);

  await tools.executar(
    'definir_quantidade_item',
    { item_id: sess.cart[0].id, quantidade: 0 },
    sess,
    async () => {}
  );
  assert.equal(sess.cart.length, 0, 'quantidade final zero remove a linha');

  console.log('Carrinho recusado permite corrigir quantidade e produto sem duplicar.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
