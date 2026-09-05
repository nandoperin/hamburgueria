const config = require('./config');

/** O horario vigente. Funcao, e nao constante: o dono edita em execucao. */
const schedule = () => config.get('schedule');
const log = require('../log');

/**
 * Retorna a hora e o dia da semana no fuso configurado.
 * Usa Intl para evitar dependência de biblioteca de datas.
 */
function nowInTimezone(quando = new Date()) {
  const tz = schedule().timezone || 'America/New_York';
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false,
  });

  const parts = Object.fromEntries(
    fmt.formatToParts(quando).map((p) => [p.type, p.value])
  );

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: weekdayMap[parts.weekday],
  };
}

/**
 * A loja está aberta agora?
 *
 * Trata janelas que cruzam a meia-noite (ex: 17h → 2h) comparando
 * contra o dia em que a janela começou.
 */
function isOpen() {
  if (estaPausado()) return false;
  return abertoPelaAgenda();
}

/** O horário configurado, sem considerar o encerramento manual. */
function abertoPelaAgenda(quando = new Date()) {
  // Modo de teste: atende 24h sem alterar o horário configurado.
  if (schedule().always_open === true) return true;

  const { hour, weekday } = nowInTimezone(quando);
  const closedDays = schedule().closed_days || [];
  const open = schedule().open_hour;
  const close = schedule().close_hour;

  const crossesMidnight = close <= open;

  if (!crossesMidnight) {
    if (closedDays.includes(weekday)) return false;
    return hour >= open && hour < close;
  }

  // Janela cruza a meia-noite: 17h–2h vira [17..23] hoje + [0..1] amanhã
  if (hour >= open) {
    return !closedDays.includes(weekday);
  }
  if (hour < close) {
    const previousDay = (weekday + 6) % 7;
    return !closedDays.includes(previousDay);
  }
  return false;
}

// ------------------------------------------- encerrar o atendimento mais cedo
//
// Acabou a carne, choveu, o entregador foi embora. O dono encerra o dia pelo
// WhatsApp e o bot passa a responder "fechado" até a próxima abertura — sem
// deploy, sem mexer em config.
//
// **Fica no banco, não em memória.** Um deploy no meio da noite reabriria o
// a loja sozinha, e ninguém perceberia: os pedidos voltariam a entrar com a
// cozinha já desmontada.

const CHAVE = 'fechado_ate';
const RECARGA_MS = 60 * 1000;

// Instante em que a pausa termina, em ms. `null` = atendendo normalmente.
let pausadoAte = null;

function estaPausado() {
  if (!pausadoAte) return false;
  if (Date.now() < pausadoAte) return true;

  // Passou da hora: a pausa morre sozinha, sem ninguém precisar reabrir.
  pausadoAte = null;
  return false;
}

/**
 * Quando o atendimento recomeça, a partir de `desde`.
 *
 * Varre o tempo de meia em meia hora em vez de calcular o próximo dia útil na
 * mão: o fuso tem horário de verão, a janela cruza a meia-noite e há dia de
 * folga no meio. Reusar a própria função que decide se está aberto é mais
 * curto e não tem como divergir dela.
 */
function proximaAbertura(desde = new Date()) {
  const PASSO_MS = 30 * 60 * 1000;
  const LIMITE = (8 * 24 * 60) / 30; // oito dias bastam até para folga longa

  let instante = new Date(Math.ceil(desde.getTime() / PASSO_MS) * PASSO_MS);

  // Sair primeiro da janela de hoje. Sem este passo, quem encerra às 20h — com
  // a loja aberta — recebia como "próxima abertura" as 20h30 do mesmo dia, e a
  // pausa terminava meia hora depois de começar.
  let i = 0;
  while (i < LIMITE && abertoPelaAgenda(instante)) {
    instante = new Date(instante.getTime() + PASSO_MS);
    i += 1;
  }

  while (i < LIMITE) {
    if (abertoPelaAgenda(instante)) return instante;
    instante = new Date(instante.getTime() + PASSO_MS);
    i += 1;
  }
  return null;
}

/** Lê o estado gravado. Falhar aqui não pode derrubar o atendimento. */
async function carregarPausa() {
  try {
    const valor = await require('../db/queries').getSetting(CHAVE);
    const ate = valor ? new Date(valor).getTime() : null;
    pausadoAte = ate && Date.now() < ate ? ate : null;
  } catch (err) {
    // Tabela ainda não criada, ou banco fora: seguimos pelo horário normal.
    log.warn({ evt: 'agenda', err }, 'não consegui ler o encerramento manual');
  }
}

/** Encerra o atendimento até a próxima abertura. Devolve quando volta. */
async function pausarAteProximaAbertura() {
  const volta = proximaAbertura();
  if (!volta) return null;

  pausadoAte = volta.getTime();
  await require('../db/queries').setSetting(CHAVE, volta.toISOString());

  log.warn(
    { evt: 'agenda', ate: volta.toISOString() },
    'atendimento encerrado pelo dono até a próxima abertura'
  );
  return volta;
}

/** Volta a atender agora, antes da hora. */
async function retomar() {
  pausadoAte = null;
  await require('../db/queries').setSetting(CHAVE, null);
  log.warn({ evt: 'agenda' }, 'atendimento retomado pelo dono');
}

/** Para o `!fila` e o `!ajuda` contarem o que está acontecendo. */
function estadoDaPausa() {
  return { pausado: estaPausado(), ate: pausadoAte ? new Date(pausadoAte) : null };
}

function start() {
  carregarPausa();
  setInterval(carregarPausa, RECARGA_MS).unref();
}

/**
 * O horário de funcionamento em texto, para mensagens ao cliente.
 *
 * Gerado do `config/schedule.json` na hora de responder, pela mesma razão que a
 * área de entrega sai do `delivery.json`: duas fontes para o mesmo fato sempre
 * divergem, e quem descobre é o cliente que veio no horário errado.
 */
const DIAS = {
  pt: ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
};

const SEMPRE = {
  pt: 'Todos os dias, 24 horas.',
  en: 'Every day, 24 hours.',
  es: 'Todos los días, 24 horas.',
};

const FECHADO = { pt: 'Fechado', en: 'Closed', es: 'Cerrado' };
const TODOS = { pt: 'Todos os dias', en: 'Every day', es: 'Todos los días' };

/** 17 -> "17h" / "5pm"; 24 e meia-noite. */
function hora(n, lang) {
  const h = Number(n) % 24;
  if (lang === 'en') {
    if (h === 0) return 'midnight';
    if (h === 12) return 'noon';
    return h < 12 ? `${h}am` : `${h - 12}pm`;
  }
  if (h === 0) return lang === 'es' ? 'medianoche' : 'meia-noite';
  return `${h}h`;
}

function horarioTexto(lang = 'pt') {
  const dias = DIAS[lang] || DIAS.pt;

  if (schedule().always_open) return SEMPRE[lang] || SEMPRE.pt;

  const fechados = (schedule().closed_days || []).map(Number);
  const abertos = [0, 1, 2, 3, 4, 5, 6].filter((d) => !fechados.includes(d));

  const janela = `${hora(schedule().open_hour, lang)} – ${hora(schedule().close_hour, lang)}`;

  if (!abertos.length) return FECHADO[lang] || FECHADO.pt;

  const quais = abertos.length === 7
    ? TODOS[lang] || TODOS.pt
    : abertos.map((d) => dias[d]).join(', ');

  const linhas = [`${quais}: ${janela}`];
  if (fechados.length) {
    linhas.push(`${FECHADO[lang] || FECHADO.pt}: ${fechados.map((d) => dias[d]).join(', ')}`);
  }
  return linhas.join(String.fromCharCode(10));
}

module.exports = {
  isOpen,
  horarioTexto,
  nowInTimezone,
  abertoPelaAgenda,
  proximaAbertura,
  pausarAteProximaAbertura,
  retomar,
  carregarPausa,
  estadoDaPausa,
  start,
};
