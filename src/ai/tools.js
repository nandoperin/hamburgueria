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
  if (!sess.cart.length) return ' Carrinho vazio ainda.';

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
        'numa frase curta com as suas palavras — algo como "me passa seu nome e ' +
        'o endereço completo, com rua, número e cidade". NÃO pergunte a cidade ' +
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

function definirEntrega(sess, { tipo }) {
  if (tipo === 'pickup') {
    if (!delivery.isPickupEnabled()) return 'Não temos retirada no balcão.';
    sess.orderType = 'pickup';
    sess.city = null;
    sess.address = null;
    const end = delivery.enderecoRetirada();
    return (
      `Retirada registrada, sem taxa.${end ? ` Endereço: ${end}.` : ''}` + oQueFalta(sess)
    );
  }

  if (tipo === 'delivery') {
    if (!delivery.getCities().length) {
      return 'Não estamos entregando agora — só retirada no balcão. Ofereça a retirada.';
    }
    sess.orderType = 'delivery';
    // Este retorno dizia "Agora pergunte a cidade" — e o modelo obedecia ao pé
    // da letra, gastando uma troca inteira só com a cidade antes de chegar à
    // rua. Quem decide o que pedir agora é `oQueFalta`, que enxerga os campos
    // todos; aqui fica só o que ele não tem como saber sozinho: a lista.
    // A lista de cidades é referência sua, não pergunta ao cliente: recitá-la
    // ("entregamos em Everett, Chelsea, Malden ou Medford — qual?") é o mesmo
    // que perguntar a cidade separada, e era o que o modelo fazia.
    return (
      'Entrega registrada. Cobertura, só para você conferir depois — não ' +
      `recite ao cliente agora: ${delivery.nomesDasCidades().join(', ')}.` +
      oQueFalta(sess)
    );
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
  return (
    `Cidade ${achada.label} aceita. Taxa de entrega: $${Number(
      achada.delivery_fee
    ).toFixed(2)}.` + oQueFalta(sess)
  );
}

function definirEndereco(sess, { endereco }) {
  if (sess.orderType === 'pickup') return 'O pedido é retirada — não precisa de endereço.';
  if (!sess.city) return 'Falta a cidade. Pergunte a cidade e chame definir_cidade antes.';

  const limpo = entrada.curto(endereco, entrada.LIMITES.endereco);
  if (limpo.length < 5) return 'Endereço curto demais. Peça rua e número.';

  sess.address = limpo;
  return `Endereço registrado: ${limpo}, ${sess.city.label}.` + oQueFalta(sess);
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

  return `Cadastro: ${limpo}${sess.email ? ` (${sess.email})` : ''}.` + oQueFalta(sess);
}

// -------------------------------------------------------- finalizar_pedido

/**
 * Fragmentos, não frases inteiras: `oQueFalta` junta os que faltam numa
 * pergunta só. Frase pronta por campo era o que produzia uma pergunta por
 * campo — o texto da ferramenta desenhava o formato da conversa.
 */
const FALTA = {
  endereco:
    'o ENDEREÇO COMPLETO — rua, número E cidade numa frase só, do jeito que ' +
    'todo mundo escreve endereço. NÃO pergunte a cidade separada: ela vem ' +
    'dentro do que ele escrever (chame definir_cidade e definir_endereco com ' +
    'as partes)',
  orderType: 'saber se é ENTREGA ou RETIRADA (chame definir_entrega)',
  city: 'a CIDADE da entrega (chame definir_cidade)',
  address: 'a RUA e o NÚMERO (chame definir_endereco)',
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
  if (!sess.cart.length) {
    return { resultado: 'O carrinho está vazio — não há o que finalizar.' };
  }

  if (faltando(sess).length) {
    return { resultado: 'Não dá para fechar ainda.' + oQueFalta(sess) };
  }

  await order.mostrarResumo(sess, send);

  return {
    resultado:
      'Resumo enviado ao cliente, com o total calculado pelo sistema. ' +
      'Ele responde sim ou não. Não repita o resumo nem invente valores.',
    entregouAoFluxo: true,
  };
}

module.exports = { SCHEMA, executar };
