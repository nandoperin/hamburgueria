const config = require('./config');
const availability = require('./availability');
const modifiers = require('./modifiers');
const promotions = require('./promotions');

/**
 * Consulta ao cardápio — a camada de leitura sobre `config/menu.json`.
 *
 * Existe para haver **um** lugar que responde "este item existe?" e "está
 * disponível?". As ferramentas da IA, o fluxo numerado de reserva, a comanda e
 * o gerador de imagem perguntam todos aqui; duas implementações de
 * disponibilidade sairiam de sincronia no primeiro item esgotado.
 *
 * Nada aqui decide preço — preço é campo do `menu.json`, e quem soma é o
 * carrinho. Este módulo só encontra e filtra.
 */

/** Idioma da cozinha — a comanda sai sempre em português. */
const LANG_COZINHA = 'pt';

function categorias() {
  const normais = config.get('menu').categories || [];
  const promocao = promotions.categoria();
  const depoisDeSanduiches = Math.max(0, normais.findIndex((c) => c.id === 'sanduiches') + 1);
  return [
    ...normais.slice(0, depoisDeSanduiches),
    promocao,
    ...normais.slice(depoisDeSanduiches),
  ];
}

/** Todos os itens, achatados, com a categoria junto. */
function allItems() {
  return categorias().flatMap((category) =>
    (category.items || []).map((item) => ({ ...item, category }))
  );
}

function itemById(id) {
  if (!id) return null;
  return allItems().find((item) => item.id === id) || null;
}

function categoriaById(id) {
  return categorias().find((c) => c.id === id) || null;
}

function itemsOfCategory(categoryId) {
  return categoriaById(categoryId)?.items || [];
}

/**
 * Um item está disponível se o cardápio o declara ativo **e** ele não foi
 * marcado como esgotado. A primeira condição é permanente (saiu do cardápio),
 * a segunda é do dia (acabou o frango).
 */
function disponivel(item) {
  return Boolean(item?.available) &&
    availability.isAvailable(item.id) &&
    promotions.itemLiberado(item);
}

function mensagemIndisponivel(item, lang = 'pt') {
  if (promotions.itemDaPromocao(item) && !promotions.itemLiberado(item)) {
    return promotions.mensagemIndisponivel(lang);
  }
  return `${nome(item, lang)} está indisponível agora.`;
}

function categoriasDisponiveis() {
  return categorias().filter((c) => (c.items || []).some(disponivel));
}

function itensDisponiveis(category) {
  return (category?.items || []).filter(disponivel);
}

function nome(item, lang) {
  return item.name[lang] || item.name.en || item.name.pt;
}

function nomeCozinha(item) {
  return item.name[LANG_COZINHA] || item.name.en;
}

function descricao(item, lang) {
  return item.description?.[lang] || item.description?.pt || '';
}

// ------------------------------------------------------- retrato para o modelo

/**
 * O cardápio como texto, para o bloco cacheável do prompt.
 *
 * Vai **inteiro** em toda requisição, então é o maior custo fixo da conversa —
 * e por ser estático é exatamente o que o prompt caching desconta. Compacto de
 * propósito: cada linha economiza em toda mensagem de todo cliente.
 *
 * Traz os ids porque é por id que o modelo chama as ferramentas. Traz os preços
 * para ele conseguir conversar sobre valor — mas **o preço que vale é o do
 * carrinho**, calculado pelo código. Se os dois divergirem, o do código ganha,
 * e o cliente confirma um resumo que o código escreveu.
 */
function paraModelo(lang) {
  const linhas = [];

  for (const categoria of categoriasDisponiveis()) {
    const itens = itensDisponiveis(categoria);
    if (!itens.length) continue;

    linhas.push(`\n## ${categoria.name[lang] || categoria.name.pt} (${categoria.id})`);

    for (const item of itens) {
      linhas.push(`- ${item.id} | ${nome(item, lang)} | $${item.price.toFixed(2)}`);

      const desc = descricao(item, lang);
      if (desc) linhas.push(`  ${desc}`);

      if (modifiers.tem(item)) {
        const sai = modifiers.removiveis(item, lang);
        const entra = modifiers.adicionais(item, lang);

        if (sai.length) {
          linhas.push(`  remover (grátis): ${sai.map((i) => i.id).join(', ')}`);
        }
        if (entra.length) {
          linhas.push(
            `  acrescentar: ${entra.map((i) => `${i.id} +$${i.preco.toFixed(2)}`).join(', ')}`
          );
        }
      }
    }
  }

  return linhas.join('\n').trim();
}

// --------------------------------------------------------------- diagnóstico

/**
 * Problemas de configuração do cardápio, para o boot denunciar.
 *
 * Erro de configuração que se anuncia é erro que alguém conserta. Em silêncio,
 * um item some das opções e o cliente nunca fica sabendo que podia ter pedido.
 */
function conferir() {
  const problemas = [];

  const vistos = new Set();
  for (const item of allItems()) {
    if (vistos.has(item.id)) problemas.push({ tipo: 'id_duplicado', item: item.id });
    vistos.add(item.id);

    if (typeof item.price !== 'number' || !(item.price >= 0)) {
      problemas.push({ tipo: 'preco_invalido', item: item.id });
    }
    if (!item.name?.pt || !item.name?.en || !item.name?.es) {
      problemas.push({ tipo: 'nome_incompleto', item: item.id });
    }
  }

  for (const orfao of modifiers.conferir(config.get('menu'))) {
    problemas.push({ tipo: 'ingrediente_inexistente', ...orfao });
  }

  return problemas;
}

module.exports = {
  LANG_COZINHA,
  categorias,
  categoriasDisponiveis,
  allItems,
  itemById,
  categoriaById,
  itemsOfCategory,
  itensDisponiveis,
  disponivel,
  mensagemIndisponivel,
  nome,
  nomeCozinha,
  descricao,
  paraModelo,
  conferir,
};
