const express = require('express');

const cardapio = require('../services/cardapio');
const modifiers = require('../services/modifiers');
const delivery = require('../services/delivery');
const { SUPPORTED_LANGS, DEFAULT_LANG } = require('../i18n');

const router = express.Router();

/**
 * Página `/cardapio` — o terceiro nível do cardápio.
 *
 * Os outros dois vivem no chat: a imagem por categoria (panorama) e a foto do
 * item sob demanda (o que converte quem está indeciso). Esta página é para quem
 * quer ver tudo com calma, e por isso fica **no rodapé**, nunca no caminho
 * crítico — o cliente que sai do chat para decidir é o cliente que pode não
 * voltar.
 *
 * Gerada do `menu.json` a cada requisição. Não há cópia para envelhecer: mudou
 * o preço, mudou a página.
 *
 * ## Auto-suficiente de propósito
 *
 * CSS embutido, zero script, zero fonte externa. Ela abre no navegador interno
 * do WhatsApp, muitas vezes em rede ruim — cada requisição a mais é uma chance
 * de a página não abrir. E sem recurso externo não há nada que rastreie quem a
 * visitou.
 */

const TITULOS = {
  pt: { menu: 'Cardápio', remover: 'sai de graça', add: 'pode acrescentar', entrega: 'Entrega', retirada: 'Retirada', gratis: 'grátis' },
  en: { menu: 'Menu', remover: 'free to remove', add: 'can be added', entrega: 'Delivery', retirada: 'Pickup', gratis: 'free' },
  es: { menu: 'Menú', remover: 'quitar es gratis', add: 'se puede agregar', entrega: 'Entrega', retirada: 'Recogida', gratis: 'gratis' },
};

/**
 * Escapa para HTML.
 *
 * O conteúdo vem do `menu.json`, que é nosso — mas a página é pública e o
 * arquivo é editado à mão. Um `&` num nome de item ("Bacon & Cheddar") já
 * quebraria a marcação; escapar custa nada e vale para o dia em que alguém
 * colar uma descrição de outro lugar.
 */
function esc(texto) {
  return String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function idioma(req) {
  const pedido = String(req.query.lang || '').toLowerCase();
  if (SUPPORTED_LANGS.includes(pedido)) return pedido;

  const aceito = String(req.headers['accept-language'] || '').toLowerCase();
  return SUPPORTED_LANGS.find((l) => aceito.startsWith(l)) || DEFAULT_LANG;
}

function preco(valor) {
  return `$${Number(valor).toFixed(2)}`;
}

function linhaIngredientes(rotulo, lista, mostrarPreco) {
  if (!lista.length) return '';

  const itens = lista
    .map((i) => {
      const extra = mostrarPreco && i.preco > 0 ? ` <b>+${preco(i.preco)}</b>` : '';
      return `<span class="ing">${esc(i.nome)}${extra}</span>`;
    })
    .join('');

  return `<div class="mods"><span class="rot">${esc(rotulo)}</span>${itens}</div>`;
}

function blocoItem(item, lang, textos) {
  const partes = [`<div class="item" id="${esc(item.id)}">`];

  partes.push('<div class="topo">');
  partes.push(`<h3>${esc(cardapio.nome(item, lang))}</h3>`);
  partes.push(`<span class="preco">${preco(item.price)}</span>`);
  partes.push('</div>');

  const desc = cardapio.descricao(item, lang);
  if (desc) partes.push(`<p class="desc">${esc(desc)}</p>`);

  if (modifiers.tem(item)) {
    partes.push(
      linhaIngredientes(textos.remover, modifiers.removiveis(item, lang), false)
    );
    partes.push(
      linhaIngredientes(textos.add, modifiers.adicionais(item, lang), true)
    );
  }

  partes.push('</div>');
  return partes.join('');
}

function blocoEntrega(textos) {
  const cidades = delivery.getCities();
  const pickup = delivery.getPickup();
  const linhas = [];

  if (pickup?.enabled) {
    linhas.push(
      `<li><b>${esc(textos.retirada)}</b> — ${esc(textos.gratis)}</li>`
    );
  }
  for (const c of cidades) {
    linhas.push(`<li>${esc(c.label)} — <b>${preco(c.delivery_fee)}</b></li>`);
  }

  if (!linhas.length) return '';
  return `<section class="entrega"><h2>${esc(textos.entrega)}</h2><ul>${linhas.join('')}</ul></section>`;
}

const CSS = `
:root{--bg:#faf8f5;--card:#fff;--tinta:#1c1917;--suave:#78716c;--linha:#e7e5e4;--destaque:#c2410c;--chip:#f5f5f4}
@media(prefers-color-scheme:dark){:root{--bg:#1c1917;--card:#292524;--tinta:#fafaf9;--suave:#a8a29e;--linha:#44403c;--destaque:#fb923c;--chip:#44403c}}
*{box-sizing:border-box}
body{margin:0;padding:0 0 3rem;background:var(--bg);color:var(--tinta);
  font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{padding:1.75rem 1.25rem 1.25rem;text-align:center}
header h1{margin:0;font-size:1.6rem;letter-spacing:-.02em}
main{max-width:640px;margin:0 auto;padding:0 1rem}
h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.09em;color:var(--suave);
  margin:2rem 0 .75rem;padding-bottom:.4rem;border-bottom:1px solid var(--linha)}
.item{background:var(--card);border:1px solid var(--linha);border-radius:12px;
  padding:.9rem 1rem;margin-bottom:.6rem}
.topo{display:flex;justify-content:space-between;align-items:baseline;gap:.75rem}
.topo h3{margin:0;font-size:1.02rem;font-weight:600}
.preco{font-weight:700;color:var(--destaque);white-space:nowrap}
.desc{margin:.35rem 0 0;color:var(--suave);font-size:.9rem}
.mods{margin-top:.6rem;font-size:.78rem;display:flex;flex-wrap:wrap;gap:.3rem;align-items:center}
.rot{color:var(--suave);text-transform:uppercase;letter-spacing:.05em;
  font-size:.68rem;width:100%;margin-bottom:.1rem}
.ing{background:var(--chip);border-radius:999px;padding:.16rem .55rem}
.entrega ul{list-style:none;padding:0;margin:0}
.entrega li{background:var(--card);border:1px solid var(--linha);border-radius:10px;
  padding:.6rem .9rem;margin-bottom:.4rem;display:flex;justify-content:space-between}
footer{text-align:center;color:var(--suave);font-size:.78rem;margin-top:2.5rem;padding:0 1rem}
`.trim();

router.get('/cardapio', (req, res) => {
  const lang = idioma(req);
  const textos = TITULOS[lang] || TITULOS[DEFAULT_LANG];
  const nome = process.env.BUSINESS_NAME || 'Cardápio';

  const secoes = cardapio
    .categoriasDisponiveis()
    .map((categoria) => {
      const itens = cardapio
        .itensDisponiveis(categoria)
        .map((item) => blocoItem(item, lang, textos))
        .join('');

      const titulo = `${categoria.emoji || ''} ${categoria.name[lang] || categoria.name.pt}`.trim();
      return `<section><h2>${esc(titulo)}</h2>${itens}</section>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(nome)} — ${esc(textos.menu)}</title>
<style>${CSS}</style>
</head>
<body>
<header><h1>${esc(nome)}</h1></header>
<main>
${secoes}
${blocoEntrega(textos)}
<footer>${esc(nome)}</footer>
</main>
</body>
</html>`;

  // Cache curto: a página é gerada do menu.json, e mudança de preço precisa
  // aparecer rápido. Cinco minutos poupa o servidor sem deixar preço velho na
  // tela de ninguém por muito tempo.
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(html);
});

module.exports = router;
