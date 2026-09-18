const path = require('path');
const fs = require('fs');
const cardapio = require('../services/cardapio');
const log = require('../log');

/**
 * Base de exemplos corrigidos da IA leitora.
 *
 * Cada exemplo é uma leitura que saiu errada e que o dono corrigiu: o texto do
 * cliente e o formulário certo. A cada mensagem, os 3 exemplos mais parecidos
 * entram na mensagem da leitora ("casos já corrigidos — leia do mesmo jeito").
 * Não é a IA aprendendo sozinha: só entra o que o dono aprovou.
 *
 * Fonte: `exemplos-leitor.json`, versionado com o código. Tamanho não é
 * problema — cada exemplo tem ~1,5 KB e o teto é MAX_EXEMPLOS.
 *
 * O validador continua valendo por cima: exemplo ajuda a LER, não decide
 * preço, cardápio nem quantidade.
 */

const ARQUIVO = path.join(__dirname, 'exemplos-leitor.json');
const MAX_EXEMPLOS = 500;
const QUANTOS = 3;
// Abaixo disso o exemplo não é parecido o bastante para ajudar — e um exemplo
// fora de contexto atrapalha mais do que ajuda.
const PARECIDO_MINIMO = 0.35;

let base = null;
// Os corrigidos pelo painel (banco, config_docs `exemplos_leitor`). Somam aos
// do arquivo; vazio = o bot age exatamente como sem o painel.
const CHAVE_BANCO = 'exemplos_leitor';
let doPainel = [];

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Trigramas do texto sem espaços: "xegg burguer" e "x egg burger" dividem
 * quase todos, que é o que importa aqui (o cliente escreve junto, separado,
 * com erro de digitação).
 */
function trigramas(texto) {
  const t = ` ${normalizar(texto).replace(/\s+/g, '')} `;
  const conjunto = new Set();
  for (let i = 0; i + 3 <= t.length; i++) conjunto.add(t.slice(i, i + 3));
  return conjunto;
}

function semelhanca(a, b) {
  if (!a.size || !b.size) return 0;
  let comuns = 0;
  for (const g of a) if (b.has(g)) comuns++;
  return (2 * comuns) / (a.size + b.size);
}

function carregar() {
  let lista = [];
  try {
    lista = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
  } catch (err) {
    log.warn({ evt: 'exemplos', err: err.message }, 'base de exemplos da leitora não carregou');
  }
  base = (Array.isArray(lista) ? lista : [])
    .filter((e) => e && typeof e.texto === 'string' && e.leitura && typeof e.leitura === 'object')
    .slice(-MAX_EXEMPLOS)
    .map((e) => ({ ...e, _trigramas: trigramas(e.texto) }));
  return base;
}

function todos() {
  const doArquivo = base || carregar();
  return doPainel.length ? doArquivo.concat(doPainel) : doArquivo;
}

// ------------------------------------------------------------------ painel

const PONTOS = ['mal_passado', 'ao_ponto', 'bem_passado'];
const PONTOS_BACON = ['mal_passado', 'bem_passado'];
const txt = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const ids = (v) => (Array.isArray(v) ? v : []).map((x) => txt(x, 40)).filter(Boolean).slice(0, 20);

/**
 * O exemplo que o dono montou no painel, conferido: produto que existe no
 * cardápio, quantidade de 1 a 50, pontos da lista. Só entram os campos
 * preenchidos — do mesmo jeito que os exemplos do arquivo.
 */
function montarDoPainel(bruto) {
  const erros = [];
  const texto = String(bruto?.texto ?? '').trim().slice(0, 1000);
  if (!texto) erros.push('falta a mensagem do cliente');
  const itens = [];
  for (const [n, i] of (Array.isArray(bruto?.itens) ? bruto.itens : []).slice(0, 20).entries()) {
    const produto = txt(i?.produto, 60);
    if (!cardapio.itemById(produto)) { erros.push(`linha ${n + 1}: escolha um produto do cardápio`); continue; }
    const qtd = Number(i?.qtd);
    const item = { produto, qtd: Number.isInteger(qtd) && qtd >= 1 && qtd <= 50 ? qtd : 1 };
    const sem = ids(i?.sem); if (sem.length) item.sem = sem;
    const com = ids(i?.com); if (com.length) item.com = com;
    if (['junto', 'a_parte'].includes(i?.salsicha)) item.salsicha = i.salsicha;
    if (PONTOS.includes(i?.ponto_bife)) item.ponto_bife = i.ponto_bife;
    if (PONTOS_BACON.includes(i?.ponto_bacon)) item.ponto_bacon = i.ponto_bacon;
    if (i?.maionese_a_parte === true) item.maionese_a_parte = true;
    item.trecho = txt(i?.trecho, 300) || txt(texto, 300);
    itens.push(item);
  }
  if (!itens.length && !erros.length) erros.push('coloque pelo menos um item');
  if (erros.length) return { ok: false, erros };
  const nota = txt(bruto?.nota, 300);
  return {
    ok: true,
    exemplo: {
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      texto,
      leitura: { itens },
      ...(nota ? { nota } : {}),
      data: new Date().toISOString().slice(0, 10),
      origem: 'painel',
    },
  };
}

function usarDoPainel(lista) {
  doPainel = (Array.isArray(lista) ? lista : [])
    .filter((e) => e && typeof e.texto === 'string' && e.leitura && typeof e.leitura === 'object')
    .slice(-MAX_EXEMPLOS)
    .map((e) => ({ ...e, _trigramas: trigramas(e.texto) }));
}

/** Os do painel como estão no banco (sem os trigramas). */
function listaDoPainel() {
  return doPainel.map(({ _trigramas, ...e }) => e);
}

/** Lê do banco no boot. Falha aqui não derruba nada: seguem os do arquivo. */
async function recarregarDoPainel() {
  try {
    const docs = await require('../db/queries').getConfigDocs();
    usarDoPainel(docs.find((d) => d.key === CHAVE_BANCO)?.doc || []);
  } catch (err) {
    log.warn({ evt: 'exemplos', err: err.message }, 'exemplos do painel não carregaram');
  }
  return doPainel.length;
}

/** Grava a lista inteira no banco e só depois passa a usar. */
async function salvarDoPainel(lista, quem = null) {
  const limpa = (Array.isArray(lista) ? lista : []).slice(-MAX_EXEMPLOS)
    .map(({ _trigramas, ...e }) => e);
  await require('../db/queries').setConfigDoc(CHAVE_BANCO, limpa, quem);
  usarDoPainel(limpa);
  return listaDoPainel();
}

/** Produtos que o exemplo cita, para não mostrar exemplo de item que saiu do cardápio. */
function produtosDoExemplo(e) {
  const l = e.leitura;
  return [
    ...(l.itens || []).map((i) => i.produto),
    ...(l.ambiguos || []).flatMap((a) => a.opcoes || []),
  ].filter(Boolean);
}

/**
 * Exemplo que depende do contexto só vale no mesmo contexto. "Tira tomate egg
 * bacon" foi corrigido com X Egg Bacon no carrinho; mostrado com Egg Bacon no
 * carrinho, ensinou a leitora a trocar os dois (prova de 18/09).
 */
function mesmoContexto(e, sess) {
  if (Array.isArray(e.carrinho_ids) && e.carrinho_ids.length) {
    const noCarrinho = new Set((sess?.cart || []).map((l) => l.productId || String(l.id || '').split(':')[0]));
    if (!e.carrinho_ids.every((id) => noCarrinho.has(id))) return false;
  }
  if (e.pergunta) {
    const ultima = normalizar(sess?.guiado?.ultimaPergunta || '');
    if (!ultima || !ultima.includes(normalizar(e.pergunta))) return false;
  }
  return true;
}

/** Os exemplos mais parecidos com o texto, do mais parecido para o menos. */
function parecidos(texto, quantos = QUANTOS, sess = null) {
  const alvo = trigramas(texto);
  return todos()
    .filter((e) => produtosDoExemplo(e).every((id) => cardapio.itemById(id)))
    .filter((e) => mesmoContexto(e, sess))
    .map((e) => ({ e, nota: semelhanca(alvo, e._trigramas) }))
    .filter((x) => x.nota >= PARECIDO_MINIMO)
    .sort((a, b) => b.nota - a.nota)
    .slice(0, quantos)
    .map((x) => x.e);
}

/** O bloco que entra na mensagem da leitora; vazio quando nada é parecido. */
function paraLeitura(texto, sess = null) {
  // Desliga sem deploy (variável no Railway) se um exemplo ensinar errado.
  if (String(process.env.EXEMPLOS_LEITOR || 'on').toLowerCase() === 'off') return '';
  const achados = parecidos(texto, QUANTOS, sess);
  if (!achados.length) return '';
  const casos = achados.map((e) => {
    const contexto = [
      e.carrinho ? `Carrinho: ${e.carrinho}.` : null,
      e.pergunta ? `Última pergunta: ${JSON.stringify(e.pergunta)}.` : null,
    ].filter(Boolean).join(' ');
    return `${contexto ? `${contexto}\n` : ''}Mensagem: ${JSON.stringify(e.texto)}\n→ ${JSON.stringify(e.leitura)}` +
      (e.nota ? `\n  (${e.nota})` : '');
  });
  return 'Casos parecidos que já foram lidos errado e o dono corrigiu — leia do mesmo jeito ' +
    '(campos que não aparecem ficam vazios/null):\n\n' + casos.join('\n\n');
}

module.exports = {
  paraLeitura, parecidos, carregar, todos, semelhanca, trigramas, MAX_EXEMPLOS,
  montarDoPainel, listaDoPainel, recarregarDoPainel, salvarDoPainel, usarDoPainel,
};
