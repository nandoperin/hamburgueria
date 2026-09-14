const assert = require('node:assert/strict');
const { limitar, zerar } = require('../src/api/limite');

function executar(middleware, ip = '127.0.0.1') {
  return new Promise((resolve) => {
    const resposta = { status: 200, corpo: null, headers: {} };
    const req = { socket: { remoteAddress: ip } };
    const res = {
      set(k, v) { resposta.headers[k] = v; return this; },
      status(c) { resposta.status = c; return this; },
      json(v) { resposta.corpo = v; resolve(resposta); return this; },
    };
    middleware(req, res, () => resolve(resposta));
  });
}

(async () => {
  zerar();
  const middleware = limitar({ nome: 'teste', max: 2, janelaMs: 60_000 });
  assert.equal((await executar(middleware)).status, 200);
  assert.equal((await executar(middleware)).status, 200);
  const bloqueado = await executar(middleware);
  assert.equal(bloqueado.status, 429);
  assert.equal(bloqueado.corpo.erro, 'muitas_tentativas');
  assert.ok(Number(bloqueado.headers['Retry-After']) > 0);
  assert.equal((await executar(middleware, '127.0.0.2')).status, 200,
    'um endereço não bloqueia outro');
  console.log('Limitação de abuso por origem passou.');
})().catch((err) => { console.error(err); process.exit(1); });
