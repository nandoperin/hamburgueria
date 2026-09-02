process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.AI_ENABLED = 'on';
process.env.LOG_LEVEL = 'silent';
const path = require('path');
const PROJECT = path.resolve(__dirname, '..');

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  registrarUsoIA: async () => null,
};

let chamadas = 0;
let entrada;
const providerPath = require.resolve(`${PROJECT}/src/ai/provider`);
require(providerPath);
require.cache[providerPath].exports = {
  habilitada: () => true,
  getModelo: () => 'mistral-small-latest',
  get: () => ({
    conversar: async (args) => {
      chamadas += 1;
      entrada = args;
      return { texto: 'Recebi seu X-Bacon. Vai ser entrega ou retirada?', chamadas: [], uso: {} };
    },
  }),
};

const session = require(`${PROJECT}/src/bot/session`);
delete require.cache[require.resolve(`${PROJECT}/src/ai/agente`)];
const agente = require(`${PROJECT}/src/ai/agente`);

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
}

(async () => {
  const s = session.get('15550000003');
  s.lang = 'pt';
  s.cart = [{ id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 }];
  const saidas = [];
  const tratou = await agente.receberCarrinho(s, async (text) => saidas.push(text));
  checar(tratou && chamadas === 1, 'faz uma chamada quando basta perguntar o próximo dado');
  const conteudo = JSON.stringify(entrada.mensagens);
  checar(conteudo.includes('EVENTO_INTERNO_CARRINHO'), 'marca a origem interna');
  checar(!/quer retirar|quer acrescentar|bebida|upsell/i.test(saidas.join(' ')), 'não oferece alteração nem bebida');

  entrada = null;
  const conhecido = session.get('15550000004');
  Object.assign(conhecido, {
    lang: 'pt',
    name: 'Fernando',
    lastAddress: '6 Main St',
    lastCityId: 'everett',
    cart: [{ id: 'x_bacon', productId: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 }],
  });
  const falasConhecido = [];
  await agente.receberCarrinho(conhecido, async (text) => falasConhecido.push(text));
  const contextoConhecido = JSON.stringify(entrada.mensagens);
  checar(contextoConhecido.includes('Fernando'), 'evento leva o nome já conhecido');
  checar(contextoConhecido.includes('6 Main St'), 'evento leva o endereço já conhecido');
  checar(!/qual.*nome|seu nome/i.test(falasConhecido.join(' ')), 'não pede o nome novamente');

  require.cache[providerPath].exports.get = () => ({
    conversar: async () => { throw new Error('indisponível'); },
  });
  const caiu = await agente.receberCarrinho(s, async () => {});
  checar(caiu === false, 'falha devolve controle ao checkout determinístico');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
