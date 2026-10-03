/**
 * Ingrediente apagado no painel continuava escondido nos lanches (03/10:
 * Molho do hot e Macarrão em 22 lanches, e "cardapio com 49 problema(s)" no
 * boot). A aba Ingredientes passa a mostrar e a limpar.
 *
 * Roda o JavaScript da própria página com um DOM mínimo de mentira.
 */
const PROJECT = require('path').resolve(__dirname, '..');
const pagina = require(`${PROJECT}/src/api/painel-page`).render(15, 'nonce-teste');

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const script = [...pagina.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
checar(Boolean(script) && (() => { try { new Function(script); return true; } catch { return false; } })(),
  'o JavaScript da página continua válido');

// DOM mínimo: só o que as funções novas usam.
function no(tag) {
  return {
    tag, filhos: [], props: {},
    append(...f) { this.filhos.push(...f); },
    replaceChildren(...f) { this.filhos = f; },
    get texto() { return this.filhos.map((f) => (typeof f === 'string' ? f : f.texto)).join(' '); },
  };
}
const ambiente = {
  window: {},
  document: { getElementById: () => no('x'), querySelectorAll: () => [], addEventListener: () => {} },
  confirm: () => true,
  avisos: [],
  postado: null,
};
const el = (tag, props, ...filhos) => {
  const n = no(tag);
  n.props = props || {};
  if (n.props.onclick) n.onclick = n.props.onclick;
  n.append(...filhos);
  return n;
};
const menu = {
  categories: [{ id: 'lanches', items: [
    { id: 'x_burger', modifiers: { removable: ['tomate', 'molho_hot', 'macarrao'], addable: ['bacon', 'molho_hot'] } },
    { id: 'x_tudo', modifiers: { removable: ['tomate', 'molho_hot'], addable: ['bacon'] } },
    { id: 'coca', modifiers: null },
  ] }],
};
const api = async (caminho, opcoes) => {
  if (opcoes?.method === 'POST') { ambiente.postado = { caminho, corpo: JSON.parse(opcoes.body) }; return { ok: true }; }
  return { doc: JSON.parse(JSON.stringify(menu)) };
};

// Extrai só as duas funções novas do script da página e roda com o DOM falso.
const pegar = (nome) => {
  const i = script.indexOf(`function ${nome}(`);
  const ini = script.lastIndexOf('\n', script.lastIndexOf(nome.startsWith('conferir') ? 'async function' : 'function', i)) + 1;
  let profundidade = 0;
  let j = script.indexOf('{', i);
  for (; j < script.length; j++) {
    if (script[j] === '{') profundidade++;
    if (script[j] === '}' && --profundidade === 0) break;
  }
  return script.slice(ini, j + 1);
};
const codigo = `${pegar('lanchesQueUsam')}\n${pegar('conferirOrfaos')}\nreturn { lanchesQueUsam, conferirOrfaos };`;
const { lanchesQueUsam, conferirOrfaos } = new Function('el', 'api', 'avisar', 'window', 'confirm', codigo)(
  el, api, (m) => ambiente.avisos.push(m), ambiente.window, () => true);

(async () => {
  checar(lanchesQueUsam(menu, 'molho_hot').length === 2 && lanchesQueUsam(menu, 'macarrao').length === 1 &&
    lanchesQueUsam(menu, 'banana').length === 0, 'conta em quantos lanches o ingrediente está');

  const dic = { tomate: {}, bacon: {} }; // molho_hot e macarrao foram apagados da lista
  const alvo = no('div');
  await conferirOrfaos(alvo, dic);
  checar(/molho_hot/.test(alvo.texto) && /macarrao/.test(alvo.texto) && /2 lanche/.test(alvo.texto),
    'o quadro aponta os 2 apagados e os 2 lanches');

  const botao = alvo.filhos[0].filhos.find((f) => f.tag === 'button');
  await botao.onclick();
  const salvo = ambiente.postado;
  checar(salvo && salvo.caminho === '/config/menu', 'o botão salva o cardápio');
  const itens = salvo.corpo.doc.categories[0].items;
  checar(itens.every((i) => !i.modifiers || ![...i.modifiers.removable, ...i.modifiers.addable].some((x) => ['molho_hot', 'macarrao'].includes(x))),
    '   sem molho_hot nem macarrao em lanche nenhum');
  checar(itens[0].modifiers.removable.includes('tomate') && itens[0].modifiers.addable.includes('bacon'),
    '   e o resto dos ingredientes fica como estava');

  const limpo = no('div');
  await conferirOrfaos(limpo, { tomate: {}, bacon: {}, molho_hot: {}, macarrao: {} });
  checar(!limpo.filhos.length, 'sem apagados, o quadro não aparece');

  console.log('\n\x1b[32mpainelorfaostest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
