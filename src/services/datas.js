/**
 * Datas no fuso do estabelecimento.
 *
 * O dono pensa em "ontem" e "dia 10" no relógio de Massachusetts; o banco
 * guarda UTC. A conversão precisa do deslocamento real de cada data: com o
 * horário de verão ele é -4h de março a novembro e -5h no resto do ano. Um
 * `-05:00` fixo empurrava o começo do dia para 1h da manhã metade do ano.
 */

const TZ = 'America/New_York';
const DIA_MS = 24 * 60 * 60 * 1000;
const FORMATO = /^\d{4}-\d{2}-\d{2}$/;

/** A data de `quando` no fuso, como AAAA-MM-DD. */
function dataLocal(quando = new Date(), tz = TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(quando);
}

/** Minutos entre o relógio do fuso e o UTC naquele instante (-240 no verão). */
function deslocamento(quando, tz = TZ) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(quando).map((x) => [x.type, x.value])
  );
  const comoUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((comoUtc - quando.getTime()) / 60000);
}

/** A data existe? (2026-02-30 não existe) */
function valida(data) {
  if (!FORMATO.test(String(data || ''))) return false;
  const [a, m, d] = data.split('-').map(Number);
  const t = new Date(Date.UTC(a, m - 1, d));
  return t.getUTCFullYear() === a && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Soma dias pelo calendário — não por 24h, que o horário de verão desalinha. */
function somarDias(data, dias) {
  const [a, m, d] = data.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

/** O instante (UTC) em que `data` começa no fuso. */
function meiaNoite(data, tz = TZ) {
  const [a, m, d] = data.split('-').map(Number);
  const utc = Date.UTC(a, m - 1, d);
  const chute = utc - deslocamento(new Date(utc), tz) * 60000;
  // O relógio muda às 2h, depois da meia-noite: medir o deslocamento no
  // próprio instante acerta também a data da troca.
  return new Date(utc - deslocamento(new Date(chute), tz) * 60000);
}

/**
 * De `de` a `ate` (inclusive), como intervalo UTC [início, fim).
 *
 * Recusa data que não existe, data invertida e mais de um ano de uma vez —
 * o relatório lê pedido por pedido, e um intervalo sem teto é uma consulta
 * sem teto.
 */
function intervaloDeDatas(de, ate, { maxDias = 366 } = {}) {
  if (!valida(de) || !valida(ate)) return { ok: false, motivo: 'data_invalida' };
  if (de > ate) return { ok: false, motivo: 'data_invertida' };

  const dias = Math.round((Date.parse(ate) - Date.parse(de)) / DIA_MS) + 1;
  if (dias > maxDias) return { ok: false, motivo: 'intervalo_grande' };

  return {
    ok: true,
    de,
    ate,
    dias,
    inicio: meiaNoite(de).toISOString(),
    fim: meiaNoite(somarDias(ate, 1)).toISOString(),
  };
}

module.exports = { TZ, dataLocal, deslocamento, valida, somarDias, meiaNoite, intervaloDeDatas };
