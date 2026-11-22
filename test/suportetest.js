/**
 * Número de suporte técnico (SUPORTE_PHONE, 22/11/2026): entra no painel pelo
 * `!painel`, e alteração feita por ele não chega aos admins — só a ele.
 * Alteração feita por admin continua avisando os admins.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.PAINEL_SECRET = 'x'.repeat(40);
process.env.BASE_URL = 'https://bot.teste';
process.env.ADMIN_PHONE = '16170000001,7810000002';
process.env.SUPORTE_PHONE = '6175550000';
process.env.LOG_LEVEL = 'silent';

const PROJECT = require('path').resolve(__dirname, '..');
const links = [];
let listaAutorizada = null;
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({
  salvarLinkPainel: async (hash, phone) => { links.push(phone); },
  consumirLinkPainel: async (a, b, c, autorizados) => { listaAutorizada = autorizados; return autorizados.includes(links.at(-1)) ? { phone: links.at(-1) } : null; },
  getSessaoPainel: async () => ({ phone: '16175550000' }),
}, { get: (alvo, k) => alvo[k] || (async () => null) });

const notify = require(`${PROJECT}/src/bot/notify`);
const enviados = [];
notify.send = async (tel, msg) => { enviados.push({ tel, msg }); return true; };

const config = require(`${PROJECT}/src/services/config`);
config.set = async (key, doc) => ({ anterior: { a: 0 }, doc });

const admin = require(`${PROJECT}/src/bot/handlers/admin`);
const painel = require(`${PROJECT}/src/services/painel`);
const suporte = require(`${PROJECT}/src/services/suporte`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  checar(!notify.admins().includes('16175550000'), 'suporte não está na lista de admins (não recebe aviso de pedido, caixa...)');
  checar(suporte.ehSuporte('16175550000') && !suporte.ehSuporte('16170000001') && !suporte.ehSuporte('5550000'), 'reconhece só o número completo do suporte');

  // !painel pelo suporte.
  const saida = [];
  let tratou = await admin.handle('16175550000', '!painel', async (m) => saida.push(m));
  checar(tratou && /https:\/\/bot\.teste\/painel\?t=/.test(saida[0]), '"!painel" do suporte: recebe o link');
  checar(links.at(-1) === '16175550000', '   o link fica ligado ao número do suporte, no servidor');
  const token = saida[0].match(/t=([A-Za-z0-9_-]{43})/)[1];
  const aberto = await painel.abrir(token);
  checar(aberto.ok && listaAutorizada.includes('16175550000') && listaAutorizada.includes('16170000001'), '   e o link abre o painel');
  checar((await painel.conferirSessao(aberto.sessao)).ok, '   a sessão do suporte vale');

  tratou = await admin.handle('16175550000', '!fechar', async () => {});
  checar(!tratou, 'outros comandos de admin não valem para o suporte');
  tratou = await admin.handle('16175550000', 'quero 1 x tudo', async () => {});
  checar(!tratou, 'mensagem comum do suporte segue como conversa normal');

  // Aviso de alteração pelo painel.
  const express = require('express');
  const app = express();
  app.use(require(`${PROJECT}/src/api/painel`));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/painel/api`;
  const painelServico = require(`${PROJECT}/src/services/painel`);
  let quem = '16175550000';
  painelServico.conferirSessao = async () => ({ ok: true, phone: quem });
  const salvar = () => fetch(`${base}/config/schedule`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: '__Host-painel_session=ok' },
    body: JSON.stringify({ doc: { always_open: true } }) });

  enviados.length = 0;
  let r = await salvar();
  checar(r.status === 200, 'suporte salva no painel');
  checar(enviados.length === 1 && enviados[0].tel === '16175550000', '   o aviso vai só para o suporte');
  checar(!enviados.some((e) => ['16170000001', '17810000002'].includes(e.tel)), '   nenhum admin recebe');

  quem = '16170000001';
  enviados.length = 0;
  r = await salvar();
  checar(r.status === 200 && enviados.map((e) => e.tel).sort().join() === '16170000001,17810000002',
    'admin salva no painel: os admins recebem o aviso, como antes');
  checar(!enviados.some((e) => e.tel === '16175550000'), '   e o suporte não recebe');

  // Sem SUPORTE_PHONE: tudo como antes.
  process.env.SUPORTE_PHONE = '';
  tratou = await admin.handle('16175550000', '!painel', async () => {});
  checar(!tratou && !suporte.ehSuporte('16175550000'), 'sem SUPORTE_PHONE: o número não tem acesso');

  srv.close();
  console.log('\n\x1b[32msuportetest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
