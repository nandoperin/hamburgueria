process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';
process.env.AI_ENABLED = 'on';

const path = require('path');
const PROJECT = path.resolve(__dirname, '..');

const schedulePath = require.resolve(`${PROJECT}/src/services/schedule`);
require(schedulePath);
require.cache[schedulePath].exports.isOpen = () => true;

const audioPath = require.resolve(`${PROJECT}/src/services/audio`);
require(audioPath);
require.cache[audioPath].exports = {
  transcrever: async () => ({ ok: true, texto: 'dois x tudo sem batata' }),
};

const providerPath = require.resolve(`${PROJECT}/src/ai/provider`);
require(providerPath);
require.cache[providerPath].exports = {
  habilitada: () => true,
};

let textoDaIA = null;
let chamadas = 0;
const agentePath = require.resolve(`${PROJECT}/src/ai/agente`);
require(agentePath);
require.cache[agentePath].exports = {
  conversar: async (_sess, texto, send) => {
    chamadas += 1;
    textoDaIA = texto;
    await send('Pedido de voz recebido pela IA.');
    return true;
  },
  registrarSaudacao: () => {},
  registrarEdicaoCarrinho: () => {},
  reiniciar: async () => true,
};

const session = require(`${PROJECT}/src/bot/session`);
const { routeAudio } = require(`${PROJECT}/src/bot/router`);

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
  console.log(`\x1b[32m   OK: ${mensagem}\x1b[0m`);
}

(async () => {
  const phone = '15550008888';
  const sess = session.get(phone);
  sess.lang = 'pt';
  sess.greeted = true;
  sess.state = 'MENU';
  const saidas = [];

  await routeAudio(
    phone,
    Buffer.from('voz'),
    'audio/ogg; codecs=opus',
    5,
    async (texto) => saidas.push(texto)
  );

  checar(chamadas === 1, 'áudio transcrito chama a IA exatamente uma vez');
  checar(textoDaIA === 'dois x tudo sem batata', 'a transcrição inteira chega à IA');
  checar(
    saidas.join('\n') === 'Pedido de voz recebido pela IA.',
    'a resposta vem da IA e não de um FAQ'
  );

  sess.state = 'PAYMENT_PENDING';
  sess.orderId = 91;
  saidas.length = 0;
  await routeAudio(
    phone,
    Buffer.from('voz'),
    'audio/ogg',
    5,
    async (texto) => saidas.push(texto)
  );
  checar(chamadas === 1, 'pedido fechado não é alterado pela IA através de áudio');
  checar(
    /#91/.test(saidas[0]) && /comprovante/i.test(saidas[0]) && /\*0\*/.test(saidas[0]),
    'pedido fechado recebe orientação própria, sem cair no FAQ'
  );

  console.log('\n\x1b[32maudioroutingtest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
