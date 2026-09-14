const express = require('express');
const crypto = require('crypto');
const qrcode = require('qrcode-terminal');
const log = require('../log');

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
 *   - token obrigatório, conferido com `timingSafeEqual`
 *   - só responde enquanto existe pareamento pendente; conectado, devolve 404
 *   - `no-store`, `noindex` e `no-referrer`, inclusive nas recusas
 *   - o QR morre da memória assim que a conexão abre (`esquecerQr`)
 *
 * `PAIRING_SECRET` autoriza apenas esta página. Nunca reutilizar a chave que
 * assina o painel: a URL passa pelo navegador e pode ficar no histórico.
 * Não existe fallback para a credencial antiga. Migração e rotação:
 * docs/SEGURANCA-PAREAMENTO-IMAGENS.md.
 */

const router = express.Router();

/** Compara em tempo constante quando os tamanhos coincidem. */
function tokenConfere(recebido, esperado) {
  if (!esperado || typeof recebido !== 'string' || !recebido) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(String(esperado));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** O QR em blocos, do jeito que o `qrcode-terminal` desenha no terminal. */
function desenhar(valor) {
  return new Promise((resolve) => {
    qrcode.generate(valor, { small: true }, (arte) => resolve(arte));
  });
}

function pagina({ arte, segundos }) {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Parear o WhatsApp</title>
<style>
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
<pre>${arte}</pre>
<p class="idade">Este QR tem ${segundos}s. Eles trocam a cada ~20s — a página se atualiza sozinha.</p>
<p>Assim que conectar, esta página deixa de existir.</p>
<script>setTimeout(function () { location.reload(); }, 15000);</script>`;
}

router.get('/pareamento', async (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  const esperado = process.env.PAIRING_SECRET;

  if (!esperado || esperado.trim().length < 32 || tokenConfere(esperado, process.env.PAINEL_SECRET)) {
    // Uma configuração insegura fecha somente o QR, sem derrubar o bot conectado.
    // Nunca registrar os valores nem a URL que contém a credencial.
    log.warn({ evt: 'pareamento' }, 'PAIRING_SECRET ausente, curto ou reutilizado — /pareamento desligado');
    return res.status(404).type('text/plain').send('nao disponivel');
  }

  if (!tokenConfere(req.query.token, esperado)) {
    // Mesma resposta de "não há QR": quem erra o token não fica sabendo se
    // existe pareamento pendente.
    log.warn({ evt: 'pareamento' }, 'tentativa em /pareamento com token invalido');
    return res.status(404).type('text/plain').send('nao disponivel');
  }

  const pendente = require('../bot/index').qrPendente();
  if (!pendente) {
    return res
      .status(404)
      .type('text/plain')
      .send('sem pareamento pendente — o bot ja esta conectado, ou ainda subindo');
  }

  const arte = await desenhar(pendente.valor);
  const segundos = Math.round((Date.now() - pendente.em) / 1000);

  res.type('html').send(pagina({ arte, segundos }));
});

module.exports = router;
