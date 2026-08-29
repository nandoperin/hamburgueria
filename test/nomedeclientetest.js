/**
 * O modelo nao e fonte de nome proprio.
 *
 * Na prova real, ao receber apenas "250 Broadway, apartamento 5", a Mistral
 * chamou definir_cadastro com "Cliente" e, em outra repeticao, com "Everett".
 * O teste antigo aceitava porque verificava apenas se sess.name tinha algum
 * valor. Este teste guarda a regra verdadeira: nome novo precisa existir na
 * mensagem atual do cliente. Contexto e historico nao autorizam inventar.
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
            { id: 'end', nome: 'definir_endereco', argumentos: { endereco: '250 Broadway' } },
            { id: 'nome', nome: 'definir_cadastro', argumentos: { nome: 'Cliente' } },
          ],
          uso: { tokensIn: 10, tokensOut: 2 },
        };
      }
      return { texto: 'Qual é o seu nome?', chamadas: [], uso: { tokensIn: 10, tokensOut: 2 } };
    },
  }),
};

const delivery = require(`${PROJECT}/src/services/delivery`);
const agente = require(`${PROJECT}/src/ai/agente`);
const session = require(`${PROJECT}/src/bot/session`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  const telefone = '15557776666';
  session.clear(telefone);
  const s = session.get(telefone);
  Object.assign(s, {
    lang: 'pt',
    state: 'ORDER',
    orderType: 'delivery',
    city: delivery.getCityById('everett'),
    cart: [{ id: 'x_burger', name: 'X-Burger', price: 11, qty: 1 }],
  });

  await agente.conversar(s, '250 Broadway, apartamento 5', async () => {});

  checar(s.address === '250 Broadway', 'o endereco dito pelo cliente foi registrado');
  checar(!s.name, 'o nome inventado pelo modelo NAO foi registrado');

  const resultados = payloads[1].mensagens
    .filter((m) => m.role === 'tool')
    .map((m) => m.content || '')
    .join('\n');
  checar(
    /nome.*nao apareceu|nome.*não apareceu/i.test(resultados),
    'o modelo recebe a causa da recusa e pede o nome verdadeiro'
  );

  console.log('\n\x1b[32mnomedeclientetest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
