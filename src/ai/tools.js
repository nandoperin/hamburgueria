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
      'Se houver mais de uma unidade e o cliente não disser quantas, omita quantidade. ' +
      'Se houver vários lanches e o cliente pedir salsicha sem indicar o lanche, ' +
      'não escolha: pergunte o lanche e o preparo na mesma mensagem.',
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
    name: 'concluir_escolha_itens',
    description:
      'Registra que o cliente terminou de escolher produtos. Use ao interpretar a resposta ' +
      'à última pergunta pós-catálogo: por exemplo, SIM para "só isso?" ou NÃO para ' +
      '"quer algo mais?". Considere a pergunta anterior; não decida pelo sim/não isolado.',
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
  {
    name: 'confirmar_resumo',
    description:
      'Confirma o resumo oficial que já está na tela e cria o pedido/pagamento. ' +
      'Use somente quando o cliente aceitar claramente o resumo SEM pedir mudança na mesma mensagem. ' +
      'Se houver qualquer correção, aplique a correção e mostre um novo resumo primeiro.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'definir_pagamento',
    description:
      'Registra a forma de pagamento imediatamente depois de o cliente escolher entrega ou retirada e antes do resumo. ' +
      'Reconheça zelle/transferência como zelle e cash/dinheiro/espécie/pagar na entrega ou retirada como cash. ' +
      'Para cash, não pergunte sobre troco: o entregador sempre leva troco.',
    input_schema: {
      type: 'object',
      properties: {
        metodo: { type: 'string', enum: ['zelle', 'cash'] },
      },
      required: ['metodo'],
    },
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
  const registrados = produtosAntesDaLogistica(nome, sess, contexto);
  const r = await executarFerramenta(nome, args, sess, send, contexto);
  if (registrados && r && typeof r.resultado === 'string') {
    r.resultado = `Produto registrado pelo sistema, como o cliente pediu nesta mensagem: ${registrados}. ${r.resultado}`;
  }
  return r;
}

// ------------------------------------------- o pedido inteiro numa mensagem
//
// "um x burger pra entrega, pago em cash": produto, quantidade, entrega e
// pagamento. Em 6 de 6 provas o modelo registrou entrega e pagamento e pulou
// o produto — o pagamento era recusado (carrinho vazio), ele dizia "Cash
// registrado!" mesmo assim, e o resto da conversa virava "Não entendi".

const FERRAMENTAS_DE_LOGISTICA = [
  'definir_entrega', 'definir_pagamento', 'definir_cidade', 'definir_endereco', 'definir_cadastro',
];

// Como recebe e como paga: o que o cliente mistura ao pedido e não é produto.
// "retirar o tomate" é ingrediente, não retirada.
const LOGISTICA = [
  '\\b(?:(?:pra|para)\\s+)?(?:entrega|entregar|delivery|retirada|pickup)\\b',
  '\\b(?:(?:pra|para|vou|irei)\\s+)?retirar\\b(?!\\s+(?:o|a|os|as)\\b)',
  '\\b(?:vou|irei)\\s+(?:buscar|pegar)\\b',
  '\\b(?:no\\s+|pelo\\s+)?balcao\\b',
  '\\b(?:(?:vou\\s+)?(?:pago|pagar|pagamento|pagando)\\s+)?(?:(?:em|no|na|com|pelo|pela|via)\\s+)?' +
    '(?:cash|dinheiro|especie|zelle|zell)\\b',
  '\\b(?:vou\\s+)?(?:pago|pagar|pagamento)\\s+(?:na|no)\\s+(?:entrega|hora|retirada)\\b',
  '\\b(?:no\\s+)?mesmo\\s+endereco\\b',
].join('|');
// Cortesia também sai antes de ler os produtos, mas não quer dizer que ele
// terminou de escolher ("boa noite, quero um x-tudo" ainda ouve "algo mais?").
const CORTESIA = '\\b(?:por favor|obrigad[oa]|boa noite|boa tarde|bom dia|oi|ola)\\b';
const FORA_DO_PRODUTO = new RegExp(`${LOGISTICA}|${CORTESIA}`, 'g');

function falouLogistica(texto) {
  return new RegExp(LOGISTICA).test(normalizarComparacao(texto));
}

/**
 * Os produtos de uma mensagem que mistura pedido e logística.
 *
 * Tira entrega, pagamento e cumprimentos, e o que sobra passa pela mesma
 * gramática conservadora do pedido em texto (`services/pedido-texto`):
 * quantidade, produto, "sem"/"com". Sobrou endereço, nome ou qualquer coisa
 * que ela não entenda com segurança? Devolve null — melhor o modelo resolver
 * do que o código adivinhar metade do pedido.
 */
function produtosDaMensagem(texto) {
  const normal = normalizarComparacao(texto);
  if (!falouLogistica(texto)) return null;
  const resto = normal.replace(FORA_DO_PRODUTO, ' ').replace(/\s+e\s*$/, '').replace(/\s+/g, ' ').trim();
  if (!resto) return null;
  const plano = require('../services/pedido-texto').interpretar(resto);
  if (!plano?.length) return null;
  const valido = plano.every((p) => cardapio.disponivel(p.item) && modifiers.validar(p.item, p).ok);
  return valido ? plano : null;
}

/**
 * Carrinho vazio e o modelo foi direto à logística: registra primeiro os
 * produtos que o cliente pediu na mesma mensagem. Uma vez por mensagem; tudo
 * ou nada. Devolve o texto do que registrou, ou null.
 */
function produtosAntesDaLogistica(nome, sess, contexto) {
  if (!FERRAMENTAS_DE_LOGISTICA.includes(nome) || (sess.cart || []).length) return null;
  if (!Object.prototype.hasOwnProperty.call(contexto, 'textoCliente')) return null;
  // A gramática do pedido em texto só conhece os nomes em português.
  if (sess.lang && sess.lang !== 'pt') return null;
  if (registradosNestaFala(sess)) return null;

  const plano = produtosDaMensagem(contexto.textoCliente);
  if (!plano) return null;

  for (const p of plano) {
    adicionar(sess, {
      item_id: p.item.id, quantidade: p.quantidade, remover: p.remover, acrescentar: p.acrescentar,
    });
  }
  sess.produtosDaMensagem = { turno: sess.turnoFala || 0, ids: plano.map((p) => p.item.id) };
  // Quem já disse como recebe ou paga terminou de escolher: sem "quer algo mais?".
  sess.escolhaItensConcluida = true;
  sess.aguardandoMaisItens = false;

  log.info({ evt: 'ia_tool', nome: 'produtos_da_mensagem', itens: sess.produtosDaMensagem.ids },
    'produto pulado pelo modelo registrado pelo sistema');
  return sess.cart.map((l) => `${l.qty}x ${l.name}`).join(', ');
}

// O inverso: "2 x tudo pra retirada, pago no zelle", e o modelo registra o
// lanche, pula como o cliente recebe e como paga, e responde "Quer algo
// mais?" (prova real, 11/09). Só vale o que está dito com todas as letras.
const DIZ_RETIRADA = /\b(?:retirada|pickup|balcao)\b|\b(?:pra|para|vou|irei)\s+(?:retirar|buscar)\b(?!\s+(?:o|a|os|as)\b)/;
// As mesmas palavras que `definirEntrega` aceita como sustentação.
const DIZ_ENTREGA = /\b(?:entrega|delivery|mesmo endereco)\b/;
const NEGA_TIPO = /\b(?:nao|sem)\s+(?:e\s+)?(?:(?:pra|para)\s+)?(?:entrega|entregar|delivery|retirada|retirar)\b/;

/**
 * Entrega/retirada e pagamento que o cliente disse na mensagem em que pediu o
 * produto, e que o modelo não registrou. Devolve as chamadas que faltaram,
 * para o agente executar; pergunta, negação ou os dois tipos juntos ficam com
 * o modelo.
 */
function logisticaPulada(sess, texto, chamadas = []) {
  if (!sess.cart?.length || (sess.lang && sess.lang !== 'pt') || /\?/.test(String(texto))) return [];
  const normal = normalizarComparacao(texto);
  const extras = [];
  if (!sess.orderType && !chamadas.includes('definir_entrega') && !NEGA_TIPO.test(normal)) {
    const retirada = DIZ_RETIRADA.test(normal);
    if (retirada !== DIZ_ENTREGA.test(normal)) {
      extras.push(['definir_entrega', { tipo: retirada ? 'pickup' : 'delivery' }]);
    }
  }
  const metodo = order.metodoDoTexto(texto);
  if (metodo && !sess.paymentMethod && !chamadas.includes('definir_pagamento')) {
    extras.push(['definir_pagamento', { metodo }]);
  }
  return extras;
}

/**
 * "Entrega na verdade" — o cliente corrige como recebe, no meio do caminho.
 *
 * Prova real: pedido em retirada, o cliente respondeu "entrega na verdade, 17
 * Fairmount st Everett" citando o "Entrega ou retirada?". O modelo chamou só
 * `definir_endereco`, que foi recusado porque o pedido ainda era retirada, e o
 * bot respondeu "Retirada, então!" — o contrário do que ele acabara de dizer,
 * com o endereço jogado fora. Devolve o tipo novo, ou null.
 */
const PAGA_NA_ENTREGA = /\b(?:vou\s+)?(?:pago|pagar|pagamento)\s+(?:na|no)\s+(?:entrega|hora|retirada)\b/g;

function tipoCorrigido(sess, texto) {
  if (!sess.cart?.length || !sess.orderType || /\?/.test(String(texto))) return null;
  // "pago na entrega" é forma de pagamento, não como ele recebe.
  const normal = normalizarComparacao(texto).replace(PAGA_NA_ENTREGA, ' ');
  if (NEGA_TIPO.test(normal)) return null;
  const retirada = DIZ_RETIRADA.test(normal);
  if (retirada === DIZ_ENTREGA.test(normal)) return null;
  const tipo = retirada ? 'pickup' : 'delivery';
  return tipo === sess.orderType ? null : tipo;
}

/** Ids que o sistema já registrou a partir desta mesma fala, ou null. */
function registradosNestaFala(sess) {
  const p = sess.produtosDaMensagem;
  return p && p.turno === (sess.turnoFala || 0) ? p.ids : null;
}

// A recusa de dado com o carrinho vazio diz o que fazer: sem isso o modelo
// respondia "registrado!" ao cliente e seguia como se estivesse.
const PRIMEIRO_O_PRODUTO =
  'Se o cliente pediu um produto nesta mensagem, registre-o primeiro com adicionar_item e ' +
  'depois chame de novo esta ferramenta; se ele ainda não pediu nenhum, pergunte o que vai querer.';

async function executarFerramenta(nome, args, sess, send, contexto = {}) {
  try {
    if (['PAYMENT_METHOD', 'CASH_CHANGE'].includes(sess.state) && nome !== 'definir_pagamento') {
      return bloqueio('Nesta etapa, apenas a forma de pagamento ou o troco podem ser registrados.');
    }
    if (
      sess.state === 'CONFIRM' &&
      ['adicionar_item', 'personalizar_item', 'definir_quantidade_item', 'remover_item'].includes(nome)
    ) {
      // Uma correção invalida o resumo que estava na tela. O carrinho reabre,
      // mas o pedido não é criado até um novo resumo oficial ser mostrado.
      sess.state = 'ORDER';
      sess.editingCart = true;
      sess.escolhaItensConcluida = true;
      sess.aguardandoMaisItens = false;
    }
    switch (nome) {
      case 'definir_preparo_salsicha': {
        const comoAcrescimo = preparoApontandoOLanche(sess, args, contexto);
        if (comoAcrescimo) return personalizar(sess, semPreparoInferido(comoAcrescimo, contexto), contexto);
        const r = salsicha.definir(sess, args);
        return r.ok ? fluxo(r.resultado) : bloqueio(r.erro);
      }
      case 'adicionar_item': {
        // O sistema já registrou este produto a partir desta mesma mensagem
        // (`produtosAntesDaLogistica`): chamar de novo dobraria a quantidade.
        if (registradosNestaFala(sess)?.includes(args.item_id)) {
          const linha = sess.cart.find((l) => produtoDaLinha(l) === args.item_id);
          return {
            resultado: `Já registrado pelo sistema nesta mensagem: ${
              linha ? `${linha.qty}x ${linha.name}` : args.item_id}. Não adicione de novo.`,
          };
        }
        const argsPreparo = semPreparoInferido(args, contexto);
        /**
         * Quando o modelo pergunta "junto ou à parte?" ANTES de adicionar o
         * item (em vez de adicionar e perguntar depois, como `personalizar_item`
         * permitiria via `definir_preparo_salsicha`), a resposta do cliente —
         * "junto" — não cita o lanche em nenhuma palavra. `semPreparoInferido`
         * só preserva `preparo_salsicha` quando o texto atual É de fato essa
         * resposta explícita; se ele sobreviveu, o produto necessariamente veio
         * de um turno anterior que o modelo está completando, não inventando.
         */
        // Os dois caminhos que a salsicha tem: adicional de um lanche
         // (`acrescentar`) e produto avulso do cardápio (`item_id`). Só o
         // primeiro estava coberto, e o modelo escolhe um ou outro sem
         // critério visível — no pedido #53 escolheu o avulso e a salsicha
         // ficou de fora do pedido inteiro.
        const completandoPreparo = Boolean(args.preparo_salsicha) &&
          argsPreparo.preparo_salsicha === args.preparo_salsicha &&
          ((args.acrescentar || []).includes('salsicha') || args.item_id === 'salsicha');
        let quantidadeFinal = false;
        if (!completandoPreparo && Object.prototype.hasOwnProperty.call(contexto, 'textoCliente')) {
          const item = cardapio.itemById(args.item_id);
          if (item && !adicaoSustentadaNoTexto(sess, item, contexto.textoCliente)) {
            return bloqueio(
              `Item NÃO adicionado: "${cardapio.nome(item, sess.lang || 'pt')}" não foi pedido ` +
              'na mensagem atual. Não invente produto; responda que não entendeu.'
            );
          }
          if (item && soPerguntou(sess, item, contexto.textoCliente)) {
            return bloqueio(
              `Item NÃO adicionado: o cliente só PERGUNTOU sobre "${cardapio.nome(item, sess.lang || 'pt')}", ` +
              'não pediu. Responda a pergunta (se tem, preço, prazo) e pergunte se ele quer que você adicione.'
            );
          }
          const comoLanche = item && adicionalPedidoComoLanche(item, contexto.textoCliente);
          if (comoLanche) return bloqueio(comoLanche);
          if (item) {
            argsPreparo.remover = remocoesPedidas(sess, item, argsPreparo.remover, contexto.textoCliente);
            const refeito = pedidoRefeito(sess, contexto.textoCliente);
            if (refeito?.substituir) aplicarListaRefeita(sess, contexto.textoCliente);
            quantidadeFinal = Boolean(refeito) && nomeCitado(nomesDoItem(item), contexto.textoCliente);
          }
        }
        const carrinhoAntes = JSON.stringify(sess.cart);
        const resultado = adicionar(sess, argsPreparo, { quantidadeFinal });
        // Quem já disse como recebe ou como paga ("um x burger pra entrega")
        // terminou de escolher: sem "Quer algo mais?" antes de seguir.
        if (JSON.stringify(sess.cart) !== carrinhoAntes && falouLogistica(contexto.textoCliente)) {
          sess.escolhaItensConcluida = true;
          sess.aguardandoMaisItens = false;
        }
        return { resultado };
      }
      case 'personalizar_item': {
        if (Object.prototype.hasOwnProperty.call(contexto, 'textoCliente') && args.remover) {
          const item = cardapio.itemById(produtoDaLinha({ id: args.item_id }));
          args = { ...args, remover: remocoesPedidas(sess, item, args.remover, contexto.textoCliente) };
        }
        return personalizar(sess, semPreparoInferido(args, contexto), contexto);
      }
      case 'definir_quantidade_item':
        return definirQuantidade(sess, args);
      case 'remover_item': {
        if (Object.prototype.hasOwnProperty.call(contexto, 'textoCliente')) {
          const duvida = removerAmbiguo(sess, args.item_id, contexto.textoCliente);
          if (duvida) return bloqueio(duvida);
        }
        return { resultado: remover(sess, args) };
      }
      case 'ver_carrinho':
        return { resultado: verCarrinho(sess) };
      case 'concluir_escolha_itens':
        return concluirEscolhaItens(sess);
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
      case 'confirmar_resumo':
        return await confirmarResumo(sess, send);
      case 'definir_pagamento':
        return await definirPagamento(sess, args, send, contexto);
      default:
        return { resultado: `ferramenta desconhecida: ${nome}` };
    }
  } catch (err) {
    log.error({ evt: 'ia_tool', nome, err }, 'falha ao executar ferramenta');
    return { resultado: `erro ao executar ${nome}: ${err.message}` };
  }
}

async function confirmarResumo(sess, send) {
  if (sess.state !== 'CONFIRM') {
    return bloqueio('Não existe um resumo oficial aguardando confirmação.');
  }
  const resposta = sess.lang === 'en' ? 'yes' : sess.lang === 'es' ? 'sí' : 'sim';
  await order.handleConfirm(sess, resposta, send);
  const esperado = sess.paymentMethod === 'cash' ? 'ORDER_COMPLETE' : 'PAYMENT_PENDING';
  if (sess.state !== esperado) {
    return bloqueio('O pedido não foi criado; mantenha o resumo aguardando confirmação.');
  }
  return {
    resultado: sess.paymentMethod === 'cash'
      ? 'Pedido cash criado como A COBRAR e enviado para impressão.'
      : 'Pedido criado e instruções oficiais do Zelle enviadas.',
    entregouAoFluxo: true,
  };
}

async function definirPagamento(sess, args, send, contexto = {}) {
  const naEtapa = ['PAYMENT_METHOD', 'CASH_CHANGE'].includes(sess.state);
  const metodo = args?.metodo;
  if (!['zelle', 'cash'].includes(metodo)) {
    return bloqueio('Forma de pagamento NÃO registrada: use metodo "zelle" ou "cash".');
  }
  if (!naEtapa) {
    if (!sess.cart?.length) {
      return bloqueio(`Forma de pagamento NÃO registrada: o carrinho está vazio. ${PRIMEIRO_O_PRODUTO}`);
    }
    if (sess.paymentMethod) {
      return bloqueio(`Forma de pagamento já registrada (${sess.paymentMethod}). Não chame de novo; siga com o próximo dado.`);
    }
    if (!sess.orderType) {
      // "um x burger, pago em cash": disse como paga antes de dizer como
      // recebe. Guarda o que ele disse, para não perguntar de novo depois.
      if (order.metodoDoTexto(contexto.textoCliente) !== metodo) {
        return bloqueio(
          'Forma de pagamento NÃO registrada: ainda falta entrega ou retirada. ' +
          'Pergunte "Entrega ou retirada?" antes da forma de pagamento.'
        );
      }
      sess.paymentMethod = metodo;
      sess.changeFor = null;
      return fluxo(`Forma de pagamento registrada: ${metodo}. Falta entrega ou retirada.`);
    }
  }

  // Falta endereço ou nome: a próxima pergunta é a da conversa, feita pelo
  // agente depois do lote (`mensagemColeta`) — cliente conhecido ouve
  // "Entrego em ...?", novo dá nome e endereço de uma vez. O `startCheckout`
  // pedia o endereço digitado de novo até a quem já tinha um salvo.
  if (Object.prototype.hasOwnProperty.call(contexto, 'textoCliente')) {
    const faltaDado = faltando({ ...sess, paymentMethod: metodo }).length > 0;
    if (faltaDado) {
      sess.paymentMethod = metodo;
      sess.changeFor = null;
      sess.state = 'ORDER';
      return fluxo(`Forma de pagamento registrada: ${metodo}.`);
    }
  }

  if (!naEtapa) sess.state = 'PAYMENT_METHOD';
  const texto = contexto.textoCliente || '';
  await order.handlePayment(sess, texto, send, {
    method: metodo,
  });
  if (['PAYMENT_METHOD', 'CASH_CHANGE'].includes(sess.state)) {
    return { resultado: 'O sistema fez a pergunta necessária e aguarda o cliente.', entregouAoFluxo: true };
  }
  return {
    resultado: 'Forma de pagamento registrada. O sistema avançou para o próximo dado obrigatório ou para o resumo.',
    entregouAoFluxo: true,
  };
}

function concluirEscolhaItens(sess) {
  if (!sess.cart?.length || !sess.aguardandoMaisItens) {
    return bloqueio('Não há uma escolha de itens aguardando conclusão.');
  }
  sess.escolhaItensConcluida = true;
  sess.aguardandoMaisItens = false;
  sess.maisItensViaIaCatalogo = false;
  sess.editingCart = false;
  sess.menuSelection = null;
  return fluxo(
    'O cliente confirmou que terminou de escolher os itens. Siga para o próximo dado obrigatório.'
  );
}

/**
 * "X Tudo com salsicha" compra o adicional, mas não responde como ele deve
 * ser servido. Modelos pequenos às vezes transformam o simples "com" em
 * preparo_salsicha="junto" e pulam a pergunta obrigatória. Só aceitamos esse
 * campo embutido quando a mensagem realmente diz junto/à parte. Repetir o
 * pedido anterior é a exceção: nesse caso o preparo já confirmado faz parte
 * do pedido salvo.
 */
function semPreparoInferido(args = {}, contexto = {}) {
  if (!args.preparo_salsicha || !Object.prototype.hasOwnProperty.call(contexto, 'textoCliente')) {
    return args;
  }

  const texto = normalizarComparacao(contexto.textoCliente);
  const repeticao = /\b(?:de sempre|igual|mesmo pedido|mesma coisa|repete|repetir)\b/.test(texto);
  const explicito = args.preparo_salsicha === 'junto'
    ? /\b(?:junto|junta|no lanche|dentro do lanche)\b/.test(texto)
    : /\b(?:a parte|separado|separada|por fora)\b/.test(texto);
  if (repeticao || explicito) return args;

  const limpo = { ...args };
  delete limpo.preparo_salsicha;
  delete limpo.lanche_id;
  delete limpo.unidades_lanche;
  return limpo;
}

/**
 * `definir_preparo_salsicha` apontando o LANCHE, e não a linha da salsicha.
 *
 * A ferramenta espera o id da linha que TEM a salsicha; o modelo entende
 * `item_id` como "onde a salsicha vai" e manda o lanche. Faz sentido do lado
 * dele — é a pergunta que o bot acabou de fazer ao cliente ("em qual
 * lanche?") — e é o que aconteceu no pedido #53: a ferramenta recusava, o
 * modelo devolvia a recusa como pergunta, e o cliente respondia a mesma
 * coisa de novo, cinco vezes, até o pedido fechar sem a salsicha.
 *
 * Em vez de recusar, o código faz o que a chamada quis dizer: acrescenta a
 * salsicha naquele lanche com o preparo pedido. Continua passando por
 * `personalizar` — que confere ambiguidade de lanche, cobra o adicional e
 * respeita `semPreparoInferido`; e por `adicaoSustentadaNoTexto`, para que
 * uma chamada solta não vire salsicha cobrada sem o cliente ter pedido.
 *
 * @returns {object|null} argumentos para `personalizar`, ou null para seguir
 *                        o caminho normal da ferramenta.
 */
function preparoApontandoOLanche(sess, args, contexto) {
  if (!['junto', 'a_parte'].includes(args?.modo)) return null;
  const linha = sess.cart.findLast((l) => String(l.id) === String(args.item_id || ''));
  if (!linha || salsicha.precisa(linha)) return null;
  if (!salsicha.lanches(sess).includes(linha)) return null;

  const item = cardapio.itemById('salsicha');
  if (!item || !cardapio.disponivel(item)) return null;
  if (Object.prototype.hasOwnProperty.call(contexto, 'textoCliente') &&
      !adicaoSustentadaNoTexto(sess, item, contexto.textoCliente)) {
    return null;
  }
  return { item_id: linha.id, acrescentar: ['salsicha'], preparo_salsicha: args.modo };
}

// --------------------------------------------------------- adicionar_item

const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * "3 x bacon" é lanche, não porção de bacon.
 *
 * Noite de 11/09: o modelo registrou "3 x bacon" como três porções do
 * adicional bacon em vez de três X Bacon. O "x" na frente do nome é a marca
 * do sanduíche; porção avulsa o cliente pede como "adicional", "porção" ou
 * "à parte". Devolve a recusa, com os lanches que levam esse nome, ou null.
 */
function adicionalPedidoComoLanche(item, texto) {
  if (item?.category?.id !== 'adicionais') return null;
  const normal = normalizarComparacao(texto);
  const nomes = nomesDoItem(item).map(normalizarComparacao).filter((n) => n.length >= 3);
  const nome = nomes.find((n) =>
    new RegExp(`\\bx\\s*-?\\s*${escaparRegex(n)}\\b`).test(normal) ||
    new RegExp(`\\bx${escaparRegex(n)}\\b`).test(normal));
  if (!nome) return null;
  const lanches = cardapio.allItems().filter((i) =>
    i.category?.id !== 'adicionais' &&
    normalizarComparacao(cardapio.nome(i, 'pt')).split(' ').includes(nome));
  const sugestao = lanches.map((i) => `${i.id} (${cardapio.nome(i, 'pt')})`).join(', ');
  return `Item NÃO adicionado: "${item.id}" é o ADICIONAL (porção extra), e o cliente escreveu ` +
    `"x ${nome}", que é um LANCHE. ${sugestao ? `Use o id do lanche: ${sugestao}.` : 'Use o id do lanche correspondente no cardápio.'}`;
}

/**
 * "Sem maionese" num lanche que não leva maionese não é erro: não há o que
 * tirar. Noite de 11/09: seis lanches "(sem maionese)" foram recusados de uma
 * vez, o modelo gastou uma rodada refazendo tudo, e um pedido de oito lanches
 * acabou em "Não entendi". Ingrediente conhecido que não faz parte do item sai
 * do pedido de remoção com uma nota; o desconhecido continua recusado por
 * `validar`. Item cadastrado sem lista de ingredientes aceita tirar qualquer
 * ingrediente conhecido — remoção é grátis, e a cozinha lê a linha.
 */
function ajustarRemocoes(item, remover = [], acrescentar = []) {
  const pedidos = unicos(remover);
  if (!modifiers.tem(item)) {
    const semLista = pedidos.length > 0 && !unicos(acrescentar).length &&
      pedidos.every((id) => modifiers.porId(id));
    return { remover: pedidos, ignorados: [], semLista };
  }
  const podeSair = new Set(item.modifiers.removable || []);
  const ignorados = pedidos.filter((id) => !podeSair.has(id) && modifiers.porId(id));
  return { remover: pedidos.filter((id) => !ignorados.includes(id)), ignorados, semLista: false };
}

function notaDeIgnorados(ajuste, lang) {
  if (!ajuste.ignorados.length) return '';
  // O id, não o nome do dicionário: "maionese" lê melhor que "Sachê de maionese".
  const nomes = ajuste.ignorados.map((id) => id.replace(/_/g, ' ')).join(', ');
  return ` Obs.: ${nomes} não faz parte deste lanche (não vem) — nada a remover; diga isso ao cliente numa frase curta.`;
}

/**
 * `quantidadeFinal`: o cliente refez o pedido — a quantidade dita substitui a
 * da linha que já estava no carrinho, em vez de somar a ela.
 */
function adicionar(sess, { item_id, quantidade = 1, remover = [], acrescentar = [], preparo_salsicha, lanche_id, unidades_lanche }, { quantidadeFinal = false } = {}) {
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
  const ajuste = ajustarRemocoes(item, remover, acrescentar);
  const val = ajuste.semLista
    ? { ok: true, removed: ajuste.remover, added: [], extra: 0 }
    : modifiers.validar(item, { remover: ajuste.remover, acrescentar });
  if (!val.ok) {
    return `Não consegui personalizar assim (${val.erro}${
      val.detalhe ? ': ' + val.detalhe.join(', ') : ''
    }). Ofereça só o que o item permite.`;
  }
  const nota = notaDeIgnorados(ajuste, lang);

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
    existing.qty = quantidadeFinal ? qty : existing.qty + qty;
    promotions.aplicarNaLinha(existing, item, val.extra, lang);
  } else {
    sess.cart.push(nova);
  }
  salsicha.reconciliar(sess);
  promotions.reprecificarCarrinho(sess.cart, lang);
  const linhaFinal = existing || nova;
  const rotulo = linhaFinal.name;

  // Sai do estado inicial para o fluxo saber que há carrinho em montagem.
  if (sess.state !== 'ORDER') sess.state = 'ORDER';

  const subtotal = session.getSubtotal(sess);
  if (existing && quantidadeFinal) {
    return `Quantidade final (o cliente refez o pedido): ${existing.qty}x ${rotulo} ` +
      `($${linhaFinal.price.toFixed(2)} cada). Linha: ${cartId}. Subtotal do carrinho: $${subtotal.toFixed(2)}.${nota}`;
  }
  return `Adicionado: ${qty}x ${rotulo} ($${linhaFinal.price.toFixed(2)} cada). Linha: ${cartId}. Subtotal do carrinho: $${subtotal.toFixed(2)}.${nota}`;
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

function linhaMencionadaNoTexto(line, texto) {
  const item = cardapio.itemById(produtoDaLinha(line));
  const nomes = [
    line.name,
    item?.id,
    item?.name?.pt,
    item?.name?.en,
    item?.name?.es,
  ].filter(Boolean);
  return nomeCitado(nomes, texto);
}

function distanciaEdicao(a, b) {
  const anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const atual = [i];
    for (let j = 1; j <= b.length; j++) {
      atual[j] = Math.min(
        atual[j - 1] + 1,
        anterior[j] + 1,
        anterior[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j < atual.length; j++) anterior[j] = atual[j];
  }
  return anterior[b.length];
}

/**
 * Um dos `nomes` aparece no texto, tolerando "x bacon" vs "x_bacon", plural,
 * e pequenos erros de digitação — o cliente digita como fala, não como o
 * `menu.json` grafa o id.
 */
function nomeCitado(nomes, texto) {
  const normal = normalizarComparacao(texto).replace(/[-_]+/g, ' ');
  const candidatos = nomes.filter(Boolean).map((nome) => normalizarComparacao(nome).replace(/[-_\s]+/g, ''));
  const palavras = normal.split(/\s+/).filter(Boolean);
  const trechos = [];
  for (let inicio = 0; inicio < palavras.length; inicio++) {
    for (let tamanho = 1; tamanho <= 4 && inicio + tamanho <= palavras.length; tamanho++) {
      trechos.push(palavras.slice(inicio, inicio + tamanho).join(''));
    }
  }
  return candidatos.some((nome) => trechos.some((trecho) => {
    if (trecho.includes(nome)) return true;
    if (nome.includes(trecho) && trecho.length >= 5) return true;
    // "coca" para "cocacola": o cliente diz o começo de um nome maior. Quatro
    // letras é o piso — abaixo disso "hot"/"bife" casariam com meio cardápio.
    if (nome.startsWith(trecho) && trecho.length >= 4) return true;
    const tolerancia = nome.length >= 9 ? 2 : nome.length >= 5 ? 1 : 0;
    return Math.abs(trecho.length - nome.length) <= tolerancia &&
      distanciaEdicao(trecho, nome) <= tolerancia;
  }));
}

/**
 * Quantas falas do cliente contam como "ele acabou de dizer isso".
 *
 * Três cobrem o vaivém de um esclarecimento — o bot pergunta, o cliente
 * responde, o bot confirma — sem esticar a ponto de um produto recusado há
 * muito tempo voltar sozinho.
 */
const FALAS_LEMBRADAS = 3;

/**
 * Guarda a fala do cliente na janela curta que a trava anti-invenção lê.
 *
 * Vive na sessão porque morre com ela: sessão nova, pedido reiniciado ou
 * expirado começam sem memória nenhuma, que é o comportamento certo.
 */
function lembrarFala(sess, texto) {
  const limpo = String(texto || '').trim();
  if (!limpo) return;
  sess.falasRecentes = [...(sess.falasRecentes || []), limpo].slice(-FALAS_LEMBRADAS);
  // Conta as falas: trava que vale "uma vez por mensagem" compara com isto.
  sess.turnoFala = (sess.turnoFala || 0) + 1;
}

/**
 * O cliente pediu este produto — nesta fala ou nas últimas dela?
 *
 * A trava nasceu olhando só a mensagem atual, e isso quebra em toda pergunta
 * de esclarecimento: o bot pergunta "em qual lanche vai o ovo?", o cliente
 * responde "no x-tudo", e a resposta legítima não repete "ovo". Em produção
 * (pedido #53) o cliente pediu salsicha cinco vezes e ela nunca entrou —
 * cada tentativa era barrada por não citar a palavra na mensagem daquele
 * turno, embora ele tivesse acabado de dizê-la.
 *
 * A defesa continua inteira: produto que o cliente NUNCA citou segue
 * bloqueado. O que muda é o alcance da pergunta — de uma mensagem para a
 * conversa recente, que é o que "o cliente pediu isso" sempre quis dizer.
 */
function adicaoSustentadaNoTexto(sess, item, texto) {
  const falas = [...new Set([...(sess.falasRecentes || []), String(texto || '')])];
  const nomes = [item.id, item.name?.pt, item.name?.en, item.name?.es, ...(item.aliases || [])];

  return falas.some((fala) => {
    const repeticao = /\b(?:o de sempre|igual da ultima|mesmo pedido|repete|repetir)\b/.test(
      normalizarComparacao(fala)
    );
    if (repeticao && (sess.lastItems || []).some((line) => produtoDaLinha(line) === item.id)) return true;
    return nomeCitado(nomes, fala);
  });
}

// ------------------------------------------ o que o cliente disse, de fato
//
// Travas nascidas da primeira noite real (10/09). Cada uma trata uma leitura
// errada que chegou ao pedido: o prompt pedia o certo, mas prompt não é trava.

function nomesDoItem(item) {
  return [item.id, item.name?.pt, item.name?.en, item.name?.es, ...(item.aliases || [])];
}

// "Salada" é alface e tomate — definição do dono. O modelo expandia para
// milho, batata palha e parmesão: no pedido #67 o cliente pediu o X-Tudão
// "sem salada" e recebeu sem batata e sem milho também.
const SALADA = ['alface', 'tomate'];
const SEM_SALADA =
  /\b(?:sem|tira|tirar|tire|retira|retirar|nao quero|no|sin|without)\s+(?:a\s+|o\s+|de\s+)?(?:salada|salad|ensalada)\b|\b(?:salada|salad|ensalada)\s+nao\b/;

/**
 * O ingrediente aparece na fala pelo nome exato (plural aceito).
 *
 * Sem a tolerância a erro de digitação do `nomeCitado`: entre ingredientes
 * ela confunde nome curto com nome curto — "molho" casava com "milho", e o
 * "1 molho extra" do pedido #67 contava como "sem milho".
 */
function ingredienteCitado(id, fala) {
  const alvo = ` ${normalizarComparacao(fala).replace(/[-_]+/g, ' ')} `;
  const nomes = [id.replace(/_/g, ' '), modifiers.nomeDe(id, 'pt'), modifiers.nomeDe(id, 'en'), modifiers.nomeDe(id, 'es')]
    .map((nome) => normalizarComparacao(nome).replace(/[-_]+/g, ' '))
    .filter(Boolean);
  return nomes.some((nome) => alvo.includes(` ${nome} `) || alvo.includes(` ${nome}s `));
}

/**
 * As remoções que o cliente pediu, com "salada" valendo alface e tomate.
 *
 * Só age quando a mensagem atual tira a salada E a lista do modelo é a da
 * salada (tem alface/tomate, ou ingrediente que o cliente não citou). Aí
 * ficam alface, tomate e o que ele citou pelo nome; o resto cai. Lista
 * justificada nome a nome ("sem cebola" no outro lanche da mesma frase) passa
 * intacta.
 */
function remocoesPedidas(sess, item, remover, texto) {
  const lista = Array.isArray(remover) ? remover : [];
  if (!lista.length || !item || !SEM_SALADA.test(normalizarComparacao(texto))) return lista;

  const falas = [...new Set([...(sess.falasRecentes || []), String(texto || '')])];
  const citado = (id) => falas.some((fala) => ingredienteCitado(id, fala));
  const listaDaSalada = lista.some((id) => SALADA.includes(id) || !citado(id));
  if (!listaDaSalada) return lista;

  const removiveis = item.modifiers?.removable || [];
  return unicos([
    ...lista.filter((id) => SALADA.includes(id) || citado(id)),
    ...SALADA.filter((id) => removiveis.includes(id)),
  ]);
}

// Pergunta não é pedido. "Tem cachorro quente?" e "quanto tempo pra ficar
// pronto um x-tudão?" viraram itens no carrinho na primeira noite real.
const VERBO_DE_PEDIDO = new RegExp(
  '\\b(?:quero|queria|gostaria|vou querer|vou pedir|pedir|pede|peco|me ve|me da|me de|' +
  'me manda|me mande|manda|mande|mandar|envia|envie|enviar|traz|traga|trazer|' +
  'adiciona|adicione|adicionar|acrescenta|acrescente|acrescimo|coloca|coloque|colocar|' +
  'poe|bota|pode ser|faz|faca|fazer|separa|vou levar|mais um|mais uma|inclui|incluir|' +
  'pega|pegar|want|would like|give me|add|quiero|dame|agrega)\\b'
);
const PERGUNTA_NO_INICIO = new RegExp(
  '^(?:tem|voces tem|vcs tem|voce tem|vc tem|ainda tem|ha|quanto|quantos|quantas|qual|' +
  'quais|como|onde|quando|que horas|sera|existe|fazem|voces fazem|vcs fazem|vendem|' +
  'voces vendem|do you have|how much|how long|what|tienen|cuanto|cual)\\b'
);
const ACEITE = new RegExp(
  '^(?:sim|s|ss|pode|isso|quero|claro|ok|okay|beleza|blz|bora|manda|adiciona|coloca|' +
  'com certeza|yes|yep|si|dale|fechado|perfeito|uhum|aham|pode ser|vou querer)\\b'
);

function frases(texto) {
  return String(texto || '')
    .split(/\n+|(?<=[.!?])\s+/)
    .map((frase) => frase.trim())
    .filter(Boolean);
}

function ehPergunta(frase) {
  return /\?\s*$/.test(frase) || PERGUNTA_NO_INICIO.test(normalizarComparacao(frase));
}

function pedeAlgo(frase) {
  return VERBO_DE_PEDIDO.test(normalizarComparacao(frase));
}

function aceitou(fala) {
  const n = normalizarComparacao(fala);
  if (/^(?:nao|no|n)\b/.test(n)) return false;
  return ACEITE.test(n) || VERBO_DE_PEDIDO.test(n);
}

/**
 * O cliente só perguntou sobre o produto — ainda não pediu.
 *
 * A fala mais recente que cita o produto decide. Se ele aparece só dentro de
 * perguntas sem verbo de pedido ("tem x-tudo?", "quanto custa o x-tudo?"), e
 * nada depois disso aceitou, o produto não entra: o modelo responde e
 * pergunta se ele quer. "Pode me mandar um x-tudo?" é pedido, e "tem coca?
 * manda uma" também.
 */
function soPerguntou(sess, item, texto) {
  const nomes = nomesDoItem(item);
  const atual = String(texto || '').trim();
  const falas = [...(sess.falasRecentes || [])];
  if (falas[falas.length - 1] !== atual) falas.push(atual);

  for (let i = falas.length - 1; i >= 0; i--) {
    const partes = frases(falas[i]);
    const citam = partes.map((frase, j) => (nomeCitado(nomes, frase) ? j : -1)).filter((j) => j >= 0);
    if (!citam.length) continue;

    const soPergunta = citam.every((j) => {
      if (!ehPergunta(partes[j]) || pedeAlgo(partes[j])) return false;
      const seguinte = partes[j + 1];
      return !(seguinte && pedeAlgo(seguinte) && seguinte.split(/\s+/).length <= 4);
    });
    if (!soPergunta) return false;
    return !falas.slice(i + 1).some(aceitou);
  }
  return false;
}

// Pedido refeito: a quantidade dita é a final, e a lista nova substitui a
// velha. No pedido #68 o cliente trocou "2 hot plain, 2 guaraná" por "1 hot
// plain, 1 hot duplo, 1 guaraná" e o bot somou tudo; foram três correções
// até o resumo ficar certo.
const REFAZ_PEDIDO = new RegExp(
  '\\b(?:pode ser entao|entao pode ser|hoje pode ser|vai ser entao|entao vai ser|' +
  'vou querer entao|entao vou querer|o pedido vai ser|o pedido fica|fica assim|' +
  'refaz\\w* o pedido|muda\\w* o pedido|troca\\w* o pedido|novo pedido)\\b'
);
const CORRIGE_QUANTIDADE = /\b(?:na verdade|corrig\w*|me enganei|errei|desculpa|desculpe|ao inves|em vez)\b/;
const SOMA = /\b(?:mais|tambem|adiciona\w*|acrescenta\w*|outro|outra|outros|outras|junto|alem)\b/;

function itensCitados(texto) {
  return cardapio.allItems().filter((item) => nomeCitado(nomesDoItem(item), texto)).length;
}

/**
 * A mensagem refaz o pedido? Devolve null, ou `{ substituir }`.
 *
 * - quantidade final: "na verdade", "desculpa", "então pode ser…" ou a mesma
 *   mensagem mandada de novo — o que ela cita fica com a quantidade dita;
 * - substituir: a lista inteira veio de novo ("hoje pode ser então: A, B e
 *   C") — o que ela não cita sai do carrinho.
 *
 * "Mais", "também", "outro" desligam as duas: aí é acréscimo mesmo.
 */
function pedidoRefeito(sess, texto) {
  const n = normalizarComparacao(texto);
  const anteriores = (sess.falasRecentes || []).slice(0, -1).map(normalizarComparacao);
  const repetida = n.length >= 12 && anteriores.includes(n);
  const refaz = REFAZ_PEDIDO.test(n);
  if (!repetida && !refaz && !CORRIGE_QUANTIDADE.test(n)) return null;
  if (SOMA.test(n)) return null;
  return { substituir: refaz && itensCitados(texto) >= 2 };
}

/** Tira do carrinho o que a lista refeita não cita — uma vez por mensagem. */
function aplicarListaRefeita(sess, texto) {
  if (sess.listaRefeitaNoTurno === sess.turnoFala) return;
  sess.listaRefeitaNoTurno = sess.turnoFala;
  const antes = sess.cart.length;
  sess.cart = sess.cart.filter((line) => linhaMencionadaNoTexto(line, texto));
  if (sess.cart.length !== antes) {
    salsicha.reconciliar(sess);
    promotions.reprecificarCarrinho(sess.cart, sess.lang || 'pt');
  }
}

function personalizar(sess, args, contexto = {}) {
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

  /**
   * "Em qual lanche?" vale para QUALQUER adicional, não só salsicha.
   *
   * Esta trava nasceu só para salsicha, porque só salsicha tinha o dilema
   * extra de "junto ou à parte". Mas a ambiguidade de ALVO — "acrescenta
   * ovo" com um X-Bacon e um X-Tudo no carrinho, sem dizer em qual — é a
   * mesma para qualquer ingrediente. Deixar só a salsicha coberta significava
   * que o modelo escolhia sozinho (e calado) qual sanduíche levava o ovo, o
   * bacon extra, o que fosse — o cliente só via "mais alguma coisa?", sem
   * nunca ter sido perguntado qual dos dois.
   *
   * `target` já foi resolvido pelo `item_id` que o modelo mandou (linhas
   * acima) — o que este bloco verifica não é "existe esse item no carrinho",
   * é "o cliente de fato apontou ESTE sanduíche na mensagem, ou o modelo
   * escolheu por conta própria entre vários possíveis".
   */
  // Só exige a marcação quando existe texto do cliente para conferir contra
  // — mesmo critério de `definirEndereco`/`definirCadastro`. Chamada
  // programática (sem `contexto.textoCliente`, como nos testes que montam o
  // carrinho direto) não tem o que checar, e bloquear ali quebraria toda
  // automação que nunca teve esse dado pra fornecer.
  const acrescentando = args.acrescentar || [];
  const temTextoCliente = Object.prototype.hasOwnProperty.call(contexto, 'textoCliente');
  if (acrescentando.length && temTextoCliente) {
    const lanches = (sess.cart || []).filter((line) =>
      ['sanduiches', 'hotdogs', 'massas'].includes(
        cardapio.itemById(produtoDaLinha(line))?.category?.id
      )
    );
    const textoCliente = String(contexto.textoCliente || '');
    if (lanches.length > 1 && !linhaMencionadaNoTexto(target, textoCliente)) {
      const nomesLanches = lanches.map((line) =>
        cardapio.nome(cardapio.itemById(produtoDaLinha(line)), sess.lang || 'pt')
      );
      const opcoes = nomesLanches.join(' ou ');

      if (acrescentando.includes('salsicha')) {
        sess.perguntaSalsichaObrigatoria = { opcoes: nomesLanches };
        return bloqueio(
          'Salsicha NÃO adicionada: o cliente não indicou em qual lanche e há vários no carrinho. ' +
          `Faça UMA única pergunta, em uma única mensagem: em qual lanche (${opcoes}) ele quer ` +
          'a salsicha e se ela vai junto ou à parte. Não escolha o lanche por conta própria.'
        );
      }

      const nomesIngredientes = acrescentando.join(', ');
      return bloqueio(
        `Adicional NÃO registrado (${nomesIngredientes}): o cliente não indicou em qual lanche ` +
        `e há vários no carrinho. Faça UMA única pergunta: em qual lanche (${opcoes}) ele quer ` +
        `${nomesIngredientes}. Não escolha por conta própria — pergunte e chame personalizar_item de novo.`
      );
    }
  }
  // Limpa a pergunta obrigatória de salsicha independentemente de ter havido
  // texto do cliente pra conferir — é limpeza de estado, não validação.
  if (acrescentando.includes('salsicha')) sess.perguntaSalsichaObrigatoria = null;

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
  const ajuste = ajustarRemocoes(item, removed, added);
  const val = ajuste.semLista
    ? { ok: true, removed: ajuste.remover, added: [], extra: 0 }
    : modifiers.validar(item, { remover: ajuste.remover, acrescentar: added });
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
  const absorvidos = absorverAdicionaisAvulsos(sess, val.added, atual.added, quantidade);
  salsicha.reconciliar(sess);
  promotions.reprecificarCarrinho(sess.cart, lang);

  const subtotal = session.getSubtotal(sess);
  return {
    resultado:
      `Alterado: ${quantidade}x ${nova.name} ($${nova.price.toFixed(2)} cada). Linha: ${nova.id}. ` +
      (absorvidos.length
        ? `Já havia ${absorvidos.join(', ')} avulso no carrinho: usei essa unidade no lanche, sem cobrar de novo. `
        : '') +
      `Subtotal do carrinho: $${subtotal.toFixed(2)}.` + notaDeIgnorados(ajuste, lang),
  };
}

/**
 * O adicional que já estava no carrinho como produto avulso vira o acréscimo
 * do lanche, em vez de ser cobrado outra vez.
 *
 * Todo adicional existe duas vezes no cardápio: como produto da categoria
 * "Adicionais" e como ingrediente acrescentável. O cliente que diz "ovo" e,
 * na pergunta seguinte, "no x-tudo" pediu UM ovo — mas o modelo registrava o
 * produto na primeira mensagem e o ingrediente na segunda, e o cliente pagava
 * os dois. Medido: $36 num pedido que devia dar $34.
 *
 * A salsicha fica de fora porque tem caminho próprio: ela é bloqueada antes
 * de chegar aqui e resolvida por `definir_preparo_salsicha`, que move a
 * avulsa para dentro do lanche sem tocar no preço.
 *
 * Só absorve o que ACABOU de ser acrescentado (`novos` menos `anteriores`):
 * repersonalizar um lanche que já tinha ovo não pode comer um ovo avulso que
 * o cliente pediu de propósito à parte.
 */
function absorverAdicionaisAvulsos(sess, novos, anteriores, quantidade) {
  const recemAdicionados = novos.filter((id) => id !== 'salsicha' && !anteriores.includes(id));
  const absorvidos = [];

  for (const id of recemAdicionados) {
    const avulso = sess.cart.findLast((line) => produtoDaLinha(line) === id);
    if (!avulso) continue;
    absorvidos.push(cardapio.nome(cardapio.itemById(id), sess.lang || 'pt'));
    avulso.qty -= quantidade;
    if (avulso.qty <= 0) sess.cart.splice(sess.cart.indexOf(avulso), 1);
  }
  return absorvidos;
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

/**
 * "Tira esse" com mais de um lanche no carrinho não diz qual.
 *
 * Apareceu quando o cliente passou a poder citar o resumo com o *responder*
 * do WhatsApp: citando a lista inteira e dizendo "tira esse", o modelo tirou
 * os dois. Carrinho esvaziado é estrago que o cliente só percebe depois —
 * então, sem o produto citado na fala e com mais de uma linha, pergunte.
 */
function removerAmbiguo(sess, item_id, texto) {
  if ((sess.cart || []).length < 2) return null;
  const item = cardapio.itemById(produtoDaLinha({ id: item_id }));
  const linha = sess.cart.find((l) => String(l.id) === String(item_id));
  const nomes = item ? nomesDoItem(item) : [];
  if (linha?.name) nomes.push(linha.name);
  if (nomeCitado(nomes.filter(Boolean), texto)) return null;

  const lista = sess.cart.map((l) => `${l.qty}x ${l.name} [${l.id}]`).join('; ');
  return `Item NÃO removido: o cliente não disse qual tirar e há mais de um no carrinho (${lista}). ` +
    'Pergunte qual deles ele quer tirar e espere a resposta.';
}

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
  if (sess.orderType && !sess.paymentMethod) {
    faltas.push('paymentMethod');
  }
  if (sess.orderType === 'delivery' && (!sess.city || !sess.address)) {
    faltas.push(!sess.city && !sess.address ? 'endereco' : !sess.city ? 'city' : 'address');
  }
  if (!sess.name) faltas.push('name');
  return faltas;
}

/**
 * Trava deterministica para a passagem da conversa ao resumo oficial.
 *
 * O modelo ajuda a entender o que o cliente escreveu, mas nao decide se o
 * pedido esta pronto nem redige a confirmacao. Quando esta funcao retorna
 * true, `finalizar_pedido` pode assumir com os valores calculados pelo codigo.
 */
function prontoParaResumo(sess) {
  return Boolean(
    sess.cart?.length &&
    !require('../services/mais-itens').pendente(sess) &&
    !salsicha.pergunta(sess) &&
    !mensagemCobertura(sess) &&
    faltando(sess).length === 0
  );
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
  if (sess.paymentMethod === 'zelle') sabidos.push('pagamento: ZELLE');
  if (sess.paymentMethod === 'cash') sabidos.push('pagamento: CASH');
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
  if (!sess.paymentMethod) {
    return jaSabemos(sess) + ' Pergunte somente: "Zelle ou cash?". Não peça nome ou endereço ainda.';
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
  if (Object.prototype.hasOwnProperty.call(contexto, 'textoCliente')) {
    const texto = normalizarComparacao(contexto.textoCliente);
    const sustentada = tipo === 'pickup'
      ? /\b(?:retirada|retirar|buscar|pegar|balcao|pickup)\b/.test(texto)
      : /\b(?:entrega|delivery|manda|mandar|levar|trazer|mesmo endereco)\b/.test(texto) ||
        Boolean(delivery.extrairCidadeEndereco(contexto.textoCliente));
    if (!sustentada) {
      return bloqueio(
        'Tipo de atendimento NÃO registrado: a mensagem atual não disse entrega nem retirada. ' +
        'Não suponha; responda que não entendeu ou faça uma pergunta curta se houver pedido no carrinho.'
      );
    }
  }
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
  if (!sess.paymentMethod) {
    sess.state = 'PAYMENT_METHOD';
    return t(lang, 'payment_method_ask');
  }
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
  if (!(sess.cart || []).length) {
    return bloqueio(`Cidade NÃO registrada: o carrinho está vazio. ${PRIMEIRO_O_PRODUTO}`);
  }
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
  if (!(sess.cart || []).length) {
    return bloqueio(`Endereço NÃO registrado: o carrinho está vazio. ${PRIMEIRO_O_PRODUTO}`);
  }
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
  await order.startCheckout(sess, send);
  return true;
}

// Respostas que chegam no lugar do nome, mas não são nome de ninguém.
const NAO_E_NOME = new Set([
  'cliente', 'customer', 'client', 'nome', 'name', 'usuario', 'user', 'teste', 'test',
  'entrega', 'retirada', 'delivery', 'pickup', 'zelle', 'zell', 'cash', 'dinheiro',
  'sim', 'nao', 'ok', 'oi', 'ola', 'pedido', 'obrigado', 'obrigada',
  'bom dia', 'boa tarde', 'boa noite',
  // "Esse" virou nome de cliente em 11/09.
  'esse', 'essa', 'isso', 'isto', 'aquele', 'aquela', 'ele', 'ela', 'eu', 'voce', 'vc',
  'nao sei', 'sei la', 'menu', 'cardapio', 'catalogo',
]);
const APRESENTACAO = /\b(?:meu nome e|meu nome|me chamo|sou o|sou a|eu sou|nome e|my name is|i am|me llamo|soy)\b/;

/**
 * O "nome" que o modelo quer gravar é, na verdade, a cidade ou uma palavra
 * genérica? Devolve o motivo, ou null.
 *
 * Pedido #71: o cliente respondeu "Everett" à pergunta da cidade e virou
 * "Everett" também no nome — a trava literal passava, porque a palavra estava
 * mesmo na mensagem. Cidade também é nome de gente ("Chelsea"): quem se
 * apresenta ("meu nome é Chelsea") ou repete depois de perguntado, passa.
 */
function nomeImprovavel(sess, nome, texto) {
  const n = normalizarComparacao(nome);
  if (NAO_E_NOME.has(n)) return `"${nome}" não é nome de pessoa.`;

  const cidades = delivery.getCities().flatMap((c) => [c.label, c.id]).map(normalizarComparacao);
  if (sess.city?.label) cidades.push(normalizarComparacao(sess.city.label));
  if (!cidades.includes(n)) return null;

  const repetiu = sess.nomeRecusado?.nome === n && sess.nomeRecusado.turno < (sess.turnoFala || 0);
  if (APRESENTACAO.test(normalizarComparacao(texto)) || repetiu) return null;

  sess.nomeRecusado = { nome: n, turno: sess.turnoFala || 0 };
  return `"${nome}" é a CIDADE da entrega, não o nome do cliente.`;
}

function definirCadastro(sess, { nome, email }, contexto = {}) {
  if (!(sess.cart || []).length) {
    return bloqueio(`Nome NÃO registrado: o carrinho está vazio. ${PRIMEIRO_O_PRODUTO}`);
  }
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
    const motivo = !mesmoConhecido && nomeImprovavel(sess, limpo, contexto.textoCliente);
    if (motivo) {
      return bloqueio(`Nome NAO REGISTRADO: ${motivo} Pergunte o nome do cliente e espere a resposta.`);
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
  paymentMethod: 'a FORMA DE PAGAMENTO: Zelle ou cash (chame definir_pagamento)',
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
  prontoParaResumo,
  orientacao: oQueFalta,
  observarMensagem,
  lembrarFala,
  logisticaPulada,
  tipoCorrigido,
  confirmarEnderecoPendente,
  mensagemAposEntrega,
  mensagemColeta,
  mensagemCobertura,
};
