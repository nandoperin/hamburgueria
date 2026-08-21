const pt = require('./pt.json');
const en = require('./en.json');
const es = require('./es.json');

const strings = { pt, en, es };

/**
 * Telefone público de atendimento, formatado para leitura.
 *
 * Separado do `ADMIN_PHONE` de propósito: aquele é lista de autorização — quem
 * pode estornar e ver faturamento — e não deve chegar ao cliente. Este é o que
 * vai impresso nas mensagens.
 */
function suporte() {
  const digitos = (process.env.SUPPORT_PHONE || '').replace(/\D/g, '');
  if (!digitos) return '';

  const dez = digitos.length === 11 && digitos.startsWith('1')
    ? digitos.slice(1)
    : digitos;

  if (dez.length !== 10) return digitos;
  return `(${dez.slice(0, 3)}) ${dez.slice(3, 6)}-${dez.slice(6)}`;
}

/** E-mail público de atendimento — para o que não é urgente. */
function emailSuporte() {
  return (process.env.SUPPORT_EMAIL || '').trim();
}

/**
 * `{contact}` e `{email}` são preenchidos sozinhos em toda mensagem.
 *
 * Antes cada ponto de chamada passava o número na mão, e bastava esquecer um
 * para o cliente ver `{contact}` cru na tela. Quem passar explicitamente ainda
 * tem prioridade.
 */
function t(lang, key, vars = {}) {
  const str = strings[lang]?.[key] ?? strings['en'][key] ?? key;
  if (str === null) return null;

  const todos = { contact: suporte(), email: emailSuporte(), ...vars };
  return str.replace(/\{(\w+)\}/g, (_, k) => todos[k] ?? `{${k}}`);
}

const SUPPORTED_LANGS = Object.keys(strings);
const DEFAULT_LANG = 'pt';

module.exports = { t, SUPPORTED_LANGS, DEFAULT_LANG, suporte, emailSuporte };
