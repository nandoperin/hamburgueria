/** Página de QR com chave mestra somente no servidor e link temporário. */

const assert = require('node:assert/strict');
const express = require('express');

process.env.DATABASE_URL = 'postgresql://fake';
process.env.BASE_URL = 'https://loja.test';
process.env.LOG_LEVEL = 'silent';
process.env.PAINEL_SECRET = 'assinatura-ficticia-'.repeat(4);
process.env.PAIRING_SECRET = 'pareamento-ficticio-'.repeat(4);

const PROJECT = require('path').resolve(__dirname, '..');
const botPath = require.resolve(`${PROJECT}/src/bot/index`);
let qr = null;
require.cache[botPath] = {
  id: botPath, filename: botPath, loaded: true,
  exports: { qrPendente: () => qr },
};

const acesso = require(`${PROJECT}/src/services/pareamento-acesso`);
const router = require(`${PROJECT}/src/api/pareamento`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  const app = express();
  app.use(router);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const origem = `http://127.0.0.1:${server.address().port}`;
  try {
    acesso.encerrar();
    qr = { valor: 'QR-DE-VERDADE', em: Date.now() - 7000 };

    console.log('\n\x1b[36m### 1. CHAVE MESTRA NÃO ABRE A URL ###\x1b[0m');
    let r = await fetch(`${origem}/pareamento?t=${process.env.PAIRING_SECRET}`, { redirect: 'manual' });
    checar(r.status === 404, 'PAIRING_SECRET não funciona como credencial de URL');
    r = await fetch(`${origem}/pareamento?t=${process.env.PAINEL_SECRET}`, { redirect: 'manual' });
    checar(r.status === 404, 'PAINEL_SECRET também não abre o QR');

    console.log('\n\x1b[36m### 2. LINK TEMPORÁRIO E USO ÚNICO ###\x1b[0m');
    const temporario = acesso.preparar();
    const token = new URL(temporario.url).searchParams.get('t');
    checar(temporario.ok && temporario.novo && /^[A-Za-z0-9_-]{43}$/.test(token),
      'é emitido token opaco de 256 bits');
    checar(!temporario.url.includes(process.env.PAIRING_SECRET), 'a chave permanente não aparece no link');

    r = await fetch(`${origem}/pareamento?t=${token}`, { redirect: 'manual' });
    const setCookie = r.headers.get('set-cookie') || '';
    checar(r.status === 303 && r.headers.get('location') === '/pareamento',
      'abertura limpa a URL por redirecionamento');
    checar(/HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Strict/i.test(setCookie),
      'sessão curta fica em cookie protegido');
    // Algumas aberturas por link (19/09): a pré-visualização do WhatsApp e o
    // pré-carregamento do navegador consumiam a única que havia, e o dono
    // ficava sem escanear o QR com o bot fora do ar.
    checar((await fetch(`${origem}/pareamento?t=${token}`, { redirect: 'manual' })).status === 303,
      'o mesmo link ainda abre depois de uma pré-visualização');
    for (let i = 3; i <= acesso.MAX_ABERTURAS; i++) {
      await fetch(`${origem}/pareamento?t=${token}`, { redirect: 'manual' });
    }
    checar((await fetch(`${origem}/pareamento?t=${token}`, { redirect: 'manual' })).status === 404,
      `passadas ${acesso.MAX_ABERTURAS} aberturas, o link morre`);

    console.log('\n\x1b[36m### 3. COOKIE MOSTRA O QR, SEM VAZAR SEGREDOS ###\x1b[0m');
    const cookie = setCookie.split(';')[0];
    r = await fetch(`${origem}/pareamento`, { headers: { cookie } });
    const html = await r.text();
    checar(r.status === 200 && /<pre>/.test(html) && html.length > 200, 'cookie válido mostra o QR');
    checar(/tem 7s/.test(html), 'mostra a idade do QR');
    checar(!html.includes(process.env.PAIRING_SECRET) && !html.includes(process.env.PAINEL_SECRET),
      'HTML não incorpora as chaves');
    const csp = r.headers.get('content-security-policy') || '';
    checar(/script-src 'nonce-/.test(csp) && !/unsafe-inline/.test(csp), 'script e estilo usam nonce');
    checar(/no-store/.test(r.headers.get('cache-control') || '') &&
      r.headers.get('referrer-policy') === 'no-referrer', 'não permite cache ou referrer');

    console.log('\n\x1b[36m### 4. SEM QR OU CONFIGURAÇÃO INSEGURA, FECHA ###\x1b[0m');
    qr = null;
    r = await fetch(`${origem}/pareamento`, { headers: { cookie } });
    checar(r.status === 404, 'sem QR pendente nada é servido');
    process.env.PAIRING_SECRET = process.env.PAINEL_SECRET;
    checar(!acesso.configurado(), 'reutilizar chave do painel desliga a página');
    r = await fetch(`${origem}/pareamento`, { headers: { cookie } });
    checar(r.status === 404, 'configuração reutilizada responde 404');

    console.log('\n\x1b[32mpareamentotest: tudo passou.\x1b[0m');
  } finally {
    server.close();
  }
})().catch((err) => { console.error(err.stack || err); process.exit(1); });
