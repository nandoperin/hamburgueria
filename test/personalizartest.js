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

  console.log('\n\x1b[32mpersonalizartest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
