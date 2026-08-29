/**
 * Uma mensagem do cliente pode gerar varias ferramentas de uma vez.
 *
 * O modelo recebe o resultado de todas elas na rodada seguinte. Se cada
 * setter disser "o que falta" enquanto o lote ainda esta sendo executado,
 * chegam instrucoes vencidas juntas: primeiro "falta endereco", depois
 * "falta nome" e por fim "esta tudo pronto". O modelo acaba reperguntando
 * dados que o codigo ja registrou.
 *
 * Esta suite usa o agente real e substitui apenas a chamada externa ao
 * provedor. O segundo payload e exatamente o que a Mistral receberia.
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
          chamadas: [
            { id: 'end', nome: 'definir_endereco', argumentos: { endereco: '6 Elm St' } },
            { id: 'nome', nome: 'definir_cadastro', argumentos: { nome: 'Zoraide' } },
            { id: 'city', nome: 'definir_cidade', argumentos: { cidade: 'Everett' } },
            { id: 'tipo', nome: 'definir_entrega', argumentos: { tipo: 'delivery' } },
          ],
          uso: { tokensIn: 10, tokensOut: 2 },
        };
      }
      return { texto: 'Certo.', chamadas: [], uso: { tokensIn: 10, tokensOut: 2 } };
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
  const telefone = '15558887777';
  session.clear(telefone);
  const s = session.get(telefone);
  Object.assign(s, {
    lang: 'pt',
    state: 'ORDER',
    cart: [{ id: 'x_burger', name: 'X-Burger', price: 11, qty: 1 }],
  });

  await agente.conversar(
    s,
    'entrega para Zoraide, 6 Elm St, Everett',
    async () => {}
  );

  checar(payloads.length === 2, 'o modelo recebeu a rodada posterior ao lote');
  checar(s.orderType === 'delivery', 'o tipo de entrega foi registrado');
  checar(s.city?.label === 'Everett', 'a cidade foi registrada');
  checar(s.address === '6 Elm St', 'o endereco foi registrado');
  checar(s.name === 'Zoraide', 'o nome foi registrado');

  const resultados = payloads[1].mensagens
    .filter((m) => m.role === 'tool')
    .map((m) => m.content || '')
    .join('\n');

  const prontos = (resultados.match(/TUDO PRONTO/g) || []).length;
  checar(prontos === 1, 'o lote produz uma unica orientacao final');
  checar(
    !/Falta (?:o ENDERECO|o ENDEREÇO|a CIDADE|o NOME)|ENDERECO COMPLETO e o NOME|ENDEREÇO COMPLETO e o NOME/i.test(
      resultados
    ),
    'nenhuma orientacao intermediaria vencida chega ao modelo'
  );

  console.log('\n\x1b[32mloteferramentastest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
