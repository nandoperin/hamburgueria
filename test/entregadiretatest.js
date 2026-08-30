/**
 * A escolha curta "entrega" de um cliente conhecido nao pode depender de o
 * modelo lembrar de chamar definir_entrega. Se ele responder apenas em texto,
 * a confirmacao do endereco nunca e armada e o "sim" seguinte vira um loop.
 */

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

// Simula exatamente a variacao relatada: o modelo formula a pergunta em texto
// e nao chama a ferramenta. O codigo deve resolver a escolha antes de chegar
// a esta dependencia externa.
const provPath = require.resolve(`${PROJECT}/src/ai/provider`);
const provReal = require(provPath);
require.cache[provPath].exports = {
  ...provReal,
  habilitada: () => true,
  getProviderName: () => 'mistral',
  getModelo: () => 'mistral-small-latest',
  get: () => ({
    conversar: async () => ({
      texto: 'Posso entregar no seu endereco de sempre?',
      chamadas: [],
      uso: { tokensIn: 10, tokensOut: 5 },
    }),
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
  await agente.conversar(s, 'entrega', async (texto) => enviadas.push(texto));

  checar(s.orderType === 'delivery', 'o codigo registra a escolha de entrega');
  checar(s.confirmandoEnderecoAnterior, 'a confirmacao do endereco fica pendente');
  checar(
    enviadas.length === 1 && enviadas[0].includes(endereco),
    'mostra uma unica vez o endereco conhecido completo'
  );

  await agente.conversar(s, 'sim', async (texto) => enviadas.push(texto));

  checar(s.address === endereco, 'o sim reaproveita o endereco conhecido');
  checar(s.state === 'CONFIRM', 'o pedido avanca para o resumo sem reconfirmar');

  console.log('\n\x1b[32mentregadiretatest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
