const assert = require('node:assert/strict');
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.LOG_LEVEL = 'silent';
const delivery = require('../src/services/delivery');
const tools = require('../src/ai/tools');

const exemplos = [
  ['6 Main St Boston', 'Boston'],
  ['6 Main St, Boston', 'Boston'],
  ['6 Main St\nBoston', 'Boston'],
  ['6 Main Av Boston MA 02110', 'Boston'],
  ['6 Main Ave. Boston, MA', 'Boston'],
  ['6 Main Ct Cambridge', 'Cambridge'],
  ['6 Main Ln Somerville', 'Somerville'],
  ['6 Everett St, Boston', 'Boston'],
  ['6 Main St Apt 2 Boston', 'Boston'],
  ['6 Main St, Boston, apt 2', 'Boston'],
  ['250 Broadway, Boston, MA 02110', 'Boston'],
  ['6 Main St North Reading', 'North Reading'],
  ['6 Main St Boston, Maria', 'Boston'],
  ['Maria, 6 Main St, Boston', 'Boston'],
  ['6 Main St', null],
  ['6 Everett St', null],
  ['6 Main St apt 2', null],
  ['6 Main St, MA 02110', null],
];
for (const [endereco, cidade] of exemplos) {
  assert.equal(delivery.extrairCidadeEndereco(endereco), cidade, endereco);
}
assert.equal(delivery.acharCidade('6 Everett St, Boston'), null);
assert.equal(delivery.acharCidade('6 Everett St'), null);
assert.equal(delivery.acharCidade('South Everett'), null);
assert.equal(delivery.acharCidade('6 Main St Everett').id, 'everett');
assert.equal(delivery.acharCidade('moro em chelsea').id, 'chelsea');
assert.equal(delivery.acharCidade('Everett, MA 02149').id, 'everett');

(async () => {
  const sess = { orderType: 'delivery', city: delivery.acharCidade('Everett'),
    address: 'endereco antigo', name: 'Maria', cart: [{ id: 'x_burger', qty: 1, price: 11 }] };
  const send = async () => { throw Error('Nao deve mostrar resumo fora da cobertura'); };
  const recusada = await tools.executar('definir_endereco', { endereco: '6 Main St' }, sess, send,
    { textoCliente: 'Maria, 6 Main St Boston' });
  assert.equal(recusada.bloqueiaFluxo, true);
  assert.equal(sess.city, null, 'nao reaproveita taxa da cidade anterior');
  assert.equal(sess.address, '6 Main St');
  assert.match(tools.mensagemColeta(sess), /não atendemos Boston/);
  assert.match(tools.mensagemColeta(sess), /Everett, Chelsea, Malden, Medford/);
  assert.match(tools.mensagemColeta(sess), /\(857\) 353-1025/);
  assert.equal((await tools.executar('finalizar_pedido', {}, sess, send)).bloqueiaFluxo, true);
  await tools.executar('definir_cidade', { cidade: 'Chelsea' }, sess, send);
  assert.equal(sess.cidadeRecusada, null);
  assert.equal(sess.city.id, 'chelsea');
  await tools.executar('definir_cidade', { cidade: 'Boston' }, sess, send);
  await tools.executar('definir_entrega', { tipo: 'pickup' }, sess, send);
  assert.equal(tools.mensagemCobertura(sess), null);
  console.log('Cidade ausente, fora da cobertura e alteracao de destino conferidas.');
})().catch(err => { console.error(err); process.exitCode = 1; });
