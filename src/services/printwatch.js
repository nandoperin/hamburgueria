const log = require('../log');
const db = require('../db/queries');
const notify = require('../bot/notify');

/**
 * Vigia a impressora e avisa o dono quando uma comanda paga não sai.
 *
 * Existe porque a falha do CloudPRNT é silenciosa: quando a impressora para de
 * consultar — falta de papel, queda de rede, configuração inválida — ninguém
 * recebe erro. O servidor segue oferecendo o trabalho, a impressora nunca
 * busca, e a cozinha só descobre pelo cliente reclamando.
 *
 * O pedido nunca se perde (fica `paid` até imprimir), mas descobrir tarde é o
 * mesmo que perder. Daí o aviso ativo.
 */

// Minutos entre o pagamento e o alerta. Curto de propósito: comida esfriando é
// pior que uma mensagem a mais.
const ATRASO_MINUTOS = Number(process.env.PRINT_ALERT_MINUTES) || 2;

// A impressora consulta a cada 5s. Passar disso é sinal de que ela caiu.
const SILENCIO_SEGUNDOS = 30;

const INTERVALO_MS = 60 * 1000;

let ultimoPolling = null;
let timer = null;

// Um aviso por pedido. Sem isso o dono receberia a mesma mensagem a cada
// minuto enquanto a impressora estiver fora.
const jaAvisados = new Set();

/** Chamado pelo endpoint do CloudPRNT a cada consulta da impressora. */
function registrarPolling() {
  ultimoPolling = Date.now();
}

/**
 * Estado da impressora do ponto de vista do servidor.
 * `viva` é inferência, não certeza: só sabemos que ela falou conosco há pouco.
 */
function status() {
  if (!ultimoPolling) {
    return { viva: false, segundos: null, nuncaFalou: true };
  }
  const segundos = Math.round((Date.now() - ultimoPolling) / 1000);
  return { viva: segundos < SILENCIO_SEGUNDOS, segundos, nuncaFalou: false };
}

/** Texto curto do tipo "há 3 min" / "há 12s". */
function desde(ms) {
  const segundos = Math.round(ms / 1000);
  if (segundos < 90) return `há ${segundos}s`;
  return `há ${Math.round(segundos / 60)} min`;
}

/** Quando o pedido virou pago — cai no created_at se o pagamento não trouxer. */
function pagoEm(order) {
  const pagamento = (order.payments || []).find((p) => p.paid_at);
  return new Date(pagamento?.paid_at || order.created_at).getTime();
}

function money(v) {
  return `$${Number(v).toFixed(2)}`;
}

/** Fila atual, com o tempo de espera de cada pedido já calculado. */
async function fila() {
  const pedidos = await db.getUnprintedPaidOrders();
  const agora = Date.now();

  return pedidos.map((o) => ({
    id: o.id,
    nome: o.customer_name || 'sem nome',
    phone: o.phone,
    total: o.total,
    esperandoMs: agora - pagoEm(o),
  }));
}

/** Resposta do comando !fila. */
async function resumo() {
  const [pendentes, st] = [await fila(), status()];

  const linhaImpressora = st.nuncaFalou
    ? '🖨️ Impressora: *nunca consultou* desde que o servidor subiu'
    : st.viva
      ? `🖨️ Impressora: ✅ ativa (último sinal ${desde(st.segundos * 1000)})`
      : `🖨️ Impressora: ⚠️ *sem sinal* ${desde(st.segundos * 1000)}`;

  if (!pendentes.length) {
    return `${linhaImpressora}\n\n✅ Nenhuma comanda esperando.`;
  }

  const lista = pendentes
    .map((p) => `*#${p.id}* — ${money(p.total)} · ${p.nome}\n  pago ${desde(p.esperandoMs)}`)
    .join('\n');

  return (
    `${linhaImpressora}\n\n` +
    `📋 *${pendentes.length} comanda(s) esperando:*\n${lista}\n\n` +
    `_Saem sozinhas quando a impressora voltar._`
  );
}

function adminsConfigurados() {
  return (process.env.ADMIN_PHONE || '')
    .split(',')
    .map((n) => n.replace(/\D/g, ''))
    .filter((n) => n.length >= 10);
}

async function avisar(atrasados) {
  const admins = adminsConfigurados();
  if (!admins.length) {
    log.warn(
      { evt: 'impressao', pedidos: atrasados.map((p) => p.id) },
      'comanda atrasada, mas ADMIN_PHONE não está configurado'
    );
    return;
  }

  const st = status();
  const lista = atrasados
    .map((p) => `*#${p.id}* — ${money(p.total)} · ${p.nome}\n  pago ${desde(p.esperandoMs)}`)
    .join('\n');

  const diagnostico = st.viva
    ? '_A impressora está consultando normalmente — confira papel, tampa e energia._'
    : `_A impressora está sem dar sinal ${st.nuncaFalou ? 'desde que o servidor subiu' : desde(st.segundos * 1000)} — confira energia e rede._`;

  const texto =
    `🖨️ *COMANDA NÃO IMPRESSA*\n\n${lista}\n\n${diagnostico}\n\n` +
    `Nada se perde: sai sozinha quando ela voltar. Use *!fila* para acompanhar.`;

  // Mesmo tratamento das respostas de comando: o canal do dono é sem acento e
  // sem emoji (ver src/texto.js).
  const paraEle = require('../texto').paraAdmin(texto);
  for (const admin of admins) {
    await notify.send(admin, paraEle);
  }
}

async function verificar() {
  const pendentes = await fila();

  // Pedido que saiu da fila pode voltar a alertar se um dia reaparecer.
  const idsNaFila = new Set(pendentes.map((p) => p.id));
  for (const id of jaAvisados) {
    if (!idsNaFila.has(id)) jaAvisados.delete(id);
  }

  const limite = ATRASO_MINUTOS * 60 * 1000;
  const novos = pendentes.filter(
    (p) => p.esperandoMs > limite && !jaAvisados.has(p.id)
  );

  if (!novos.length) return;

  novos.forEach((p) => jaAvisados.add(p.id));

  const st = status();
  log.warn(
    {
      evt: 'impressao',
      pedidos: novos.map((p) => p.id),
      impressoraViva: st.viva,
      silencioSegundos: st.segundos,
    },
    `${novos.length} comanda(s) paga(s) sem imprimir — avisando o dono`
  );

  await avisar(novos);
}

function start() {
  if (timer) return;

  timer = setInterval(() => {
    verificar().catch((err) =>
      log.error({ evt: 'impressao', err }, 'falha ao verificar a fila de impressão')
    );
  }, INTERVALO_MS);
  timer.unref();

  log.info(
    { evt: 'boot', atrasoMinutos: ATRASO_MINUTOS },
    `vigilância de impressão ativa — alerta após ${ATRASO_MINUTOS} min sem imprimir`
  );
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  registrarPolling,
  status,
  fila,
  resumo,
  verificar,
  start,
  stop,
};
