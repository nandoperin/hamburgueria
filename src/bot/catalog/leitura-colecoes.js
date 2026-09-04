const { getBinaryNodeChild } = require('@whiskeysockets/baileys');
const { parseCollectionsNode } = require('@whiskeysockets/baileys/lib/Utils/business.js');
const { estrutura } = require('./leitura-business');

// Consulta independente, com o prazo padrão do SDK. Nunca importa nem exclui.
function criarLeituraColecoes({ socket, phone, registrar = () => {} }) {
  return async () => {
    const numero = phone();
    if (!/^\d{10,15}$/.test(numero || '')) throw new Error('Numero da sessao indisponivel.');
    const inicio = Date.now();
    const concluir = (resultado, resposta) => {
      const tempoMs = Date.now() - inicio;
      registrar({ code: resultado.code, tempoMs,
        ...(resultado.status ? { status: resultado.status } : {}),
        ...(resultado.colecoes ? { colecoes: resultado.colecoes.length, produtos: resultado.produtos.length } : {}),
        ...(resposta ? { estrutura: estrutura(resposta) } : {}),
      });
      return { ...resultado, tempoMs };
    };
    let resposta;
    try {
      // Mesmo pedido de getCollections da versão instalada, validando também
      // resposta ausente (timeout ocultado pelo SDK) e formato inesperado.
      resposta = await socket.query({
        tag: 'iq',
        attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'w:biz:catalog', smax_id: '35' },
        content: [{ tag: 'collections', attrs: { biz_jid: `${numero}@s.whatsapp.net` },
          content: [['collection_limit', 50], ['item_limit', 50], ['width', 100], ['height', 100]]
            .map(([tag, valor]) => ({ tag, attrs: {}, content: Buffer.from(String(valor)) })),
        }],
      }, 60000);
    } catch (err) {
      const status = Number(err?.output?.statusCode);
      return concluir({ code: status === 408 ? 'colecoes_timeout' : 'colecoes_consulta_falhou',
        ...(Number.isInteger(status) ? { status } : {}),
      });
    }
    if (!resposta) return concluir({ code: 'colecoes_sem_resposta' });
    const container = getBinaryNodeChild(resposta, 'collections');
    if (resposta.tag !== 'iq' || resposta.attrs?.type === 'error' ||
        getBinaryNodeChild(resposta, 'error') || !container ||
        (container.content != null && !Array.isArray(container.content)) ||
        getBinaryNodeChild(container, 'error')) {
      return concluir({ code: 'colecoes_estrutura_inesperada' }, resposta);
    }
    // O SDK só entende filhos diretos collection. Não chamar estrutura diferente
    // de "zero coleções". Nunca considerar a lista um inventário completo.
    if ((container.content || []).some(n => !['collection', 'paging'].includes(n.tag))) {
      return concluir({ code: 'colecoes_estrutura_inesperada' }, resposta);
    }
    try {
      const { collections } = parseCollectionsNode(resposta);
      const produtos = new Map();
      for (const c of collections) {
        if (!/^\d+$/.test(c.id)) return concluir({ code: 'colecoes_dados_invalidos' }, resposta);
        for (const p of c.products) {
          if (!/^\d+$/.test(p.id)) return concluir({ code: 'colecoes_dados_invalidos' }, resposta);
          produtos.set(p.id, { id: p.id, name: p.name });
        }
      }
      return concluir({ code: 'colecoes_lidas', parcial: true,
        colecoes: collections.map(c => ({ name: c.name, quantidade: c.products.length })),
        produtos: [...produtos.values()],
      }, resposta);
    } catch { return concluir({ code: 'colecoes_dados_invalidos' }, resposta); }
  };
}

module.exports = { criarLeituraColecoes };
