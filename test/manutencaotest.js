/**
 * Entrada de manutenção no painel sem WhatsApp (docs/MANUTENCAO_ACESSO.md):
 * senha + código do autenticador, travas, código usado uma vez, e nenhuma
 * mensagem para ninguém.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.PAINEL_SECRET = 'x'.repeat(40);
process.env.BASE_URL = 'https://bot.teste';
process.env.ADMIN_PHONE = '16170000001';
process.env.MANUTENCAO_PHONE = '6175550000';
process.env.LOG_LEVEL = 'silent';

const PROJECT = require('path').resolve(__dirname, '..');
const crypto = require('crypto');
const settings = new Map();
const links = [];
let bancoFora = false;
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({
  getSetting: async (k) => { if (bancoFora) throw new Error('banco fora'); return settings.get(k) ?? null; },
  setSetting: async (k, v) => { settings.set(k, v); },
  salvarLinkPainel: async (hash, phone) => { links.push(phone); },
}, { get: (alvo, k) => alvo[k] || (async () => null) });

const enviados = [];
require(`${PROJECT}/src/bot/notify`).send = async (tel, msg) => { enviados.push({ tel, msg }); return true; };

const acesso = require(`${PROJECT}/src/services/manutencao-acesso`);
const limite = require(`${PROJECT}/src/api/limite`);
const SEGREDO = crypto.randomBytes(20);
const SENHA = 'uma senha bem comprida';

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}
const codigo = (deslocamento = 0, agora = Date.now()) => acesso.codigoDoPasso(SEGREDO, acesso.passoAtual(agora) + deslocamento);

(async () => {
  const express = require('express');
  const app = express();
  app.use(require(`${PROJECT}/src/api/painel`));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (senha, cod) => fetch(`${base}/painel/manutencao`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ senha, codigo: cod }).toString(),
  }).then(async (r) => ({ status: r.status, local: r.headers.get('location'), html: await r.text(), csp: r.headers.get('content-security-policy') }));

  // Sem as variáveis: a página não existe.
  let r = await fetch(`${base}/painel/manutencao`);
  checar(r.status === 404, 'sem as variáveis: 404');
  r = await post(SENHA, codigo());
  checar(r.status === 404, '   e o POST também');

  process.env.MANUTENCAO_TOTP_SECRET = acesso.base32Codificar(SEGREDO);
  process.env.MANUTENCAO_SENHA_HASH = acesso.gerarHashSenha(SENHA);
  checar(!process.env.MANUTENCAO_SENHA_HASH.includes(SENHA), 'o hash não contém a senha');

  r = await fetch(`${base}/painel/manutencao`);
  const html = await r.text();
  checar(r.status === 200 && /name="senha"/.test(html) && /name="codigo"/.test(html) && !/<script/.test(html),
    'página com senha e código, sem JavaScript');
  checar(/frame-ancestors 'none'/.test(r.headers.get('content-security-policy')) && r.headers.get('cache-control') === 'no-store',
    '   com os cabeçalhos de segurança');

  // Erros: a mesma mensagem.
  r = await post('senha errada', codigo());
  const erroSenha = r.html;
  checar(r.status === 401 && /Senha ou código inválido/.test(r.html), 'senha errada: recusa');
  r = await post(SENHA, '000000' === codigo() ? '111111' : '000000');
  checar(r.status === 401 && r.html === erroSenha, 'código errado: a mesma mensagem (não diz qual errou)');

  // Certo: o link de uso único do painel.
  links.length = 0;
  r = await post(SENHA, codigo());
  checar(r.status === 303 && /^\/painel\?t=[A-Za-z0-9_-]{43}$/.test(r.local), 'senha e código certos: vai para o painel');
  checar(links.at(-1) === '16175550000', '   a sessão é do número de manutenção');
  checar(enviados.length === 0, '   e nenhuma mensagem de WhatsApp para ninguém');
  r = await post(SENHA, codigo());
  checar(r.status === 401, 'o mesmo código não entra duas vezes');

  // Trava curta: 5 erros seguidos.
  settings.delete('manutencao_trava');
  limite.zerar();
  for (let i = 0; i < 5; i += 1) await post('errada', '123456');
  r = await post(SENHA, codigo(1));
  checar(r.status === 429 && /Muitas tentativas/.test(r.html), '5 erros seguidos: trava, nem a senha certa entra');
  checar(JSON.parse(settings.get('manutencao_trava')).ate > Date.now(), '   a trava fica no banco (sobrevive a deploy)');
  const daqui16 = Date.now() + 16 * 60 * 1000;
  const depois = await acesso.entrar({ senha: SENHA, codigo: codigo(0, daqui16) }, daqui16);
  checar(depois.ok, '   depois de 15 minutos, entra de novo');

  // Trava longa: 20 erros no dia.
  settings.delete('manutencao_trava');
  let t = Date.now() + 60 * 60 * 1000;
  for (let i = 0; i < 20; i += 1) {
    await acesso.entrar({ senha: 'errada', codigo: '123456' }, t);
    t += 16 * 60 * 1000; // passa a trava curta entre as rodadas
  }
  const trava = JSON.parse(settings.get('manutencao_trava'));
  checar(trava.ate - t > 20 * 60 * 60 * 1000, '20 erros em 24 horas: trava de 24 horas');
  const ainda = await acesso.entrar({ senha: SENHA, codigo: codigo(0, t + 60 * 60 * 1000) }, t + 60 * 60 * 1000);
  checar(ainda.motivo === 'travado', '   uma hora depois, ainda travado');

  // Banco fora: recusa.
  settings.delete('manutencao_trava');
  bancoFora = true;
  const fora = await acesso.entrar({ senha: SENHA, codigo: codigo(0, t + 2e8) }, t + 2e8);
  checar(fora.motivo === 'indisponivel', 'banco fora: não entra (sem trava, não abre)');
  bancoFora = false;

  // Alteração pelo suporte: nenhuma mensagem.
  const painelServico = require(`${PROJECT}/src/services/painel`);
  painelServico.conferirSessao = async () => ({ ok: true, phone: '16175550000' });
  require(`${PROJECT}/src/services/config`).set = async (key, doc) => ({ anterior: {}, doc });
  enviados.length = 0;
  r = await fetch(`${base}/painel/api/config/schedule`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: '__Host-painel_session=ok' },
    body: JSON.stringify({ doc: { always_open: true } }) });
  checar(r.status === 200 && enviados.length === 0, 'alteração do suporte no painel: nenhuma mensagem, nem para ele');

  srv.close();
  console.log('\n\x1b[32mmanutencaotest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
