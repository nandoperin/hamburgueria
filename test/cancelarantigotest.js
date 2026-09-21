/**
 * "Cancelar" no meio de um pedido novo não pode achar o pedido da semana
 * passada (dono, 20/09: ouviu que o *#55* não podia ser cancelado, e a equipe
 * foi avisada à toa). Só conta o pedido do atendimento de agora.
 */
process.env.DATABASE_URL = 'postgresql://fake';

const PROJECT = require('path').resolve(__dirname, '..');
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({}, { get: () => async () => null });

const cancel = require(`${PROJECT}/src/bot/handlers/cancel`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const horas = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

checar(!cancel.doAtendimentoDeAgora(null), 'sem pedido nenhum, nada a cancelar');
checar(cancel.doAtendimentoDeAgora({ id: 200, status: 'paid', created_at: horas(0.2) }),
  'pedido de minutos atrás é o de agora');
checar(cancel.doAtendimentoDeAgora({ id: 201, status: 'printed', created_at: horas(5) }),
  'pedido de 5 horas atrás ainda conta (mesma noite)');
checar(!cancel.doAtendimentoDeAgora({ id: 55, status: 'printed', created_at: horas(24 * 7) }),
  'pedido da semana passada (o #55) não conta mais');
checar(!cancel.doAtendimentoDeAgora({ id: 56, status: 'paid', created_at: horas(20) }),
  'pedido de ontem também não');
checar(cancel.doAtendimentoDeAgora({ id: 57, status: 'pending', created_at: 'data estranha' }),
  'data ilegível não some com o pedido: vale como de agora');

console.log('\n\x1b[32mcancelarantigotest: tudo passou.\x1b[0m');
