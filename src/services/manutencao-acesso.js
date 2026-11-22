const crypto = require('crypto');

const log = require('../log');
const db = require('../db/queries');

/**
 * Entrada de manutenção no painel sem WhatsApp (docs/MANUTENCAO_ACESSO.md).
 *
 * O bot é um aparelho conectado ao WhatsApp da loja: tudo o que passa por ele
 * aparece no celular da loja. O suporte técnico entra por uma página própria,
 * com senha + código do autenticador (TOTP, RFC 6238), e recebe o mesmo link
 * de uso único do `!painel` — o resto do painel não muda.
 *
 * Variáveis: `MANUTENCAO_TOTP_SECRET` (base32), `MANUTENCAO_SENHA_HASH`
 * (scrypt, gerado por scripts/manutencao-gerar.js) e `MANUTENCAO_PHONE`.
 * Sem qualquer uma delas a página não existe.
 *
 * Nada aqui manda mensagem: entradas, erros e travas ficam só no log.
 */

const PASSO_S = 30;
const DIGITOS = 6;
const TRAVA_CURTA = { falhas: 5, ms: 15 * 60 * 1000 };
const TRAVA_LONGA = { falhas: 20, janelaMs: 24 * 60 * 60 * 1000, ms: 24 * 60 * 60 * 1000 };
const CHAVE_TRAVA = 'manutencao_trava';
const CHAVE_PASSO = 'manutencao_totp_ultimo';
const SCRYPT = { N: 16384, r: 8, p: 1 };

// ------------------------------------------------------------------ base32

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Codificar(buf) {
  let bits = 0;
  let valor = 0;
  let saida = '';
  for (const byte of buf) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      saida += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) saida += ALFABETO[(valor << (5 - bits)) & 31];
  return saida;
}

function base32Decodificar(texto) {
  const limpo = String(texto || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let valor = 0;
  const bytes = [];
  for (const c of limpo) {
    const i = ALFABETO.indexOf(c);
    if (i === -1) return null;
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// -------------------------------------------------------------------- TOTP

function codigoDoPasso(segredo, passo) {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(passo));
  const hmac = crypto.createHmac('sha1', segredo).update(contador).digest();
  const deslocamento = hmac[hmac.length - 1] & 15;
  const numero = (hmac.readUInt32BE(deslocamento) & 0x7fffffff) % (10 ** DIGITOS);
  return String(numero).padStart(DIGITOS, '0');
}

function passoAtual(agora = Date.now()) {
  return Math.floor(agora / 1000 / PASSO_S);
}

/** O passo (±1, tolerância de relógio) em que o código vale, ou null. */
function passoDoCodigo(segredo, codigo, agora = Date.now()) {
  const c = String(codigo || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const atual = passoAtual(agora);
  let achado = null;
  for (const p of [atual - 1, atual, atual + 1]) {
    // Compara os três sempre, sem sair no primeiro: o tempo não diz qual bateu.
    if (crypto.timingSafeEqual(Buffer.from(codigoDoPasso(segredo, p)), Buffer.from(c))) achado = p;
  }
  return achado;
}

// ------------------------------------------------------------------- senha

function gerarHashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(senha), sal, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${sal.toString('base64')}$${hash.toString('base64')}`;
}

function lerHash(texto) {
  const partes = String(texto || '').trim().split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return null;
  const [N, r, p] = partes.slice(1, 4).map(Number);
  const sal = Buffer.from(partes[4], 'base64');
  const hash = Buffer.from(partes[5], 'base64');
  if (![N, r, p].every(Number.isInteger) || sal.length < 16 || hash.length !== 32) return null;
  return { N, r, p, sal, hash };
}

function senhaConfere(senha, hashTexto) {
  const h = lerHash(hashTexto);
  if (!h) return false;
  const calculado = crypto.scryptSync(String(senha || ''), h.sal, 32, { N: h.N, r: h.r, p: h.p });
  return crypto.timingSafeEqual(calculado, h.hash);
}

// ----------------------------------------------------------- configuração

function segredo() {
  const s = base32Decodificar(process.env.MANUTENCAO_TOTP_SECRET);
  return s && s.length >= 16 ? s : null;
}

function telefone() {
  return require('./suporte').numeros()[0] || null;
}

/** A página só existe com as três variáveis e o painel ligado. */
function habilitado() {
  return Boolean(segredo() && lerHash(process.env.MANUTENCAO_SENHA_HASH) && telefone() &&
    require('./painel').habilitado());
}

// ------------------------------------------------------------------ travas

// A trava é POR ORIGEM (IP), não geral: com trava geral, quem achasse o
// endereço errava 20 vezes de propósito e deixava o suporte de fora por 24 h
// (revisão de segurança, 22/11). Contra muitos IPs, quem protege é a senha
// longa + o código, não a trava. O IP fica só como impressão (HMAC), nunca puro.
const MAX_ORIGENS = 500;

/**
 * IPv6 conta pelo bloco /64: quem tem um bloco tem milhões de endereços, e cada
 * um viraria uma origem nova (revisão, 22/11). IPv4 (inclusive "::ffff:1.2.3.4")
 * conta pelo endereço.
 */
function blocoDe(ip) {
  const s = String(ip || 'desconhecido').trim().toLowerCase();
  if (!s.includes(':') || /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(s)) return s.replace(/^::ffff:/, '');
  const [cabeca, cauda = ''] = s.split('::');
  const a = cabeca ? cabeca.split(':') : [];
  const b = cauda ? cauda.split(':') : [];
  const grupos = s.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return `${grupos.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

function origemDe(ip) {
  const chave = process.env.MANUTENCAO_TOTP_SECRET || 'manutencao';
  return crypto.createHmac('sha256', chave).update(blocoDe(ip)).digest('base64url').slice(0, 22);
}

/** Travas gravadas no banco, por origem. Banco fora → erro (quem chama recusa). */
async function lerTravasOuFalha() {
  const bruto = await db.getSetting(CHAVE_TRAVA);
  let t = {};
  try { t = JSON.parse(bruto || '{}') || {}; } catch { t = {}; }
  // Formato antigo (uma trava só, sem origem) é descartado.
  return t && typeof t === 'object' && !Array.isArray(t) && !('seguidas' in t) ? t : {};
}

function travaDa(travas, origem) {
  const t = travas[origem] || {};
  return { seguidas: Number(t.seguidas) || 0, ate: Number(t.ate) || 0, falhas: Array.isArray(t.falhas) ? t.falhas : [] };
}

/**
 * Tira origens sem trava ativa e sem falha recente; no máximo MAX_ORIGENS sem
 * trava. Trava ativa nunca sai: senão, um ataque com muitos IPs novos
 * "empurrava" para fora uma origem travada (revisão, 22/11). Elas não crescem
 * sem fim porque o disjuntor geral fecha antes.
 */
function podar(travas, agora) {
  const recente = (t) => (t.falhas || []).some((f) => f > agora - TRAVA_LONGA.janelaMs);
  const entradas = Object.entries(travas).filter(([k]) => k !== GERAL);
  const travadas = entradas.filter(([, t]) => (Number(t.ate) || 0) > agora);
  const livres = entradas.filter(([, t]) => !((Number(t.ate) || 0) > agora) && recente(t))
    .sort((a, b) => Math.max(0, ...(b[1].falhas || [])) - Math.max(0, ...(a[1].falhas || [])))
    .slice(0, MAX_ORIGENS);
  const saida = Object.fromEntries([...travadas, ...livres]);
  if (travas[GERAL]) saida[GERAL] = travas[GERAL];
  return saida;
}

// Disjuntor geral: muitas falhas somando todas as origens (IPs trocados ou
// falsificados) fecham a entrada para todos por um tempo. Alto de propósito:
// só um ataque sustentado chega lá, e o `!painel` pelo WhatsApp fica de reserva.
const GERAL = '_geral';
const DISJUNTOR = { falhasHora: 100, ms: 60 * 60 * 1000 };

function falhasNaHora(travas, agora) {
  return Object.entries(travas).filter(([k]) => k !== GERAL)
    .reduce((s, [, t]) => s + (t.falhas || []).filter((f) => f > agora - 60 * 60 * 1000).length, 0);
}

// Uma tentativa por vez: duas em paralelo não podem passar da trava juntas.
let fila = Promise.resolve();
function emFila(fn) {
  const vez = fila.then(fn, fn);
  fila = vez.catch(() => {});
  return vez;
}

/**
 * Confere senha e código. Devolve `{ ok, motivo }`:
 * `ok` | `desligado` | `travado` (com `ate`) | `invalido` | `indisponivel`.
 */
function entrar(dados, agora = Date.now()) {
  return emFila(async () => {
    if (!habilitado()) return { ok: false, motivo: 'desligado' };
    try {
      return await conferir(dados || {}, agora);
    } catch (err) {
      // Banco fora: recusa. Melhor não entrar do que entrar sem a trava.
      log.error({ evt: 'manutencao', err }, 'falha na entrada de manutenção');
      return { ok: false, motivo: 'indisponivel' };
    }
  });
}

async function conferir({ senha, codigo, ip }, agora) {
  const origem = origemDe(ip);
  const travas = await lerTravasOuFalha();
  const geral = Number(travas[GERAL]?.ate) || 0;
  if (geral > agora) {
    log.error({ evt: 'manutencao', origem, ate: new Date(geral).toISOString() }, 'entrada de manutenção fechada pelo disjuntor geral');
    return { ok: false, motivo: 'travado', ate: geral };
  }
  const trava = travaDa(travas, origem);
  if (trava.ate > agora) {
    log.warn({ evt: 'manutencao', origem, ate: new Date(trava.ate).toISOString() }, 'entrada de manutenção travada');
    return { ok: false, motivo: 'travado', ate: trava.ate };
  }

  // Os dois sempre, para o tempo de resposta não dizer qual errou.
  const senhaOk = senhaConfere(senha, process.env.MANUTENCAO_SENHA_HASH);
  const passo = passoDoCodigo(segredo(), codigo, agora);
  const ultimo = Number(await db.getSetting(CHAVE_PASSO)) || 0;
  const codigoOk = passo !== null && passo > ultimo;

  if (senhaOk && codigoOk) {
    await db.setSetting(CHAVE_PASSO, String(passo));
    travas[origem] = { seguidas: 0, ate: 0, falhas: trava.falhas };
    await db.setSetting(CHAVE_TRAVA, JSON.stringify(podar(travas, agora)));
    log.info({ evt: 'manutencao', origem }, 'entrada de manutenção no painel');
    return { ok: true };
  }

  trava.seguidas += 1;
  trava.falhas = [...trava.falhas.filter((t) => t > agora - TRAVA_LONGA.janelaMs), agora];
  if (trava.falhas.length >= TRAVA_LONGA.falhas) {
    trava.ate = agora + TRAVA_LONGA.ms;
    trava.seguidas = 0;
  } else if (trava.seguidas >= TRAVA_CURTA.falhas) {
    trava.ate = agora + TRAVA_CURTA.ms;
    trava.seguidas = 0;
  }
  travas[origem] = trava;
  // Conta antes da poda: origem descartada também conta para o disjuntor.
  const falhasHora = falhasNaHora(travas, agora);
  if (falhasHora >= DISJUNTOR.falhasHora) {
    travas[GERAL] = { ate: agora + DISJUNTOR.ms };
    log.error({ evt: 'manutencao', falhasHora }, 'disjuntor geral da entrada de manutenção: fechada por 1 hora');
  }
  const podadas = podar(travas, agora);
  await db.setSetting(CHAVE_TRAVA, JSON.stringify(podadas));
  log.warn({ evt: 'manutencao', origem, seguidas: trava.seguidas, noDia: trava.falhas.length, falhasHora,
    travou: trava.ate > agora, repetido: passo !== null && !codigoOk }, 'entrada de manutenção recusada');
  return { ok: false, motivo: 'invalido' };
}

module.exports = {
  entrar,
  habilitado,
  telefone,
  gerarHashSenha,
  senhaConfere,
  base32Codificar,
  base32Decodificar,
  codigoDoPasso,
  passoAtual,
  TRAVA_CURTA,
  TRAVA_LONGA,
  DISJUNTOR,
  podar,
  blocoDe,
};
