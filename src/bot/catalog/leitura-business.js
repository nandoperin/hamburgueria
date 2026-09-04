const { getBinaryNodeChild, getBinaryNodeChildren } = require('@whiskeysockets/baileys');
// Mesmo parser da versão instalada, mas só depois de validar o envelope.
const { parseCatalogNode } = require('@whiskeysockets/baileys/lib/Utils/business.js');

const TAGS = new Set(['iq', 'product_catalog', 'product', 'products', 'collections',
  'collection', 'error', 'paging', 'after', 'before', 'result', 'query', 'item']);

function estrutura(node, profundidade = 0) {
  if (!node || typeof node !== 'object') return 'ausente';
  const tag = TAGS.has(node.tag) ? node.tag : 'outro';
  if (profundidade >= 3 || !Array.isArray(node.content)) return tag;
  // Apenas tags conhecidas: nunca texto, atributos, JIDs, URLs ou tokens.
  const filhos = [...new Set(node.content.slice(0, 50).map(n => estrutura(n, profundidade + 1)))];
  return `${tag}[${filhos.join(',')}]`;
}

function interpretar(resposta) {
  const envelope = resposta?.tag === 'product_catalog'
    ? { tag: 'iq', attrs: { type: 'result' }, content: [resposta] } : resposta;
  const catalogo = getBinaryNodeChild(envelope, 'product_catalog');
  if (envelope?.tag !== 'iq' || envelope?.attrs?.type === 'error' ||
      !catalogo || !Array.isArray(catalogo.content) ||
      getBinaryNodeChild(envelope, 'error') || getBinaryNodeChild(catalogo, 'error')) {
    return { code: 'catalogo_estrutura_inesperada' };
  }
  const produtos = getBinaryNodeChildren(catalogo, 'product');
  // Um container desconhecido não significa que a coleção esteja vazia.
  if (catalogo.content.some(n => !['product', 'paging'].includes(n.tag))) {
    return { code: 'catalogo_estrutura_inesperada' };
  }
  try {
    const resultado = parseCatalogNode(envelope);
    if (resultado.products.length !== produtos.length ||
        resultado.products.some(p => !/^\d+$/.test(p.id))) {
      return { code: 'catalogo_produto_invalido' };
    }
    return { resultado };
  } catch { return { code: 'catalogo_produto_invalido' }; }
}

function criarLeitura({ socket, phone, registrar = () => {} }) {
  return async function ler({ cursor, limit = 50 } = {}) {
    const numero = phone();
    if (!/^\d{10,15}$/.test(numero || '')) throw new Error('Numero da sessao indisponivel para consultar o catalogo.');
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 4096)) {
      throw new Error('Cursor de catalogo invalido.');
    }
    const jid = `${numero}@s.whatsapp.net`;
    const tamanho = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 50;
    // Lotes limitados; em retorno vazio/inesperado da primeira página, experimentar
    // o tamanho padrão (10) do SDK uma vez. Não repetir escritas nem criar sessão.
    const tentativas = cursor || tamanho === 10 ? [tamanho] : [tamanho, 10];
    let code = 'catalogo_sem_produtos';
    for (const quantidade of tentativas) {
      const conteudo = [
        { tag: 'limit', attrs: {}, content: Buffer.from(String(quantidade)) },
        { tag: 'width', attrs: {}, content: Buffer.from('100') },
        { tag: 'height', attrs: {}, content: Buffer.from('100') },
        ...(cursor ? [{ tag: 'after', attrs: {}, content: cursor }] : []),
      ];
      let resposta;
      try {
        resposta = await socket.query({
          tag: 'iq', attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'w:biz:catalog' },
          content: [{ tag: 'product_catalog', attrs: { jid, allow_shop_source: 'true' }, content: conteudo }],
        }, 15000);
      } catch (err) {
        const status = Number(err?.output?.statusCode);
        registrar({ code: 'catalogo_consulta_falhou', ...(Number.isInteger(status) ? { status } : {}) });
        throw new Error('Nao foi possivel ler o catalogo nesta conexao (catalogo_consulta_falhou). A importacao foi bloqueada; nao altere os produtos nem os precos.');
      }
      const leitura = interpretar(resposta);
      registrar({ code: leitura.code || 'catalogo_resposta', estrutura: estrutura(resposta),
        limite: quantidade, produtos: leitura.resultado?.products.length || 0 });
      if (leitura.resultado?.products.length || leitura.resultado?.nextPageCursor ||
          (cursor && leitura.resultado)) return leitura.resultado;
      code = leitura.code || 'catalogo_sem_produtos';
    }
    // As coleções são somente um diagnóstico: podem omitir produtos sem coleção
    // ou truncar itens. Nunca usá-las como inventário para excluir ou importar.
    let complemento = '';
    if (typeof socket.getCollections === 'function') {
      try {
        const { collections } = await socket.getCollections(jid, 50);
        const ids = new Set((collections || []).flatMap(c => c.products || []).map(p => p.id));
        registrar({ code: 'catalogo_colecoes_diagnostico', colecoes: collections?.length || 0, produtos: ids.size });
        if (ids.size) complemento = ` As colecoes retornaram ${ids.size} produtos, mas essa leitura pode ser parcial.`;
      } catch { registrar({ code: 'catalogo_colecoes_falhou' }); }
    }
    throw new Error(`O Baileys nao conseguiu ler os produtos do catalogo conectado (${code}).${complemento} Isso nao confirma catalogo vazio. A importacao foi bloqueada; nao altere os produtos nem os precos. Envie esta resposta ao responsavel tecnico.`);
  };
}

module.exports = { criarLeitura, interpretar, estrutura };
