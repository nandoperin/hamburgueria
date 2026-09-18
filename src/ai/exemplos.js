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
  return base || carregar();
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

module.exports = { paraLeitura, parecidos, carregar, todos, semelhanca, trigramas, MAX_EXEMPLOS };
