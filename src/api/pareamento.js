const express = require('express');
const crypto = require('crypto');
const qrcode = require('qrcode-terminal');
const log = require('../log');
const { limitar } = require('./limite');
const acesso = require('../services/pareamento-acesso');

/**
 * O QR de pareamento numa página, porque o log não serve para isso.
 *
 * ## Por que existe
 *
 * O bot tinha duas formas de parear e nenhuma utilizável no Railway:
 *
 *   QR no log     — 33 linhas de arte ASCII que o visualizador do Railway
 *                   quebra. Ilegível na prática ("gigante, tem que rolar tela").
 *   Código de 8   — legível, mas depende de `requestPairingCode`, a parte mais
 *                   instável do Baileys. Numa noite inteira com a 7.0.0-rc13,
 *                   ~25 códigos foram emitidos e nenhum foi aceito, sempre com
 *                   "confira se inseriu o código correto". Nada no servidor
 *                   falhava: o log parecia perfeito enquanto ninguém conseguia
 *                   entrar.
 *
 * Aqui o mesmo QR sai numa página, em tamanho que o celular lê de longe. E o
 * ganho não é só de legibilidade: escanear é **instantâneo**, o que elimina a
 * corrida contra o relógio que o código de 8 caracteres impõe — ele vence em
 * menos de 3 minutos, e entre ler o log, copiar e navegar até a tela certa a
 * janela fechava sozinha.
 *
 * ## Segurança
 *
 * **O QR é credencial**: quem escaneia passa a falar como a hamburgueria. Daí:
 *
 *   - link aleatório, temporário e de uso único; a chave mestra nunca vai à URL
 *   - só responde enquanto existe pareamento pendente; conectado, devolve 404
 *   - `no-store`, `noindex` e `no-referrer`, inclusive nas recusas
 *   - o QR morre da memória assim que a conexão abre (`esquecerQr`)
 *
 * `PAIRING_SECRET` assina credenciais temporárias somente no servidor. Nunca
 * reutilizar a chave que assina o painel.
 * Não existe fallback para a credencial antiga. Migração e rotação:
 * docs/SEGURANCA-PAREAMENTO-IMAGENS.md.
 */

const router = express.Router();

/** O QR em blocos, do jeito que o `qrcode-terminal` desenha no terminal. */
function desenhar(valor) {
  return new Promise((resolve) => {
    qrcode.generate(valor, { small: true }, (arte) => resolve(arte));
  });
}

function pagina({ arte, segundos, nonce }) {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Parear o WhatsApp</title>
<style nonce="${nonce}">
  :root { color-scheme: light; }
  body {
    margin: 0; padding: 24px 16px; background: #fff; color: #111;
    font: 16px/1.5 system-ui, -apple-system, sans-serif; text-align: center;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { margin: 4px 0; color: #555; font-size: 14px; }
  /* line-height 1 e nenhum espaçamento: qualquer folga entre as linhas quebra
     os módulos do QR e a câmera não lê. */
  pre {
    display: inline-block; margin: 20px 0; padding: 16px; background: #fff;
    font-family: monospace; font-size: 9px; line-height: 1; letter-spacing: 0;
    white-space: pre; text-align: left;
  }
  .idade { font-variant-numeric: tabular-nums; }
</style>
<h1>Parear o WhatsApp</h1>
<p>No celular do bot: <b>Aparelhos conectados → Conectar aparelho</b> → aponte a câmera.</p>
${arte ? `<pre>${arte}</pre>
<p class="idade">Este QR tem ${segundos}s. Eles trocam a cada ~20s — a página se atualiza sozinha.</p>`
  : `<p><b>Aguardando o QR…</b></p>
<p>O bot está entre uma tentativa e outra. Deixe esta página aberta: o QR aparece sozinho em instantes.</p>`}
<p>Assim que conectar, esta página deixa de existir.</p>
<script nonce="${nonce}">history.replaceState(null, '', '/pareamento');setTimeout(function () { location.reload(); }, ${arte ? 15000 : 10000});</script>`;
}

function cookie(req, nome) {
  const prefixo = `${nome}=`;
  for (const parte of String(req.headers.cookie || '').split(';')) {
    const item = parte.trim();
    if (item.startsWith(prefixo)) {
      try { return decodeURIComponent(item.slice(prefixo.length)); } catch (_err) { return ''; }
    }
  }
  return '';
}

// A página se recarrega sozinha enquanto espera o QR, então o teto precisa
// caber nisso: com 30 o próprio auto-refresh estourava o limite e o dono via
// "nao disponivel" (20/09). Segue barrando enxurrada de tentativa de token.
router.get('/pareamento', limitar({
  nome: 'pareamento',
  max: 200,
  janelaMs: 5 * 60 * 1000,
  // Mantém a mesma resposta usada por token inválido e QR ausente.
  aoBloquear: (_req, res) => res.status(404).type('text/plain').send('nao disponivel'),
}), async (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  if (!acesso.configurado()) {
    // Uma configuração insegura fecha somente o QR, sem derrubar o bot conectado.
    // Nunca registrar os valores nem a URL que contém a credencial.
    log.warn({ evt: 'pareamento' }, 'PAIRING_SECRET ausente, curto ou reutilizado — /pareamento desligado');
    return res.status(404).type('text/plain').send('nao disponivel');
  }

  if (req.query.t) {
    const aberto = acesso.abrir(req.query.t);
    if (!aberto.ok) {
      log.warn({ evt: 'pareamento' }, 'tentativa em /pareamento com link invalido');
      return res.status(404).type('text/plain').send('nao disponivel');
    }
    res.set(
      'Set-Cookie',
      `__Host-pareamento_session=${encodeURIComponent(aberto.sessao)}; HttpOnly; Secure; ` +
        `SameSite=Lax; Path=/pareamento; Max-Age=${aberto.segundos}`
    );
    return res.redirect(303, '/pareamento');
  }

  if (!acesso.conferir(cookie(req, '__Host-pareamento_session'))) {
    return res.status(404).type('text/plain').send('nao disponivel');
  }

  const pendente = require('../bot/index').qrPendente();
  const nonce = crypto.randomBytes(16).toString('base64');
  // Entre uma tentativa de conexão e outra o bot fica alguns minutos sem QR.
  // Antes isso virava 404 e o dono achava que o link tinha morrido (19/09):
  // agora a página espera e mostra o QR assim que ele nascer.
  const arte = pendente ? await desenhar(pendente.valor) : null;
  const segundos = pendente ? Math.round((Date.now() - pendente.em) / 1000) : 0;

  res.set(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; ` +
      "form-action 'none'; frame-ancestors 'none'"
  );
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.type('html').send(pagina({ arte, segundos, nonce }));
});

module.exports = router;
