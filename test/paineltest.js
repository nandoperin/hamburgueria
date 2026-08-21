/**
 * O acesso ao painel.
 *
 * O painel edita preço e cardápio numa URL pública, sem senha — a confiança
 * inteira mora no token. Estes testes travam as propriedades que fazem isso ser
 * defensável: assinatura inforjável, validade curta, uso único do link, e a
 * porta fechando quando o segredo falta.
 *
 * Nada aqui precisa de banco nem de rede: o token é autocontido de propósito.
 */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://loja.test';
process.env.PAINEL_SECRET = 'x'.repeat(40);

const PROJECT = require('path').resolve(__dirname, '..');
const painel = require(`${PROJECT}/src/services/painel`);

const DONO = '16174449612';

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const tokenDe = (url) => new URL(url).searchParams.get('t');

(async () => {
  // ------------------------------------------------------------ 1. o caminho
  console.log('\n\x1b[36m### 1. LINK VALIDO ABRE UMA VEZ ###\x1b[0m');
  painel.zerar();

  const link = painel.criarLink(DONO);
  checar(link.ok, 'o link e gerado para o dono');
  checar(link.url.startsWith('https://loja.test/painel?t='), 'aponta para o BASE_URL');

  const t = tokenDe(link.url);
  const aberto = painel.abrir(t);
  checar(aberto.ok, 'abre na primeira vez');
  checar(Boolean(aberto.sessao), 'e devolve uma sessao para a pagina usar');
  checar(
    aberto.sessao !== t,
    'a sessao NAO e o token do link — o do WhatsApp queima, o da pagina fica na memoria'
  );

  // --------------------------------------------------------- 2. o uso único
  console.log('\n\x1b[36m### 2. O MESMO LINK NAO ABRE DUAS VEZES ###\x1b[0m');
  const segunda = painel.abrir(t);
  checar(!segunda.ok && segunda.motivo === 'ja_usado', 'a segunda abertura e recusada');
  checar(
    painel.conferirSessao(aberto.sessao).ok,
    'mas a sessao ja aberta continua valendo — o dono nao e expulso no meio da edicao'
  );

  // --------------------------------------------------------- 3. forjar
  console.log('\n\x1b[36m### 3. FORJAR NAO FUNCIONA ###\x1b[0m');
  const outro = painel.criarLink(DONO);
  const bom = tokenDe(outro.url);
  const [tipo, phone, expira, id, assinatura] = bom.split('.');

  checar(
    !painel.abrir(`${tipo}.${phone}.${expira}.${id}.${'A'.repeat(assinatura.length)}`).ok,
    'assinatura trocada e recusada'
  );
  checar(
    !painel.abrir(`${tipo}.19999999999.${expira}.${id}.${assinatura}`).ok,
    'trocar o telefone invalida — a assinatura cobre o telefone'
  );
  checar(
    !painel.abrir(`${tipo}.${phone}.${Date.now() + 9e9}.${id}.${assinatura}`).ok,
    'esticar a validade invalida — a assinatura cobre a expiracao'
  );
  checar(!painel.abrir('qualquer.coisa').ok, 'lixo e recusado sem quebrar');
  checar(!painel.abrir('').ok, 'vazio e recusado');
  checar(!painel.abrir(null).ok, 'null e recusado');

  // ------------------------------------------------- 4. link != sessao
  console.log('\n\x1b[36m### 4. UM TOKEN NAO SERVE PARA O OUTRO ###\x1b[0m');
  const l2 = painel.criarLink(DONO);
  const t2 = tokenDe(l2.url);
  checar(
    !painel.conferirSessao(t2).ok,
    'token de link nao vale como sessao — o tipo faz parte da assinatura'
  );
  const a2 = painel.abrir(t2);
  checar(!painel.abrir(a2.sessao).ok, 'e token de sessao nao abre a pagina');

  // ---------------------------------------------------------- 5. expiração
  console.log('\n\x1b[36m### 5. VALIDADE ###\x1b[0m');
  const agora = Date.now;
  const l3 = painel.criarLink(DONO);
  Date.now = () => agora() + painel.LINK_TTL_MS + 1000;
  checar(!painel.abrir(tokenDe(l3.url)).ok, 'link vencido nao abre');

  Date.now = () => agora() + painel.SESSAO_TTL_MS + 1000;
  checar(!painel.conferirSessao(aberto.sessao).ok, 'sessao vencida nao salva');
  Date.now = agora;

  // ------------------------------------------- 6. segredo que falta fecha
  console.log('\n\x1b[36m### 6. SEM SEGREDO, A PORTA FECHA ###\x1b[0m');
  const l4 = painel.criarLink(DONO);
  const t4 = tokenDe(l4.url);

  process.env.PAINEL_SECRET = '';
  checar(!painel.habilitado(), 'sem PAINEL_SECRET o painel se declara desabilitado');
  checar(!painel.criarLink(DONO).ok, 'e recusa gerar link');
  checar(!painel.abrir(t4).ok, 'link legitimo tambem nao abre — fecha, nao abre');

  // Segredo curto e o mesmo que segredo nenhum: um HMAC de 4 caracteres nao
  // protege coisa alguma, e "esta configurado" nao pode ser a checagem.
  process.env.PAINEL_SECRET = 'curto';
  checar(!painel.habilitado(), 'segredo curto demais tambem nao habilita');

  process.env.PAINEL_SECRET = 'x'.repeat(40);

  // ------------------------------------------- 7. trocar o segredo derruba
  console.log('\n\x1b[36m### 7. TROCAR O SEGREDO INVALIDA TUDO ###\x1b[0m');
  const l5 = painel.criarLink(DONO);
  process.env.PAINEL_SECRET = 'y'.repeat(40);
  checar(
    !painel.abrir(tokenDe(l5.url)).ok,
    'link emitido com o segredo antigo para de valer — e a saida se um vazar'
  );

  console.log('\n\x1b[32mpaineltest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
