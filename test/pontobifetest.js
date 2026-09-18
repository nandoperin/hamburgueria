process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';

const tools = require('../src/ai/tools');
const session = require('../src/bot/session');

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
  console.log(`\x1b[32m   OK: ${mensagem}\x1b[0m`);
}

const send = async () => {};

(async () => {
  session.clear('15550000021');
  const s = session.get('15550000021');
  s.lang = 'pt';

  await tools.executar(
    'adicionar_item',
    { item_id: 'x_burger' },
    s,
    send,
    { textoCliente: 'quero um x burger com bife bem passado' }
  );

  let linha = s.cart[0];
  checar(s.cart.length === 1 && linha.pontoBife === 'bem_passado',
    'bem passado entra no lanche sem pergunta adicional');
  checar(linha.price === 12, 'ponto do bife não altera o preço');
  checar(linha.name.includes('bife bem passado') && linha.choicesCozinha.includes('bife bem passado'),
    'observação aparece no resumo e na comanda');

  await tools.executar(
    'personalizar_item',
    { item_id: linha.id },
    s,
    send,
    { textoCliente: 'na verdade deixa o bife mau passado' }
  );
  linha = s.cart[0];
  checar(linha.pontoBife === 'mal_passado' && linha.choicesCozinha.includes('bife mal passado'),
    'mau passado corrige a mesma unidade sem adicionar outro lanche');

  await tools.executar(
    'personalizar_item',
    { item_id: linha.id },
    s,
    send,
    { textoCliente: 'deixa o bife ao ponto' }
  );
  linha = s.cart[0];
  checar(s.cart.length === 1 && linha.pontoBife === 'ao_ponto',
    'ao ponto também é registrado sem duplicar o produto');
  checar(linha.price === 12 && linha.choicesCozinha.includes('bife ao ponto'),
    'a observação final segue sem custo e pronta para impressão');

  await tools.executar(
    'personalizar_item',
    { item_id: linha.id, acrescentar: ['bacon'] },
    s,
    send,
    { textoCliente: 'coloca bacon nesse lanche' }
  );
  const resumo = require('../src/bot/handlers/order').summaryLines(s.cart, 'pt');
  checar(resumo.includes('bife ao ponto'),
    'resumo preserva o ponto mesmo quando separa o preço do adicional');

  session.clear('15550000022');
  const bebida = session.get('15550000022');
  bebida.lang = 'pt';
  const recusado = await tools.executar(
    'adicionar_item',
    { item_id: 'coca_cola', ponto_bife: 'bem_passado' },
    bebida,
    send
  );
  checar(recusado.bloqueiaFluxo && bebida.cart.length === 0,
    'ponto de bife não pode ser aplicado a produto sem bife');

  // "com bife bem passado" fala do bife que já vem: o modelo que manda
  // acrescentar bife cobraria um bife que o cliente não pediu.
  session.clear('15550000023');
  const semExtra = session.get('15550000023');
  semExtra.lang = 'pt';
  await tools.executar('adicionar_item', { item_id: 'x_burger', acrescentar: ['bife'] }, semExtra, send,
    { textoCliente: 'um x burger com bife bem passado' });
  checar(semExtra.cart[0].price === 12 && !semExtra.cart[0].added.includes('bife') &&
    semExtra.cart[0].pontoBife === 'bem_passado',
  '"com bife bem passado" não cobra bife extra');

  session.clear('15550000024');
  const comExtra = session.get('15550000024');
  comExtra.lang = 'pt';
  await tools.executar('adicionar_item', { item_id: 'x_burger', acrescentar: ['bife'] }, comExtra, send,
    { textoCliente: 'um x burger com bife extra bem passado' });
  checar(comExtra.cart[0].added.includes('bife') && comExtra.cart[0].price > 12,
    'bife extra dito com todas as letras continua sendo cobrado');

  // Dois lanches citados: o ponto dito não pode cair no lanche errado.
  session.clear('15550000025');
  const dois = session.get('15550000025');
  dois.lang = 'pt';
  await tools.executar('adicionar_item', { item_id: 'x_tudo' }, dois, send);
  await tools.executar('adicionar_item', { item_id: 'x_burger' }, dois, send);
  await tools.executar('personalizar_item', { item_id: 'x_tudo', acrescentar: ['bacon'] }, dois, send,
    { textoCliente: 'bacon no x tudo e o x burger bem passado' });
  const xTudo = dois.cart.find((l) => l.productId === 'x_tudo');
  checar(xTudo.added.includes('bacon') && !xTudo.pontoBife,
    'com dois lanches na frase, o X-Tudo recebe o bacon e não o ponto do X-Burger');

  console.log('\n\x1b[32mpontobifetest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});