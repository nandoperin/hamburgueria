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

// "Boa noite / Gostaria de fazer um pedido" (14/11, 16174068211 e
// 17815266637): só a vontade de pedir, sem lanche. Ia para a leitora, que não
// achava item, e o cliente ouvia "Não entendi". Casa a mensagem inteira; com
// lanche, número, entrega ou retirada, não entra — segue o caminho de sempre.
const PEDIR_PT = '(?:(?:eu|a gente) )?(?:gostaria|queria|quero|quer|vou|vamos|preciso|posso|pode|podemos|' +
  'da pra|da para|tem como|consigo|consegue|como (?:faco|faz)(?: pra| para)?|to querendo|estou querendo|' +
  'to a fim|tou a fim|estou a fim|to afim|estou afim)(?: de)? ' +
  '(?:fazer|faze|realizar|pedir|encomendar|anotar)(?: (?:um|uns|o|meu|1|uma|outro|mais um))?' +
  '(?: (?:pedido|pedidos|encomenda|lanche|lanches))?';
const ANOTA = '(?:anota|anote|anotar|faz|faca)(?: ai)? (?:o |meu |um )?pedido';
const PEDIR_EN = "(?:i (?:d|would) like to|i want to|i wanna|can i|could i|i d like to|may i)(?: (?:make|place|do))?(?: an?)? order";
const PEDIR_ES = '(?:quiero|quisiera|queria|puedo|me gustaria)(?: hacer)?(?: (?:un|una))? (?:pedido|orden|pedir|ordenar)';
const FINAL = '(?: (?:ai|por favor|pf|pfv|pfvr|please|por fa|com voces|com vcs|com vc|por aqui|aqui|hoje|agora|ok|pessoal|gente|amigo|amiga))*';
const SO_INTENCAO = new RegExp(
  `^(?:(?:${CUMPRIMENTO}|${CORTESIA}|pessoal|gente|amigo|amiga|por favor) )*` +
  `(?:${PEDIR_PT}|${ANOTA}|${PEDIR_EN}|${PEDIR_ES})${FINAL}$`
);

function ehSoIntencaoDePedido(texto) {
  const bruto = String(texto || '').trim();
  if (!bruto || bruto.length > 160 || /\d/.test(bruto)) return false;
  const normal = bruto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  return SO_INTENCAO.test(normal);
}

module.exports = { ehSoSaudacao, ehSoIntencaoDePedido };
