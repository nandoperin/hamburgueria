/** A escolha de entrega e a confirmação do endereço passam pela IA. */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';

const path = require('path');
const PROJECT = path.resolve(__dirname, '..');

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  registrarUsoIA: async () => null,
  getUsoIA: async () => null,
};
require('./comentrega').ligar();

let respostas = [];
let chamadas = 0;
const provPath = require.resolve(`${PROJECT}/src/ai/provider`);
const provReal = require(provPath);
require.cache[provPath].exports = {
  ...provReal,
  habilitada: () => true,
  getProviderName: () => 'mistral',
  getModelo: () => 'mistral-small-latest',
  get: () => ({
    conversar: async () => {
      chamadas += 1;
      return respostas.shift();
    },
  }),
};

const agente = require(`${PROJECT}/src/ai/agente`);
const session = require(`${PROJECT}/src/bot/session`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  const telefone = '15551110004';
  const endereco = '2021 Revere Beach Parkway, Everett, MA 02149';
  session.clear(telefone);
  const s = session.get(telefone);
  Object.assign(s, {
    lang: 'pt',
    state: 'ORDER',
    name: 'Fernando',
    lastAddress: endereco,
    lastCityId: 'everett',
    cart: [{ id: 'x_burger', name: 'X-Burger', price: 11, qty: 1 }],
  });

  const enviadas = [];
  respostas = [{
    texto: '',
    chamadas: [{ id: 'entrega', nome: 'definir_entrega', argumentos: { tipo: 'delivery' } }],
    uso: { tokensIn: 10, tokensOut: 5 },
  }];
  await agente.conversar(s, 'entrega', async (texto) => enviadas.push(texto));

  checar(chamadas === 1, 'a escolha de entrega passa pela IA');
  checar(s.orderType === 'delivery', 'a ferramenta registra a escolha de entrega');
  checar(s.confirmandoEnderecoAnterior, 'a confirmacao do endereco fica pendente');
  checar(
    enviadas.length === 1 && enviadas[0].includes(endereco),
    'mostra uma unica vez o endereco conhecido completo'
  );

  respostas = [{
    texto: '',
    chamadas: [
      { id: 'endereco', nome: 'definir_endereco', argumentos: { endereco } },
      { id: 'finalizar', nome: 'finalizar_pedido', argumentos: {} },
    ],
    uso: { tokensIn: 10, tokensOut: 5 },
  }];
  await agente.conversar(s, 'sim', async (texto) => enviadas.push(texto));

  checar(chamadas === 2, 'a confirmação do endereço também passa pela IA');
  checar(s.address === endereco, 'o sim reaproveita o endereco conhecido');
  checar(s.state === 'CONFIRM', 'o pedido avanca para o resumo sem reconfirmar');

  console.log('\n\x1b[32mentregadiretatest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
