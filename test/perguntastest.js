/**
 * Perguntas e respostas cadastradas pelo dono (docs/PERGUNTAS.md, fase 1,
 * 13/11/2026): a IA só escolhe o número da pergunta; o bot manda a resposta do
 * dono palavra por palavra. Sem cadastro, tudo como antes (vai para a equipe).
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'on';
process.env.FLUXO_GUIADO = 'on';
process.env.LOG_LEVEL = 'silent';
process.env.ADMIN_PHONE = '18573531025';

const PROJECT = require('path').resolve(__dirname, '..');
const menuProducao = require('./fixtures/menu-producao.json');
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
config.get = (chave) => (chave === 'menu' ? menuProducao : getReal(chave));
require(`${PROJECT}/src/services/schedule`).isOpen = () => true;

const settings = new Map();
const docs = new Map();
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({
  getSetting: async (k) => settings.get(k) ?? null,
  setSetting: async (k, v) => { settings.set(k, v); },
  getConfigDocs: async () => [...docs].map(([key, doc]) => ({ key, doc })),
  setConfigDoc: async (key, doc) => { docs.set(key, doc); },
  upsertCustomer: async (c) => ({ id: 1, ...c }),
}, { get: (alvo, k) => alvo[k] || (async () => null) });
const notify = require(`${PROJECT}/src/bot/notify`);
const paraEquipe = [];
notify.send = async (tel, msg) => { if (tel === '18573531025') paraEquipe.push(msg); return true; };

const VAZIA = {
  itens: [], ambiguos: [], correcoes: [], refazer_lista: false, concluiu_itens: false,
  entrega: null, cidade: null, endereco: null, nome: null, pagamento: null, troco: null,
  confirma_resumo: null, pergunta: null, cancelar: false,
};
let leitura = VAZIA;
let numeroEscolhido = null;
const pedidosEscolha = [];
const provPath = require.resolve(`${PROJECT}/src/ai/provider`);
const provReal = require(provPath);
require.cache[provPath].exports = {
  ...provReal,
  habilitada: () => true, getProviderName: () => 'mistral', getModelo: () => 'mistral-small-latest', leitora: () => null,
  get: () => ({
    extrair: async (pedido) => {
      if (pedido.nome === 'pergunta_cadastrada') {
        pedidosEscolha.push(pedido);
        return { texto: JSON.stringify({ numero: numeroEscolhido }), concluida: true, uso: { tokensIn: 1, tokensOut: 1 } };
      }
      return { texto: JSON.stringify({ ...VAZIA, ...leitura }), concluida: true, uso: { tokensIn: 1, tokensOut: 1 } };
    },
    conversar: async () => { throw new Error('o agente antigo não deveria ser chamado'); },
  }),
};

const router = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);
const perguntas = require(`${PROJECT}/src/services/perguntas`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}
let n = 0;
let tel = '';
async function falar(texto, l = {}, novo = false) {
  if (novo || !tel) tel = `155577996${String(++n).padStart(2, '0')}`;
  leitura = l;
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t));
  return { r: saidas.join('\n---\n'), s: session.get(tel) };
}
const X = (produto, qtd, trecho) => ({ produto, qtd, sem: [], com: [], salsicha: null, ponto_bife: null,
  ponto_bacon: null, maionese_a_parte: false, trecho });

(async () => {
  // ---------------------------------------------------- cadastro vazio
  await falar('Boa noite', {}, true);
  let { r } = await falar('O macarrão tem pimenta?', { pergunta: 'outra' });
  checar(pedidosEscolha.length === 0, 'sem cadastro: nenhuma chamada a mais à IA');
  checar(paraEquipe.length === 1 && /macarrao tem pimenta/.test(paraEquipe[0]), 'sem cadastro: vai para a equipe, como antes');
  await perguntas.anotarPendente('x'); // espera a fila
  const pend = await perguntas.pendentes();
  checar(pend.some((p) => p.pergunta === 'O macarrão tem pimenta?') && !JSON.stringify(pend).includes(tel),
    'a pergunta sem resposta fica anotada para o painel, sem telefone');

  // ---------------------------------------------------- validação
  checar(!perguntas.montarItem({ pergunta: '', resposta: 'x' }).ok, 'cadastro: sem pergunta recusa');
  checar(!perguntas.montarItem({ pergunta: 'O macarrão tem pimenta?', resposta: ' ' }).ok, 'cadastro: sem resposta recusa');
  const m = perguntas.montarItem({ pergunta: 'O macarrão tem pimenta?', resposta: 'Não leva pimenta.\nSe quiser, mandamos à parte.' });
  checar(m.ok && m.item.resposta === 'Não leva pimenta.\nSe quiser, mandamos à parte.' && m.item.ativa === true,
    'cadastro: resposta com duas linhas é preservada');

  // ---------------------------------------------------- com cadastro
  const estac = perguntas.montarItem({ pergunta: 'Tem estacionamento?', resposta: 'Tem vaga na rua, em frente à loja.' }).item;
  await perguntas.salvar([m.item, estac]);
  checar(docs.get('perguntas').length === 2, 'cadastro salvo no banco');
  await perguntas.recarregar();
  checar(perguntas.ativas().length === 2, 'cadastro recarregado do banco');

  paraEquipe.length = 0;
  numeroEscolhido = 1;
  await falar('Boa noite', {}, true);
  ({ r } = await falar('macarrão é apimentado?', { pergunta: 'outra' }));
  checar(r.includes('Não leva pimenta.\nSe quiser, mandamos à parte.') && paraEquipe.length === 0,
    '"macarrão é apimentado?": responde com o texto do dono, sem ir para a equipe');
  const enviado = pedidosEscolha.at(-1);
  checar(/1\. O macarrão tem pimenta\?/.test(enviado.mensagens[0].content) && /2\. Tem estacionamento\?/.test(enviado.mensagens[0].content) &&
    !enviado.mensagens[0].content.includes('Não leva pimenta'), 'para a IA vão só as perguntas, nunca as respostas');

  // Pergunta no meio do pedido: responde e segue a etapa.
  await falar('Boa noite', {}, true);
  ({ r } = await falar('1 x tudo. tem estacionamento?', { itens: [X('x_tudo', 1, '1 x tudo')], pergunta: 'outra' }));
  numeroEscolhido = 2;
  ({ r } = await falar('tem lugar pra parar o carro?', { pergunta: 'outra' }));
  checar(r.includes('Tem vaga na rua, em frente à loja.') && /Entrega ou retirada\?/.test(r),
    'no meio do pedido: responde e repete a próxima etapa');

  // Nenhuma parecida, número inventado ou item desligado: equipe.
  for (const [num, desc] of [[null, 'nenhuma parecida'], [7, 'número fora da lista'], [0, 'número zero']]) {
    numeroEscolhido = num;
    paraEquipe.length = 0;
    await falar('Boa noite', {}, true);
    ({ r } = await falar('vocês fazem festa?', { pergunta: 'outra' }));
    checar(paraEquipe.length === 1 && !r.includes('Não leva pimenta'), `${desc}: vai para a equipe`);
  }
  await perguntas.salvar([{ ...m.item, ativa: false }, estac]);
  numeroEscolhido = 1;
  await falar('Boa noite', {}, true);
  ({ r } = await falar('o macarrão tem pimenta?', { pergunta: 'outra' }));
  checar(r.includes('Tem vaga na rua') || !r.includes('Não leva pimenta'), 'item desligado não vai para a IA nem é respondido');
  checar(/1\. Tem estacionamento\?/.test(pedidosEscolha.at(-1).mensagens[0].content), '   a lista enviada só tem os ligados');

  // Status do pedido e fiado continuam indo direto para a equipe.
  const antes = pedidosEscolha.length;
  paraEquipe.length = 0;
  await falar('Boa noite', {}, true);
  await falar('meu pedido já saiu?', { pergunta: 'status_pedido' });
  checar(paraEquipe.length === 1 && pedidosEscolha.length === antes, 'status do pedido: equipe, sem consultar o cadastro');

  // "Vcs tem chicken nugget?" a leitora marca como cardápio (13/11, 17744629082).
  const nugget = perguntas.montarItem({ pergunta: 'Vocês têm nugget?', resposta: 'Não temos nugget.' }).item;
  await perguntas.salvar([estac, nugget]);
  numeroEscolhido = 2;
  await falar('Boa noite', {}, true);
  ({ r } = await falar('Vou querer 2 X tudo. Vcs tem chicken nugget?', { itens: [X('x_tudo', 2, '2 X tudo')], pergunta: 'cardapio' }));
  checar(r.includes('Não temos nugget.') && !/pedido\.html/.test(r), '"tem chicken nugget?" lido como cardápio: resposta cadastrada, não o link');
  numeroEscolhido = null;
  await falar('Boa noite', {}, true);
  ({ r } = await falar('vocês tem milkshake?', { pergunta: 'cardapio' }));
  checar(!r.includes('Não temos nugget.'), '   nada parecido no cadastro: segue com o cardápio, como antes');
  const antesMenu = pedidosEscolha.length;
  await falar('Boa noite', {}, true);
  await falar('me manda o cardápio', { pergunta: 'cardapio' });
  checar(pedidosEscolha.length === antesMenu, '"me manda o cardápio": link direto, sem chamada a mais à IA');

  // ---------------------------------------------------- Zelle
  paraEquipe.length = 0;
  await falar('Boa noite', {}, true);
  ({ r } = await falar('Qual o zelle?', { pergunta: 'outra' }));
  checar(/Nosso Zelle: \*\(857\) 353-1025\*, em nome de \*Point Burger\*/.test(r) && paraEquipe.length === 0,
    '"Qual o zelle?": telefone e nome da configuração de pagamento, sem ir para a equipe');

  // Falha da IA na escolha: equipe, sem quebrar.
  require.cache[provPath].exports.get = () => ({
    extrair: async (pedido) => {
      if (pedido.nome === 'pergunta_cadastrada') throw new Error('fora do ar');
      return { texto: JSON.stringify({ ...VAZIA, ...leitura }), concluida: true, uso: { tokensIn: 1, tokensOut: 1 } };
    },
  });
  paraEquipe.length = 0;
  await falar('Boa noite', {}, true);
  ({ r } = await falar('tem estacionamento?', { pergunta: 'outra' }));
  checar(paraEquipe.length === 1, 'IA fora do ar na escolha: vai para a equipe');

  console.log('\n\x1b[32mperguntastest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
