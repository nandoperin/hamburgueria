/** Acesso opaco, persistente, revogável e de uso único do painel. */

process.env.DATABASE_URL = 'postgresql://fake';
process.env.BASE_URL = 'https://loja.test';
process.env.PAINEL_SECRET = 'x'.repeat(40);
process.env.ADMIN_PHONE = '16174449612,17815022706';
process.env.LOG_LEVEL = 'silent';

const PROJECT = require('path').resolve(__dirname, '..');
const db = require(`${PROJECT}/src/db/queries`);

// Banco persistente de mentira: permanece mesmo quando o módulo do serviço é
// recarregado, reproduzindo um restart sem abrir conexão externa.
const registros = new Map();
db.garantirTabelaPainelAcesso = async () => {};
db.limparAcessosPainelExpirados = async () => {};
db.salvarLinkPainel = async (hash, phone, expira) => {
  registros.set(hash, { tipo: 'link', phone, expira: +expira, usado: false });
  return { phone };
};
db.consumirLinkPainel = async (linkHash, sessaoHash, sessaoExpira, admins) => {
  const link = registros.get(linkHash);
  if (!link || link.tipo !== 'link' || link.usado || link.expira <= Date.now()) return null;
  link.usado = true;
  if (!admins.includes(link.phone)) return null;
  registros.set(sessaoHash, { tipo: 'sessao', phone: link.phone, expira: +sessaoExpira, usado: false });
  return { phone: link.phone };
};
db.getSessaoPainel = async (hash) => {
  const r = registros.get(hash);
  return r && r.tipo === 'sessao' && !r.usado && r.expira > Date.now() ? { phone: r.phone } : null;
};
db.revogarAcessoPainel = async (hash) => { const r = registros.get(hash); if (r) r.usado = true; };

let painel = require(`${PROJECT}/src/services/painel`);
const DONO = '16174449612';
const tokenDe = (url) => new URL(url).searchParams.get('t');

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  console.log('\n\x1b[36m### 1. LINK OPACO E DE USO UNICO ###\x1b[0m');
  registros.clear();
  const link = await painel.criarLink(DONO);
  const token = tokenDe(link.url);
  checar(link.ok && /^[A-Za-z0-9_-]{43}$/.test(token), 'link contém somente token aleatório');
  checar(!link.url.includes(DONO), 'telefone do admin não aparece na URL');

  const aberto = await painel.abrir(token);
  checar(aberto.ok && aberto.sessao !== token, 'primeira abertura cria outra credencial');
  checar(!(await painel.abrir(token)).ok, 'segunda abertura é recusada');
  checar((await painel.conferirSessao(aberto.sessao)).ok, 'sessão criada continua válida');

  console.log('\n\x1b[36m### 2. RESTART NÃO RESSUSCITA O LINK ###\x1b[0m');
  delete require.cache[require.resolve(`${PROJECT}/src/services/painel`)];
  painel = require(`${PROJECT}/src/services/painel`);
  checar(!(await painel.abrir(token)).ok, 'uso único sobrevive ao reinício do serviço');

  console.log('\n\x1b[36m### 3. ADMIN REMOVIDO É REVOGADO ###\x1b[0m');
  const antesDeRemover = await painel.criarLink(DONO);
  process.env.ADMIN_PHONE = '17815022706';
  checar(!(await painel.abrir(tokenDe(antesDeRemover.url))).ok,
    'link pendente de telefone removido não abre');
  checar(!(await painel.conferirSessao(aberto.sessao)).ok,
    'sessão aberta de telefone removido para imediatamente');
  checar(!(await painel.criarLink(DONO)).ok, 'telefone removido não recebe novo link');
  process.env.ADMIN_PHONE = `${DONO},17815022706`;

  console.log('\n\x1b[36m### 4. EXPIRAÇÃO E SEGREDO ###\x1b[0m');
  const agora = Date.now;
  const vence = await painel.criarLink(DONO);
  Date.now = () => agora() + painel.LINK_TTL_MS + 1;
  checar(!(await painel.abrir(tokenDe(vence.url))).ok, 'link vencido não abre');
  Date.now = agora;

  const segredoAntigo = await painel.criarLink(DONO);
  process.env.PAINEL_SECRET = 'y'.repeat(40);
  checar(!(await painel.abrir(tokenDe(segredoAntigo.url))).ok, 'trocar segredo invalida links antigos');
  checar(!(await painel.conferirSessao(aberto.sessao)).ok, 'trocar segredo invalida sessões antigas');

  process.env.PAINEL_SECRET = '';
  checar(!painel.habilitado() && !(await painel.criarLink(DONO)).ok, 'sem segredo a porta fecha');
  process.env.PAINEL_SECRET = 'curto';
  checar(!painel.habilitado(), 'segredo curto também fecha');
  process.env.PAINEL_SECRET = 'z'.repeat(40);
  checar(!(await painel.abrir('sessao.telefone.expira.assinatura')).ok,
    'credencial antiga com telefone é recusada');

  console.log('\n\x1b[32mpaineltest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
