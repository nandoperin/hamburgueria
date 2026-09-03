/**
 * Pergunta deterministica economiza uma chamada, mas continua no historico.
 * Sem isso, "não entendi" chega à IA sem a pergunta que o cliente leu.
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

const payloads = [];
let rodada = 0;
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
          chamadas: [{ id: 'tipo', nome: 'definir_entrega', argumentos: { tipo: 'delivery' } }],
          uso: { tokensIn: 10, tokensOut: 2 },
        };
      }
      return { texto: 'Preciso do endereço da entrega.', chamadas: [], uso: { tokensIn: 10, tokensOut: 2 } };
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
  const telefone = '15551110003';
  session.clear(telefone);
  const s = session.get(telefone);
  Object.assign(s, {
    lang: 'pt',
    state: 'ORDER',
    cart: [{ id: 'x_burger', name: 'X-Burger', price: 11, qty: 1 }],
  });

  const enviadas = [];
  await agente.conversar(s, 'entrega', async (texto) => enviadas.push(texto));

  checar(payloads.length === 1, 'pergunta de endereço não gasta uma segunda chamada');
  checar(/endere[cç]o/i.test(enviadas[0] || ''), 'cliente recebe uma pergunta de endereco');
  checar(/nome/i.test(enviadas[0] || '') && !/cidade/i.test(enviadas[0] || ''), 'pede nome junto e deixa cidade para somente se faltar');
  checar(
    !/apartment|unit|apartamento/i.test(enviadas[0] || ''),
    'apartamento nao e transformado em campo obrigatorio'
  );

  await agente.conversar(s, 'não entendi', async (texto) => enviadas.push(texto));
  const historico = payloads[1].mensagens.map((m) => m.content || '').join('\n');
  checar(
    payloads[1].mensagens.some((m) => m.role === 'assistant' && m.content === enviadas[0]),
    'a IA recebe no histórico a pergunta determinística que o cliente leu'
  );

  console.log('\n\x1b[32mperguntadiretatest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
