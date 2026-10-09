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

/**
 * Chave "este celular fez este pedido" (decisão do dono, 09/10/2026).
 *
 * O site não comprova o telefone digitado. Por isso o preenchimento NUNCA
 * devolve os dados salvos de um telefone — devolve só o nome e o endereço do
 * pedido que AQUELE aparelho fez pelo site, isto é, o que ele mesmo digitou.
 * A chave é `<id do pedido>.<HMAC(id + telefone)>` com `PEDIR_SEGREDO`, que só
 * o servidor conhece; o aparelho a recebe no fim do pedido e manda de volta no
 * próximo. Quem faz um pedido com o número de outra pessoa ganha a chave do
 * pedido DELE, e vê o que ele mesmo digitou — nada da outra pessoa. Custo
 * aceito pelo dono: o preenchimento começa no segundo pedido pelo site.
 *
 * Sem `PEDIR_SEGREDO`, não há chave: o preenchimento fica desligado e o resto
 * do site segue normal. Nada novo no banco.
 */
function assinatura(orderId, phone) {
  const segredo = process.env.PEDIR_SEGREDO || '';
  if (segredo.length < 16 || !orderId || !phone) return null;
  return require('crypto').createHmac('sha256', segredo).update(`pedido:${orderId}:${phone}`).digest('hex').slice(0, 40);
}

function chaveDoPedido(orderId, phone) {
  const sig = assinatura(orderId, phone);
  return sig ? `${orderId}.${sig}` : null;
}

/** O id do pedido, se a chave foi emitida por nós para este telefone; senão null. */
function pedidoDaChave(phone, chave) {
  const m = /^(\d{1,12})\.([0-9a-f]{40})$/.exec(typeof chave === 'string' ? chave : '');
  if (!m) return null;
  const certa = assinatura(m[1], phone);
  if (!certa) return null;
  return require('crypto').timingSafeEqual(Buffer.from(certa), Buffer.from(m[2])) ? Number(m[1]) : null;
}

// Teto por IP, número completo, pedido de até um ano, cada consulta no log.
// O telefone vai no corpo, nunca na URL.
const TETOS_CLIENTE = [
  { janela: 10 * 60 * 1000, max: 5 },
  { janela: 24 * 60 * 60 * 1000, max: 20 },
];
const PEDIDO_VALIDO_DIAS = 365;

router.post('/pedir/cliente', express.json({ limit: '2kb' }), async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'desconhecido';
  const phone = pedidoweb.normalizarTelefone(req.body?.telefone);
  if (!phone) return res.status(400).json({ erro: 'telefone' });
  if (estourou(`cli:${ip}`, TETOS_CLIENTE)) {
    log.warn({ evt: 'pedir', ip }, 'teto de consulta de cliente pelo site estourado');
    return res.status(429).json({ erro: 'muitas_tentativas' });
  }
  // Sem a chave deste aparelho, nem consulta o banco: a resposta é a mesma de
  // um número sem cadastro, para não revelar quem é cliente.
  const orderId = pedidoDaChave(phone, req.body?.chave);
  if (!orderId) {
    log.info({ evt: 'pedir', ip, phone, comChave: Boolean(req.body?.chave) }, 'consulta de cliente pelo site sem chave válida');
    return res.json({});
  }
  try {
    const order = await db.getOrder(orderId);
    const valido = order && String(order.phone) === phone &&
      (Date.now() - new Date(order.created_at).getTime()) < PEDIDO_VALIDO_DIAS * 864e5;
    if (!valido) return res.json({});
    const cidade = order.order_type === 'delivery'
      ? require('../services/delivery').getCities().find((c) => c.label === order.city) || null
      : null;
    const resposta = {
      ...(order.customer_name ? { nome: order.customer_name } : {}),
      ...(cidade && order.address ? { cidade: cidade.id, endereco: order.address } : {}),
    };
    log.info({ evt: 'pedir', ip, phone, pedido: orderId, achou: Object.keys(resposta) }, 'consulta de cliente pelo site');
    return res.json(resposta);
  } catch (err) {
    log.error({ evt: 'pedir', err }, 'falha ao consultar cliente pelo site');
    return res.json({});
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
      // O aparelho guarda e manda de volta no próximo pedido para preencher.
      ...(chaveDoPedido(order.id, pedido.phone) ? { chave: chaveDoPedido(order.id, pedido.phone) } : {}),
    });
  } catch (err) {
    log.error({ evt: 'erro', err }, 'falha ao gravar pedido do site');
    return res.status(502).json({ erro: 'gravar' });
  }
}

module.exports = router;
module.exports.zerarVazao = () => marcas.clear();
