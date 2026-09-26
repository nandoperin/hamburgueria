const { AwsClient } = require('aws4fetch');

const log = require('../log');
const pool = require('../db/client');
const notify = require('../bot/notify');

/**
 * Backup diário do banco para o Cloudflare R2 — o mesmo do espetinho
 * (`projeto atendimento`), com bucket e token próprios (dono, 26/09).
 *
 * ## Por que existe
 *
 * O plano Hobby do Railway não tem backup nem point-in-time recovery. Sem
 * isto, o volume do Postgres é cópia única: se ele se perder, perdem-se os
 * pedidos, os clientes e — o que mais dói — o cardápio, os preços, as cidades e
 * o horário que o dono editou no painel (`config_docs`).
 *
 * ## As três regras
 *
 * 1. **Sai do Railway.** Cópia no mesmo volume morre junto com ele.
 * 2. **É automático.** Um dump que depende de alguém lembrar não é backup.
 * 3. **Falha em voz alta.** Dois dias sem sucesso avisam o dono no WhatsApp.
 *
 * ## O que entra e o que não entra
 *
 * Entra tudo o que é do negócio. Ficam de fora só os acessos temporários
 * (link do painel, código de pareamento) e os aparelhos da impressora: restaurar
 * um acesso vencido ou revogado seria reabrir uma porta — refazer o pareamento
 * leva um minuto.
 */

// 03:00 em NY: depois do fechamento e antes da abertura.
const HORA_BACKUP = Number(process.env.BACKUP_HOUR) || 3;

// Confere de hora em hora se o backup do dia já saiu. A marca fica no banco:
// um temporizador de 24 h seria zerado a cada deploy.
const INTERVALO_MS = 60 * 60 * 1000;

const DIAS_ATE_ALARME = 2;
const CHAVE_ULTIMO = 'ultimo_backup';

// O que a aba Backups do painel mostra: cada tentativa, com sucesso ou falha.
// Guarda só os últimos 7 dias — a mesma janela dos arquivos no R2 (dono, 26/09).
const CHAVE_HISTORICO = 'historico_backup';
const DIAS_NO_HISTORICO = 7;

// Em ordem de dependência: `orders` referencia `customers`, `payments`
// referencia `orders`.
const TABELAS = [
  'customers', 'orders', 'payments',
  'bot_settings', 'item_availability', 'ai_usage',
  'config_docs', 'config_historico', 'conversas_log',
];

let timer = null;

const fuso = () => process.env.TZ_LOJA || 'America/New_York';

function hojeNoFuso(quando = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso(), year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(quando);
}

function horaNoFuso(quando = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: fuso(), hour: 'numeric', hour12: false,
  }).format(quando)) % 24;
}

// ---------------------------------------------------------------- o conteúdo

async function linhas(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * Os `INSERT` de uma tabela, com o escape feito pelo próprio Postgres
 * (`quote_nullable` resolve aspas, NULL e acento). Colunas json voltam como
 * estrutura, não como texto.
 */
async function dumpTabela(tabela) {
  const colunas = await linhas(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [tabela]
  );
  if (!colunas.length) return `-- tabela ${tabela} não encontrada\n\n`;

  const nomes = colunas.map((c) => `"${c.column_name}"`);
  const valores = colunas
    .map((c) => (c.data_type === 'jsonb' || c.data_type === 'json'
      ? `quote_nullable("${c.column_name}"::text) || '::${c.data_type}'`
      : `quote_nullable("${c.column_name}")`))
    .join(` || ',' || `);

  const registros = await linhas(
    `SELECT 'INSERT INTO ${tabela} (${nomes.join(',')}) VALUES (' || ${valores} || ');' AS sql
       FROM ${tabela}`
  );

  const cabecalho = `-- ${tabela}: ${registros.length} registro(s)\n`;
  if (!registros.length) return `${cabecalho}\n`;
  return `${cabecalho}${registros.map((l) => l.sql).join('\n')}\n\n`;
}

/**
 * O arquivo completo. Termina ajustando os contadores de id: inserir `id`
 * explícito não avança a sequência, e o primeiro pedido depois de restaurar
 * nasceria com id 1, colidindo com um que já existe.
 */
async function gerarDump() {
  const partes = [
    '-- Backup do banco da Point Burger',
    `-- Gerado em ${new Date().toISOString()}`,
    '--',
    '-- Restauração: rode src/db/schema.sql primeiro, depois este arquivo.',
    '-- Os contadores de id são ajustados no fim — não remova essas linhas.',
    '',
  ];

  for (const tabela of TABELAS) partes.push(await dumpTabela(tabela));

  partes.push('-- Contadores de id: sem isto o próximo registro colide com um id existente.');
  for (const tabela of ['customers', 'orders', 'payments', 'config_historico', 'conversas_log']) {
    partes.push(
      `SELECT setval(pg_get_serial_sequence('${tabela}', 'id'), ` +
      `(SELECT COALESCE(MAX(id), 1) FROM ${tabela}));`
    );
  }
  partes.push('');
  return partes.join('\n');
}

// ------------------------------------------------------------------ o envio

function configurado() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET
  );
}

/**
 * Endereço do R2 a partir do `R2_ACCOUNT_ID`. Aceita o id sozinho ou a URL
 * inteira que a Cloudflare mostra — colar a URL produzia `https://https://...`
 * no espetinho, com um erro que não apontava para variável nenhuma.
 */
function enderecoBase() {
  const bruto = String(process.env.R2_ACCOUNT_ID || '').trim();
  if (/^https?:\/\//i.test(bruto)) return `https://${new URL(bruto).host}`;
  if (bruto.includes('.')) return `https://${bruto.replace(/\/.*$/, '')}`;
  return `https://${bruto}.r2.cloudflarestorage.com`;
}

async function enviarParaR2(nome, conteudo) {
  const cliente = new AwsClient({
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });

  const resposta = await cliente.fetch(`${enderecoBase()}/${process.env.R2_BUCKET}/${nome}`, {
    method: 'PUT',
    body: conteudo,
    headers: { 'content-type': 'application/sql; charset=utf-8' },
  });

  if (!resposta.ok) {
    const corpo = await resposta.text().catch(() => '');
    throw new Error(`R2 respondeu ${resposta.status}: ${corpo.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------- histórico

async function lerHistorico() {
  try {
    const bruto = await require('../db/queries').getSetting(CHAVE_HISTORICO);
    const lista = JSON.parse(bruto || '[]');
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

/** Anota a tentativa e descarta o que passou de 7 dias. Nunca derruba o backup. */
async function anotar(entrada, agora = new Date()) {
  try {
    const limite = hojeNoFuso(new Date(agora.getTime() - DIAS_NO_HISTORICO * 86400000));
    const lista = (await lerHistorico()).filter((e) => e.data > limite);
    lista.push(entrada);
    await require('../db/queries').setSetting(CHAVE_HISTORICO, JSON.stringify(lista.slice(-50)));
  } catch (err) {
    log.warn({ evt: 'backup', err }, 'não consegui anotar o histórico do backup');
  }
}

/** Para a aba Backups do painel: o mais recente primeiro, só os últimos 7 dias. */
async function historico(agora = new Date()) {
  const limite = hojeNoFuso(new Date(agora.getTime() - DIAS_NO_HISTORICO * 86400000));
  const entradas = (await lerHistorico()).filter((e) => e.data > limite).reverse();
  return {
    configurado: configurado(),
    bucket: process.env.R2_BUCKET || null,
    hora: HORA_BACKUP,
    dias: DIAS_NO_HISTORICO,
    entradas,
  };
}

// ------------------------------------------------------------------ execução

async function avisarDono(texto) {
  const paraEle = require('../texto').paraAdmin(texto);
  for (const admin of notify.admins()) await notify.send(admin, paraEle);
}

/** Executa agora, independente do horário. Usado pelo `!backup agora`. */
async function executar() {
  if (!configurado()) {
    throw new Error(
      'R2 não configurado — faltam R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, ' +
        'R2_SECRET_ACCESS_KEY ou R2_BUCKET'
    );
  }

  const nome = `hamburgueria-${hojeNoFuso()}.sql`;
  try {
    const dump = await gerarDump();
    await enviarParaR2(nome, dump);

    await require('../db/queries').setSetting(CHAVE_ULTIMO, hojeNoFuso());

    const tamanho = Buffer.byteLength(dump, 'utf8');
    log.info({ evt: 'backup', arquivo: nome, bytes: tamanho }, `backup enviado: ${nome}`);
    await anotar({ data: hojeNoFuso(), quando: new Date().toISOString(), arquivo: nome, bytes: tamanho, ok: true });
    return { nome, tamanho };
  } catch (err) {
    await anotar({ data: hojeNoFuso(), quando: new Date().toISOString(), arquivo: nome, ok: false,
      erro: String(err.message || err).slice(0, 200) });
    throw err;
  }
}

/** De hora em hora: já passou das 3h e o backup de hoje ainda não saiu? */
async function verificar(agora = new Date()) {
  if (!configurado()) return { pulado: 'nao-configurado' };
  if (horaNoFuso(agora) < HORA_BACKUP) return { pulado: 'cedo' };

  const db = require('../db/queries');
  const hoje = hojeNoFuso(agora);
  const ultimo = await db.getSetting(CHAVE_ULTIMO);
  if (ultimo === hoje) return { pulado: 'ja-feito' };

  try {
    const { nome, tamanho } = await executar();
    return { feito: true, nome, tamanho };
  } catch (err) {
    log.error({ evt: 'backup', err }, 'falha ao gerar ou enviar o backup');

    // Uma falha isolada pode ser rede; dias seguidos é não ter backup.
    const diasSemBackup = ultimo
      ? Math.round((new Date(hoje) - new Date(ultimo)) / 86400000)
      : DIAS_ATE_ALARME;

    if (diasSemBackup >= DIAS_ATE_ALARME) {
      await avisarDono(
        `⚠️ *BACKUP FALHANDO*\n\n` +
          `Sem backup bem-sucedido ${ultimo ? `desde ${ultimo}` : 'nenhuma vez ainda'}.\n\n` +
          `Motivo: ${err.message}\n\n` +
          `_O bot segue funcionando normalmente — o que está em risco é a cópia de segurança._`
      ).catch(() => {});
    }
    return { erro: err.message, diasSemBackup };
  }
}

/** Resposta do comando `!backup`. */
async function resumo() {
  if (!configurado()) {
    return (
      '⚠️ *Backup não configurado.*\n\n' +
      'Faltam as variáveis do R2 no Railway:\n' +
      'R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET'
    );
  }

  const ultimo = await require('../db/queries').getSetting(CHAVE_ULTIMO);
  if (!ultimo) return '⚠️ *Nenhum backup feito ainda.*\n\n_Use *!backup agora* para forçar um._';

  const dias = Math.round((new Date(hojeNoFuso()) - new Date(ultimo)) / 86400000);
  const estado = dias === 0 ? '✅ feito hoje' : dias === 1 ? '⏳ ontem' : `⚠️ há ${dias} dias`;

  return (
    `💾 *BACKUP*\n\n` +
    `Último: *${ultimo}* — ${estado}\n` +
    `Destino: R2 (${process.env.R2_BUCKET})\n\n` +
    `_Roda sozinho às ${HORA_BACKUP}h. Para forçar: *!backup agora*_`
  );
}

function start() {
  if (timer) return;
  if (!configurado()) {
    log.warn({ evt: 'boot' }, 'backup desativado — variáveis do R2 não configuradas');
    return;
  }

  timer = setInterval(() => {
    verificar().catch((err) => log.error({ evt: 'backup', err }, 'falha no ciclo de backup'));
  }, INTERVALO_MS);
  timer.unref();

  // No boot: se o processo passou o dia fora, não espera a próxima hora cheia.
  verificar().catch(() => {});
  log.info({ evt: 'boot', hora: HORA_BACKUP }, `backup diário ativo — ${HORA_BACKUP}h para o R2`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  executar, verificar, resumo, historico, gerarDump, configurado, start, stop,
  HORA_BACKUP, CHAVE_ULTIMO, CHAVE_HISTORICO, TABELAS,
};
