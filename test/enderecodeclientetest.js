/**
 * Cidade nao pode virar endereco.
 *
 * Na prova real, ao receber somente "Everett", a Mistral chamou cidade e
 * endereco com o mesmo valor. Endereco e livre, mas a cidade sozinha nao pode
 * ocupar o campo de entrega.
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

let rodada = 0;
const payloads = [];
const provPath = require.resolve(`${PROJECT}/src/ai/provider`);
const provReal = require(provPath);
require.cache[provPath].exports = {
  ...provReal,
  habilitada: () => true,
  getProviderName: () => 'mistral',
  getModelo: () => 'mistral-small-latest',
  get: () => ({
    conversar: async (payload) => {
      payloads.push({
        ...payload,
        mensagens: payload.mensagens.map((m) => ({ ...m })),
      });
      rodada += 1;
      if (rodada === 1) {
        return {
          texto: '',
          chamadas: [
            { id: 'city', nome: 'definir_cidade', argumentos: { cidade: 'Everett' } },
            { id: 'end', nome: 'definir_endereco', argumentos: { endereco: 'Everett' } },
          ],
          uso: { tokensIn: 10, tokensOut: 2 },
        };
      }
      return { texto: 'Qual é o endereço da entrega?', chamadas: [], uso: { tokensIn: 10, tokensOut: 2 } };
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
  const telefone = '15556665555';
  session.clear(telefone);
  const s = session.get(telefone);
  Object.assign(s, {
    lang: 'pt',
    state: 'ORDER',
    orderType: 'delivery',
    name: 'Maria',
    cart: [{ id: 'x_burger', name: 'X-Burger', price: 11, qty: 1 }],
  });

  await agente.conversar(s, 'Everett', async () => {});

  checar(s.city?.label === 'Everett', 'a cidade foi registrada');
  checar(!s.address, 'a cidade inventada como endereco NAO foi registrada');

  const resultados = payloads[1].mensagens
    .filter((m) => m.role === 'tool')
    .map((m) => m.content || '')
    .join('\n');
  checar(
    /cidade sozinha.*NAO E O ENDERECO/i.test(resultados),
    'o modelo recebe a recusa sem impor numero ou formato postal'
  );

  console.log('\n\x1b[32menderecodeclientetest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
