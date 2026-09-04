require('./menu-legado');
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';

const path = require('path');
const PROJECT = path.resolve(__dirname, '..');
const tools = require(`${PROJECT}/src/ai/tools`);
const session = require(`${PROJECT}/src/bot/session`);

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
  console.log(`\x1b[32m   OK: ${mensagem}\x1b[0m`);
}

function checarMetadados(line, esperado, mensagem) {
  checar(
    line.productId === esperado.productId &&
      JSON.stringify(line.removed) === JSON.stringify(esperado.removed) &&
      JSON.stringify(line.added) === JSON.stringify(esperado.added) &&
      JSON.stringify(line.choicesCozinha) === JSON.stringify(esperado.choicesCozinha),
    mensagem
  );
}

const send = async () => {};

(async () => {
  session.clear('15550000002');
  const s = session.get('15550000002');
  s.lang = 'pt';
  await tools.executar('adicionar_item', { item_id: 'x_bacon', quantidade: 2 }, s, send);

  const ambiguo = await tools.executar(
    'personalizar_item',
    { item_id: 'x_bacon', remover: ['cebola'] },
    s,
    send
  );
  checar(
    !/ferramenta desconhecida/i.test(ambiguo.resultado),
    `personalizar_item precisa existir; recebeu: ${ambiguo.resultado}`
  );
  checar(ambiguo.bloqueiaFluxo, 'pergunta quantas unidades quando há duas');
  checar(s.cart.length === 1 && s.cart[0].qty === 2, 'ambiguidade não altera nada');

  await tools.executar(
    'personalizar_item',
    { item_id: 'x_bacon', quantidade: 1, remover: ['cebola'], acrescentar: ['bacon'] },
    s,
    send
  );
  checar(s.cart.length === 2, 'divide uma unidade da linha base');
  const alterada = s.cart.find((line) => line.removed?.includes('cebola'));
  const base = s.cart.find((line) => line.id === 'x_bacon');
  checar(alterada.qty === 1 && alterada.added.includes('bacon'), 'aplica os dois modificadores');
  checar(alterada.productId === 'x_bacon', 'linha alterada preserva o produto base');
  checar(alterada.price > base.price, 'adicional aumenta preço pelo cadastro interno');

  await tools.executar(
    'personalizar_item',
    { item_id: alterada.id, restaurar: ['cebola'], retirar_adicionais: ['bacon'] },
    s,
    send
  );
  checar(s.cart.length === 1 && s.cart[0].qty === 2, 'desfazer reúne linhas idênticas');

  const antesDoProibido = JSON.stringify(s.cart);
  const proibido = await tools.executar(
    'personalizar_item',
    { item_id: 'x_bacon', quantidade: 1, acrescentar: ['abacaxi'] },
    s,
    send
  );
  checar(/nao_acrescentavel|não consegui/i.test(proibido.resultado), 'recusa ingrediente proibido');
  checar(JSON.stringify(s.cart) === antesDoProibido, 'ingrediente proibido não altera o carrinho');

  const excesso = await tools.executar(
    'personalizar_item',
    { item_id: 'x_bacon', quantidade: 3, remover: ['cebola'] },
    s,
    send
  );
  checar(/quantidade/i.test(excesso.resultado), 'recusa mais unidades do que existem');
  checar(JSON.stringify(s.cart) === antesDoProibido, 'quantidade excessiva não altera o carrinho');

  await tools.executar(
    'personalizar_item',
    { item_id: 'x_bacon', quantidade: 1, remover: ['cebola'] },
    s,
    send
  );
  const semCebola = s.cart.find((line) => line.removed?.includes('cebola'));

  const antesDaAmbiguidadeDeVariantes = JSON.stringify(s.cart);
  const variantesAmbiguas = await tools.executar(
    'personalizar_item',
    { item_id: 'x_bacon', quantidade: 1, acrescentar: ['bacon'] },
    s,
    send
  );
  checar(
    variantesAmbiguas.bloqueiaFluxo && /linha|variante|qual/i.test(variantesAmbiguas.resultado),
    'id base com linha base e personalizada orienta a escolher a variante'
  );
  checar(
    JSON.stringify(s.cart) === antesDaAmbiguidadeDeVariantes,
    'id base ambíguo não altera nenhuma variante mesmo com quantidade'
  );

  await tools.executar(
    'personalizar_item',
    { item_id: semCebola.id, acrescentar: ['bacon'] },
    s,
    send
  );
  const preservada = s.cart.find((line) =>
    line.removed?.includes('cebola') && line.added?.includes('bacon')
  );
  checar(Boolean(preservada), 'novo adicional preserva a retirada anterior');

  session.clear('15550000005');
  const antiga = session.get('15550000005');
  antiga.lang = 'pt';
  antiga.cart = [{ id: 'x_bacon', name: 'X-Bacon', qty: 1, price: 14 }];
  await tools.executar(
    'personalizar_item',
    { item_id: 'x_bacon', remover: ['cebola'] },
    antiga,
    send
  );
  checar(
    antiga.cart.length === 1 && antiga.cart[0].productId === 'x_bacon' && antiga.cart[0].removed.includes('cebola'),
    'linha antiga sem productId continua personalizável'
  );

  session.clear('15550000007');
  const dividirLegada = session.get('15550000007');
  dividirLegada.lang = 'pt';
  dividirLegada.cart = [
    { id: 'x_bacon:-cebola+bacon', name: 'X-Bacon legado personalizado', qty: 2, price: 15 },
  ];
  await tools.executar(
    'personalizar_item',
    { item_id: 'x_bacon:-cebola+bacon', quantidade: 1, acrescentar: ['ovo'] },
    dividirLegada,
    send
  );
  const origemLegada = dividirLegada.cart.find((line) => line.id === 'x_bacon:-cebola+bacon');
  const destinoNovo = dividirLegada.cart.find(
    (line) => line.id === 'x_bacon:-cebola+bacon,ovo'
  );
  checar(origemLegada?.qty === 1 && destinoNovo?.qty === 1, 'divide parcialmente a origem legada');
  checarMetadados(
    origemLegada,
    {
      productId: 'x_bacon',
      removed: ['cebola'],
      added: ['bacon'],
      choicesCozinha: ['- sem cebola', '+ bacon'],
    },
    'divisão completa os quatro metadados da origem legada restante'
  );
  checarMetadados(
    destinoNovo,
    {
      productId: 'x_bacon',
      removed: ['cebola'],
      added: ['bacon', 'ovo'],
      choicesCozinha: ['- sem cebola', '+ bacon', '+ ovo'],
    },
    'divisão mantém os quatro metadados coerentes no destino'
  );

  session.clear('15550000008');
  const recomporLegada = session.get('15550000008');
  recomporLegada.lang = 'pt';
  recomporLegada.cart = [
    { id: 'x_bacon', name: 'X-Bacon legado', qty: 1, price: 14 },
    {
      id: 'x_bacon:-cebola+bacon',
      productId: 'x_bacon',
      name: 'X-Bacon personalizado',
      nomeCozinha: 'X-Bacon',
      choicesCozinha: ['- sem cebola', '+ bacon'],
      removed: ['cebola'],
      added: ['bacon'],
      qty: 1,
      price: 15,
    },
  ];
  await tools.executar(
    'personalizar_item',
    {
      item_id: 'x_bacon:-cebola+bacon',
      restaurar: ['cebola'],
      retirar_adicionais: ['bacon'],
    },
    recomporLegada,
    send
  );
  checar(
    recomporLegada.cart.length === 1 && recomporLegada.cart[0].qty === 2,
    'recompõe a personalização no destino legado existente'
  );
  checarMetadados(
    recomporLegada.cart[0],
    { productId: 'x_bacon', removed: [], added: [], choicesCozinha: [] },
    'recomposição completa os quatro metadados do destino legado'
  );

  session.clear('15550000006');
  const adicionarLegada = session.get('15550000006');
  adicionarLegada.lang = 'pt';
  adicionarLegada.cart = [
    { id: 'x_bacon:-cebola+bacon', name: 'X-Bacon legado', qty: 1, price: 15 },
  ];
  await tools.executar(
    'adicionar_item',
    { item_id: 'x_bacon', remover: ['cebola'], acrescentar: ['bacon'] },
    adicionarLegada,
    send
  );
  checar(adicionarLegada.cart[0].qty === 2, 'adicionar_item reúne a linha legada existente');
  checarMetadados(
    adicionarLegada.cart[0],
    {
      productId: 'x_bacon',
      removed: ['cebola'],
      added: ['bacon'],
      choicesCozinha: ['- sem cebola', '+ bacon'],
    },
    'adicionar_item completa os quatro metadados da linha legada'
  );

  console.log('\n\x1b[32mpersonalizartest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
