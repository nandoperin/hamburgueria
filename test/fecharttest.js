process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.SQUARE_ACCESS_TOKEN = 'faketoken';
process.env.SQUARE_LOCATION_ID = 'FAKELOC';
process.env.BASE_URL = 'https://fake.test';
process.env.ADMIN_PHONE = '15550001111';
process.env.SUPPORT_PHONE = '18573124606';

/**
 * Encerrar o atendimento mais cedo, pelo WhatsApp.
 *
 * Acabou a carne, choveu, o entregador foi embora. O que importa aqui é o que
 * NÃO precisa acontecer depois: ninguém tem que lembrar de reabrir no dia
 * seguinte, e um deploy no meio da noite não pode reabrir o truck sozinho — por
 * isso o estado fica no banco, e não em memória.
 */

const PROJECT = require('path').resolve(__dirname, '..');
const ADMIN = '15550001111';

// O banco falso guarda de verdade, para provar que o estado sobrevive.
const guardado = {};
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getSetting: async (k) => guardado[k] ?? null,
  setSetting: async (k, v) => { if (v === null) delete guardado[k]; else guardado[k] = v; },
  getCustomerByPhone: async () => null,
  getLastDeliveryOrder: async () => null,
  getActiveOrderByPhone: async () => null,
  listUnavailableItems: async () => [],
};

// O `!fechar` só significa alguma coisa com o horário valendo. Em produção o
// `always_open` pode estar ligado (modo de teste, 24h) — e aí não existe
// "próxima abertura" para a pausa terminar. A suíte fixa o horário que quer
// provar, em vez de depender do que estiver no config hoje, pelo mesmo motivo
// que `comentrega.js` liga a entrega sozinho.
const cfgPath = require.resolve(`${PROJECT}/config/schedule.json`);
require(cfgPath);
require.cache[cfgPath].exports = {
  ...require.cache[cfgPath].exports,
  always_open: false,
};

const schedule = require(`${PROJECT}/src/services/schedule`);
const admin = require(`${PROJECT}/src/bot/handlers/admin`);
const { route } = require(`${PROJECT}/src/bot/router`);
const session = require(`${PROJECT}/src/bot/session`);
const notify = require(`${PROJECT}/src/bot/notify`);

notify.registerRich({ sendButtons: async () => {}, sendList: async () => [] });
notify.register(async () => {});

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const titulo = (n) => console.log(`\n\x1b[33m### ${n} ###\x1b[0m`);

async function comando(texto) {
  const ditas = [];
  await admin.handle(ADMIN, texto, async (t) => ditas.push(t));
  return ditas.join('\n');
}

// Congela o relogio numa terca-feira as 20h de Everett (EDT = UTC-4).
const RealDate = Date;
function fixar(iso) {
  const alvo = new RealDate(iso);
  global.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : alvo; }
    static now() { return alvo.getTime(); }
  };
}

(async () => {
  // ============================================ fechar no meio do movimento
  titulo('ENCERRAR AS 20H DE UMA TERCA');

  fixar('2026-08-12T00:30:00Z'); // terca 11/08, 20:30 ET
  checar(schedule.isOpen(), 'antes do comando, o truck esta aberto');

  let r = await comando('!fechar');
  console.log('      ' + r.split('\n')[0]);

  checar(!schedule.isOpen(), 'depois do !fechar, o bot responde fechado');
  checar(r.includes('Volta sozinho'), 'e avisa que volta sozinho');
  checar(
    /quarta/i.test(r),
    `dizendo quando: ${r.match(/\*([^*]*feira[^*]*)\*/)?.[1] || '(?)'}`
  );

  // ===================================== o cliente sente na hora
  titulo('O CLIENTE RECEBE FECHADO');

  const ditas = [];
  session.clear('15559998888');
  await route('15559998888', 'Oi', async (t) => ditas.push(t));
  checar(
    /fechad|closed|cerrad/i.test(ditas.join('\n')),
    'quem escrever recebe a mensagem de fechado, nos tres idiomas'
  );

  // ============================ o estado esta no banco, nao so na memoria
  titulo('SOBREVIVE A UM DEPLOY');

  checar(Boolean(guardado.fechado_ate), 'o encerramento foi gravado no banco');

  // Simula o processo reiniciando: a memoria zera, o banco continua.
  await schedule.retomar();          // limpa a memoria...
  guardado.fechado_ate = new RealDate('2026-08-12T21:00:00Z').toISOString(); // ...e o banco tem o registro
  await schedule.carregarPausa();
  checar(
    !schedule.isOpen(),
    'ao subir de novo, o bot le o banco e continua fechado — nao reabre sozinho'
  );

  // ============================================ a pausa morre na hora certa
  titulo('VOLTA SOZINHO NA PROXIMA ABERTURA');

  fixar('2026-08-12T21:30:00Z'); // quarta 12/08, 17:30 ET
  checar(
    schedule.isOpen(),
    'passada a hora, o atendimento volta sem ninguem reabrir'
  );

  // ===================================================== reabrir antes da hora
  titulo('MUDOU DE IDEIA');

  fixar('2026-08-12T00:30:00Z'); // terca, 20:30 ET de novo
  await schedule.retomar();
  await comando('!fechar');
  checar(!schedule.isOpen(), 'fechou');

  r = await comando('!abrir');
  checar(schedule.isOpen(), 'e o !abrir retoma na hora');
  checar(r.includes('retomado'), 'confirmando ao dono');
  checar(!guardado.fechado_ate, 'e limpa o registro do banco');

  // ================================== fechar quando ja esta fechado
  titulo('FECHAR FORA DO HORARIO');

  fixar('2026-08-12T15:00:00Z'); // quarta, 11h ET — antes de abrir
  r = await comando('!fechar');
  // Sem acento: o canal do admin passa por `paraAdmin` (ver src/texto.js).
  checar(
    r.includes('ja esta fechado'),
    'nao finge que encerrou algo que nao estava aberto'
  );
  checar(!guardado.fechado_ate, 'e nao grava nada');

  global.Date = RealDate;
  console.log('\n\x1b[32mTodos os cenarios passaram.\x1b[0m');
})().catch((e) => {
  global.Date = RealDate;
  console.error('\n\x1b[31mFALHOU:\x1b[0m', e.message);
  process.exit(1);
});
