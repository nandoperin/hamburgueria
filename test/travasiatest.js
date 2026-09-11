/**
 * Leituras erradas da IA na primeira noite real (10/09), agora travadas no
 * código — o prompt pedia o certo, mas prompt não é trava.
 *
 *   - "sem salada" virou sem alface, tomate, milho, batata palha e parmesão
 *     (pedido #67; o cliente reclamou). Salada é alface e tomate.
 *   - "Tem cachorro quente?" e "quanto tempo pra um x-tudão?" viraram itens.
 *   - "Everett", a cidade, virou o nome do cliente (pedido #71).
 *   - Pedido refeito ("hoje pode ser então 1 hot plain, 1 hot duplo, 1
 *     guaraná") foi somado ao anterior (pedido #68).
 *
 * As ferramentas rodam de verdade, sem modelo: cada caso é a chamada que o
 * modelo fez naquela noite, com a mensagem real do cliente.
 */
process.env.AI_ENABLED = 'off';

const tools = require('../src/ai/tools');
const session = require('../src/bot/session');

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

let seq = 0;
function novaSessao() {
  const telefone = `155500077${String(seq++).padStart(2, '0')}`;
  session.clear(telefone);
  const sess = session.get(telefone);
  sess.lang = 'pt';
  sess.state = 'MENU';
  return sess;
}

const nada = async () => {};

/** Um turno como o agente faz: guarda a fala, depois chama a ferramenta. */
async function turno(sess, texto, chamadas) {
  tools.lembrarFala(sess, texto);
  const resultados = [];
  for (const [nome, args] of chamadas) {
    resultados.push(await tools.executar(nome, args, sess, nada, { textoCliente: texto }));
  }
  return resultados;
}

const linha = (sess, produto) => sess.cart.find((l) => l.productId === produto);
const qtd = (sess, produto) => sess.cart
  .filter((l) => l.productId === produto)
  .reduce((soma, l) => soma + l.qty, 0);

(async () => {
  // ---------------------------------------------------------- 1. salada
  console.log('\n\x1b[36m### 1. SALADA E ALFACE E TOMATE ###\x1b[0m');
  let sess = novaSessao();
  await turno(sess, 'Boa noite, vou querer 1 X-TUDO sem salada, 1 molho extra e 1 Guaraná lata', [
    ['adicionar_item', { item_id: 'x_tudo', quantidade: 1, remover: ['alface', 'tomate', 'milho', 'batata_palha', 'parmesao'] }],
  ]);
  checar(JSON.stringify([...linha(sess, 'x_tudo').removed].sort()) === '["alface","tomate"]',
    '"sem salada" tira só alface e tomate — milho, batata palha e parmesão ficam');

  sess = novaSessao();
  await turno(sess, 'um x tudo sem salada e sem milho', [
    ['adicionar_item', { item_id: 'x_tudo', remover: ['alface', 'tomate', 'milho', 'batata_palha'] }],
  ]);
  checar(JSON.stringify([...linha(sess, 'x_tudo').removed].sort()) === '["alface","milho","tomate"]',
    'o que o cliente cita pelo nome continua saindo');

  sess = novaSessao();
  await turno(sess, 'um x tudo sem salada', [['adicionar_item', { item_id: 'x_tudo', remover: ['alface'] }]]);
  checar(JSON.stringify([...linha(sess, 'x_tudo').removed].sort()) === '["alface","tomate"]',
    'o modelo esqueceu o tomate: salada é os dois');

  sess = novaSessao();
  await turno(sess, 'um x tudo sem salada e um x burger sem milho', [
    ['adicionar_item', { item_id: 'x_tudo', remover: ['alface', 'tomate'] }],
    ['adicionar_item', { item_id: 'x_burger', remover: ['milho'] }],
  ]);
  checar(JSON.stringify(linha(sess, 'x_burger').removed) === '["milho"]',
    'o outro lanche da mesma frase fica só "sem milho" — a salada não vaza para ele');

  sess = novaSessao();
  await turno(sess, 'um x tudo', [['adicionar_item', { item_id: 'x_tudo' }]]);
  await turno(sess, 'tira a salada do x tudo', [
    ['personalizar_item', { item_id: 'x_tudo', remover: ['alface', 'tomate', 'milho', 'parmesao'] }],
  ]);
  checar(JSON.stringify([...linha(sess, 'x_tudo').removed].sort()) === '["alface","tomate"]',
    'vale também ao personalizar depois');

  // ---------------------------------------------- 2. pergunta não é pedido
  console.log('\n\x1b[36m### 2. PERGUNTA NAO E PEDIDO ###\x1b[0m');
  sess = novaSessao();
  let [r] = await turno(sess, 'Tem hot plain?', [['adicionar_item', { item_id: 'hot_plain' }]]);
  checar(r.bloqueiaFluxo && /PERGUNTOU/.test(r.resultado) && !sess.cart.length,
    '"Tem hot plain?" não põe no carrinho');

  sess = novaSessao();
  [r] = await turno(sess, 'Quanto tempo pra ficar pronto um x tudo ?', [['adicionar_item', { item_id: 'x_tudo' }]]);
  checar(r.bloqueiaFluxo && !sess.cart.length, '"quanto tempo pra um x tudo?" também não');

  [r] = await turno(sess, 'sim, pode mandar', [['adicionar_item', { item_id: 'x_tudo' }]]);
  checar(!r.bloqueiaFluxo && qtd(sess, 'x_tudo') === 1, 'depois do "sim" o x tudo entra');

  sess = novaSessao();
  [r] = await turno(sess, 'Pode me mandar um x tudo?', [['adicionar_item', { item_id: 'x_tudo' }]]);
  checar(!r.bloqueiaFluxo && qtd(sess, 'x_tudo') === 1, '"Pode me mandar um x tudo?" é pedido');

  sess = novaSessao();
  const multi = await turno(sess, 'X tudo\nTem hot plain?', [
    ['adicionar_item', { item_id: 'x_tudo' }],
    ['adicionar_item', { item_id: 'hot_plain' }],
  ]);
  checar(!multi[0].bloqueiaFluxo && multi[1].bloqueiaFluxo && qtd(sess, 'x_tudo') === 1 && !linha(sess, 'hot_plain'),
    'linha de pedido entra; a linha de pergunta, não');

  sess = novaSessao();
  [r] = await turno(sess, 'tem coca? manda uma', [['adicionar_item', { item_id: 'coca_cola' }]]);
  checar(!r.bloqueiaFluxo && qtd(sess, 'coca_cola') === 1, '"tem coca? manda uma" é pedido');

  sess = novaSessao();
  [r] = await turno(sess, 'poderia me enviar um x tudo e uma coca por favor.', [['adicionar_item', { item_id: 'x_tudo' }]]);
  checar(!r.bloqueiaFluxo, 'pedido educado, sem ponto de interrogação, entra');

  // ------------------------------------------------ 3. cidade não é nome
  console.log('\n\x1b[36m### 3. CIDADE NAO E NOME ###\x1b[0m');
  sess = novaSessao();
  await turno(sess, 'um x burger', [['adicionar_item', { item_id: 'x_burger' }]]);
  let [cidade, cadastro] = await turno(sess, 'Everett', [
    ['definir_cidade', { cidade: 'Everett' }],
    ['definir_cadastro', { nome: 'Everett' }],
  ]);
  checar(!cadastro.atualizarFluxo && /CIDADE/.test(cadastro.resultado) && !sess.name,
    '"Everett" registra a cidade, mas não vira o nome (pedido #71)');
  [cadastro] = await turno(sess, 'Gustavo', [['definir_cadastro', { nome: 'Gustavo' }]]);
  checar(sess.name === 'Gustavo', 'o nome de verdade entra na resposta seguinte');

  [cadastro] = await turno(await novaSessaoCom('x_burger'), 'Cliente', [['definir_cadastro', { nome: 'Cliente' }]]);
  checar(/não é nome/.test(cadastro.resultado), '"Cliente" não é nome de ninguém');

  sess = await novaSessaoCom('x_burger');
  [cadastro] = await turno(sess, 'meu nome é Chelsea', [['definir_cadastro', { nome: 'Chelsea' }]]);
  checar(sess.name === 'Chelsea', 'quem se chama Chelsea e se apresenta, passa');

  sess = await novaSessaoCom('x_burger');
  await turno(sess, 'Chelsea', [['definir_cadastro', { nome: 'Chelsea' }]]);
  checar(!sess.name, 'só "Chelsea" como resposta: parece a cidade, pergunta de novo');
  await turno(sess, 'Chelsea', [['definir_cadastro', { nome: 'Chelsea' }]]);
  checar(sess.name === 'Chelsea', 'repetiu depois de perguntado: é o nome dela');

  // ------------------------------------------------ 4. pedido refeito
  console.log('\n\x1b[36m### 4. PEDIDO REFEITO ###\x1b[0m');
  sess = novaSessao();
  await turno(sess, 'Gostaria de\n\n2 hot plain\n\n2 gurana\n\nQuanto Daria?', [
    ['adicionar_item', { item_id: 'hot_plain', quantidade: 2 }],
    ['adicionar_item', { item_id: 'guarana', quantidade: 2 }],
  ]);
  await turno(sess, 'Desculpa\n\nHoje pode ser então\n\n1 hot plain\n\n1 hot   duplo\n\n1   gurana lata', [
    ['adicionar_item', { item_id: 'hot_plain', quantidade: 1 }],
    ['adicionar_item', { item_id: 'hot_duplo', quantidade: 1 }],
    ['adicionar_item', { item_id: 'guarana', quantidade: 1 }],
  ]);
  checar(qtd(sess, 'hot_plain') === 1 && qtd(sess, 'hot_duplo') === 1 && qtd(sess, 'guarana') === 1,
    'o pedido #68 fica 1 hot plain, 1 hot duplo, 1 guaraná — não 3, 1 e 3');

  sess = novaSessao();
  await turno(sess, 'um x tudo e uma coca', [
    ['adicionar_item', { item_id: 'x_tudo' }],
    ['adicionar_item', { item_id: 'coca_cola' }],
  ]);
  await turno(sess, 'pode ser então 2 x burger e 1 guaraná', [
    ['adicionar_item', { item_id: 'x_burger', quantidade: 2 }],
    ['adicionar_item', { item_id: 'guarana', quantidade: 1 }],
  ]);
  checar(!linha(sess, 'x_tudo') && !linha(sess, 'coca_cola') && qtd(sess, 'x_burger') === 2 && qtd(sess, 'guarana') === 1,
    'a lista refeita substitui a anterior');

  sess = novaSessao();
  await turno(sess, 'um x tudo e uma coca', [
    ['adicionar_item', { item_id: 'x_tudo' }],
    ['adicionar_item', { item_id: 'coca_cola' }],
  ]);
  await turno(sess, 'na verdade quero mais uma coca', [['adicionar_item', { item_id: 'coca_cola' }]]);
  checar(qtd(sess, 'coca_cola') === 2 && qtd(sess, 'x_tudo') === 1, '"mais uma" continua somando');

  await turno(sess, 'desculpa, são 3 x tudo', [['adicionar_item', { item_id: 'x_tudo', quantidade: 3 }]]);
  checar(qtd(sess, 'x_tudo') === 3 && qtd(sess, 'coca_cola') === 2, 'correção de quantidade vira a quantidade final');

  sess = novaSessao();
  const mensagem = 'Olá boa noite gostaria de fazer um pedido de 1 hot especial. Delivery';
  await turno(sess, mensagem, [['adicionar_item', { item_id: 'hot_especial', quantidade: 1 }]]);
  await turno(sess, mensagem, [['adicionar_item', { item_id: 'hot_especial', quantidade: 1 }]]);
  checar(qtd(sess, 'hot_especial') === 1, 'a mesma mensagem mandada de novo não dobra o pedido');

  sess = novaSessao();
  await turno(sess, 'um x tudo', [['adicionar_item', { item_id: 'x_tudo' }]]);
  await turno(sess, 'outro x tudo', [['adicionar_item', { item_id: 'x_tudo' }]]);
  checar(qtd(sess, 'x_tudo') === 2, 'pedir outro, sem refazer, continua somando');

  console.log('\n\x1b[32mtravasiatest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});

/** Sessão com um produto já no carrinho — o cadastro exige pedido. */
async function novaSessaoCom(produto) {
  const sess = novaSessao();
  await turno(sess, `um ${produto.replace('_', ' ')}`, [['adicionar_item', { item_id: produto }]]);
  return sess;
}
