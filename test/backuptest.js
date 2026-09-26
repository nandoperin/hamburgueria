/**
 * Backup diário para o R2 (dono, 26/09 — o mesmo do espetinho).
 *
 * O cenário que mais importa não é o backup funcionando: é ele falhando em
 * silêncio, que é como se descobre, no pior dia, que não havia backup.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.ADMIN_PHONE = '15550001111';
process.env.R2_ACCOUNT_ID = 'conta-de-teste';
process.env.R2_ACCESS_KEY_ID = 'chave-de-teste';
process.env.R2_SECRET_ACCESS_KEY = 'segredo-de-teste';
process.env.R2_BUCKET = 'hamburgueria-backups';

const PROJECT = require('path').resolve(__dirname, '..');
const ADMIN = '15550001111';

// Banco falso com dado que exercita o escape: aspas, acento e jsonb.
const consultas = [];
const linhas = {
  customers: [{ sql: "INSERT INTO customers (\"id\",\"name\") VALUES ('1','O''Brien Ação');" }],
  orders: [{ sql: `INSERT INTO orders ("id","items_json") VALUES ('1','[{"a":1}]'::jsonb);` }],
  config_docs: [{ sql: `INSERT INTO config_docs ("key","doc") VALUES ('menu','{"categories":[]}'::jsonb);` }],
};
const clientPath = require.resolve(`${PROJECT}/src/db/client`);
require(clientPath);
require.cache[clientPath].exports = {
  query: async (sql) => {
    consultas.push(sql);
    if (/information_schema/.test(sql)) {
      return { rows: [{ column_name: 'id', data_type: 'bigint' }, { column_name: 'items_json', data_type: 'jsonb' }] };
    }
    const tabela = (sql.match(/FROM (\w+)\s*$/) || [])[1];
    return { rows: linhas[tabela] || [] };
  },
};

const guardado = {};
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = {
  getSetting: async (k) => guardado[k] ?? null,
  setSetting: async (k, v) => { guardado[k] = v; },
};

let modoR2 = 'ok';
let enviados = [];
const a4Path = require.resolve('aws4fetch');
require(a4Path);
require.cache[a4Path].exports = {
  AwsClient: class {
    async fetch(url, opcoes) {
      if (modoR2 === 'erro') return { ok: false, status: 403, text: async () => 'AccessDenied' };
      enviados.push({ url, corpo: opcoes.body });
      return { ok: true, status: 200, text: async () => '' };
    }
  },
};

const avisos = [];
const notify = require(`${PROJECT}/src/bot/notify`);
notify.send = async (phone, texto) => { avisos.push({ phone, texto }); return true; };

const backup = require(`${PROJECT}/src/services/backup`);
const texto = require(`${PROJECT}/src/texto`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  // O conteúdo.
  const dump = await backup.gerarDump();
  checar(dump.includes('INSERT INTO customers') && dump.includes('INSERT INTO orders'), 'traz clientes e pedidos');
  checar(dump.includes('INSERT INTO config_docs'), 'e o cardápio, preços e cidades do painel (config_docs)');
  checar(dump.includes("O''Brien"), 'aspas escapadas pelo próprio Postgres');
  checar(dump.includes('::jsonb'), 'jsonb volta como estrutura');
  checar(dump.includes("setval(pg_get_serial_sequence('orders', 'id')"), 'ajusta o contador de id dos pedidos');
  checar(!backup.TABELAS.includes('painel_acessos') && !backup.TABELAS.includes('printer_devices') &&
    !backup.TABELAS.includes('printer_pairing_codes'), 'acessos do painel e da impressora ficam de fora');
  checar(consultas.every((s) => !/painel_acessos|printer_/.test(s)), '   e nem são lidos');

  // O envio.
  enviados = [];
  const r = await backup.executar();
  checar(enviados.length === 1 && enviados[0].url.includes('/hamburgueria-backups/'), 'envia um arquivo ao bucket configurado');
  checar(/hamburgueria-\d{4}-\d{2}-\d{2}\.sql$/.test(enviados[0].url), `com nome datado: ${r.nome}`);
  checar(Boolean(guardado[backup.CHAVE_ULTIMO]), 'a data do último backup fica gravada no banco');

  enviados = [];
  const pulado = await backup.verificar(new Date());
  checar(pulado.pulado === 'ja-feito' && !enviados.length, 'não refaz no mesmo dia');

  // Falha em voz alta.
  modoR2 = 'erro';
  avisos.length = 0;
  guardado[backup.CHAVE_ULTIMO] = '2026-08-01';
  const falhou = await backup.verificar(new Date());
  checar(falhou.erro && falhou.erro.includes('403'), 'a falha é reportada com o que o R2 respondeu');
  const alarme = avisos.find((a) => a.phone === ADMIN && /BACKUP FALHANDO/i.test(a.texto));
  checar(Boolean(alarme) && /bot segue funcionando/i.test(alarme.texto), 'o dono é avisado no WhatsApp');
  modoR2 = 'ok';

  // O id da conta aceita as formas que a Cloudflare mostra.
  for (const valor of ['abc123', 'https://abc123.r2.cloudflarestorage.com', 'https://abc123.r2.cloudflarestorage.com/', 'abc123.r2.cloudflarestorage.com']) {
    process.env.R2_ACCOUNT_ID = valor;
    enviados = [];
    await backup.executar();
    checar(new URL(enviados[0].url).host === 'abc123.r2.cloudflarestorage.com', `R2_ACCOUNT_ID "${valor}" funciona`);
  }
  process.env.R2_ACCOUNT_ID = 'conta-de-teste';

  // Histórico para a aba Backups do painel: só os últimos 7 dias.
  const hoje = new Date();
  const dia = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric',
    month: '2-digit', day: '2-digit' }).format(new Date(hoje.getTime() - n * 86400000));
  guardado[backup.CHAVE_HISTORICO] = JSON.stringify([
    { data: dia(10), quando: new Date(hoje.getTime() - 10 * 86400000).toISOString(), arquivo: 'velho.sql', bytes: 10, ok: true },
    { data: dia(3), quando: new Date(hoje.getTime() - 3 * 86400000).toISOString(), arquivo: 'recente.sql', bytes: 10, ok: true },
  ]);
  enviados = [];
  await backup.executar();
  let h = await backup.historico();
  checar(h.entradas[0].ok && h.entradas[0].arquivo === r.nome && h.entradas[0].bytes > 0, 'o backup feito entra no histórico, primeiro da lista');
  checar(h.entradas.some((e) => e.arquivo === 'recente.sql'), '   o de 3 dias atrás continua');
  checar(!h.entradas.some((e) => e.arquivo === 'velho.sql'), '   o de 10 dias atrás sai sozinho');
  checar(h.dias === 7 && h.bucket === 'hamburgueria-backups' && h.hora === backup.HORA_BACKUP, 'a aba recebe bucket, hora e a janela de 7 dias');

  modoR2 = 'erro';
  await backup.executar().catch(() => {});
  h = await backup.historico();
  checar(!h.entradas[0].ok && /403/.test(h.entradas[0].erro), 'a falha também aparece no histórico, com o motivo');
  modoR2 = 'ok';

  // Histórico corrompido não derruba o backup.
  guardado[backup.CHAVE_HISTORICO] = 'isto não é json';
  enviados = [];
  await backup.executar();
  checar(enviados.length === 1 && (await backup.historico()).entradas.length === 1, 'histórico ilegível recomeça, e o backup sai igual');

  // A aba no painel.
  const pagina = require(`${PROJECT}/src/api/painel-page`).render(15, 'nonce-teste');
  checar(pagina.includes("'💾 Backups'") && pagina.includes('Backup feito no Cloudflare R2, mantendo por '),
    'o painel tem a aba Backups com a descrição');

  // Sem R2 configurado, nada quebra.
  delete process.env.R2_BUCKET;
  checar(!backup.configurado(), 'detecta que falta configuração');
  const resp = await backup.resumo();
  checar(/nao configurado/i.test(texto.ascii(resp)) && resp.includes('R2_BUCKET'), '!backup explica o que falta');
  let recusou = false;
  try { await backup.executar(); } catch (err) { recusou = /configurado/.test(err.message); }
  checar(recusou, '!backup agora recusa em vez de fingir que salvou');

  console.log('\n\x1b[32mbackuptest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
