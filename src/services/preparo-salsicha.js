const cardapio = require('./cardapio');
const modifiers = require('./modifiers');

const baseId = line => line.productId || String(line.id).split(':')[0];
const avulsa = line => baseId(line) === 'salsicha';
const precisa = line => avulsa(line) || (line.added || []).includes('salsicha');
const normalizar = texto => String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[.!?]/g, '').trim();

function lanches(sess) {
  return sess.cart.filter(line => ['sanduiches', 'hotdogs', 'massas'].includes(
    cardapio.itemById(baseId(line))?.category.id
  ));
}

// Apenas apresentação/identidade. Nunca altera quantidade, preço ou adicionais.
function rotular(line, lang = 'pt') {
  const item = cardapio.itemById(baseId(line));
  if (!item) return;
  const estado = { removed: line.removed || [], added: line.added || [] };
  line.id = modifiers.cartId(item, estado);
  line.name = modifiers.rotulo(item, estado, lang);
  line.choicesCozinha = modifiers.linhasCozinha(estado);
  const preparo = line.preparoSalsicha;
  if (!precisa(line) || !preparo) return;
  const detalhe = preparo.modo === 'a_parte' ? 'salsicha adicional à parte' :
    `salsicha adicional junto${preparo.alvoNome ? ` com ${preparo.alvoNome}` : ' com o lanche'}` +
      (preparo.unidades ? ` (${preparo.unidades} lanche(s), dividir igualmente)` : '');
  line.id += `${line.id.includes(':') ? '' : ':'}~salsicha=${preparo.modo}${preparo.alvoId ? '@' + encodeURIComponent(preparo.alvoId) : ''}${preparo.unidades ? '#'+preparo.unidades : ''}`;
  line.name += ` (${detalhe})`;
  line.choicesCozinha.push(detalhe);
}

function pendente(sess) {
  return (sess.cart || []).find(line => {
    if (!precisa(line)) return false;
    const p = line.preparoSalsicha;
    if (!p || !['junto', 'a_parte'].includes(p.modo)) return true;
    if (p.modo === 'junto' && avulsa(line)) {
      const alvo = lanches(sess).find(alvo => alvo.id === p.alvoId);
      return !alvo || !p.unidades || p.unidades > alvo.qty || line.qty % p.unidades !== 0;
    }
    return false;
  });
}

function pergunta(sess) {
  const line = pendente(sess);
  if (!line) return null;
  if (line.preparoSalsicha?.modo === 'junto' && avulsa(line)) {
    const alvo = lanches(sess).find(l => l.id === line.preparoSalsicha.alvoId);
    if (alvo) return `São ${line.qty} salsicha(s) adicionais e ${alvo.qty}x ${alvo.name}. Em quantos desses lanches quer colocar a salsicha?`;
    return 'A salsicha vai junto com qual lanche?' +
      (lanches(sess).length ? ` ${lanches(sess).map(l => l.name).join('; ')}.` : ' Escolha o lanche, ou peça a salsicha à parte.');
  }
  const deQual = avulsa(line) ? '' : ` do ${cardapio.nome(cardapio.itemById(baseId(line)), sess.lang || 'pt')}`;
  return `A salsicha adicional${deQual} vai à parte ou junto com o lanche?`;
}

function definir(sess, { item_id, modo, lanche_id, unidades_lanche }) {
  const line = sess.cart.findLast(l => l.id === item_id);
  if (!line || !precisa(line)) return { ok: false, erro: 'Não achei essa salsicha adicional no carrinho. Use o id exato da linha.' };
  if (!['junto', 'a_parte'].includes(modo)) return { ok: false, erro: 'Informe junto ou a_parte.' };
  let alvo = null;
  let unidades;
  if (modo === 'junto' && avulsa(line)) {
    const opcoes = lanches(sess);
    alvo = lanche_id ? opcoes.find(l => l.id === lanche_id) : opcoes.length === 1 ? opcoes[0] : null;
    if (lanche_id && !alvo) return { ok: false, erro: 'O lanche indicado não está no carrinho. Use o id exato da linha.' };
    if (alvo) {
      unidades = unidades_lanche ?? (alvo.qty === 1 || line.qty === 1 ? 1 : null);
      if (unidades != null && (!Number.isInteger(unidades) || unidades < 1 || unidades > alvo.qty || line.qty % unidades !== 0)) {
        return { ok: false, erro: 'Essa distribuição não divide as salsichas em quantidades inteiras iguais. Indique em quantos lanches elas vão, sem alterar a quantidade comprada.' };
      }
    }
  }
  line.preparoSalsicha = { modo, ...(alvo ? { alvoId: alvo.id, alvoNome: alvo.name, unidades } : {}) };
  rotular(line, sess.lang || 'pt');
  return { ok: true, resultado: `Preparo registrado, sem nova cobrança. Linha: ${line.id}.` };
}

// Respostas curtas à pergunta são resolvidas sem chamada paga nem reconfirmação.
function responder(sess, texto) {
  const line = pendente(sess);
  if (!line) return false;
  const n = normalizar(texto);
  let modo = /^(?:a parte|separad[ao]|separad[ao]s|por fora)$/.test(n) ? 'a_parte' :
    /^(?:junto|junta|junto com (?:o )?lanche|no lanche|dentro do lanche)$/.test(n) ? 'junto' : null;
  let alvo;
  if (line.preparoSalsicha?.modo === 'junto' && /^\d{1,2}$/.test(n) && line.preparoSalsicha.alvoId) {
    return definir(sess, { item_id:line.id, modo:'junto', lanche_id:line.preparoSalsicha.alvoId, unidades_lanche:Number(n) });
  }
  if (!modo && line.preparoSalsicha?.modo === 'junto') {
    const opcoes = lanches(sess).filter(l => [l.name, cardapio.nome(cardapio.itemById(baseId(l)), 'pt')]
      .some(nome => normalizar(nome) === n.replace(/^(?:no|na|com o|com a) /, '')));
    if (opcoes.length === 1) { modo = 'junto'; alvo = opcoes[0]; }
  }
  if (!modo) return false;
  return definir(sess, { item_id: line.id, modo, lanche_id: alvo?.id });
}

module.exports = { baseId, avulsa, precisa, rotular, pendente, pergunta, definir, responder };
