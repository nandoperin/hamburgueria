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

  const maisItens = require('../src/services/mais-itens');
  require('../src/ai/provider').habilitada = () => true;
  for (const resposta of ['Não', 'não obrigado', 'só isso', 'nada mais']) {
    const editado = sessaoCom(1);
    Object.assign(editado, { orderType: 'pickup', name: 'Teste', escolhaItensConcluida: true });
    tools.orientacao(editado);
    assert.equal(editado.aguardandoMaisItens, true);
    const falas = [];
    assert.equal(await maisItens.responder(editado, resposta, async text => falas.push(text)), true);
    assert.equal(editado.state, 'CONFIRM', 'encerra edição e aguarda confirmação do resumo');
    assert.equal(editado.editingCart, false);
    assert.equal(falas.length, 1, 'envia somente o resumo');
    assert.match(falas[0], /RESUMO DO PEDIDO/);
  }

  const incompleto = sessaoCom(1);
  incompleto.orderType = 'pickup';
  tools.orientacao(incompleto);
  const falas = [];
  await maisItens.responder(incompleto, 'não', async text => falas.push(text));
  assert.match(falas[0], /nome/i, 'pede dado que falta antes do resumo');
  assert.notEqual(incompleto.state, 'CONFIRM');

  const alteracao = sessaoCom(1);
  alteracao.orderType = 'pickup';
  tools.orientacao(alteracao);
  assert.equal(await maisItens.responder(alteracao, 'não, quero outra fanta', async () => {}), false,
    'frase com alteração continua com a IA');

  console.log('Carrinho recusado permite corrigir quantidade e produto sem duplicar.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
