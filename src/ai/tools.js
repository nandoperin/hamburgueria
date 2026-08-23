const cardapio = require('../services/cardapio');
const delivery = require('../services/delivery');
const entrada = require('../entrada');
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
    name: 'definir_entrega',
    description:
      'Registra se o pedido é entrega ou retirada no balcão. Chame assim que o ' +
      'cliente disser — não espere o fim do pedido.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: {
          type: 'string',
          enum: ['delivery', 'pickup'],
          description: 'delivery = entrega no endereço; pickup = retirada no balcão',
        },
      },
      required: ['tipo'],
    },
  },
  {
    name: 'definir_cidade',
    description:
      'Registra a cidade da entrega e devolve a taxa. SEMPRE chame antes de ' +
      'confirmar que entregamos em algum lugar — só esta ferramenta sabe quais ' +
      'cidades são atendidas e quanto custa cada uma. Se ela disser que não ' +
      'atendemos, diga isso ao cliente e ofereça a retirada; nunca prometa ' +
      'entrega por conta própria. Passe o nome da cidade já corrigido ' +
      '(ex: o cliente escreveu "everet" → passe "Everett").',
    input_schema: {
      type: 'object',
      properties: {
        cidade: { type: 'string', description: 'Nome da cidade, ex: Everett, Chelsea' },
      },
      required: ['cidade'],
    },
  },
  {
    name: 'definir_endereco',
    description:
      'Registra a rua e o número da entrega. Use depois de a cidade ter sido ' +
      'aceita por definir_cidade.',
    input_schema: {
      type: 'object',
      properties: {
        endereco: {
          type: 'string',
          // Sem endereço de exemplo: o que o cliente escreveu, e nada mais.
          // Exemplo concreto aqui é dado plausível dentro do prompt, e modelo
          // pequeno preenche lacuna com o que tem à mão — ver o comentário
          // sobre nomes próprios em `agente.js#systemPrompt`.
          description:
            'Rua, número e complemento, exatamente como o cliente escreveu. ' +
            'Nunca invente nem complete o que ele não disse.',
        },
      },
      required: ['endereco'],
    },
  },
  {
    name: 'definir_cadastro',
    description:
      'Registra o nome do cliente (obrigatório) e o email (opcional, só se ele ' +
      'oferecer — não insista).',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome do cliente' },
        email: { type: 'string', description: 'Email, se o cliente quiser dar' },
      },
      required: ['nome'],
    },
  },
  {
    name: 'finalizar_pedido',
    description:
      'Fecha o pedido e mostra o resumo para o cliente confirmar. Se ainda ' +
      'faltar algo (entrega/retirada, cidade, endereço ou nome), a ferramenta ' +
      'diz o que falta — pergunte de forma natural e chame de novo.',
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
      case 'definir_entrega':
        return { resultado: definirEntrega(sess, args) };
      case 'definir_cidade':
        return { resultado: definirCidade(sess, args) };
      case 'definir_endereco':
        return { resultado: definirEndereco(sess, args) };
      case 'definir_cadastro':
        return { resultado: definirCadastro(sess, args) };
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

// ------------------------------------------------------------- checkout
//
// Estas quatro ferramentas existem para o agente conduzir o fechamento
// **conversando**, em vez de entregar o cliente a um menu numerado no momento
// mais delicado do pedido. Antes daqui, `finalizar_pedido` chamava
// `order.startCheckout` e o agente saía de cena: o cliente vinha de uma conversa
// natural e topava com botões e "digite 1".
//
// O que NÃO mudou é quem decide. O modelo extrai da frase solta ("é pra
// Chelsea mesmo, rua tal 123") e chama; a cobertura, a taxa e o total continuam
// saindo de `delivery.json` e do carrinho. É por isso que a cobertura tem
// ferramenta própria: sem ela, "moro em Boston mas é pertinho" teria chance.

function definirEntrega(sess, { tipo }) {
  if (tipo === 'pickup') {
    if (!delivery.isPickupEnabled()) return 'Não temos retirada no balcão.';
    sess.orderType = 'pickup';
    sess.city = null;
    sess.address = null;
    const end = delivery.enderecoRetirada();
    return `Retirada registrada, sem taxa.${end ? ` Endereço: ${end}.` : ''}`;
  }

  if (tipo === 'delivery') {
    if (!delivery.getCities().length) {
      return 'Não estamos entregando agora — só retirada no balcão. Ofereça a retirada.';
    }
    sess.orderType = 'delivery';
    return `Entrega registrada. Agora pergunte a cidade e chame definir_cidade. Atendemos: ${delivery
      .nomesDasCidades()
      .join(', ')}.`;
  }

  return 'Tipo inválido. Use "delivery" ou "pickup".';
}

/**
 * A porta da cobertura.
 *
 * O modelo manda o nome; quem responde "atende ou não" é o `delivery.json`.
 * Recusar aqui, e não no prompt, é o que impede a insistência de funcionar.
 */
function definirCidade(sess, { cidade }) {
  const achada = delivery.acharCidade(cidade);

  if (!achada) {
    const lista = delivery.nomesDasCidades().join(', ');
    return (
      `NÃO ATENDEMOS "${cidade}". Diga isso ao cliente com clareza e ofereça a ` +
      `retirada no balcão. Entregamos só em: ${lista}. ` +
      `Não prometa entrega para essa cidade em nenhuma hipótese.`
    );
  }

  sess.orderType = 'delivery';
  sess.city = achada;
  return `Cidade ${achada.label} aceita. Taxa de entrega: $${Number(
    achada.delivery_fee
  ).toFixed(2)}. Agora peça a rua e o número.`;
}

function definirEndereco(sess, { endereco }) {
  if (sess.orderType === 'pickup') return 'O pedido é retirada — não precisa de endereço.';
  if (!sess.city) return 'Falta a cidade. Pergunte a cidade e chame definir_cidade antes.';

  const limpo = entrada.curto(endereco, entrada.LIMITES.endereco);
  if (limpo.length < 5) return 'Endereço curto demais. Peça rua e número.';

  sess.address = limpo;
  return `Endereço registrado: ${limpo}, ${sess.city.label}.`;
}

function definirCadastro(sess, { nome, email }) {
  const limpo = entrada.curto(nome, entrada.LIMITES.nome);
  if (limpo.length < 2) return 'Nome curto demais. Pergunte o nome do cliente.';

  sess.name = limpo;

  // Email é opcional e serve à lista de promoções, não ao pedido. Insistir
  // custa uma volta de conversa e trava quem só queria comprar.
  if (email && /.+@.+\..+/.test(email)) {
    sess.email = entrada.curto(email, entrada.LIMITES.email);
  }

  return `Cadastro: ${limpo}${sess.email ? ` (${sess.email})` : ''}.`;
}

// -------------------------------------------------------- finalizar_pedido

const FALTA = {
  orderType: 'Falta saber se é ENTREGA ou RETIRADA. Pergunte e chame definir_entrega.',
  city: 'Falta a CIDADE da entrega. Pergunte e chame definir_cidade.',
  address: 'Falta a RUA e o NÚMERO. Pergunte e chame definir_endereco.',
  name: 'Falta o NOME do cliente. Pergunte e chame definir_cadastro.',
};

/**
 * Fecha e mostra o resumo.
 *
 * Devolve o que falta em vez de despachar para o checkout numerado: o agente
 * pergunta com as palavras dele e chama de novo. O resumo em si é texto do
 * código, com números que o código somou — o cliente confirma o que o sistema
 * escreveu (ver `order.mostrarResumo`).
 */
async function finalizar(sess, send) {
  if (!sess.cart.length) {
    return { resultado: 'O carrinho está vazio — não há o que finalizar.' };
  }

  if (!sess.orderType) return { resultado: FALTA.orderType };
  if (sess.orderType === 'delivery' && !sess.city) return { resultado: FALTA.city };
  if (sess.orderType === 'delivery' && !sess.address) return { resultado: FALTA.address };
  if (!sess.name) return { resultado: FALTA.name };

  await order.mostrarResumo(sess, send);

  return {
    resultado:
      'Resumo enviado ao cliente, com o total calculado pelo sistema. ' +
      'Ele responde sim ou não. Não repita o resumo nem invente valores.',
    entregouAoFluxo: true,
  };
}

module.exports = { SCHEMA, executar };
