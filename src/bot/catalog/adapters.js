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

function safeCatalogCode(code, fallback = 'pedido_invalido') {
  return Object.prototype.hasOwnProperty.call(PUBLIC_ERROR_KEYS, code) ? code : fallback;
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

/** O que o WhatsApp respondeu quando recusou ler o carrinho, curto para o log. */
function causaDaFalha(err, orderMessage) {
  let token = '';
  try { token = orderMessage?.token ? tokenBase64(orderMessage.token) : ''; } catch (_e) { token = ''; }
  // O token do carrinho nunca vai para o log, nem se o WhatsApp devolvê-lo.
  const semToken = (s) => (token ? s.split(token).join('[token]') : s);
  const curto = (v) => (v == null ? null : semToken(String(v)).slice(0, 300));
  let dados = null;
  try { dados = curto(JSON.stringify(err?.data ?? null)); } catch (_e) { dados = null; }
  return {
    erro: curto(err?.message),
    status: err?.output?.statusCode ?? err?.status ?? null,
    dados,
    temToken: Boolean(orderMessage?.token),
    itensNaMensagem: orderMessage?.itemCount ?? null,
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
  } catch (err) {
    // 08/10: todo carrinho passou a falhar aqui e o log só dizia
    // "leitura_falhou" — o motivo do WhatsApp era descartado. Agora vai junto,
    // só para o log; o cliente continua recebendo a mesma mensagem.
    const falha = new CatalogInputError('leitura_falhou');
    falha.causa = causaDaFalha(err, orderMessage);
    throw falha;
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

module.exports = { CatalogInputError, publicErrorKey, safeCatalogCode, fromBaileys, fromMeta };
