/**
 * Aba "Perguntas" do painel (docs/PERGUNTAS.md, fase 2, 13/11/2026): o dono
 * cadastra, edita, liga/desliga e apaga perguntas; o bot passa a usar na hora.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.PAINEL_SECRET = 'x'.repeat(40);
process.env.LOG_LEVEL = 'silent';

const PROJECT = require('path').resolve(__dirname, '..');
const docs = new Map();
const settings = new Map();
let bancoFora = false;
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({
  getConfigDocs: async () => [...docs].map(([key, doc]) => ({ key, doc })),
  setConfigDoc: async (key, doc) => {
    if (bancoFora) throw new Error('banco fora');
    docs.set(key, JSON.parse(JSON.stringify(doc)));
    return { key, doc };
  },
  getSetting: async (k) => settings.get(k) ?? null,
  setSetting: async (k, v) => { settings.set(k, v); },
}, { get: (alvo, k) => alvo[k] || (async () => null) });

const painelServico = require(`${PROJECT}/src/services/painel`);
painelServico.habilitado = () => true;
painelServico.conferirSessao = async (t) => (t === 'ok' ? { ok: true, phone: '16174449612' } : { ok: false });

const perguntas = require(`${PROJECT}/src/services/perguntas`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  // A página: aba nova, JavaScript válido.
  const pagina = require(`${PROJECT}/src/api/painel-page`).render(15, 'nonce-teste');
  const script = [...pagina.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  checar((() => { try { new Function(script); return true; } catch { return false; } })(), 'o JavaScript do painel continua válido');
  checar(/perguntas: \['❓ Perguntas', renderPerguntas\]/.test(script) && /SOMENTE_LEITURA = \[[^\]]*'perguntas'/.test(script),
    'aba "❓ Perguntas" no painel, salvando cada item sozinha');

  const express = require('express');
  const app = express();
  app.use(require(`${PROJECT}/src/api/painel`));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/painel/api`;
  const chamar = (p, opts = {}) => fetch(base + p, { ...opts,
    headers: { 'Content-Type': 'application/json', Cookie: '__Host-painel_session=ok', ...(opts.headers || {}) } })
    .then(async (r) => ({ status: r.status, corpo: await r.json().catch(() => null) }));
  const post = (corpo) => chamar('/perguntas', { method: 'POST', body: JSON.stringify(corpo) });

  let r = await fetch(`${base}/perguntas`);
  checar(r.status === 401, 'sem sessão do painel: 401');

  r = await chamar('/perguntas');
  checar(r.status === 200 && r.corpo.lista.length === 0, 'lista começa vazia');

  r = await post({ pergunta: 'O macarrão tem pimenta?', resposta: 'Não leva pimenta.\nSe quiser, mandamos à parte.' });
  checar(r.status === 200 && r.corpo.lista.length === 1 && docs.get('perguntas').length === 1, 'cadastra e grava no banco');
  const id = r.corpo.lista[0].id;
  checar(perguntas.ativas().length === 1 && perguntas.ativas()[0].resposta === 'Não leva pimenta.\nSe quiser, mandamos à parte.',
    'o bot já usa, sem reiniciar');

  r = await post({ pergunta: '', resposta: 'x' });
  checar(r.status === 400 && r.corpo.problemas.includes('escreva a pergunta'), 'sem pergunta: recusa com o motivo');

  r = await post({ id, pergunta: 'O macarrão é apimentado?', resposta: 'Não leva pimenta.', ativa: true });
  checar(r.status === 200 && r.corpo.lista.length === 1 && r.corpo.lista[0].id === id && r.corpo.lista[0].pergunta === 'O macarrão é apimentado?',
    'edita no lugar, mantendo o código');

  r = await post({ id, pergunta: 'O macarrão é apimentado?', resposta: 'Não leva pimenta.', ativa: false });
  checar(r.status === 200 && perguntas.lista()[0].ativa === false && perguntas.ativas().length === 0, 'desligar: o bot para de usar');

  r = await post({ id: 'q_inventado', pergunta: 'x?', resposta: 'y' });
  checar(r.status === 404, 'editar item que não existe: 404');

  bancoFora = true;
  r = await post({ pergunta: 'Tem estacionamento?', resposta: 'Tem vaga na rua.' });
  checar(r.status === 500 && perguntas.lista().length === 1, 'banco fora: não salva e o bot segue com a lista de antes');
  bancoFora = false;

  r = await chamar('/perguntas/' + id, { method: 'DELETE' });
  checar(r.status === 200 && r.corpo.lista.length === 0 && docs.get('perguntas').length === 0, 'apagar');
  r = await chamar('/perguntas/' + id, { method: 'DELETE' });
  checar(r.status === 404, 'apagar de novo: 404');

  // Fase 3: perguntas sem resposta, "Responder" e "Ignorar".
  await perguntas.anotarPendente('Vocês aceitam Venmo?');
  await perguntas.anotarPendente('Tem opção vegetariana?');
  r = await chamar('/perguntas');
  checar(r.corpo.pendentes.length === 2 && r.corpo.pendentes[0].pergunta === 'Tem opção vegetariana?',
    'sem resposta: as duas aparecem, a mais recente primeiro');
  const [vegetariana, venmo] = r.corpo.pendentes;
  r = await post({ pergunta: venmo.pergunta, resposta: 'Aceitamos só cash ou Zelle.', dePendente: venmo.id });
  checar(r.status === 200 && perguntas.ativas().some((p) => p.pergunta === 'Vocês aceitam Venmo?'), '"Responder": vira pergunta cadastrada');
  r = await chamar('/perguntas');
  checar(r.corpo.pendentes.length === 1 && r.corpo.pendentes[0].pergunta === 'Tem opção vegetariana?', '   e sai da lista das sem resposta');
  r = await chamar('/perguntas/pendentes/ignorar', { method: 'POST', body: JSON.stringify({ em: vegetariana.id }) });
  checar(r.status === 200, '"Ignorar": responde ok');
  r = await chamar('/perguntas');
  checar(r.corpo.pendentes.length === 0 && !perguntas.lista().some((p) => p.pergunta === 'Tem opção vegetariana?'),
    '   sai da lista sem cadastrar nada');
  r = await chamar('/perguntas/pendentes/ignorar', { method: 'POST', body: JSON.stringify({ em: vegetariana.id }) });
  checar(r.status === 404, '"Ignorar" de novo: 404');
  await perguntas.salvar([]);

  for (let i = 0; i < perguntas.MAX_PERGUNTAS; i += 1) await perguntas.salvar([...perguntas.lista(), perguntas.montarItem({ pergunta: 'Pergunta ' + i, resposta: 'ok' }).item]);
  r = await post({ pergunta: 'Mais uma?', resposta: 'ok' });
  checar(r.status === 400 && /no máximo 50/.test(r.corpo.problemas[0]), 'limite de 50 perguntas');

  srv.close();
  console.log('\n\x1b[32mperguntaspaineltest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
