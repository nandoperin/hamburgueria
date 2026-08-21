const menu = require('../../config/menu.json');

/**
 * Ponte entre o catálogo do WhatsApp e o `menu.json`.
 *
 * O "Content ID" de cada produto no Commerce Manager é o próprio `id` do item
 * no menu — assim o pedido que chega pelo webhook (`type: "order"`) volta a ser
 * um item do cardápio sem tabela de-para separada para manter em sincronia.
 *
 * Um catálogo é único por WABA. O feed principal vai em português; inglês e
 * espanhol entram como feeds de sobrescrita (ver `overrideRows`).
 */

const CATALOG_LANG = 'pt';

/**
 * Idiomas extras e o código que vai na coluna `override` do feed de tradução.
 *
 * **O sufixo `_XX` é obrigatório e significa "qualquer país".** Feed de idioma
 * e feed de país usam formatos diferentes: o de país leva `US`, `BR`; o de
 * idioma leva `en_XX`, `es_XX`. A documentação da Meta usa exatamente esses
 * exemplos, e o template que o Commerce Manager gera vem preenchido com eles.
 */
const OVERRIDE_CODES = { en: 'en_XX', es: 'es_XX' };
const OVERRIDE_LANGS = Object.keys(OVERRIDE_CODES);

// Arte de marca usada por todo item sem foto própria.
const IMAGEM_PADRAO = '/img/marca/hamburgueria.jpg';

/** Todos os itens do cardápio, achatados, com a categoria junto. */
function allItems() {
  return menu.categories.flatMap((category) =>
    category.items.map((item) => ({ ...item, category }))
  );
}

function itemByRetailerId(retailerId) {
  return allItems().find((item) => item.id === retailerId) || null;
}

/**
 * Produto usado como miniatura do cartão do catálogo.
 *
 * Todos os exemplos da Meta para `catalog_message` mandam um
 * `thumbnail_product_retailer_id`, e sem ele a API responde "Products not found
 * in FB catalog" mesmo com o catálogo vinculado e cheio — ela não escolhe um
 * produto sozinha.
 *
 * Precisa ser um id que exista no Commerce Manager, então sai da mesma lista
 * que gera o feed. Prefere o carro-chefe (X-Burger); se ele sumir do cardápio,
 * cai no primeiro item disponível.
 */
function thumbnailRetailerId() {
  const disponiveis = allItems().filter((item) => item.available !== false);
  const preferido = disponiveis.find((item) => item.id === 'x_burger');
  return (preferido || disponiveis[0])?.id || null;
}

/**
 * Item exige uma etapa de escolha que o catálogo não sabe conduzir sozinho.
 *
 * Cobre os combos herdados (`options.picks`, escolha de carne). Modificadores
 * de ingrediente (remover/adicionar) não caem aqui: eles são opcionais e o
 * cliente que pede pelo catálogo recebe o item como vem no cardápio.
 */
function needsOptions(item) {
  return Boolean(item?.options?.picks);
}

function itemsOfCategory(categoryId) {
  const category = menu.categories.find((c) => c.id === categoryId);
  return category ? category.items : [];
}

/** Acréscimo de uma escolha específica dentro de um combo (ex: costela +$2). */
function surchargeFor(combo, itemId) {
  return combo?.options?.surcharge?.[itemId] || 0;
}

// ------------------------------------------------------- feed do Commerce Manager

const FEED_COLUMNS = [
  'id',
  'title',
  'description',
  'availability',
  'condition',
  'price',
  'link',
  'image_link',
  'brand',
];

/**
 * Monta as linhas do feed de produtos.
 *
 * `siteUrl` é o domínio do estabelecimento — a Meta exige `link` e `image_link`
 * em toda linha, e recusa o feed se as imagens não abrirem publicamente.
 */
function feedRows({ siteUrl, imageBase, brand, lang = CATALOG_LANG }) {
  const base = siteUrl.replace(/\/$/, '');
  const imgBase = (imageBase || siteUrl).replace(/\/$/, '');

  return allItems()
    .filter((item) => item.available !== false)
    .map((item) => ({
      id: item.id,
      title: item.name[lang] || item.name.pt,
      description: item.description?.[lang] || item.description?.pt || '',
      availability: 'in stock',
      condition: 'new',
      price: `${item.price.toFixed(2)} USD`,
      link: `${base}/cardapio#${item.id}`,
      // Sem foto própria, o item usa a arte de marca. Para dar foto a um
      // produto, basta acrescentar `"image": "/img/produtos/x.jpg"` ao item no
      // menu.json.
      image_link: `${imgBase}${item.image || IMAGEM_PADRAO}`,
      brand,
    }));
}

// Feed de tradução: a localidade e só o que muda de idioma para idioma.
const OVERRIDE_COLUMNS = ['id', 'override', 'title', 'description'];

/**
 * Linhas do feed de sobrescrita por idioma.
 *
 * O catálogo principal vai em português; cada idioma extra entra como um feed
 * separado no Commerce Manager, contendo apenas id, título e descrição. O
 * WhatsApp escolhe qual mostrar pelo **locale do aparelho do cliente** — não
 * pelo idioma que ele selecionou no bot. Os dois podem divergir, e não há como
 * forçar: quem decide é a Meta.
 */
function overrideRows(lang) {
  const override = OVERRIDE_CODES[lang];
  if (!override) throw new Error(`Idioma sem código de substituição: ${lang}`);

  return allItems()
    .filter((item) => item.available !== false)
    .map((item) => ({
      id: item.id,
      override,
      title: item.name[lang] || item.name.pt,
      description: item.description?.[lang] || item.description?.pt || '',
    }));
}

function escapeCsv(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows, columns = FEED_COLUMNS) {
  const header = columns.join(',');
  const body = rows.map((row) =>
    columns.map((column) => escapeCsv(row[column])).join(',')
  );
  return [header, ...body].join('\n') + '\n';
}

module.exports = {
  CATALOG_LANG,
  OVERRIDE_LANGS,
  OVERRIDE_CODES,
  FEED_COLUMNS,
  OVERRIDE_COLUMNS,
  overrideRows,
  allItems,
  thumbnailRetailerId,
  itemByRetailerId,
  needsOptions,
  itemsOfCategory,
  surchargeFor,
  feedRows,
  toCsv,
};
