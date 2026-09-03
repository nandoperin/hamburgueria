const { t } = require('../../i18n');
const config = require('../../services/config');
const notify = require('../notify');
const availability = require('../../services/availability');
const catalog = require('../../services/catalog');

const TAG_EMOJI = {
  bestseller: '⭐',
  new: '🆕',
  spicy: '🌶️',
  vegan: '🌱',
  glutenfree: '🌾',
};

function formatPrice(p) {
  return `$${p.toFixed(2)}`;
}

/**
 * Idioma da cozinha — a comanda sai sempre em português.
 *
 * O nome do item é congelado no carrinho no idioma que o cliente escolheu, e
 * era esse nome que ia para o papel: um pedido em inglês imprimia "Sausage
 * Skewer", obrigando quem monta o espeto a traduzir no meio do movimento.
 * Quem lê a comanda é sempre a mesma pessoa, e ela não muda de idioma.
 */
const LANG_COZINHA = 'pt';

function nomeCozinha(item) {
  return item.name[LANG_COZINHA] || item.name.en;
}

/**
 * Interpreta seleções múltiplas numa só mensagem.
 *
 * O cliente pode mandar "1", ou várias de uma vez separadas por quebra de
 * linha, vírgula ou espaço:
 *
 *   1          → [1]
 *   1\n2       → [1, 2]
 *   1, 2, 2    → [1, 2, 2]   (repetir soma quantidade)
 *
 * Retorna null se qualquer parte não for número — aí o texto é tratado
 * como comando ou pergunta, não como seleção.
 */
function parseSelections(text) {
  const parts = text
    .trim()
    .split(/[\s,;\n]+/)
    .filter(Boolean);

  if (!parts.length) return null;
  if (!parts.every((p) => /^\d+$/.test(p))) return null;

  return parts.map(Number);
}

/**
 * Um item está disponível se o cardápio o declara ativo **e** ele não foi
 * marcado como esgotado. A primeira condição é permanente (item que saiu do
 * cardápio), a segunda é do dia (acabou a carne).
 */
function itemDisponivel(item) {
  return Boolean(item.available) && availability.isAvailable(item.id);
}

function getAvailableCategories() {
  return config.get('menu').categories.filter((c) => c.items.some(itemDisponivel));
}

function getAvailableItems(category) {
  return category.items.filter(itemDisponivel);
}

// Botão de resposta rápida aparece pronto pra tocar — sem o passo de "abrir"
// que toda lista exige. Só cabem 3 no WhatsApp, então só vale a pena quando
// as opções cabem nesse limite (hoje: as 3 categorias do cardápio).
const BUTTON_OPTIONS_MAX = 3;

function categoryTitle(lang, category) {
  return `${category.emoji} ${category.name[lang] || category.name.en}`;
}

/**
 * Categorias — botões quando cabem (elimina o "abrir lista" a mais que o
 * cliente sentiu entre escolher a categoria e ver os produtos), lista tocável
 * como alternativa se um dia passarem de 3.
 */
async function sendMainMenu(session, send, aviso = null) {
  const lang = session.lang;
  session.state = 'MENU';
  session.currentCategory = null;

  const categories = getAvailableCategories();
  const options = categories.map((c, i) => ({ id: String(i + 1), title: categoryTitle(lang, c) }));
  const intro = t(lang, 'main_menu_intro');
  const body = aviso ? `${aviso}\n\n${intro}` : intro;

  if (categories.length <= BUTTON_OPTIONS_MAX) {
    const sentButtons = await notify.sendButtons(session.phone, {
      body,
      buttons: options,
    });
    if (sentButtons) return;
  }

  await notify.sendList(session.phone, {
    body,
    button: t(lang, 'main_menu_button'),
    sections: [{ title: t(lang, 'main_menu_section'), rows: options }],
    footer: t(lang, 'main_menu_footer'),
  });
}

/**
 * Apresenta o cardápio ao cliente.
 *
 * Com `META_CATALOG_ID` configurado manda o cartão do catálogo (fotos, escolha
 * de quantidade, carrinho nativo). Sem ele — ou se a Meta recusar — cai na
 * lista de categorias tocável, que se degrada para texto numerado sozinha.
 */
/**
 * Seções do catálogo, na ordem do `menu.json` e só com o que está disponível.
 *
 * O catálogo da Meta não guarda categoria nem ordem — os produtos aparecem
 * embaralhados, carne no meio de refrigerante. Aqui a ordem é nossa.
 */
function catalogSections(lang) {
  return getAvailableCategories()
    .map((category) => ({
      title: `${category.emoji || ''} ${category.name[lang] || category.name.pt}`.trim(),
      retailerIds: getAvailableItems(category).map((item) => item.id),
    }))
    .filter((section) => section.retailerIds.length);
}

/**
 * Apresenta o cardápio ao cliente.
 *
 * Três tentativas, da melhor para a mais simples:
 *
 * 1. **Lista de produtos em seções** — fotos, quantidade nativa e o cardápio
 *    agrupado por categoria na nossa ordem. Limite de 30 produtos; temos 12.
 * 2. **Cartão do catálogo** — abre o catálogo inteiro, sem ordem nem seção.
 * 3. **Lista de categorias em texto** — sem catálogo configurado, ou se a Meta
 *    recusar as duas de cima.
 *
 * `CATALOG_MODE=card` força pular a primeira, caso as seções incomodem.
 */
async function presentMenu(session, send, aviso = null) {
  const lang = session.lang;
  const base = t(lang, 'catalog_intro', {
    name: process.env.BUSINESS_NAME || 'nossa hamburgueria',
  });
  // "Retirada — sem taxa" e "Entrega em Everett — $5" chegam por aqui e viram a
  // primeira linha do cartão, em vez de uma mensagem só para confirmar o toque.
  const body = aviso ? `${aviso}\n\n${base}` : base;
  const footer = t(lang, 'catalog_footer');

  const pronto = () => {
    session.state = 'MENU';
    session.currentCategory = null;
  };

  if (process.env.META_CATALOG_ID) {
    if ((process.env.CATALOG_MODE || 'sections').toLowerCase() === 'sections') {
      const sections = catalogSections(lang);
      if (sections.length) {
        const enviou = await notify.sendProductList(session.phone, {
          header: process.env.BUSINESS_NAME || 'nossa hamburgueria',
          body,
          footer,
          sections,
        });
        if (enviou) return pronto();
      }
    }

    const enviou = await notify.sendCatalog(session.phone, {
      body,
      footer,
      thumbnailRetailerId: catalog.thumbnailRetailerId(),
    });
    if (enviou) return pronto();
  }

  await sendMainMenu(session, send, aviso);
}

/** Itens de uma categoria como lista tocável — `id` = posição dentro dela. */
async function sendCategoryMenu(session, category, send) {
  const lang = session.lang;

  const rows = getAvailableItems(category).map((item, i) => {
    const tags = (item.tags || [])
      .map((tag) => TAG_EMOJI[tag])
      .filter(Boolean)
      .join('');
    const name = item.name[lang] || item.name.en;
    return {
      id: String(i + 1),
      title: tags ? `${name} ${tags}` : name,
      description: formatPrice(item.price),
    };
  });

  await notify.sendList(session.phone, {
    header: `${category.emoji} ${category.name[lang] || category.name.en}`,
    body: t(lang, 'category_menu_intro'),
    button: t(lang, 'category_menu_button'),
    sections: [{ title: category.name[lang] || category.name.en, rows }],
    footer: t(lang, 'category_menu_footer'),
  });
}

// ------------------------------------------------ itens com escolha (combos)

function getCategoryById(id) {
  return config.get('menu').categories.find((c) => c.id === id);
}

/** Itens disponíveis para escolher dentro de um combo. */
function getOptionChoices(options) {
  const category = getCategoryById(options.from_category);
  return category ? getAvailableItems(category) : [];
}

function buildOptionRows(options, lang) {
  const surcharge = options.surcharge || {};

  return getOptionChoices(options).map((choice, i) => {
    const extra = surcharge[choice.id];
    return {
      id: String(i + 1),
      title: choice.name[lang] || choice.name.en,
      description: extra ? t(lang, 'catalog_surcharge', { amount: extra.toFixed(2) }) : '',
    };
  });
}

/** Pergunta a próxima escolha pendente do combo, com lista tocável. */
async function askNextOption(session, send) {
  const lang = session.lang;
  const pending = session.pendingItem;
  const options = pending.options;
  const itemName = pending.name;

  const body =
    options.picks === 1
      ? t(lang, 'ask_option_single', { item: itemName })
      : t(lang, 'ask_option_multi', {
          item: itemName,
          current: pending.chosen.length + 1,
          total: options.picks,
        });

  await notify.sendList(session.phone, {
    body,
    button: t(lang, 'catalog_meat_button'),
    sections: [{ title: t(lang, 'catalog_meat_section'), rows: buildOptionRows(options, lang) }],
  });
}

/**
 * Inicia a escolha de espetinhos de um combo, guardando o item pendente
 * na sessão até o cliente completar todas as escolhas.
 */
async function startOptionFlow(session, item, lang, send) {
  session.pendingItem = {
    id: item.id,
    name: item.name[lang] || item.name.en,
    basePrice: item.price,
    options: item.options,
    chosen: [],
  };
  session.state = 'CHOOSING_OPTIONS';
  await askNextOption(session, send);
}

/**
 * Estado CHOOSING_OPTIONS — cliente escolhe as carnes do combo.
 * Só adiciona ao carrinho quando todas as escolhas estiverem feitas.
 */
async function handleOption(session, text, send) {
  const lang = session.lang;
  const pending = session.pendingItem;

  if (!pending) {
    session.state = 'MENU';
    await sendMainMenu(session, send);
    return;
  }

  const choices = getOptionChoices(pending.options);
  const picks = parseSelections(text);

  const valid = (picks || []).filter((n) => n >= 1 && n <= choices.length);
  if (!valid.length) {
    await send(t(lang, 'option_invalid'));
    await askNextOption(session, send);
    return;
  }

  // Aceita as escolhas de uma vez ("1 2"), respeitando o limite do combo.
  const faltam = pending.options.picks - pending.chosen.length;
  for (const n of valid.slice(0, faltam)) {
    pending.chosen.push(choices[n - 1]);
  }

  if (pending.chosen.length < pending.options.picks) {
    await askNextOption(session, send);
    return;
  }

  addComboToCart(session, lang);
  session.pendingItem = null;
  session.state = 'ORDER';

  const last = session.cart[session.cart.length - 1];
  const categoryId = getAvailableCategories()[session.currentCategory]?.id;

  await send(
    t(lang, 'item_added', {
      name: last.name,
      cart_summary: buildCartSummary(session),
      quick_nav: buildQuickNav(lang, categoryId),
    })
  );

  // Havia mais de um combo na mesma seleção: abre o próximo da fila.
  const proximo = (session.pendingItemQueue || []).shift();
  if (proximo) await startOptionFlow(session, proximo, lang, send);
}

/**
 * Monta o item final do combo — nome com as carnes e preço com acréscimos.
 *
 * Usado tanto pelo fluxo de texto quanto pelo do catálogo, para que a comanda
 * e o carrinho fiquem idênticos independente de por onde o pedido entrou.
 */
function pushCombo(session, { comboId, baseName, basePrice, surcharge, chosen, lang }) {
  const extras = surcharge || {};
  const labels = chosen.map((c) => c.name[lang] || c.name.en);
  const extra = chosen.reduce((sum, c) => sum + (extras[c.id] || 0), 0);

  // `baseName` já chega traduzido; a versão da cozinha sai do cardápio.
  const combo = catalog.itemByRetailerId(comboId);

  // Combos com carnes diferentes são itens distintos no carrinho.
  const cartId = `${comboId}:${chosen.map((c) => c.id).sort().join('+')}`;
  const existing = session.cart.find((i) => i.id === cartId);

  if (existing) {
    existing.qty += 1;
    return existing;
  }

  const entry = {
    id: cartId,
    name: `${baseName} — ${labels.join(', ')}`,
    // Guardado à parte para a comanda listar as carnes sem truncar o nome.
    choices: labels,
    baseName,
    nomeCozinha: combo ? nomeCozinha(combo) : baseName,
    choicesCozinha: chosen.map(nomeCozinha),
    qty: 1,
    price: basePrice + extra,
  };

  session.cart.push(entry);
  return entry;
}

function addComboToCart(session, lang) {
  const pending = session.pendingItem;

  return pushCombo(session, {
    comboId: pending.id,
    baseName: pending.name,
    basePrice: pending.basePrice,
    surcharge: pending.options.surcharge,
    chosen: pending.chosen,
    lang,
  });
}

// ------------------------------------------------------- navegação por letra

const CHECKOUT_SHORTCUT = 'F';

/** Letra de atalho da categoria — do config, ou a inicial do id. */
function shortcutOf(category) {
  return (category.shortcut || category.id[0]).toUpperCase();
}

/** Resolve uma letra digitada para a categoria correspondente. */
function categoryByShortcut(letter) {
  const key = letter.trim().toUpperCase();
  if (key.length !== 1) return null;
  return getAvailableCategories().find((c) => shortcutOf(c) === key) || null;
}

function isCheckoutShortcut(text) {
  return text.trim().toUpperCase() === CHECKOUT_SHORTCUT;
}

/**
 * Barra de atalhos exibida após adicionar um item.
 *
 * Permite pular direto para outra categoria ou fechar o pedido sem voltar ao
 * menu principal. Usa letras porque os números continuam valendo para itens.
 */
function buildQuickNav(lang, currentCategoryId) {
  const others = getAvailableCategories()
    .filter((c) => c.id !== currentCategoryId)
    .map((c) => `${c.emoji} *${shortcutOf(c)}* ${c.name[lang] || c.name.en}`)
    .join('  ·  ');

  return t(lang, 'quick_nav', {
    categories: others,
    checkout: CHECKOUT_SHORTCUT,
  });
}

function buildCartSummary(session) {
  const lang = session.lang;
  const subtotal = session.cart.reduce((s, i) => s + i.price * i.qty, 0);
  const items = session.cart
    .map((i) => `• ${i.name} x${i.qty} — ${formatPrice(i.price * i.qty)}`)
    .join('\n');

  return t(lang, 'cart_summary', { items, subtotal: subtotal.toFixed(2) });
}

/**
 * Estado MENU — o cliente navega entre categorias e adiciona itens.
 *
 * `session.currentCategory` guarda o índice da categoria aberta, ou null
 * quando estamos no menu principal. Cuidado: o índice 0 é válido, então
 * as comparações precisam ser explícitas contra null.
 */
async function handle(session, text, send) {
  const lang = session.lang;
  const input = text.trim().toLowerCase();
  const categories = getAvailableCategories();

  // "0" não chega aqui: o router o trata como reinício antes do dispatch.
  //
  // `presentMenu`, e não `sendMainMenu`: quem tem catálogo configurado deve
  // receber o cartão com fotos de volta, não a lista de categorias em texto.
  // O "Não, add itens" da confirmação já fazia assim; o "menu" tinha ficado
  // para trás, e devolvia uma versão pior do cardápio a quem pedia para vê-lo.
  if (input === 'menu') {
    await presentMenu(session, send);
    return;
  }

  // Atalho por letra: pula direto para outra categoria, sem passar pelo menu.
  const shortcut = categoryByShortcut(input);
  if (shortcut) {
    session.currentCategory = categories.indexOf(shortcut);
    session.state = 'MENU';
    await sendCategoryMenu(session, shortcut, send);
    return;
  }

  const index = parseInt(input, 10) - 1;

  // Menu principal: escolher uma categoria.
  if (session.currentCategory === null || session.currentCategory === undefined) {
    if (Number.isNaN(index) || index < 0 || index >= categories.length) {
      await sendMainMenu(session, send);
      return;
    }

    session.currentCategory = index;
    await sendCategoryMenu(session, categories[index], send);
    return;
  }

  // Dentro de uma categoria: escolher um item.
  const category = categories[session.currentCategory];
  if (!category) {
    session.currentCategory = null;
    await sendMainMenu(session, send);
    return;
  }

  const items = getAvailableItems(category);
  const picks = parseSelections(input);

  if (!picks) {
    await sendCategoryMenu(session, category, send);
    return;
  }

  const valid = picks.filter((n) => n >= 1 && n <= items.length);
  if (!valid.length) {
    await sendCategoryMenu(session, category, send);
    return;
  }

  // Um combo precisa da escolha das carnes, o que interrompe a seleção
  // múltipla. Adiciona os itens simples antes e depois abre a escolha.
  const added = [];
  const combos = [];

  for (const n of valid) {
    const item = items[n - 1];

    if (item.options?.picks > 0) {
      combos.push(item);
      continue;
    }

    addSimpleItem(session, item, lang);
    added.push(item.name[lang] || item.name.en);
  }

  if (added.length) {
    session.state = 'ORDER';
    await send(
      t(lang, 'item_added', {
        name: added.join(', '),
        cart_summary: buildCartSummary(session),
        quick_nav: buildQuickNav(lang, category.id),
      })
    );
  }

  // Cada combo abre uma escolha de carnes, que interrompe o resto da seleção.
  // Os demais ficam na fila e entram assim que o anterior fechar — antes o
  // laço parava no primeiro combo e o que vinha depois sumia sem aviso.
  if (combos.length) {
    session.pendingItemQueue = combos.slice(1);
    await startOptionFlow(session, combos[0], lang, send);
  }
}

function addSimpleItem(session, item, lang) {
  const name = item.name[lang] || item.name.en;
  const existing = session.cart.find((c) => c.id === item.id);

  if (existing) {
    existing.productId = existing.productId || item.id;
    existing.choicesCozinha = existing.choicesCozinha || [];
    existing.removed = existing.removed || [];
    existing.added = existing.added || [];
    existing.qty += 1;
  } else {
    session.cart.push({
      id: item.id,
      productId: item.id,
      name,
      nomeCozinha: nomeCozinha(item),
      choicesCozinha: [],
      removed: [],
      added: [],
      qty: 1,
      price: item.price,
    });
  }
}

module.exports = {
  handle,
  handleOption,
  presentMenu,
  pushCombo,
  addSimpleItem,
  itemDisponivel,
  categoryByShortcut,
  isCheckoutShortcut,
  buildQuickNav,
  sendMainMenu,
  sendCategoryMenu,
  buildCartSummary,
  getAvailableCategories,
};
