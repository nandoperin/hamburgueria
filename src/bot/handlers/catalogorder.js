const { t, DEFAULT_LANG } = require('../../i18n');
const log = require('../../log');
const catalog = require('../../services/catalog');
const notify = require('../notify');
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

function quantidadeSegura(bruta, retailerId) {
  const n = Math.floor(Number(bruta));
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > QTD_MAX) {
    log.warn(
      { evt: 'carrinho', produto: retailerId, quantidade: bruta, teto: QTD_MAX },
      'quantidade acima do teto — limitada'
    );
    return QTD_MAX;
  }
  return n;
}

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
const fantasmasAvisados = new Set();

async function avisarDono(retailerIds) {
  const novos = retailerIds.filter((id) => id && !fantasmasAvisados.has(id));
  if (!novos.length) return;

  novos.forEach((id) => fantasmasAvisados.add(id));

  const admin = notify.dono();
  if (!admin) return;

  await notify.send(
    admin,
    require('../../texto').paraAdmin(
      `👻 *PRODUTO FANTASMA NO CATÁLOGO*\n\n` +
        `Um cliente escolheu e o bot não reconheceu:\n${novos.map((id) => `• ${id}`).join('\n')}\n\n` +
        `Ele existe no catálogo da Meta mas não em config/menu.json, então saiu do ` +
        `carrinho e o cliente foi avisado.\n\nUse *!catalogo* para ver tudo que está divergente.`
    )
  );
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
 * Entrada principal — recebe o carrinho montado no catálogo.
 *
 * `productItems` vem do webhook em snake_case: product_retailer_id, quantity.
 */
async function handleCartOrder(session, productItems, send) {
  const lang = session.lang || DEFAULT_LANG;
  session.lang = lang;
  session.pendingCombos = [];

  const unknown = [];
  const esgotados = [];

  for (const entry of productItems || []) {
    const retailerId = entry.product_retailer_id || entry.productRetailerId;
    const quantity = quantidadeSegura(entry.quantity, retailerId);
    const item = catalog.itemByRetailerId(retailerId);

    if (!item) {
      unknown.push(retailerId);
      continue;
    }

    // O catálogo da Meta não sabe o que esgotou hoje — quem sabe é o banco.
    if (!menuHandler.itemDisponivel(item)) {
      esgotados.push(labelOf(item, lang));
      continue;
    }

    if (catalog.needsOptions(item)) {
      queueCombo(session, item, quantity, lang);
      continue;
    }

    for (let i = 0; i < quantity; i += 1) {
      menuHandler.addSimpleItem(session, item, lang);
    }
  }

  if (unknown.length) {
    log.warn(
      { evt: 'carrinho', produtos: unknown },
      'produtos do catálogo sem correspondência no cardápio'
    );
    // O cliente escolheu, e o item sumiu do resumo. Sem esta linha ele recebia
    // um total menor do que montou, ou "carrinho vazio", sem nenhuma pista.
    await send(t(lang, 'catalog_unknown'));
    await avisarDono(unknown);
  }

  // Avisar antes do resumo: o cliente precisa saber por que o total mudou.
  if (esgotados.length) {
    await send(t(lang, 'catalog_sold_out', { items: esgotados.join(', ') }));
  }

  if (!session.cart.length && !session.pendingCombos.length) {
    await send(t(lang, 'catalog_empty'));
    return;
  }

  // Sem "recebi seu carrinho": a mensagem seguinte já prova o recebimento —
  // ou pergunta a escolha nomeando o combo, ou lista os itens no resumo.
  if (session.pendingCombos.length) {
    session.state = 'CATALOG_OPTIONS';
    await askNextCombo(session, send);
    return;
  }

  await continueAfterCart(session, send);
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
  const carrinho = orderHandler.oQueFalta(session)
    ? menuHandler.buildCartSummary(session)
    : null;

  // Quem cobra o que falta é o checkout, na mesma ordem do fluxo de texto —
  // entrega, endereço, cadastro. Duplicar a sequência aqui era como as duas
  // versões saíam de sincronia.
  await orderHandler.startCheckout(session, send, carrinho);
}

module.exports = { handleCartOrder, handleChoice, continueAfterCart, CHOICE_PREFIX };
