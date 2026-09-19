/**
 * Comanda que falha na impressora não trava a fila (18/09: a #162 falhando
 * a cada 20 s segurou a #163). Até a 3ª falha volta na hora; depois espera,
 * sempre tentando de novo; na 5ª avisa o dono; uma impressa libera as adiadas.
 */
process.env.LOG_LEVEL = 'silent';
const path = require('path');
const express = require('express');

const PROJECT = path.resolve(__dirname, '..');
const chamadas = [];
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  authenticatePrinterDevice: async () => ({ id: 'android_teste', name: 'Loja' }),
  releaseClaimedPrint: async (id) => { chamadas.push(['libera', id]); return { id }; },
  adiarImpressao: async (id, _d, _h, s) => { chamadas.push(['adia', id, s]); return { id }; },
  completeClaimedPrint: async (id) => { chamadas.push(['impressa', id]); return { id, status: 'printed' }; },
  liberarImpressoesAdiadas: async () => { chamadas.push(['libera_adiadas']); return 1; },
};
const avisos = [];
const notifyPath = require.resolve(`${PROJECT}/src/bot/notify`);
require.cache[notifyPath] = { id: notifyPath, filename: notifyPath, loaded: true,
  exports: { admins: () => ['16170000000', '17810000000'], send: async (tel, texto) => { avisos.push([tel, texto]); } } };

const printretry = require(`${PROJECT}/src/services/printretry`);
const router = require(`${PROJECT}/src/api/printer-agent`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  checar([1, 2, 3].every((n) => printretry.esperaSegundos(n) === 0), 'até a 3ª falha volta na hora');
  checar(printretry.esperaSegundos(4) === 30 && printretry.esperaSegundos(5) === 60 &&
    printretry.esperaSegundos(6) === 120 && printretry.esperaSegundos(9) === 300, 'depois 30 s, 60 s, 120 s… até 5 min');

  const app = express();
  app.use(router);
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/printer-agent`;
  const lease = 'L'.repeat(40);
  const post = (rota, jobId) => fetch(`${base}/${rota}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${'t'.repeat(43)}` },
    body: JSON.stringify({ jobId: String(jobId), leaseToken: lease }),
  });
  try {
    for (let i = 1; i <= 6; i++) checar((await post('fail', 162)).status === 200, `falha ${i} da #162 aceita`);
    const da162 = chamadas.filter((c) => c[1] === 162);
    checar(da162.slice(0, 3).every((c) => c[0] === 'libera'), 'as 3 primeiras voltam para a fila na hora (como antes)');
    checar(da162[3][0] === 'adia' && da162[3][2] === 30 && da162[5][2] === 120, 'da 4ª em diante espera, sem abandonar');
    await new Promise((r) => setImmediate(r));
    checar(avisos.length === 2 && avisos.every(([, t]) => /#162 NAO IMPRIME/.test(t)),
      'na 5ª falha avisa os admins, uma vez só (a 6ª não repete)');

    chamadas.length = 0;
    checar((await post('complete', 163)).status === 200, '#163 impressa');
    await new Promise((r) => setImmediate(r));
    checar(chamadas.some((c) => c[0] === 'libera_adiadas'), 'uma impressa libera as adiadas para tentar já');

    chamadas.length = 0;
    await post('complete', 162);
    await post('fail', 162);
    checar(chamadas.at(-1)[0] === 'libera', 'depois de imprimir, a contagem da comanda zera');
  } finally {
    srv.close();
  }
  console.log('\n\x1b[32mprintretrytest: tudo passou.\x1b[0m');
})().catch((e) => { console.error(e); process.exit(1); });
