/**
 * Base de exemplos pelo painel: o dono corrige uma leitura errada e o exemplo
 * passa a ir junto para a IA leitora, somado aos do arquivo.
 *
 * O que não pode quebrar: com o painel vazio (ou o banco fora), a leitura é
 * exatamente a de antes.
 */
process.env.DATABASE_URL = 'postgresql://fake';
process.env.PAINEL_SECRET = 'x'.repeat(40);

const PROJECT = require('path').resolve(__dirname, '..');
const menuProducao = require('./fixtures/menu-producao.json');
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
config.get = (chave) => (chave === 'menu' ? menuProducao : getReal(chave));

// Banco de mentira só com config_docs.
const docs = new Map();
let bancoFora = false;
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({
  getConfigDocs: async () => {
    if (bancoFora) throw new Error('banco fora');
    return [...docs].map(([key, doc]) => ({ key, doc }));
  },
  setConfigDoc: async (key, doc) => {
    if (bancoFora) throw new Error('banco fora');
    docs.set(key, JSON.parse(JSON.stringify(doc)));
    return { key, doc };
  },
}, { get: (alvo, k) => alvo[k] || (async () => null) });

const painelServico = require(`${PROJECT}/src/services/painel`);
painelServico.habilitado = () => true;
painelServico.conferirSessao = async (t) => (t === 'ok' ? { ok: true, phone: '16174449612' } : { ok: false });

const leitor = require(`${PROJECT}/src/ai/leitor`);
leitor.ler = async (sess, texto) => ({ ok: true, dados: leitor.normalizar({
  itens: [{ produto: 'hamburger', qtd: 1, sem: [], com: [], trecho: texto }], ambiguos: [],
}) });

const exemplos = require(`${PROJECT}/src/ai/exemplos`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  console.log('\n\x1b[36m### 1. PAINEL VAZIO NÃO MUDA NADA ###\x1b[0m');
  const frases = exemplos.carregar().map((e) => e.texto);
  const antes = frases.map((t) => exemplos.paraLeitura(t));
  checar(await exemplos.recarregarDoPainel() === 0, 'sem documento no banco, nenhum exemplo do painel');
  checar(frases.every((t, i) => exemplos.paraLeitura(t) === antes[i]), 'leitura igual à de antes para todos os exemplos');
  bancoFora = true;
  checar(await exemplos.recarregarDoPainel() === 0, 'banco fora: não lança, segue só com o arquivo');
  bancoFora = false;

  console.log('\n\x1b[36m### 2. MONTAGEM CONFERIDA ###\x1b[0m');
  checar(!exemplos.montarDoPainel({ texto: '', itens: [] }).ok, 'sem mensagem é recusado');
  checar(!exemplos.montarDoPainel({ texto: 'oi', itens: [{ produto: 'nao_existe' }] }).ok, 'produto fora do cardápio é recusado');
  checar(!exemplos.montarDoPainel({ texto: 'oi', itens: [] }).ok, 'sem item é recusado');
  const m = exemplos.montarDoPainel({ texto: 'Quero um hamburgao', nota: 'hamburgao é o Hamburgão',
    itens: [{ produto: 'hamburger', qtd: '2', sem: ['tomate'], com: [], ponto_bife: 'bem_passado',
      ponto_bacon: 'x', salsicha: '', maionese_a_parte: false, trecho: '' }] });
  const it = m.exemplo?.leitura.itens[0];
  checar(m.ok && it.qtd === 2 && it.sem[0] === 'tomate' && it.ponto_bife === 'bem_passado', 'campos preenchidos entram');
  checar(!('com' in it) && !('ponto_bacon' in it) && !('salsicha' in it) && !('maionese_a_parte' in it),
    'campos vazios ou inválidos ficam de fora');
  checar(it.trecho === 'Quero um hamburgao' && m.exemplo.origem === 'painel' && m.exemplo.id, 'trecho padrão = a mensagem');

  console.log('\n\x1b[36m### 3. ROTAS DO PAINEL ###\x1b[0m');
  const express = require('express');
  const app = express();
  app.use(require(`${PROJECT}/src/api/painel`));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/painel/api`;
  const chamar = (p, opts = {}) => fetch(base + p, { ...opts,
    headers: { 'Content-Type': 'application/json', Cookie: '__Host-painel_session=ok', ...(opts.headers || {}) } })
    .then(async (r) => ({ status: r.status, corpo: await r.json() }));
  try {
    const semLogin = await fetch(base + '/exemplos').then((r) => r.status);
    checar(semLogin === 401, 'sem sessão do painel, recusado');

    let r = await chamar('/exemplos');
    checar(r.status === 200 && r.corpo.painel.length === 0 && r.corpo.arquivo.length === frases.length &&
      r.corpo.produtos.some((p) => p.id === 'x_burger'), 'lista: painel vazio, os do arquivo e os produtos');

    r = await chamar('/exemplos', { method: 'POST', body: JSON.stringify({ texto: 'oi', itens: [{ produto: 'zzz' }] }) });
    checar(r.status === 400 && r.corpo.problemas.length, 'exemplo inválido volta com o problema');

    r = await chamar('/exemplos', { method: 'POST', body: JSON.stringify({ texto: 'me ve um xburgao caprichado',
      nota: 'xburgao é o X Burger', itens: [{ produto: 'x_burger', qtd: 1 }] }) });
    checar(r.status === 200 && r.corpo.painel.length === 1, 'exemplo salvo');
    checar(docs.get('exemplos_leitor')?.length === 1 && !('_trigramas' in docs.get('exemplos_leitor')[0]),
      'gravado no banco (config_docs exemplos_leitor), sem campo interno');
    checar(/xburgao é o X Burger/.test(exemplos.paraLeitura('me ve um xburgao caprichado por favor')),
      'mensagem parecida já leva o exemplo para a IA');
    checar(frases.every((t, i) => exemplos.paraLeitura(t) === antes[i]), 'os do arquivo continuam valendo igual');

    // Reinício: vem do banco.
    exemplos.usarDoPainel([]);
    checar(await exemplos.recarregarDoPainel() === 1, 'depois de reiniciar, volta do banco');

    r = await chamar('/exemplos/ler', { method: 'POST', body: JSON.stringify({ texto: 'hamburguer' }) });
    checar(r.status === 200 && r.corpo.itens[0].produto === 'hamburger', '"Ver o que a IA entende" devolve a leitura');

    const id = docs.get('exemplos_leitor')[0].id;
    r = await chamar('/exemplos/nao-existe', { method: 'DELETE' });
    checar(r.status === 404, 'apagar id inexistente: 404');
    r = await chamar('/exemplos/' + id, { method: 'DELETE' });
    checar(r.status === 200 && r.corpo.painel.length === 0 && docs.get('exemplos_leitor').length === 0, 'exemplo apagado');
    checar(!/xburgao/.test(exemplos.paraLeitura('me ve um xburgao caprichado por favor')), 'apagado não vai mais para a IA');

    bancoFora = true;
    r = await chamar('/exemplos', { method: 'POST', body: JSON.stringify({ texto: 'x', itens: [{ produto: 'x_burger' }] }) });
    checar(r.status === 500 && exemplos.listaDoPainel().length === 0, 'banco fora ao salvar: erro e nada muda na memória');
    bancoFora = false;
  } finally {
    srv.close();
  }
  console.log('\n\x1b[32mexemplos pelo painel: ok\x1b[0m');
})().catch((e) => { console.error(e); process.exit(1); });
