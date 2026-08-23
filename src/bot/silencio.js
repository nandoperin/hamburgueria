/**
 * Cala o despejo de chaves privadas que o `libsignal` faz no console.
 *
 * O Baileys recebe `logger: pino({ level: 'silent' })`, e isso cala o Baileys.
 * Mas o `libsignal` — a camada de criptografia por baixo dele — não usa esse
 * logger: escreve direto em `console.info` / `console.warn`, e passa o objeto
 * de sessão **inteiro** como segundo argumento.
 *
 * O que aparecia no log do Railway a cada troca de sessão:
 *
 *     Closing session: SessionEntry {
 *       privKey: <Buffer 60 68 63 a8 7b ca dc 94 ...>,
 *       rootKey: <Buffer ba ec e7 60 fd 78 95 3b ...>,
 *       remoteIdentityKey: <Buffer 05 8e d4 08 60 45 ...>
 *
 * São duas coisas ruins ao mesmo tempo:
 *
 * 1. **Chave privada em log.** O log do Railway é visível para quem tem acesso
 *    à conta, e costuma ser encaminhado para fora (monitoramento, exportação).
 *    Material criptográfico não tem por que estar lá.
 *
 * 2. **Log ilegível.** Cada evento desses são ~40 linhas de buffer. Duas linhas
 *    úteis de diagnóstico — "instruções de pagamento enviadas" e "cobrando
 *    comprovante" — ficavam soterradas. Log que não se lê na hora do problema
 *    é log que não existe.
 *
 * O filtro é por prefixo conhecido, e **deixa passar todo o resto**: um erro
 * novo do libsignal continua aparecendo. Silenciar o console inteiro seria
 * trocar um problema por outro pior — o de não ver a próxima falha.
 */

/**
 * As mensagens do `libsignal/src/session_record.js` e `session_builder.js` que
 * ou carregam o objeto de sessão, ou são ruído de rotina.
 *
 * Conferidas contra o código do pacote instalado, não supostas. Se o libsignal
 * mudar as strings, o filtro para de pegar — e a consequência é log verboso de
 * novo, não bot quebrado.
 */
const RUIDO = [
  'Closing session:',
  'Opening session:',
  'Session already closed',
  'Session already open',
  'Removing old closed session:',
  'Migrating session to:',
  'Closing open session in favor of incoming prekey bundle',
  'Decrypted message with closed session.',
];

function ehRuido(args) {
  const primeiro = args[0];
  return typeof primeiro === 'string' && RUIDO.some((p) => primeiro.startsWith(p));
}

/**
 * Instala o filtro. Idempotente: chamar duas vezes não empilha wrappers.
 *
 * @param {object} alvo  só para teste; em produção é o `console` global.
 */
function aplicar(alvo = console) {
  if (alvo.__silencioLibsignal) return alvo;
  alvo.__silencioLibsignal = true;

  for (const nivel of ['info', 'warn']) {
    const original = alvo[nivel].bind(alvo);
    alvo[nivel] = (...args) => {
      if (ehRuido(args)) return;
      original(...args);
    };
  }

  return alvo;
}

module.exports = { aplicar, RUIDO };
