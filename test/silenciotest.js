/**
 * Chave privada não vai para o log.
 *
 * O `libsignal`, que vem por baixo do Baileys, escreve direto em
 * `console.info` / `console.warn` — por fora do `pino({ level: 'silent' })`
 * que o Baileys recebe — e passa o objeto de sessão INTEIRO como argumento.
 *
 * O que aparecia no log de produção, a cada troca de sessão:
 *
 *     Closing session: SessionEntry {
 *       privKey: <Buffer 60 68 63 a8 ...>,
 *       rootKey: <Buffer ba ec e7 60 ...>
 *
 * Dois danos ao mesmo tempo: material criptográfico num log que é visível para
 * quem tem acesso à conta e costuma ser exportado, e ~40 linhas de buffer por
 * evento soterrando as linhas de diagnóstico que importam.
 *
 * O que esta suíte trava não é "some tudo" — é **some o ruído conhecido, e
 * nada além disso**. Um filtro guloso demais esconderia a próxima falha do
 * libsignal, que é exatamente o que se quer enxergar.
 */

const PROJECT = require('path').resolve(__dirname, '..');
const silencio = require(`${PROJECT}/src/bot/silencio`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

/** Um console de mentira, para não mexer no de verdade durante o teste. */
function consoleFalso() {
  const saidas = [];
  return {
    saidas,
    info: (...a) => saidas.push(['info', ...a]),
    warn: (...a) => saidas.push(['warn', ...a]),
    error: (...a) => saidas.push(['error', ...a]),
    log: (...a) => saidas.push(['log', ...a]),
  };
}

/** O objeto que o libsignal despeja — com o que não pode vazar. */
const SESSAO = {
  registrationId: 1300391836,
  currentRatchet: {
    ephemeralKeyPair: {
      privKey: Buffer.from('60686 3a87bcadc94', 'utf8'),
    },
    rootKey: Buffer.from('baece760fd78953b', 'utf8'),
  },
};

(async () => {
  // ------------------------------------- 1. o despejo de chave é barrado
  console.log('\n\x1b[36m### 1. O DESPEJO DE SESSAO NAO PASSA ###\x1b[0m');
  const c = silencio.aplicar(consoleFalso());

  c.info('Closing session:', SESSAO);
  c.info('Opening session:', SESSAO);
  c.warn('Session already closed', SESSAO);
  c.info('Removing old closed session:', SESSAO);

  checar(
    c.saidas.length === 0,
    'nenhuma das quatro mensagens que carregam o objeto de sessão foi impressa'
  );

  const tudo = JSON.stringify(c.saidas);
  checar(!tudo.includes('privKey'), 'privKey não aparece em lugar nenhum da saída');
  checar(!tudo.includes('rootKey'), 'rootKey também não');

  // ------------------------------- 2. o resto do libsignal continua visível
  console.log('\n\x1b[36m### 2. ERRO DE VERDADE CONTINUA APARECENDO ###\x1b[0m');
  c.saidas.length = 0;

  c.error('Failed to decrypt message with any known session...');
  c.warn('Unhandled bucket type (for naming):', 'objeto');
  c.error('WARNING: Expected pubkey of length 33, please report');

  checar(
    c.saidas.length === 3,
    'as três mensagens de erro real passaram — o filtro não é uma mordaça'
  );

  // ----------------------------------------- 3. o resto do mundo passa
  console.log('\n\x1b[36m### 3. O CONSOLE CONTINUA SENDO CONSOLE ###\x1b[0m');
  c.saidas.length = 0;

  c.info('bot no ar');
  c.warn('comanda atrasada');
  c.info('Closing something else entirely');

  checar(c.saidas.length === 3, 'mensagens do projeto não são afetadas');
  checar(
    c.saidas[2][1] === 'Closing something else entirely',
    'e "Closing" sozinho não basta — o filtro casa o prefixo inteiro'
  );

  // ------------------------------------- 4. argumento não-string não quebra
  console.log('\n\x1b[36m### 4. ENTRADA ESQUISITA NAO QUEBRA ###\x1b[0m');
  c.saidas.length = 0;
  c.info(SESSAO);
  c.info(null);
  c.info();
  c.warn(42);
  checar(c.saidas.length === 4, 'objeto, null, vazio e número passam sem lançar');

  // ------------------------------------------------ 5. aplicar duas vezes
  console.log('\n\x1b[36m### 5. APLICAR DUAS VEZES NAO EMPILHA ###\x1b[0m');
  const c2 = consoleFalso();
  silencio.aplicar(c2);
  const depoisDaPrimeira = c2.info;
  silencio.aplicar(c2);
  checar(c2.info === depoisDaPrimeira, 'a segunda chamada não envolve o wrapper de novo');

  console.log('\n\x1b[32msilenciotest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
