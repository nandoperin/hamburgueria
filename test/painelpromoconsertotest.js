/**
 * Produto da promoção sem produto-base (08/11/2026): o X Bacon foi apagado e
 * recriado no cardápio com outro código (x_bacon → xbacon), e a promoção
 * parou de salvar ("produto-base não existe"). O painel passa a:
 *   - avisar no ✕ do cardápio quando o produto está na promoção;
 *   - mostrar "Consertar" no item da promoção cujo produto sumiu.
 */
const PROJECT = require('path').resolve(__dirname, '..');
const pagina = require(`${PROJECT}/src/api/painel-page`).render(15, 'nonce-teste');

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}
const script = [...pagina.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
checar((() => { try { new Function(script); return true; } catch { return false; } })(), 'o JavaScript do painel continua válido');

const pegar = (nome) => {
  const i = script.indexOf(`function ${nome}(`);
  const ini = script.lastIndexOf('\n', i) + 1;
  let p = 0;
  let j = script.indexOf('{', i);
  for (; j < script.length; j++) {
    if (script[j] === '{') p++;
    if (script[j] === '}' && --p === 0) break;
  }
  return script.slice(ini, j + 1);
};
function no(tag) {
  return { tag, filhos: [], classList: { toggle() {} }, append(...f) { this.filhos.push(...f); }, replaceChildren(...f) { this.filhos = f; } };
}
const el = (tag, props, ...filhos) => {
  const n = no(tag);
  n.props = props || {};
  if (n.props.onclick) n.onclick = n.props.onclick;
  if (tag === 'select') n.value = '';
  n.append(...filhos);
  if (tag === 'select') {
    const primeira = filhos[0];
    Object.defineProperty(n, 'append', { value(...f) { this.filhos.push(...f); if (!this.value && f[0]?.props) this.value = f[0].props.value; } });
    if (primeira?.props) n.value = primeira.props.value;
  }
  return n;
};
const achar = (raiz, teste) => {
  const out = [];
  const andar = (n) => { if (!n || typeof n !== 'object') return; if (teste(n)) out.push(n); (n.filhos || []).forEach(andar); };
  andar(raiz);
  return out;
};
const textoDe = (n) => (typeof n === 'string' ? n : (n.filhos || []).map(textoDe).join(' '));

const window = {
  __menuPromo: { categories: [
    { id: 'sanduiches', name: { pt: 'Sanduíches' }, items: [{ id: 'x_tudo', name: { pt: 'X Tudo' } }, { id: 'xbacon', name: { pt: 'X bacon' } }] },
  ] },
};
let sujo = 0;
let renderizou = 0;
const document = { getElementById: () => no('main') };
const { cardPromocao } = new Function('el', 'window', 'marcarSujo', 'renderPromocao', 'document', 'doc', 'confirm',
  `${pegar('cardPromocao')}\nreturn { cardPromocao };`)(
  el, window, () => { sujo += 1; }, () => { renderizou += 1; }, document, { category: { items: [] } }, () => true);

// Item da promoção com produto que sumiu.
const quebrado = { id: 'promo_terca_quarta_x_bacon', base_item_id: 'x_bacon', name: { pt: 'X Bacon — preço promocional' }, price: 16, available: true };
let card = cardPromocao(quebrado);
const botao = achar(card, (n) => n.tag === 'button' && textoDe(n) === 'Consertar')[0];
const escolha = achar(card, (n) => n.tag === 'select')[0];
checar(botao && /não existe mais no cardápio/.test(textoDe(card)), 'item sem produto: aviso e botão "Consertar"');
checar(escolha.value === 'xbacon', '   já vem escolhido o produto de nome parecido (x_bacon → xbacon)');
botao.onclick();
checar(quebrado.base_item_id === 'xbacon' && sujo === 1 && renderizou === 1, '"Consertar" aponta o item para o X bacon atual e marca para salvar');
checar(quebrado.id === 'promo_terca_quarta_x_bacon' && quebrado.price === 16, '   o resto do item (código, preço) fica como estava');

// Item normal: sem aviso.
card = cardPromocao({ id: 'promo_terca_quarta_x_tudo', base_item_id: 'x_tudo', name: { pt: 'X Tudo — preço promocional' }, price: 18 });
checar(!achar(card, (n) => n.tag === 'button' && textoDe(n) === 'Consertar').length, 'item com produto que existe: sem "Consertar"');

// O ✕ do cardápio avisa quando o produto está na promoção.
const mensagens = [];
window.__promoDoMenu = { category: { items: [
  { id: 'promo_terca_quarta_x_bacon', base_item_id: 'xbacon', name: { pt: 'X Bacon — preço promocional' } },
  { id: 'promo_terca_quarta_3_x_bacon', base_item_id: 'xbacon', name: { pt: '3 X Bacon — preço promocional' } },
] } };
const { cardItem } = new Function('el', 'window', 'marcarSujo', 'renderMenu', 'document', 'confirm', 'listaIng', 'money',
  `${pegar('cardItem')}\nreturn { cardItem };`)(
  el, window, () => {}, () => {}, document, (m) => { mensagens.push(m); return false; }, () => no('ings'), (v) => '$' + v);
const cat = { id: 'sanduiches', items: [{ id: 'xbacon', name: { pt: 'X bacon' } }, { id: 'x_tudo', name: { pt: 'X Tudo' } }] };
const clicarX = (item) => achar(cardItem(cat, item, []), (n) => n.tag === 'button' && n.props.title === 'remover')[0].onclick();
clicarX(cat.items[0]);
checar(/está na promoção \(X Bacon — preço promocional, 3 X Bacon — preço promocional\)/.test(mensagens[0]) &&
  /edite o produto em vez de remover/.test(mensagens[0]), '✕ do X bacon: avisa que está na promoção e sugere editar');
checar(cat.items.length === 2, '   cancelado o aviso, o produto fica');
clicarX(cat.items[1]);
checar(mensagens[1] === 'Remover "X Tudo" do cardápio?', '✕ de produto fora da promoção: a pergunta de sempre');

console.log('\n\x1b[32mpainelpromoconsertotest: tudo passou.\x1b[0m');
