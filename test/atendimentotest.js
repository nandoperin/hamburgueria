/**
 * Reclamação, estorno e "falar com atendente" vão para uma pessoa.
 *
 * Na primeira noite real (10/09) tudo isso ia para a IA: a cliente do pedido
 * #66 (veio 1 lanche e 1 refrigerante de 2 + 2) pediu estorno e passou meia
 * hora mandando "ainda não recebi o retorno", com o bot respondendo e ninguém
 * da loja sabendo. As mensagens abaixo são as dela.
 */

process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.ADMIN_PHONE = '15550001111,15550002222';
process.env.SUPPORT_PHONE = '18573531025';
process.env.AI_ENABLED = 'off';

const PROJECT = require('path').resolve(__dirname, '..');

let lojaAberta = true;
const schedulePath = require.resolve(`${PROJECT}/src/services/schedule`);
require(schedulePath);
require.cache[schedulePath].exports.isOpen = () => lojaAberta;

const CLIENTE = '17815205536';
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getCustomerByPhone: async () => null,
  getLastDeliveryOrder: async () => null,
  getActiveOrderByPhone: async () => null,
  getUltimoPedidoFeito: async () => null,
  upsertCustomer: async (c) => ({ id: 1, ...c }),
  registrarUsoIA: async () => null,
  getUsoIA: async () => null,
  getUltimoPedidoDoTelefone: async (phone) => (phone === CLIENTE
    ? { id: 66, status: 'printed', total: 37, created_at: '2026-09-10T23:44:19Z', customer_name: 'Cleide' }
    : null),
  getOrder: async (id) => (id === 66 ? { id: 66, phone: CLIENTE } : null),
};

const notify = require(`${PROJECT}/src/bot/notify`);
const paraAdmins = [];
const fotos = [];
notify.register(async (phone, texto) => { paraAdmins.push({ phone, texto }); return true; });
notify.sendImage = async (phone, { caption }) => { fotos.push({ phone, caption }); return true; };

const comprovantePath = require.resolve(`${PROJECT}/src/services/comprovante`);
require(comprovantePath);
let leuComprovante = false;
require.cache[comprovantePath].exports.receber = async () => { leuComprovante = true; return false; };

const router = require(`${PROJECT}/src/bot/router`);
const atendimento = require(`${PROJECT}/src/services/atendimento`);
const session = require(`${PROJECT}/src/bot/session`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

async function cliente(phone, texto) {
  const ditas = [];
  await router.route(phone, texto, async (m) => { ditas.push(m); });
  return ditas.join('\n');
}

(async () => {
  // --------------------------------------------- 1. a reclamação do #66
  console.log('\n\x1b[36m### 1. RECLAMACAO VAI PARA UMA PESSOA ###\x1b[0m');
  const resposta = await cliente(CLIENTE, 'Eu pedi 2 lanche com 2 refrigerante e so veio um lanche e refrigerante');
  checar(/chamei a equipe/.test(resposta) && /857/.test(resposta), 'o cliente ouve que uma pessoa vai responder');
  checar(paraAdmins.length === 2 && paraAdmins.map((m) => m.phone).join() === '15550001111,15550002222',
    'os dois admins são avisados');
  const aviso = paraAdmins[0].texto;
  console.log(aviso);
  checar(/ATENDIMENTO/.test(aviso) && /reclamacao/.test(aviso), 'com o motivo');
  checar(/#66/.test(aviso) && /Cleide/.test(aviso) && /\+17815205536/.test(aviso), 'com o pedido, o nome e o telefone');
  checar(/so veio um lanche/.test(aviso), 'e a mensagem dela');
  checar(/!bot 66/.test(aviso), 'e o comando para devolver ao bot');

  // ------------------------------------------ 2. o que ela manda depois
  console.log('\n\x1b[36m### 2. EM ATENDIMENTO, O BOT FICA QUIETO ###\x1b[0m');
  paraAdmins.length = 0;
  const depois = await cliente(CLIENTE, 'Ainda nao recebi o retorno');
  checar(depois === '', 'o bot não responde por cima da pessoa');
  checar(paraAdmins.length === 2 && /em atendimento/.test(paraAdmins[0].texto) &&
    /Ainda nao recebi o retorno/.test(paraAdmins[0].texto), 'a mensagem chega aos admins');

  paraAdmins.length = 0;
  const qualquer = await cliente(CLIENTE, '#66');
  checar(qualquer === '' && paraAdmins.length === 2, 'qualquer mensagem dela, não só reclamação');

  const semResposta = [];
  await router.routeImagem(CLIENTE, Buffer.from('foto'), 'image/jpeg', async (m) => semResposta.push(m));
  checar(fotos.length === 2 && /Cleide/.test(fotos[0].caption), 'a foto dela vai para os admins');
  checar(!leuComprovante && !semResposta.length, 'sem virar leitura de comprovante nem resposta do bot');

  // --------------------------------------------------- 3. !bot devolve
  console.log('\n\x1b[36m### 3. !bot DEVOLVE AO BOT ###\x1b[0m');
  const ditasAdmin = [];
  await router.route('15550001111', '!bot 66', async (m) => ditasAdmin.push(m));
  checar(/voltou a responder/.test(ditasAdmin.join()), 'o admin devolve pelo número do pedido');
  paraAdmins.length = 0;
  const volta = await cliente(CLIENTE, 'oi');
  checar(volta !== '' && paraAdmins.length === 0, 'e o bot volta a atender, sem repassar nada');

  // ---------------------------------------------- 4. atendente e estorno
  console.log('\n\x1b[36m### 4. ATENDENTE, ESTORNO, LOJA FECHADA ###\x1b[0m');
  atendimento.zerar();
  paraAdmins.length = 0;
  lojaAberta = false;
  const fechada = await cliente('15557770001', 'Falar com atendente');
  checar(/chamei a equipe/.test(fechada) && paraAdmins.length === 2,
    'com a loja fechada, o pedido de atendente chega mesmo assim');
  checar(/pediu para falar com uma pessoa/.test(paraAdmins[0].texto), 'com o motivo certo');
  lojaAberta = true;

  paraAdmins.length = 0;
  await cliente('15557770002', 'Falei com a moça aqui que vcs podem mim retornar o zelle do outro pedido');
  checar(paraAdmins.length === 2 && /estorno/.test(paraAdmins[0].texto), 'pedido de estorno também');

  // ----------------------------------- 5. o que NÃO é pedido de pessoa
  console.log('\n\x1b[36m### 5. O QUE NAO E ATENDIMENTO ###\x1b[0m');
  paraAdmins.length = 0;
  await cliente('15557770003', 'Ja saiu pra entrega?');
  checar(paraAdmins.length === 0, 'pergunta de status segue com o bot');

  const montando = session.get('15557770004');
  Object.assign(montando, { lang: 'pt', state: 'CONFIRM', cart: [{ id: 'x_tudo', productId: 'x_tudo', name: 'X Tudo', qty: 1, price: 20 }] });
  await cliente('15557770004', 'faltou o guarana');
  checar(paraAdmins.length === 0, 'no meio do pedido, "faltou o guaraná" é sobre o carrinho');

  // ------------------------------- 6. carrinho do catálogo e janela
  console.log('\n\x1b[36m### 6. CATALOGO E FIM DA JANELA ###\x1b[0m');
  await cliente('15557770005', 'o lanche veio frio');
  checar(Boolean(atendimento.aberto('15557770005')), 'reclamação abre o atendimento');
  await router.routeOrder('15557770005', { items: [], source: 'baileys' }, async () => {});
  checar(!atendimento.aberto('15557770005'), 'mandou carrinho do catálogo: quer pedir, o bot volta');

  await cliente('15557770006', 'o lanche veio frio');
  const agora = Date.now;
  Date.now = () => agora() + atendimento.JANELA_MS + 60 * 1000;
  paraAdmins.length = 0;
  const depoisDaJanela = await cliente('15557770006', 'oi');
  Date.now = agora;
  checar(depoisDaJanela !== '' && paraAdmins.length === 0, 'meia hora sem mensagem: o bot volta sozinho');

  console.log('\n\x1b[32matendimentotest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
