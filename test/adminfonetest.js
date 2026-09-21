/**
 * Número de admin sem o código do país não pode calar os avisos.
 *
 * 20/09: `ADMIN_PHONE` começava com "7815022706" (faltava o 1). Todo aviso que
 * vai só para o dono — cancelamento de pedido pelo cliente, teto de gasto —
 * saía para um número inexistente: 58 falhas seguidas no log, nada no celular,
 * e o dono só descobriu porque o cliente avisou.
 */
process.env.DATABASE_URL = 'postgresql://fake';

const PROJECT = require('path').resolve(__dirname, '..');
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({}, { get: () => async () => null });

const notify = require(`${PROJECT}/src/bot/notify`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

process.env.ADMIN_PHONE = '7815022706,16178667738';
checar(notify.dono() === '17815022706', 'o 1 é completado no número de 10 dígitos que recebe os avisos');
checar(notify.admins().join(',') === '17815022706,16178667738', 'os já completos não são alterados');

process.env.ADMIN_PHONE = '+1 (617) 866-7738, 1 781 502 2706';
checar(notify.admins().join(',') === '16178667738,17815022706', 'pontuação e espaços saem, o número fica igual');

process.env.ADMIN_PHONE = '5531988887777';
checar(notify.dono() === '5531988887777', 'número de outro país passa sem mexer');

process.env.ADMIN_PHONE = '';
checar(notify.dono() === '' && notify.admins().length === 0, 'sem admin configurado, lista vazia');

console.log('\n\x1b[32madminfonetest: tudo passou.\x1b[0m');
