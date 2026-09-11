const log = require('../log');
const db = require('../db/queries');
const notify = require('../bot/notify');
const schedule = require('./schedule');
const caixa = require('./caixa');
const { paraAdmin } = require('../texto');

/**
 * Quando o dia fecha, os admins recebem o caixa do Zelle.
 *
 * Com a comanda saindo no comprovante, o fim do dia é a hora de conferir o
 * banco de uma vez: o resumo mostra o que foi conferido, o que falta — pedido
 * por pedido — e o `!liberar todos` pronto.
 *
 * "Fechou" é a passagem de aberto para fechado, pelo horário ou pelo
 * `!fechar`. O período é o das últimas 24 horas, que num dia de expediente é o
 * expediente inteiro — inclusive quando ele termina à meia-noite, onde "hoje"
 * pelo calendário já seria o dia seguinte.
 *
 * O que ficou sem conferir **não é cobrado no dia seguinte**: decisão do dono,
 * o dia que passou está encerrado.
 */

const INTERVALO_MS = 60 * 1000;
const JANELA_MS = 24 * 60 * 60 * 1000;

let timer = null;

// `null` até a primeira volta: o encerramento manual (`!fechar`) é lido do
// banco logo depois do boot, e decidir antes disso trataria um restart com a
// loja fechada à mão como um fechamento novo.
let estavaAberto = null;

async function enviarResumo(agora = new Date()) {
  const admins = notify.admins();
  if (!admins.length) return false;

  const de = new Date(agora.getTime() - JANELA_MS).toISOString();
  const resumo = caixa.classificar(await db.getPagamentosDoPeriodo(de, agora.toISOString()));
  if (!caixa.temZelle(resumo)) return false;

  const texto = paraAdmin(caixa.mensagemFechamento(resumo));
  for (const admin of admins) await notify.send(admin, texto);

  log.info(
    { evt: 'caixa', conferidos: resumo.conferido.qtd, aConferir: resumo.aConferir.qtd },
    'caixa do Zelle enviado no fechamento'
  );
  return true;
}

/** Uma volta do vigia: manda o resumo só na passagem de aberto para fechado. */
async function verificar(agora = new Date()) {
  const aberto = schedule.isOpen();
  const fechou = estavaAberto === true && !aberto;
  estavaAberto = aberto;
  if (!fechou) return false;
  return enviarResumo(agora);
}

function start() {
  if (timer) return;

  timer = setInterval(() => {
    verificar().catch((err) =>
      log.error({ evt: 'caixa', err }, 'falha ao montar o caixa do fechamento')
    );
  }, INTERVALO_MS);
  timer.unref();

  log.info({ evt: 'boot' }, 'caixa do Zelle ativo — resumo aos admins quando o dia fechar');
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  estavaAberto = null;
}

module.exports = { verificar, enviarResumo, start, stop };
