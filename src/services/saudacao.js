// Compartilhado pela entrada e pelo filtro da IA: uma saudação comum não é
// texto aleatório. Só casa a mensagem inteira para não engolir um pedido ou
// pergunta que venha depois de "ei, ...".
const CUMPRIMENTO = '(?:oi+|ola+|ei+|opa+|alo+|salve|fala|e ?ai+|eae+|' +
  'bom+ dia+|boa+ tarde+|boa+ noite+|' +
  'hi+|hello+|hey+|hola+|buenas|buenos dias|buenas tardes|buenas noches)';
const CORTESIA = '(?:tudo (?:bem|bom|joia|certo)|td (?:bem|bom)|tdb|beleza|blz|como vai|como vao)';
const SO_SAUDACAO = new RegExp(
  `^(?:${CUMPRIMENTO}|${CORTESIA})(?: (?:${CUMPRIMENTO}|${CORTESIA}|pessoal|gente))*(?: por ai)?$`
);

function ehSoSaudacao(texto) {
  const bruto = String(texto || '').trim();
  if (!bruto || bruto.length > 160) return false;
  // O aceno sozinho também é cumprimento; outros emojis não viram pedido.
  if (/^(?:👋[\u{1F3FB}-\u{1F3FF}]?\uFE0F?\s*)+$/u.test(bruto)) return true;
  const normal = bruto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  return SO_SAUDACAO.test(normal);
}

module.exports = { ehSoSaudacao };
