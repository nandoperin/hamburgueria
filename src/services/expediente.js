const schedule = require('./schedule');

/**
 * As vigias de impressão e de pagamento precisam rodar agora?
 *
 * Elas consultam o banco a cada minuto. Com a loja fechada o dia inteiro, isso
 * eram quase 2.900 consultas por dia sem pedido nenhum para vigiar (dono,
 * 24/09: cuidado com o banco).
 *
 * Não param no minuto em que fecha: o último pedido da noite ainda pode estar
 * sem imprimir, sem comprovante ou para expirar (30 min). A folga de 2 horas
 * cobre todos esses prazos com sobra.
 *
 * O boot conta como "acabou de abrir": um deploy de madrugada vigia as 2 horas
 * seguintes, porque não há como saber se ficou algum pedido do fechamento.
 */
const FOLGA_MS = 2 * 60 * 60 * 1000;

let ultimaVezAberto = Date.now();

function deveVigiar(agora = Date.now()) {
  if (schedule.isOpen()) {
    ultimaVezAberto = agora;
    return true;
  }
  return agora - ultimaVezAberto < FOLGA_MS;
}

module.exports = { deveVigiar, FOLGA_MS };
