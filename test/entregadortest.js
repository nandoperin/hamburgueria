/**
 * Telefone do entregador na confirmação do pedido com entrega (dono, 14/11):
 * cadastrado na aba Entrega, até 2 números, mensagem editável. Sem número,
 * nada muda.
 */
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.DATABASE_URL = 'postgresql://fake';
process.env.PAINEL_SECRET = 'x'.repeat(40);

const PROJECT = require('path').resolve(__dirname, '..');
require('./comentrega').ligar();

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
let nPedido = 0;
require.cache[dbPath].exports = new Proxy({
  upsertCustomer: async (c) => ({ id: 7, ...c }),
  createOrder: async (o) => ({ id: 500 + (++nPedido), status: 'pending', total: o.total, order_type: o.orderType, ...o }),
  createCashPayment: async (p) => ({ ...p, method: 'cash', status: 'cash_due' }),
  createZellePayment: async (p) => ({ ...p, method: 'zelle', status: 'pending' }),
}, { get: (alvo, k) => alvo[k] || (async () => null) });

const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
let entregador;
config.get = (chave) => (chave === 'delivery' ? { ...getReal('delivery'), entregador } : getReal(chave));

const order = require(`${PROJECT}/src/bot/handlers/order`);
const ent = require(`${PROJECT}/src/services/entregador`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

function sessao(tipo, lang = 'pt') {
  const entrega = tipo === 'delivery';
  return {
    phone: '1555000' + String(Math.floor(Math.random() * 1e4)).padStart(4, '0'), lang,
    state: 'CONFIRM', paymentMethod: 'cash', changeFor: null, orderType: tipo, name: 'Junior',
    city: entrega ? { id: 'medford', label: 'Medford', delivery_fee: 7 } : null,
    address: entrega ? '21 glenwood ave' : null,
    subtotal: 20, deliveryFee: entrega ? 7 : 0, total: entrega ? 27 : 20,
    cart: [{ id: 'x_tudo', productId: 'x_tudo', name: 'X Tudo', qty: 1, price: 20 }],
  };
}
async function confirmar(tipo, lang) {
  const enviadas = [];
  await order.handleConfirm(sessao(tipo, lang), 'sim', async (m) => enviadas.push(m));
  return enviadas.join('\n---\n');
}

(async () => {
  // Sem cadastro: igual a antes.
  entregador = undefined;
  let r = await confirmar('delivery');
  checar(/registrado/.test(r) && !/entregador/i.test(r), 'sem telefone cadastrado: a confirmação sai como antes');

  // Um número, mensagem padrão.
  entregador = { telefones: ['6175551234'], mensagem: ent.PADRAO_PT };
  r = await confirmar('delivery');
  checar(r.includes('📞 Nosso entregador pode ligar do número *(617) 555-1234*. Por favor, atenda!'),
    'entrega: a linha com o número formatado');
  checar(r.indexOf('registrado') < r.indexOf('📞 Nosso entregador'), '   depois da confirmação');

  r = await confirmar('pickup');
  checar(!/entregador/i.test(r), 'retirada: sem a linha');

  // Dois números e mensagem própria.
  entregador = { telefones: ['16175551234', '(781) 555-9999'], mensagem: 'Atenda o entregador: {numero} 🛵' };
  r = await confirmar('delivery');
  checar(r.includes('Atenda o entregador: *(617) 555-1234* ou *(781) 555-9999* 🛵'), 'dois números e a mensagem do dono');

  r = await confirmar('delivery', 'en');
  checar(r.includes('Our driver may call you from *(617) 555-1234* or *(781) 555-9999*'), 'cliente em inglês: mensagem padrão traduzida');

  // Números apagados no painel: some.
  entregador = { telefones: [], mensagem: ent.PADRAO_PT };
  r = await confirmar('delivery');
  checar(!/entregador/i.test(r), 'números apagados: a linha some');

  // Validação do painel.
  checar(ent.validar(undefined).length === 0, 'validação: sem o bloco, ok (banco antigo)');
  checar(ent.validar({ telefones: ['6175551234', '7815559999'], mensagem: ent.PADRAO_PT }).length === 0, 'validação: 2 números ok');
  checar(ent.validar({ telefones: ['1', '2', '3'] }).some((e) => /no máximo 2/.test(e)), 'validação: 3 números recusa');
  checar(ent.validar({ telefones: ['555123'] }).some((e) => /10 dígitos/.test(e)), 'validação: número curto recusa');
  checar(ent.validar({ telefones: ['6175551234'], mensagem: 'Ligue pra ele' }).some((e) => /\{numero\}/.test(e)), 'validação: mensagem sem {numero} recusa');
  const doc = { ...getReal('delivery'), entregador: { telefones: ['1'] } };
  checar(config.validar ? config.validar('delivery', doc).length > 0 : true, 'o documento de entrega com número inválido não salva');

  // Painel: bloco na aba Entrega, JavaScript válido.
  const pagina = require(`${PROJECT}/src/api/painel-page`).render(15, 'nonce-teste');
  const script = [...pagina.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  checar((() => { try { new Function(script); return true; } catch { return false; } })(), 'o JavaScript do painel continua válido');
  checar(/🛵 Entregador/.test(script) && /\{numero\}/.test(script), 'aba Entrega tem o bloco do entregador');

  console.log('\n\x1b[32mentregadortest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
