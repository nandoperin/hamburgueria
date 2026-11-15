const config = require('./config');
const { t } = require('../i18n');

/**
 * Telefone do entregador na confirmação do pedido com entrega (dono, 14/11).
 *
 * Cliente não atendia a ligação do entregador: número desconhecido. Com o
 * telefone na confirmação, ele sabe quem vai ligar. Nenhuma mensagem nova —
 * só uma linha a mais no texto que o bot já manda.
 *
 * Fica na aba Entrega do painel (`delivery.entregador`): até 2 telefones e a
 * mensagem, com `{numero}` onde entra o telefone. Sem telefone, nada muda.
 */

const MAX_TELEFONES = 2;
const MAX_MENSAGEM = 300;
const PADRAO_PT = '📞 Nosso entregador pode ligar do número {numero}. Por favor, atenda!';

function digitos(tel) {
  return String(tel || '').replace(/\D/g, '');
}

/** 6175551234 → (617) 555-1234. Fora do padrão americano, como veio. */
function formatar(tel) {
  const d = digitos(tel);
  const dez = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  if (dez.length !== 10) return d;
  return `(${dez.slice(0, 3)}) ${dez.slice(3, 6)}-${dez.slice(6)}`;
}

function telefoneValido(tel) {
  const d = digitos(tel);
  return d.length === 10 || (d.length === 11 && d.startsWith('1'));
}

/** Problemas do bloco `entregador` do documento de entrega (para o painel). */
function validar(bloco) {
  if (bloco === undefined || bloco === null) return [];
  const erros = [];
  const tels = bloco.telefones;
  if (tels !== undefined && !Array.isArray(tels)) return ['telefones do entregador precisam ser uma lista'];
  if ((tels || []).length > MAX_TELEFONES) erros.push(`no máximo ${MAX_TELEFONES} telefones de entregador`);
  for (const tel of tels || []) {
    if (!telefoneValido(tel)) erros.push(`telefone do entregador "${tel}" precisa ter 10 dígitos (ex.: 6175551234)`);
  }
  const msg = bloco.mensagem;
  if (msg !== undefined && msg !== null && typeof msg !== 'string') erros.push('mensagem do entregador precisa ser texto');
  if (typeof msg === 'string' && msg.trim()) {
    if (msg.length > MAX_MENSAGEM) erros.push(`mensagem do entregador: no máximo ${MAX_MENSAGEM} letras`);
    if (!msg.includes('{numero}')) erros.push('mensagem do entregador precisa ter {numero}, onde entra o telefone');
  }
  return erros;
}

/** A linha para a confirmação, ou null quando não há telefone cadastrado. */
function linha(lang = 'pt') {
  const bloco = config.get('delivery')?.entregador;
  const tels = (Array.isArray(bloco?.telefones) ? bloco.telefones : [])
    .filter(telefoneValido).slice(0, MAX_TELEFONES).map(formatar);
  if (!tels.length) return null;
  const numero = tels.map((x) => `*${x}*`).join(` ${t(lang, 'entregador_ou')} `);
  const propria = typeof bloco.mensagem === 'string' && bloco.mensagem.includes('{numero}') ? bloco.mensagem.trim() : '';
  // A mensagem do painel é escrita em português; inglês e espanhol usam a padrão.
  const modelo = lang === 'pt' ? (propria || PADRAO_PT) : t(lang, 'entregador_aviso');
  return modelo.split('{numero}').join(numero);
}

/** Acrescenta a linha ao fim do texto (pedido com entrega). */
function acrescentar(texto, lang = 'pt') {
  const l = linha(lang);
  return l ? `${texto}\n\n${l}` : texto;
}

module.exports = { linha, acrescentar, validar, formatar, PADRAO_PT, MAX_TELEFONES };
