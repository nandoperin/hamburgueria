const { t } = require('../../i18n');
const log = require('../../log');
const db = require('../../db/queries');
const pagamento = require('../../services/pagamento');
const notify = require('../notify');

/**
 * Cancelamento de pedido com estorno.
 *
 * **Pago é definitivo para o cliente.** Confirmado o pagamento, a comanda sai e
 * a cozinha começa; deixar o cliente desfazer isso sozinho, mesmo um minuto
 * depois, é abrir a porta para prejuízo. Estorno é decisão do dono, sempre.
 *
 * O que o cliente cancela é o **fluxo**: o carrinho em montagem, ou um pedido
 * cujo link foi gerado e nunca pago — nesses casos não há dinheiro envolvido.
 *
 *   pending   — link gerado, não pago  → cancela, nada a estornar
 *   paid      — pago                   → recusa, avisa o dono
 *   printed   — cozinha já recebeu     → recusa, avisa o dono
 *   cancelled — nada a fazer
 */

function money(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function adminPhone() {
  return (process.env.ADMIN_PHONE || '').replace(/\D/g, '');
}

/** Avisa o dono. Falha aqui não impede o cancelamento em si. */
async function avisarAdmin(texto) {
  const phone = adminPhone();
  if (!phone) {
    log.warn({ evt: 'cancelamento' }, 'ADMIN_PHONE não configurado — aviso não enviado');
    return;
  }
  await notify.send(phone, require('../../texto').paraAdmin(texto));
}

/**
 * Estorna (ou marca para estorno manual) e marca o pedido como cancelado.
 *
 * O estorno vem primeiro de propósito: se ele falhar, o pedido continua ativo
 * e o dono é avisado. O contrário deixaria o cliente sem comida e sem dinheiro.
 *
 * Com Zelle o estorno é manual (não há API): `pagamento.estornar` não move
 * dinheiro, só devolve se o dono precisa devolver à mão. Com Square, a mesma
 * chamada faz o refund de verdade. `cancel.js` não distingue os dois.
 */
async function cancelarComEstorno(order, motivo) {
  const payment = await db.getPaymentByOrderId(order.id);

  const { estornou, manual } = await pagamento.estornar({
    order,
    payment,
    motivo,
  });

  await db.updateOrderStatus(order.id, 'cancelled');

  // `estornou`: o dinheiro voltou por API agora. `manual`: o dono precisa
  // devolver pelo banco (caso Zelle com pagamento já confirmado).
  return { estornou, manual, payment };
}

// ------------------------------------------------------------ pelo cliente

/**
 * Cliente pediu para cancelar. Chamado pelo router quando há pedido em aberto.
 */
async function handleCustomerCancel(session, send) {
  const order = await db.getActiveOrderByPhone(session.phone);

  // O idioma vem do pedido, não da sessão: quem cancela costuma voltar horas
  // depois, com a sessão já expirada e o idioma perdido.
  const lang = order?.lang || session.lang || 'pt';

  if (!order) {
    await send(t(lang, 'cancel_no_order'));
    return;
  }

  // Pago é definitivo: só o dono estorna.
  if (order.status === 'paid' || order.status === 'printed') {
    await send(t(lang, 'cancel_paid_order', { order_id: order.id }));

    await avisarAdmin(
      `⚠️ *Cliente quer cancelar*\n\n` +
        `Pedido *#${order.id}* — ${money(order.total)}\n` +
        `${order.customer_name || 'sem nome'} · +${order.phone}\n` +
        (order.status === 'printed'
          ? 'A comanda já foi impressa.'
          : 'Pago, comanda ainda na fila.') +
        `\n\nPara estornar: *!cancelar ${order.id}* (mostra o pedido e pede confirmação)\n` +
        `Para ver: *!pedido ${order.id}*`
    );
    return;
  }

  // Só resta `pending`: link gerado e nunca pago, sem dinheiro envolvido.
  try {
    await cancelarComEstorno(order, 'Cancelado pelo cliente antes do pagamento');
    await send(t(lang, 'cancel_done', { order_id: order.id }));
  } catch (err) {
    log.error({ evt: 'cancelamento', pedido: order.id, err }, 'falha ao cancelar pedido');
    await send(t(lang, 'cancel_error'));
    await avisarAdmin(
      `❌ *Falha ao cancelar #${order.id}*\n\n${err.message}`
    );
  }
}

// -------------------------------------------------------------- pelo dono

/**
 * Manda o cancelamento ao papel — sempre, e não só quando a comanda já saiu.
 *
 * Quando **já saiu**, o leitor é a cozinha: alguém está montando o espeto agora,
 * e mensagem no WhatsApp do dono não alcança quem está na chapa.
 *
 * Quando **não saiu**, o leitor é o dono, e o motivo é outro. Estornar é a única
 * ação sem desfazer deste sistema, e até aqui um pedido pago e ainda não
 * impresso podia ser cancelado sem deixar um único rastro em papel. O papel vale
 * porque é o canal que um invasor não controla: quem tomasse o WhatsApp do dono
 * receberia os avisos dele, mas para adulterar o que já saiu na impressora
 * teria que estar dentro do truck.
 *
 * Melhor esforço: se a impressora estiver fora, o cancelamento continua válido —
 * o dinheiro já foi estornado, e falhar aqui não pode desfazer aquilo.
 */
async function registrarNoPapel(order, { phone, naCozinha }) {
  try {
    const printer = require('../../services/printer');
    const printqueue = require('../../services/printqueue');

    printqueue.enfileirar({
      conteudo: printer.buildCancelamento(order, { phone, naCozinha }),
      descricao: `cancelamento do #${order.id}`,
    });
  } catch (err) {
    log.error(
      { evt: 'impressao', pedido: order.id, err },
      'falha ao enfileirar o aviso de cancelamento'
    );
  }
}

// ------------------------------------------------- confirmação em duas etapas
//
// Estornar é a única coisa que este sistema faz sem desfazer. `!fechar` tem
// `!abrir`, `!esgotou` tem `!voltou`; dinheiro que voltou ao cliente só volta
// para cá pedindo a ele.
//
// E o risco não é ataque, é dedo: no teclado do celular, no meio do movimento,
// `!cancelar 23` em vez de `!cancelar 32` estorna o pedido de outro cliente. Por
// isso o primeiro comando **mostra** o pedido e o segundo executa — o que a
// confirmação compra não é o "ok", é o dono ter lido o nome e o valor antes.
//
// Repetir o número no `ok` é de propósito: para o erro passar, teria que se
// repetir igual, depois de o resumo do pedido errado já estar na tela.

const CONFIRMACAO_MS = 2 * 60 * 1000;

/** orderId → instante em que o resumo foi mostrado. */
const aguardando = new Map();

function registrarPendente(orderId) {
  const agora = Date.now();
  for (const [id, em] of aguardando) {
    if (agora - em > CONFIRMACAO_MS) aguardando.delete(id);
  }
  aguardando.set(orderId, agora);
}

/** Devolve true e consome — uma confirmação não serve duas vezes. */
function consumirPendente(orderId) {
  const em = aguardando.get(orderId);
  aguardando.delete(orderId);
  return Boolean(em) && Date.now() - em <= CONFIRMACAO_MS;
}

/**
 * O resumo que o dono lê antes de decidir.
 *
 * Usa o mesmo `resumoPedido` de `!pedido` e `!ultimos` para o pedido ter sempre
 * a mesma cara — reconhecer o formato é metade de conferir se é o certo. O
 * `require` é preguiçoso porque `admin.js` carrega este módulo.
 */
function pedirConfirmacao(order, payment) {
  const { resumoPedido } = require('./admin');
  // Pagamento confirmado (o dono já liberou com !liberar) significa que o
  // dinheiro chegou. Com Zelle a devolução é manual, então a confirmação avisa
  // que o dono terá de estornar pelo banco — não que o sistema faz isso.
  const recebido = payment?.status === 'paid';
  const automatico = pagamento.estornoAutomatico();

  let linhaValor;
  if (!recebido) {
    linhaValor = `Não há pagamento a estornar — só marca o pedido como cancelado.`;
  } else if (automatico) {
    linhaValor = `Isto devolve *${money(order.total)}* ao cliente.\nNão tem desfazer.`;
  } else {
    linhaValor =
      `O cliente já pagou *${money(order.total)}*.\n` +
      `⚠️ O estorno do Zelle é *manual*: você terá de devolver pelo app do banco.`;
  }

  return (
    `⚠️ *CONFIRME O CANCELAMENTO*\n\n` +
    `${resumoPedido(order)}\n\n` +
    linhaValor +
    `\n\nConfirme: *!cancelar ${order.id} ok*\n` +
    `_Vale por 2 minutos._`
  );
}

/**
 * Comando de admin: `!cancelar 12` mostra, `!cancelar 12 ok` executa.
 *
 * Funciona em qualquer estado do pedido.
 */
async function handleAdminCancel(orderId, send, confirmado = false, phone = null) {
  const order = await db.getOrder(orderId);

  if (!order) {
    await send(`❌ Pedido #${orderId} não encontrado.`);
    return;
  }
  if (order.status === 'cancelled') {
    await send(`ℹ️ Pedido #${orderId} já estava cancelado.`);
    return;
  }

  if (!confirmado) {
    registrarPendente(orderId);
    await send(pedirConfirmacao(order, await db.getPaymentByOrderId(orderId)));
    return;
  }

  // Chegou o "ok" sem o resumo ter sido visto, ou tarde demais. Recusar aqui é
  // o que impede o atalho de decorar a frase e pular justamente a parte que
  // protege — ver o pedido.
  if (!consumirPendente(orderId)) {
    await send(
      `⏳ Não há confirmação em aberto para o *#${orderId}* — ela expirou, ou ` +
        `o resumo não chegou a ser pedido.\n\n` +
        `Comece por *!cancelar ${orderId}* e confira o pedido antes de estornar.`
    );
    return;
  }

  // Guardado antes: `cancelarComEstorno` troca o status para `cancelled`, e
  // depois não dá mais para saber se a cozinha chegou a receber a comanda.
  const jaEstavaNaCozinha = order.status === 'printed';

  try {
    const { estornou, manual } = await cancelarComEstorno(order, 'Cancelado pelo estabelecimento');

    await registrarNoPapel(order, { phone, naCozinha: jaEstavaNaCozinha });

    let linhaEstorno;
    if (estornou) {
      linhaEstorno = '✅ Estorno enviado ao cliente.';
    } else if (manual) {
      linhaEstorno = `⚠️ Estorne *${money(order.total)}* ao cliente pelo app do banco — o Zelle não devolve sozinho.`;
    } else {
      linhaEstorno = 'Não havia pagamento a estornar.';
    }

    await send(
      `🚫 *Pedido #${order.id} cancelado*\n\n` +
        `${money(order.total)} — ${order.customer_name || 'sem nome'}\n` +
        linhaEstorno +
        (jaEstavaNaCozinha
          ? '\n🖨️ A comanda já tinha saído — aviso de cancelamento indo para a impressora.'
          : '\n🖨️ Comprovante indo para a impressora.')
    );

    // Avisa o cliente no idioma dele. Só promete estorno quando ele de fato
    // pagou — e isso é o que `cancelarComEstorno` devolve (estornou por API, ou
    // manual pelo banco). Ler `order.status` aqui não serve: ele já virou
    // 'cancelled' na linha acima.
    const paid = estornou || manual;
    await notify.send(
      order.phone,
      paid
        ? t(order.lang || 'pt', 'cancel_by_store', {
            order_id: order.id,
            total: Number(order.total).toFixed(2),
          })
        : t(order.lang || 'pt', 'cancel_done', { order_id: order.id })
    );
  } catch (err) {
    log.error(
      { evt: 'cancelamento', pedido: orderId, err },
      'falha ao cancelar pedido pelo admin'
    );
    await send(`❌ Falha ao cancelar #${orderId}: ${err.message}`);
  }
}

module.exports = {
  handleCustomerCancel,
  handleAdminCancel,
  cancelarComEstorno,
  CONFIRMACAO_MS,
};
