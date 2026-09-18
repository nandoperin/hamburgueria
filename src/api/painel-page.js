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
  promotions: ['🔥 Promo Terça e Quarta', renderPromocao],
  ingredientes: ['🧂 Ingredientes', renderIngredientes],
  delivery: ['🚗 Entrega', renderEntrega],
  schedule: ['🕐 Horário', renderHorario],
  relatorios: ['📊 Relatórios', renderRelatorios],
  conversas: ['💬 Conversas', renderConversas],
  exemplos: ['🧠 Exemplos', renderExemplos],
};

// Abas que só leem — sem \`doc\` de config/painel/api, sem barra de salvar.
// (Exemplos tem os próprios botões: cada exemplo salva sozinho.)
const SOMENTE_LEITURA = ['relatorios', 'conversas', 'exemplos'];

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

function renderPromocao(main) {
  const ativa = promocaoAtivaAgora();
  const automatico = el('input', { type: 'checkbox' });
  automatico.checked = doc.automatic === true;
  automatico.onchange = () => {
    doc.automatic = automatico.checked;
    marcarSujo();
    renderPromocao(main);
  };

  const nos = [
    el('div', { cls: 'card' },
      el('div', { cls: 'linha' },
        el('span', { cls: 'estado ' + (ativa ? 'ativa' : 'inativa') },
          ativa ? '● Promoção ativa agora' : '○ Promoção inativa agora')),
      el('p', { cls: 'explica' }, doc.automatic === true
        ? 'Ativa terça-feira às 00h e desativa quinta-feira às 00h, no horário de Nova York.'
        : 'O modo automático está desligado. O estado abaixo decide se o bot aceita a promoção.')),
    el('div', { cls: 'card' },
      el('label', {}, automatico, 'Ativar automaticamente toda terça e quarta')),
  ];

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
  nos.push(el('h2', {}, 'Produtos da Promo Terça e Quarta'));
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
        description: { pt: (base.description?.pt || nomeBase) + '. Promoção de terça e quarta.' },
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

// ------------------------------------------------------------------ menu
function renderMenu(main) {
  const ings = Object.entries((window.__ings || {}));
  const nos = [];

  for (const cat of doc.categories || []) {
    nos.push(el('h2', {}, (cat.emoji || '') + ' ' + (cat.name?.pt || cat.id)));
    for (const item of cat.items || []) nos.push(cardItem(cat, item, ings));
    nos.push(el('button', { cls: 'add', onclick: () => {
      const id = prompt('Id do item novo (sem espaço, ex: x_duplo):');
      if (!id || !/^[a-z0-9_]+$/.test(id)) return alert('Use só letras minúsculas, números e _');
      cat.items.push({ id, name: { pt: '' }, description: { pt: '' }, price: 0,
                       available: true, tags: [], allergens: [],
                       modifiers: { removable: [], addable: [] } });
      marcarSujo(); renderMenu(main);
    } }, '+ item em ' + (cat.name?.pt || cat.id)));
  }
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
      if (!confirm('Remover "' + (item.name?.pt || item.id) + '" do cardápio?')) return;
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

  for (const [id, ing] of Object.entries(dic)) {
    const nome = el('input', { type: 'text', value: ing.name?.pt || '' });
    nome.oninput = () => { ing.name = { ...ing.name, pt: nome.value }; marcarSujo(); };
    const preco = el('input', { type: 'number', step: '0.01', min: '0', value: ing.price ?? 0 });
    preco.oninput = () => { ing.price = Number(preco.value); marcarSujo(); };

    nos.push(el('div', { cls: 'card' }, el('div', { cls: 'linha' }, nome, preco,
      el('button', { cls: 'mini', onclick: () => {
        if (!confirm('Remover o ingrediente "' + (ing.name?.pt || id) + '"?')) return;
        delete dic[id]; marcarSujo(); renderIngredientes(main);
      } }, '✕'))));
  }

  nos.push(el('button', { cls: 'add', onclick: () => {
    const id = prompt('Id do ingrediente (sem espaço, ex: queijo_extra):');
    if (!id || !/^[a-z0-9_]+$/.test(id)) return alert('Use só letras minúsculas, números e _');
    dic[id] = { name: { pt: '' }, price: 0 };
    marcarSujo(); renderIngredientes(main);
  } }, '+ ingrediente'));

  main.replaceChildren(...nos);
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
