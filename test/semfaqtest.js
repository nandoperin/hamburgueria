process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';
process.env.AI_ENABLED = 'on';

const path = require('path');
const fs = require('fs');
const PROJECT = path.resolve(__dirname, '..');

const schedulePath = require.resolve(`${PROJECT}/src/services/schedule`);
require(schedulePath);
require.cache[schedulePath].exports.isOpen = () => true;

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getActiveOrderByPhone: async () => null,
  listUnavailableItems: async () => [],
};

let textoDaIA = null;
const providerPath = require.resolve(`${PROJECT}/src/ai/provider`);
require(providerPath);
require.cache[providerPath].exports = {
  habilitada: () => true,
};

const agentePath = require.resolve(`${PROJECT}/src/ai/agente`);
require(agentePath);
require.cache[agentePath].exports = {
  conversar: async (_sess, texto, send) => {
    textoDaIA = texto;
    await send('Resposta natural da IA.');
    return true;
  },
  registrarSaudacao: () => {},
  registrarEdicaoCarrinho: () => {},
  reiniciar: async () => true,
};

const session = require(`${PROJECT}/src/bot/session`);
const { route } = require(`${PROJECT}/src/bot/router`);
const { t } = require(`${PROJECT}/src/i18n`);

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
  console.log(`\x1b[32m   OK: ${mensagem}\x1b[0m`);
}

(async () => {
  const phone = '15550007777';
  const sess = session.get(phone);
  sess.lang = 'pt';
  sess.greeted = true;
  sess.state = 'MENU';
  const saidas = [];

  await route(phone, 'ajuda', async (texto) => saidas.push(texto));

  checar(textoDaIA === 'ajuda', 'pedido de ajuda vai para a IA, sem atalho de FAQ');
  checar(saidas.join('\n') === 'Resposta natural da IA.', 'nenhuma resposta pronta de FAQ é enviada');
  checar(!/faq/i.test(t('pt', 'main_menu_footer')), 'o cardápio não anuncia FAQ');
  checar(
    !fs.readFileSync(`${PROJECT}/src/ai/agente.js`, 'utf8').includes("handlers/faq"),
    'o FAQ antigo não alimenta mais a IA'
  );

  console.log('\n\x1b[32msemfaqtest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
