/**
 * Número de suporte técnico (`SUPORTE_PHONE`, 22/11/2026).
 *
 * Quem faz a manutenção entra no painel sem ser admin da loja: pede `!painel`
 * pelo WhatsApp, edita, e nada chega aos admins — o aviso de alteração vai só
 * para o próprio suporte. Não recebe aviso de pedido, caixa ou pergunta, e não
 * tem os outros comandos de admin.
 *
 * Só no servidor: o número nunca vai para o navegador nem para os admins.
 * Lista separada por vírgula, como `ADMIN_PHONE`. Mesmo número nas duas
 * listas conta como suporte no painel (alteração em silêncio).
 */

const MIN_DIGITOS = 10;

function canonico(digitos) {
  return digitos.length === 10 ? `1${digitos}` : digitos;
}

/** Números de suporte, só dígitos e com o código do país. */
function numeros() {
  return [...new Set(
    (process.env.SUPORTE_PHONE || '')
      .split(',')
      .map((n) => n.replace(/\D/g, ''))
      .filter((n) => n.length >= MIN_DIGITOS)
      .map(canonico)
  )];
}

/** O telefone é de suporte? Número completo, como em `isAdminPhone`. */
function ehSuporte(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < MIN_DIGITOS) return false;
  return numeros().includes(canonico(d));
}

module.exports = { numeros, ehSuporte };
