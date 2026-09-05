require('./menu-legado');
/** Regressão: coleta só faltantes e falhas não reiniciam a conversa. */
const assert = require('node:assert/strict');
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';
process.env.LOG_LEVEL = 'silent';

let cliente = null;
const db = require('../src/db/queries');
Object.assign(db, {
  getCustomerByPhone: async () => cliente,
  getLastDeliveryOrder: async () => cliente ? { address: '6 Main St', city: 'Everett' } : null,
  getUltimoPedidoFeito: async () => cliente ? { items_json: [{ id: 'x_bacon', qty: 1, price: 1 }] } : null,
  registrarUsoIA: async () => null,
  getUsoIA: async () => null,
});
require('../src/services/schedule').isOpen = () => true;
require('./comentrega').ligar();
const provider = require('../src/ai/provider');
let respostas = [];
let chamadas = 0;
provider.habilitada = () => true;
provider.getModelo = () => 'mistral-small-latest';
provider.get = () => ({ conversar: async () => {
  chamadas++;
  const resposta = respostas.shift();
  if (resposta instanceof Error) throw resposta;
  assert.ok(resposta, 'o fluxo não deveria gastar mais uma chamada para repetir a coleta');
  return { uso: { tokensIn: 1, tokensOut: 1 }, ...resposta };
} });
const session = require('../src/bot/session');
const { route } = require('../src/bot/router');
const agente = require('../src/ai/agente');
const tools = require('../src/ai/tools');
const notify = require('../src/bot/notify');
let enviados = [];
const send = async texto => enviados.push(texto);
notify.register(async (_phone, texto) => send(texto));
notify.registerRich({ catalogLink: () => 'https://wa.me/c/15550000000' });
let id = 0;
function preparar(dados = {}) {
  const s = session.get(`1555900${String(++id).padStart(4, '0')}`);
  Object.assign(s, { lang: 'pt', state: 'ORDER', cart: [{ id: 'x_burger', name: 'X-Burger', qty: 1, price: 11 }] }, dados);
  enviados = []; chamadas = 0; respostas = [];
  return s;
}
function lote(...lista) {
  return { texto: '', chamadas: lista.map(([nome, argumentos], i) => ({ id: `tool-${i}`, nome, argumentos })) };
}
const casos = [];
const caso = (nome, fn) => casos.push([nome, fn]);

caso('novo recebe saudação com catálogo e categorias', async () => {
  cliente = null;
  const s = preparar({ state: 'LANGUAGE', cart: [] });
  await route(s.phone, 'oi', send);
  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /Bem-vindo ao Point Burger/);
  assert.match(enviados[0], /Abra o catálogo no WhatsApp/);
  assert.match(enviados[0], /Sanduíches/);
  assert.equal(s.menuSelection?.kind, 'categories');
  assert.equal(chamadas, 0);
  assert.ok(agente.getHistorico(s.phone).some(m =>
    m.role === 'assistant' && /Bem-vindo ao Point Burger/.test(m.content)
  ), 'a IA deve receber a saudação que o cliente já leu');
});
caso('conhecido é cumprimentado sem oferta automática do último pedido', async () => {
  cliente = { id: 7, name: 'Fernando', lang: 'pt' };
  const s = preparar({ state: 'LANGUAGE', cart: [] });
  await route(s.phone, 'oi', send);
  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /Oi, Fernando/);
  assert.match(enviados[0], /Abra o catálogo no WhatsApp/);
  assert.match(enviados[0], /Sanduíches/);
  assert.equal(s.lastAddress, '6 Main St');
  assert.equal(s.lastCityId, 'everett');
  assert.equal(s.cart.length, 0);
  assert.equal(chamadas, 0);
});
caso('entrega de novo cliente pede nome e endereço juntos', async () => {
  const s = preparar();
  respostas = [lote(['definir_entrega', { tipo: 'delivery' }])];
  await agente.conversar(s, 'entrega', send);
  assert.deepEqual(enviados, ['Me passa seu nome e endereço de entrega.']);
  assert.equal(chamadas, 1);
});
caso('endereço sem cidade é preservado e pergunta só cidade', async () => {
  const s = preparar({ orderType: 'delivery' });
  respostas = [lote(['definir_endereco', { endereco: '6 Main St' }], ['definir_cadastro', { nome: 'Maria' }])];
  await agente.conversar(s, 'Maria, 6 Main St', send);
  assert.deepEqual(enviados, ['Qual a cidade?']);
  assert.equal(s.address, '6 Main St');
  assert.equal(s.name, 'Maria');
  assert.equal(chamadas, 1);
});
caso('nome já conhecido não é pedido com endereço novo', async () => {
  const s = preparar({ name: 'Fernando' });
  respostas = [lote(['definir_entrega', { tipo: 'delivery' }])];
  await agente.conversar(s, 'entrega', send);
  assert.deepEqual(enviados, ['Me passa o endereço da entrega.']);
});
caso('endereço salvo é oferecido com cidade uma vez; sim avança ao resumo', async () => {
  const s = preparar({ name: 'Fernando', lastAddress: '6 Main St', lastCityId: 'everett' });
  await agente.conversar(s, 'entrega', send);
  assert.deepEqual(enviados, ['Entrego em 6 Main St, Everett?']);
  enviados = [];
  await agente.conversar(s, 'sim', send);
  assert.equal(s.state, 'CONFIRM');
  assert.equal(s.city.delivery_fee, 5);
  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /RESUMO/);
  assert.equal(chamadas, 0);
});
caso('mesmo endereço explícito não pede confirmação de novo', async () => {
  const s = preparar({ name: 'Fernando', lastAddress: '6 Main St', lastCityId: 'everett' });
  respostas = [lote(['definir_entrega', { tipo: 'delivery' }]), lote(['finalizar_pedido', {}])];
  await agente.conversar(s, 'entrega no mesmo endereço', send);
  assert.equal(s.state, 'CONFIRM');
  assert.equal(s.address, '6 Main St');
  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /RESUMO/);
});
caso('novo na retirada informa apenas o nome', async () => {
  const s = preparar();
  respostas = [lote(['definir_entrega', { tipo: 'pickup' }])];
  await agente.conversar(s, 'retirada', send);
  assert.deepEqual(enviados, ['Me passa seu nome.']);
  assert.equal(chamadas, 1);
});
caso('endereço salvo com cidade não repete o nome da cidade', async () => {
  const s = preparar({ name: 'Fernando', lastAddress: '6 Main St, Everett', lastCityId: 'everett' });
  await agente.conversar(s, 'entrega', send);
  assert.deepEqual(enviados, ['Entrego em 6 Main St, Everett?']);
});
caso('recusar endereço salvo preserva nome e registra destino novo', async () => {
  const s = preparar({ name: 'Fernando', lastAddress: '6 Main St', lastCityId: 'everett' });
  await agente.conversar(s, 'entrega', send);
  enviados = [];
  respostas = [lote(['definir_endereco', { endereco: '8 Elm St, Chelsea' }]), lote(['finalizar_pedido', {}])];
  await agente.conversar(s, 'não, 8 Elm St, Chelsea', send);
  assert.equal(s.name, 'Fernando');
  assert.equal(s.address, '8 Elm St, Chelsea');
  assert.equal(s.city.delivery_fee, 7);
  assert.equal(s.state, 'CONFIRM');
  assert.equal(enviados.length, 1);
});
caso('conhecido na retirada vai direto ao resumo', async () => {
  const s = preparar({ name: 'Fernando' });
  respostas = [lote(['definir_entrega', { tipo: 'pickup' }]), lote(['finalizar_pedido', {}])];
  await agente.conversar(s, 'retirada', send);
  assert.equal(s.state, 'CONFIRM');
  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /RESUMO/);
});
caso('cidade no endereço livre dispensa pergunta separada', async () => {
  const s = preparar({ orderType: 'delivery', name: 'Maria' });
  respostas = [lote(['definir_endereco', { endereco: '6 Main St\nEverett' }]), lote(['finalizar_pedido', {}])];
  await agente.conversar(s, '6 Main St\nEverett', send);
  assert.equal(s.state, 'CONFIRM');
  assert.equal(enviados.length, 1);
  assert.equal(s.city.id, 'everett');
});
caso('falha da IA orienta menu/catalogo sem reiniciar ou perder carrinho', async () => {
  const s = preparar({ name: 'Fernando', orderType: 'delivery', address: '6 Main St' });
  const antes = JSON.stringify(s.cart);
  respostas = [new Error('API indisponível')];
  await route(s.phone, 'xyz?', send);
  assert.deepEqual(enviados, ['Não entendi. Para ver o menu, escreva menu ou clique no catálogo.']);
  assert.equal(s.state, 'ORDER');
  assert.equal(JSON.stringify(s.cart), antes);
  assert.equal(s.address, '6 Main St');
  assert.equal(s.name, 'Fernando');
});
caso('resposta vazia da IA também oferece saída, sem silêncio', async () => {
  const s = preparar();
  respostas = [{ texto: '', chamadas: [] }];
  await route(s.phone, 'xyz?', send);
  assert.deepEqual(enviados, ['Não entendi. Para ver o menu, escreva menu ou clique no catálogo.']);
  assert.equal(s.cart.length, 1);
});
caso('endereço fora da área é recusado mesmo sem ferramenta de cidade', async () => {
  const s = preparar({ name: 'Maria', orderType: 'delivery' });
  respostas = [lote(['definir_endereco', { endereco: '6 Main St Boston' }], ['finalizar_pedido', {}])];
  await agente.conversar(s, '6 Main St Boston', send);
  assert.equal(enviados.length, 1);
  assert.match(enviados[0], /não atendemos Boston/);
  assert.match(enviados[0], /Everett, Chelsea, Malden, Medford/);
  assert.match(enviados[0], /\(857\) 353-1025/);
  assert.equal(s.city, null);
  assert.notEqual(s.state, 'CONFIRM');
  assert.equal(chamadas, 1);
});
caso('cobertura recusada não é substituída por coleta genérica', async () => {
  const s = preparar({ orderType: 'delivery', name: 'Maria' });
  respostas = [lote(['definir_cidade', { cidade: 'Boston' }]), { texto: 'Ainda não entregamos em Boston. Pode retirar no balcão.', chamadas: [] }];
  await agente.conversar(s, 'entrega em Boston', send);
  assert.equal(s.city, null);
  assert.match(enviados[0], /não atendemos Boston/);
  assert.match(enviados[0], /\(857\) 353-1025/);
  assert.equal(chamadas, 1, 'recusa enviada sem uma segunda chamada ao modelo');
});
caso('repetição do pedido usa preço atual, não preço guardado', async () => {
  const s = preparar(); s.cart = [];
  await tools.executar('adicionar_item', { item_id: 'x_bacon' }, s, send);
  assert.equal(s.cart[0].price, 14);
});

(async () => {
  let falhas = 0;
  for (const [nome, fn] of casos) {
    try { await fn(); console.log(`OK: ${nome}`); }
    catch (err) { falhas++; console.error(`FALHOU: ${nome}\n${err.message}`); }
  }
  assert.equal(falhas, 0, `${falhas} casos falharam`);
})().catch(err => { console.error(err.message); process.exit(1); });
