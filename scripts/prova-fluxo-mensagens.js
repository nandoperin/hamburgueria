/** Prova paga e explícita com o modelo real, sem WhatsApp nem banco reais. */
require('dotenv').config();
const assert = require('node:assert/strict');
const arg = nome => process.argv.find(v => v.startsWith(`--${nome}=`))?.split('=').slice(1).join('=');
if (process.argv.includes('--help')) {
  console.log('node scripts/prova-fluxo-mensagens.js [--repeticoes=1] [--cenario=trecho]\nUsa a IA configurada no .env; não grava pedidos nem acessa o WhatsApp/Supabase.');
  process.exit(0);
}
Object.assign(process.env, {
  NODE_ENV: 'test', LOG_LEVEL: 'silent', AI_ENABLED: 'on',
  SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake',
  BASE_URL: 'https://fake.test', BUSINESS_NAME: 'Point Burger', ADMIN_PHONE: '',
  AI_MAX_USD_DIA: '0', AI_MAX_TOKENS_CONVERSA: '0',
});
let conhecido = false;
const db = require('../src/db/queries');
Object.assign(db, {
  getCustomerByPhone: async () => conhecido ? { id: 1, name: 'Fernando', lang: 'pt' } : null,
  getLastDeliveryOrder: async () => conhecido ? { address: '6 Main St', city: 'Everett' } : null,
  getUltimoPedidoFeito: async () => conhecido ? { items_json: [{ id: 'x_bacon', name: 'X-Bacon', qty: 1, price: 1, removed: ['cebola'] }] } : null,
  registrarUsoIA: async () => null, getUsoIA: async () => null,
});
require('../src/services/schedule').isOpen = () => true;
require('../test/comentrega').ligar();
const provider = require('../src/ai/provider');
const custo = require('../src/ai/custo');
const original = provider.get;
let chamadas = 0, gasto = 0, falhasApi = 0;
provider.get = () => ({ conversar: async payload => {
  await new Promise(r => setTimeout(r, 1100));
  try {
    const resposta = await original().conversar(payload);
    chamadas++;
    gasto += custo.calcular(resposta.uso, provider.getModelo());
    return resposta;
  } catch (err) { falhasApi++; throw err; }
} });
const { route } = require('../src/bot/router');
const session = require('../src/bot/session');
const notify = require('../src/bot/notify');
const fallback = 'Não entendi. Para ver o menu, escreva menu ou clique no catálogo.';
let baloes = [];
let ferramentas = [];
const tools = require('../src/ai/tools');
const executar = tools.executar;
tools.executar = async (...args) => {
  const resultado = await executar(...args);
  ferramentas.push({ nome: args[0], argumentos: args[1], bloqueado: !!resultado.bloqueiaFluxo });
  return resultado;
};
notify.register(async (_phone, msg) => baloes.push(msg));
const cenarios = [
  { nome: 'novo: incompreensão e cidade ausente', conhecido: false,
    falas: ['oi', 'zxq blorpt ???', 'quero um x-burger', 'entrega', 'Maria, 6 Main St', 'Everett'],
    conferir(s, respostas) {
      assert.match(respostas[1].join(''), /Não entendi.*menu.*catálogo/s);
      assert.equal(respostas[3].join(''), 'Me passa seu nome e endereço de entrega.');
      assert.equal(respostas[4].join(''), 'Qual a cidade?');
      assert.equal(s.name, 'Maria'); assert.equal(s.city.id, 'everett');
    } },
  { nome: 'conhecido: confirmação única', conhecido: true,
    falas: ['oi', 'quero um x-burger', 'entrega', 'sim'],
    conferir(s, respostas) {
      assert.equal(respostas[0].join(''), 'Oi, Fernando! O que vai querer hoje?');
      assert.equal(respostas[2].join(''), 'Entrego em 6 Main St, Everett?');
      assert.equal(respostas[3].length, 1); assert.match(respostas[3][0], /RESUMO/);
      assert.equal(s.address, '6 Main St');
    } },
  { nome: 'conhecido: mesmo endereço explícito', conhecido: true,
    falas: ['oi', 'quero um x-burger', 'entrega no mesmo endereço'],
    conferir(s, respostas) { assert.equal(s.address, '6 Main St'); assert.equal(respostas[2].length, 1); assert.match(respostas[2][0], /RESUMO/); } },
  { nome: 'conhecido: retirada', conhecido: true,
    falas: ['oi', 'quero um x-burger', 'retirada'],
    conferir(s, respostas) { assert.equal(s.orderType, 'pickup'); assert.equal(respostas[2].length, 1); assert.match(respostas[2][0], /RESUMO/); } },
  { nome: 'conhecido: repetir pedido quando solicitado', conhecido: true,
    falas: ['oi', 'quero o de sempre', 'entrega no mesmo endereço'],
    conferir(s, respostas) {
      assert.equal(respostas[0].join(''), 'Oi, Fernando! O que vai querer hoje?');
      assert.equal(s.cart.length, 1); assert.equal(s.cart[0].productId, 'x_bacon');
      assert.equal(s.cart[0].price, 14); assert.ok(s.cart[0].removed.includes('cebola'));
    } },
];
(async () => {
  const repeticoes = Math.max(1, Number(arg('repeticoes')) || 1);
  let executados = 0, falhas = 0;
  for (let r = 0; r < repeticoes; r++) {
    for (const caso of cenarios.filter(c => c.nome.includes(arg('cenario') || ''))) {
      conhecido = caso.conhecido;
      const phone = `1555901${String(++executados).padStart(4, '0')}`;
      const respostas = [];
      const apiAntes = falhasApi;
      try {
        for (const fala of caso.falas) {
          baloes = [];
          ferramentas = [];
          await route(phone, fala, async msg => baloes.push(msg));
          console.log(JSON.stringify({ ferramentas }));
          respostas.push([...baloes]);
        }
        const s = session.get(phone);
        assert.equal(falhasApi, apiAntes, 'falha de API: resultado inconclusivo');
        caso.conferir(s, respostas);
        assert.equal(s.state, 'CONFIRM', 'deveria chegar ao resumo');
        assert.ok(!respostas.slice(1).flat().some(v => /bem-vindo|o que (?:você )?vai querer hoje/i.test(v)), 'repetiu a abertura');
        console.log(`PASSOU: ${caso.nome}`);
      } catch (err) {
        falhas++; console.log(`FALHOU: ${caso.nome}: ${err.message}`);
      } finally {
        respostas.forEach((saida, i) => console.log(JSON.stringify({ cliente: caso.falas[i], bot: saida })));
        session.clear(phone);
      }
    }
  }
  console.log(JSON.stringify({ executados, falhas, falhasApi, chamadas, custoUsd: Number(gasto.toFixed(6)) }));
  process.exit(falhas || !executados ? 1 : 0);
})().catch(() => { console.error('Prova interrompida; confira a configuração do provedor.'); process.exit(1); });
