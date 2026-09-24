/**
 * Papel avulso que falha segue a regra da comanda (23/09: o "atendimento
 * encerrado" voltava a cada 20 s por meia hora com a impressora fora).
 */
const PROJECT = require('path').resolve(__dirname, '..');
const printqueue = require(`${PROJECT}/src/services/printqueue`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

printqueue.limpar();
const token = printqueue.enfileirar({ gerar: () => 'x', descricao: 'teste' });

function falhar() {
  const r = printqueue.reservar('android_1', 'h');
  if (!r) return null;
  return printqueue.liberarReserva(token, 'android_1', 'h');
}

// Três falhas: volta na hora, como sempre.
for (let i = 1; i <= 3; i += 1) {
  const r = falhar();
  checar(r && r.falhas === i && r.esperaSegundos === 0 && printqueue.proximo()?.token === token,
    `falha ${i}: volta para a fila na hora`);
}

// Quarta: espera 30 s, e ninguém pega nesse meio tempo.
const quarta = falhar();
checar(quarta.esperaSegundos === 30, 'falha 4: espera 30 s');
checar(printqueue.proximo() === null && printqueue.reservar('android_1', 'h') === null,
  '   durante a espera o Android não recebe a página');
checar(printqueue.tamanho() === 1, '   e a página não sai da fila');

// A impressora voltou (outra coisa imprimiu): libera na hora.
printqueue.liberarAdiados();
checar(printqueue.proximo()?.token === token, 'impressora voltou: a página tenta já');

// Reserva de verdade (com dono) não é mexida pelo liberarAdiados.
printqueue.reservar('android_1', 'h2');
printqueue.liberarAdiados();
checar(printqueue.proximo() === null, 'reserva em andamento continua reservada');
checar(printqueue.concluirReserva(token, 'android_1', 'h2') && printqueue.tamanho() === 0,
  'impressa, sai da fila');

console.log('\n\x1b[32mavulsoesperatest: tudo passou.\x1b[0m');
