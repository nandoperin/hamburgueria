/**
 * "Stefany" não é complemento de endereço (cliente real, 24/09 20h29).
 *
 * A regra que reconhece "ap 1", "apt 3", "ste 4" casava qualquer palavra que
 * COMEÇASSE com uma dessas ("ste" + "fany"), e a cliente respondeu o nome três
 * vezes ouvindo "Me passa seu nome". Reproduzido aqui com as leituras exatas
 * que a leitora devolveu naquela conversa.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';
process.env.FLUXO_GUIADO = 'on';

const PROJECT = require('path').resolve(__dirname, '..');
const menuProducao = require('./fixtures/menu-producao.json');
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
config.get = (chave) => (chave === 'menu' ? menuProducao : getReal(chave));
require(`${PROJECT}/src/services/schedule`).isOpen = () => true;

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({ upsertCustomer: async (c) => ({ id: 1, ...c }) },
  { get: (alvo, k) => alvo[k] || (async () => null) });
require(`${PROJECT}/src/bot/notify`).send = async () => true;

const VAZIA = {
  itens: [], ambiguos: [], correcoes: [], refazer_lista: false, concluiu_itens: false,
  entrega: null, cidade: null, endereco: null, nome: null, pagamento: null, troco: null,
  confirma_resumo: null, pergunta: null, cancelar: false,
};
let proxima = VAZIA;
const provPath = require.resolve(`${PROJECT}/src/ai/provider`);
const provReal = require(provPath);
require.cache[provPath].exports = {
  ...provReal,
  habilitada: () => true, getProviderName: () => 'mistral', getModelo: () => 'mistral-small-latest',
  get: () => ({
    extrair: async () => ({ texto: JSON.stringify({ ...VAZIA, ...proxima }), concluida: true, uso: { tokensIn: 1, tokensOut: 1 } }),
    conversar: async () => { throw new Error('o agente antigo não deveria ser chamado'); },
  }),
};

const router = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);
const tools = require(`${PROJECT}/src/ai/tools`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}
async function falar(tel, texto, leitura) {
  proxima = leitura;
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return saidas.join('\n---\n');
}

(async () => {
  // A conversa real, mensagem por mensagem.
  const TEL = '15557793360';
  await falar(TEL, 'Boa noite', {});
  await falar(TEL, '3 laurel st Malden \n\n1 X-egg \nSem batata palha', {
    itens: [{ produto: 'x_egg_burger', qtd: 1, sem: ['batata_palha'], com: [], salsicha: null,
      ponto_bife: null, ponto_bacon: null, maionese_a_parte: false, trecho: '1 X-egg \nSem batata palha' }],
    entrega: 'entrega', cidade: 'Malden', endereco: '3 laurel st',
  });
  const s = session.get(TEL);
  checar(s.cart.length === 1 && s.address === '3 laurel st' && s.city?.label === 'Malden',
    'lanche, cidade e endereço entram da primeira mensagem');

  const r = await falar(TEL, 'Stefany', { nome: 'Stefany' });
  checar(s.name === 'Stefany', '"Stefany" é aceito como nome');
  checar(!/Me passa seu nome/.test(r), '   e o bot não pede o nome de novo');
  checar(s.address === '3 laurel st', '   e não entra no endereço');

  // Outros nomes que começavam com palavra de complemento.
  for (const nome of ['Stella', 'Steve', 'Blanca', 'Casandra', 'Apolo', 'Bruna']) {
    const t = `1555779${String(nome.length).padStart(4, '0')}${nome.charCodeAt(1)}`;
    await falar(t, '1 x tudo', { itens: [{ produto: 'x_tudo', qtd: 1, sem: [], com: [], salsicha: null,
      ponto_bife: null, ponto_bacon: null, maionese_a_parte: false, trecho: '1 x tudo' }] });
    await falar(t, nome, { nome });
    checar(session.get(t).name === nome, `"${nome}" é aceito como nome`);
  }

  // O que é complemento continua sendo complemento.
  const c = session.get('15557799999');
  c.lang = 'pt';
  c.cart = [{ id: 'x_tudo', productId: 'x_tudo', name: 'X Tudo', qty: 1, price: 20 }];
  for (const comp of ['Ap1', 'apt 3', 'ap. 2', 'ste 4', 'fundos', 'casa 2', 'unit 4b', 'bl b', 'apto']) {
    const res = await tools.executar('definir_cadastro', { nome: comp }, c, async () => {}, { textoCliente: comp });
    checar(res.bloqueiaFluxo && /complemento do endereço/.test(res.resultado), `"${comp}" continua sendo complemento`);
  }

  console.log('\n\x1b[32mnomecomplementotest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
