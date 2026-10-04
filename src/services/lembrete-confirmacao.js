const log = require('../log');
const session = require('../bot/session');
const notify = require('../bot/notify');
const schedule = require('./schedule');
const atendimento = require('./atendimento');
const { t } = require('../i18n');

/**
 * Lembrete de confirmação (dono, 03/10): o cliente apressado recebe o resumo,
 * não responde o "Sim (s) ou Não (n)" e o pedido fica parado.
 *
 * Só na etapa do resumo (`CONFIRM`), depois de 10 minutos sem resposta, UMA
 * vez por conversa. Não muda nada no fluxo: só manda a mensagem. O que o
 * cliente responder depois — sim, não, uma pergunta, outro item — segue o
 * caminho de sempre.
 *
 * Não precisa de banco: o pedido ainda não confirmado mora na conversa em
 * memória, com a hora da última mensagem. Fica de fora quem está com o
 * atendente humano, e nada sai com a loja fechada.
 */

const ESPERA_MS = 10 * 60 * 1000;
const INTERVALO_MS = 60 * 1000;

let timer = null;

/** Uma volta: quem está parado no resumo há 10 minutos e ainda não foi lembrado. */
async function verificar(agora = Date.now()) {
  if (!schedule.isOpen()) return [];
  const lembrados = [];
  for (const sess of session.abertas()) {
    if (sess.state !== 'CONFIRM' || sess.lembreteConfirmacao) continue;
    if (agora - sess.lastActivity < ESPERA_MS) continue;
    if (atendimento.aberto(sess.phone)) continue;

    // Marca antes de enviar: se o envio demorar, a próxima volta não repete.
    sess.lembreteConfirmacao = true;
    try {
      await notify.send(sess.phone, t(sess.lang || 'pt', 'lembrete_confirmar'));
      lembrados.push(sess.phone);
      log.info({ evt: 'lembrete', phone: sess.phone }, 'lembrete de confirmação enviado');
    } catch (err) {
      log.warn({ evt: 'lembrete', phone: sess.phone, err }, 'falha ao enviar lembrete de confirmação');
    }
  }
  return lembrados;
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    verificar().catch((err) => log.error({ evt: 'lembrete', err }, 'falha no lembrete de confirmação'));
  }, INTERVALO_MS);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { verificar, start, stop, ESPERA_MS };
