const express = require('express');
const crypto = require('crypto');

const log = require('../log');
const db = require('../db/queries');
const config = require('../services/config');
const datas = require('../services/datas');
const painel = require('../services/painel');
const pagina = require('./painel-page');
const { limitar } = require('./limite');

const router = express.Router();

/**
 * O painel do dono: cardápio, preços, entrega, horário e relatórios.
 *
 * ## O que ele NÃO toca
 *
 * Só os documentos de `config.DOCS` — `menu`, `promotions`, `ingredientes`,
 * `delivery` e `schedule`. Pagamento, `ADMIN_PHONE` e tokens não estão lá, e a
 * ausência é a defesa: quem editasse o destinatário do Zelle redirecionaria o
 * faturamento inteiro, com o bot entregando o dado novo educadamente para cada
 * cliente. Não há checagem de permissão para alguém afrouxar depois — a chave
 * simplesmente não existe.
 *
 * ## Autenticação
 *
 * Link de uso único pelo WhatsApp (`!painel`), que abre a página e queima. O
 * que a página usa depois vive só na memória do navegador. Ver
 * `services/painel.js`.
 */

/** Sem `PAINEL_SECRET`, a porta fecha — nunca abre. */
function exigirPainel(req, res) {
  if (painel.habilitado()) return true;
  log.error({ evt: 'painel' }, 'PAINEL_SECRET ausente — painel recusado');
  res.status(503).type('html').send(pagina.erro('Painel indisponível.'));
  return false;
}

// ------------------------------------------------------------------- página

router.get('/painel', limitar({ nome: 'painel-pagina', max: 60, janelaMs: 5 * 60 * 1000 }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  if (!exigirPainel(req, res)) return;

  const aberto = await painel.abrir(req.query.t);

  if (!aberto.ok) {
    // A mesma tela para link expirado, já usado ou forjado: dizer qual é
    // ajudaria quem está tentando adivinhar, e não ajuda o dono — para ele a
    // saída é a mesma, pedir outro.
    log.warn({ evt: 'painel', motivo: aberto.motivo }, 'acesso ao painel recusado');
    return res
      .status(401)
      .type('html')
      .send(
        pagina.erro(
          'Este link não vale mais.',
          'Mande <b>!painel</b> no WhatsApp para receber um novo.'
        )
      );
  }

  const nonce = crypto.randomBytes(16).toString('base64');
  // Nada externo carrega: o painel e auto-suficiente, e o CSP e o cinto para o
  // caso de algum texto de config chegar com marcacao junto.
  res.set(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; ` +
      "connect-src 'self'; form-action 'none'; frame-ancestors 'none'"
  );
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.set(
    'Set-Cookie',
    `__Host-painel_session=${encodeURIComponent(aberto.sessao)}; HttpOnly; Secure; ` +
      `SameSite=Strict; Path=/; Max-Age=${Math.floor(painel.SESSAO_TTL_MS / 1000)}`
  );
  res.type('html').send(pagina.render(aberto.minutos, nonce));
});

// --------------------------------------------------------------------- api

/** Toda rota de dados passa por aqui. */
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

async function autenticar(req, res, next) {
  if (!painel.habilitado()) return res.status(503).json({ erro: 'painel_indisponivel' });

  const token = cookie(req, '__Host-painel_session');
  const sessao = await painel.conferirSessao(token);

  if (!sessao.ok) {
    res.set('Set-Cookie', '__Host-painel_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
    if (sessao.motivo === 'painel_indisponivel') {
      return res.status(503).json({ erro: 'painel_indisponivel' });
    }
    return res.status(401).json({ erro: 'sessao_invalida' });
  }

  req.painelPhone = sessao.phone;
  next();
}

const api = express.Router();
api.use(limitar({ nome: 'painel-api', max: 300, janelaMs: 60 * 1000 }));
api.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.get('Sec-Fetch-Site') === 'cross-site') {
    return res.status(403).json({ erro: 'origem_recusada' });
  }
  next();
});
api.use(express.json({ limit: '512kb' }));
api.use(autenticar);

api.get('/config/:key', (req, res) => {
  try {
    res.json({ key: req.params.key, doc: config.get(req.params.key) });
  } catch (err) {
    res.status(404).json({ erro: 'documento_desconhecido' });
  }
});

api.post('/config/:key', async (req, res) => {
  const { key } = req.params;

  try {
    const salvo = await config.set(key, req.body?.doc, req.painelPhone);
    await avisarAdmins(key, req.painelPhone, salvo.anterior, salvo.doc);
    res.json({ ok: true, doc: config.get(key) });
  } catch (err) {
    // Erro de validação é do dono, e ele precisa ler o que está errado. Erro de
    // banco é nosso, e a mensagem crua não ajuda ninguém na tela.
    if (err.validacao) {
      return res.status(400).json({ erro: 'invalido', problemas: err.erros });
    }
    log.error({ evt: 'painel', doc: key, err }, 'falha ao salvar config');
    res.status(500).json({ erro: 'falha_ao_salvar' });
  }
});

// ------------------------------------------------------------- relatórios

const { TZ } = datas;

// O formato antigo (sem datas) segue aceito: uma página aberta antes da troca
// continua funcionando até o link vencer.
const PERIODOS = { hoje: 0, semana: 7, mes: 30, trimestre: 90 };

/**
 * O período pedido: `de` e `ate` em AAAA-MM-DD, no relógio da loja — "ontem"
 * é `de=ate=` a data de ontem. Sem datas, vale o `periodo` antigo ou hoje.
 */
function periodoDaConsulta(query) {
  if (query.de || query.ate) {
    const de = String(query.de || query.ate);
    return datas.intervaloDeDatas(de, String(query.ate || de));
  }
  const hoje = datas.dataLocal();
  const dias = PERIODOS[query.periodo] ?? 0;
  return datas.intervaloDeDatas(datas.somarDias(hoje, -dias), hoje);
}

api.get('/relatorio', async (req, res) => {
  const periodo = periodoDaConsulta(req.query);
  if (!periodo.ok) return res.status(400).json({ erro: 'periodo_invalido', motivo: periodo.motivo });
  const { inicio: de, fim: ate } = periodo;

  try {
    const [resumo, porDia, porCidade, porHora, clientes] = await Promise.all([
      db.getReport(de, ate),
      db.getRevenueByDay(de, ate, TZ),
      db.getReportByCity(de, ate),
      db.getReportByHour(de, ate, TZ),
      db.getReportClientes(de, ate),
    ]);

    res.json({ de: periodo.de, ate: periodo.ate, resumo, porDia, porCidade, porHora, clientes });
  } catch (err) {
    log.error({ evt: 'painel', err }, 'falha ao montar relatorio');
    res.status(500).json({ erro: 'falha_no_relatorio' });
  }
});

/** A aba "Deliverys": entregas do período, por cidade e uma a uma. */
api.get('/relatorio/entregas', async (req, res) => {
  const periodo = periodoDaConsulta(req.query);
  if (!periodo.ok) return res.status(400).json({ erro: 'periodo_invalido', motivo: periodo.motivo });

  try {
    const entregas = await db.getReportEntregas(periodo.inicio, periodo.fim);
    res.json({ de: periodo.de, ate: periodo.ate, ...entregas });
  } catch (err) {
    log.error({ evt: 'painel', err }, 'falha ao montar relatorio de entregas');
    res.status(500).json({ erro: 'falha_no_relatorio' });
  }
});

/** A aba "Conferência": Zelle do período, uma venda por linha. */
api.get('/relatorio/conferencia', async (req, res) => {
  const periodo = periodoDaConsulta(req.query);
  if (!periodo.ok) return res.status(400).json({ erro: 'periodo_invalido', motivo: periodo.motivo });

  try {
    const conferencia = await db.getReportZelle(periodo.inicio, periodo.fim);
    res.json({ de: periodo.de, ate: periodo.ate, ...conferencia });
  } catch (err) {
    log.error({ evt: 'painel', err }, 'falha ao montar conferencia de Zelle');
    res.status(500).json({ erro: 'falha_no_relatorio' });
  }
});

api.get('/conversas', async (req, res) => {
  try {
    res.json({ conversas: await db.getConversasRecentes() });
  } catch (err) {
    log.error({ evt: 'painel', err }, 'falha ao listar conversas');
    res.status(500).json({ erro: 'falha_ao_listar' });
  }
});

api.get('/pedidos', async (req, res) => {
  try {
    res.json({ pedidos: await db.getRecentOrders(30) });
  } catch (err) {
    log.error({ evt: 'painel', err }, 'falha ao listar pedidos');
    res.status(500).json({ erro: 'falha_ao_listar' });
  }
});

router.use('/painel/api', api);

// ------------------------------------------------------------------ aviso

/**
 * Toda mudança avisa no WhatsApp do dono.
 *
 * É o detector, não a tranca: não impede nada, faz aparecer. Se ele não mudou o
 * preço, descobre em segundos em vez de no fim do mês.
 *
 * A ressalva honesta, que o projeto irmão já documentou: um alarme entregue no
 * canal que o atacante controla não é alarme. Se for o próprio WhatsApp que
 * estiver comprometido, o aviso chega para quem fez. Contra isso o irmão usa o
 * papel — a impressora é um canal com dono diferente. Aqui ficou de fora por
 * ser mudança frequente, e comprovante repetido é o começo de ninguém mais ler
 * comprovante nenhum.
 */
async function avisarAdmins(key, phone, antes, depois) {
  const notify = require('../bot/notify');
  const admins = notify.admins();
  if (!admins.length) return;

  const texto = require('../texto');
  const quem = String(phone || '').slice(-4);
  // A comparação é do servidor. Não repetir nomes/chaves enviados pelo
  // navegador no alerta: até um admin legítimo pode colar conteúdo estranho.
  const mudou = JSON.stringify(antes) !== JSON.stringify(depois);
  const resumo = mudou
    ? 'O conteúdo foi alterado; a versão anterior ficou no histórico.'
    : 'O documento foi salvo sem diferença de conteúdo.';

  await Promise.allSettled(admins.map((admin) => notify.send(
      admin,
      texto.paraAdmin(
        `⚙️ *${key.toUpperCase()} ALTERADO PELO PAINEL*\n\n` +
          `${resumo}\n\n` +
          `_Por +...${quem}. Se não foi você, alguém entrou com o seu link._`
      )
    )));
}

module.exports = router;
