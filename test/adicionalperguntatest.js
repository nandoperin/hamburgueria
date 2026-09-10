/**
 * O adicional pedido numa mensagem e esclarecido na seguinte.
 *
 * O relato que isto trava (pedido #53 em produção): o cliente escreveu
 * "Salsicha", o bot perguntou em qual lanche, ele respondeu "Hamburgao" — e a
 * trava anti-invenção barrou, porque a mensagem daquele turno não continha a
 * palavra "salsicha". Ele tentou cinco vezes; o pedido fechou sem o item.
 *
 * Vale para QUALQUER adicional (ovo, bacon, banana...), não só salsicha: todos
 * existem como produto avulso e como ingrediente, e o modelo escolhe um
 * caminho ou outro sem critério visível. Os dois passam por aqui.
 *
 * A defesa que NÃO pode cair junto: produto que o cliente nunca citou continua
 * bloqueado, e a janela de memória é curta — ela cobre um esclarecimento, não
 * a conversa inteira.
 */
process.env.AI_ENABLED = 'off';

const tools = require('../src/ai/tools');
const session = require('../src/bot/session');

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

function novaSessao(telefone) {
  session.clear(telefone);
  const sess = session.get(telefone);
  sess.lang = 'pt';
  sess.state = 'MENU';
  return sess;
}

const nada = async () => {};

(async () => {
  // ------------------------------------------ 1. produto avulso, o caso do #53
  console.log('\n\x1b[36m### 1. ADICIONAL AVULSO PEDIDO E ESCLARECIDO DEPOIS ###\x1b[0m');
  for (const [produto, pedido, resposta] of [
    ['salsicha', 'salsicha', 'no hamburgao'],
    ['ovo', 'quero um ovo', 'no x tudo'],
    ['bacon', 'bacon', 'hamburgao'],
  ]) {
    const sess = novaSessao('1555000090');
    await tools.executar('adicionar_item', { item_id: 'hamburgao', quantidade: 1 }, sess, nada,
      { textoCliente: 'quero um hamburgao' });

    // Turno 1: o cliente pede o adicional. O bot pergunta em qual lanche.
    tools.lembrarFala(sess, pedido);
    // Turno 2: ele responde o lanche — sem repetir o nome do adicional.
    tools.lembrarFala(sess, resposta);

    const r = await tools.executar('adicionar_item', { item_id: produto, quantidade: 1 }, sess, nada,
      { textoCliente: resposta });
    checar(!r.bloqueiaFluxo && /Adicionado/.test(r.resultado),
      `"${pedido}" + "${resposta}" registra ${produto} (antes: bloqueado)`);
    checar(sess.cart.some((l) => l.productId === produto), `e ${produto} está no carrinho`);
    session.clear('1555000090');
  }

  // ------------------------------------- 2. a defesa continua de pé
  console.log('\n\x1b[36m### 2. INVENÇÃO CONTINUA BLOQUEADA ###\x1b[0m');
  const limpa = novaSessao('1555000091');
  tools.lembrarFala(limpa, 'oi');
  tools.lembrarFala(limpa, 'sim');
  const inventado = await tools.executar('adicionar_item', { item_id: 'x_bacon', quantidade: 1 }, limpa, nada,
    { textoCliente: 'sim' });
  checar(inventado.bloqueiaFluxo === true,
    'produto que o cliente nunca citou segue bloqueado');
  checar(!limpa.cart.length, 'e nada entra no carrinho');

  // -------------------------------------- 3. a janela é curta
  console.log('\n\x1b[36m### 3. A JANELA NÃO GUARDA A CONVERSA INTEIRA ###\x1b[0m');
  const antiga = novaSessao('1555000092');
  tools.lembrarFala(antiga, 'ovo');
  for (const fala of ['nao', 'quero entrega', 'meu nome e joao', 'rua tal 123']) {
    tools.lembrarFala(antiga, fala);
  }
  const tarde = await tools.executar('adicionar_item', { item_id: 'ovo', quantidade: 1 }, antiga, nada,
    { textoCliente: 'rua tal 123' });
  checar(tarde.bloqueiaFluxo === true,
    'adicional citado há quatro mensagens já não sustenta a adição');

  // ------------------------------- 4. o mesmo adicional não é cobrado duas vezes
  console.log('\n\x1b[36m### 4. ADICIONAL AVULSO NÃO É COBRADO DE NOVO NO LANCHE ###\x1b[0m');
  const dobro = novaSessao('1555000094');
  await tools.executar('adicionar_item', { item_id: 'x_tudo', quantidade: 1 }, dobro, nada,
    { textoCliente: 'quero um x tudo' });
  await tools.executar('adicionar_item', { item_id: 'ovo', quantidade: 1 }, dobro, nada,
    { textoCliente: 'ovo' });
  const antesDoOvo = dobro.cart.reduce((s, l) => s + l.price * l.qty, 0);
  checar(antesDoOvo === 22, `x-tudo $20 + ovo avulso $2 = $22 (deu $${antesDoOvo})`);

  const noLanche = await tools.executar('personalizar_item',
    { item_id: 'x_tudo', acrescentar: ['ovo'] }, dobro, nada, { textoCliente: 'no x tudo' });
  const depois = dobro.cart.reduce((s, l) => s + l.price * l.qty, 0);
  checar(depois === 22, `continua $22 — o ovo mudou de lugar, não dobrou (deu $${depois})`);
  checar(!dobro.cart.some((l) => l.productId === 'ovo' && !(l.added || []).length),
    'a linha do ovo avulso saiu do carrinho');
  checar(dobro.cart.some((l) => l.productId === 'x_tudo' && (l.added || []).includes('ovo')),
    'e o ovo está no x-tudo');
  checar(/sem cobrar de novo/i.test(noLanche.resultado),
    'o resultado avisa o modelo do reaproveitamento, para ele não repetir a cobrança na fala');

  // Repersonalizar não pode comer um avulso que o cliente quis à parte.
  await tools.executar('adicionar_item', { item_id: 'ovo', quantidade: 1 }, dobro, nada,
    { textoCliente: 'quero mais um ovo à parte' });
  await tools.executar('personalizar_item',
    { item_id: 'x_tudo:+ovo', acrescentar: ['bacon'] }, dobro, nada, { textoCliente: 'bacon no x tudo' });
  checar(dobro.cart.some((l) => l.productId === 'ovo'),
    'ovo pedido à parte sobrevive a uma personalização seguinte do mesmo lanche');
  session.clear('1555000094');

  // ------------------- 5. preparo antes da salsicha existir orienta o modelo
  console.log('\n\x1b[36m### 5. PREPARO ANTES DA SALSICHA EXISTIR ORIENTA ###\x1b[0m');
  const semSalsicha = novaSessao('1555000093');
  await tools.executar('adicionar_item', { item_id: 'hamburgao', quantidade: 1 }, semSalsicha, nada,
    { textoCliente: 'quero um hamburgao' });
  const preparo = await tools.executar('definir_preparo_salsicha',
    { item_id: 'hamburgao', modo: 'junto' }, semSalsicha, nada, { textoCliente: 'junto' });
  checar(preparo.bloqueiaFluxo === true, 'preparo numa linha sem salsicha é recusado');
  checar(/Acrescente a salsicha primeiro/i.test(preparo.resultado),
    'e o erro diz ao modelo o que fazer, em vez de só "não achei"');

  // -------- 6. preparo apontando o lanche vira acréscimo, em vez de recusa
  console.log('\n\x1b[36m### 6. PREPARO APONTANDO O LANCHE ACRESCENTA A SALSICHA ###\x1b[0m');
  const apontado = novaSessao('1555000095');
  await tools.executar('adicionar_item', { item_id: 'hamburgao', quantidade: 1 }, apontado, nada,
    { textoCliente: 'quero um hamburgao' });
  tools.lembrarFala(apontado, 'salsicha');
  tools.lembrarFala(apontado, 'no hamburgao junto');
  const virou = await tools.executar('definir_preparo_salsicha',
    { item_id: 'hamburgao', modo: 'junto' }, apontado, nada, { textoCliente: 'no hamburgao junto' });
  checar(!virou.bloqueiaFluxo, 'a chamada apontando o lanche não é mais recusada');
  const linhaSalsicha = apontado.cart.find((l) => (l.added || []).includes('salsicha'));
  checar(Boolean(linhaSalsicha), 'a salsicha entrou no lanche apontado');
  checar(linhaSalsicha?.preparoSalsicha?.modo === 'junto', 'com o preparo "junto" registrado');
  checar(apontado.cart.reduce((s, l) => s + l.price * l.qty, 0) === 13,
    'e cobrou hamburgão $12 + salsicha $1 = $13');

  const semPedido = novaSessao('1555000096');
  await tools.executar('adicionar_item', { item_id: 'hamburgao', quantidade: 1 }, semPedido, nada,
    { textoCliente: 'quero um hamburgao' });
  tools.lembrarFala(semPedido, 'sim');
  const solta = await tools.executar('definir_preparo_salsicha',
    { item_id: 'hamburgao', modo: 'junto' }, semPedido, nada, { textoCliente: 'sim' });
  checar(solta.bloqueiaFluxo === true,
    'sem o cliente ter pedido salsicha, a chamada solta continua recusada');
  checar(!semPedido.cart.some((l) => (l.added || []).includes('salsicha')),
    'e nenhuma salsicha é cobrada');

  for (const tel of ['1555000091', '1555000092', '1555000093', '1555000095', '1555000096']) session.clear(tel);
  console.log('\n\x1b[32madicionalperguntatest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
