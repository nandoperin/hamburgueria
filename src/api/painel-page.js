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
`.trim();

const JS = `
const S = document.body.dataset.s;
let doc = {}, aba = 'menu', sujo = false;

const api = async (p, opts = {}) => {
  const r = await fetch('/painel/api' + p, {
    ...opts,
    headers: { 'Authorization': 'Bearer ' + S, 'Content-Type': 'application/json' },
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
};

async function abrir(nome) {
  if (sujo && !confirm('Há alterações não salvas. Sair mesmo assim?')) return;
  aba = nome; sujo = false;
  document.querySelectorAll('nav button').forEach((b) =>
    b.setAttribute('aria-selected', b.dataset.aba === nome));

  const main = document.getElementById('main');
  main.replaceChildren(el('p', { cls: 'vazio' }, 'Carregando…'));

  const barra = document.getElementById('barra');
  barra.style.display = nome === 'relatorios' ? 'none' : 'flex';
  document.getElementById('salvar').disabled = true;
  avisar('');

  if (nome === 'relatorios') return ABAS[nome][1](main);
  const r = await api('/config/' + nome);
  doc = r.doc;
  ABAS[nome][1](main);
}

// --------------------------------------------------------------- promoção
function promocaoAtivaAgora() {
  if (doc.automatic !== true) return doc.manual_active === true;
  const dia = new Intl.DateTimeFormat('en-US', {
    timeZone: doc.timezone || 'America/New_York', weekday: 'short'
  }).format(new Date());
  return dia === 'Thu';
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
        ? 'Ativa quinta-feira às 00h e desativa sexta-feira às 00h, no horário de Nova York.'
        : 'O modo automático está desligado. O estado abaixo decide se o bot aceita a promoção.')),
    el('div', { cls: 'card' },
      el('label', {}, automatico, 'Ativar automaticamente toda quinta-feira')),
  ];

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
  nos.push(el('h2', {}, 'Produtos do Quintou'));
  for (const item of categoria.items || []) nos.push(cardPromocao(item));
  main.replaceChildren(...nos);
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
      onclick: () => card.classList.toggle('aberto') }, '▾')));

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
async function renderRelatorios(main) {
  const sel = el('select', {},
    ...[['hoje', 'Hoje'], ['semana', '7 dias'], ['mes', '30 dias'], ['trimestre', '90 dias']]
      .map(([v, t]) => el('option', { value: v }, t)));

  const alvo = el('div', {});
  const carregar = async () => {
    alvo.replaceChildren(el('p', { cls: 'vazio' }, 'Carregando…'));
    const r = await api('/relatorio?periodo=' + sel.value);
    alvo.replaceChildren(...blocosRelatorio(r));
  };
  sel.onchange = carregar;

  main.replaceChildren(el('div', { cls: 'linha' }, el('label', {}, 'Período'), sel), alvo);
  await carregar();
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

function tabela(titulo, cabecalho, linhas) {
  const t = el('table', {}, el('tr', {}, ...cabecalho.map((c, i) =>
    el('th', { cls: i ? 'num' : '' }, c))));
  for (const l of linhas) {
    t.append(el('tr', {}, ...l.map((c, i) => el('td', { cls: i ? 'num' : '' }, c))));
  }
  return el('div', {}, el('h2', {}, titulo), el('div', { cls: 'card' }, t));
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

function moldura({ titulo, corpo, sessao = '', head = '' }) {
  return `<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${titulo}</title>
<style>${CSS}</style>
${head}
</head>
<body${sessao ? ` data-s="${sessao}"` : ''}>
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

function render(sessao, minutos) {
  const nome = process.env.BUSINESS_NAME || 'Painel';

  return moldura({
    titulo: `${nome} — Painel`,
    sessao,
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
<script>${JS}</script>`,
  });
}

module.exports = { render, erro };
