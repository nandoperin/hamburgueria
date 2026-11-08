/**
 * Dias da promoção escolhidos no painel (dono, 07/11/2026): cada dia da
 * semana tem uma caixinha. Marcando só domingo, a promoção vale só no
 * domingo; terça e quarta continua exatamente como era.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.LOG_LEVEL = 'silent';

const PROJECT = require('path').resolve(__dirname, '..');
const menuProducao = require('./fixtures/menu-producao.json');
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
let promoDoc = null;
config.get = (chave) => {
  if (chave === 'menu') return menuProducao;
  if (chave === 'promotions') return promoDoc;
  return getReal(chave);
};
const base = JSON.parse(JSON.stringify(getReal('promotions')));
const comDias = (weekdays) => { promoDoc = { ...JSON.parse(JSON.stringify(base)), automatic: true, manual_active: false, disabled_date: null, weekdays }; };

const promotions = require(`${PROJECT}/src/services/promotions`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}
// 08/11/2026 é domingo; 10/11 é terça (meio-dia em Nova York).
const DOMINGO = new Date('2026-11-08T17:00:00Z');
const TERCA = new Date('2026-11-10T17:00:00Z');
const QUARTA = new Date('2026-11-11T17:00:00Z');

// ---------------------------------------------------------------- servidor
comDias([2, 3]);
checar(!promotions.ativa(DOMINGO) && promotions.ativa(TERCA) && promotions.ativa(QUARTA), 'terça e quarta: vale terça e quarta, não domingo (como sempre)');
checar(promotions.mensagemIndisponivel('pt') === 'Esta promoção é válida somente às terças e quartas-feiras.',
  'terça e quarta: a frase de "não vale hoje" é a de sempre');

comDias([0]);
checar(promotions.ativa(DOMINGO) && !promotions.ativa(TERCA), 'só domingo marcado: vale no domingo e não na terça');
checar(promotions.mensagemIndisponivel('pt') === 'Esta promoção é válida somente: domingo.' &&
  promotions.mensagemIndisponivel('en') === 'This special is available only on: Sunday.',
  'só domingo: a frase cita domingo (pt e en)');

comDias([5, 6, 0]);
checar(promotions.diasTexto('pt') === 'domingo, sexta e sábado' && promotions.ativa(DOMINGO) && !promotions.ativa(QUARTA),
  'vários dias: "domingo, sexta e sábado"');
checar(config.validar('promotions', promoDoc).length === 0, 'o painel salva a promoção com os dias novos');
checar(config.validar('promotions', { ...promoDoc, weekdays: [] }).length > 0, 'sem nenhum dia, o servidor recusa (como antes)');

// ---------------------------------------------------------------- painel
const pagina = require(`${PROJECT}/src/api/painel-page`).render(15, 'nonce-teste');
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
function no(tag) { return { tag, filhos: [], append(...f) { this.filhos.push(...f); }, replaceChildren(...f) { this.filhos = f; } }; }
const el = (tag, props, ...filhos) => { const n = no(tag); n.props = props || {}; n.append(...filhos); if (tag === 'input') n.checked = false; return n; };
const caixas = (raiz) => {
  const achadas = [];
  const andar = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.tag === 'label' && n.filhos[0]?.tag === 'input' && typeof n.filhos[1] === 'string') achadas.push({ nome: n.filhos[1], cb: n.filhos[0] });
    (n.filhos || []).forEach(andar);
  };
  andar(raiz);
  return achadas;
};
const painelDoc = JSON.parse(JSON.stringify(base));
painelDoc.automatic = true;
painelDoc.weekdays = [2, 3];
const avisos = [];
const codigo = `const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];\n` +
  ['diasDaPromo', 'juntarDias', 'renomearCategoriaPromo', 'renderPromocao'].map(pegar).join('\n') +
  '\nreturn { renderPromocao };';
const { renderPromocao } = new Function('el', 'doc', 'marcarSujo', 'alert', 'promocaoAtivaAgora', 'dataLocalPromocao',
  'cardPromocao', 'formularioNovaPromocao', codigo)(
  el, painelDoc, () => {}, (m) => avisos.push(m), () => false, () => '2026-11-07', () => no('card'), () => no('form'));

const main = no('main');
renderPromocao(main);
let dias = caixas(main).filter((c) => ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'].includes(c.nome));
checar(dias.length === 7 && dias.filter((d) => d.cb.checked).map((d) => d.nome).join(',') === 'terça,quarta',
  'painel: 7 caixinhas, com terça e quarta marcadas');
const clicar = (nome, marcado) => {
  const d = caixas(main).find((c) => c.nome === nome);
  d.cb.checked = marcado;
  d.cb.props.onchange ? d.cb.props.onchange() : d.cb.onchange();
};
// el() guarda onchange nas props; o código atribui cb.onchange depois de criar.
clicar('domingo', true);
clicar('terça', false);
clicar('quarta', false);
checar(painelDoc.weekdays.join(',') === '0' && painelDoc.category.name.pt === 'Promo Domingo' &&
  painelDoc.category.name.en === 'Sunday specials', 'painel: marcando só domingo, a promoção vira "Promo Domingo"');
clicar('domingo', false);
checar(painelDoc.weekdays.join(',') === '0' && avisos.length === 1, 'painel: desmarcar o último dia não deixa — avisa');
clicar('terça', true);
clicar('quarta', true);
clicar('domingo', false);
checar(painelDoc.weekdays.join(',') === '2,3' && painelDoc.category.name.pt === 'Promo Terça e Quarta',
  'painel: voltando para terça e quarta, o nome volta ao de sempre');

// ---------------------------------------------------------------- site e bot
comDias([0]);
promoDoc.category.name = { pt: 'Promo Domingo', en: 'Sunday specials', es: 'Promoción de domingo' };
const cardapio = require(`${PROJECT}/src/services/cardapio`);
checar(cardapio.categorias().some((c) => c.name?.pt === 'Promo Domingo'), 'bot e site: a categoria aparece como "Promo Domingo"');

console.log('\n\x1b[32mpromodiastest: tudo passou.\x1b[0m');
