const log = require('../log');
const db = require('../db/queries');
const schedule = require('./schedule');

/**
 * Histórico de pedidos e pagamentos guardado por 2 meses (decisão do dono,
 * 13/11/2026).
 *
 * Nada antigo é apagado: na primeira volta o bot grava em `bot_settings` a
 * data de início (`retencao_desde`). Só o que foi criado **depois** dela entra
 * na limpeza, e só quando passar de 60 dias. Os pedidos de antes ficam como
 * estão.
 *
 * Roda com a loja fechada, de algumas em algumas horas, em lotes pequenos.
 * Clientes (`customers`) não são apagados: é o que traz nome e endereço salvos
 * no próximo pedido.
 *
 * Lembrete: o backup do R2 guarda só 7 dias — o que sai daqui não volta.
 */

const CHAVE = 'retencao_desde';
const DIAS = 60;
const DIA_MS = 24 * 60 * 60 * 1000;
const INTERVALO_MS = 6 * 60 * 60 * 1000;
const PRIMEIRA_VOLTA_MS = 5 * 60 * 1000;
const MAX_LOTES = 20;

let timer = null;
let primeira = null;

/** Data a partir da qual o histórico pode ser apagado. Grava na primeira vez. */
async function marco(agora = new Date()) {
  const salvo = await db.getSetting(CHAVE);
  if (salvo && !Number.isNaN(Date.parse(salvo))) return new Date(salvo);
  await db.setSetting(CHAVE, agora.toISOString());
  log.info({ evt: 'retencao', desde: agora.toISOString() }, 'retenção de 2 meses começa a contar a partir de agora');
  return agora;
}

/** Uma volta: apaga o que passou de 60 dias, criado depois do marco. */
async function limpar(agora = new Date()) {
  const desde = await marco(agora);
  if (schedule.isOpen()) return { pedidos: 0, pagamentos: 0, pulou: 'aberto' };

  const ate = new Date(agora.getTime() - DIAS * DIA_MS);
  if (ate <= desde) return { pedidos: 0, pagamentos: 0 };

  const total = { pedidos: 0, pagamentos: 0 };
  for (let i = 0; i < MAX_LOTES; i += 1) {
    const r = await db.apagarPedidosAntigos(desde.toISOString(), ate.toISOString());
    total.pedidos += r.pedidos;
    total.pagamentos += r.pagamentos;
    if (!r.pedidos) break;
  }
  if (total.pedidos) {
    log.info({ evt: 'retencao', ...total, ate: ate.toISOString() }, 'histórico com mais de 2 meses apagado');
  }
  return total;
}

function rodar() {
  limpar().catch((err) => log.error({ evt: 'retencao', err }, 'falha na limpeza do histórico'));
}

function start() {
  if (timer) return;
  primeira = setTimeout(rodar, PRIMEIRA_VOLTA_MS);
  primeira.unref();
  timer = setInterval(rodar, INTERVALO_MS);
  timer.unref();
  log.info({ evt: 'boot' }, 'retenção ativa — pedidos novos ficam guardados por 2 meses');
}

function stop() {
  if (timer) clearInterval(timer);
  if (primeira) clearTimeout(primeira);
  timer = null;
  primeira = null;
}

module.exports = { limpar, marco, start, stop, DIAS, CHAVE };
