const express = require('express');

const log = require('../log');
const db = require('../db/queries');
const schedule = require('../services/schedule');
const pedidoweb = require('../services/pedidoweb');
const { prazoPedido } = require('../i18n');

/**
 * A porta do site: o cardápio para a página desenhar, e a criação do pedido.
 *
 * Mesmo desenho do food truck (`projeto atendimento/src/api/pedir.js`): a
 * página mora no site (pointburgerjg.com, HTML estático) e chama esta API. A
 * criação do pedido fica aqui, onde estão o banco e a fila da impressora.
 *
 * Decisão do dono (09/10/2026): o pedido do site **imprime direto**, sem
 * confirmação no WhatsApp. Grava como o bot grava — `createOrder` +
 * `createZellePayment`/`createCashPayment` —, e daí em diante é o caminho de
 * sempre: comanda, comprovante do Zelle pelo WhatsApp, `!liberar`, painel.
 *
 * Nenhum arquivo do fluxo do bot foi alterado para isto: esta rota só lê o
 * cardápio e usa a mesma função de montar linha do carrinho.
 *
 * ## Desligado por padrão
 *
 * Sem `PEDIR_ATIVO`, as rotas respondem 404 — como se não existissem. Liga e
 * desliga sem deploy: se a página der problema numa noite de movimento, o
 * WhatsApp continua lá.
 */

const router = express.Router();

/** Origens que podem chamar a API pelo navegador. */
function origens() {
  return (process.env.PEDIR_ORIGENS || 'https://pointburgerjg.com,https://www.pointburgerjg.com')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function ativo() {
  return /^(1|true|sim|on)$/i.test(process.env.PEDIR_ATIVO || '');
}

/** Número da loja no WhatsApp, para o link do comprovante na página. */
function whatsappDaLoja() {
  const link = require('../bot/notify').catalogLink();
  const doLink = link ? link.replace(/\D/g, '') : '';
  return doLink || String(process.env.PEDIR_WHATSAPP || '').replace(/\D/g, '') || null;
}

// ------------------------------------------------------------------- portão

router.use('/pedir', (req, res, next) => {
  if (!ativo()) return res.status(404).end();

  const origem = req.headers.origin;
  if (origem && origens().includes(origem)) {
    res.set('Access-Control-Allow-Origin', origem);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();

  res.set('Cache-Control', 'no-store');
  return next();
});

// ------------------------------------------------------------------- vazão

/**
 * Tetos por IP e por telefone.
 *
 * Aqui o pedido imprime direto — não há pagamento online barrando o falso.
 * Por IP segura o laço; por telefone segura quem repete o mesmo número.
 * Ninguém pedindo de verdade encosta nesses números.
 */
const TETOS_IP = [
  { janela: 60 * 1000, max: 3 },
  { janela: 60 * 60 * 1000, max: 10 },
];
const TETOS_TELEFONE = [{ janela: 30 * 60 * 1000, max: 3 }];
const marcas = new Map();

function estourou(chave, tetos) {
  const agora = Date.now();
  const maior = tetos[tetos.length - 1].janela;
  const lista = (marcas.get(chave) || []).filter((t) => agora - t < maior);
  const passou = tetos.some(({ janela, max }) => lista.filter((t) => agora - t < janela).length >= max);
  if (!passou) lista.push(agora);
  marcas.set(chave, lista);
  if (marcas.size > 2000) {
    for (const [k, v] of marcas) if (!v.some((t) => agora - t < 60 * 60 * 1000)) marcas.delete(k);
  }
  return passou;
}

// ------------------------------------------------------------------- rotas

router.get('/pedir/cardapio', (req, res) => {
  try {
    res.json({ ...pedidoweb.cardapioPublico(), whatsapp: whatsappDaLoja() });
  } catch (err) {
    log.error({ evt: 'pedir', err }, 'falha ao montar o cardápio do site');
    res.status(500).json({ erro: 'interno' });
  }
});

// Orçamento: só conta, não grava. Teto próprio e folgado — a página chama a
// cada mudança no carrinho.
const TETOS_ORCAMENTO = [{ janela: 60 * 1000, max: 60 }];
router.post('/pedir/orcamento', express.json({ limit: '20kb' }), (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'desconhecido';
  if (estourou(`orc:${ip}`, TETOS_ORCAMENTO)) return res.status(429).json({ erro: 'muitas_tentativas' });
  try {
    return res.json(pedidoweb.orcar(req.body));
  } catch (err) {
    if (err instanceof pedidoweb.PedidoInvalido) return res.status(400).json({ erro: err.codigo, detalhe: err.detalhe });
    log.error({ evt: 'pedir', err }, 'falha no orçamento do site');
    return res.status(500).json({ erro: 'interno' });
  }
});

router.post(
  '/pedir/pedido',
  express.json({ limit: '20kb' }),
  (req, res) => log.contexto({ canal: 'web' }, () => criar(req, res))
);

async function criar(req, res) {
  const ip = req.ip || req.socket?.remoteAddress || 'desconhecido';
  if (estourou(`ip:${ip}`, TETOS_IP)) {
    log.warn({ evt: 'pedir', ip }, 'teto de pedidos pelo site estourado (IP)');
    return res.status(429).json({ erro: 'muitas_tentativas' });
  }

  // Fechado é fechado aqui, e não na página: ela pode ter sido aberta às 22h59.
  if (!schedule.isOpen()) return res.status(409).json({ erro: 'fechado', horario: schedule.horarioTexto('pt') });

  let pedido;
  try {
    pedido = pedidoweb.montarPedido(req.body);
  } catch (err) {
    if (err instanceof pedidoweb.PedidoInvalido) {
      log.info({ evt: 'pedir', recusa: err.codigo, detalhe: err.detalhe }, 'pedido do site recusado');
      return res.status(400).json({ erro: err.codigo, detalhe: err.detalhe });
    }
    log.error({ evt: 'erro', err }, 'falha ao conferir pedido do site');
    return res.status(500).json({ erro: 'interno' });
  }

  if (estourou(`tel:${pedido.phone}`, TETOS_TELEFONE)) {
    log.warn({ evt: 'pedir', phone: pedido.phone }, 'teto de pedidos pelo site estourado (telefone)');
    return res.status(429).json({ erro: 'muitas_tentativas' });
  }

  log.marcar({ phone: pedido.phone });

  try {
    // O telefone digitado no site NÃO é comprovado. Cliente que já existe não
    // é tocado — senão qualquer um reescreveria o nome de outra pessoa no
    // cadastro. O nome digitado vale só para este pedido (`customer_name`).
    const customer = (await db.getCustomerByPhone(pedido.phone)) ||
      (await db.upsertCustomer({ phone: pedido.phone, lang: 'pt', name: pedido.nome }));

    const order = await db.createOrder({
      customerId: customer.id,
      phone: pedido.phone,
      lang: 'pt',
      orderType: pedido.orderType,
      customerName: pedido.nome,
      items: pedido.cart,
      city: pedido.city,
      address: pedido.address,
      subtotal: pedido.subtotal,
      deliveryFee: pedido.deliveryFee,
      total: pedido.total,
    });
    log.marcar({ pedido: order.id });
    log.info(
      { evt: 'pedido', origem: 'site', tipo: pedido.orderType, itens: pedido.cart.length, total: pedido.total, pagamento: pedido.pagamento },
      `pedido #${order.id} criado pelo site`
    );

    // O mesmo passo do bot que solta a comanda na cozinha.
    if (pedido.pagamento === 'cash') {
      await db.createCashPayment({ orderId: order.id, amount: pedido.total, changeFor: pedido.trocoPara });
    } else {
      await db.createZellePayment({ orderId: order.id, amount: pedido.total });
    }
    log.info({ evt: 'pagamento', origem: 'site', metodo: pedido.pagamento },
      'pedido liberado para impressão, pagamento a conferir');

    return res.status(201).json({
      pedido: order.id,
      total: pedido.total,
      subtotal: pedido.subtotal,
      taxa: pedido.deliveryFee,
      pagamento: pedido.pagamento,
      trocoPara: pedido.trocoPara,
      tipo: pedido.orderType,
      prazo: prazoPedido('pt', pedido.orderType),
      itens: pedido.cart.map((l) => ({ nome: l.name, qtd: l.qty, preco: l.price })),
      whatsapp: whatsappDaLoja(),
    });
  } catch (err) {
    log.error({ evt: 'erro', err }, 'falha ao gravar pedido do site');
    return res.status(502).json({ erro: 'gravar' });
  }
}

module.exports = router;
module.exports.zerarVazao = () => marcas.clear();
