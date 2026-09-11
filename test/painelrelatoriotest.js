/**
 * Relatório do painel: período por data e a aba Deliverys.
 *
 * O painel só oferecia "hoje", "7 dias", "30 dias" e "90 dias" — o relatório
 * de ontem não tinha como ser consultado. Agora o período é De/até, no relógio
 * da loja, e a conversão para o banco (UTC) precisa acertar o horário de verão.
 *
 * O banco é um espião: nenhuma linha aqui toca Postgres, mas as consultas de
 * verdade rodam — o que se confere é o intervalo que chega a elas e a conta
 * que sai delas.
 */

process.env.DATABASE_URL = 'postgresql://fake';
process.env.BASE_URL = 'https://loja.test';
process.env.PAINEL_SECRET = 'x'.repeat(40);

const path = require('path');
const express = require('express');
const PROJECT = path.resolve(__dirname, '..');

// ------------------------------------------------------ o banco de mentira
const consultas = [];
let responder = () => ({ rows: [] });
const clientPath = require.resolve(`${PROJECT}/src/db/client`);
require(clientPath);
require.cache[clientPath].exports = {
  query: async (sql, params) => {
    consultas.push({ sql, params });
    return responder(sql, params);
  },
};

const datas = require(`${PROJECT}/src/services/datas`);
const db = require(`${PROJECT}/src/db/queries`);
const painel = require(`${PROJECT}/src/services/painel`);
const router = require(`${PROJECT}/src/api/painel`);
const pagina = require(`${PROJECT}/src/api/painel-page`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const ENTREGAS = [
  // 21h43 de 10/09 em Massachusetts — no UTC, já é dia 11.
  { id: 90, created_at: '2026-09-11 01:43:41.617+00', city: 'Everett', delivery_fee: 5, total: 25 },
  { id: 91, created_at: '2026-09-11 02:10:00+00', city: 'Chelsea', delivery_fee: 7, total: 31.5 },
  { id: 92, created_at: '2026-09-11 02:30:00+00', city: 'Everett', delivery_fee: 5, total: 19 },
];

(async () => {
  // ------------------------------------------------ 1. datas no fuso da loja
  console.log('\n\x1b[36m### 1. DATAS NO RELOGIO DA LOJA ###\x1b[0m');
  checar(datas.meiaNoite('2026-09-10').toISOString() === '2026-09-10T04:00:00.000Z',
    'no verao o dia comeca as 04h UTC');
  checar(datas.meiaNoite('2026-01-15').toISOString() === '2026-01-15T05:00:00.000Z',
    'no inverno, as 05h UTC');
  checar(datas.meiaNoite('2026-11-01').toISOString() === '2026-11-01T04:00:00.000Z' &&
    datas.meiaNoite('2026-11-02').toISOString() === '2026-11-02T05:00:00.000Z',
    'a troca do horario de verao cai no dia certo');
  const ontem = datas.intervaloDeDatas('2026-09-10', '2026-09-10');
  checar(ontem.ok && ontem.inicio === '2026-09-10T04:00:00.000Z' && ontem.fim === '2026-09-11T04:00:00.000Z',
    'um dia so vira o intervalo do dia inteiro');
  checar(!datas.intervaloDeDatas('2026-02-30', '2026-03-01').ok, 'data que nao existe e recusada');
  checar(!datas.intervaloDeDatas('2026-09-11', '2026-09-10').ok, 'data invertida e recusada');
  checar(!datas.intervaloDeDatas('2025-01-01', '2026-09-10').ok, 'mais de um ano de uma vez e recusado');

  // ------------------------------------------------- 2. a conta das entregas
  console.log('\n\x1b[36m### 2. ENTREGAS ###\x1b[0m');
  responder = (sql) => ({ rows: /order_type = 'delivery'/.test(sql) ? ENTREGAS : [] });
  const e = await db.getReportEntregas(ontem.inicio, ontem.fim);
  checar(e.resumo.entregas === 3, 'conta as entregas');
  checar(e.resumo.valorTotal === 75.5 && e.resumo.taxas === 17, 'soma o valor dos pedidos e as taxas');
  checar(e.porCidade[0].cidade === 'Everett' && e.porCidade[0].entregas === 2 &&
    e.porCidade[0].total === 44 && e.porCidade[0].taxas === 10, 'agrupa por cidade');
  checar(e.porCidade[1].cidade === 'Chelsea' && e.porCidade[1].entregas === 1, 'com cada cidade separada');
  checar(e.lista.length === 3 && e.lista[0].id === 90 && e.lista[0].cidade === 'Everett' &&
    e.lista[0].taxa === 5 && e.lista[0].total === 25, 'e lista uma a uma');
  checar(e.lista[0].quando === '2026-09-11T01:43:41.617Z', 'com a hora em ISO (o Safari do iPhone le)');
  const sqlEntregas = consultas.find((c) => /order_type = 'delivery'/.test(c.sql));
  checar(sqlEntregas.params[0] === ontem.inicio && sqlEntregas.params[1] === ontem.fim,
    'a consulta usa o intervalo pedido');

  // ------------------------------------------------ 3. por dia, no dia local
  console.log('\n\x1b[36m### 3. POR DIA ###\x1b[0m');
  responder = () => ({ rows: ENTREGAS.map((x) => ({ total: x.total, created_at: x.created_at })) });
  const porDia = await db.getRevenueByDay(ontem.inicio, ontem.fim);
  checar(porDia.length === 1 && porDia[0].day === '2026-09-10' && porDia[0].count === 3,
    'pedido das 21h fica no dia da loja, nao no dia UTC');

  // ------------------------------------------------------------- 4. a API
  console.log('\n\x1b[36m### 4. API DO PAINEL ###\x1b[0m');
  const app = express();
  app.use(router);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/painel/api`;
  try {
    painel.zerar();
    const link = painel.criarLink('16174449612');
    const sessao = painel.abrir(new URL(link.url).searchParams.get('t')).sessao;
    const auth = { authorization: `Bearer ${sessao}` };

    responder = (sql) => ({ rows: /order_type = 'delivery'/.test(sql) ? ENTREGAS : [] });
    consultas.length = 0;
    let r = await fetch(`${base}/relatorio?de=2026-09-10&ate=2026-09-10`, { headers: auth });
    const geral = await r.json();
    checar(r.status === 200 && geral.de === '2026-09-10' && geral.ate === '2026-09-10',
      'o relatorio geral aceita De/ate');
    checar(consultas.length >= 5 && consultas.every((c) =>
      c.params[0] === '2026-09-10T04:00:00.000Z' && c.params[1] === '2026-09-11T04:00:00.000Z'),
    'e todas as consultas usam o dia de ontem no relogio da loja');

    r = await fetch(`${base}/relatorio/entregas?de=2026-09-10&ate=2026-09-10`, { headers: auth });
    const aba = await r.json();
    checar(r.status === 200 && aba.resumo.entregas === 3 && aba.porCidade.length === 2 && aba.lista.length === 3,
      'a aba Deliverys recebe cards, cidades e a lista');

    r = await fetch(`${base}/relatorio/entregas?de=2026-09-11&ate=2026-09-10`, { headers: auth });
    checar(r.status === 400, 'periodo invertido volta erro, sem consultar');

    r = await fetch(`${base}/relatorio?de=ontem`, { headers: auth });
    checar(r.status === 400, 'data fora do formato volta erro');

    consultas.length = 0;
    r = await fetch(`${base}/relatorio?periodo=semana`, { headers: auth });
    checar(r.status === 200 && consultas[0].params[0] === datas.meiaNoite(datas.somarDias(datas.dataLocal(), -7)).toISOString(),
      'o formato antigo (periodo=semana) continua aceito');

    r = await fetch(`${base}/relatorio/entregas?de=2026-09-10&ate=2026-09-10`);
    checar(r.status === 401, 'sem sessao, nada de relatorio');
  } finally {
    server.close();
  }

  // ----------------------------------------------------------- 5. a página
  console.log('\n\x1b[36m### 5. A PAGINA ###\x1b[0m');
  const html = pagina.render('sessao-teste', 15);
  const js = html.split('<script>')[1].split('</script>')[0];
  // Só compila, não executa: um erro de sintaxe derrubaria o painel inteiro.
  new (require('vm').Script)(js, { filename: 'painel-page.js' });
  checar(true, 'o script do painel compila');
  checar(/'Deliverys'/.test(js) && /'Período'/.test(js), 'a aba Deliverys fica ao lado de Periodo');
  checar(/type: 'date'/.test(js) && /'Ontem'/.test(js), 'com filtro por data e o atalho de ontem');
  checar(/relatorio\/entregas/.test(js), 'e a aba busca as entregas');

  console.log('\n\x1b[32mpainelrelatoriotest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
