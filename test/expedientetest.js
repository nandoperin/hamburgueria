/**
 * Vigias de impressão e pagamento param com a loja fechada há mais de 2 h
 * (dono, 24/09: cuidado com o banco).
 */
const PROJECT = require('path').resolve(__dirname, '..');
const schedule = require(`${PROJECT}/src/services/schedule`);
let aberta = true;
schedule.isOpen = () => aberta;

const { deveVigiar, FOLGA_MS } = require(`${PROJECT}/src/services/expediente`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const HORA = 60 * 60 * 1000;
const t0 = Date.now();

// Boot com a loja fechada: vigia as 2 h seguintes (pode ter sobrado pedido).
aberta = false;
checar(deveVigiar(t0 + HORA), 'boot com a loja fechada: vigia na primeira hora');
checar(!deveVigiar(t0 + FOLGA_MS + 1000), 'boot com a loja fechada: para depois de 2 h');

// Aberta: vigia sempre.
aberta = true;
checar(deveVigiar(t0 + 10 * HORA), 'loja aberta: vigia');

// Fechou às 10h (relógio do teste): segue 2 h, depois para.
aberta = false;
checar(deveVigiar(t0 + 10 * HORA + 30 * 60 * 1000), 'fechou há 30 min: ainda vigia');
checar(deveVigiar(t0 + 11.9 * HORA), 'fechou há 1h54: ainda vigia');
checar(!deveVigiar(t0 + 12.1 * HORA), 'fechou há mais de 2 h: para de consultar o banco');

// Reabriu: volta na hora.
aberta = true;
checar(deveVigiar(t0 + 30 * HORA), 'reabriu: volta a vigiar');

console.log('\n\x1b[32mexpedientetest: tudo passou.\x1b[0m');
