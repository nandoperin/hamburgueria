/**
 * Fluxo guiado sem "Quer algo mais?" (pedido do dono, 18/09).
 *
 * Depois dos itens o bot pergunta a entrega; item novo continua entrando em
 * qualquer etapa antes da confirmação. E o carrinho do catálogo segue pelo
 * fluxo guiado com a pergunta fixa — antes o agente antigo perguntava em texto
 * livre, a leitora não sabia o que tinha sido perguntado e o "Não" seguinte
 * ficava sem resposta.
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

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({ upsertCustomer: async (c) => ({ id: 1, ...c }) },
  { get: (alvo, k) => alvo[k] || (async () => null) });

const VAZIA = {
  itens: [], ambiguos: [], correcoes: [], refazer_lista: false, concluiu_itens: false,
  entrega: null, cidade: null, endereco: null, nome: null, pagamento: null, troco: null,
  confirma_resumo: null, pergunta: null, cancelar: false,
};
const item = (produto, qtd, trecho) => ({
  produto, qtd, sem: [], com: [], salsicha: null, ponto_bife: null, maionese_a_parte: false, trecho,
});
let proxima = VAZIA;
let chamadasAoAgente = 0;
const provPath = require.resolve(`${PROJECT}/src/ai/provider`);
const provReal = require(provPath);
require.cache[provPath].exports = {
  ...provReal,
  habilitada: () => true, getProviderName: () => 'mistral', getModelo: () => 'mistral-small-latest',
  get: () => ({
    extrair: async () => ({ texto: JSON.stringify({ ...VAZIA, ...proxima }), concluida: true, uso: { tokensIn: 1, tokensOut: 1 } }),
    conversar: async () => { chamadasAoAgente += 1; throw new Error('o agente antigo não deveria ser chamado'); },
  }),
};

const router = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}
async function falar(tel, texto, leitura, opcoes = {}) {
  proxima = { ...VAZIA, ...leitura };
  const saidas = [];
  await router.route(tel, texto, async (t) => saidas.push(t), opcoes);
  return saidas.join('\n---\n');
}

(async () => {
  // Texto: itens → direto para entrega ou retirada.
  const TEL = '15557790300';
  let r = await falar(TEL, 'boa noite\n1 xtudo', { itens: [item('x_tudo', 1, '1 xtudo')] });
  checar(!/algo mais/i.test(r) && /Entrega ou retirada\?/.test(r), 'depois dos itens pergunta entrega, sem "Quer algo mais?"');

  r = await falar(TEL, 'retirada e uma coca', { entrega: 'retirada', itens: [item('coca_cola', 1, 'uma coca')] });
  const s = session.get(TEL);
  checar(s.orderType === 'pickup' && s.cart.some((l) => l.productId === 'coca_cola'),
    'item novo no meio da coleta continua entrando');
  checar(!/algo mais/i.test(r), 'e nada de "Quer algo mais?" depois');

  // Catálogo: o fluxo guiado responde, com a pergunta fixa.
  const TEL2 = '15557790301';
  await falar(TEL2, 'À parte', {});
  const saidas = [];
  await router.routeOrder(TEL2, {
    source: 'meta', externalOrderId: 'guiado-catalogo-1',
    items: [{ productId: 'x_tudo', quantity: 2, externalProductId: 'x_tudo' }],
  }, async (t) => saidas.push(t));
  const s2 = session.get(TEL2);
  checar(/Anotei/.test(saidas.join('\n')) && /Entrega ou retirada\?/.test(saidas.join('\n')),
    'carrinho do catálogo: "Anotei" e a pergunta de entrega');
  checar(s2.state === 'ORDER' && s2.guiado?.ultimaPergunta === 'Entrega ou retirada?',
    'estado ORDER e a leitora sabe o que foi perguntado');

  r = await falar(TEL2, 'retirada', { entrega: 'retirada' });
  checar(session.get(TEL2).orderType === 'pickup', '"retirada" depois do catálogo é entendido');

  // Cliente real, 18/09 14h04: "Entrego em 8 wislow st Everett?" → "Sim" →
  // a mesma pergunta em loop. A leitora devolve o formulário vazio para "Sim".
  for (const [n, resposta] of [[20, 'Sim'], [21, 'Já falei que sim'], [22, 'pode ser']]) {
    const tel = `155577903${n}`;
    await falar(tel, '1 xtudo', { itens: [item('x_tudo', 1, '1 xtudo')] });
    Object.assign(session.get(tel), { name: 'Cliente', lastAddress: '8 wislow st', lastCityId: 'everett' });
    r = await falar(tel, 'Entrega', { entrega: 'entrega' });
    checar(/Entrego em 8 wislow st/.test(r), 'pergunta o endereço salvo');
    r = await falar(tel, resposta, {});
    const s = session.get(tel);
    checar(s.address === '8 wislow st' && s.city?.id === 'everett' && !/Entrego em/.test(r),
      `"${resposta}" confirma o endereço salvo e segue (sem repetir a pergunta)`);
  }
  const TELN = '15557790323';
  await falar(TELN, '1 xtudo', { itens: [item('x_tudo', 1, '1 xtudo')] });
  Object.assign(session.get(TELN), { name: 'Cliente', lastAddress: '8 wislow st', lastCityId: 'everett' });
  await falar(TELN, 'Entrega', { entrega: 'entrega' });
  r = await falar(TELN, 'Não, outro endereço', {});
  checar(!session.get(TELN).address && !/Entrego em/.test(r), '"não, outro endereço" pede o endereço novo');

  // Salsicha junto ou à parte: resposta curta é do código, não da leitora
  // (teste do dono de 18/09: "a parte" sem crase não era aceito).
  const TEL3 = '15557790302';
  r = await falar(TEL3, 'x burger com salsicha', {
    itens: [{ ...item('x_burger', 1, 'x burger com salsicha'), com: ['salsicha'] }] });
  checar(/à parte ou junto/.test(r), 'pergunta se a salsicha vai junto ou à parte');
  // Se a resposta fosse para a leitora, ela leria uma salsicha avulsa a mais.
  r = await falar(TEL3, 'a parte', { itens: [item('salsicha', 1, 'a parte')] });
  const s3 = session.get(TEL3);
  checar(s3.cart[0].preparoSalsicha?.modo === 'a_parte' && !s3.cart.some((l) => l.productId === 'salsicha'),
    '"a parte" sem crase registra o preparo, sem passar pela leitora');

  // Conversa real de +1 781-502-2706 (18/09), com as leituras do log.
  const correcaoLog = (extra) => ({ acao: 'alterar', linha: 'x_tudo:-maionese', qtd: null, sem: ['maionese'], com: [],
    ponto_bife: null, ponto_bacon: null, trecho: '', ...extra });
  const xTudos = (tel) => session.get(tel).cart.filter((l) => l.productId === 'x_tudo');
  const semMaio = (tel) => xTudos(tel).filter((l) => l.removed.includes('maionese')).reduce((t, l) => t + l.qty, 0);
  const total = (tel) => xTudos(tel).reduce((t, l) => t + l.qty, 0);

  const TEL4 = '15557790303';
  await falar(TEL4, 'Queria 2 x tudo sem maionese', {
    itens: [{ ...item('x_tudo', 2, '2 x tudo sem maionese'), sem: ['maionese'] }] });
  checar(total(TEL4) === 2 && semMaio(TEL4) === 2, '2 X Tudo sem maionese');
  checar(/X Tudo \(sem maionese\)/.test(session.get(TEL4).cart[0].name) &&
    session.get(TEL4).cart[0].choicesCozinha.includes('- sem maionese'), 'resumo e comanda dizem "sem maionese", não "sachê"');

  await falar(TEL4, 'Apenas 1 é sem maionese', { correcoes: [correcaoLog({ trecho: 'Apenas 1 é sem maionese' })] });
  checar(total(TEL4) === 2 && semMaio(TEL4) === 1, '"Apenas 1 é sem maionese": 1 sem e 1 normal, sem lanche a mais');

  const antes = JSON.stringify(session.get(TEL4).cart);
  r = await falar(TEL4, 'Está errado', { correcoes: [correcaoLog({ qtd: 2, sem: [], com: ['maionese'], trecho: 'Está errado' })] });
  checar(/O que está errado/.test(r) && JSON.stringify(session.get(TEL4).cart) === antes,
    '"Está errado": pergunta o que corrigir e não mexe no carrinho');

  const TEL5 = '15557790304';
  await falar(TEL5, 'Queria 2 x tudo sem maionese', {
    itens: [{ ...item('x_tudo', 2, '2 x tudo sem maionese'), sem: ['maionese'] }] });
  await falar(TEL5, '1 x tudo sem maionese e o outro normal', {
    itens: [{ ...item('x_tudo', 1, 'o outro normal'), sem: ['maionese'] }],
    correcoes: [correcaoLog({ trecho: '1 x tudo sem maionese e o outro normal' })] });
  checar(total(TEL5) === 2 && semMaio(TEL5) === 1, '"1 x tudo sem maionese e o outro normal": 2 no total, não 3');

  // Maionese (regra do dono, 18/09): add/extra/à parte = sachê $1, quantos
  // quiser, sem perguntar o lanche; "sem maionese" só tira.
  const saches = (tel) => session.get(tel).cart.filter((l) => l.productId === 'sache_maionese').reduce((t, l) => t + l.qty, 0);
  const TEL6 = '15557790305';
  await falar(TEL6, 'Quero um xtudo sem maionese e outro normal', { itens: [
    { ...item('x_tudo', 1, 'um xtudo sem maionese'), sem: ['maionese'] }, item('x_tudo', 1, 'outro normal')] });
  checar(saches(TEL6) === 0, '"sem maionese" não cobra nada');
  r = await falar(TEL6, 'Add maionese', {});
  checar(saches(TEL6) === 1 && !/Em qual lanche/.test(r), '"Add maionese" que a leitora não leu: 1 sachê, sem perguntar o lanche');
  await falar(TEL6, 'mais 2 maionese', {});
  checar(saches(TEL6) === 3, '"mais 2 maionese": mais 2 sachês');

  const TEL7 = '15557790306';
  await falar(TEL7, 'x tudo com maionese extra', { itens: [{ ...item('x_tudo', 1, 'x tudo com maionese extra'), com: ['maionese'] }] });
  const c7 = session.get(TEL7).cart;
  checar(saches(TEL7) === 1 && !c7.find((l) => l.productId === 'x_tudo').added.includes('maionese'),
    'maionese extra no lanche vira 1 sachê, não ingrediente');
  const TEL8 = '15557790307';
  await falar(TEL8, 'x tudo com 2 sache de maionese', { itens: [item('x_tudo', 1, 'x tudo'), item('sache_maionese', 2, '2 sache de maionese')] });
  checar(saches(TEL8) === 2, 'sachê lido pela leitora não é cobrado em dobro');

  // Prova de 18/09: as duas IAs leram "um maionese a oarte" como alteração de
  // lanche e o bot perguntava "Em qual item". Agora é 1 sachê, sem pergunta.
  const TEL9 = '15557790308';
  await falar(TEL9, 'x tudo e x egg bacon', { itens: [item('x_tudo', 1, 'x tudo'), item('xeggbacon', 1, 'x egg bacon')] });
  r = await falar(TEL9, 'Sao 2 e um maionese a oarte', { correcoes: [
    { acao: 'alterar', linha: 'x_tudo', qtd: null, sem: [], com: ['maionese'], ponto_bife: null, ponto_bacon: null, trecho: 'um maionese a oarte' }] });
  checar(saches(TEL9) === 1 && !/Em qual item/.test(r), '"um maionese a oarte": 1 sachê, sem perguntar o lanche');
  // A Mistral pôs 2 sachês em "Add maionese" com 2 lanches: sem número, é 1.
  const TEL10 = '15557790309';
  await falar(TEL10, '2 x tudo', { itens: [item('x_tudo', 2, '2 x tudo')] });
  await falar(TEL10, 'Add maionese', { itens: [item('sache_maionese', 2, 'Add maionese')] });
  checar(saches(TEL10) === 1, '"Add maionese" sem número é 1 sachê');

  // "Quero 3 xtudo 2 sem maionese" (dono, 18/09): a DeepSeek às vezes lê só os
  // 2 sem maionese. O resto do total é normal; nada de sachê.
  for (const [n, itens] of [
    [11, [{ ...item('x_tudo', 2, '3 xtudo 2 sem maionese'), sem: ['maionese'] }]],
    [12, [{ ...item('x_tudo', 2, '2 sem maionese'), sem: ['maionese'] }, item('x_tudo', 1, '3 xtudo')]],
  ]) {
    const tel = `155577903${n}`;
    r = await falar(tel, 'Quero 3 xtudo 2 sem maionese', { itens });
    checar(total(tel) === 3 && semMaio(tel) === 2 && saches(tel) === 0 && !/Confere/.test(r),
      `"3 xtudo 2 sem maionese" (leitura ${n - 10}): 2 sem maionese, 1 normal, sem cobrar`);
  }

  // Auditoria de 18/09: com o fluxo guiado ligado, nenhum caminho usa o agente
  // antigo — pedido esperando pagamento ("Pedido #160" inventado, JSON de
  // ferramenta ao cliente) e "0" para recomeçar eram os que ainda usavam.
  const TELP = '15557790330';
  await falar(TELP, '1 xtudo', { itens: [item('x_tudo', 1, '1 xtudo')] });
  Object.assign(session.get(TELP), { state: 'PAYMENT_PENDING', orderId: 159, paymentMethod: 'zelle', orderType: 'delivery' });
  r = await falar(TELP, '1 x tudo sem maionese e com cebola\nE 1 x Egg bacon calabresa', {});
  checar(/159/.test(r) && !/Pedido #160/.test(r) && !/"name"/.test(r), 'pedido esperando pagamento: resposta fixa, nada inventado');
  r = await falar(TELP, '?', {});
  checar(/159/.test(r), '"?" com pedido pendente: lembra o pedido #159');
  const TELR = '15557790331';
  await falar(TELR, '1 xtudo', { itens: [item('x_tudo', 1, '1 xtudo')] });
  r = await falar(TELR, '0', {});
  checar(/recomeçar do zero/.test(r) && !/cancelado/.test(r) && !session.get(TELR).cart.length, '"0" recomeça com resposta fixa');
  // "0" depois do pedido fechado (dono, 18/09): dizia "Pedido cancelado", mas
  // o #162 seguiu para a cozinha — nada foi cancelado.
  const TELZ = '15557790332';
  await falar(TELZ, '1 xtudo', { itens: [item('x_tudo', 1, '1 xtudo')] });
  Object.assign(session.get(TELZ), { state: 'ORDER_COMPLETE', orderId: 162, paymentMethod: 'zelle', orderType: 'pickup' });
  r = await falar(TELZ, 'xtudo sem cebola', {});
  checar(/162/.test(r) && /digite \*0\*/.test(r), 'mensagem depois do pedido fechado: lembra o #162');
  r = await falar(TELZ, '0', {});
  checar(/pedido novo/.test(r) && /162/.test(r) && /continua valendo/.test(r) && !/cancelado/.test(r) &&
    !session.get(TELZ).cart.length, '"0" depois do pedido fechado: pedido novo, o #162 continua valendo');
  // Resposta citando uma mensagem (dono, 18/09): a citação aponta o item e a
  // quantidade — o bot perguntava "Em qual item" de novo. Leituras reais da
  // DeepSeek com a citação.
  const TELC1 = '15557790340';
  await falar(TELC1, '2 x tudo', { itens: [item('x_tudo', 2, '2 x tudo')] });
  r = await falar(TELC1, 'tira um', { correcoes: [{ acao: 'quantidade', linha: 'x_tudo', qtd: 1, sem: [], com: [],
    ponto_bife: null, ponto_bacon: null, trecho: 'tira um' }] }, { citada: '2 x tudo' });
  checar(total(TELC1) === 1 && !/Em qual item/.test(r), 'citando "2 x tudo", "tira um" deixa 1, sem perguntar qual');
  const TELC2 = '15557790341';
  await falar(TELC2, 'x tudo e x burger', { itens: [item('x_tudo', 1, 'x tudo'), item('x_burger', 1, 'x burger')] });
  r = await falar(TELC2, 'esse sem tomate', { correcoes: [{ acao: 'alterar', linha: 'x_burger', qtd: null, sem: ['tomate'], com: [],
    ponto_bife: null, ponto_bacon: null, trecho: 'esse sem tomate' }] }, { citada: '• X Burger x1 — $12.00' });
  const xbC = session.get(TELC2).cart.find((l) => l.productId === 'x_burger');
  checar(xbC?.removed.includes('tomate') && !/Em qual item/.test(r), 'citando a linha do X Burger, "esse sem tomate" vai nele');
  const TELC3 = '15557790342';
  await falar(TELC3, '1 x tudo', { itens: [item('x_tudo', 1, '1 x tudo')] });
  await falar(TELC3, 'completo', { itens: [item('hot_completo', null, 'completo')] },
    { citada: 'Qual você quer em "2 hot dog"? Temos: Hot plain, Hot simples, Hot Duplo, Hot completo, Hot especial, Hot tudo.' });
  const hc = session.get(TELC3).cart.find((l) => l.productId === 'hot_completo');
  checar(hc?.qty === 2, 'citando "Qual você quer em 2 hot dog?", "completo" são 2');

  // Lanche do catálogo citado de novo é detalhe dele, não item novo (regra do
  // dono, 19/09 — #182: o X Tudão do catálogo virou 3 no carrinho).
  const tools = require(`${PROJECT}/src/ai/tools`);
  const doCatalogo = (tel, linhas) => {
    const sc = session.get(tel);
    Object.assign(sc, { lang: 'pt', state: 'ORDER', greeted: true });
    for (const [id, q] of linhas) tools.carrinho.adicionar(sc, { item_id: id, quantidade: q });
    for (const l of sc.cart) l.doCatalogo = true;
    return sc;
  };
  const qtdDe = (tel, id) => session.get(tel).cart.filter((l) => l.productId === id).reduce((t, l) => t + l.qty, 0);
  const TELK = '15557790350';
  doCatalogo(TELK, [['x_tudao', 1], ['guarana', 1]]);
  await falar(TELK, 'Xtudao com acréscimo de banana e sem alface e tomate', { itens: [{ ...item('x_tudao', null,
    'Xtudao com acréscimo de banana e sem alface e tomate'), sem: ['alface', 'tomate'], com: ['banana'] }] });
  const xt = session.get(TELK).cart.filter((l) => l.productId === 'x_tudao');
  checar(xt.length === 1 && xt[0].qty === 1 && xt[0].removed.includes('alface') && xt[0].removed.includes('tomate'),
    'catálogo: "Xtudao sem alface e tomate" altera o X Tudão, não soma outro');
  checar(xt[0].doCatalogo, 'a linha alterada continua marcada como do catálogo');
  await falar(TELK, '1xtudao sem alface e sem tomate e 1 guaraná', { itens: [
    { ...item('x_tudao', 1, '1xtudao sem alface e sem tomate'), sem: ['alface', 'tomate'] }, item('guarana', 1, '1 guaraná')] });
  checar(qtdDe(TELK, 'x_tudao') === 1 && qtdDe(TELK, 'guarana') === 1, 'catálogo: repetir o pedido não soma nada');
  await falar(TELK, 'Você entendeu que é só 1 xtudao ne ?', { pergunta: 'outra' });
  checar(qtdDe(TELK, 'x_tudao') === 1, 'catálogo: "é só 1 xtudao né?" não soma outro');
  await falar(TELK, 'Mais 1 guaraná', { itens: [item('guarana', 1, 'Mais 1 guaraná')] });
  checar(qtdDe(TELK, 'guarana') === 2, 'catálogo: "Mais 1 guaraná" soma');
  const TELK2 = '15557790351';
  doCatalogo(TELK2, [['x_tudo', 2]]);
  await falar(TELK2, '1 xtudo sem tomate', { itens: [{ ...item('x_tudo', 1, '1 xtudo sem tomate'), sem: ['tomate'] }] });
  const xt2 = session.get(TELK2).cart.filter((l) => l.productId === 'x_tudo');
  checar(qtdDe(TELK2, 'x_tudo') === 2 && xt2.some((l) => l.qty === 1 && l.removed.includes('tomate')) &&
    xt2.some((l) => l.qty === 1 && !l.removed.length), 'catálogo com 2: "1 xtudo sem tomate" é um dos dois');
  await falar(TELK2, 'outro xtudo', { itens: [item('x_tudo', 1, 'outro xtudo')] });
  checar(qtdDe(TELK2, 'x_tudo') === 3, 'catálogo: "outro xtudo" soma');

  // Produto desligado no painel (dono, 19/09): "Quero um hot plain" virava
  // "Qual você quer? X Burger, Hamburgão..." — leitura real do log.
  const hotPlain = menuProducao.categories.flatMap((c) => c.items).find((i) => i.id === 'hot_plain');
  hotPlain.available = false;
  const TELE = '15557790360';
  const lanches16 = ['x_burger', 'hamburgao', 'x_egg_burger', 'x_salada', 'x_egg_salada', 'egg_bacon', 'x_calabresa_bacon',
    'x_tudo', 'x_tudao', 'hamburger', 'eggburger', 'xbacon', 'xeggbacon', 'bacon_burger', 'xcalabresa', 'macarrao_chapa'];
  r = await falar(TELE, 'Ola\nQuero um hot plain', { ambiguos: [{ trecho: 'um hot plain', qtd: 1, opcoes: lanches16 }] });
  checar(/Hot plain\* sem estoque hoje\. Esgotado!/.test(r) && !/Qual você quer/.test(r) && !session.get(TELE).cart.length,
    'produto desligado: "sem estoque hoje. Esgotado!", sem lista aleatória, nada no carrinho');
  const TELE2 = '15557790361';
  r = await falar(TELE2, '1 xtudo\n1 hot plain', { itens: [item('x_tudo', 1, '1 xtudo'), item('hot_simples', 1, '1 hot plain')] });
  checar(qtdDe(TELE2, 'x_tudo') === 1 && !qtdDe(TELE2, 'hot_simples') && /sem estoque hoje/.test(r),
    'produto desligado junto com outro: o outro entra, o chute da leitora (Hot simples) não');
  // Numa linha só (teste do dono, 19/09 01:45): o X Tudo sumia junto.
  const TELE3 = '15557790362';
  r = await falar(TELE3, 'ola\nquero um xtudo e hot plain', { itens: [item('x_tudo', null, 'um xtudo')],
    ambiguos: [{ trecho: 'hot plain', qtd: null, opcoes: lanches16 }] });
  checar(qtdDe(TELE3, 'x_tudo') === 1 && /sem estoque hoje/.test(r) && !/Qual você quer/.test(r),
    'na mesma linha: o X Tudo entra, o Hot plain avisa sem estoque');
  // A leitura real trouxe X Tudão para "um xtudo": o que acontece com ela.
  const TELE4 = '15557790363';
  r = await falar(TELE4, 'ola\nquero um xtudo e hot plain', { itens: [item('x_tudao', null, 'um xtudo')],
    ambiguos: [{ trecho: 'hot plain', qtd: null, opcoes: lanches16 }] });
  checar(qtdDe(TELE4, 'x_tudo') === 1 && !qtdDe(TELE4, 'x_tudao') && /sem estoque hoje/.test(r),
    'leitura real do log (X Tudão para "um xtudo"): entra o X Tudo, o Hot plain avisa');
  hotPlain.available = true;

  checar(chamadasAoAgente === 0, `o agente antigo não foi chamado nenhuma vez (${chamadasAoAgente})`);

  console.log('\n\x1b[32mguiadosemmaistest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
