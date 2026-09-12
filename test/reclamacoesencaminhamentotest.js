// Sem serviços reais: testa o roteador e a entrega independente a cada admin.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.BASE_URL = 'https://fake.test';
process.env.DATABASE_URL = 'postgresql://fake';
process.env.AI_ENABLED = 'on';
process.env.ADMIN_PHONE = '+1 (555) 000-1111,15550002222,15550001111';
process.env.SUPPORT_PHONE = '15550003333';

const assert = require('node:assert/strict');
const log = require('../src/log');
const registros = [];
for (const nivel of ['info', 'warn', 'error']) log[nivel] = (dados) => registros.push({ nivel, ...dados });
const atendimento = require('../src/services/atendimento');
const session = require('../src/bot/session');
const notify = require('../src/bot/notify');
const db = require('../src/db/queries');
const schedule = require('../src/services/schedule');
let aberta = true;
schedule.isOpen = () => aberta;
const consultas = [], avisos = [], fotos = [];
let modoEnvio = 'ok', fotoFalha = false, chamadasIA = 0;

Object.assign(db, {
  getUltimoPedidoDoTelefone: async phone => {
    consultas.push({ tipo: 'telefone', phone });
    return { id: 88, phone, customer_name: 'Cliente Teste', status: 'printed', total: 20, created_at: new Date().toISOString() };
  },
  getOrder: async id => {
    consultas.push({ tipo: 'id', id });
    if (id === 999) throw new Error('falha privada do banco');
    if (id === 404) return null;
    return { id, phone: id === 66 ? '15558880000' : CLIENTE, customer_name: id === 66 ? 'Nome privado' : 'Cliente Teste',
      status: 'printed', total: id === 66 ? 999 : 20, created_at: new Date().toISOString() };
  },
  updateOrderStatus: async () => { throw new Error('não deve mudar status do pedido'); },
  createOrder: async () => { throw new Error('não deve criar pedido'); },
  approvePayment: async () => { throw new Error('não deve confirmar pagamento'); },
  getCustomerByPhone: async () => null,
  getLastDeliveryOrder: async () => null,
  getUltimoPedidoFeito: async () => null,
});
notify.send = async (phone, texto) => {
  avisos.push({ phone, texto });
  if (modoEnvio === 'falha_primeiro' && phone === '15550001111') throw new Error('falha privada de envio');
  return modoEnvio !== 'falha_todos';
};
notify.sendImage = async (phone, imagem) => { fotos.push({ phone, ...imagem }); return !fotoFalha; };
require('../src/ai/provider').habilitada = () => true;
const agente = require('../src/ai/agente');
agente.conversar = async () => { chamadasIA++; throw new Error('reclamação não pode virar pedido na IA'); };
agente.conversarPagamento = async () => { chamadasIA++; throw new Error('não deve pedir comprovante ao reclamante'); };
const router = require('../src/bot/router');
const audio = require('../src/services/audio');
const CLIENTE = '15559990000';

function preparar(estado = 'ORDER_COMPLETE') {
  atendimento.zerar(); session.clear(CLIENTE);
  require('../src/bot/vazao').zerar();
  avisos.length = 0; fotos.length = 0; consultas.length = 0; registros.length = 0;
  modoEnvio = 'ok'; fotoFalha = false; chamadasIA = 0; aberta = true;
  const sess = session.get(CLIENTE);
  Object.assign(sess, { state: estado, lang: 'pt', orderId: estado === 'LANGUAGE' ? null : 88,
    cart: [], orderType: 'pickup', paymentMethod: 'zelle', greeted: true, name: 'Cliente Teste' });
  return sess;
}
async function falar(texto) {
  const respostas = [];
  await router.route(CLIENTE, texto, async t => respostas.push(t));
  return respostas.join('\n');
}
function doisAdmins(lista = avisos) {
  assert.deepEqual(lista.map(a => a.phone).sort(), ['15550001111', '15550002222']);
}

(async () => {
  // Variações comuns, inclusive depois de a sessão expirar ou reiniciar o bot.
  const frases = [
    'Meu pedido está atrasado', 'meu pedido atrasou', 'meu pedido n chegou', 'meu pedido não chegou',
    'Ainda não recebi meu lanche', 'Tá demorando', 'ainda estou esperando',
    'Cadê meu pedido?', 'kd meu pedido', 'Onde está minha entrega?',
    'Como tá meu pedido?', 'Quero saber do meu pedido', 'Meu pedido já saiu?', 'Ja saiu pra entrega?',
    'Já ficou pronto?', 'Tá pronto?', 'Posso buscar?', 'Posso ir retirar?',
    'Qual é o número do meu pedido?', 'Tem previsão do meu pedido?',
    'O lanche veio frio', 'Não veio a coca', 'faltou meu refrigerante',
    'paguei duas vezes', 'Quero falar com atendente',
    'Where is my order?', "My order hasn't arrived", 'Is my order ready?',
    'Mi pedido no ha llegado', 'Donde esta mi pedido?', 'Puedo recoger?',
  ];
  for (const estado of ['ORDER_COMPLETE', 'PAYMENT_PENDING', 'LANGUAGE']) {
    for (const frase of frases) {
      preparar(estado);
      const resposta = await falar(frase);
      assert.match(resposta, /chamei a equipe/, `${estado}: ${frase}`);
      assert.doesNotMatch(resposta, /RESUMO|menu|comprovante|25 minutos|1h|saiu para entrega/);
      doisAdmins();
      assert(avisos.every(a => /#88/.test(a.texto) && a.texto.includes(CLIENTE)));
      assert.equal(chamadasIA, 0);
      assert.equal(registros.filter(r => r.fase === 'envio_admin' && r.aceito).length, 2);
    }
  }

  // Perguntas comerciais e correções da compra atual seguem como antes.
  for (const frase of ['quanto tempo para ficar pronto?', 'qual o valor da entrega?',
    'quero 2 x tudo', 'quero fazer um novo pedido', 'menu', 'obrigado', 'chegou tudo certinho',
    'vou chegar atrasado para buscar']) {
    assert.equal(atendimento.detectar(frase, { state: 'MENU', cart: [] }), null, frase);
  }
  const montando = { state: 'CONFIRM', cart: [{ id: 'x_tudo', qty: 1 }] };
  for (const frase of ['faltou o guaraná', 'meu pedido está errado', 'quanto tempo demora?', 'tira o tomate']) {
    assert.equal(atendimento.detectar(frase, montando), null, frase);
  }
  assert.equal(atendimento.detectar('no pedido anterior faltou o guaraná', montando), 'reclamacao');
  assert.equal(atendimento.detectar('que horas abre amanhã?', { state: 'ORDER_COMPLETE' }), null);
  for (const frase of ['quanto tempo?', 'que horas fica pronto?', 'quando vai ficar pronto?']) {
    preparar();
    assert.match(await falar(frase), /chamei a equipe/);
    doisAdmins();
  }

  preparar('LANGUAGE'); aberta = false;
  assert.match(await falar('meu pedido não chegou'), /chamei a equipe/);
  doisAdmins();

  // Áudio tem as mesmas regras do texto, inclusive fora do horário. A
  // transcrição aqui é simulada: nenhum crédito ou mensagem real é usado.
  for (const lojaAberta of [true, false]) {
    preparar(); aberta = lojaAberta;
    const ditas = [];
    audio.transcrever = async () => ({ ok: true, texto: 'meu pedido não chegou' });
    await router.routeAudio(CLIENTE, Buffer.from('voz'), 'audio/ogg', 5, async t => ditas.push(t));
    assert.match(ditas.join('\n'), /chamei a equipe/);
    doisAdmins(); assert.equal(chamadasIA, 0);
  }
  preparar('LANGUAGE'); aberta = false;
  const fechada = [];
  audio.transcrever = async () => ({ ok: true, texto: 'quero um x tudo' });
  await router.routeAudio(CLIENTE, Buffer.from('voz'), 'audio/ogg', 5, async t => fechada.push(t));
  assert.deepEqual(fechada, [router.closedMessage()]);
  assert.equal(avisos.length, 0); assert.equal(chamadasIA, 0);

  // Número informado vence o último pedido, mas só para o mesmo telefone.
  preparar();
  await falar('Meu pedido 80 já saiu?');
  assert.deepEqual(consultas, [{ tipo: 'id', id: 80 }]);
  assert(avisos.every(a => /Pedido informado: #80/.test(a.texto) && !/#88/.test(a.texto)));
  assert.equal(atendimento.aberto(CLIENTE).pedidoId, 80);
  for (const [numero, esperado] of [[66, /não localizado|nao localizado/], [404, /não localizado|nao localizado/], [999, /indispon[ií]vel/]]) {
    preparar();
    await falar(`Pedido #${numero} já saiu?`);
    doisAdmins();
    assert(avisos.every(a => esperado.test(a.texto) && !/Nome privado|999\.00|falha privada/.test(a.texto)));
    assert.equal(atendimento.aberto(CLIENTE).pedidoId, null);
  }
  preparar(); await falar('80');
  assert.equal(consultas[0].id, 80);
  preparar(); await falar('Pedido 80 e pedido 88 não chegaram');
  assert(avisos.every(a => /Pedidos citados: #80, #88/.test(a.texto)));
  assert.equal(consultas.length, 0, 'não escolher um pedido por sorte');

  // Falhar no primeiro não interrompe o segundo, e há diagnóstico separado.
  preparar(); modoEnvio = 'falha_primeiro';
  assert.match(await falar('não chegou'), /chamei a equipe/);
  doisAdmins();
  assert(registros.some(r => r.fase === 'envio_admin' && r.adminFinal === '1111' && !r.aceito));
  assert(registros.some(r => r.fase === 'envio_admin' && r.adminFinal === '2222' && r.aceito));
  assert(atendimento.aberto(CLIENTE));
  preparar(); modoEnvio = 'falha_todos';
  const falha = await falar('não chegou');
  doisAdmins();
  assert.match(falha, /Não consegui encaminhar/);
  assert.match(falha, /3333/);
  assert.doesNotMatch(falha, /1111|2222|chamei/);
  assert(!atendimento.aberto(CLIENTE), 'não silenciar se ninguém recebeu o aviso');
  preparar();
  const admins = process.env.ADMIN_PHONE;
  process.env.ADMIN_PHONE = '';
  assert.match(await falar('está atrasado'), /Não consegui encaminhar/);
  assert(!atendimento.aberto(CLIENTE));
  process.env.ADMIN_PHONE = admins;

  // Texto e imagem seguintes continuam indo para todos; sem resposta duplicada.
  preparar(); await falar('está atrasado');
  avisos.length = 0;
  assert.equal(await falar('meu nome é Ana'), '');
  doisAdmins();
  avisos.length = 0;
  assert.equal(await falar('na verdade é o pedido 80'), '');
  doisAdmins(); assert.equal(atendimento.aberto(CLIENTE).pedidoId, 80);
  const ditas = [];
  await router.routeImagem(CLIENTE, Buffer.from('foto teste'), 'image/jpeg', async t => ditas.push(t));
  doisAdmins(fotos); assert.equal(ditas.length, 0);
  avisos.length = 0; fotos.length = 0; fotoFalha = true;
  await router.routeImagem(CLIENTE, Buffer.from('foto teste'), 'image/jpeg', async t => ditas.push(t));
  doisAdmins(fotos); doisAdmins();
  assert(avisos.every(a => /foto não pôde/.test(a.texto)));
  avisos.length = 0; modoEnvio = 'falha_todos';
  assert.match(await falar('preciso de retorno'), /Não consegui encaminhar/);
  assert(!atendimento.aberto(CLIENTE));

  preparar(); await falar('está atrasado');
  atendimento.aberto(CLIENTE).repasses = 20;
  avisos.length = 0;
  assert.match(await falar('mais uma mensagem'), /limite/);
  assert.equal(avisos.length, 0, 'mantém a proteção contra enxurrada');
  assert(registros.some(r => r.fase === 'limite_repasses'));
  console.log('Reclamações, andamento sem rastreamento, número do pedido e todos os admins: passaram.');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
