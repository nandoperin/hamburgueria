const catalog = require('../../services/catalog');
const entrada = require('../../entrada');

class CatalogInputError extends Error {
  constructor(code, products = []) {
    super(code);
    this.name = 'CatalogInputError';
    this.code = code;
    this.products = products.map((value) => entrada.limpar(value, 120));
  }

  toJSON() {
    return { name: this.name, code: this.code, products: this.products };
  }
}

const PUBLIC_ERROR_KEYS = Object.freeze({
  pedido_invalido: 'catalog_error_pedido_invalido',
  leitura_falhou: 'catalog_error_leitura_falhou',
  produto_desconhecido: 'catalog_error_produto_desconhecido',
  produto_ambiguo: 'catalog_error_produto_ambiguo',
  quantidade_invalida: 'catalog_error_quantidade_invalida',
  quantidade_total: 'catalog_error_quantidade_invalida',
  produto_esgotado: 'catalog_error_produto_esgotado',
  origem_invalida: 'catalog_error_pedido_invalido',
  pedido_vazio: 'catalog_error_pedido_invalido',
});

function publicErrorKey(code) {
  return PUBLIC_ERROR_KEYS[code] || 'catalog_error_pedido_invalido';
}

function tokenBase64(token) {
  if (typeof token === 'string' && token.trim()) return token;
  if (Buffer.isBuffer(token) || token instanceof Uint8Array) {
    return Buffer.from(token).toString('base64');
  }
  throw new CatalogInputError('pedido_invalido');
}

function fromMeta(message) {
  const externalOrderId = String(message?.id || '').trim();
  if (!externalOrderId) throw new CatalogInputError('pedido_invalido');
  const entries = message?.order?.product_items;
  if (!Array.isArray(entries)) throw new CatalogInputError('pedido_invalido');
  return {
    source: 'meta',
    externalOrderId,
    items: entries.map((entry) => ({
      productId: String(entry.product_retailer_id || ''),
      quantity: entry.quantity,
      externalProductId: String(entry.product_retailer_id || ''),
    })),
  };
}

async function fromBaileys(sock, orderMessage) {
  const externalOrderId = String(orderMessage?.orderId || '').trim();
  if (!externalOrderId || !sock?.getOrderDetails) {
    throw new CatalogInputError('pedido_invalido');
  }

  let details;
  try {
    details = await sock.getOrderDetails(externalOrderId, tokenBase64(orderMessage.token));
  } catch (_err) {
    throw new CatalogInputError('leitura_falhou');
  }

  const products = Array.isArray(details?.products) ? details.products : [];
  const items = products.map((product) => {
    const resolvido = catalog.resolverNomePt(product?.name);
    if (!resolvido.ok) {
      const code = resolvido.erro === 'ambiguo'
        ? 'produto_ambiguo'
        : 'produto_desconhecido';
      throw new CatalogInputError(code, [product?.name]);
    }
    return {
      productId: resolvido.item.id,
      quantity: product.quantity,
      externalProductId: String(product.id || ''),
    };
  });

  return { source: 'baileys', externalOrderId, items };
}

module.exports = { CatalogInputError, publicErrorKey, fromBaileys, fromMeta };
