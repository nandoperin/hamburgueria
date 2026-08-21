const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Roda todas as suítes de `test/` em processos separados.
 *
 * Processo por suíte não é preciosismo: cada uma substitui módulos no
 * `require.cache` — banco, Square, horário — para não tocar em serviço real.
 * No mesmo processo, uma substituição vazaria para a seguinte e o resultado
 * dependeria da ordem.
 */
const suites = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('test.js'))
  .sort();

let falhas = 0;

for (const suite of suites) {
  const nome = suite.replace(/\.js$/, '');
  process.stdout.write(`  ${nome.padEnd(12)} `);

  // O log estruturado fica em silêncio nos testes: as suítes provocam de
  // propósito erros que ele registraria, e a saída delas é o que importa aqui.
  // `LOG_LEVEL=info npm test` liga de volta quando o assunto for o próprio log.
  // `NODE_ENV=test` não é decoração: as portas com segredo fecham por padrão e
  // só cedem em ambiente declarado (ver `src/ambiente.js`). Sem esta linha, as
  // suítes que batem no CloudPRNT levariam 503 em vez de exercitar o protocolo.
  // A suíte de segurança sobrescreve para `production` no cenário dela.
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: process.env.LOG_LEVEL || 'silent',
      // Forçado, e não herdado: as suítes exercitam o fluxo numerado, e com a
      // IA ligada ela assume em MENU/ORDER e as asserções passam a depender do
      // que um modelo respondeu. Pior que instável — é **chamada paga**: rodar
      // a suíte viraria fatura, e um `npm test` num CI viraria fatura em laço.
      //
      // Quem quiser testar a conversa com IA faz isso à parte, com chave e de
      // propósito. A suíte cobre o que tem que funcionar quando a IA não está.
      AI_ENABLED: 'off',
    },
  });

  if (r.status === 0) {
    console.log('\x1b[32mPASSOU\x1b[0m');
    continue;
  }

  falhas += 1;
  console.log('\x1b[31mFALHOU\x1b[0m');
  const saida = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n');
  saida.slice(-12).forEach((l) => console.log(`      ${l}`));
}

console.log();
if (falhas) {
  console.log(`\x1b[31m${falhas} de ${suites.length} suíte(s) falharam.\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mTodas as ${suites.length} suítes passaram.\x1b[0m`);
