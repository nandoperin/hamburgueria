const cardapio = require('../services/cardapio');
const delivery = require('../services/delivery');
const entrada = require('../entrada');
const modifiers = require('../services/modifiers');
const promotions = require('../services/promotions');
const salsicha = require('../services/preparo-salsicha');
const session = require('../bot/session');
const order = require('../bot/handlers/order');
const log = require('../log');
const { t } = require('../i18n');

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
    name: 'definir_preparo_salsicha',
    description: 'Define se uma salsicha ADICIONAL já no carrinho vai à parte ou junto do lanche. Não compra outra salsicha nem altera preço. Não use para salsicha que já vem no hot dog. Use id exato da linha; se avulsa com vários lanches, informe lanche_id.',
    input_schema: { type: 'object', properties: {
      item_id: { type: 'string' },
      modo: { type: 'string', enum: ['junto', 'a_parte'] },
      lanche_id: { type: 'string' },
      unidades_lanche: { type: 'integer', minimum: 1, maximum: 99, description: 'Só para distribuir salsichas avulsas entre várias unidades do mesmo lanche.' },
    }, required: ['item_id', 'modo'] },
  },
  {
    name: 'adicionar_item',
    description:
      'Adiciona um produto novo ao carrinho do cliente. Use o id do item do cardápio. ' +
      'Não use para corrigir quantidade ou ingredientes de uma linha existente. ' +
      'Para personalizar, passe os ids de ingredientes a remover (grátis) ou ' +
      'acrescentar (com preço). Para alterar uma linha que já existe, use personalizar_item. ' +
      'Confirme o item e o preço ao cliente depois.',
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
        preparo_salsicha: { type: 'string', enum: ['junto', 'a_parte'], description: 'Só se o cliente já informou como servir a salsicha ADICIONAL. Não adivinhe.' },
        lanche_id: { type: 'string', description: 'Para salsicha avulsa junto: id exato do lanche no carrinho.' },
        unidades_lanche: { type: 'integer', minimum: 1, maximum: 99 },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'personalizar_item',
    description:
      'Altera um produto que JÁ está no carrinho. Não adiciona uma nova unidade. ' +
      'Se houver mais de uma unidade e o cliente não disser quantas, omita quantidade.',
    input_schema: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'Id base ou id exato da linha no carrinho' },
        quantidade: { type: 'integer', minimum: 1, maximum: 99 },
        remover: { type: 'array', items: { type: 'string' } },
        acrescentar: { type: 'array', items: { type: 'string' } },
        restaurar: { type: 'array', items: { type: 'string' } },
        retirar_adicionais: { type: 'array', items: { type: 'string' } },
        preparo_salsicha: { type: 'string', enum: ['junto', 'a_parte'] },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'definir_quantidade_item',
    description:
      'Define a quantidade FINAL de um produto que JÁ está no carrinho. ' +
      'Use quando o cliente corrigir a quantidade, especialmente depois de recusar o resumo. ' +
      'Quantidade zero remove a linha inteira. Não soma unidades.',
    input_schema: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'Id base ou id exato da linha no carrinho' },
        quantidade: {
          type: 'integer',
          minimum: 0,
          maximum: 99,
          description: 'Quantidade final desejada, não a quantidade a acrescentar',
        },
      },
      required: ['item_id', 'quantidade'],
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
      'Registra o endereço livre de entrega, mesmo se a cidade ainda não foi informada. ' +
      'Identifica cidades atendidas dentro do endereço. Se não houver cidade, pergunte só a cidade depois.',
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
            'Endereço livre, exatamente como o cliente informou, incluindo a cidade ' +
            'quando ela estiver no texto. Não invente nem complete dados.',
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
async function executar(nome, args, sess, send, contexto = {}) {
  try {
    switch (nome) {
      case 'definir_preparo_salsicha': {
        const r = salsicha.definir(sess, args);
        return r.ok ? fluxo(r.resultado) : bloqueio(r.erro);
      }
      case 'adicionar_item':
        return { resultado: adicionar(sess, args) };
      case 'personalizar_item':
        return personalizar(sess, args);
      case 'definir_quantidade_item':
        return definirQuantidade(sess, args);
      case 'remover_item':
        return { resultado: remover(sess, args) };
      case 'ver_carrinho':
        return { resultado: verCarrinho(sess) };
      case 'definir_entrega':
        return await definirEntrega(sess, args, send, contexto);
      case 'definir_cidade':
        return definirCidade(sess, args, contexto);
      case 'definir_endereco':
        return definirEndereco(sess, args, contexto);
      case 'definir_cadastro':
        return definirCadastro(sess, args, contexto);
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

function adicionar(sess, { item_id, quantidade = 1, remover = [], acrescentar = [], preparo_salsicha, lanche_id, unidades_lanche }) {
  const lang = sess.lang || 'pt';
  const item = cardapio.itemById(item_id);

  if (!item) return `Item "${item_id}" não existe no cardápio.`;
  if (!cardapio.disponivel(item)) {
    return cardapio.mensagemIndisponivel(item, lang);
  }
  if (acrescentar.includes('salsicha') && sess.cart.some(salsicha.avulsa)) {
    return 'Salsicha já cobrada como produto avulso. Adicione o lanche sem esse adicional e use definir_preparo_salsicha para indicar onde servir, sem cobrar duas vezes.';
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
  const nova = {
    id: modifiers.cartId(item, val), productId: item.id,
    name: modifiers.rotulo(item, val, lang), nomeCozinha: cardapio.nomeCozinha(item),
    choicesCozinha: modifiers.linhasCozinha(val), removed: [...val.removed],
    added: [...val.added], qty, price: item.price + val.extra,
  };
  promotions.aplicarNaLinha(nova, item, val.extra, lang);
  if (preparo_salsicha && salsicha.precisa(nova)) {
    const r = salsicha.definir({ ...sess, cart: [...sess.cart, nova] }, {
      item_id: nova.id, modo: preparo_salsicha, lanche_id, unidades_lanche,
    });
    if (!r.ok) return r.erro;
  }
  const cartId = nova.id;
  const existing = sess.cart.find((i) => i.id === cartId);
  if (existing) {
    completarMetadados(existing, {
      productId: item.id,
      removed: val.removed,
      added: val.added,
    });
    existing.qty += qty;
    promotions.aplicarNaLinha(existing, item, val.extra, lang);
  } else {
    sess.cart.push(nova);
  }
  promotions.reprecificarCarrinho(sess.cart, lang);
  const linhaFinal = existing || nova;
  const rotulo = linhaFinal.name;

  // Sai do estado inicial para o fluxo saber que há carrinho em montagem.
  if (sess.state !== 'ORDER') sess.state = 'ORDER';

  const subtotal = session.getSubtotal(sess);
  return `Adicionado: ${qty}x ${rotulo} ($${linhaFinal.price.toFixed(2)} cada). Linha: ${cartId}. Subtotal do carrinho: $${subtotal.toFixed(2)}.`;
}

// ------------------------------------------------------ personalizar_item

function produtoDaLinha(line) {
  return line.productId || String(line.id || '').split(':')[0];
}

function unicos(lista) {
  return [...new Set((lista || []).map(String).filter(Boolean))];
}

function sem(lista, retirados) {
  const remover = new Set(unicos(retirados));
  return unicos(lista).filter((id) => !remover.has(id));
}

function modificadoresDoId(line, item) {
  const prefixo = `${item.id}:`;
  const id = String(line.id || '');
  if (!id.startsWith(prefixo)) return { removed: [], added: [] };

  const sufixo = id.slice(prefixo.length).split('~salsicha=')[0];
  const inicioAdicionais = sufixo.indexOf('+');
  const parteRemovidos = inicioAdicionais === -1 ? sufixo : sufixo.slice(0, inicioAdicionais);
  const parteAdicionados = inicioAdicionais === -1 ? '' : sufixo.slice(inicioAdicionais + 1);

  return {
    removed: parteRemovidos.startsWith('-') ? parteRemovidos.slice(1).split(',') : [],
    added: parteAdicionados ? parteAdicionados.split(',') : [],
  };
}

function estadoDaLinha(line, item) {
  const peloId = modificadoresDoId(line, item);
  return modifiers.validar(item, {
    remover: Array.isArray(line.removed) ? line.removed : peloId.removed,
    acrescentar: Array.isArray(line.added) ? line.added : peloId.added,
  });
}

function completarMetadados(line, { productId, removed, added }) {
  if (!line.productId) line.productId = productId;
  if (!Array.isArray(line.removed)) line.removed = [...removed];
  if (!Array.isArray(line.added)) line.added = [...added];
  if (!Array.isArray(line.choicesCozinha)) {
    line.choicesCozinha = modifiers.linhasCozinha({
      removed: line.removed,
      added: line.added,
    });
  }
  return line;
}

function juntarLinha(sess, nova) {
  const existente = sess.cart.find((line) => line.id === nova.id);
  if (existente) {
    completarMetadados(existente, nova);
    existente.qty += nova.qty;
  } else sess.cart.push(nova);
}

function personalizar(sess, args) {
  if ((args.acrescentar || []).includes('salsicha') && sess.cart.some(salsicha.avulsa)) {
    return bloqueio('Já há salsicha avulsa cobrada no carrinho. Para colocá-la junto use definir_preparo_salsicha, sem acrescentar e cobrar outra. Se o cliente pedir mais, acrescente unidades ao produto salsicha.');
  }
  const lang = sess.lang || 'pt';
  const id = String(args.item_id || '');
  const exata = sess.cart.find((line) => String(line.id) === id);
  const peloProduto = sess.cart.filter((line) => produtoDaLinha(line) === id);
  const variantes = new Set(peloProduto.map((line) => String(line.id)));
  if (variantes.size > 1) {
    return bloqueio(
      `Há variantes diferentes de "${id}" no carrinho. ` +
        `Pergunte qual linha deve ser alterada e use o id exato dela.`
    );
  }
  const compativeis = exata ? [exata] : peloProduto;

  if (!compativeis.length) {
    return bloqueio(`Não achei "${id}" no carrinho para personalizar.`);
  }

  const unidades = compativeis.reduce((total, line) => total + Number(line.qty || 0), 0);
  if (args.quantidade == null && unidades > 1) {
    return bloqueio(
      `Há ${unidades} unidades compatíveis no carrinho. Pergunte quantas devem ser alteradas.`
    );
  }

  const quantidade = args.quantidade == null ? 1 : args.quantidade;
  if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > unidades) {
    return bloqueio(
      `Quantidade inválida: há ${unidades} unidade${unidades === 1 ? '' : 's'} compatível${
        unidades === 1 ? '' : 'is'
      } no carrinho.`
    );
  }

  const target = compativeis.find((line) => Number(line.qty || 0) >= quantidade);
  if (!target) {
    return bloqueio(
      'A quantidade pedida está dividida entre linhas com personalizações diferentes. ' +
        'Peça o id exato da linha que deve ser alterada.'
    );
  }

  const item = cardapio.itemById(produtoDaLinha(target));
  if (!item) return bloqueio('O produto dessa linha não existe mais no cardápio.');
  if (!cardapio.disponivel(item)) {
    return bloqueio(cardapio.mensagemIndisponivel(item, lang));
  }

  const atual = estadoDaLinha(target, item);
  if (!atual.ok) {
    return bloqueio(
      `Não consegui preservar a personalização atual (${atual.erro}${
        atual.detalhe ? ': ' + atual.detalhe.join(', ') : ''
      }).`
    );
  }

  const removed = unicos([
    ...sem(atual.removed, args.restaurar),
    ...(args.remover || []),
  ]);
  const added = unicos([
    ...sem(atual.added, args.retirar_adicionais),
    ...(args.acrescentar || []),
  ]);
  const val = modifiers.validar(item, { remover: removed, acrescentar: added });
  if (!val.ok) {
    return bloqueio(
      `Não consegui personalizar assim (${val.erro}${
        val.detalhe ? ': ' + val.detalhe.join(', ') : ''
      }). Ofereça só o que o item permite.`
    );
  }

  const nova = {
    id: modifiers.cartId(item, { removed: val.removed, added: val.added }),
    productId: item.id,
    name: modifiers.rotulo(item, { removed: val.removed, added: val.added }, lang),
    nomeCozinha: cardapio.nomeCozinha(item),
    choicesCozinha: modifiers.linhasCozinha({ removed: val.removed, added: val.added }),
    removed: [...val.removed],
    added: [...val.added],
    qty: quantidade,
    price: item.price + val.extra,
  };
  if (val.added.includes('salsicha') && target.preparoSalsicha) {
    nova.preparoSalsicha = { ...target.preparoSalsicha };
    salsicha.rotular(nova, lang);
  }
  if (args.preparo_salsicha && val.added.includes('salsicha')) {
    nova.preparoSalsicha = { modo: args.preparo_salsicha };
    if (!['junto', 'a_parte'].includes(args.preparo_salsicha)) return bloqueio('Preparo de salsicha inválido.');
    salsicha.rotular(nova, lang);
  }

  completarMetadados(target, {
    productId: item.id,
    removed: atual.removed,
    added: atual.added,
  });
  target.qty -= quantidade;
  if (target.qty === 0) sess.cart.splice(sess.cart.indexOf(target), 1);
  juntarLinha(sess, nova);
  promotions.reprecificarCarrinho(sess.cart, lang);

  const subtotal = session.getSubtotal(sess);
  return {
    resultado:
      `Alterado: ${quantidade}x ${nova.name} ($${nova.price.toFixed(2)} cada). Linha: ${nova.id}. ` +
      `Subtotal do carrinho: $${subtotal.toFixed(2)}.`,
  };
}

// ------------------------------------------------ definir_quantidade_item

function definirQuantidade(sess, { item_id, quantidade }) {
  const id = String(item_id || '');
  if (!Number.isInteger(quantidade) || quantidade < 0 || quantidade > 99) {
    return bloqueio('Informe a quantidade final entre 0 e 99.');
  }

  const exata = sess.cart.find((line) => String(line.id) === id);
  const peloProduto = sess.cart.filter((line) => produtoDaLinha(line) === id);
  const candidatas = exata ? [exata] : peloProduto;
  if (!candidatas.length) {
    return bloqueio(`Não achei "${id}" no carrinho para alterar a quantidade.`);
  }
  if (!exata && new Set(candidatas.map((line) => String(line.id))).size > 1) {
    return bloqueio(
      `Há versões diferentes de "${id}" no carrinho. Pergunte qual linha deve ter a quantidade alterada.`
    );
  }

  const linha = candidatas[0];
  const anterior = Number(linha.qty) || 0;
  if (quantidade === 0) sess.cart.splice(sess.cart.indexOf(linha), 1);
  else linha.qty = quantidade;
  promotions.reprecificarCarrinho(sess.cart, sess.lang || 'pt');
  sess.state = 'ORDER';

  const subtotal = session.getSubtotal(sess);
  const resultado = quantidade === 0
    ? `Removido do carrinho: ${linha.name}.`
    : `Quantidade corrigida: ${linha.name}, de ${anterior} para ${quantidade}.`;
  return {
    resultado:
      `${resultado} Subtotal: $${subtotal.toFixed(2)}. ` +
      'O carrinho continua aberto para edição; só finalize quando o cliente pedir.',
  };
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
    .map((i) => `- [${i.id}] ${i.qty}x ${i.name} ($${(i.price * i.qty).toFixed(2)})`)
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

/**
 * O que ainda falta para fechar — ou o empurrão, quando não falta nada.
 *
 * Acrescentado ao resultado de cada setter, e essa posição é o ponto: o
 * modelo ouve "pode fechar" **no instante em que o pedido fica completo**, na
 * resposta da própria ferramenta que completou.
 *
 * Existe porque a via do prompt bateu no teto. O `mistral-small` entende a
 * regra "chame finalizar_pedido" e ainda assim, numa vez em três, escreve o
 * resumo com as próprias palavras — "Total: $16.00. Confirma tudo?" — em vez
 * de chamar. E o dano é silencioso: o estado nunca vai para CONFIRM, então o
 * "sim" do cliente não fecha pedido nenhum. Ele acha que pediu; não existe
 * pedido.
 *
 * Instrução no system prompt é lida uma vez, no começo, e concorre com tudo
 * mais. Resultado de ferramenta chega no momento da decisão, sobre o assunto
 * da decisão. Não substitui o prompt — reforça onde ele escorrega.
 */
/**
 * Cidade e endereço faltando juntos são **um** pedido, não dois.
 *
 * Listá-los separados foi o suficiente para o modelo continuar perguntando só
 * a cidade: medido em 2 de 3 conversas, ele lia "Falta a CIDADE..., a RUA e o
 * NÚMERO..." e respondia *"Pra qual cidade é a entrega?"*. Não é desobediência
 * — é a lista dando permissão para atacar o primeiro item.
 *
 * Fundidos, o pedido só existe numa forma: endereço completo. E é a forma
 * certa, porque é assim que qualquer pessoa escreve um endereço.
 */
function faltando(sess) {
  const faltas = [];
  if (!sess.orderType) faltas.push('orderType');
  if (sess.orderType === 'delivery' && (!sess.city || !sess.address)) {
    faltas.push(!sess.city && !sess.address ? 'endereco' : !sess.city ? 'city' : 'address');
  }
  if (!sess.name) faltas.push('name');
  return faltas;
}

/**
 * ## Por que a lista inteira, e não o próximo campo
 *
 * A primeira versão devolvia **um** campo por vez, com `return` na primeira
 * falta encontrada. Parecia certo — pergunta uma coisa de cada vez, como um
 * atendente — e produzia isto, medido num teste real:
 *
 *     Bot: É entrega ou retirada?          Cliente: Entrega
 *     Bot: Pra qual cidade?                Cliente: Everett
 *     Bot: Qual a rua e número?            Cliente: 6 elm st
 *     Bot: Anotei! Qual é o nome?          Cliente: Fernando
 *
 * Quatro idas e voltas para três dados que cabem numa frase. É o formulário
 * que este bot existe para não ser — só que digitado devagar, com emoji.
 *
 * Pedir tudo junto encurta para uma troca: *"me passa nome e endereço
 * completo"*, e o cliente responde *"Fernando, 6 Elm St, Everett"*. A cidade
 * some como pergunta separada e volta como parte do endereço — continua
 * validada pelo `delivery.json` em `definir_cidade`, que é o que importa.
 * Quando ele não disser a cidade, ela reaparece sozinha na próxima passagem
 * por aqui.
 */
/**
 * O que JÁ está decidido, dito em voz alta para não ser perguntado de novo.
 *
 * "Já havia escolhido retirada, perguntou de novo se era entrega ou retirada"
 * — relato de um teste real. `oQueFalta` sempre disse o que falta, e o modelo
 * concluía o resto sozinho; quando não concluía, reperguntava o que o cliente
 * acabara de responder, que é a marca registrada do formulário.
 *
 * Dizer o resolvido custa uma linha e fecha essa porta: o dado está na frente
 * dele no momento em que ele decide o que perguntar.
 */
function jaSabemos(sess) {
  const sabidos = [];
  if (sess.orderType === 'pickup') sabidos.push('é RETIRADA no balcão');
  if (sess.orderType === 'delivery') {
    sabidos.push('é ENTREGA');
    if (sess.city) sabidos.push(`cidade: ${sess.city.label}`);
    if (sess.address) sabidos.push(`endereço: ${sess.address}`);
  }
  if (sess.name) sabidos.push(`nome: ${sess.name}`);

  if (!sabidos.length) return '';
  return ` JÁ SABEMOS (não pergunte de novo): ${sabidos.join('; ')}.`;
}

function oQueFalta(sess) {
  const foraDaArea = mensagemCobertura(sess);
  if (foraDaArea) return foraDaArea + ' Não pergunte novamente qual é a cidade nem finalize a entrega.';
  if (!sess.cart.length) return ' Carrinho vazio ainda.';
  if (require('../services/mais-itens').pendente(sess)) {
    const pergunta = require('../services/mais-itens').pergunta(sess);
    return ` Pergunte: "${pergunta}" Espere a resposta. ` +
      'Se responder não, só isso ou nada mais, siga direto para finalizar_pedido; ' +
      'peça somente dados que ainda faltarem. Não pergunte se quer finalizar.';
  }
  if (!sess.orderType) {
    return jaSabemos(sess) + ' Pergunte somente: "Entrega ou retirada?". Não peça nome ou endereço ainda.';
  }

  // Cliente conhecido não redigita endereço. Quando ele escolhe entrega,
  // oferecemos o último destino e esperamos apenas sim ou não. A cidade ainda
  // precisa existir na cobertura atual — endereço antigo não fura essa regra.
  if (
    sess.orderType === 'delivery' &&
    !sess.city &&
    !sess.address &&
    sess.lastAddress &&
    sess.lastCityId &&
    !sess.enderecoAnteriorRecusado
  ) {
    const cidadeAnterior = delivery.getCityById(sess.lastCityId);
    if (cidadeAnterior) {
      sess.confirmandoEnderecoAnterior = true;
      return (
        ` ENDEREÇO ANTERIOR: "${sess.lastAddress}", ${cidadeAnterior.label}. ` +
        'Pergunte somente se pode entregar nesse endereço e espere a resposta. ' +
        'Não peça nome nem peça o endereço outra vez. Se confirmar, chame ' +
        'definir_cidade e definir_endereco com esses dados. Se recusar, peça o ' +
        'novo endereço do jeito que ele costuma escrever, incluindo a cidade.'
      );
    }
  }

  const faltas = faltando(sess);
  if (faltas.length) {
    const sabido = jaSabemos(sess);
    // A frase pronta, e não só a lista do que falta.
    //
    // Com a lista, o modelo pedia endereço e esquecia o nome — pegava o
    // primeiro item e parava, o que cortou o fechamento de quatro trocas para
    // três em vez de duas. É o mesmo achado de `argumentosDoItem`: dar o que
    // ele precisa **executar** funciona; deixar para ele montar, não.
    //
    // O exemplo é seguro porque é a pergunta do bot, não dado do cliente — não
    // contém nome nem endereço plausível que o modelo possa adotar como fato
    // (a armadilha registrada em `systemPrompt`).
    if (faltas.includes('endereco') && faltas.includes('name')) {
      return (
        sabido +
        ' Falta o ENDEREÇO COMPLETO e o NOME. Peça os DOIS na mesma mensagem, ' +
        'numa frase curta com as suas palavras. Peça o endereço livre, do jeito ' +
        'que o cliente costuma escrever, incluindo a cidade. NÃO pergunte a cidade ' +
        'separada nem deixe o nome para depois: quando ele responder, chame ' +
        'definir_cidade, definir_endereco e definir_cadastro de uma vez.'
      );
    }

    const pedidos = faltas.map((f) => FALTA[f]);
    const lista =
      pedidos.length > 1
        ? pedidos.slice(0, -1).join(', ') + ' e ' + pedidos[pedidos.length - 1]
        : pedidos[0];
    return (
      `${sabido} Falta ${lista}. Peça TUDO numa mensagem só, com as suas ` +
      'palavras — não uma pergunta por vez. Assim que ele responder, chame as ' +
      'ferramentas de cada dado e siga.'
    );
  }

  // Aqui ficava a sugestão de bebida. Ver `sugerirBebida`, logo abaixo, para
  // por que ela saiu — e o que teria que ser diferente para voltar.
  return (
    ' TUDO PRONTO: item, endereço e nome estão registrados. ' +
    'CHAME finalizar_pedido AGORA, na MESMA resposta, sem escrever nada antes. ' +
    'Nada de "anotei", nada de repetir o endereço, nada de resumo seu — o ' +
    'resumo do sistema já traz item, taxa, total e endereço, e vir logo depois ' +
    'da sua confirmação faz o cliente ler tudo duas vezes.'
  );
}

// Setter bem-sucedido: o agente calcula o proximo passo somente depois de
// executar o lote inteiro de ferramentas daquela mensagem. Se cada setter
// calcular aqui, os primeiros devolvem instrucoes que ja estarao vencidas
// quando o modelo voltar a ser chamado.
function fluxo(resultado) {
  return { resultado, atualizarFluxo: true };
}

// Erro que precisa ser resolvido pelo cliente antes de continuar. Ele impede
// que uma orientacao generica (por exemplo, pedir o endereco) seja anexada
// depois de uma cidade recusada ou de um dado invalido.
function bloqueio(resultado) {
  return { resultado, bloqueiaFluxo: true };
}

/**
 * A sugestão de bebida foi REMOVIDA. Isto é o registro de por quê.
 *
 * O dono pediu o upsell, e ele foi implementado do jeito que ele descreveu:
 * no fechamento, uma vez só, com o texto saindo do modelo em vez de um
 * template enlatado. Passou nos testes determinísticos e em 10/10 na prova
 * contra o modelo real. Mesmo assim, no uso de verdade, o veredito dele foi:
 *
 *   "retire o upsell. sempre ele, o fluxo não casa, repete sempre"
 *
 * ## O que a prova não via
 *
 * Os roteiros da prova são lineares — item, entrega, endereço, nome, fecha. Um
 * pedido real vai e volta: o cliente acrescenta item depois de dar o endereço,
 * muda de ideia, confirma e desconfirma. Cada volta dessas passa por
 * `oQueFalta` de novo, e a oferta reaparecia em pontos onde nada a justificava
 * — depois de confirmar o endereço, por exemplo.
 *
 * `upsellFeito` prendia a oferta a **uma por sessão**, e a sessão reinicia mais
 * do que eu supunha: `session.reset` a cada novo pedido, e o timeout de 30
 * minutos. Cada reinício zerava a trava e a pergunta voltava.
 *
 * É a diferença entre "passa no teste" e "serve ao cliente", e ela custou três
 * rodadas de ajuste — regra, texto, e de novo texto — antes de ficar claro que
 * o problema não era o ajuste fino, era o lugar.
 *
 * ## Para quem for reintroduzir
 *
 * Não é caso de reverter este commit. O que faltou não foi a regra nem o
 * texto: foi **um gatilho que não seja `oQueFalta`**. Ele roda em toda passagem
 * pelo fechamento, e o fechamento não acontece uma vez — acontece toda vez que
 * o cliente mexe no pedido. Um upsell que funcione precisa de um momento que
 * ocorra uma vez de verdade, e a sessão não oferece um hoje.
 *
 * `upselltest` foi virado do avesso e agora prova a AUSÊNCIA: se alguém religar
 * a sugestão sem resolver isso, a suíte quebra e traz este comentário junto.
 */

// `categoriaDaLinha` morava aqui e saiu junto com a sugestão de bebida — era a
// única a usá-la. A armadilha que ela resolvia continua valendo para quem
// precisar de categoria a partir do carrinho: a linha guarda o id COMPOSTO
// (`x_bacon:-cebola+ovo`, ver `modifiers.cartId`), que não existe no cardápio.
// `itemById` devolve null se você não desfizer a fusão antes — sem erro, sem
// log, apenas nunca achando nada.

async function definirEntrega(sess, { tipo }, _send, contexto = {}) {
  if (tipo === 'pickup') {
    if (!delivery.isPickupEnabled()) return bloqueio('Não temos retirada no balcão.');
    sess.orderType = 'pickup';
    sess.cidadeRecusada = null;
    sess.city = null;
    sess.address = null;
    sess.confirmandoEnderecoAnterior = false;
    sess.enderecoAnteriorRecusado = false;
    const end = delivery.enderecoRetirada();
    return fluxo(`Retirada registrada, sem taxa.${end ? ` Endereço: ${end}.` : ''}`);
  }

  if (tipo === 'delivery') {
    if (!delivery.getCities().length) {
      return bloqueio(
        'Não estamos entregando agora — só retirada no balcão. Ofereça a retirada.'
      );
    }
    const jaEraEntrega = sess.orderType === 'delivery';
    sess.orderType = 'delivery';
    if (!jaEraEntrega) sess.enderecoAnteriorRecusado = false;

    const textoCliente = String(contexto.textoCliente || '');
    const pediuOutro =
      /outro\s+endere[cç]o|endere[cç]o\s+novo|mudei|trocar\s+endere[cç]o|mudar\s+endere[cç]o/i.test(
        textoCliente
      );

    if (pediuOutro) {
      sess.confirmandoEnderecoAnterior = false;
      sess.enderecoAnteriorRecusado = true;
    }
    // Só uma escolha inequívoca reaproveita o destino automaticamente. Frases
    // com um endereço novo continuam passando pela extração normal da IA.
    const mesmoEndereco = /^(?:entrega\s+)?(?:no\s+)?mesmo endereco$/.test(
      normalizarComparacao(textoCliente).replace(/[.!?]+$/, '').trim()
    );
    const cidadeSalva = sess.lastCityId && delivery.getCityById(sess.lastCityId);
    if (mesmoEndereco && sess.lastAddress && cidadeSalva && !sess.address) {
      sess.city = cidadeSalva;
      sess.address = sess.lastAddress;
      sess.confirmandoEnderecoAnterior = false;
      sess.enderecoAnteriorRecusado = false;
    }
    // Este retorno dizia "Agora pergunte a cidade" — e o modelo obedecia ao pé
    // da letra, gastando uma troca inteira só com a cidade antes de chegar à
    // rua. Quem decide o que pedir agora é `oQueFalta`, que enxerga os campos
    // todos; aqui fica só o que ele não tem como saber sozinho: a lista.
    // A lista de cidades é referência sua, não pergunta ao cliente: recitá-la
    // ("entregamos em Everett, Chelsea, Malden ou Medford — qual?") é o mesmo
    // que perguntar a cidade separada, e era o que o modelo fazia.
    return fluxo(
      'Entrega registrada. Cobertura, só para você conferir depois — não ' +
        `recite ao cliente agora: ${delivery.nomesDasCidades().join(', ')}.`
    );
  }

  return bloqueio('Tipo inválido. Use "delivery" ou "pickup".');
}

/**
 * Pergunta curta enviada pelo código depois de TODO o lote de ferramentas.
 * Assim uma cidade recusada tem prioridade e nunca fica escondida atrás de
 * uma pergunta prematura. Também evita gastar outra chamada só para a IA
 * reformular uma coleta de dados que não muda.
 */
function mensagemAposEntrega(sess) {
  if (sess.orderType !== 'delivery' || !sess.cart.length || sess.address) return null;

  const cidadeAnterior = sess.lastCityId && delivery.getCityById(sess.lastCityId);
  const cidadeAtualCompativel = !sess.city || sess.city.id === sess.lastCityId;
  if (
    sess.lastAddress &&
    cidadeAnterior &&
    cidadeAtualCompativel &&
    !sess.enderecoAnteriorRecusado
  ) {
    sess.confirmandoEnderecoAnterior = true;
    const jaTemCidade = delivery.acharCidade(sess.lastAddress)?.id === cidadeAnterior.id;
    const address = jaTemCidade ? sess.lastAddress : `${sess.lastAddress}, ${cidadeAnterior.label}`;
    return t(sess.lang || 'pt', 'collect_saved_address', { address });
  }

  return t(sess.lang || 'pt', sess.name ? 'collect_address' : 'collect_name_address');
}

/** Somente depois do lote de setters: nunca pergunta um dado já registrado. */
function mensagemColeta(sess) {
  if (mensagemCobertura(sess)) return mensagemCobertura(sess);
  if (salsicha.pergunta(sess)) return salsicha.pergunta(sess);
  if (!sess.cart.length) return null;
  const lang = sess.lang || 'pt';
  if (!sess.orderType) return require('../services/mais-itens').pergunta(sess) || t(lang, 'collect_type');
  if (sess.orderType === 'delivery') {
    if (!sess.address) return mensagemAposEntrega(sess);
    if (!sess.city) return t(lang, 'collect_city');
  }
  if (!sess.name) return t(lang, 'collect_name');
  if (sess.editingCart) return require('../services/mais-itens').pergunta(sess);
  return null;
}

/**
 * A porta da cobertura.
 *
 * O modelo manda o nome; quem responde "atende ou não" é o `delivery.json`.
 * Recusar aqui, e não no prompt, é o que impede a insistência de funcionar.
 */
function mensagemCobertura(sess) {
  if (sess.orderType !== 'delivery' || !sess.cidadeRecusada) return null;
  const lista = delivery.nomesDasCidades().join(', ');
  return `Ainda não atendemos ${sess.cidadeRecusada} para entrega. ` +
    (lista ? `Atendemos: ${lista}. ` : 'No momento, não há cidades disponíveis para entrega. ') +
    'Para outras opções, ligue para (857) 353-1025.';
}

function recusarCidade(sess, cidade) {
  sess.orderType = 'delivery';
  sess.city = null;
  sess.cidadeRecusada = entrada.curto(cidade, 100);
  sess.confirmandoEnderecoAnterior = false;
  sess.enderecoAnteriorRecusado = true;
  return bloqueio('NÃO ATENDEMOS. ' + mensagemCobertura(sess));
}

function definirCidade(sess, { cidade }, contexto = {}) {
  // Se a IA tirar Boston dos argumentos, o endereco original ainda prevalece.
  const informada = delivery.extrairCidadeEndereco(contexto.textoCliente) || cidade;
  const achada = delivery.acharCidade(informada);

  if (!achada) {
    return recusarCidade(sess, informada);
  }

  sess.orderType = 'delivery';
  sess.city = achada;
  sess.cidadeRecusada = null;
  return fluxo(
    `Cidade ${achada.label} aceita. Taxa de entrega: $${Number(
      achada.delivery_fee
    ).toFixed(2)}.`
  );
}

function definirEndereco(sess, { endereco }, contexto = {}) {
  if (sess.orderType === 'pickup') {
    return bloqueio('O pedido é retirada — não precisa de endereço.');
  }

  const limpo = entrada.curto(endereco, entrada.LIMITES.endereco);
  if (!limpo) return bloqueio('Endereço vazio. Peça o endereço da entrega.');

  // A cidade e a unica parte com regra de negocio: define cobertura e taxa.
  // Procurar no texto inteiro cobre virgula, espaco e quebra de linha sem
  // transformar o restante do endereco num formulario postal.
  const cidadeInformada = delivery.extrairCidadeEndereco(limpo) ||
    delivery.extrairCidadeEndereco(contexto.textoCliente);
  const cidadeNoEndereco = delivery.acharCidade(cidadeInformada || limpo);
  if (cidadeInformada && !cidadeNoEndereco) {
    sess.address = limpo;
    return recusarCidade(sess, cidadeInformada);
  }
  if (cidadeNoEndereco) {
    sess.orderType = 'delivery';
    sess.city = cidadeNoEndereco;
    sess.cidadeRecusada = null;

    // Endereco livre nao significa aceitar a cidade como se fosse a rua. A IA
    // ja confundiu os dois campos numa chamada real. Barramos somente essa
    // igualdade exata; nenhum numero, apartment, ZIP ou formato postal e
    // exigido do cliente.
    const enderecoNormalizado = normalizarComparacao(limpo);
    const eSoCidade =
      enderecoNormalizado === normalizarComparacao(cidadeNoEndereco.label) ||
      enderecoNormalizado === normalizarComparacao(cidadeNoEndereco.id);
    if (eSoCidade) {
      return bloqueio(
        `Cidade registrada: ${cidadeNoEndereco.label}, mas a cidade sozinha NAO ` +
          'E O ENDERECO. Peca apenas o endereco da entrega, em texto livre. ' +
          'Nao exija numero nem apartment/unit.'
      );
    }
  }

  if (Object.prototype.hasOwnProperty.call(contexto, 'textoCliente')) {
    const textoCliente = contexto.textoCliente;
    const mesmoAtual =
      sess.address && normalizarComparacao(sess.address) === normalizarComparacao(limpo);
    const pediuAnterior =
      /mesm[oa]\s+endere[cç]o|endere[cç]o\s+de\s+sempre|manda\s+(?:pro|para o)\s+de\s+sempre|no\s+de\s+sempre/i.test(
        String(textoCliente || '')
      );
    const correspondeAoAnterior =
      sess.lastAddress &&
      normalizarComparacao(limpo).startsWith(normalizarComparacao(sess.lastAddress));
    const confirmouOferta =
      sess.confirmandoEnderecoAnterior &&
      respostaAfirma(textoCliente) &&
      correspondeAoAnterior;

    // Endereço anterior ainda exige confirmação. Endereço novo, porém, é livre:
    // o cliente sabe como o entregador encontra sua casa, e só a cidade passa
    // pela regra de cobertura/preço.
    if (!mesmoAtual && !confirmouOferta && !(pediuAnterior && correspondeAoAnterior)) {
      sess.address = limpo;
      sess.confirmandoEnderecoAnterior = false;
      sess.enderecoAnteriorRecusado = false;
      return fluxo(
        sess.city
          ? `Endereço registrado: ${limpo}. Cidade identificada: ${sess.city.label}.`
          : `Endereço registrado: ${limpo}. A cidade ainda não foi identificada; ` +
            'peça apenas para incluir a cidade.'
      );
    }
  }

  sess.address = limpo;
  sess.confirmandoEnderecoAnterior = false;
  sess.enderecoAnteriorRecusado = false;
  return fluxo(
    sess.city
      ? `Endereço registrado: ${limpo}. Cidade identificada: ${sess.city.label}.`
      : `Endereço registrado: ${limpo}. A cidade ainda não foi identificada; ` +
        'peça apenas para incluir a cidade.'
  );
}

function normalizarComparacao(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9@._+-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function apareceInteiro(valor, texto) {
  const procurado = normalizarComparacao(valor);
  const origem = normalizarComparacao(texto);
  if (!procurado || !origem) return false;
  return ` ${origem} `.includes(` ${procurado} `);
}

function respostaAfirma(texto) {
  return /^(?:sim|pode|isso|correto|confirmo|yes|si|esse mesmo|essa mesma)\b/i.test(
    normalizarComparacao(texto)
  );
}

function observarMensagem(sess, texto) {
  if (!sess.confirmandoEnderecoAnterior) return;
  if (/^(?:nao|no|outro|outra|mudei|trocar|mudar)\b/i.test(normalizarComparacao(texto))) {
    sess.confirmandoEnderecoAnterior = false;
    sess.enderecoAnteriorRecusado = true;
  }
}

function respostaAfirmaCurta(texto) {
  const resposta = normalizarComparacao(texto);
  return new Set([
    'sim', 'sim pode', 'pode', 'isso', 'correto', 'confirmo',
    'yes', 'si', 'esse mesmo', 'essa mesma',
  ]).has(resposta);
}

/**
 * Confirmação curta do endereço conhecido não precisa do modelo. O código já
 * tem todos os dados e a taxa vem da cidade configurada. Além de mais preciso,
 * isso elimina as duas rodadas que seriam usadas para chamar os setters e
 * depois finalizar o pedido.
 */
async function confirmarEnderecoPendente(sess, texto, send) {
  if (!sess.confirmandoEnderecoAnterior || !respostaAfirmaCurta(texto)) return false;
  if (!sess.cart.length || !sess.name || !sess.lastAddress || !sess.lastCityId) {
    return false;
  }

  const cidade = delivery.getCityById(sess.lastCityId);
  if (!cidade) {
    sess.confirmandoEnderecoAnterior = false;
    sess.enderecoAnteriorRecusado = true;
    return false;
  }

  sess.orderType = 'delivery';
  sess.city = cidade;
  sess.address = sess.lastAddress;
  sess.confirmandoEnderecoAnterior = false;
  sess.enderecoAnteriorRecusado = false;
  await order.mostrarResumo(sess, send);
  return true;
}

function definirCadastro(sess, { nome, email }, contexto = {}) {
  const limpo = entrada.curto(nome, entrada.LIMITES.nome);
  if (limpo.length < 2) {
    return bloqueio('Nome curto demais. Pergunte o nome do cliente.');
  }

  // O modelo extrai; ele nao cria identidade. Na prova real, uma mensagem que
  // continha somente o endereco virou cadastro "Cliente" em uma repeticao e
  // "Everett" em outra. O prompt proibia, mas prompt nao e trava. Nome novo
  // precisa estar literalmente sustentado pela mensagem atual. O nome ja
  // conhecido pode ser repetido pelo modelo a partir do contexto sem obrigar
  // o cliente a se apresentar outra vez.
  if (Object.prototype.hasOwnProperty.call(contexto, 'textoCliente')) {
    const mesmoConhecido =
      sess.name && normalizarComparacao(sess.name) === normalizarComparacao(limpo);
    if (!mesmoConhecido && !apareceInteiro(limpo, contexto.textoCliente)) {
      return bloqueio(
        `Nome NAO REGISTRADO: "${limpo}" não apareceu na mensagem atual do cliente. ` +
          'Não invente nem use cidade, endereço ou palavras genéricas como nome. ' +
          'Pergunte o nome e espere a resposta.'
      );
    }
  }

  sess.name = limpo;

  // Email é opcional e serve à lista de promoções, não ao pedido. Insistir
  // custa uma volta de conversa e trava quem só queria comprar.
  const emailSustentado =
    !Object.prototype.hasOwnProperty.call(contexto, 'textoCliente') ||
    apareceInteiro(email, contexto.textoCliente) ||
    (sess.email && normalizarComparacao(sess.email) === normalizarComparacao(email));
  if (email && /.+@.+\..+/.test(email) && emailSustentado) {
    sess.email = entrada.curto(email, entrada.LIMITES.email);
  }

  return fluxo(`Cadastro: ${limpo}${sess.email ? ` (${sess.email})` : ''}.`);
}

// -------------------------------------------------------- finalizar_pedido

/**
 * Fragmentos, não frases inteiras: `oQueFalta` junta os que faltam numa
 * pergunta só. Frase pronta por campo era o que produzia uma pergunta por
 * campo — o texto da ferramenta desenhava o formato da conversa.
 */
const FALTA = {
  endereco:
    'o ENDEREÇO DA ENTREGA em texto livre, incluindo a cidade. NÃO pergunte a cidade separada: ela vem ' +
    'dentro do que ele escrever (chame definir_cidade e definir_endereco com ' +
    'as partes)',
  orderType: 'saber se é ENTREGA ou RETIRADA (chame definir_entrega)',
  city: 'a CIDADE da entrega (chame definir_cidade)',
  address:
    'o ENDEREÇO DA ENTREGA, do jeito que o cliente escrever (chame definir_endereco)',
  name: 'o NOME do cliente (chame definir_cadastro)',
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
  if (salsicha.pergunta(sess)) return bloqueio(salsicha.pergunta(sess));
  if (mensagemCobertura(sess)) return bloqueio(mensagemCobertura(sess));
  if (!sess.cart.length) {
    return { resultado: 'O carrinho está vazio — não há o que finalizar.' };
  }

  if (faltando(sess).length) {
    return fluxo('Não dá para fechar ainda.' + oQueFalta(sess));
  }

  await order.mostrarResumo(sess, send);

  return {
    resultado:
      'Resumo enviado ao cliente, com o total calculado pelo sistema. ' +
      'Ele responde sim ou não. Não repita o resumo nem invente valores.',
    entregouAoFluxo: true,
  };
}

module.exports = {
  SCHEMA,
  executar,
  orientacao: oQueFalta,
  observarMensagem,
  confirmarEnderecoPendente,
  mensagemAposEntrega,
  mensagemColeta,
  mensagemCobertura,
};
