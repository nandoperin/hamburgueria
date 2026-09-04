const config = require('./config');

const DIAS_PROMOCAO = [2, 3];

const doc = () => config.get('promotions');

function diaNoFuso(quando = new Date(), timezone = 'America/New_York') {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  }).format(quando);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday];
}

function dataNoFuso(quando = new Date(), timezone = 'America/New_York') {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(quando);
  const valor = (tipo) => partes.find((p) => p.type === tipo)?.value;
  return `${valor('year')}-${valor('month')}-${valor('day')}`;
}

/**
 * A disponibilidade é calculada na hora da mensagem. Não depende de cron nem
 * de um timer sobreviver a deploy: terça às 00h entra; quinta às 00h sai.
 */
function ativa(quando = new Date()) {
  const promocao = doc();
  if (promocao.disabled_date === dataNoFuso(quando, promocao.timezone)) return false;
  if (promocao.automatic === true) {
    const dias = Array.isArray(promocao.weekdays) ? promocao.weekdays : DIAS_PROMOCAO;
    return dias.includes(diaNoFuso(quando, promocao.timezone));
  }
  return promocao.manual_active === true;
}

function itemBase(id) {
  return (config.get('menu').categories || [])
    .flatMap((categoria) => categoria.items || [])
    .find((item) => item.id === id) || null;
}

function expandirItem(item) {
  const base = itemBase(item.base_item_id);
  const quantidade = Number(item.bundle_quantity) || 1;
  return {
    ...(base || {}),
    ...item,
    name: { ...(base?.name || {}), ...(item.name || {}) },
    description: { ...(base?.description || {}), ...(item.description || {}) },
    // Em pacote de três, uma alteração precisaria indicar em qual unidade vai.
    // Não cobrar um adicional uma vez e aplicá-lo silenciosamente nas três.
    modifiers: quantidade === 1 ? base?.modifiers : undefined,
    ingredientQuantities: quantidade === 1 ? base?.ingredientQuantities : undefined,
    promotionId: 'terca_quarta',
    baseItemId: item.base_item_id,
    bundleQuantity: quantidade,
    catalogVisible: false,
  };
}

function categoria() {
  const categoriaPromocao = doc().category;
  return {
    ...categoriaPromocao,
    items: (categoriaPromocao.items || []).map(expandirItem),
  };
}

function itemDaPromocao(item) {
  return ['terca_quarta', 'quintou'].includes(item?.promotionId);
}

function ofertas(baseItemId) {
  return (doc().category?.items || [])
    .filter((item) => item.available !== false && item.base_item_id === baseItemId)
    .map((item) => ({ quantidade: Number(item.bundle_quantity) || 1, preco: Number(item.price) }))
    .filter((item) => item.quantidade > 0 && Number.isFinite(item.preco));
}

/**
 * Calcula o menor preço possível para a quantidade pedida. Assim o cliente
 * pede simplesmente "3 X Tudo" e recebe $50, sem conhecer ids ou nomes de
 * promoção. Quantidades fora dos pacotes usam a melhor combinação disponível.
 */
function precificar(item, quantidade = 1, quando = new Date()) {
  const qtd = Math.max(1, Math.floor(Number(quantidade) || 1));
  const unitarioNormal = Number(item?.regularPrice ?? item?.price) || 0;
  const totalNormal = unitarioNormal * qtd;
  if (!item || itemDaPromocao(item) || !ativa(quando)) {
    return { unitario: Number(item?.price) || 0, total: (Number(item?.price) || 0) * qtd, promocional: itemDaPromocao(item) };
  }

  const opcoes = ofertas(item.id);
  if (!opcoes.length) return { unitario: unitarioNormal, total: totalNormal, promocional: false };

  const melhor = Array(qtd + 1).fill(Infinity);
  melhor[0] = 0;
  for (let n = 1; n <= qtd; n += 1) {
    melhor[n] = melhor[n - 1] + unitarioNormal;
    for (const oferta of opcoes) {
      if (oferta.quantidade <= n) {
        melhor[n] = Math.min(melhor[n], melhor[n - oferta.quantidade] + oferta.preco);
      }
    }
  }

  return {
    unitario: melhor[qtd] / qtd,
    total: melhor[qtd],
    promocional: melhor[qtd] < totalNormal,
  };
}

function rotulo(nome, lang = 'pt') {
  if (/preço promocional|special price|precio promocional/i.test(nome)) return nome;
  if (lang === 'en') return `${nome} — special price`;
  if (lang === 'es') return `${nome} — precio promocional`;
  return `${nome} — preço promocional`;
}

function aplicarNaLinha(line, item, extraUnitario = 0, lang = 'pt', quando = new Date()) {
  const preco = precificar(item, line.qty, quando);
  line.baseName = line.baseName || line.name;
  line.price = preco.unitario + extraUnitario;
  line.promotionApplied = preco.promocional;
  line.name = preco.promocional ? rotulo(line.baseName, lang) : line.baseName;
  return line;
}

function reprecificarCarrinho(cart, lang = 'pt', quando = new Date()) {
  // Preço já colocado no carrinho fica travado quando a promoção encerra ou é
  // pausada. Nunca aumente um pedido que o cliente já viu.
  if (!ativa(quando)) return cart;
  const modifiers = require('./modifiers');
  const grupos = new Map();
  for (const line of cart || []) {
    const id = line.productId || String(line.id || '').split(':')[0];
    const item = itemBase(id);
    if (!item) continue;
    if (!grupos.has(id)) grupos.set(id, { item, linhas: [], quantidade: 0 });
    const grupo = grupos.get(id);
    grupo.linhas.push(line);
    grupo.quantidade += Number(line.qty) || 0;
  }

  for (const grupo of grupos.values()) {
    const preco = precificar(grupo.item, grupo.quantidade, quando);
    for (const line of grupo.linhas) {
      const extra = (line.added || []).reduce((total, ingrediente) =>
        total + modifiers.precoDe(ingrediente), 0);
      line.baseName = line.baseName || line.name;
      line.price = preco.unitario + extra;
      line.promotionApplied = preco.promocional;
      line.name = preco.promocional ? rotulo(line.baseName, lang) : line.baseName;
    }
  }
  return cart;
}

function itemLiberado(item, quando = new Date()) {
  return !itemDaPromocao(item) || ativa(quando);
}

function mensagemIndisponivel(lang = 'pt') {
  const promocao = doc();
  if (promocao.automatic === true) {
    if (lang === 'en') return 'This special is available on Tuesdays and Wednesdays only.';
    if (lang === 'es') return 'Esta promoción está disponible solamente los martes y miércoles.';
    return 'Esta promoção é válida somente às terças e quartas-feiras.';
  }
  if (lang === 'en') return 'The special is not active right now.';
  if (lang === 'es') return 'La promoción no está activa en este momento.';
  return 'A promoção não está ativa no momento.';
}

function mencionada(texto) {
  const normalizado = String(texto || '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /\bpromo(?:cao)?\b|\bpromo(?:cao)?\s+(?:de\s+)?(?:terca|quarta)\b/.test(normalizado);
}

module.exports = {
  DIAS_PROMOCAO,
  ativa,
  categoria,
  dataNoFuso,
  diaNoFuso,
  itemDaPromocao,
  itemLiberado,
  mensagemIndisponivel,
  mencionada,
  ofertas,
  aplicarNaLinha,
  reprecificarCarrinho,
  precificar,
  rotulo,
};
