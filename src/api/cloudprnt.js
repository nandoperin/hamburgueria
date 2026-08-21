const express = require('express');
const crypto = require('crypto');

const log = require('../log');
const db = require('../db/queries');
const {
  buildTicketWithCopies,
  buildTestPage,
  mediaType,
} = require('../services/printer');

/**
 * Impressão de teste sob demanda, fora da fila de pedidos.
 *
 * O `!testeimpressao` do admin marca isto, a impressora pega no próximo
 * polling e o token `teste` distingue do id numérico de um pedido. Existe para
 * verificar fonte e papel sem gastar um pedido de verdade — as duas tentativas
 * anteriores de ampliar a fonte foram testadas em pedido real, e uma delas
 * saiu confirmada sem nunca ter impresso.
 */
const TOKEN_TESTE = 'teste';
let testePendente = false;

function pedirTeste() {
  testePendente = true;
}

function testeNaFila() {
  return testePendente;
}
const printwatch = require('../services/printwatch');
const printqueue = require('../services/printqueue');

const router = express.Router();

/**
 * Protocolo CloudPRNT da Star Micronics.
 *
 *   POST   /cloudprnt  → a impressora pergunta se há trabalho
 *   GET    /cloudprnt  → busca o conteúdo a imprimir
 *   DELETE /cloudprnt  → confirma que imprimiu
 *
 * O jobToken é o id do pedido, então o DELETE sabe qual marcar como impresso.
 */

/**
 * Autenticação da impressora. Usa `authToken` (não `token`) porque o
 * protocolo já reserva `token` para o jobToken nas chamadas GET/DELETE.
 *
 * ## O que este token guarda
 *
 * O GET devolve a comanda inteira: nome, endereço, telefone do cliente e a
 * confirmação de quem liberou o pagamento. O DELETE marca como impresso —
 * quem chamar antes da impressora faz a comanda **nunca sair**, e a cozinha
 * descobre pelo cliente ligando.
 *
 * ## Por que a falta do token agora fecha
 *
 * Pelo mesmo motivo do webhook da Meta: sem o token configurado, a versão
 * anterior liberava tudo para quem alcançasse a `BASE_URL`, que é pública por
 * necessidade — a impressora precisa chegar nela pela internet. Sem token não
 * há como distinguir a impressora de qualquer outro. O 503 diz a verdade: o
 * serviço não está em condição de responder.
 */
function iguais(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function checkToken(req, res) {
  const expected = process.env.CLOUDPRNT_TOKEN;
  if (!expected) {
    if (require('../ambiente').exigeSegredos()) {
      log.error(
        { evt: 'impressao' },
        'CLOUDPRNT_TOKEN ausente — impressao recusada por seguranca'
      );
      res.status(503).json({ jobReady: false });
      return false;
    }
    return true; // desenvolvimento declarado: segue sem exigir
  }

  const provided = req.query.authToken || req.headers['x-cloudprnt-token'];
  if (!iguais(provided, expected)) {
    res.status(401).json({ jobReady: false });
    return false;
  }
  return true;
}

/**
 * Formatos oferecidos à impressora, em ordem de preferência.
 *
 * O CloudPRNT foi desenhado para o servidor oferecer uma **lista** e a
 * impressora escolher o que sabe imprimir, pedindo aquele no GET. Vínhamos
 * oferecendo um só — e quando esse um foi `text/vnd.star.markup`, ela não teve
 * alternativa: pegou o trabalho, não soube renderizar e confirmou assim mesmo.
 *
 * Agora ela escolhe, e o GET registra a escolha. Enquanto não soubermos o que
 * ela de fato aceita, o conteúdo servido continua sendo texto puro — ASCII
 * imprime igual em qualquer um desses modos, então oferecer não arrisca nada.
 */
function mediaTypesOferecidos() {
  // A ordem importa: a impressora pega o primeiro da lista que reconhece.
  // Por isso os nativos vêm antes e `text/plain` fica por último — se ela ainda
  // assim escolher texto puro, é porque os outros ela não sabe, e aí a resposta
  // é definitiva. Deixar texto puro no topo tornaria o teste inútil.
  return [
    'application/vnd.star.starprnt',
    'application/vnd.star.line',
    'text/plain',
  ];
}

/**
 * Identifica a impressora uma vez por processo.
 *
 * Nasceu registrando o corpo inteiro do polling, para descobrir que formato ela
 * suportava — foi assim que chegamos ao StarPRNT. Só que o corpo carrega
 * `printingInProgress` e `jobToken`, que mudam a cada impressão, então a
 * deduplicação por conteúdo disparava várias linhas por pedido e enterrava os
 * avisos que importam.
 *
 * Ficou só modelo e MAC: muda quando a impressora é trocada, que é a única vez
 * em que isso interessa.
 */
let impressoraConhecida = null;

function registrarPerfil(req) {
  try {
    const identidade = `${req.headers['user-agent'] || '?'} · ${req.body?.printerMAC || 'sem MAC'}`;
    if (identidade === impressoraConhecida) return;

    impressoraConhecida = identidade;
    log.info(
      { evt: 'impressao', modelo: req.headers['user-agent'], mac: req.body?.printerMAC },
      `impressora identificada: ${identidade}`
    );
  } catch {
    // Diagnóstico não pode derrubar o polling.
  }
}

let ultimoTipoPedido = null;

// O corpo do polling é um punhado de campos de estado da impressora. 64kb já é
// generoso, e sem teto explícito o padrão do Express (100kb) valeria por acaso.
router.post('/cloudprnt', express.json({ limit: '64kb' }), async (req, res) => {
  if (!checkToken(req, res)) return;

  // Só o polling autenticado conta como sinal de vida — token errado pode ser
  // qualquer coisa batendo na URL, não a nossa impressora.
  printwatch.registrarPolling();
  registrarPerfil(req);

  try {
    // O teste fura a fila: quem pediu está de pé na frente da impressora.
    if (testePendente) {
      return res.json({
        jobReady: true,
        mediaTypes: mediaTypesOferecidos(),
        jobToken: TOKEN_TESTE,
      });
    }

    // Pedido antes de avulso: comida esfria, papel não. O teste continua
    // furando os dois porque quem pediu está de pé na frente da impressora.
    const order = await db.getNextPrintableOrder();

    if (!order) {
      const avulso = printqueue.proximo();
      if (!avulso) return res.json({ jobReady: false });

      return res.json({
        jobReady: true,
        mediaTypes: mediaTypesOferecidos(),
        jobToken: avulso.token,
      });
    }

    // Debug, não info: enquanto a impressora estiver fora do ar o mesmo pedido
    // é oferecido a cada 5 segundos, e isso encheria o log de repetição. Quem
    // avisa que a comanda não saiu é o printwatch, uma vez por pedido.
    log.debug({ evt: 'impressao', pedido: order.id }, 'comanda oferecida à impressora');

    res.json({
      jobReady: true,
      mediaTypes: mediaTypesOferecidos(),
      jobToken: String(order.id),
    });
  } catch (err) {
    log.error({ evt: 'erro', err }, 'falha no polling do CloudPRNT');
    res.json({ jobReady: false });
  }
});

router.get('/cloudprnt', async (req, res) => {
  if (!checkToken(req, res)) return;

  try {
    const jobToken = String(req.query.token || req.query.jobToken || '');

    const escolhido = req.query.type || req.headers.accept || '(não informado)';
    if (escolhido !== ultimoTipoPedido) {
      ultimoTipoPedido = escolhido;
      log.info(
        { evt: 'impressao', formato: escolhido },
        `impressora escolheu o formato ${escolhido}`
      );
    }

    // A página de teste sempre sai em StarPRNT: o objetivo dela é justamente
    // provar se a impressora obedece aos comandos de ampliação.
    if (jobToken === TOKEN_TESTE) {
      res.type('application/vnd.star.starprnt');
      return res.send(buildTestPage());
    }

    if (printqueue.ehAvulso(jobToken)) {
      const avulso = printqueue.porToken(jobToken);
      // Some da fila entre o POST e o GET só se outra coisa a esvaziou; nesse
      // caso 404 é honesto — a impressora tenta o próximo no polling seguinte.
      if (!avulso) return res.status(404).send('');

      log.info(
        { evt: 'impressao', token: jobToken, descricao: avulso.descricao },
        `"${avulso.descricao}" entregue à impressora`
      );

      res.type(`${mediaType()}; charset=utf-8`);
      return res.send(avulso.conteudo);
    }

    const order = /^\d+$/.test(jobToken)
      ? await db.getOrder(Number(jobToken))
      : await db.getNextPrintableOrder();

    if (!order) {
      return res.status(404).send('');
    }

    // A comanda leva quem liberou o pagamento — com Zelle, é o único rastro
    // de que uma pessoa conferiu o comprovante antes de a comida sair.
    const payment = await db.getPaymentByOrderId(order.id);

    log.info({ evt: 'impressao', pedido: order.id }, `comanda #${order.id} entregue`);

    res.type(`${mediaType()}; charset=utf-8`);
    res.send(buildTicketWithCopies(order, payment));
  } catch (err) {
    log.error({ evt: 'erro', err }, 'falha ao gerar comanda');
    res.status(500).send('');
  }
});

router.delete('/cloudprnt', async (req, res) => {
  if (!checkToken(req, res)) return;

  try {
    const jobToken = String(req.query.token || req.query.jobToken || '');

    if (jobToken === TOKEN_TESTE) {
      testePendente = false;
      log.info({ evt: 'impressao', tipo: 'teste' }, 'página de teste impressa');
    } else if (printqueue.ehAvulso(jobToken)) {
      const feito = printqueue.confirmar(jobToken);
      if (feito) {
        log.info(
          { evt: 'impressao', token: jobToken, descricao: feito.descricao },
          `"${feito.descricao}" impresso`
        );
      }
    } else if (/^\d+$/.test(jobToken)) {
      await db.markOrderPrinted(Number(jobToken));
      log.info(
        { evt: 'impressao', pedido: Number(jobToken) },
        `pedido #${jobToken} impresso`
      );
    }

    res.json({ ok: true });
  } catch (err) {
    log.error({ evt: 'erro', err }, 'falha ao confirmar impressão');
    res.status(500).json({ ok: false });
  }
});

module.exports = router;
module.exports.pedirTeste = pedirTeste;
module.exports.testeNaFila = testeNaFila;
