const cardapio = require('../services/cardapio');
const modifiers = require('../services/modifiers');
const session = require('../bot/session');
const order = require('../bot/handlers/order');
const log = require('../log');

/**
 * As ferramentas que o modelo pode chamar durante a conversa.
 *
 * Cada uma é a **porta** entre o que o modelo pediu e o que o sistema aceita:
 * o modelo sugere ids e quantidades, mas quem confere disponibilidade, calcula
 * preço e monta o item do carrinho é o código, lendo os mesmos services que o
 * fluxo numerado usa (`cardapio`, `modifiers`, `order`). Assim o carrinho, a
 * comanda e o resumo ficam idênticos, tenha o pedido vindo da conversa ou dos
 * botões.
 *
 * Preço nunca sai daqui para o modelo decidir — sai do `menu.json` e do
 * `ingredientes.json`. O modelo pode falar de valor para conversar, mas o total
 * que vale é o que estas funções calculam.
 */

// ------------------------------------------------------- esquema das ferramentas

/**
 * Declaração das ferramentas no formato que `ai/provider.js` repassa a cada
 * provedor. `input_schema` é JSON Schema — o mesmo shape que Claude, OpenAI e
 * Mistral entendem (o adaptador de cada um converte).
 */
const SCHEMA = [
  {
    name: 'adicionar_item',
    description:
      'Adiciona um item ao carrinho do cliente. Use o id do item do cardápio. ' +
      'Para personalizar, passe os ids de ingredientes a remover (grátis) ou ' +
      'acrescentar (com preço). Confirme o item e o preço ao cliente depois.',
    input_schema: {
      type: 'object',
      properties: {
        item_id: {
          type: 'string',
          description: 'Id do item no cardápio, ex: x_bacon, batata_frita, coca_cola',
        },
        quantidade: {
          type: 'integer',
          description: 'Quantas unidades. Padrão 1.',
          minimum: 1,
        },
        remover: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids de ingredientes a remover (sempre grátis), ex: ["cebola","tomate"]',
        },
        acrescentar: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids de ingredientes a acrescentar (com preço), ex: ["bacon","ovo"]',
        },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'remover_item',
    description: 'Remove uma unidade de um item do carrinho pelo id do item.',
    input_schema: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'Id do item a remover do carrinho' },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'ver_carrinho',
    description: 'Mostra o que está no carrinho do cliente e o subtotal atual.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'finalizar_pedido',
    description:
      'Fecha o pedido e inicia o checkout (pergunta entrega/retirada, endereço, ' +
      'nome e depois pagamento). Use quando o cliente disser que terminou.',
    input_schema: { type: 'object', properties: {} },
  },
];

// ---------------------------------------------------------------- execução

/**
 * Executa uma chamada de ferramenta e devolve um resultado textual para o
 * modelo continuar a conversa. Nunca lança: erro vira texto que o modelo lê e
 * reformula com o cliente.
 *
 * `send` é passado adiante só para `finalizar_pedido`, que entrega o carrinho ao
 * fluxo de checkout existente (ele mesmo fala com o cliente pelos balões de
 * sempre). As demais ferramentas devolvem texto e deixam o modelo responder.
 *
 * @returns {Promise<{resultado: string, entregouAoFluxo?: boolean}>}
 */
async function executar(nome, args, sess, send) {
  try {
    switch (nome) {
      case 'adicionar_item':
        return { resultado: adicionar(sess, args) };
      case 'remover_item':
        return { resultado: remover(sess, args) };
      case 'ver_carrinho':
        return { resultado: verCarrinho(sess) };
      case 'finalizar_pedido':
        return await finalizar(sess, send);
      default:
        return { resultado: `ferramenta desconhecida: ${nome}` };
    }
  } catch (err) {
    log.error({ evt: 'ia_tool', nome, err }, 'falha ao executar ferramenta');
    return { resultado: `erro ao executar ${nome}: ${err.message}` };
  }
}

// --------------------------------------------------------- adicionar_item

function adicionar(sess, { item_id, quantidade = 1, remover = [], acrescentar = [] }) {
  const lang = sess.lang || 'pt';
  const item = cardapio.itemById(item_id);

  if (!item) return `Item "${item_id}" não existe no cardápio.`;
  if (!cardapio.disponivel(item)) {
    return `${cardapio.nome(item, lang)} está indisponível agora.`;
  }

  // A porta dos modificadores: valida contra a lista DAQUELE item e devolve o
  // preço extra. Recusa em vez de corrigir — o modelo relê o erro e ajusta.
  const val = modifiers.validar(item, { remover, acrescentar });
  if (!val.ok) {
    return `Não consegui personalizar assim (${val.erro}${
      val.detalhe ? ': ' + val.detalhe.join(', ') : ''
    }). Ofereça só o que o item permite.`;
  }

  const qty = Math.max(1, Math.min(quantidade, 20));
  const precoUnit = item.price + val.extra;
  const cartId = modifiers.cartId(item, { removed: val.removed, added: val.added });
  const rotulo = modifiers.rotulo(item, { removed: val.removed, added: val.added }, lang);

  const existing = sess.cart.find((i) => i.id === cartId);
  if (existing) {
    existing.qty += qty;
  } else {
    sess.cart.push({
      id: cartId,
      name: rotulo,
      nomeCozinha: cardapio.nomeCozinha(item),
      // A comanda lista estas sub-linhas sob o item (mesmo canal dos combos).
      choicesCozinha: modifiers.linhasCozinha({ removed: val.removed, added: val.added }),
      qty,
      price: precoUnit,
    });
  }

  // Sai do estado inicial para o fluxo saber que há carrinho em montagem.
  if (sess.state !== 'ORDER') sess.state = 'ORDER';

  const subtotal = session.getSubtotal(sess);
  return `Adicionado: ${qty}x ${rotulo} ($${precoUnit.toFixed(2)} cada). Subtotal do carrinho: $${subtotal.toFixed(2)}.`;
}

// ----------------------------------------------------------- remover_item

function remover(sess, { item_id }) {
  const antes = sess.cart.length;
  const removeu = session.removeItem(sess, item_id);
  if (!removeu) return `Não achei "${item_id}" no carrinho.`;
  const subtotal = session.getSubtotal(sess);
  const agora = sess.cart.length;
  return `Removido. ${agora === 0 ? 'Carrinho vazio.' : `Subtotal: $${subtotal.toFixed(2)}.`}${
    antes !== agora ? '' : ''
  }`;
}

// ------------------------------------------------------------ ver_carrinho

function verCarrinho(sess) {
  if (!sess.cart.length) return 'O carrinho está vazio.';
  const linhas = sess.cart
    .map((i) => `- ${i.qty}x ${i.name} ($${(i.price * i.qty).toFixed(2)})`)
    .join('\n');
  const subtotal = session.getSubtotal(sess);
  return `Carrinho:\n${linhas}\nSubtotal: $${subtotal.toFixed(2)}.`;
}

// -------------------------------------------------------- finalizar_pedido

/**
 * Entrega o carrinho ao checkout já existente (`order.startCheckout`), que
 * pergunta entrega/retirada, endereço, nome e emite o pagamento Zelle pelos
 * balões de sempre. A partir daqui a máquina de estados assume — o agente sai
 * de cena até o próximo "oi".
 */
async function finalizar(sess, send) {
  if (!sess.cart.length) {
    return { resultado: 'O carrinho está vazio — não há o que finalizar.' };
  }
  await order.startCheckout(sess, send);
  return {
    resultado: 'Checkout iniciado. O fluxo de pagamento assumiu a conversa.',
    entregouAoFluxo: true,
  };
}

module.exports = { SCHEMA, executar };
