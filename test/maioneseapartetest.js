/**
 * Sachê de maionese é item à parte — não acréscimo à procura de um lanche.
 *
 * 17/09, Eduardo: o carrinho do catálogo trouxe um Hot Completo, um macarrão e
 * um sachê de maionese. A regra "todo adicional vai junto de um lanche" fez o
 * bot perguntar em qual deles ia o sachê; ele respondeu "Hot completo" três
 * vezes e "A parte" uma, a IA registrou "à parte" como entrega, e o pedido
 * nunca fechou — o dono assumiu a conversa.
 *
 * Mesma noite, pedido #156: "1 maionese adicional" entrou como sachê E como
 * maionese dentro do X-Bacon. O cliente pagou duas.
 */
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';

const tools = require('../src/ai/tools');
const session = require('../src/bot/session');

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
  console.log(`\x1b[32m   OK: ${mensagem}\x1b[0m`);
}

const send = async () => {};
const produto = (sess, id) => sess.cart.filter((l) => (l.productId || l.id.split(':')[0]) === id);

function nova(phone) {
  session.clear(phone);
  const s = session.get(phone);
  s.lang = 'pt';
  return s;
}

(async () => {
  // ------------------------------------ 1. o carrinho do Eduardo, do catálogo
  const eduardo = nova('15550000031');
  await tools.executar('adicionar_item', { item_id: 'hot_completo' }, eduardo, send);
  await tools.executar('adicionar_item', { item_id: 'macarrao_chapa' }, eduardo, send);
  eduardo.cart.push({
    id: 'sache_maionese', productId: 'sache_maionese', name: 'Sachê de maionese',
    nomeCozinha: 'Sachê de maionese', choicesCozinha: [], removed: [], added: [], qty: 1, price: 1,
  });
  tools.associarAdicionaisAoUnicoAlvo(eduardo);
  checar(tools.perguntaAdicionalPendente(eduardo) === null,
    'com dois lanches no carrinho, o sachê não gera "em qual lanche vai?"');
  checar(produto(eduardo, 'sache_maionese').length === 1,
    'o sachê do catálogo continua no pedido como item à parte');

  // -------------------------------- 2. "a maionese à parte" não é recusado
  const aParte = nova('15550000032');
  await tools.executar('adicionar_item', { item_id: 'hot_completo' }, aParte, send);
  const r = await tools.executar('adicionar_item', { item_id: 'sache_maionese' }, aParte, send,
    { textoCliente: 'e uma maionese a parte' });
  checar(!r.bloqueiaFluxo && produto(aParte, 'sache_maionese').length === 1,
    '"maionese à parte" entra como sachê, sem sermão de "não vendemos à parte"');

  // ------------------------------------- 3. pedido #156: cobrança dupla
  const dupla = nova('15550000033');
  await tools.executar('adicionar_item', { item_id: 'x_bacon' }, dupla, send);
  await tools.executar('adicionar_item', { item_id: 'sache_maionese' }, dupla, send,
    { textoCliente: '1 maione adicional' });
  const noLanche = await tools.executar('personalizar_item', { item_id: 'x_bacon', acrescentar: ['maionese'] },
    dupla, send, { textoCliente: '1 maione adicional' });
  const xBacon = produto(dupla, 'x_bacon')[0];
  checar(noLanche.bloqueiaFluxo && !xBacon.added.includes('maionese'),
    'com o sachê no pedido, a maionese não é cobrada de novo dentro do lanche');

  const dentro = nova('15550000034');
  await tools.executar('adicionar_item', { item_id: 'x_bacon' }, dentro, send);
  await tools.executar('adicionar_item', { item_id: 'sache_maionese' }, dentro, send,
    { textoCliente: 'um sache de maionese' });
  await tools.executar('personalizar_item', { item_id: 'x_bacon', acrescentar: ['maionese'] },
    dentro, send, { textoCliente: 'e maionese extra dentro do lanche tambem' });
  checar(produto(dentro, 'x_bacon')[0].added.includes('maionese'),
    'quem pede maionese dentro do lanche também continua podendo');

  // ------------------------------------ 4. os outros adicionais não mudam
  const bacon = nova('15550000035');
  await tools.executar('adicionar_item', { item_id: 'hot_completo' }, bacon, send);
  const avulso = await tools.executar('adicionar_item', { item_id: 'bacon' }, bacon, send,
    { textoCliente: 'um bacon a parte' });
  checar(avulso.bloqueiaFluxo && produto(bacon, 'bacon').length === 0,
    'bacon à parte continua recusado: só salsicha e sachê vão à parte');

  console.log('\n\x1b[32mmaioneseapartetest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
