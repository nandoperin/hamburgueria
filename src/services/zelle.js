const config = require('../../config/pagamento.json');
const { t } = require('../i18n');

/**
 * Pagamento por Zelle.
 *
 * ## O que o Zelle não tem
 *
 * Não tem webhook: nada avisa o servidor que o dinheiro chegou. Não tem API de
 * estorno: nada desfaz. A confirmação continua **humana**, mas vem depois: o
 * print do comprovante solta a comanda, e o dono confere o banco em seguida.
 *
 * O fluxo:
 *
 *   cliente confirma      -> pedido `pending`, instruções enviadas
 *   cliente manda o print -> pedido `paid` (a impressora pega na hora) e
 *                            pagamento `awaiting_review`; o dono recebe a imagem
 *   dono confere o banco  -> !liberar grava quem conferiu (pagamento `paid`)
 *                            ou !recusar, que tira o pedido da cozinha
 *
 * `db.getNextPrintableOrder()` busca `status = 'paid'`. Escrevem isso o
 * comprovante (`db.markProofReceived`) e o `!liberar` sem comprovante.
 */

/** Marcador do arquivo de exemplo. Config com isso dentro não foi preenchida. */
const NAO_PREENCHIDO = /^PREENCHER:/i;

function vazio(valor) {
  const s = String(valor ?? '').trim();
  return !s || NAO_PREENCHIDO.test(s);
}

/**
 * A config do Zelle está pronta para receber dinheiro?
 *
 * Vale o mesmo rigor de um segredo, e pelo mesmo motivo do `ambiente.js`: o
 * caso não previsto tem que cair do lado fechado. Config pela metade não
 * degrada em silêncio — ela manda o cliente pagar para `PREENCHER: nome`, e
 * quem descobre é o cliente, com o dinheiro na mão.
 *
 * @returns {{ok: boolean, faltando: string[]}}
 */
function conferir() {
  const z = config.zelle || {};
  const faltando = [];

  if (vazio(z.nome)) faltando.push('zelle.nome');
  if (vazio(z.email) && vazio(z.telefone)) {
    faltando.push('zelle.email ou zelle.telefone');
  }

  return { ok: !faltando.length, faltando };
}

function configurado() {
  return conferir().ok;
}

/** Destinatário, para a mensagem ao cliente. */
function destinatario() {
  const z = config.zelle || {};
  return {
    nome: String(z.nome || '').trim(),
    email: String(z.email || '').trim(),
    telefone: String(z.telefone || '').replace(/\D/g, ''),
  };
}

/**
 * A mensagem que o cliente recebe depois de confirmar.
 *
 * Sai do i18n, não de um modelo: é o texto que carrega para onde mandar
 * dinheiro e quanto. Gerar isso por LLM seria pôr o valor e o destinatário na
 * mão de quem pode alucinar os dois.
 */
function instrucoes(order, lang) {
  const { nome, email, telefone } = destinatario();

  return t(lang, 'zelle_instructions', {
    order_id: order.id,
    total: Number(order.total).toFixed(2),
    zelle_nome: nome,
    zelle_contato: telefone || email,
  });
}

// ------------------------------------------------------------- comprovante

function regrasComprovante() {
  const c = config.comprovante || {};
  const tetoEnv = Number(process.env.PROOF_MAX_MB);

  return {
    exigir: c.exigir !== false,
    // O `.env` manda, porque é o que se ajusta sem deploy quando a banda aperta.
    maxBytes: Math.round((Number.isFinite(tetoEnv) && tetoEnv > 0 ? tetoEnv : c.max_mb || 5) * 1024 * 1024),
    mimetypes: Array.isArray(c.mimetypes) && c.mimetypes.length
      ? c.mimetypes
      : ['image/jpeg', 'image/png', 'image/webp'],
  };
}

/** Minutos até cobrar o comprovante, e até desistir do pedido. */
function prazos() {
  const p = config.prazos || {};
  return {
    lembrete: Number(p.lembrete_minutos) || 10,
    expira: Number(p.expira_minutos) || 30,
  };
}

// ------------------------------------------------------------- estorno
//
// Parte da interface de pagamento (ver `src/services/pagamento.js`). O Zelle
// não tem API de estorno: o dinheiro volta ao cliente pelo app do banco, à
// mão. Então aqui "estornar" nunca move dinheiro — ele só informa a quem chamou
// que, se houve pagamento, o estorno é uma ação **manual** do dono.
//
// A contrapartida Square (`src/services/square.js`, esqueleto) implementa a
// mesma assinatura de verdade, com `refundPayment`. Quem chama — `cancel.js` —
// não muda ao trocar de provedor.

/** O provedor devolve dinheiro sozinho? Zelle, não. */
function estornoAutomatico() {
  return false;
}

/**
 * Situações em que o cliente pagou (ou diz ter pagado, com o print): o dono
 * conferiu (`paid` — ver `db.approvePayment`) ou o comprovante chegou e ainda
 * espera conferência.
 */
const RECEBIDO = ['paid', 'awaiting_review', 'review_reminded'];

/**
 * "Estorna" um pedido do Zelle.
 *
 * Não há chamada externa: devolve se o estorno precisa ser feito à mão. Isso é
 * verdade quando o dinheiro foi conferido ou quando o comprovante chegou — a
 * comanda já saiu, e o cliente acredita ter pagado. Pedido `pending` nunca
 * recebeu dinheiro, então não há o que estornar.
 *
 * @returns {{estornou: boolean, manual: boolean}}
 *   estornou é sempre false (o Zelle não estorna sozinho); manual diz se o dono
 *   precisa devolver o valor pelo banco.
 */
async function estornar({ payment } = {}) {
  const recebeu = RECEBIDO.includes(payment?.status);
  return { estornou: false, manual: recebeu };
}

module.exports = {
  conferir,
  configurado,
  destinatario,
  instrucoes,
  regrasComprovante,
  prazos,
  estornoAutomatico,
  estornar,
};
