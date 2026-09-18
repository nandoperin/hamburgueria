/**
 * O fluxo guiado grava a conversa no log do painel (aba Conversas), com o que
 * a leitura entendeu em cada fala do cliente. Antes só o agente antigo gravava.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.AI_ENABLED = 'on';
process.env.FLUXO_GUIADO = 'on';

const PROJECT = require('path').resolve(__dirname, '..');
const menuProducao = require('./fixtures/menu-producao.json');
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
config.get = (chave) => (chave === 'menu' ? menuProducao : getReal(chave));
require(`${PROJECT}/src/services/schedule`).isOpen = () => true;

const gravadas = [];
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({
  upsertCustomer: async (c) => ({ id: 1, ...c }),
  registrarConversa: async (phone, mensagens) => { gravadas.push({ phone, mensagens }); },
}, { get: (alvo, k) => alvo[k] || (async () => null) });

const VAZIA = {
  itens: [], ambiguos: [], correcoes: [], refazer_lista: false, concluiu_itens: false,
  entrega: null, cidade: null, endereco: null, nome: null, pagamento: null, troco: null,
  confirma_resumo: null, pergunta: null, cancelar: false,
};
const provPath = require.resolve(`${PROJECT}/src/ai/provider`);
const provReal = require(provPath);
require.cache[provPath].exports = {
  ...provReal,
  habilitada: () => true, getProviderName: () => 'mistral', getModelo: () => 'mistral-small-latest',
  get: () => ({
    extrair: async () => ({ texto: JSON.stringify({ ...VAZIA, itens: [{
      produto: 'x_tudao', qtd: 1, sem: ['tomate'], com: [], salsicha: null, ponto_bife: null,
      maionese_a_parte: false, trecho: 'Xtudao sem tomate' }] }), concluida: true, uso: { tokensIn: 1, tokensOut: 1 } }),
    conversar: async () => { throw new Error('o agente antigo não deveria ser chamado'); },
  }),
};

const router = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  const TEL = '15557790200';
  await router.route(TEL, 'Ola\nQuero um macarrao\nXtudao sem tomate', async () => {});
  checar(!gravadas.length, 'nada gravado com a conversa em andamento');
  session.clear(TEL);
  await new Promise((r) => setImmediate(r));
  checar(gravadas.length === 1 && gravadas[0].phone === TEL, 'conversa do fluxo guiado gravada quando a sessão fecha');
  const [cliente, bot] = gravadas[0].mensagens;
  checar(cliente.de === 'cliente' && /macarrao/.test(cliente.texto), 'guarda o que o cliente escreveu');
  checar(/macarrao_chapa/.test(cliente.leitura) && /x_tudao -tomate/.test(cliente.leitura), 'guarda o que a leitura entendeu');
  checar(bot?.de === 'bot' && /X Tud/.test(bot.texto), 'guarda o que o bot respondeu');

  console.log('\n\x1b[32mguiadologtest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
