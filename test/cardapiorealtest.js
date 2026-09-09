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
const execute = (s, name, args, contexto) =>
  tools.executar(name, args, s, async () => {}, contexto);
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
  await tools.executar('adicionar_item', {
    item_id:'x_tudo', acrescentar:['salsicha'], preparo_salsicha:'junto',
  }, s, async () => {}, { textoCliente:'quero um xtudo com salsicha' });
  assert.equal(s.cart[0].preparoSalsicha, undefined,
    '"com salsicha" não permite à IA adivinhar junto');
  assert.match(preparo.pergunta(s), /à parte ou junto/,
    'pergunta o preparo obrigatório depois de cobrar o adicional');
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
  const editado = novo();
  await add(editado, 'x_tudo');
  await add(editado, 'salsicha');
  assert.ok(preparo.responder(editado, 'junto').ok);
  const idAntesDaEdicao = editado.cart.find(preparo.avulsa).preparoSalsicha.alvoId;
  await execute(editado, 'personalizar_item', { item_id:'x_tudo', remover:['tomate'] });
  const alvoEditado = editado.cart.find(line => line.productId === 'x_tudo');
  const salsichaEditada = editado.cart.find(preparo.avulsa);
  assert.notEqual(alvoEditado.id, idAntesDaEdicao);
  assert.equal(salsichaEditada.preparoSalsicha.alvoId, alvoEditado.id,
    'editar o único lanche atualiza o destino da salsicha');
  assert.equal(preparo.pergunta(editado), null,
    'não pergunta qual lanche quando só existe o X Tudo editado');
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
  await add(s, 'x_tudo');
  await add(s, 'x_bacon');
  const antesAmbiguo = JSON.stringify(s.cart);
  const ambiguo = await execute(
    s,
    'personalizar_item',
    { item_id: 'x_tudo', acrescentar: ['salsicha'] },
    { textoCliente: 'adiciona salsicha' }
  );
  assert.equal(ambiguo.bloqueiaFluxo, true, 'não escolhe X Tudo por conta própria');
  assert.equal(JSON.stringify(s.cart), antesAmbiguo, 'pedido ambíguo não altera nenhum lanche');
  assert.match(ambiguo.resultado, /X Tudo.*(?:Bacon Burger|X Bacon)|(?:Bacon Burger|X Bacon).*X Tudo/,
    'a IA recebe todos os lanches para perguntar ao cliente');

  const explicito = await execute(
    s,
    'personalizar_item',
    { item_id: 'x_bacon', acrescentar: ['salsicha'], preparo_salsicha: 'junto' },
    { textoCliente: 'coloca a salsicha junto no bacon burger' }
  );
  assert.equal(Boolean(explicito.bloqueiaFluxo), false, 'destino explícito é aceito');
  assert.equal(s.cart.find(line => line.productId === 'x_bacon').preparoSalsicha?.modo, 'junto');
  assert.equal(s.cart.find(line => line.productId === 'x_tudo').added.length, 0,
    'X Tudo permanece sem salsicha');

  /**
   * A mesma ambiguidade, mas com um adicional que NÃO é salsicha.
   *
   * Relato real: cliente com X-Bacon e X-Tudo no carrinho pediu "acrescenta
   * ovo" sem dizer em qual — o modelo escolheu um sanduíche sozinho e o
   * cliente só viu "mais alguma coisa?", nunca uma pergunta de qual dos
   * dois. A trava de "em qual lanche?" existia só para salsicha; isto prova
   * que agora vale para qualquer acrescentar.
   */
  s = novo();
  await add(s, 'x_tudo');
  await add(s, 'x_bacon');
  const antesOvoAmbiguo = JSON.stringify(s.cart);
  const ovoAmbiguo = await execute(
    s,
    'personalizar_item',
    { item_id: 'x_tudo', acrescentar: ['ovo'] },
    { textoCliente: 'adiciona ovo' }
  );
  assert.equal(ovoAmbiguo.bloqueiaFluxo, true, 'não escolhe X Tudo por conta própria pro ovo');
  assert.equal(JSON.stringify(s.cart), antesOvoAmbiguo, 'ovo ambíguo não altera nenhum lanche');
  assert.match(ovoAmbiguo.resultado, /X Tudo.*(?:Bacon Burger|X Bacon)|(?:Bacon Burger|X Bacon).*X Tudo/,
    'a IA recebe todos os lanches para perguntar ao cliente, não só no caso da salsicha');

  const ovoExplicito = await execute(
    s,
    'personalizar_item',
    { item_id: 'x_bacon', acrescentar: ['ovo'] },
    { textoCliente: 'coloca ovo no bacon burger' }
  );
  assert.equal(Boolean(ovoExplicito.bloqueiaFluxo), false, 'destino explícito do ovo é aceito');
  assert.ok(s.cart.find(line => line.productId === 'x_bacon').added.includes('ovo'));
  assert.equal(s.cart.find(line => line.productId === 'x_tudo').added.length, 0,
    'X Tudo permanece sem ovo — o acrescimo foi só no bacon burger citado');

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
