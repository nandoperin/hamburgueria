/**
 * Código automático no cadastro (dono, 07/11/2026): ao criar produto ou
 * ingrediente no painel, o dono digita só o nome e o código sai dele. Os
 * itens que já existem não mudam de código.
 *
 * Roda o JavaScript da própria página com um DOM mínimo de mentira, como o
 * painelorfaostest.
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
checar(!script.includes('Id do item novo') && !script.includes('Id do ingrediente'),
  'o painel não pede mais o id ao dono');

const pegar = (nome) => {
  const i = script.indexOf(`function ${nome}(`);
  const ini = script.lastIndexOf('\n', i) + 1;
  let profundidade = 0;
  let j = script.indexOf('{', i);
  for (; j < script.length; j++) {
    if (script[j] === '{') profundidade++;
    if (script[j] === '}' && --profundidade === 0) break;
  }
  return script.slice(ini, j + 1);
};

function no(tag) {
  return { tag, filhos: [], append(...f) { this.filhos.push(...f); }, replaceChildren(...f) { this.filhos = f; } };
}
const el = (tag, props, ...filhos) => {
  const n = no(tag);
  n.props = props || {};
  if (n.props.onclick) n.onclick = n.props.onclick;
  n.append(...filhos);
  return n;
};
const botoes = (raiz) => {
  const achados = [];
  const andar = (n) => { if (!n || typeof n !== 'object') return; if (n.tag === 'button') achados.push(n); (n.filhos || []).forEach(andar); };
  andar(raiz);
  return achados;
};

const doc = {
  categories: [
    { id: 'sanduiches', name: { pt: 'Sanduíches' }, items: [{ id: 'x_burger', name: { pt: 'X Burger' } }, { id: 'x_duplo', name: { pt: 'X Duplo' } }] },
    { id: 'adicionais', name: { pt: 'Adicionais' }, items: [{ id: 'bacon', name: { pt: 'Bacon' } }] },
  ],
  ingredientes: { tomate: { name: { pt: 'Tomate' }, price: 0 }, bacon: { name: { pt: 'Bacon' }, price: 4 } },
};
let resposta = '';
const fila = []; // respostas em ordem, para quem pergunta duas vezes
let sujo = 0;
const codigo = `${pegar('codigoNovo')}\n${pegar('idsDoCardapio')}\n${pegar('renderMenu')}\n${pegar('renderIngredientes')}\n` +
  'return { codigoNovo, idsDoCardapio, renderMenu, renderIngredientes };';
const f = new Function('el', 'doc', 'prompt', 'marcarSujo', 'cardItem', 'conferirOrfaos', 'lanchesQueUsam', 'window', 'confirm', codigo)(
  el, doc, () => (fila.length ? fila.shift() : resposta), () => { sujo += 1; }, () => no('card'), () => {}, () => [], {}, () => true);

// O código gerado do nome.
const vazio = new Set();
checar(f.codigoNovo('X Duplo Bacon', vazio) === 'x_duplo_bacon', '"X Duplo Bacon" vira x_duplo_bacon');
checar(f.codigoNovo('Pão australiano', vazio) === 'pao_australiano', 'acento sai: "Pão australiano" vira pao_australiano');
checar(f.codigoNovo('  Coca-Cola 2L!! ', vazio) === 'coca_cola_2l', 'pontuação e espaços viram um _ só');
checar(f.codigoNovo('X Duplo', new Set(['x_duplo'])) === 'x_duplo_2' &&
  f.codigoNovo('X Duplo', new Set(['x_duplo', 'x_duplo_2'])) === 'x_duplo_3', 'código repetido ganha _2, _3');
checar(f.codigoNovo('!!!', vazio) === 'item', 'nome sem letra nem número vira "item"');
checar(/^[a-z0-9_]+$/.test(f.codigoNovo('Hambúrguer Ç & Ñ', vazio)), 'só letras minúsculas, números e _');

// "+ item": pede o nome, gera o código e já preenche o nome.
const main = no('main');
f.renderMenu(main);
resposta = 'X Duplo';
botoes(main).find((b) => /\+ item em Sanduíches/.test(b.filhos.join(''))).onclick();
const novo = doc.categories[0].items.at(-1);
checar(novo.id === 'x_duplo_2' && novo.name.pt === 'X Duplo' && novo.available === true && sujo === 1,
  '+ item: "X Duplo" já existente vira x_duplo_2, com o nome preenchido');
resposta = 'Bacon';
botoes(main).find((b) => /\+ item em Adicionais/.test(b.filhos.join(''))).onclick();
checar(doc.categories[1].items.at(-1).id === 'bacon_2', '+ item: não repete código de outra categoria');
checar(doc.categories[0].items[0].id === 'x_burger' && doc.categories[0].items[1].id === 'x_duplo', 'os itens antigos ficam com o código de sempre');
const antes = doc.categories[0].items.length;
resposta = '   ';
botoes(main).find((b) => /\+ item em Sanduíches/.test(b.filhos.join(''))).onclick();
checar(doc.categories[0].items.length === antes, '+ item: cancelado ou sem nome, nada é criado');

// "+ categoria": nome e emoji; código do nome; nasce vazia, nos 3 idiomas.
const mainCat = no('main');
f.renderMenu(mainCat);
const botaoCat = () => botoes(mainCat).find((b) => b.filhos.join('') === '+ categoria');
checar(Boolean(botaoCat()), '+ categoria aparece no fim do cardápio');
fila.push('Sobremesas', '🍰');
botaoCat().onclick();
const cat = doc.categories.at(-1);
checar(cat.id === 'sobremesas' && cat.emoji === '🍰' && cat.name.pt === 'Sobremesas' && cat.name.en === 'Sobremesas' &&
  cat.name.es === 'Sobremesas' && Array.isArray(cat.items) && cat.items.length === 0,
  '+ categoria: "Sobremesas" com 🍰, código sobremesas, vazia e com o nome nos 3 idiomas');
fila.push('Sobremesas', '');
botaoCat().onclick();
checar(doc.categories.at(-1).id === 'sobremesas_2' && doc.categories.at(-1).emoji === '🍽️',
  '+ categoria: nome repetido vira sobremesas_2; sem emoji, usa 🍽️');
const qtdCat = doc.categories.length;
fila.push('');
botaoCat().onclick();
checar(doc.categories.length === qtdCat, '+ categoria: cancelado, nada é criado');
checar(doc.categories[0].id === 'sanduiches' && doc.categories[1].id === 'adicionais', 'as categorias antigas ficam como estavam');


// "+ ingrediente": o mesmo.
const mainIng = no('main');
f.renderIngredientes(mainIng);
resposta = 'Queijo Cheddar';
botoes(mainIng).find((b) => /\+ ingrediente/.test(b.filhos.join(''))).onclick();
checar(doc.ingredientes.queijo_cheddar?.name?.pt === 'Queijo Cheddar' && doc.ingredientes.queijo_cheddar.price === 0,
  '+ ingrediente: "Queijo Cheddar" vira queijo_cheddar, com o nome preenchido');
resposta = 'Tomate';
botoes(mainIng).find((b) => /\+ ingrediente/.test(b.filhos.join(''))).onclick();
checar(doc.ingredientes.tomate_2?.name?.pt === 'Tomate' && doc.ingredientes.tomate.name.pt === 'Tomate',
  '+ ingrediente: nome repetido não apaga o antigo, vira tomate_2');

console.log('\n\x1b[32mpainelcodigotest: tudo passou.\x1b[0m');
