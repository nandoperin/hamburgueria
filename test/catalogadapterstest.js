const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const cardapioPath = require.resolve(`${PROJECT}/src/services/cardapio`);
require.cache[cardapioPath] = {
  id: cardapioPath,
  filename: cardapioPath,
  loaded: true,
  exports: {
    allItems: () => [
      { id: 'x_bacon', name: { pt: 'X-Bacon' }, price: 14, available: true },
    ],
    itemsOfCategory: () => [],
  },
};

const {
  fromBaileys,
  fromMeta,
  CatalogInputError,
  publicErrorKey,
} = require(`${PROJECT}/src/bot/catalog/adapters`);

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
}

function checarContrato(order, esperado) {
  checar(JSON.stringify(order) === JSON.stringify(esperado), 'mantem somente o contrato CatalogOrder');
  const serializado = JSON.stringify(order);
  checar(!serializado.includes('price'), 'descarta preco externo');
  checar(!serializado.includes('total'), 'descarta total externo');
  checar(!serializado.includes('currency'), 'descarta moeda externa');
}

(async () => {
  let chamada;
  let nomeDoProduto = 'X-Bacon';
  const sock = {
    getOrderDetails: async (orderId, token) => {
      chamada = { orderId, token };
      return {
        products: [
          { id: 'wa-17', name: nomeDoProduto, quantity: 2, price: 1, currency: 'USD' },
        ],
        price: 1,
        total: 2,
        currency: 'USD',
      };
    },
  };

  const segredoTexto = 'token-que-nao-pode-vazar';
  const segredo = Buffer.from(segredoTexto);
  const baileys = await fromBaileys(sock, { orderId: 'ord-1', token: segredo });
  checar(chamada.orderId === 'ord-1', 'busca o pedido certo');
  checar(chamada.token === segredo.toString('base64'), 'converte token para base64');
  checarContrato(baileys, {
    source: 'baileys',
    externalOrderId: 'ord-1',
    items: [{ productId: 'x_bacon', quantity: 2, externalProductId: 'wa-17' }],
  });
  checar(!JSON.stringify(baileys).includes(segredoTexto), 'retorno nao carrega token');

  const meta = fromMeta({
    id: 'wamid.1',
    order: {
      product_items: [
        { product_retailer_id: 'x_bacon', quantity: 2, item_price: 1, currency: 'USD' },
      ],
      total: 2,
      currency: 'USD',
    },
  });
  checarContrato(meta, {
    source: 'meta',
    externalOrderId: 'wamid.1',
    items: [{ productId: 'x_bacon', quantity: 2, externalProductId: 'x_bacon' }],
  });

  const chavesPublicas = {
    pedido_invalido: 'catalog_error_pedido_invalido',
    leitura_falhou: 'catalog_error_leitura_falhou',
    produto_desconhecido: 'catalog_error_produto_desconhecido',
    produto_ambiguo: 'catalog_error_produto_ambiguo',
    quantidade_invalida: 'catalog_error_quantidade_invalida',
    quantidade_total: 'catalog_error_quantidade_invalida',
    produto_esgotado: 'catalog_error_produto_esgotado',
    origem_invalida: 'catalog_error_pedido_invalido',
    pedido_vazio: 'catalog_error_pedido_invalido',
    erro_interno_qualquer: 'catalog_error_pedido_invalido',
  };
  Object.entries(chavesPublicas).forEach(([code, esperado]) => {
    checar(publicErrorKey(code) === esperado, `reduz ${code} a uma chave publica conhecida`);
  });

  nomeDoProduto = `Produto\u001b sem cadastro ${'x'.repeat(130)}`;
  try {
    await fromBaileys(sock, { orderId: 'ord-2', token: Buffer.from('secreto') });
    throw new Error('nome desconhecido deveria ser recusado');
  } catch (err) {
    checar(err instanceof CatalogInputError, 'usa erro sanitizado');
    checar(err.code === 'produto_desconhecido', 'classifica nome desconhecido');
    checar(!JSON.stringify(err).includes('secreto'), 'erro nao carrega token');
    checar(err.products[0] === `Produto sem cadastro ${'x'.repeat(99)}`, 'limpa e limita o nome exposto');
    checar(JSON.stringify(err) === JSON.stringify({
      name: 'CatalogInputError',
      code: 'produto_desconhecido',
      products: [`Produto sem cadastro ${'x'.repeat(99)}`],
    }), 'serializa somente o erro sanitizado');
  }

  try {
    fromMeta({ order: { product_items: [] } });
    throw new Error('Meta sem id deveria ser recusada');
  } catch (err) {
    checar(err instanceof CatalogInputError && err.code === 'pedido_invalido', 'recusa Meta invalida');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
