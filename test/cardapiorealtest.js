process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.AI_ENABLED = 'off';
process.env.LOG_LEVEL = 'silent';
const assert = require('node:assert/strict');
const cardapio = require('../src/services/cardapio');
const catalog = require('../src/services/catalog');
const modifiers = require('../src/services/modifiers');
const preparo = require('../src/services/preparo-salsicha');
const tools = require('../src/ai/tools');
const order = require('../src/bot/handlers/order');
const catalogorder = require('../src/bot/handlers/catalogorder');
const session = require('../src/bot/session');
const novo = () => ({ phone: '15550000000', lang: 'pt', state: 'ORDER', cart: [] });
const execute = (s, name, args) => tools.executar(name, args, s, async () => {});
const add = (s, item_id, args = {}) => execute(s, 'adicionar_item', { item_id, ...args });

(async () => {
  const precos = {
    x_burger:12, hamburgao:12, x_egg_burger:13, x_salada:13, x_egg_salada:14,
    x_bacon:15, egg_bacon:16, x_calabresa_bacon:19, x_tudo:20, x_tudao:24,
    hot_plain:6, hot_simples:8, hot_duplo:10, hot_completo:13, hot_especial:13,
    hot_tudo:16, macarrao_chapa:17, guarana:3, coca_cola:2, fanta_laranja:2,
    salsicha:1, bacon:4, banana:1, ovo:2, bife:2, mussarela:2, calabresa:4, sache_maionese:1,
  };
  assert.equal(cardapio.allItems().length, 37);
  assert.deepEqual(cardapio.conferir(), []);
  for (const [id, price] of Object.entries(precos)) {
    const item = cardapio.itemById(id);
    assert.equal(item.price, price, id);
    assert.equal(catalog.resolverNomePt(item.name.pt).item.id, id);
    for (const ing of item.modifiers?.addable || []) {
      assert.ok(modifiers.precoDe(ing) > 0, 'nada de adicional grátis inventado');
    }
  }
  for (const [nome, id] of [['hamburgao','hamburgao'], ['sache de maionese','sache_maionese'], ['x Tudão','x_tudao'], ['Guaraná Antártica','guarana']]) {
    assert.equal(catalog.resolverNomePt(nome).item.id, id);
  }
  assert.equal(cardapio.itemById('x_tudao').ingredientQuantities.ovo, 2);
  assert.equal(cardapio.itemById('hot_duplo').ingredientQuantities.salsicha, 2);
  for (const id of ['x_bacon', 'egg_bacon']) assert.ok(!cardapio.itemById(id).modifiers.removable.includes('mussarela'));
  for (const id of ['tomate', 'milho']) assert.ok(!cardapio.itemById('x_calabresa_bacon').modifiers.removable.includes(id));
  assert.equal(modifiers.validar(cardapio.itemById('x_burger'), { acrescentar:['presunto'] }).ok, false);
  let s = novo();
  await add(s, 'x_burger', { remover:['tomate'], acrescentar:['bacon','ovo'] });
  assert.equal(session.getSubtotal(s), 18);
  assert.equal(preparo.pergunta(s), null);
  s = novo();
  for (const id of ['hot_plain', 'hot_simples', 'hot_duplo', 'hot_completo', 'hot_especial', 'hot_tudo']) await add(s, id);
  assert.equal(preparo.pergunta(s), null, 'salsicha da receita não pergunta');
  s = novo();
  await add(s, 'x_burger', { acrescentar:['salsicha'] });
  assert.match(preparo.pergunta(s), /à parte ou junto/);
  const enviado = [];
  await order.mostrarResumo(s, text => enviado.push(text));
  assert.equal(s.state, 'ORDER');
  assert.equal(enviado.length, 1, 'checkout não avança sem preparo');
  assert.ok(preparo.responder(s, 'à parte').ok);
  assert.equal(preparo.pergunta(s), null);
  assert.equal(session.getSubtotal(s), 13);
  assert.match(s.cart[0].choicesCozinha.join(' '), /à parte/);
  await execute(s, 'personalizar_item', { item_id:s.cart[0].id, remover:['tomate'] });
  assert.equal(preparo.pergunta(s), null, 'editar outro ingrediente preserva preparo');
  assert.match(s.cart[0].name, /à parte/);
  await execute(s, 'personalizar_item', { item_id:s.cart[0].id, retirar_adicionais:['salsicha'] });
  assert.equal(session.getSubtotal(s), 12);
  assert.ok(!s.cart[0].preparoSalsicha);
  s = novo();
  await add(s, 'x_burger', { acrescentar:['salsicha'], preparo_salsicha:'junto' });
  assert.equal(preparo.pergunta(s), null, 'preparo já informado não repergunta');
  await add(s, 'x_burger', { acrescentar:['salsicha'], preparo_salsicha:'a_parte' });
  assert.equal(s.cart.length, 2, 'preparos distintos não se misturam');
  await add(s, 'x_burger', { acrescentar:['salsicha'], preparo_salsicha:'a_parte' });
  assert.equal(s.cart.find(l => l.preparoSalsicha.modo === 'a_parte').qty, 2);
  s = novo();
  const mensagens = [];
  await catalogorder.handleCartOrder(s, { source:'baileys', externalOrderId:'real-menu', items:[
    {productId:'x_burger',quantity:1}, {productId:'salsicha',quantity:2},
  ]}, async text => mensagens.push(text));
  assert.equal(mensagens.length, 1);
  assert.match(mensagens[0], /à parte ou junto/);
  assert.equal(session.getSubtotal(s), 14);
  assert.ok(preparo.responder(s, 'junto').ok);
  assert.equal(preparo.pergunta(s), null);
  assert.equal(session.getSubtotal(s), 14, 'catálogo cobra duas unidades uma única vez');
  assert.match(s.cart.find(preparo.avulsa).choicesCozinha.join(' '), /X Burger/);
  const antes = JSON.stringify(s.cart);
  await execute(s, 'personalizar_item', {item_id:'x_burger',acrescentar:['salsicha']});
  assert.equal(JSON.stringify(s.cart), antes, 'não cobra novamente salsicha do catálogo');
  await execute(s, 'remover_item', {item_id:'x_burger'});
  assert.ok(preparo.pergunta(s), 'retirar lanche de destino exige nova escolha');
  s = novo();
  await add(s, 'x_burger'); await add(s, 'hot_simples'); await add(s, 'salsicha');
  assert.ok(preparo.responder(s, 'junto').ok);
  assert.match(preparo.pergunta(s), /qual lanche/);
  assert.ok(preparo.responder(s, 'hot simples').ok);
  assert.equal(preparo.pergunta(s), null);
  assert.equal(session.getSubtotal(s), 21);
  assert.equal(preparo.definir(s, {item_id:s.cart.find(preparo.avulsa).id,modo:'junto',lanche_id:'coca_cola'}).ok, false);
  s = novo();
  await add(s, 'x_burger', {quantidade:2}); await add(s, 'salsicha', {quantidade:2});
  assert.ok(preparo.responder(s, 'junto').ok);
  assert.match(preparo.pergunta(s), /quantos/);
  assert.equal(preparo.responder(s, '3').ok, false, 'não distribui em lanche inexistente');
  assert.ok(preparo.responder(s, '2').ok);
  assert.equal(preparo.pergunta(s), null);
  assert.equal(session.getSubtotal(s), 26);
  assert.equal(s.cart.find(preparo.avulsa).preparoSalsicha.unidades, 2);
  const salvo = JSON.parse(JSON.stringify(s.cart));
  const repetido = novo();
  for (const line of salvo) await add(repetido, line.productId, {
    quantidade:line.qty, remover:line.removed, acrescentar:line.added,
    preparo_salsicha:line.preparoSalsicha?.modo, lanche_id:line.preparoSalsicha?.alvoId,
    unidades_lanche:line.preparoSalsicha?.unidades,
  });
  assert.equal(preparo.pergunta(repetido), null, 'repetir pedido preserva preparo');
  assert.equal(session.getSubtotal(repetido), 26);
  console.log('Menu real: 28 produtos, preços, receitas, catálogo, preparo, cobrança e bloqueio do checkout conferidos.');
})().catch(err => { console.error(err); process.exitCode = 1; });
