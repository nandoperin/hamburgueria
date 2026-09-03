const configService = require('./config');

/** A config vigente. Funcao, e nao constante: o dono edita em execucao. */
const config = () => configService.get('delivery');

/** Cidades ativas, na ordem em que aparecem no menu. */
function getCities() {
  return (config().cities || []).filter((c) => c.active !== false);
}

/** Resolve a cidade pelo número digitado pelo cliente (1-based). */
function getCityByIndex(index) {
  const cities = getCities();
  if (!Number.isInteger(index) || index < 1 || index > cities.length) return null;
  return cities[index - 1];
}

/**
 * Acha a cidade pelo que o cliente escreveu.
 *
 * O modelo extrai o nome de uma frase solta ("moro em everet", "é pra Chelsea
 * mesmo", "Malden MA") e passa adiante. Quem decide se atendemos é **esta
 * função**, contra o `delivery.json` — nunca o modelo.
 *
 * A diferença não é estilística. Deixar a cobertura a cargo do modelo faria
 * "moro em Boston mas é bem pertinho, dá pra entregar?" ter chance de ganhar
 * uma vez. E uma vez basta: sai entregador para fora da área, com taxa que não
 * cobre a viagem.
 *
 * Compara sem acento e sem caixa porque ninguém digita "Malden" com esmero no
 * meio de um pedido.
 */
function normalizarCidade(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

const SUFIXO_RUA = /\b(?:street|st|avenue|ave|av|court|ct|lane|ln|road|rd|drive|dr|boulevard|blvd|parkway|pkwy|place|pl|terrace|ter|way|circle|cir)\.?(?=\s|,|$)/gi;
const ESTADO_ZIP = /(?:[,\s]+(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|Massachusetts))?(?:[,\s]+\d{5}(?:-\d{4})?)?[,\s]*$/i;
const UNIDADE = /(?:\b(?:apt|apartment|unit|suite|ste)\.?\s*#?\s*|#\s*)[a-z0-9-]+\b/gi;

/** Extrai uma candidata, inclusive fora da cobertura; nao valida a rua. */
function extrairCidadeEndereco(texto) {
  const original = String(texto || '').trim();
  // Nome de cidade sozinho e interpretado pelo modelo/definir_cidade.
  if (!/\d/.test(original)) return null;
  const semEstado = original.replace(ESTADO_ZIP, '').trim();
  const candidata = (trecho) => {
    const limpo = trecho.replace(UNIDADE, '').replace(/^[,\s]+|[,\s.!?]+$/g, '').trim();
    if (!/^[\p{L}][\p{L}.'’ -]{1,70}$/u.test(limpo)) return null;
    if (limpo.split(/\s+/).length > 5) return null;
    // Complementos nao sao cidades. Na duvida, deixa a IA interpretar.
    if (/\b(?:apt|apartment|unit|suite|floor|andar|fundos|basement|upstairs|downstairs|perto|porta|entrada|atr[aá]s)\b/i.test(limpo)) return null;
    return limpo;
  };
  const partes = semEstado.split(/[,\n]+/);
  // Sem virgula: "6 Main St Boston". O sufixo e uma pista, nao requisito.
  for (let i = 0; i < partes.length; i++) {
    if (!/\d/.test(partes[i])) continue;
    for (const match of partes[i].matchAll(new RegExp(SUFIXO_RUA))) {
      if (!/\d/.test(partes[i].slice(0, match.index))) continue;
      const cidade = candidata(partes[i].slice(match.index + match[0].length));
      if (cidade && !new RegExp(SUFIXO_RUA).test(cidade.replace(/^St\.?\s+/i, ''))) return cidade;
    }
    for (let j = i + 1; j < partes.length; j++) {
      if (/\d/.test(partes[j]) && !UNIDADE.test(partes[j])) break;
      UNIDADE.lastIndex = 0;
      const cidade = candidata(partes[j]);
      if (cidade) return cidade;
    }
  }
  return null;
}

function acharCidade(texto) {
  const extraida = extrairCidadeEndereco(texto);
  const alvo = normalizarCidade(extraida || texto).replace(ESTADO_ZIP, '').trim();

  if (!alvo) return null;

  const cidades = getCities();

  // Exata primeiro: "chelsea" não deve casar com uma cidade cujo nome apenas
  // contenha essas letras.
  const exata = cidades.find((c) => normalizarCidade(c.label) === alvo || normalizarCidade(c.id) === alvo);
  if (exata) return exata;

  // Cidade extraida fora da area nao pode casar com o nome de uma rua.
  // "6 Everett St, Boston" nao e entrega em Everett.
  if (extraida || /\d/.test(alvo)) return null;

  // Aceita frases simples, mas nao substrings como "South Everett".
  const cidadeInformada = alvo.replace(/^(?:moro em|entrega (?:em|para)|e (?:pra|para)|cidade (?:de|e))\s+/, '')
    .replace(ESTADO_ZIP, '').replace(/\s+mesmo$/, '').trim();
  return cidades.find((c) => [c.label, c.id].some((nome) => normalizarCidade(nome) === cidadeInformada)) || null;
}

/** Nomes das cidades atendidas, para dizer ao cliente o que existe. */
function nomesDasCidades() {
  return getCities().map((c) => c.label);
}

function getCityById(id) {
  return getCities().find((c) => c.id === id) || null;
}

/**
 * Taxa de entrega da cidade, considerando a regra de entrega grátis
 * acima de um valor de subtotal.
 */
function getDeliveryFee(city, subtotal) {
  if (!city) return 0;
  const threshold = config().free_delivery_above || 0;
  if (threshold > 0 && subtotal >= threshold) return 0;
  return city.delivery_fee;
}

function getMinOrder() {
  return config().min_order || 0;
}

/**
 * Endereco da retirada, ou null quando ainda nao foi preenchido.
 *
 * O `config/delivery.json` nasce com "PREENCHER: rua, numero..." — e esse texto
 * ia direto para o resumo que o cliente confirma, para a mensagem de retirada e
 * para a **comanda impressa** (`order.js` grava o endereco de retirada no
 * pedido). Placeholder que vaza para o cliente e pior que campo vazio: parece
 * defeito do sistema, e some no meio de um texto que ninguem rele.
 */
const NAO_PREENCHIDO = /^PREENCHER:/i;

function enderecoRetirada() {
  const bruto = String(getPickup().address || '').trim();
  if (!bruto || NAO_PREENCHIDO.test(bruto)) return null;
  return bruto;
}

function getPickup() {
  return config().pickup || { enabled: false };
}

function isPickupEnabled() {
  return getPickup().enabled === true;
}

/** Lista formatada das cidades para exibir no WhatsApp. */
function formatCityList() {
  return getCities()
    .map((c, i) => `${i + 1}️⃣ ${c.label} — $${c.delivery_fee.toFixed(2)}`)
    .join('\n');
}

module.exports = {
  getCities,
  getCityByIndex,
  acharCidade,
  extrairCidadeEndereco,
  nomesDasCidades,
  getCityById,
  getDeliveryFee,
  getMinOrder,
  formatCityList,
  getPickup,
  enderecoRetirada,
  isPickupEnabled,
};
