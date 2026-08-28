const express = require('express');

const log = require('../log');
const db = require('../db/queries');
const config = require('../services/config');
const painel = require('../services/painel');
const pagina = require('./painel-page');

const router = express.Router();

/**
 * O painel do dono: cardápio, preços, entrega, horário e relatórios.
 *
 * ## O que ele NÃO toca
 *
 * Só os documentos de `config.DOCS` — `menu`, `ingredientes`, `delivery`,
 * `schedule`, `faq`. Pagamento, `ADMIN_PHONE` e tokens não estão lá, e a
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

router.get('/painel', (req, res) => {
  if (!exigirPainel(req, res)) return;

  const aberto = painel.abrir(req.query.t);

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

  res.set('Cache-Control', 'no-store');
  // Nada externo carrega: o painel e auto-suficiente, e o CSP e o cinto para o
  // caso de algum texto de config chegar com marcacao junto.
  res.set(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
      "connect-src 'self'; form-action 'none'; frame-ancestors 'none'"
  );
  res.set('Referrer-Policy', 'no-referrer');
  res.type('html').send(pagina.render(aberto.sessao, aberto.minutos));
});

// --------------------------------------------------------------------- api

/** Toda rota de dados passa por aqui. */
function autenticar(req, res, next) {
  if (!painel.habilitado()) return res.status(503).json({ erro: 'painel_indisponivel' });

  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const sessao = painel.conferirSessao(token);

  if (!sessao.ok) {
    return res.status(401).json({ erro: 'sessao_invalida', motivo: sessao.motivo });
  }

  req.painelPhone = sessao.phone;
  next();
}

const api = express.Router();
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
    await config.set(key, req.body?.doc, req.painelPhone);
    await avisarDono(key, req.painelPhone, req.body?.resumo);
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

const TZ = 'America/New_York';

/** Início do dia no fuso do estabelecimento, `dias` atrás. */
function inicioDoDia(dias = 0) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const d = new Date(`${partes}T00:00:00-05:00`);
  d.setDate(d.getDate() - dias);
  return d.toISOString();
}

const PERIODOS = { hoje: 0, semana: 7, mes: 30, trimestre: 90 };

api.get('/relatorio', async (req, res) => {
  const dias = PERIODOS[req.query.periodo] ?? 0;
  const de = inicioDoDia(dias);
  const ate = new Date().toISOString();

  try {
    const [resumo, porDia, porCidade, porHora, clientes] = await Promise.all([
      db.getReport(de, ate),
      db.getRevenueByDay(de, ate),
      db.getReportByCity(de, ate),
      db.getReportByHour(de, ate, TZ),
      db.getReportClientes(de, ate),
    ]);

    res.json({ periodo: req.query.periodo || 'hoje', resumo, porDia, porCidade, porHora, clientes });
  } catch (err) {
    log.error({ evt: 'painel', err }, 'falha ao montar relatorio');
    res.status(500).json({ erro: 'falha_no_relatorio' });
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
async function avisarDono(key, phone, resumo) {
  const admin = notify.dono();
  if (!admin) return;

  const texto = require('../texto');
  const notify = require('../bot/notify');
  const quem = String(phone || '').slice(-4);

  await notify
    .send(
      admin,
      texto.paraAdmin(
        `⚙️ *${key.toUpperCase()} ALTERADO PELO PAINEL*\n\n` +
          (resumo ? `${resumo}\n\n` : '') +
          `_Por +...${quem}. Se não foi você, alguém entrou com o seu link._`
      )
    )
    .catch(() => {
      // Melhor esforço: o aviso não pode desfazer uma gravação que já ocorreu.
    });
}

module.exports = router;
