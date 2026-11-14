/**
 * A página do painel — HTML, CSS e JS num arquivo só.
 *
 * Sem framework, sem build, sem recurso externo. Ela abre no navegador do
 * celular do dono, muitas vezes em rede ruim: cada requisição a mais é uma
 * chance de não abrir. E sem recurso externo não há nada que rastreie quem
 * entrou.
 *
 * O CSP no cabeçalho é o cinto: mesmo que algum texto de config chegasse com
 * marcação junto, não haveria script externo para carregar.
 */

const CSS = `
:root{--bg:#faf8f5;--card:#fff;--tinta:#1c1917;--suave:#78716c;--linha:#e7e5e4;
  --acao:#c2410c;--ok:#15803d;--erro:#b91c1c;--chip:#f5f5f4}
@media(prefers-color-scheme:dark){:root{--bg:#1c1917;--card:#292524;--tinta:#fafaf9;
  --suave:#a8a29e;--linha:#44403c;--acao:#fb923c;--ok:#4ade80;--erro:#f87171;--chip:#44403c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tinta);padding-bottom:5rem;
  font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{padding:1rem;border-bottom:1px solid var(--linha);position:sticky;top:0;
  background:var(--bg);z-index:10}
h1{margin:0 0 .6rem;font-size:1.15rem}
nav{display:flex;gap:.3rem;overflow-x:auto;-webkit-overflow-scrolling:touch}
nav button{flex:0 0 auto;background:var(--chip);border:1px solid var(--linha);
  color:var(--tinta);border-radius:999px;padding:.4rem .85rem;font-size:.85rem;cursor:pointer}
nav button[aria-selected=true]{background:var(--acao);border-color:var(--acao);color:#fff}
main{max-width:720px;margin:0 auto;padding:1rem}
h2{font-size:.75rem;text-transform:uppercase;letter-spacing:.09em;color:var(--suave);
  margin:1.5rem 0 .5rem}
.card{background:var(--card);border:1px solid var(--linha);border-radius:12px;
  padding:.75rem .9rem;margin-bottom:.5rem}
.linha{display:flex;gap:.5rem;align-items:center}
.linha input[type=text]{flex:1;min-width:0}
input,select,textarea{background:var(--bg);color:var(--tinta);border:1px solid var(--linha);
  border-radius:8px;padding:.45rem .6rem;font:inherit;font-size:.92rem}
input[type=number]{width:5.5rem;text-align:right}
textarea{width:100%;min-height:3.5rem;margin-top:.5rem}
label{font-size:.8rem;color:var(--suave);display:flex;align-items:center;gap:.3rem}
.det{margin-top:.7rem;padding-top:.7rem;border-top:1px dashed var(--linha);display:none}
.card.aberto .det{display:block}
.card.off{opacity:.55}
.ings{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.35rem}
.ings label{background:var(--chip);border-radius:999px;padding:.2rem .55rem;font-size:.78rem;
  color:var(--tinta);cursor:pointer}
.mini{background:none;border:none;color:var(--suave);cursor:pointer;font-size:1.1rem;padding:.2rem .4rem}
.mini:hover{color:var(--erro)}
.add{background:none;border:1px dashed var(--linha);color:var(--suave);border-radius:10px;
  padding:.5rem 1rem;cursor:pointer;font:inherit;font-size:.85rem;width:100%;margin-top:.3rem}
.barra{position:fixed;bottom:0;left:0;right:0;background:var(--card);
  border-top:1px solid var(--linha);padding:.7rem 1rem;display:flex;gap:.7rem;
  align-items:center;justify-content:flex-end}
.salvar{background:var(--acao);color:#fff;border:none;border-radius:10px;
  padding:.6rem 1.4rem;font:inherit;font-weight:600;cursor:pointer}
.salvar:disabled{opacity:.45;cursor:default}
#aviso{flex:1;font-size:.82rem}
.ok{color:var(--ok)}.err{color:var(--erro)}
table{width:100%;border-collapse:collapse;font-size:.88rem}
th,td{text-align:left;padding:.4rem .3rem;border-bottom:1px solid var(--linha)}
th{color:var(--suave);font-weight:600;font-size:.75rem;text-transform:uppercase}
td.num,th.num{text-align:right;white-space:nowrap}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:.5rem}
.kpi{background:var(--card);border:1px solid var(--linha);border-radius:12px;padding:.75rem}
.kpi b{display:block;font-size:1.35rem;color:var(--acao)}
.kpi span{font-size:.75rem;color:var(--suave)}
.barinha{height:6px;background:var(--acao);border-radius:3px;min-width:2px}
.vazio{color:var(--suave);font-size:.88rem;padding:1rem 0}
.estado{display:inline-flex;align-items:center;gap:.4rem;border-radius:999px;
  padding:.3rem .65rem;font-size:.8rem;font-weight:650;background:var(--chip)}
.estado.ativa{color:var(--ok)}.estado.inativa{color:var(--suave)}
.explica{margin:.45rem 0 0;color:var(--suave);font-size:.82rem}
.erro-promo{margin-top:.6rem;padding:.6rem;border:1px solid var(--erro);border-radius:.5rem}
.erro-promo .explica{color:var(--erro);margin-top:0}
.subabas{display:flex;gap:.4rem;margin-bottom:.7rem}
.subabas button{flex:1;background:var(--chip);border:1px solid var(--linha);color:var(--tinta);
  border-radius:10px;padding:.55rem .8rem;font:inherit;font-size:.9rem;font-weight:600;cursor:pointer}
.subabas button[aria-selected=true]{background:var(--acao);border-color:var(--acao);color:#fff}
input[type=date]{flex:1;min-width:0}
.atalhos{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.6rem}
.atalhos button{background:var(--chip);border:1px solid var(--linha);color:var(--tinta);
  border-radius:999px;padding:.3rem .8rem;font-size:.8rem;cursor:pointer}
.pequeno{display:block;font-size:.72rem;color:var(--suave)}
.conferencia-lista{display:grid;gap:.5rem}
.conferencia-item{background:var(--card);border:1px solid var(--linha);border-radius:12px;
  padding:.75rem .9rem}
.conferencia-topo{display:flex;gap:1rem;align-items:flex-start}
.conferencia-topo>div{min-width:0;flex:1}
.conferencia-topo b{display:block;overflow-wrap:anywhere}
.conferencia-valor{color:var(--acao);font-size:1.12rem;white-space:nowrap}
.conferencia-endereco{margin-top:.55rem;font-size:.86rem;overflow-wrap:anywhere}
`.trim();

const JS = `
history.replaceState(null, '', '/painel');
let doc = {}, aba = 'menu', sujo = false;

const api = async (p, opts = {}) => {
  const r = await fetch('/painel/api' + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
  });
  if (r.status === 401) { avisar('Sessão expirada. Peça !painel de novo.', true); throw new Error('401'); }
  return r.json();
};

const el = (t, a = {}, ...kids) => {
  const n = document.createElement(t);
  for (const [k, v] of Object.entries(a)) {
    if (k === 'cls') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : String(c));
  return n;
};

const money = (n) => '$' + Number(n || 0).toFixed(2);
function marcarSujo() { sujo = true; document.getElementById('salvar').disabled = false; avisar(''); }
function avisar(msg, erro) {
  const a = document.getElementById('aviso');
  a.textContent = msg; a.className = erro ? 'err' : 'ok';
}

// ------------------------------------------------------------------ abas
const ABAS = {
  menu: ['🍔 Cardápio', renderMenu],
  promotions: ['🔥 Promoção', renderPromocao],
  ingredientes: ['🧂 Ingredientes', renderIngredientes],
  delivery: ['🚗 Entrega', renderEntrega],
  schedule: ['🕐 Horário', renderHorario],
  relatorios: ['📊 Relatórios', renderRelatorios],
  conversas: ['💬 Conversas', renderConversas],
  exemplos: ['🧠 Exemplos', renderExemplos],
  perguntas: ['❓ Perguntas', renderPerguntas],
  backups: ['💾 Backups', renderBackups],
};

// Abas que só leem — sem \`doc\` de config/painel/api, sem barra de salvar.
// (Exemplos e Perguntas têm os próprios botões: cada item salva sozinho.)
const SOMENTE_LEITURA = ['relatorios', 'conversas', 'exemplos', 'perguntas', 'backups'];

async function abrir(nome) {
  if (sujo && !confirm('Há alterações não salvas. Sair mesmo assim?')) return;
  aba = nome; sujo = false;
  document.querySelectorAll('nav button').forEach((b) =>
    b.setAttribute('aria-selected', b.dataset.aba === nome));

  const main = document.getElementById('main');
  main.replaceChildren(el('p', { cls: 'vazio' }, 'Carregando…'));

  const barra = document.getElementById('barra');
  barra.style.display = SOMENTE_LEITURA.includes(nome) ? 'none' : 'flex';
  document.getElementById('salvar').disabled = true;
  avisar('');

  if (SOMENTE_LEITURA.includes(nome)) return ABAS[nome][1](main);
  const r = await api('/config/' + nome);
  doc = r.doc;
  if (nome === 'promotions') {
    const menuPromo = await api('/config/menu');
    window.__menuPromo = menuPromo.doc;
  }
  // Na aba Cardápio, a promoção só para leitura: o ✕ avisa quando o produto
  // está nela (08/11: o X Bacon recriado deixou a promoção sem produto-base).
  if (nome === 'menu') {
    try { window.__promoDoMenu = (await api('/config/promotions')).doc; } catch (e) { window.__promoDoMenu = null; }
  }
  ABAS[nome][1](main);
}

// --------------------------------------------------------------- promoção
function dataLocalPromocao() {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: doc.timezone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const valor = (tipo) => partes.find((p) => p.type === tipo)?.value;
  return valor('year') + '-' + valor('month') + '-' + valor('day');
}

function promocaoAtivaAgora() {
  if (doc.disabled_date === dataLocalPromocao()) return false;
  if (doc.automatic !== true) return doc.manual_active === true;
  const dia = new Intl.DateTimeFormat('en-US', {
    timeZone: doc.timezone || 'America/New_York', weekday: 'short'
  }).format(new Date());
  const numero = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[dia];
  return (doc.weekdays || [2, 3]).includes(numero);
}

// Dias da promoção escolhidos pelo dono (07/11): antes era sempre terça e
// quarta. O servidor já guardava a lista em weekdays; aqui viram caixinhas.
function diasDaPromo() {
  return [...new Set(doc.weekdays || [2, 3])].sort((a, b) => a - b);
}
function juntarDias(nomes, e) {
  return nomes.length <= 1 ? (nomes[0] || '') : nomes.slice(0, -1).join(', ') + e + nomes[nomes.length - 1];
}
// O nome da categoria acompanha os dias — é o que o cliente vê no bot e no
// site. Terça e quarta volta ao nome de sempre.
function renomearCategoriaPromo() {
  doc.category = doc.category || { items: [] };
  const dias = diasDaPromo();
  if (dias.join(',') === '2,3') {
    doc.category.name = { pt: 'Promo Terça e Quarta', en: 'Tuesday & Wednesday specials', es: 'Promoción de martes y miércoles' };
    return;
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const en = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const es = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  doc.category.name = {
    pt: 'Promo ' + juntarDias(dias.map((d) => cap(DIAS[d])), ' e '),
    en: juntarDias(dias.map((d) => en[d]), ' & ') + ' specials',
    es: 'Promoción de ' + juntarDias(dias.map((d) => es[d]), ' y '),
  };
}

function renderPromocao(main) {
  const ativa = promocaoAtivaAgora();
  const automatico = el('input', { type: 'checkbox' });
  automatico.checked = doc.automatic === true;
  automatico.onchange = () => {
    doc.automatic = automatico.checked;
    marcarSujo();
    renderPromocao(main);
  };
  const diasTexto = juntarDias(diasDaPromo().map((d) => DIAS[d]), ' e ');

  const nos = [
    el('div', { cls: 'card' },
      el('div', { cls: 'linha' },
        el('span', { cls: 'estado ' + (ativa ? 'ativa' : 'inativa') },
          ativa ? '● Promoção ativa agora' : '○ Promoção inativa agora')),
      el('p', { cls: 'explica' }, doc.automatic === true
        ? 'Ativa às 00h de cada dia marcado (' + diasTexto + ') e desativa à meia-noite seguinte, no horário de Nova York.'
        : 'O modo automático está desligado. O estado abaixo decide se o bot aceita a promoção.')),
    el('div', { cls: 'card' },
      el('label', {}, automatico, 'Ativar automaticamente nos dias marcados abaixo')),
  ];

  if (doc.automatic === true) {
    const caixas = el('div', { cls: 'ings' });
    DIAS.forEach((nomeDia, numero) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = diasDaPromo().includes(numero);
      cb.onchange = () => {
        const dias = new Set(diasDaPromo());
        if (cb.checked) dias.add(numero); else dias.delete(numero);
        // O servidor recusa promoção sem dia: pelo menos um fica marcado.
        if (!dias.size) { cb.checked = true; alert('Marque pelo menos um dia. Para parar a promoção, desligue o modo automático.'); return; }
        doc.weekdays = [...dias].sort((a, b) => a - b);
        renomearCategoriaPromo();
        marcarSujo();
        renderPromocao(main);
      };
      caixas.append(el('label', {}, cb, nomeDia));
    });
    nos.push(el('div', { cls: 'card' }, el('h2', {}, 'Dias da promoção'), caixas));
  }

  const pausadaHoje = doc.disabled_date === dataLocalPromocao();
  nos.push(el('div', { cls: 'card' },
    el('button', { cls: pausadaHoje ? 'add' : 'mini', onclick: () => {
      doc.disabled_date = pausadaHoje ? null : dataLocalPromocao();
      marcarSujo();
      renderPromocao(main);
    } }, pausadaHoje ? 'Reativar promoção hoje' : 'Desativar promoção hoje'),
    el('p', { cls: 'explica' }, pausadaHoje
      ? 'A promoção está pausada hoje e volta automaticamente no próximo dia programado.'
      : 'Use quando não quiser vender a promoção somente no dia de hoje.')));

  if (doc.automatic !== true) {
    const manual = el('input', { type: 'checkbox' });
    manual.checked = doc.manual_active === true;
    manual.onchange = () => {
      doc.manual_active = manual.checked;
      marcarSujo();
      renderPromocao(main);
    };
    nos.push(el('div', { cls: 'card' },
      el('label', {}, manual, 'Promoção ativa manualmente agora')));
  }

  const categoria = doc.category || { items: [] };
  nos.push(el('h2', {}, 'Produtos da ' + (doc.category?.name?.pt || 'promoção')));
  for (const item of categoria.items || []) nos.push(cardPromocao(item));
  nos.push(formularioNovaPromocao(main, categoria));
  main.replaceChildren(...nos);
}

function produtosBasePromocao() {
  return (window.__menuPromo?.categories || []).flatMap((categoria) =>
    (categoria.items || []).filter((item) => item.available !== false && item.catalogVisible !== false)
      .map((item) => ({ ...item, categoria: categoria.name?.pt || categoria.id })));
}

function formularioNovaPromocao(main, categoria) {
  const card = el('div', { cls: 'card' }, el('h3', {}, 'Cadastrar outro produto na promoção'));
  const seletor = el('select', {});
  for (const item of produtosBasePromocao()) {
    seletor.append(el('option', { value: item.id }, item.categoria + ' · ' + (item.name?.pt || item.id)));
  }
  const quantidade = el('input', { type: 'number', min: '1', step: '1', value: 1, title: 'Quantidade do pacote' });
  const preco = el('input', { type: 'number', min: '0', step: '0.01', value: 0, title: 'Preço promocional total' });
  card.append(el('div', { cls: 'linha' }, seletor, quantidade, preco,
    el('button', { cls: 'add', onclick: () => {
      const base = produtosBasePromocao().find((item) => item.id === seletor.value);
      const qtd = Number(quantidade.value);
      const valor = Number(preco.value);
      if (!base || !Number.isInteger(qtd) || qtd < 1 || !Number.isFinite(valor) || valor < 0) {
        alert('Escolha o produto, a quantidade e um preço válido.'); return;
      }
      let id = 'promo_' + base.id + '_' + qtd;
      let sufixo = 2;
      while ((categoria.items || []).some((item) => item.id === id)) id = 'promo_' + base.id + '_' + qtd + '_' + sufixo++;
      const nomeBase = base.name?.pt || base.id;
      const nome = (qtd > 1 ? qtd + ' ' : '') + nomeBase + ' — preço promocional';
      categoria.items.push({
        id, base_item_id: base.id, bundle_quantity: qtd,
        name: { pt: nome },
        description: { pt: (base.description?.pt || nomeBase) + '. Promoção de ' + juntarDias(diasDaPromo().map((d) => DIAS[d]), ' e ') + '.' },
        price: valor, available: true,
      });
      marcarSujo(); renderPromocao(main);
    } }, 'Adicionar')));
  card.append(el('p', { cls: 'explica' },
    'Escolha um produto do cardápio, quantas unidades entram na oferta e o preço total.'));
  return card;
}

function cardPromocao(item) {
  const card = el('div', { cls: 'card' });
  const nome = el('input', { type: 'text', value: item.name?.pt || '', placeholder: 'Nome do produto' });
  nome.oninput = () => { item.name = { ...item.name, pt: nome.value }; marcarSujo(); };
  const preco = el('input', { type: 'number', step: '0.01', min: '0', value: item.price ?? 0 });
  preco.oninput = () => { item.price = Number(preco.value); marcarSujo(); };
  const dispo = el('input', { type: 'checkbox' });
  dispo.checked = item.available !== false;
  dispo.onchange = () => { item.available = dispo.checked; marcarSujo(); };

  card.append(el('div', { cls: 'linha' }, nome, preco,
    el('label', {}, dispo, 'incluído'),
    el('button', { cls: 'mini', title: 'detalhes',
      onclick: () => card.classList.toggle('aberto') }, '▾'),
    el('button', { cls: 'mini', title: 'remover', onclick: () => {
      if (!confirm('Remover "' + (item.name?.pt || item.id) + '" da promoção?')) return;
      doc.category.items = doc.category.items.filter((i) => i !== item);
      marcarSujo(); renderPromocao(document.getElementById('main'));
    } }, '✕')));

  // Produto-base que sumiu do cardápio (apagado e recriado com outro código):
  // o servidor não salva a promoção assim. "Consertar" aponta para o produto
  // atual escolhido aqui (08/11, X Bacon).
  const todosDoCardapio = (window.__menuPromo?.categories || []).flatMap((c) =>
    (c.items || []).map((i) => ({ id: i.id, nome: (c.name?.pt || c.id) + ' · ' + (i.name?.pt || i.id) })));
  if (window.__menuPromo && !todosDoCardapio.some((i) => i.id === item.base_item_id)) {
    const escolha = el('select', {});
    for (const i of todosDoCardapio) escolha.append(el('option', { value: i.id }, i.nome));
    const parecido = todosDoCardapio.find((i) => String(item.base_item_id || '').replace(/_/g, '') === i.id.replace(/_/g, ''));
    if (parecido) escolha.value = parecido.id;
    card.append(el('div', { cls: 'erro-promo' },
      el('p', { cls: 'explica' }, '⚠️ O produto deste item ("' + (item.base_item_id || '?') +
        '") não existe mais no cardápio — a promoção não salva assim. Escolha o produto certo:'),
      el('div', { cls: 'linha' }, escolha, el('button', { cls: 'add', onclick: () => {
        if (!escolha.value) return;
        item.base_item_id = escolha.value;
        marcarSujo();
        renderPromocao(document.getElementById('main'));
      } }, 'Consertar'))));
  }

  const det = el('div', { cls: 'det' });
  const desc = el('textarea', { placeholder: 'Descrição da promoção' });
  desc.value = item.description?.pt || '';
  desc.oninput = () => { item.description = { ...item.description, pt: desc.value }; marcarSujo(); };
  det.append(desc, el('p', { cls: 'vazio' },
    'Produto-base: ' + (item.base_item_id || 'não definido') +
    ' · unidades: ' + (item.bundle_quantity || 1)));
  card.append(det);
  return card;
}

// Código interno gerado do nome (dono, 07/11): o dono digita só o nome do
// produto ou do ingrediente. "X Duplo Bacon" vira x_duplo_bacon, "Pão
// australiano" vira pao_australiano; se já existir, ganha _2, _3. Os itens
// antigos não mudam de código — o código é o que liga cardápio, carrinho,
// comanda e relatório, e trocar quebraria o histórico.
function codigoNovo(nome, existentes) {
  const base = String(nome || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'item';
  let id = base;
  let n = 2;
  while (existentes.has(id)) id = base + '_' + n++;
  return id;
}

function idsDoCardapio() {
  const ids = new Set();
  for (const cat of doc.categories || []) for (const item of cat.items || []) ids.add(item.id);
  return ids;
}

// ------------------------------------------------------------------ menu
function renderMenu(main) {
  const ings = Object.entries((window.__ings || {}));
  const nos = [];

  for (const cat of doc.categories || []) {
    nos.push(el('h2', {}, (cat.emoji || '') + ' ' + (cat.name?.pt || cat.id)));
    for (const item of cat.items || []) nos.push(cardItem(cat, item, ings));
    nos.push(el('button', { cls: 'add', onclick: () => {
      const nomeNovo = (prompt('Nome do produto novo (ex: X Duplo Bacon):') || '').trim();
      if (!nomeNovo) return;
      const id = codigoNovo(nomeNovo, idsDoCardapio());
      cat.items.push({ id, name: { pt: nomeNovo }, description: { pt: '' }, price: 0,
                       available: true, tags: [], allergens: [],
                       modifiers: { removable: [], addable: [] } });
      marcarSujo(); renderMenu(main);
    } }, '+ item em ' + (cat.name?.pt || cat.id)));
  }
  // Categoria nova (dono, 07/11: Sobremesas). Pede nome e emoji; o código sai
  // do nome. Nasce vazia — o bot e o site só a mostram quando tiver item à
  // venda — e com o nome nos três idiomas, como as de sempre.
  nos.push(el('button', { cls: 'add', onclick: () => {
    const nomeCat = (prompt('Nome da categoria nova (ex: Sobremesas):') || '').trim();
    if (!nomeCat) return;
    const emoji = (prompt('Emoji da categoria (ex: 🍰) — pode deixar em branco:') || '').trim().slice(0, 8) || '🍽️';
    const id = codigoNovo(nomeCat, new Set((doc.categories || []).map((c) => c.id)));
    doc.categories = doc.categories || [];
    doc.categories.push({ id, emoji, name: { pt: nomeCat, en: nomeCat, es: nomeCat }, items: [] });
    marcarSujo(); renderMenu(main);
  } }, '+ categoria'));
  main.replaceChildren(...nos);
}

function cardItem(cat, item, ings) {
  const card = el('div', { cls: 'card' });

  const nome = el('input', { type: 'text', value: item.name?.pt || '', placeholder: 'Nome do item' });
  nome.oninput = () => { item.name = { ...item.name, pt: nome.value }; marcarSujo(); };

  const preco = el('input', { type: 'number', step: '0.01', min: '0', value: item.price ?? 0 });
  preco.oninput = () => { item.price = Number(preco.value); marcarSujo(); };

  const dispo = el('input', { type: 'checkbox' });
  dispo.checked = item.available !== false;
  dispo.onchange = () => { item.available = dispo.checked; marcarSujo(); };

  card.append(el('div', { cls: 'linha' },
    nome, preco, el('label', {}, dispo, 'à venda'),
    el('button', { cls: 'mini', title: 'detalhes',
      onclick: () => card.classList.toggle('aberto') }, '▾'),
    el('button', { cls: 'mini', title: 'remover', onclick: () => {
      const naPromo = ((window.__promoDoMenu && window.__promoDoMenu.category && window.__promoDoMenu.category.items) || [])
        .filter((p) => p.base_item_id === item.id);
      const avisoPromo = naPromo.length
        ? '\\n\\nAtenção: este produto está na promoção (' + naPromo.map((p) => p.name?.pt || p.id).join(', ') +
          '). Removendo, esses itens da promoção param de valer até serem consertados na aba Promoção.' +
          '\\n\\nPara mudar nome ou preço, edite o produto em vez de remover e cadastrar de novo.'
        : '';
      if (!confirm('Remover "' + (item.name?.pt || item.id) + '" do cardápio?' + avisoPromo)) return;
      cat.items = cat.items.filter((i) => i !== item);
      marcarSujo(); renderMenu(document.getElementById('main'));
    } }, '✕')));

  const det = el('div', { cls: 'det' });
  const desc = el('textarea', { placeholder: 'Descrição que o cliente vê' });
  desc.value = item.description?.pt || '';
  desc.oninput = () => { item.description = { ...item.description, pt: desc.value }; marcarSujo(); };
  det.append(desc);

  // Como o cliente chama o produto no WhatsApp ("coca", "macarrao"). É o que
  // deixa o bot aceitar a palavra curta sem pedir pra repetir.
  const apelidos = el('input', { type: 'text', style: 'width:100%;margin-top:.5rem',
    value: (item.aliases || []).join(', '), placeholder: 'apelidos, separados por vírgula: coca, cocacola' });
  apelidos.oninput = () => {
    item.aliases = apelidos.value.split(',').map((s) => s.trim()).filter(Boolean);
    marcarSujo();
  };
  det.append(el('h2', {}, 'Apelidos (como o cliente pede)'), apelidos);

  // Adicionais: "pode ir à parte" decide se o produto pode ser vendido sozinho
  // (salsicha, sachê, bife) ou se sempre entra dentro de um lanche.
  if (cat.id === 'adicionais') {
    const aParte = el('input', { type: 'checkbox' });
    aParte.checked = typeof item.avulso === 'boolean'
      ? item.avulso
      : ['salsicha', 'sache_maionese'].includes(item.id);
    aParte.onchange = () => { item.avulso = aParte.checked; marcarSujo(); };
    det.append(el('h2', {}, 'Como este adicional é vendido'),
      el('label', {}, aParte, 'pode ir à parte (sozinho, sem lanche)'),
      el('p', { cls: 'explica' }, 'Desmarcado, ele sempre entra dentro de um lanche — ' +
        'e com mais de um lanche no pedido o bot pergunta em qual.'));
  }

  if (ings.length) {
    item.modifiers = item.modifiers || { removable: [], addable: [] };
    det.append(listaIng('Pode tirar (grátis)', item.modifiers, 'removable', ings));
    det.append(listaIng('Pode acrescentar (cobra)', item.modifiers, 'addable', ings));
  }
  det.append(el('p', { cls: 'vazio' }, 'id: ' + item.id));
  card.append(det);
  return card;
}

function listaIng(titulo, mods, campo, ings) {
  const box = el('div', {}, el('h2', {}, titulo));
  const lista = el('div', { cls: 'ings' });
  mods[campo] = mods[campo] || [];

  for (const [id, ing] of ings) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = mods[campo].includes(id);
    cb.onchange = () => {
      mods[campo] = cb.checked
        ? [...new Set([...mods[campo], id])]
        : mods[campo].filter((x) => x !== id);
      marcarSujo();
    };
    const rotulo = ing.name?.pt || id;
    lista.append(el('label', {}, cb,
      rotulo + (campo === 'addable' && ing.price > 0 ? ' +' + money(ing.price) : '')));
  }
  box.append(lista);
  return box;
}

// ----------------------------------------------------------- ingredientes
function renderIngredientes(main) {
  const dic = doc.ingredientes = doc.ingredientes || {};
  const nos = [el('h2', {}, 'Remover é sempre grátis. O preço abaixo é o de acrescentar.')];
  // Ingrediente apagado aqui continuava escondido nos lanches (03/10: Molho do
  // hot e Macarrão em 22 lanches, e o aviso no boot). Este quadro mostra e limpa.
  const orfaos = el('div', {});
  nos.push(orfaos);
  conferirOrfaos(orfaos, dic);

  for (const [id, ing] of Object.entries(dic)) {
    const nome = el('input', { type: 'text', value: ing.name?.pt || '' });
    nome.oninput = () => { ing.name = { ...ing.name, pt: nome.value }; marcarSujo(); };
    const preco = el('input', { type: 'number', step: '0.01', min: '0', value: ing.price ?? 0 });
    preco.oninput = () => { ing.price = Number(preco.value); marcarSujo(); };

    nos.push(el('div', { cls: 'card' }, el('div', { cls: 'linha' }, nome, preco,
      el('button', { cls: 'mini', onclick: () => {
        const usos = lanchesQueUsam(window.__menuIng, id).length;
        if (!confirm('Remover o ingrediente "' + (ing.name?.pt || id) + '"?' +
          (usos ? ' Ele está em ' + usos + ' lanche(s) — depois de remover, use o botão "Tirar dos lanches" que vai aparecer no topo.' : ''))) return;
        delete dic[id]; marcarSujo(); renderIngredientes(main);
      } }, '✕'))));
  }

  nos.push(el('button', { cls: 'add', onclick: () => {
    const nomeNovo = (prompt('Nome do ingrediente novo (ex: Queijo cheddar):') || '').trim();
    if (!nomeNovo) return;
    const id = codigoNovo(nomeNovo, new Set(Object.keys(dic)));
    dic[id] = { name: { pt: nomeNovo }, price: 0 };
    marcarSujo(); renderIngredientes(main);
  } }, '+ ingrediente'));

  main.replaceChildren(...nos);
}

/** Os lanches do cardápio que citam o ingrediente, em "pode tirar" ou "pode acrescentar". */
function lanchesQueUsam(menu, id) {
  const achados = [];
  for (const cat of (menu && menu.categories) || []) {
    for (const item of cat.items || []) {
      const m = item.modifiers || {};
      if ((m.removable || []).includes(id) || (m.addable || []).includes(id)) achados.push(item);
    }
  }
  return achados;
}

/**
 * Ingredientes que não existem mais na lista, mas continuam gravados nos
 * lanches: o painel não desenha caixinha para eles, então não dava para
 * desmarcar. O botão tira de todos os lanches e salva o cardápio.
 */
async function conferirOrfaos(alvo, dic) {
  let menu;
  try {
    menu = (await api('/config/menu')).doc;
  } catch (e) { return; }
  window.__menuIng = menu;

  const apagados = {};
  for (const cat of menu.categories || []) {
    for (const item of cat.items || []) {
      const m = item.modifiers || {};
      for (const id of [...(m.removable || []), ...(m.addable || [])]) {
        if (!dic[id]) (apagados[id] = apagados[id] || new Set()).add(item.id);
      }
    }
  }
  const ids = Object.keys(apagados);
  if (!ids.length) { alvo.replaceChildren(); return; }

  const lanches = new Set();
  ids.forEach((id) => apagados[id].forEach((i) => lanches.add(i)));
  const botao = el('button', { cls: 'add', onclick: async () => {
    if (!confirm('Tirar ' + ids.join(', ') + ' de ' + lanches.size + ' lanche(s) e salvar o cardápio?')) return;
    botao.disabled = true;
    for (const cat of menu.categories || []) {
      for (const item of cat.items || []) {
        if (!item.modifiers) continue;
        item.modifiers.removable = (item.modifiers.removable || []).filter((x) => !ids.includes(x));
        item.modifiers.addable = (item.modifiers.addable || []).filter((x) => !ids.includes(x));
      }
    }
    try {
      const r = await api('/config/menu', { method: 'POST',
        body: JSON.stringify({ doc: menu, resumo: 'Ingredientes apagados tirados dos lanches: ' + ids.join(', ') }) });
      if (r.erro === 'invalido') { avisar('Não salvou: ' + r.problemas.join(' · '), true); botao.disabled = false; return; }
      if (r.erro) { avisar('Não salvou. Tente de novo.', true); botao.disabled = false; return; }
      avisar('Ingredientes apagados tirados dos lanches ✓');
      conferirOrfaos(alvo, dic);
    } catch (e) { botao.disabled = false; }
  } }, 'Tirar dos lanches');

  alvo.replaceChildren(el('div', { cls: 'card' },
    el('p', {}, '⚠️ ' + ids.length + ' ingrediente(s) que não estão nesta lista continuam marcados em ' +
      lanches.size + ' lanche(s): ' + ids.join(', ') + '. Eles não aparecem para desmarcar no Cardápio.'),
    botao));
}

// ---------------------------------------------------------------- entrega
function renderEntrega(main) {
  doc.cities = doc.cities || [];
  const nos = [el('h2', {}, 'Cidades atendidas e taxa de cada uma')];

  for (const c of doc.cities) {
    const nome = el('input', { type: 'text', value: c.label || '' });
    nome.oninput = () => { c.label = nome.value; marcarSujo(); };
    const taxa = el('input', { type: 'number', step: '0.01', min: '0', value: c.delivery_fee ?? 0 });
    taxa.oninput = () => { c.delivery_fee = Number(taxa.value); marcarSujo(); };
    const ativa = el('input', { type: 'checkbox' });
    ativa.checked = c.active !== false;
    ativa.onchange = () => { c.active = ativa.checked; marcarSujo(); };

    nos.push(el('div', { cls: 'card' }, el('div', { cls: 'linha' }, nome, taxa,
      el('label', {}, ativa, 'atende'),
      el('button', { cls: 'mini', onclick: () => {
        if (!confirm('Remover ' + c.label + '?')) return;
        doc.cities = doc.cities.filter((x) => x !== c); marcarSujo(); renderEntrega(main);
      } }, '✕'))));
  }

  nos.push(el('button', { cls: 'add', onclick: () => {
    const label = prompt('Nome da cidade:');
    if (!label) return;
    doc.cities.push({ id: label.toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, ''),
                      label, delivery_fee: 0, active: true });
    marcarSujo(); renderEntrega(main);
  } }, '+ cidade'));

  doc.pickup = doc.pickup || { enabled: true };
  const ret = el('input', { type: 'checkbox' });
  ret.checked = doc.pickup.enabled === true;
  ret.onchange = () => { doc.pickup.enabled = ret.checked; marcarSujo(); };
  const end = el('input', { type: 'text', value: doc.pickup.address || '' });
  end.oninput = () => { doc.pickup.address = end.value; marcarSujo(); };

  nos.push(el('h2', {}, 'Retirada no balcão'));
  nos.push(el('div', { cls: 'card' },
    el('div', { cls: 'linha' }, el('label', {}, ret, 'aceita retirada')),
    el('div', { cls: 'linha', style: 'margin-top:.5rem' }, end)));

  main.replaceChildren(...nos);
}

// ---------------------------------------------------------------- horário
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function renderHorario(main) {
  const sempre = el('input', { type: 'checkbox' });
  sempre.checked = doc.always_open === true;
  sempre.onchange = () => { doc.always_open = sempre.checked; marcarSujo(); renderHorario(main); };

  const nos = [
    el('div', { cls: 'card' }, el('label', {}, sempre, 'atender 24 horas (modo de teste)')),
  ];

  if (!doc.always_open) {
    const abre = el('input', { type: 'number', min: '0', max: '24', value: doc.open_hour ?? 17 });
    abre.oninput = () => { doc.open_hour = Number(abre.value); marcarSujo(); };
    const fecha = el('input', { type: 'number', min: '0', max: '24', value: doc.close_hour ?? 24 });
    fecha.oninput = () => { doc.close_hour = Number(fecha.value); marcarSujo(); };

    nos.push(el('h2', {}, 'Abre e fecha (hora cheia, 0 a 24)'));
    nos.push(el('div', { cls: 'card' }, el('div', { cls: 'linha' },
      el('label', {}, 'abre'), abre, el('label', {}, 'fecha'), fecha)));

    doc.closed_days = doc.closed_days || [];
    const box = el('div', { cls: 'ings' });
    DIAS.forEach((nome, i) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = doc.closed_days.includes(i);
      cb.onchange = () => {
        doc.closed_days = cb.checked
          ? [...new Set([...doc.closed_days, i])]
          : doc.closed_days.filter((d) => d !== i);
        marcarSujo();
      };
      box.append(el('label', {}, cb, nome));
    });
    nos.push(el('h2', {}, 'Dias fechados'));
    nos.push(el('div', { cls: 'card' }, box));
  }

  main.replaceChildren(...nos);
}

// ------------------------------------------------------------- relatórios
// As datas são as do relógio da loja; o servidor converte para o banco.
const TZ_LOJA = 'America/New_York';
const dataLoja = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ_LOJA,
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/** AAAA-MM-DD de n dias atrás, pelo calendário da loja. */
function diasAtras(n) {
  const [a, m, d] = dataLoja(new Date()).split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d - n)).toISOString().slice(0, 10);
}

const quandoLoja = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: TZ_LOJA,
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// A sub-aba e as datas sobrevivem à troca entre os relatórios.
let relAba = 'periodo', relDe = null, relAte = null, relPedido = 0;

async function renderRelatorios(main) {
  const hoje = diasAtras(0);
  relDe = relDe || hoje;
  relAte = relAte || hoje;

  const de = el('input', { type: 'date', value: relDe, max: hoje });
  const ate = el('input', { type: 'date', value: relAte, max: hoje });
  const alvo = el('div', {});

  const carregar = async () => {
    if (!de.value || !ate.value) return;
    if (de.value > ate.value) {
      alvo.replaceChildren(el('p', { cls: 'vazio' }, 'A data inicial está depois da final.'));
      return;
    }
    relDe = de.value;
    relAte = ate.value;
    // Toque rápido em dois atalhos: vale a resposta do último.
    const meu = ++relPedido;
    alvo.replaceChildren(el('p', { cls: 'vazio' }, 'Carregando…'));
    const q = '?de=' + relDe + '&ate=' + relAte;
    const caminho = relAba === 'entregas' ? '/relatorio/entregas'
      : relAba === 'conferencia' ? '/relatorio/conferencia'
        : '/relatorio';
    const r = await api(caminho + q);
    if (meu !== relPedido) return;
    if (r.erro) {
      alvo.replaceChildren(el('p', { cls: 'vazio' }, 'Não consegui montar o relatório desse período.'));
      return;
    }
    const blocos = relAba === 'entregas' ? blocosEntregas(r)
      : relAba === 'conferencia' ? blocosConferencia(r)
        : blocosRelatorio(r);
    alvo.replaceChildren(...blocos);
  };
  de.onchange = carregar;
  ate.onchange = carregar;

  const atalho = (rotulo, inicio, fim) => el('button', { onclick: () => {
    de.value = diasAtras(inicio);
    ate.value = diasAtras(fim);
    carregar();
  } }, rotulo);

  const subaba = (id, rotulo) => el('button', {
    'aria-selected': relAba === id ? 'true' : 'false',
    onclick: () => { relAba = id; renderRelatorios(main); },
  }, rotulo);

  main.replaceChildren(
    el('div', { cls: 'subabas', role: 'tablist' },
      subaba('periodo', 'Período'), subaba('entregas', 'Deliverys'),
      subaba('conferencia', 'Conferência')),
    el('div', { cls: 'card' },
      el('div', { cls: 'linha' }, el('label', {}, 'De'), de, el('label', {}, 'até'), ate),
      el('div', { cls: 'atalhos' },
        atalho('Hoje', 0, 0), atalho('Ontem', 1, 1), atalho('7 dias', 6, 0), atalho('30 dias', 29, 0))),
    alvo);
  await carregar();
}

/** Zelle escolhido nos pedidos confirmados, para conferir no extrato. */
function blocosConferencia(r) {
  const k = (v, l) => el('div', { cls: 'kpi' }, el('b', {}, v), el('span', {}, l));
  const nos = [
    el('div', { cls: 'kpis' },
      k(r.resumo.pagamentos, 'pagamentos Zelle'),
      k(money(r.resumo.valorTotal), 'valor para conferir')),
    el('p', { cls: 'explica' },
      'Compare esta lista com o extrato do Zelle. Ela inclui os pedidos confirmados, mesmo sem comprovante.'),
  ];

  if (!r.resumo.pagamentos) {
    nos.push(el('p', { cls: 'vazio' }, 'Nenhum pagamento Zelle neste período.'));
    return nos;
  }

  const lista = el('div', { cls: 'conferencia-lista' });
  for (const p of r.lista) {
    const telefone = String(p.telefone || '');
    lista.append(el('div', { cls: 'conferencia-item' },
      el('div', { cls: 'conferencia-topo' },
        el('div', {},
          el('b', {}, p.nome || 'Sem nome'),
          el('span', { cls: 'pequeno' }, (telefone ? '+' + telefone.replace(/^\\+/, '') : 'Sem telefone') +
            ' · pedido #' + p.id + ' · ' + quandoLoja(p.quando))),
        el('strong', { cls: 'conferencia-valor' }, money(p.valor))),
      el('div', { cls: 'conferencia-endereco' }, p.endereco || 'Sem endereço'),
      el('span', { cls: 'pequeno' }, p.cidade || 'Sem cidade')));
  }
  nos.push(lista);

  if (r.listaTruncada) {
    nos.push(el('p', { cls: 'explica' },
      'Mostrando os primeiros ' + r.lista.length + ' pagamentos — os totais acima contam todos. ' +
      'Diminua o período para ver a lista inteira.'));
  }
  return nos;
}

/** A aba Deliverys: quantas entregas, quanto, por cidade e uma a uma. */
function blocosEntregas(r) {
  const k = (v, l) => el('div', { cls: 'kpi' }, el('b', {}, v), el('span', {}, l));
  const nos = [el('div', { cls: 'kpis' },
    k(r.resumo.entregas, 'entregas'),
    k(money(r.resumo.valorTotal), 'valor total'),
    k(money(r.resumo.taxas), 'taxas de entrega'))];

  if (!r.resumo.entregas) {
    nos.push(el('p', { cls: 'vazio' }, 'Nenhuma entrega neste período.'));
    return nos;
  }

  nos.push(tabela('Por cidade', ['Cidade', 'Entregas', 'Taxas', 'Valor total'],
    r.porCidade.map((c) => [c.cidade, c.entregas, money(c.taxas), money(c.total)])));

  nos.push(tabela('Entrega por entrega', ['Pedido', 'Cidade', 'Taxa', 'Valor'],
    r.lista.map((e) => [
      el('span', {}, '#' + e.id, el('span', { cls: 'pequeno' }, quandoLoja(e.quando))),
      e.cidade, money(e.taxa), money(e.total)]), 2));

  if (r.listaTruncada) {
    nos.push(el('p', { cls: 'explica' },
      'Mostrando as primeiras ' + r.lista.length + ' entregas — os totais acima contam todas. ' +
      'Diminua o período para ver a lista inteira.'));
  }
  return nos;
}

function blocosRelatorio(r) {
  const nos = [];
  const k = (v, l) => el('div', { cls: 'kpi' }, el('b', {}, v), el('span', {}, l));

  nos.push(el('div', { cls: 'kpis' },
    k(r.resumo.orderCount, 'pedidos'),
    k(money(r.resumo.revenue), 'receita'),
    k(money(r.resumo.avgTicket), 'ticket médio'),
    k(money(r.resumo.deliveryFees), 'taxas de entrega')));

  if (!r.resumo.orderCount) {
    nos.push(el('p', { cls: 'vazio' }, 'Nenhum pedido confirmado neste período.'));
    return nos;
  }

  nos.push(tabela('Mais vendidos', ['Item', 'Qtd', 'Receita'],
    r.resumo.topItems.map((i) => [i.name, i.qty, money(i.revenue)])));

  nos.push(tabela('Por cidade', ['Onde', 'Pedidos', 'Receita', 'Taxas'],
    r.porCidade.map((c) => [c.cidade, c.pedidos, money(c.receita), money(c.taxas)])));

  const pico = Math.max(...r.porHora.map((h) => h.pedidos), 1);
  nos.push(el('h2', {}, 'Movimento por hora'));
  const horas = el('div', { cls: 'card' });
  for (const h of r.porHora.filter((x) => x.pedidos > 0)) {
    horas.append(el('div', { cls: 'linha', style: 'margin:.2rem 0' },
      el('span', { style: 'width:3.2rem;font-size:.8rem;color:var(--suave)' }, h.hora + 'h'),
      el('div', { cls: 'barinha', style: 'width:' + Math.round((h.pedidos / pico) * 70) + '%' }),
      el('span', { style: 'font-size:.8rem' }, h.pedidos)));
  }
  nos.push(horas);

  nos.push(el('div', { cls: 'kpis' },
    k(r.clientes.total, 'clientes'),
    k(r.clientes.recorrentes, 'voltaram')));

  nos.push(tabela('Quem mais comprou', ['Cliente', 'Pedidos', 'Total'],
    r.clientes.top.map((c) => [c.nome || ('+' + c.phone), c.pedidos, money(c.total)])));

  nos.push(tabela('Por dia', ['Dia', 'Pedidos', 'Receita'],
    r.porDia.map((d) => [d.day, d.count, money(d.revenue)])));

  return nos;
}

/** texto = quantas colunas, da esquerda, são texto (o resto alinha como número). */
function tabela(titulo, cabecalho, linhas, texto = 1) {
  const t = el('table', {}, el('tr', {}, ...cabecalho.map((c, i) =>
    el('th', { cls: i >= texto ? 'num' : '' }, c))));
  for (const l of linhas) {
    t.append(el('tr', {}, ...l.map((c, i) => el('td', { cls: i >= texto ? 'num' : '' }, c))));
  }
  return el('div', {}, el('h2', {}, titulo), el('div', { cls: 'card' }, t));
}

// ------------------------------------------------------------- conversas
async function renderConversas(main) {
  const r = await api('/conversas');
  const conversas = r.conversas || [];

  if (!conversas.length) {
    main.replaceChildren(el('p', { cls: 'vazio' }, 'Nenhuma conversa registrada ainda.'));
    return;
  }

  const nos = [el('p', { cls: 'explica' },
    'As ' + conversas.length + ' conversas mais recentes, a mais nova primeiro. ' +
    'As que estão em andamento aparecem em até 10 minutos.')];

  for (const c of conversas) {
    const quando = new Date(c.criada_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    const card = el('div', { cls: 'card' },
      el('div', { cls: 'linha' },
        el('b', {}, '+' + c.phone),
        el('span', { style: 'color:var(--suave);font-size:.8rem;margin-left:auto' }, quando)));

    const balaos = el('div', { style: 'margin-top:.6rem;display:flex;flex-direction:column;gap:.4rem' });
    for (const m of c.mensagens || []) {
      const doCliente = m.de === 'cliente';
      const balao = el('div', { style:
        'max-width:88%;padding:.5rem .7rem;border-radius:10px;font-size:.88rem;white-space:pre-wrap;' +
        (doCliente
          ? 'align-self:flex-end;background:var(--acao);color:#fff'
          : 'align-self:flex-start;background:var(--chip)') });
      if (m.texto) balao.append(m.texto);
      if (m.ferramentas?.length) {
        balao.append(el('div', { style: 'opacity:.75;font-size:.75rem;margin-top:.25rem' },
          '⚙ ' + m.ferramentas.join(', ')));
      }
      if (m.leitura) {
        balao.append(el('div', { style: 'opacity:.8;font-size:.75rem;margin-top:.25rem' },
          '🔎 entendeu: ' + m.leitura));
      }
      if (doCliente && m.texto) {
        balao.append(el('button', {
          style: 'display:block;margin-top:.3rem;background:rgba(255,255,255,.2);color:#fff;border:none;' +
            'border-radius:6px;padding:.15rem .5rem;font-size:.72rem;cursor:pointer',
          onclick: () => { window.__textoCorrigir = m.texto; abrir('exemplos'); },
        }, '✏️ Corrigir'));
      }
      balaos.append(balao);
    }
    card.append(balaos);
    nos.push(card);
  }
  main.replaceChildren(...nos);
}

// --------------------------------------------------------------- backups
async function renderBackups(main) {
  const r = await api('/backups');
  const nos = [el('p', { cls: 'explica' },
    'Backup feito no Cloudflare R2, mantendo por ' + r.dias + ' dias. ' +
    'Roda sozinho todo dia às ' + r.hora + 'h (horário de NY)' +
    (r.bucket ? ', no bucket ' + r.bucket : '') + '. ' +
    'Esta lista mostra só os últimos ' + r.dias + ' dias; o mais antigo sai sozinho. ' +
    'Para fazer um agora, mande !backup agora no WhatsApp.')];

  if (!r.configurado) {
    nos.push(el('p', { cls: 'vazio' }, '⚠️ Backup não configurado: faltam as variáveis R2_* no Railway.'));
  }
  if (!r.entradas.length) {
    nos.push(el('p', { cls: 'vazio' }, 'Nenhum backup registrado nos últimos ' + r.dias + ' dias.'));
    main.replaceChildren(...nos);
    return;
  }

  const t = el('table', {});
  t.append(el('tr', {}, ...['Dia', 'Hora', 'Situação', 'Arquivo', 'Tamanho'].map((c) => el('th', {}, c))));
  for (const e of r.entradas) {
    const quando = new Date(e.quando);
    const dia = quando.toLocaleDateString('pt-BR', { timeZone: 'America/New_York', weekday: 'short', day: '2-digit', month: '2-digit' });
    const hora = quando.toLocaleTimeString('pt-BR', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
    t.append(el('tr', {},
      el('td', {}, dia),
      el('td', {}, hora),
      el('td', {}, e.ok ? '✅ feito' : '❌ falhou' + (e.erro ? ': ' + e.erro : '')),
      el('td', {}, e.arquivo || ''),
      el('td', { cls: 'num' }, e.ok && e.bytes != null ? (e.bytes / 1024).toFixed(1) + ' KB' : '')));
  }
  nos.push(el('div', { cls: 'card' }, t));
  main.replaceChildren(...nos);
}

// -------------------------------------------------------------- exemplos
// A base de exemplos corrigidos da IA leitora: a mensagem que o bot entendeu
// errado e o que ela queria dizer. Cada exemplo salva sozinho.
async function renderExemplos(main) {
  const r = await api('/exemplos');
  const produtos = r.produtos || [];
  const ings = window.__ings || {};
  const nomeIng = (id) => (ings[id] && ings[id].name && ings[id].name.pt) || id;
  const nomeProd = (id) => (produtos.find((p) => p.id === id) || {}).nome || id;
  const linhaVazia = () => ({ produto: '', qtd: 1, sem: [], com: [], ponto_bife: '', ponto_bacon: '',
    salsicha: '', maionese_a_parte: false, trecho: '' });

  const texto = el('textarea', { placeholder: 'Cole aqui a mensagem do cliente que o bot entendeu errado' });
  texto.value = window.__textoCorrigir || '';
  window.__textoCorrigir = '';
  const nota = el('input', { type: 'text', style: 'width:100%;margin-top:.5rem',
    placeholder: 'Explicação (opcional). Ex.: "hamburguer" é o Hamburger' });
  const msg = el('p', { cls: 'explica' });
  const caixaLinhas = el('div', { style: 'margin-top:.6rem' });
  let linhas = [linhaVazia()];

  const aviso = (t, erro) => { msg.textContent = t; msg.className = 'explica ' + (erro ? 'err' : 'ok'); };
  const escolha = (opcoes, valor, mudar) => {
    const s = el('select', {}, ...opcoes.map(([v, t]) => el('option', { value: v }, t)));
    s.value = valor || '';
    s.onchange = () => mudar(s.value);
    return s;
  };
  const marcar = (titulo, lista) => {
    const box = el('div', { cls: 'ings' });
    for (const id of Object.keys(ings)) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = lista.includes(id);
      cb.onchange = () => {
        const i = lista.indexOf(id);
        if (cb.checked && i < 0) lista.push(id);
        if (!cb.checked && i >= 0) lista.splice(i, 1);
      };
      box.append(el('label', {}, cb, nomeIng(id)));
    }
    const d = el('details', { style: 'margin-top:.4rem' },
      el('summary', { style: 'font-size:.82rem;cursor:pointer' }, titulo), box);
    if (lista.length) d.open = true;
    return d;
  };

  function desenharLinhas() {
    caixaLinhas.replaceChildren(...linhas.map((l, n) => {
      const prod = escolha([['', 'Escolha o produto…'], ...produtos.map((p) => [p.id, p.nome])],
        l.produto, (v) => { l.produto = v; });
      prod.style.cssText = 'flex:1;min-width:0';
      const qtd = el('input', { type: 'number', min: '1', max: '50' });
      qtd.value = l.qtd;
      qtd.oninput = () => { l.qtd = Number(qtd.value); };
      const maio = el('input', { type: 'checkbox' });
      maio.checked = !!l.maionese_a_parte;
      maio.onchange = () => { l.maionese_a_parte = maio.checked; };
      const trecho = el('input', { type: 'text', style: 'width:100%;margin-top:.4rem',
        placeholder: 'Parte da mensagem que fala deste item (opcional)' });
      trecho.value = l.trecho || '';
      trecho.oninput = () => { l.trecho = trecho.value; };
      return el('div', { cls: 'card' },
        el('div', { cls: 'linha' }, qtd, prod,
          el('button', { cls: 'mini', title: 'Tirar esta linha',
            onclick: () => { linhas.splice(n, 1); desenharLinhas(); } }, '✕')),
        el('div', { cls: 'linha', style: 'flex-wrap:wrap;margin-top:.4rem' },
          escolha([['', 'Bife: normal'], ['mal_passado', 'Bife mal passado'], ['ao_ponto', 'Bife ao ponto'],
            ['bem_passado', 'Bife bem passado']], l.ponto_bife, (v) => { l.ponto_bife = v; }),
          escolha([['', 'Bacon: normal'], ['mal_passado', 'Bacon mal passado'],
            ['bem_passado', 'Bacon bem passado']], l.ponto_bacon, (v) => { l.ponto_bacon = v; }),
          escolha([['', 'Salsicha: —'], ['junto', 'Salsicha junto'], ['a_parte', 'Salsicha à parte']],
            l.salsicha, (v) => { l.salsicha = v; })),
        el('label', { style: 'margin-top:.4rem' }, maio, 'Maionese à parte (cobra o sachê)'),
        trecho,
        marcar('➖ Sem (tirar do lanche)', l.sem),
        marcar('➕ Com (acrescentar)', l.com));
    }));
  }

  async function verIA() {
    if (!texto.value.trim()) return aviso('Cole a mensagem primeiro.', true);
    aviso('Perguntando à IA…');
    try {
      const lido = await api('/exemplos/ler', { method: 'POST', body: JSON.stringify({ texto: texto.value }) });
      if (lido.erro) return aviso('A IA não respondeu agora. Monte as linhas à mão.', true);
      linhas = (lido.itens || []).map((i) => ({ ...linhaVazia(), ...i,
        qtd: i.qtd || 1, ponto_bife: i.ponto_bife || '', ponto_bacon: i.ponto_bacon || '', salsicha: i.salsicha || '' }));
      if (!linhas.length) linhas = [linhaVazia()];
      desenharLinhas();
      const duvidas = (lido.ambiguos || []).map((a) => '"' + a.trecho + '": ' + a.opcoes.map(nomeProd).join(' ou '));
      aviso('É isto que a IA entende hoje (sem carrinho). Corrija o que estiver errado e salve.' +
        (duvidas.length ? ' Ela ficou em dúvida em: ' + duvidas.join('; ') + '.' : ''));
    } catch (e) { /* 401 já avisou */ }
  }

  async function salvarExemplo() {
    aviso('Salvando…');
    const itens = linhas.map((l) => ({ ...l, qtd: Number(l.qtd) || 1 }));
    try {
      const s = await api('/exemplos', { method: 'POST',
        body: JSON.stringify({ texto: texto.value, nota: nota.value, itens }) });
      if (s.erro === 'invalido') return aviso('Não salvou: ' + s.problemas.join(' · '), true);
      if (s.erro) return aviso('Não salvou. Tente de novo.', true);
      window.__avisoExemplos = 'Exemplo salvo ✓ — já vale para as próximas mensagens.';
      renderExemplos(main);
    } catch (e) { /* 401 já avisou */ }
  }

  const resumo = (e) => (e.leitura.itens || []).map((i) => {
    const partes = [(i.qtd || 1) + '× ' + nomeProd(i.produto)];
    if (i.sem && i.sem.length) partes.push('sem ' + i.sem.map(nomeIng).join(', '));
    if (i.com && i.com.length) partes.push('com ' + i.com.map(nomeIng).join(', '));
    if (i.ponto_bife) partes.push('bife ' + i.ponto_bife.replace('_', ' '));
    if (i.ponto_bacon) partes.push('bacon ' + i.ponto_bacon.replace('_', ' '));
    if (i.salsicha) partes.push('salsicha ' + (i.salsicha === 'a_parte' ? 'à parte' : 'junto'));
    if (i.maionese_a_parte) partes.push('maionese à parte');
    return partes.join(' · ');
  });

  const doPainel = (r.painel || []).slice().reverse().map((e) => el('div', { cls: 'card' },
    el('div', { cls: 'linha' },
      el('b', { style: 'white-space:pre-wrap;flex:1' }, e.texto),
      el('button', { cls: 'mini', title: 'Apagar exemplo', onclick: async () => {
        if (!confirm('Apagar este exemplo?')) return;
        const d = await api('/exemplos/' + encodeURIComponent(e.id), { method: 'DELETE' });
        if (d.erro) return aviso('Não apagou. Tente de novo.', true);
        window.__avisoExemplos = 'Exemplo apagado.';
        renderExemplos(main);
      } }, '🗑')),
    ...resumo(e).map((t) => el('div', { style: 'font-size:.85rem' }, '→ ' + t)),
    e.nota ? el('div', { cls: 'pequeno' }, e.nota) : null,
    el('div', { cls: 'pequeno' }, e.data || '')));

  const doSistema = el('details', {},
    el('summary', { style: 'cursor:pointer;font-size:.85rem;color:var(--suave)' },
      'Exemplos do sistema (' + (r.arquivo || []).length + ') — mudam só com atualização'),
    ...(r.arquivo || []).map((e) => el('div', { cls: 'card' },
      el('div', { style: 'white-space:pre-wrap;font-size:.88rem' }, e.texto),
      e.nota ? el('div', { cls: 'pequeno' }, e.nota) : null)));

  desenharLinhas();
  if (window.__avisoExemplos) { aviso(window.__avisoExemplos); window.__avisoExemplos = ''; }

  main.replaceChildren(
    el('p', { cls: 'explica' }, 'Quando o bot entender errado uma mensagem, corrija aqui. ' +
      'Quando chegar uma mensagem parecida, o exemplo vai junto para a IA ler do mesmo jeito. ' +
      'Não muda preço, cardápio nem regra — só ajuda a ler.'),
    el('h2', {}, 'Novo exemplo'),
    el('div', { cls: 'card' },
      texto,
      el('button', { cls: 'add', onclick: verIA }, '🔎 Ver o que a IA entende'),
      caixaLinhas,
      el('button', { cls: 'add', onclick: () => { linhas.push(linhaVazia()); desenharLinhas(); } }, '+ Adicionar item'),
      nota,
      el('div', { cls: 'linha', style: 'margin-top:.6rem' },
        msg, el('button', { cls: 'salvar', style: 'margin-left:auto', onclick: salvarExemplo }, 'Salvar exemplo'))),
    el('h2', {}, 'Corrigidos no painel (' + (r.painel || []).length + ')'),
    ...(doPainel.length ? doPainel : [el('p', { cls: 'vazio' }, 'Nenhum ainda.')]),
    el('h2', {}, 'Do sistema'),
    doSistema);
}

// ------------------------------------------------------------- perguntas
// Perguntas que o bot responde sozinho (docs/PERGUNTAS.md, fase 2). A IA só
// escolhe qual foi feita; a resposta vai palavra por palavra. Cada pergunta
// salva sozinha, como os exemplos.
async function renderPerguntas(main) {
  const r = await api('/perguntas');
  const lista = r.lista || [];
  const msg = el('p', { cls: 'explica' });
  const aviso = (t, erro) => { msg.textContent = t; msg.className = 'explica ' + (erro ? 'err' : 'ok'); };

  async function gravar(corpo, okTexto) {
    aviso('Salvando…');
    try {
      const s = await api('/perguntas', { method: 'POST', body: JSON.stringify(corpo) });
      if (s.erro === 'invalido') return aviso('Não salvou: ' + s.problemas.join(' · '), true);
      if (s.erro) return aviso('Não salvou. Tente de novo.', true);
      window.__avisoPerguntas = okTexto;
      renderPerguntas(main);
    } catch (e) { /* 401 já avisou */ }
  }

  function formulario(item) {
    const pergunta = el('input', { type: 'text', style: 'width:100%', maxlength: '120',
      placeholder: 'Pergunta, como o cliente faz. Ex.: O macarrão tem pimenta?' });
    pergunta.value = item ? item.pergunta : '';
    const resposta = el('textarea', { maxlength: '600',
      placeholder: 'Resposta que o bot vai mandar, do seu jeito. Ex.: Não leva pimenta. Se quiser, mandamos à parte.' });
    resposta.value = item ? item.resposta : '';
    return { pergunta, resposta };
  }

  const novo = formulario(null);
  // Fase 3: "Responder" leva a pergunta sem resposta para o formulário acima.
  let dePendente = null;
  const pendentes = (r.pendentes || []).map((p) => el('div', { cls: 'card' },
    el('div', { style: 'white-space:pre-wrap' }, '"' + p.pergunta + '"'),
    el('div', { cls: 'linha', style: 'margin-top:.4rem' },
      el('span', { cls: 'pequeno', style: 'flex:1' }, new Date(p.em).toLocaleString('pt-BR', { timeZone: 'America/New_York' })),
      el('button', { cls: 'add', onclick: () => {
        novo.pergunta.value = p.pergunta.slice(0, 120);
        novo.resposta.value = '';
        dePendente = p.id || p.em;
        aviso('Escreva a resposta e salve. A pergunta sai desta lista.');
        novo.resposta.focus();
        novo.pergunta.scrollIntoView({ block: 'center' });
      } }, 'Responder'),
      el('button', { cls: 'mini', title: 'ignorar', onclick: async () => {
        const d = await api('/perguntas/pendentes/ignorar', { method: 'POST', body: JSON.stringify({ em: p.id || p.em }) });
        if (d.erro && d.erro !== 'nao_encontrado') return aviso('Não tirou. Tente de novo.', true);
        window.__avisoPerguntas = 'Pergunta ignorada.';
        renderPerguntas(main);
      } }, 'Ignorar'))));
  const cards = lista.map((p) => {
    const f = formulario(p);
    const ativa = el('input', { type: 'checkbox' });
    ativa.checked = p.ativa !== false;
    const card = el('div', { cls: 'card' + (p.ativa === false ? ' off' : '') },
      el('div', { cls: 'linha' },
        el('b', { style: 'flex:1;white-space:pre-wrap' }, p.pergunta),
        el('label', { cls: 'pequeno' }, ativa, 'ligada'),
        el('button', { cls: 'mini', title: 'editar', onclick: () => card.classList.toggle('aberto') }, '▾'),
        el('button', { cls: 'mini', title: 'apagar', onclick: async () => {
          if (!confirm('Apagar a pergunta "' + p.pergunta + '"?')) return;
          const d = await api('/perguntas/' + encodeURIComponent(p.id), { method: 'DELETE' });
          if (d.erro) return aviso('Não apagou. Tente de novo.', true);
          window.__avisoPerguntas = 'Pergunta apagada.';
          renderPerguntas(main);
        } }, '✕')),
      el('div', { style: 'white-space:pre-wrap;font-size:.88rem;margin-top:.3rem' }, '→ ' + p.resposta),
      el('div', { cls: 'pequeno' }, 'editada em ' + (p.atualizada || '—')),
      el('div', { cls: 'det' }, f.pergunta, f.resposta,
        el('button', { cls: 'salvar', onclick: () => gravar({ id: p.id, pergunta: f.pergunta.value,
          resposta: f.resposta.value, ativa: ativa.checked }, 'Pergunta atualizada ✓') }, 'Salvar alteração')));
    ativa.onchange = () => gravar({ id: p.id, pergunta: p.pergunta, resposta: p.resposta, ativa: ativa.checked },
      ativa.checked ? 'Pergunta ligada ✓' : 'Pergunta desligada — o bot não usa mais esta resposta.');
    return card;
  });

  if (window.__avisoPerguntas) { aviso(window.__avisoPerguntas); window.__avisoPerguntas = ''; }
  const cheio = lista.length >= (r.max || 50);
  main.replaceChildren(
    el('p', { cls: 'explica' }, 'Cadastre perguntas que os clientes fazem e a resposta que o bot deve dar. ' +
      'A IA reconhece a pergunta mesmo escrita de outro jeito, e o bot manda a sua resposta palavra por palavra. ' +
      'Pergunta que não estiver aqui continua indo para a equipe. O telefone do Zelle o bot já responde sozinho.'),
    el('h2', {}, 'Nova pergunta'),
    cheio
      ? el('p', { cls: 'vazio' }, 'Limite de ' + (r.max || 50) + ' perguntas. Apague alguma para cadastrar outra.')
      : el('div', { cls: 'card' }, novo.pergunta, novo.resposta,
        el('div', { cls: 'linha', style: 'margin-top:.6rem' }, msg,
          el('button', { cls: 'salvar', style: 'margin-left:auto', onclick: () =>
            gravar({ pergunta: novo.pergunta.value, resposta: novo.resposta.value,
              ...(dePendente ? { dePendente } : {}) }, 'Pergunta salva ✓ — o bot já usa.') },
          'Salvar pergunta'))),
    cheio ? msg : null,
    el('h2', {}, 'Sem resposta — foram para a equipe (' + pendentes.length + ')'),
    el('p', { cls: 'explica' }, 'Perguntas dos últimos 30 dias que o bot não soube responder. ' +
      'Responda uma vez e, da próxima, o bot responde sozinho. Só o texto da pergunta fica guardado, sem o telefone.'),
    ...(pendentes.length ? pendentes : [el('p', { cls: 'vazio' }, 'Nenhuma. 🎉')]),
    el('h2', {}, 'Cadastradas (' + lista.length + ')'),
    ...(cards.length ? cards : [el('p', { cls: 'vazio' }, 'Nenhuma ainda.')]));
}

// ------------------------------------------------------------------ salvar
async function salvar() {
  const btn = document.getElementById('salvar');
  btn.disabled = true;
  avisar('Salvando…');

  // O painel edita só em português. Inglês e espanhol recebem o mesmo texto
  // QUANDO estiverem vazios — sem isso um item novo apareceria como "undefined"
  // para quem escolheu outro idioma, porque vários pontos do bot param o
  // fallback no inglês. Traduções já existentes não são tocadas.
  if (aba === 'menu' || aba === 'promotions') {
    const categorias = aba === 'menu' ? (doc.categories || []) : [doc.category];
    for (const cat of categorias) {
      if (!cat) continue;
      for (const i of cat.items || []) {
        i.name = { ...i.name, en: i.name?.en || i.name?.pt, es: i.name?.es || i.name?.pt };
        if (i.description?.pt) {
          i.description = { ...i.description,
            en: i.description?.en || i.description.pt,
            es: i.description?.es || i.description.pt };
        }
      }
    }
  }
  if (aba === 'ingredientes') {
    for (const ing of Object.values(doc.ingredientes || {})) {
      ing.name = { ...ing.name, en: ing.name?.en || ing.name?.pt, es: ing.name?.es || ing.name?.pt };
    }
  }

  try {
    const r = await api('/config/' + aba, {
      method: 'POST',
      body: JSON.stringify({ doc, resumo: ABAS[aba][0] + ' atualizado' }),
    });
    if (r.erro === 'invalido') {
      avisar('Não salvou: ' + r.problemas.join(' · '), true);
      btn.disabled = false;
      return;
    }
    if (r.erro) { avisar('Não salvou. Tente de novo.', true); btn.disabled = false; return; }
    sujo = false;
    avisar('Salvo ✓');
    if (aba === 'ingredientes') window.__ings = doc.ingredientes;
  } catch (e) { /* 401 já avisou */ }
}

// -------------------------------------------------------------------- boot
(async () => {
  const nav = document.querySelector('nav');
  for (const [nome, [rotulo]] of Object.entries(ABAS)) {
    nav.append(el('button', { 'data-aba': nome, onclick: () => abrir(nome) }, rotulo));
  }
  document.getElementById('salvar').onclick = salvar;
  window.addEventListener('beforeunload', (e) => { if (sujo) e.preventDefault(); });

  // Os ingredientes alimentam as caixinhas do cardápio, então vêm antes.
  try { window.__ings = (await api('/config/ingredientes')).doc.ingredientes || {}; }
  catch (e) { window.__ings = {}; }

  abrir('menu');
})();
`.trim();

function moldura({ titulo, corpo, nonce = '', head = '' }) {
  return `<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${titulo}</title>
<style${nonce ? ` nonce="${nonce}"` : ''}>${CSS}</style>
${head}
</head>
<body>
${corpo}
</body>
</html>`;
}

function erro(titulo, detalhe = '') {
  return moldura({
    titulo: 'Painel',
    corpo: `<main style="text-align:center;padding-top:4rem">
<h1>${titulo}</h1>
${detalhe ? `<p style="color:var(--suave)">${detalhe}</p>` : ''}
</main>`,
  });
}

function render(minutos, nonce) {
  const nome = process.env.BUSINESS_NAME || 'Painel';

  return moldura({
    titulo: `${nome} — Painel`,
    nonce,
    corpo: `<header>
  <h1>${nome}</h1>
  <nav role="tablist"></nav>
</header>
<main id="main"></main>
<div class="barra" id="barra">
  <span id="aviso"></span>
  <span style="font-size:.75rem;color:var(--suave)">expira em ${minutos} min</span>
  <button class="salvar" id="salvar" disabled>Salvar</button>
</div>
<script nonce="${nonce}">${JS}</script>`,
  });
}

module.exports = { render, erro };
