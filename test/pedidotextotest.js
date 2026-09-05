process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
process.env.LOG_LEVEL = 'silent';
process.env.AI_ENABLED = 'on';
const assert = require('node:assert/strict');
const pedido = require('../src/services/pedido-texto');
const agente = require('../src/ai/agente');
const db = require('../src/db/queries');
let cadastro = null;
db.getCustomerByPhone = async () => cadastro;
db.getLastDeliveryOrder = async () => null;
db.getUltimoPedidoFeito = async () => null;
let chamadasIA = 0;
let iaDisponivel = false;
agente.conversar = async (sess, texto) => {
  chamadasIA++;
  if (iaDisponivel) sess.textoRecebidoPelaIA = texto;
  return iaDisponivel;
};
require('../src/services/schedule').isOpen = () => true;
require('../src/bot/vazao').avaliar = () => 'permitir';
const { route } = require('../src/bot/router');
const sessoes = require('../src/bot/session');
const notify = require('../src/bot/notify');
let saidas = [];
const send = async texto => saidas.push(texto);
notify.register(async (_phone, texto) => send(texto));
let serial = 0;
const nova = () => {
  const sess = sessoes.get('1555000' + String(++serial).padStart(4, '0'));
  Object.assign(sess, { lang: 'pt', state: 'MENU', cart: [], menuSelection: { kind: 'items', ids: ['x_tudo'] } });
  saidas = [];
  return sess;
};
(async () => {
  // Novo print: olá -> pedido direto, sem menu. Também cobre pedido como
  // primeira mensagem, passando por welcome e carregamento do cadastro.
  for (const conhecido of [false, true]) {
    cadastro = conhecido ? { id: 7, name: 'Fernando', lang: 'pt' } : null;
    for (const comOla of [true, false]) {
      const sess = nova();
      sess.state = 'LANGUAGE';
      sess.menuSelection = null;
      if (comOla) {
        await route(sess.phone, 'Ola', send);
        assert.equal(sess.state, 'MENU');
        assert.equal(sess.menuSelection?.kind, 'categories');
        assert.match(saidas.at(-1), /Abra o catálogo no WhatsApp|Cardápio/);
        if (conhecido) assert.match(saidas.at(-1), /Fernando/);
      }
      await route(sess.phone, 'Xtudo sem tomate e xtudo com salsicha', send);
      assert.equal(sess.cart.length, 2);
      assert.deepEqual(sess.cart[0].removed, ['tomate']);
      assert.deepEqual(sess.cart[1].added, ['salsicha']);
      assert.equal(sessoes.getSubtotal(sess), 41);
      assert.match(saidas.at(-1), /parte ou junto/);
      assert.ok(!saidas.some(s => /Não entendi/.test(s)));
      await route(sess.phone, 'junto', send);
      assert.equal(sess.cart[1].preparoSalsicha.modo, 'junto');
      assert.equal(sessoes.getSubtotal(sess), 41);
    }
  }
  cadastro = null;
  assert.ok(chamadasIA > 0, 'texto livre tentou a IA antes da rede local');
  // Print 10:22: o pedido inteiro e as duas mensagens separadas são equivalentes.
  for (const batata of ['batata', 'batatas', 'batata palha']) {
    for (const qtd of ['2', '2x', '2 x', 'dois']) {
      for (const separado of [false, true]) {
        const sess = nova(); sess.menuSelection = null;
        if (separado) {
          await route(sess.phone, `Xtudo sem ${batata}`, send);
          assert.match(saidas.at(-1), /Quer algo mais/);
          await route(sess.phone, `${qtd} xtudo com salsicha`, send);
        } else {
          await route(sess.phone, `Xtudo sem ${batata} e ${qtd} xtudo com salsicha`, send);
        }
        assert.equal(sess.cart.length, 2, `${batata}/${qtd}/${separado}`);
        assert.deepEqual(sess.cart[0].removed, ['batata_palha']);
        assert.equal(sess.cart[0].qty, 1);
        assert.deepEqual(sess.cart[1].added, ['salsicha']);
        assert.equal(sess.cart[1].qty, 2);
        assert.equal(sessoes.getSubtotal(sess), 62);
        await route(sess.phone, 'junto', send);
        assert.equal(sess.cart[1].preparoSalsicha.modo, 'junto');
        assert.equal(sess.cart[1].qty, 2);
        assert.equal(sessoes.getSubtotal(sess), 62);
      }
    }
  }
  const separados = nova(); separados.menuSelection = null;
  await route(separados.phone, 'Xtudo sem tomate', send);
  await route(separados.phone, '2 xtudo com salsicha', send);
  assert.deepEqual(separados.cart[0].removed, ['tomate']);
  assert.equal(separados.cart[1].qty, 2);
  assert.equal(sessoes.getSubtotal(separados), 62);
  assert.ok(chamadasIA > 0);
  const printNovo = nova(); printNovo.menuSelection = null;
  await route(printNovo.phone, 'Xtudo sem tomate e xtudo com salsicha', send);
  await route(printNovo.phone, 'A parte', send);
  assert.match(saidas.at(-1), /Quer algo mais\? Digite menu para abrir as opções/);
  assert.ok(!saidas.at(-1).includes('Entrega ou retirada'));
  await route(printNovo.phone, 'Quero uma coca', send);
  assert.equal(printNovo.cart.length, 3);
  assert.equal(printNovo.cart[2].productId, 'coca_cola');
  assert.equal(printNovo.cart[2].qty, 1);
  assert.equal(sessoes.getSubtotal(printNovo), 43);
  assert.equal(printNovo.cart[1].preparoSalsicha.modo, 'a_parte');
  assert.match(saidas.at(-1), /Quer algo mais/);
  await route(printNovo.phone, 'sim', send);
  assert.match(saidas.at(-1), /O que mais você quer/);
  await route(printNovo.phone, 'só isso', send);
  assert.match(saidas.at(-1), /Entrega ou retirada/);
  assert.equal(printNovo.aguardandoMaisItens, false);
  assert.equal(printNovo.escolhaItensConcluida, true);
  assert.ok(chamadasIA > 0, 'itens em texto tentam a IA; respostas curtas ficam locais');
  assert.ok(!require('../src/ai/tools').mensagemColeta(printNovo).includes('Quer algo mais'));
  const reiniciado = sessoes.reset(printNovo.phone);
  assert.ok(!reiniciado.escolhaItensConcluida, 'novo pedido permite nova escolha');

  // Catálogo também pausa antes da entrega, sem chamar o modelo.
  const nativo = nova(); nativo.menuSelection = null;
  await require('../src/bot/router').routeOrder(nativo.phone, {
    source: 'meta', externalOrderId: 'mais-itens-catalogo',
    items: [{ productId: 'x_burger', quantity: 1, externalProductId: 'x_burger' }],
  }, send);
  assert.match(saidas.at(-1), /Quer algo mais/);
  await route(nativo.phone, 'Quero uma coca', send);
  assert.equal(sessoes.getSubtotal(nativo), 14);
  await route(nativo.phone, 'não, obrigado', send);
  assert.match(saidas.at(-1), /Entrega ou retirada/);
  assert.ok(chamadasIA > 0);

  // Se a IA perguntou "Quer algo mais?" depois de entrega/nome ja estarem
  // definidos, "n" encerra a escolha e vai direto ao resumo. Nao volta para a
  // IA mostrar o carrinho e perguntar de novo.
  const diretoAoResumo = nova(); diretoAoResumo.menuSelection = null;
  Object.assign(diretoAoResumo, {
    orderType: 'pickup',
    name: 'Giovanna',
    aguardandoMaisItens: true,
    escolhaItensConcluida: false,
    cart: [{ id: 'x_burger', productId: 'x_burger', name: 'X Burger', qty: 1, price: 12 }],
  });
  const chamadasAntesDoNao = chamadasIA;
  await route(diretoAoResumo.phone, 'n', send);
  assert.equal(chamadasIA, chamadasAntesDoNao, 'negacao curta nao volta para a IA');
  assert.equal(diretoAoResumo.state, 'CONFIRM');
  assert.equal(saidas.length, 1);
  assert.match(saidas[0], /RESUMO DO PEDIDO/);
  assert.doesNotMatch(saidas[0], /mais alguma coisa|quer algo mais/i);

  for (const grafia of ['Xtudo', 'X Tudo', 'X-Tudo']) {
    const sess = nova();
    // Percorre menu -> categoria -> pedido, como no print, e não só o parser.
    await route(sess.phone, 'menu', send);
    await route(sess.phone, 'sanduiches', send);
    await route(sess.phone, `${grafia} sem tomate e xtudo com salsicha extra`, send);
    assert.equal(sess.cart.length, 2);
    assert.deepEqual(sess.cart[0].removed, ['tomate']);
    assert.deepEqual(sess.cart[0].added, []);
    assert.deepEqual(sess.cart[1].added, ['salsicha']);
    assert.deepEqual(sess.cart[1].removed, []);
    assert.equal(sess.cart[0].price, 20);
    assert.equal(sess.cart[1].price, 21);
    assert.equal(sessoes.getSubtotal(sess), 41);
    assert.notEqual(sess.cart[0].id, sess.cart[1].id);
    assert.match(saidas.at(-1), /parte ou junto/);
    assert.equal(sess.menuSelection, null);
    await route(sess.phone, 'junto', send);
    assert.equal(sess.cart[1].preparoSalsicha.modo, 'junto');
    assert.equal(sessoes.getSubtotal(sess), 41);
  }
  assert.ok(chamadasIA > 0);
  process.env.AI_ENABLED = 'off';
  const semIA = nova();
  await route(semIA.phone, 'xtudo sem tomate e xtudo com salsicha extra', send);
  assert.equal(sessoes.getSubtotal(semIA), 41);
  assert.match(saidas.at(-1), /parte ou junto/);
  process.env.AI_ENABLED = 'on';
  const quantidade = nova();
  assert.equal(await pedido.atender(quantidade, 'dois x tudo sem tomate com bacon extra', send), true);
  assert.equal(quantidade.cart[0].qty, 2);
  assert.equal(quantidade.cart[0].price, 24);
  for (const texto of ['nao quero xtudo', 'xtudo?', 'xtudo sem tomate e uma pizza',
    'xtudo com duas salsichas', 'xtudo com bacon e bacon', 'xtudo sem tomate por 1 dolar',
    'xtudo sem batata frita', 'xtudo sem batata e batata palha', 'xtudo com queijo',
    'xtudo sem tomate entrega em boston', 'xtudo com bacon e um ovo', 'xtudo com cheddar']) {
    const sess = nova();
    assert.equal(await pedido.atender(sess, texto, send), false, texto);
    assert.equal(sess.cart.length, 0, 'frase incerta nao modifica parcialmente');
  }
  const conflito = nova();
  assert.equal(await pedido.atender(conflito, 'xtudo sem tomate com tomate', send), false);
  assert.equal(conflito.cart.length, 0);
  const fechado = nova(); fechado.state = 'PAYMENT_PENDING';
  assert.equal(await pedido.atender(fechado, 'xtudo sem tomate', send), false);
  const semMenu = nova(); semMenu.menuSelection = null;
  assert.equal(await pedido.atender(semMenu, 'xtudo sem tomate', send), true);
  assert.equal(semMenu.cart.length, 1);
  assert.equal(await pedido.atender(semMenu, 'xtudo sem tomate', send), false,
    'nao duplicar item quando a frase pode ser uma edicao do carrinho');
  assert.equal(semMenu.cart.length, 1);
  semMenu.aguardandoMaisItens = false;
  assert.equal(await pedido.atender(semMenu, '2 xtudo sem tomate', send), false,
    'fora da pergunta de mais itens, quantidade nao resolve ambiguidade de edicao');
  assert.equal(semMenu.cart.length, 1);
  const antesLivre = chamadasIA;
  const livre = nova();
  await route(livre.phone, 'xtudo com cheddar', send);
  assert.equal(chamadasIA, antesLivre + 1, 'frase nao suportada continua com a IA');
  const prioridade = nova(); prioridade.menuSelection = null;
  iaDisponivel = true;
  const antesPrioridade = chamadasIA;
  await route(prioridade.phone, 'quero um xtudo sem tomate', send);
  iaDisponivel = false;
  assert.equal(chamadasIA, antesPrioridade + 1);
  assert.equal(prioridade.textoRecebidoPelaIA, 'quero um xtudo sem tomate');
  assert.equal(prioridade.cart.length, 0, 'rede local não roda quando a IA tratou');
  console.log('Pedido do print: duas variantes, $41, preparo sem duplicar custo, sem IA e sem aplicacao parcial.');
})().catch(err => { console.error(err); process.exitCode = 1; });
