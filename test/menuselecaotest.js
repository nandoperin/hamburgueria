process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.AI_ENABLED = 'on';
process.env.LOG_LEVEL = 'silent';
delete process.env.META_CATALOG_ID;
const assert = require('node:assert/strict');
const db = require('../src/db/queries');
db.getCustomerByPhone = async () => null;
require('../src/services/schedule').isOpen = () => true;
require('../src/bot/vazao').avaliar = () => 'permitir';
const provider = require('../src/ai/provider');
provider.habilitada = () => true;
const agente = require('../src/ai/agente');
let chamadas = 0;
agente.conversar = async (_sess, texto) => {
  chamadas++;
  // Simula provedor fora somente neste pedido para provar a rede local.
  return texto !== 'um X Burger sem tomate';
};
const notify = require('../src/bot/notify');
let enviadas = [];
const send = async text => enviadas.push(text);
notify.register(async (_phone, text) => send(text));
notify.registerRich({ catalogLink: () => 'https://wa.me/c/15550000000' });
const sessao = require('../src/bot/session');
const menu = require('../src/bot/handlers/menu');
const cardapio = require('../src/services/cardapio');
const {route} = require('../src/bot/router');
let numero = 0;
const novo = () => {
  const s = sessao.get('1555555' + String(++numero).padStart(4, '0'));
  Object.assign(s,{lang:'pt',state:'ORDER'}); enviadas = []; return s;
};
const pedir = (s, text) => route(s.phone,text,send);
(async () => {
  for (const escolha of ['1', 'sanduiches', 'sanduíche', '1 sanduiche']) {
    const s = novo();
    await pedir(s, 'catálogo');
    assert.match(enviadas.join('\n'), /wa.me\/c\/15550000000/);
    await pedir(s, escolha);
    assert.equal(s.menuSelection.kind, 'items');
    assert.equal(s.menuSelection.categoryId, 'sanduiches');
    await pedir(s, '1');
    assert.equal(s.cart[0].productId,'x_burger');
    assert.equal(s.cart[0].price,12);
    assert.equal(s.menuSelection,null);
    assert.match(enviadas.at(-1), /Quer algo mais\? Digite menu para abrir as opções/);
    await pedir(s, 'não');
    assert.match(enviadas.at(-1), /entrega ou retirada/i);
  }
  assert.equal(chamadas,0,'seleções conhecidas não gastam IA');
  for (const escolha of ['X Burger', '1 X Burger', '2x X Burger']) {
    const s = novo(); await pedir(s,'cardápio'); await pedir(s,escolha);
    assert.equal(s.cart[0].qty, escolha.startsWith('2') ? 2 : 1);
  }
  let s = novo();
  await pedir(s,'catálogo'); await pedir(s,'1'); await pedir(s,'1, 2');
  assert.deepEqual(s.cart.map(i=>i.productId),['x_burger','hamburgao']);
  s = novo(); await pedir(s,'catálogo'); await pedir(s,'1'); await pedir(s,'999');
  assert.equal(s.cart.length,0);
  assert.equal(chamadas,0,'número inexistente não compra nada');
  await pedir(s,'um X Burger sem tomate');
  assert.equal(chamadas,1,'pedido livre tenta a IA antes da validacao local de reserva');
  assert.deepEqual(s.cart[0].removed,['tomate']);
  assert.equal(s.menuSelection,null);
  await pedir(s,'1');
  assert.equal(chamadas,2,'número fora da seleção não vira produto');
  s = novo(); await pedir(s,'catálogo'); await pedir(s,'1');
  const availability = require('../src/services/availability');
  const original = availability.isAvailable;
  availability.isAvailable = id => id !== 'x_burger';
  await pedir(s,'1'); assert.equal(s.cart.length,0,'esgotado não muda posição da seleção');
  availability.isAvailable = original;
  s = novo(); s.state='LANGUAGE'; await pedir(s,'catálogo');
  assert.equal(s.menuSelection.kind,'categories','menu funciona como primeira mensagem');
  notify.registerRich({catalogLink:()=> 'https://outro.test/'});
  assert.equal(notify.catalogLink(),null,'não aceita link de catálogo externo');
  s = novo(); await menu.presentMenu(s,send);
  assert.ok(!enviadas.join('\n').includes('outro.test'));
  notify.registerRich({ catalogLink: () => 'https://wa.me/c/15550000000' });
  for (const frase of ['Qual menu?', 'Me manda o menu', 'menu', 'Pode me enviar o cardápio por favor?']) {
    s = novo(); s.state = 'LANGUAGE';
    const antes = chamadas;
    await pedir(s, frase);
    assert.equal(chamadas, antes, 'pedido de cardápio não recebe lista improvisada da IA');
    assert.equal(enviadas.length, 1, 'cardápio direto sem saudação ou pergunta antes');
    assert.match(enviadas[0], /wa.me\/c\/15550000000/);
    assert.equal(s.menuSelection.kind, 'categories');
    assert.ok(!enviadas[0].includes('X Burger'), 'produtos só após escolher categoria');
    await pedir(s, '1');
    assert.equal(s.menuSelection.categoryId, 'sanduiches');
    assert.match(enviadas.at(-1), /X Burger/);
    assert.match(enviadas.at(-1), /\$12\.00/);
    await pedir(s, '1');
    assert.equal(s.cart[0].productId, 'x_burger');
  }
  assert.equal(menu.isMenuRequest('não quero menu'), false);
  assert.equal(menu.isMenuRequest('quero um xtudo e me manda o menu'), false);
  console.log('Seleção por número/nome, conversa IA, catálogo e primeira mensagem: OK.');
})().catch(e=>{console.error(e);process.exitCode=1});
