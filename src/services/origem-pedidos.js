const log = require('../log');

/**
 * Quantos pedidos vieram do site e quantos do WhatsApp (dono, 09/10/2026).
 *
 * Sem coluna nova em `orders`: o site anota o id de cada pedido que cria numa
 * lista em `bot_settings` (como o histórico de backup), com a origem —
 * `whatsapp` quando o cliente chegou pelo convite do bot (`?origem=whatsapp`),
 * `site` quando entrou direto. Todo pedido do relatório que não está na lista
 * é do WhatsApp.
 *
 * Guarda 120 dias, o bastante para o relatório do mês. Uma falha aqui nunca
 * atrapalha o pedido: ele já foi gravado e já foi para a cozinha.
 */
const CHAVE = 'pedidos_site';
const DIAS = 120;

let fila = Promise.resolve();

function ler(bruto) {
  try {
    const lista = JSON.parse(bruto || '[]');
    return Array.isArray(lista) ? lista : [];
  } catch (_) {
    return [];
  }
}

/** Anota um pedido do site. Em fila, para dois pedidos juntos não se apagarem. */
function anotar(orderId, origem) {
  const tarefa = fila.then(async () => {
    const db = require('../db/queries');
    const corte = Date.now() - DIAS * 864e5;
    const lista = ler(await db.getSetting(CHAVE)).filter((p) => new Date(p.em).getTime() >= corte);
    lista.push({ id: Number(orderId), origem: origem === 'whatsapp' ? 'whatsapp' : 'site', em: new Date().toISOString() });
    await db.setSetting(CHAVE, JSON.stringify(lista));
  }).catch((err) => log.warn({ evt: 'origem', err, pedido: orderId }, 'não consegui anotar a origem do pedido do site'));
  fila = tarefa;
  return tarefa;
}

/** Contagem do período: total, WhatsApp, site (e quantos do site vieram do convite). */
async function contar(from, to) {
  const db = require('../db/queries');
  const [ids, bruto] = await Promise.all([db.getIdsPedidosPagos(from, to), db.getSetting(CHAVE)]);
  const doSite = new Map(ler(bruto).map((p) => [Number(p.id), p.origem]));
  let site = 0;
  let viaConvite = 0;
  for (const id of ids) {
    if (!doSite.has(id)) continue;
    site += 1;
    if (doSite.get(id) === 'whatsapp') viaConvite += 1;
  }
  return { total: ids.length, whatsapp: ids.length - site, site, viaConvite };
}

/** A linha do `!relatorio`. */
function linhas({ total, whatsapp, site, viaConvite }) {
  const pct = (n) => (total ? ` (${Math.round((n / total) * 100)}%)` : '');
  return `\n*Canais:*\n  WhatsApp: ${whatsapp}${pct(whatsapp)}\n  Site: ${site}${pct(site)}` +
    (site ? ` — ${viaConvite} pelo convite do WhatsApp` : '') + '\n';
}

module.exports = { anotar, contar, linhas, CHAVE };
