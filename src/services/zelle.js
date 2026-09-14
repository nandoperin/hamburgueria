const config = require('../../config/pagamento.json');
const { t, prazoPedido } = require('../i18n');

/**
 * Pagamento por Zelle.
 *
 * ## O que o Zelle não tem
 *
 * Não tem webhook: nada avisa o servidor que o dinheiro chegou. Não tem API de
 * estorno: nada desfaz. A confirmação continua **humana**, mas vem depois: o
 * print do comprovante solta a comanda, e o dono confere o banco em seguida.
 *
 * O fluxo, desde 13/09:
 *
 *   pedido confirmado     -> pedido `paid`, pagamento `pending`; a comanda sai
 *                            na hora, igual ao cash, e as instruções do Zelle
 *                            são enviadas junto
 *   cliente manda o print -> pagamento `awaiting_review`; o dono recebe o
 *                            arquivo. Nada da cozinha depende disso
 *   dono confere o banco  -> !liberar grava quem conferiu (pagamento `paid`)
 *                            ou !recusar, que tira o pedido da cozinha
 *
 * O comprovante deixou de ser portão porque nunca foi prova: ele mostra o que
 * o cliente diz ter feito, e quem confirma o dinheiro é o extrato. Segurar o
 * preparo por ele atrasava toda a venda — e a conferência continua existindo,
 * só que depois, onde ela sempre esteve.
 *
 * `db.getNextPrintableOrder()` busca `status = 'paid'`. Quem escreve isso é a
 * confirmação do pedido (`db.createZellePayment`).
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
    // O prazo entra aqui porque a comanda já saiu: a mensagem que pede o
    // comprovante é, antes disso, a confirmação de que o lanche está sendo
    // feito. Sem o prazo ela pareceria condicionar o preparo ao print.
    estimated_time: prazoPedido(lang, order.order_type),
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
// O Zelle não tem API de estorno: o dinheiro volta ao cliente pelo app do
// banco. Aqui "estornar" só informa se o dono precisa agir manualmente.

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
 * comanda já saiu, e o cliente acredita ter pagado.
 *
 * O terceiro caso nasceu em 13/09, quando a comanda passou a sair antes do
 * comprovante: **entrega sem print não é o mesmo que entrega sem pagamento**. O
 * cliente recebeu as instruções, pode ter mandado o Zelle e simplesmente não
 * ter mandado a foto. Dizer "não há o que estornar" ali seria o bot afirmando
 * algo que ninguém verificou, na hora em que o dono decide devolver dinheiro.
 * Na retirada continua valendo o contrário: ali o dinheiro é conferido no
 * balcão, e pedido cancelado antes disso não recebeu nada.
 *
 * @returns {{manual: boolean, incerto: boolean}}
 *   manual diz se o dono precisa devolver o valor pelo banco; incerto pede que
 *   ele confira antes.
 */
async function estornar({ order, payment } = {}) {
  const recebeu = RECEBIDO.includes(payment?.status);
  const incerto = !recebeu &&
    payment?.status === 'pending' &&
    order?.order_type !== 'pickup';
  return { manual: recebeu, incerto };
}

module.exports = {
  conferir,
  configurado,
  destinatario,
  instrucoes,
  regrasComprovante,
  prazos,
  estornar,
};
