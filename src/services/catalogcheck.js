const log = require('../log');
const catalog = require('./catalog');

/**
 * Confere se o catálogo da Meta e o `config/menu.json` ainda contam a mesma
 * história.
 *
 * São dois lugares mantidos à mão, ligados só pela convenção de o "Content ID"
 * do produto ser o `id` do item. Nada impede que divirjam, e nenhuma das duas
 * formas de divergir avisa sozinha:
 *
 * - **Preço diferente** — o cliente vê um valor no catálogo e paga outro. Quem
 *   manda no que é cobrado é sempre o `menu.json` (`menu.js`, `addSimpleItem`);
 *   o catálogo é só vitrine. Editar o preço no Commerce Manager não muda nada
 *   do que é cobrado, e ainda é desfeito no próximo envio do feed.
 * - **Produto só de um lado** — órfão na Meta some do carrinho sem o cliente
 *   entender; ausente na Meta simplesmente não aparece no cardápio com foto.
 *
 * A checagem roda na subida (log) e sob demanda pelo `!catalogo` (WhatsApp).
 */

const GRAPH = 'https://graph.facebook.com';
const API_VERSION = process.env.META_API_VERSION || 'v22.0';

// O teto existe só para a resposta não crescer sem limite se alguém encher o
// Commerce Manager de itens fora do cardápio.
const LIMITE = 200;

function configurado() {
  return Boolean(process.env.META_CATALOG_ID && process.env.META_ACCESS_TOKEN);
}

/**
 * Produtos do catálogo, pela Graph API.
 *
 * O token vai no cabeçalho, e não na query: URL entra em log de proxy, em
 * histórico e em mensagem de erro — o cabeçalho, não.
 */
async function buscarProdutos() {
  const url =
    `${GRAPH}/${API_VERSION}/${process.env.META_CATALOG_ID}/products` +
    `?fields=retailer_id,name,price&limit=${LIMITE}`;

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
  });

  const body = await res.json();

  if (!res.ok || body.error) {
    const err = new Error(body.error?.message || `Graph API ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return body.data || [];
}

/** "$18.00" → 18. A Meta devolve o preço já formatado com a moeda. */
function precoNumerico(bruto) {
  const n = Number(String(bruto ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Itens que o feed deveria conter.
 *
 * `available: false` é saída permanente do cardápio, e esses ficam fora do feed
 * de propósito (ver `catalog.feedRows`). Já o esgotado do dia continua no
 * catálogo — quem barra é o bot, na hora do pedido.
 */
function itensDoFeed() {
  return catalog.allItems().filter(
    (item) => item.available !== false && item.catalogVisible !== false
  );
}

/**
 * Compara os dois lados.
 *
 * @returns {Promise<object|null>} null quando o catálogo não está configurado
 */
async function verificar() {
  if (!configurado()) return null;

  const produtos = await buscarProdutos();
  const itens = itensDoFeed();

  const porId = new Map(itens.map((item) => [item.id, item]));
  const naMeta = new Set(produtos.map((p) => p.retailer_id));

  const orfaos = produtos
    .filter((p) => !porId.has(p.retailer_id))
    .map((p) => ({ id: p.retailer_id, nome: p.name }));

  const ausentes = itens
    .filter((item) => !naMeta.has(item.id))
    .map((item) => ({ id: item.id, nome: item.name.pt }));

  const precos = [];
  for (const produto of produtos) {
    const item = porId.get(produto.retailer_id);
    if (!item) continue;

    const naVitrine = precoNumerico(produto.price);
    if (naVitrine === null || Math.abs(naVitrine - item.price) < 0.005) continue;

    precos.push({ id: item.id, nome: item.name.pt, catalogo: naVitrine, cobrado: item.price });
  }

  return {
    ok: !orfaos.length && !ausentes.length && !precos.length,
    total: produtos.length,
    esperados: itens.length,
    orfaos,
    ausentes,
    precos,
  };
}

// ------------------------------------------------------------------- na subida

/**
 * Roda uma vez ao subir e registra o que estiver torto.
 *
 * Não derruba nada: um catálogo divergente é problema de configuração, não
 * motivo para o bot não atender. E falha de rede aqui não pode impedir a
 * subida — se a Graph API estiver fora do ar, o log diz isso e a vida segue.
 */
async function verificarNoBoot() {
  try {
    const r = await verificar();

    if (!r) {
      log.info({ evt: 'catalogo' }, 'catálogo não configurado — checagem ignorada');
      return;
    }

    if (r.ok) {
      log.info(
        { evt: 'catalogo', produtos: r.total },
        `catálogo conferido: ${r.total} produtos, tudo batendo com o cardápio`
      );
      return;
    }

    log.warn(
      {
        evt: 'catalogo',
        orfaos: r.orfaos.map((o) => o.id),
        ausentes: r.ausentes.map((a) => a.id),
        precos: r.precos,
      },
      'catálogo divergente do cardápio — use !catalogo para o detalhe'
    );
  } catch (err) {
    log.error({ evt: 'catalogo', err }, 'falha ao conferir o catálogo');
  }
}

// ------------------------------------------------------------ resposta do bot

function money(v) {
  return `$${Number(v).toFixed(2)}`;
}

/** Resposta do comando `!catalogo`. */
async function resumo() {
  if (!configurado()) {
    return '📦 Catálogo não configurado (META_CATALOG_ID ausente) — o cardápio sai em texto.';
  }

  let r;
  try {
    r = await verificar();
  } catch (err) {
    return `❌ Não consegui consultar o catálogo na Meta.\n\n${err.message}`;
  }

  if (r.ok) {
    return (
      `📦 *CATÁLOGO EM DIA*\n\n` +
      `✅ ${r.total} produtos, todos batendo com o cardápio — nomes e preços.`
    );
  }

  const blocos = [`📦 *CATÁLOGO DIVERGENTE*`];

  if (r.precos.length) {
    blocos.push(
      `💵 *Preço diferente* (o bot cobra o do cardápio):\n` +
        r.precos
          .map(
            (p) =>
              `• ${p.nome}\n  catálogo ${money(p.catalogo)} · *cobrado ${money(p.cobrado)}*`
          )
          .join('\n')
    );
  }

  if (r.orfaos.length) {
    blocos.push(
      `👻 *Só no catálogo* (o bot não reconhece e remove do carrinho):\n` +
        r.orfaos.map((o) => `• ${o.nome} (${o.id})`).join('\n')
    );
  }

  if (r.ausentes.length) {
    blocos.push(
      `🚫 *Só no cardápio* (não aparece com foto para o cliente):\n` +
        r.ausentes.map((a) => `• ${a.nome} (${a.id})`).join('\n')
    );
  }

  blocos.push(
    `_Para acertar: editar_ config/menu.json_, rodar_ npm run catalogo_ e subir ` +
      `o CSV no Commerce Manager._`
  );

  return blocos.join('\n\n');
}

module.exports = { verificar, verificarNoBoot, resumo, configurado };
