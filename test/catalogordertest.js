process.env.AI_ENABLED = 'off';
process.env.ADMIN_PHONE = '16175550000';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.SQUARE_ACCESS_TOKEN = 'faketoken';
process.env.SQUARE_LOCATION_ID = 'FAKELOC';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';

const path = require('path');
const PROJECT = path.resolve(__dirname, '..');
const session = require(`${PROJECT}/src/bot/session`);
const notify = require(`${PROJECT}/src/bot/notify`);
const handler = require(`${PROJECT}/src/bot/handlers/catalogorder`);

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
}

const mensagens = [];
const alertas = [];
const send = async (text) => mensagens.push(text);
notify.register(async (_phone, text) => alertas.push(text));

(async () => {
  const telefone = '15550000001';
  session.clear(telefone);
  const s = session.get(telefone);
  s.lang = 'pt';

  const pedido = {
    source: 'baileys',
    externalOrderId: 'ord-1',
    items: [{ productId: 'x_bacon', quantity: 2, externalProductId: 'wa-1' }],
  };

  const aplicado = await handler.handleCartOrder(s, pedido, send);
  checar(aplicado.status === 'applied', 'devolve status aplicado');
  checar(aplicado.session === s, 'devolve a sessão aplicada');
  checar(s.cart[0].qty === 2, 'aplica quantidade');
  checar(s.cart[0].price === 14, 'usa preço interno do X-Bacon');
  checar(s.cart[0].productId === 'x_bacon', 'guarda identidade base');

  const estadoAntesDaRepeticao = s.state;
  const mensagensAntesDaRepeticao = mensagens.length;
  const repetido = await handler.handleCartOrder(s, pedido, send);
  checar(repetido.status === 'duplicate', 'identifica retransmissão');
  checar(s.cart[0].qty === 2, 'retransmissão não duplica');
  checar(s.state === estadoAntesDaRepeticao, 'retransmissão não move o checkout');
  checar(
    mensagens.length === mensagensAntesDaRepeticao + 1,
    'retransmissão responde somente com a confirmação curta'
  );

  const antes = JSON.stringify(s.cart);
  const adulterado = {
    source: 'meta',
    externalOrderId: 'ord-2',
    items: [
      { productId: 'x_bacon', quantity: 1, externalProductId: 'ok' },
      { productId: 'guarana', quantity: 100, externalProductId: 'ruim' },
    ],
  };
  const rejeitado = await handler.handleCartOrder(s, adulterado, send);
  checar(rejeitado.status === 'rejected', 'rejeita quantidade acima de 99');
  checar(JSON.stringify(s.cart) === antes, 'não aplica metade do lote');

  const desconhecido = {
    source: 'meta',
    externalOrderId: 'ord-fantasma-1',
    token: 'TOKEN-SECRETO',
    payload: 'PAYLOAD-SECRETO',
    cliente: 'CLIENTE-SECRETO',
    phone: '15559999999',
    items: [{ productId: 'produto_fantasma', quantity: 1, externalProductId: 'externo-fantasma' }],
  };
  const mensagensAntesDoFantasma = mensagens.length;
  await handler.handleCartOrder(s, desconhecido, send);
  await handler.handleCartOrder(
    s,
    { ...desconhecido, externalOrderId: 'ord-fantasma-2' },
    send
  );
  checar(alertas.length === 1, 'avisa o dono uma vez por erro e produto divergente');
  checar(
    !/TOKEN-SECRETO|PAYLOAD-SECRETO|CLIENTE-SECRETO|15559999999/.test(alertas[0]),
    'alerta não inclui token, payload, cliente ou telefone'
  );
  const respostasFantasma = mensagens.slice(mensagensAntesDoFantasma).join('\n');
  checar(!respostasFantasma.includes('produto_fantasma'), 'Meta não expõe ID interno');
  checar(respostasFantasma.includes('um item do carrinho'), 'Meta usa descrição pública');

  checar(typeof handler.avisarDono === 'function', 'exporta alerta para recusas do adaptador');
  await handler.avisarDono('produto_ambiguo', ['Nome parecido']);
  await handler.avisarDono('produto_ambiguo', ['Nome parecido']);
  checar(alertas.length === 2, 'alerta exportado também deduplica por erro e produto');

  await handler.handleCartOrder(s, {
    source: 'baileys',
    externalOrderId: 'ord-3',
    items: [{ productId: 'guarana', quantity: 1, externalProductId: 'wa-2' }],
  }, send);
  checar(s.cart.some((line) => line.productId === 'guarana'), 'mescla carrinho novo');

  const invalidos = [
    ['quantidade ausente', [{ productId: 'x_bacon', externalProductId: 'a' }]],
    ['quantidade zero', [{ productId: 'x_bacon', quantity: 0, externalProductId: 'b' }]],
    ['quantidade fracionária', [{ productId: 'x_bacon', quantity: 1.5, externalProductId: 'c' }]],
    ['total 201', [
      { productId: 'x_bacon', quantity: 67, externalProductId: 'd1' },
      { productId: 'x_bacon', quantity: 67, externalProductId: 'd2' },
      { productId: 'x_bacon', quantity: 67, externalProductId: 'd3' },
    ]],
    ['produto inexistente', [
      { productId: 'nao_existe', quantity: 1, externalProductId: 'e' },
    ]],
  ];

  for (const [nome, items] of invalidos) {
    const fotografia = JSON.stringify(s.cart);
    const idsAntes = JSON.stringify(s.catalogOrderIds);
    const resultado = await handler.handleCartOrder(s, {
      source: 'meta', externalOrderId: `invalido-${nome}`, items,
    }, send);
    checar(resultado.status === 'rejected', `${nome}: lote recusado`);
    checar(JSON.stringify(s.cart) === fotografia, `${nome}: carrinho intacto`);
    checar(JSON.stringify(s.catalogOrderIds) === idsAntes, `${nome}: ID não é marcado`);
  }

  const cardapio = require(`${PROJECT}/src/services/cardapio`);
  const disponibilidadeOriginal = cardapio.disponivel;
  cardapio.disponivel = (item) => item.id !== 'agua';
  const fotografia = JSON.stringify(s.cart);
  const esgotado = await handler.handleCartOrder(s, {
    source: 'meta',
    externalOrderId: 'invalido-esgotado',
    items: [{ productId: 'agua', quantity: 1, externalProductId: 'agua' }],
  }, send);
  cardapio.disponivel = disponibilidadeOriginal;
  checar(esgotado.status === 'rejected', 'produto esgotado: lote recusado');
  checar(JSON.stringify(s.cart) === fotografia, 'produto esgotado: carrinho intacto');

  const idiomas = [
    ['pt', 'Não consegui ler esse carrinho.'],
    ['en', "I couldn't read this cart."],
    ['es', 'No pude leer este carrito.'],
  ];
  for (const [lang, trecho] of idiomas) {
    s.lang = lang;
    const inicio = mensagens.length;
    const resultado = await handler.handleCartOrder(s, {
      source: 'origem-desconhecida',
      externalOrderId: `origem-${lang}`,
      items: [{ productId: 'x_bacon', quantity: 1, externalProductId: 'x' }],
    }, send);
    checar(resultado.status === 'rejected', `${lang}: origem inválida recusada`);
    checar(mensagens.slice(inicio).join('\n').includes(trecho), `${lang}: recusa traduzida`);
  }

  s.catalogOrderIds = Array.from({ length: 25 }, (_v, i) => `ord-${i + 1}`);
  const reiniciada = session.reset(telefone);
  checar(reiniciada.catalogOrderIds.length === 20, 'reset mantém somente 20 IDs');
  checar(reiniciada.catalogOrderIds[0] === 'ord-6', 'reset mantém os IDs mais recentes');

  console.log('Todos os cenários de carrinho de catálogo passaram.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
