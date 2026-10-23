/**
 * Teto de quantidade por pedido — decisão do dono, 23/10/2026 (auditoria do
 * food truck, 10/2026).
 *
 * Pedido em dinheiro e em Zelle vai para a cozinha antes de o dinheiro ser
 * conferido. Sem teto, um pedido falso de 200 lanches imprimia inteiro. Vale
 * para o WhatsApp e para o site, com os mesmos números:
 *
 *   - até 10 unidades do mesmo item (o item do cardápio — "X Tudo sem
 *     cebola" e "X Tudo" somam juntos);
 *   - até 30 itens no pedido.
 *
 * Pacote da promoção ("3 X Tudo") conta as 3 unidades no total do pedido.
 */
const POR_ITEM = 10;
const POR_PEDIDO = 30;

const itemDaLinha = (linha) => String(linha.productId || linha.id || '').split(':')[0];

function unidades(linha) {
  const item = require('./cardapio').itemById(itemDaLinha(linha));
  return Number(linha.qty || 0) * (Number(item?.bundleQuantity) || 1);
}

/** O que estoura o teto, ou `null` se está tudo dentro. */
function excede(cart) {
  const porItem = new Map();
  let total = 0;
  for (const linha of cart || []) {
    const id = itemDaLinha(linha);
    porItem.set(id, (porItem.get(id) || 0) + Number(linha.qty || 0));
    total += unidades(linha);
  }
  for (const linha of cart || []) {
    if (porItem.get(itemDaLinha(linha)) > POR_ITEM) {
      return { tipo: 'item', linha, quantidade: porItem.get(itemDaLinha(linha)) };
    }
  }
  if (total > POR_PEDIDO) return { tipo: 'pedido', quantidade: total };
  return null;
}

module.exports = { POR_ITEM, POR_PEDIDO, excede };
