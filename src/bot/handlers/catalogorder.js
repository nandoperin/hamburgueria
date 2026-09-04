const { t, DEFAULT_LANG } = require('../../i18n');
const catalog = require('../../services/catalog');
const cardapio = require('../../services/cardapio');
const notify = require('../notify');
const { publicErrorKey } = require('../catalog/adapters');
const ia = require('../../ai/provider');
const agente = require('../../ai/agente');
const menuHandler = require('./menu');
const orderHandler = require('./order');

/**
 * Pedidos vindos do catálogo do WhatsApp.
 *
 * O catálogo não tem opções nem modificadores: o cliente só consegue somar
 * SKUs fechados ao carrinho. Os itens simples entram direto; os combos que
 * ainda exigem escolha (`options.picks`) entram sem ela definida, então quando
 * o carrinho chega a gente enfileira uma pergunta por unidade e resolve as
 * escolhas aqui no chat, com lista tocável.
 *
 * Um combo que pede duas escolhas, e "x3" no carrinho, pedem várias vezes —
 * daí a fila ser por unidade, e não por linha do carrinho.
 */

const CHOICE_PREFIX = 'opcao:';

/**
 * Teto de unidades por linha do carrinho.
 *
 * A quantidade é o único número que chega do cliente e vai direto para um
 * laço — o preço sempre sai do `menu.json`, então valor não é manipulável. Mas
 * a interface do WhatsApp limita a 99 por item, e nada garante que o payload
 * respeite isso: qualquer cliente modificado, ou o WhatsApp Web com o JS
 * alterado, pode mandar o que quiser.
 *
 * Sem teto, um combo com quantidade absurda enfileira uma pergunta de escolha
 * por unidade — e cada pergunta é uma mensagem cobrada.
 */
const QTD_MAX = 99;
const QTD_TOTAL_MAX = 200;

function labelOf(item, lang) {
  return item.name[lang] || item.name.en;
}

/**
 * Produto que existe no catálogo da Meta e não no cardápio.
 *
 * É erro de configuração, e está custando dinheiro **agora**: o cliente
 * escolheu e não vai receber. A checagem da subida e o `!catalogo` acham isso
 * também, mas só quando alguém olha — aqui o problema se anuncia.
 *
 * Um aviso por produto e por processo: se cinco clientes tocarem no mesmo item
 * fantasma, o dono recebe uma mensagem, não cinco.
 */
const produtosAvisados = new Set();

async function avisarDono(erro, produtos) {
  const novos = produtos.filter((produto) => {
    const chave = `${erro}:${String(produto || '').slice(0, 120)}`;
    if (produtosAvisados.has(chave)) return false;
    produtosAvisados.add(chave);
    return true;
  });
  if (!novos.length) return;

  const admin = notify.dono();
  if (!admin) return;

  await notify.send(admin, require('../../texto').paraAdmin(
    `CATALOGO DIVERGENTE\n\nMotivo: ${erro}\n` +
    novos.map((produto) => `- ${produto}`).join('\n')
  ));
}

function validarPedido(order) {
  if (!['baileys', 'meta'].includes(order?.source)) {
    return { ok: false, erro: 'origem_invalida', produtos: [] };
  }
  if (!String(order.externalOrderId || '').trim() || !Array.isArray(order.items) || !order.items.length) {
    return { ok: false, erro: 'pedido_vazio', produtos: [] };
  }

  let total = 0;
  const linhas = [];
  for (const entry of order.items) {
    const quantity = Number(entry.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > QTD_MAX) {
      return { ok: false, erro: 'quantidade_invalida', produtos: [entry.externalProductId] };
    }
    total += quantity;
    if (total > QTD_TOTAL_MAX) {
      return { ok: false, erro: 'quantidade_total', produtos: [] };
    }

    const item = cardapio.itemById(entry.productId);
    if (!item) return { ok: false, erro: 'produto_desconhecido', produtos: [entry.productId] };
    if (!cardapio.disponivel(item)) {
      return { ok: false, erro: 'produto_esgotado', produtos: [cardapio.nome(item, 'pt')] };
    }
    linhas.push({ item, quantity });
  }
  return { ok: true, linhas };
}

function aplicarLinhas(sess, linhas, lang) {
  for (const { item, quantity } of linhas) {
    const existing = sess.cart.find((line) => line.id === item.id);
    if (existing) {
      existing.qty += quantity;
      continue;
    }
    sess.cart.push({
      id: item.id,
      productId: item.id,
      name: cardapio.nome(item, lang),
      nomeCozinha: cardapio.nomeCozinha(item),
      choicesCozinha: [],
      removed: [],
      added: [],
      qty: quantity,
      price: item.price,
    });
  }
}

function jaRecebido(sess, externalOrderId) {
  return (sess.catalogOrderIds || []).includes(externalOrderId);
}

function marcarRecebido(sess, externalOrderId) {
  sess.catalogOrderIds = [...(sess.catalogOrderIds || []), externalOrderId].slice(-20);
}

async function responderRecusa(sess, order, validacao, send) {
  const mostrarProdutos = order?.source === 'baileys';
  const lang = sess.lang || DEFAULT_LANG;
  await send(t(
    lang,
    publicErrorKey(validacao.erro),
    { items: mostrarProdutos ? validacao.produtos.join(', ') : t(lang, 'catalog_item_generic') }
  ));
}

/** Enfileira uma pergunta por unidade do combo. */
function queueCombo(session, comboItem, quantity, lang) {
  for (let unit = 1; unit <= quantity; unit += 1) {
    session.pendingCombos.push({
      comboId: comboItem.id,
      baseName: labelOf(comboItem, lang),
      basePrice: comboItem.price,
      surcharge: comboItem.options.surcharge || {},
      picks: comboItem.options.picks,
      fromCategory: comboItem.options.from_category,
      chosen: [],
      unit,
      units: quantity,
    });
  }
}

/**
 * Entrada principal — recebe um carrinho normalizado pelos adaptadores.
 */
async function handleCartOrder(session, order, send, validacaoPronta = null) {
  if (jaRecebido(session, order?.externalOrderId)) {
    await send(t(session.lang || DEFAULT_LANG, 'catalog_duplicate'));
    return { status: 'duplicate', session };
  }

  const validacao = validacaoPronta || validarPedido(order);
  if (!validacao.ok) {
    await responderRecusa(session, order, validacao, send);
    if (['produto_desconhecido', 'produto_ambiguo', 'produto_esgotado'].includes(validacao.erro)) {
      await avisarDono(validacao.erro, validacao.produtos);
    }
    return { status: 'rejected', session };
  }

  const lang = session.lang || DEFAULT_LANG;
  session.lang = lang;
  session.pendingCombos = [];
  session.menuSelection = null;
  aplicarLinhas(session, validacao.linhas, lang);
  agente.registrarSaudacao(session, 'Carrinho registrado pelo sistema: ' +
    session.cart.map(l => `[${l.id}] ${l.qty}x ${l.name}`).join('; '));
  marcarRecebido(session, order.externalOrderId);
  if (session.state === 'LANGUAGE') session.state = 'ORDER';
  await continueAfterCart(session, send);
  return { status: 'applied', session };
}

/** Pergunta a escolha do próximo combo da fila, com lista tocável. */
async function askNextCombo(session, send) {
  const lang = session.lang;
  const pending = session.pendingCombos[0];

  if (!pending) {
    await continueAfterCart(session, send);
    return;
  }

  const choices = catalog
    .itemsOfCategory(pending.fromCategory)
    .filter((item) => menuHandler.itemDisponivel(item));

  const rows = choices.map((choice) => {
    const extra = pending.surcharge[choice.id] || 0;
    return {
      id: `${CHOICE_PREFIX}${choice.id}`,
      title: labelOf(choice, lang),
      description: extra ? t(lang, 'catalog_surcharge', { amount: extra.toFixed(2) }) : '',
    };
  });

  // "Combo 1" quando é único; "Combo 1 (2 de 3)" quando o cliente pediu vários.
  const unitLabel =
    pending.units > 1
      ? `${pending.baseName} (${pending.unit}/${pending.units})`
      : pending.baseName;

  const body =
    pending.picks > 1
      ? t(lang, 'catalog_ask_meat_n', {
          item: unitLabel,
          current: pending.chosen.length + 1,
          total: pending.picks,
        })
      : t(lang, 'catalog_ask_meat', { item: unitLabel });

  // Guardado para o fallback em texto, onde o cliente responde o número.
  session.pendingChoiceRows = await notify.sendList(session.phone, {
    body,
    button: t(lang, 'catalog_meat_button'),
    sections: [{ title: t(lang, 'catalog_meat_section'), rows }],
  });
}

/**
 * Estado CATALOG_OPTIONS — resposta da lista de escolhas.
 *
 * Aceita tanto o id da linha (lista nativa) quanto o número (fallback texto).
 */
async function handleChoice(session, text, send) {
  const lang = session.lang;
  const pending = session.pendingCombos[0];

  if (!pending) {
    await continueAfterCart(session, send);
    return;
  }

  const input = String(text).trim();
  let choiceId = null;

  if (input.startsWith(CHOICE_PREFIX)) {
    choiceId = input.slice(CHOICE_PREFIX.length);
  } else if (/^\d+$/.test(input)) {
    const row = (session.pendingChoiceRows || [])[Number(input) - 1];
    if (row) choiceId = row.id.slice(CHOICE_PREFIX.length);
  }

  const choice = choiceId ? catalog.itemByRetailerId(choiceId) : null;
  if (!choice) {
    await send(t(lang, 'option_invalid'));
    await askNextCombo(session, send);
    return;
  }

  pending.chosen.push(choice);

  if (pending.chosen.length < pending.picks) {
    await askNextCombo(session, send);
    return;
  }

  menuHandler.pushCombo(session, {
    comboId: pending.comboId,
    baseName: pending.baseName,
    basePrice: pending.basePrice,
    surcharge: pending.surcharge,
    chosen: pending.chosen,
    lang,
  });

  session.pendingCombos.shift();

  if (session.pendingCombos.length) {
    await askNextCombo(session, send);
    return;
  }

  session.pendingChoiceRows = null;
  await continueAfterCart(session, send);
}

/**
 * Carrinho resolvido — segue para o fechamento.
 *
 * O carrinho só acompanha o checkout quando ele vai **interromper** para pedir
 * alguma coisa (endereço, nome): ali o cliente precisa ver o que está comprando
 * antes de digitar. Se o checkout for direto ao resumo, a lista não vai — o
 * resumo já traz os mesmos itens, com subtotal, taxa e total, e mostrar antes
 * seria a mesma lista duas vezes em poucos segundos.
 *
 * E quando vai, vai **junto** da pergunta, não numa mensagem própria.
 */
async function continueAfterCart(session, send) {
  const pergunta = require('../../services/preparo-salsicha').pergunta(session);
  if (pergunta) {
    session.state = 'ORDER';
    await send(pergunta);
    agente.registrarSaudacao(session, pergunta);
    return;
  }
  const falta = orderHandler.oQueFalta(session);
  if (ia.habilitada() && falta) {
    const tratou = await agente.receberCarrinho(session, send);
    if (tratou) return;
  }

  const carrinho = falta
    ? menuHandler.buildCartSummary(session)
    : null;

  // Quem cobra o que falta é o checkout, na mesma ordem do fluxo de texto —
  // entrega, endereço, cadastro. Duplicar a sequência aqui era como as duas
  // versões saíam de sincronia.
  await orderHandler.startCheckout(session, send, carrinho);
}

module.exports = {
  handleCartOrder,
  handleChoice,
  continueAfterCart,
  validarPedido,
  avisarDono,
  CHOICE_PREFIX,
};
