const dicionario = require('../../config/ingredientes.json').ingredientes;
const availability = require('./availability');
const { t } = require('../i18n');

/**
 * Ingredientes: o que sai, o que entra, e quanto custa.
 *
 * Este módulo é a **autoridade de preço** da personalização. A ferramenta
 * `adicionar_item` que o modelo chama passa por aqui, e o que sai daqui é o que
 * vai para o carrinho. O modelo manda ids; quem responde o preço é este arquivo,
 * lendo `config/ingredientes.json`.
 *
 * ## Remover é sempre de graça, e isso é código
 *
 * Não existe campo de configuração para cobrar por remoção. É regra escrita
 * aqui, não dado — para que passar a cobrar por tirar cebola exija mexer no
 * código e passar por revisão, em vez de alguém trocar um número num JSON.
 *
 * ## Por que a lista é por item, e não global
 *
 * `removable` e `addable` vivem em cada item do `menu.json`. Validar contra a
 * lista **daquele item** e não contra o dicionário inteiro é o que impede
 * "macarrão sem alface" e "água com bacon" — combinações que o modelo pode
 * inventar com a maior naturalidade, porque para ele são só duas strings.
 */

/** Idioma da cozinha — a comanda sai sempre em português, como o nome do item. */
const LANG_COZINHA = 'pt';

/**
 * Teto de modificadores por item.
 *
 * A comanda é papel. Nome de cliente sem teto já consumiu rolo inteiro no
 * projeto irmão (`entrada.js`), e aqui a lista vem de um modelo — que erra em
 * lote quando erra. Vinte é folgado: o item com mais opções tem oito
 * removíveis e nove adicionais.
 */
const MAX_MODIFICADORES = 20;

function porId(id) {
  return dicionario[id] || null;
}

function nomeDe(id, lang) {
  const ing = porId(id);
  if (!ing) return id;
  return ing.name[lang] || ing.name.en || id;
}

function precoDe(id) {
  const ing = porId(id);
  return ing ? Number(ing.price) || 0 : 0;
}

/** O item aceita personalização? */
function tem(item) {
  const m = item?.modifiers;
  if (!m) return false;
  return Boolean(m.removable?.length || m.addable?.length);
}

/**
 * Resolve uma lista de ids do cardápio em objetos com nome e preço.
 *
 * Ids que não existem no dicionário são descartados **em silêncio aqui** — é
 * erro de configuração, e quem o denuncia é `conferir()`, no boot. Deixar
 * quebrar no meio de um pedido seria a hora errada de descobrir.
 */
function resolver(ids, lang) {
  return (ids || [])
    .filter((id) => porId(id))
    .map((id) => ({ id, nome: nomeDe(id, lang), preco: precoDe(id) }));
}

/** O que já vem no item e pode sair. Sempre de graça. */
function removiveis(item, lang) {
  return resolver(item?.modifiers?.removable, lang).map((i) => ({ ...i, preco: 0 }));
}

/**
 * O que pode entrar, com preço.
 *
 * Filtrado por disponibilidade: acabou o bacon, ele some das opções em vez de
 * ser vendido e faltar na hora de montar.
 */
function adicionais(item, lang) {
  return resolver(item?.modifiers?.addable, lang).filter((i) =>
    availability.isAvailable(i.id)
  );
}

// --------------------------------------------------------------- validação

/** Normaliza para lista de strings únicas, sem vazio. */
function limpar(lista) {
  if (!Array.isArray(lista)) return [];
  const vistos = new Set();
  const saida = [];
  for (const bruto of lista) {
    const id = String(bruto ?? '').trim();
    if (!id || vistos.has(id)) continue;
    vistos.add(id);
    saida.push(id);
  }
  return saida;
}

/**
 * A porta. Recebe o que o modelo pediu e devolve o que o carrinho aceita.
 *
 * Argumento de ferramenta é **entrada não confiável** — tão não confiável
 * quanto o texto que o cliente digita, e pela mesma razão: quem escolheu o
 * conteúdo não fomos nós. Por isso cada id é conferido contra a lista daquele
 * item, e não contra o dicionário.
 *
 * Recusa em vez de corrigir. Um `erro` volta ao modelo, que reformula e tenta
 * de novo com o cliente — melhor que montar silenciosamente um sanduíche que
 * ninguém pediu.
 *
 * @returns {{ok: true, removed: string[], added: string[], extra: number}
 *          |{ok: false, erro: string, detalhe?: string[]}}
 */
function validar(item, { remover = [], acrescentar = [] } = {}) {
  if (!item) return { ok: false, erro: 'item_inexistente' };

  const pedidosRemover = limpar(remover);
  const pedidosAcrescentar = limpar(acrescentar);

  if (!pedidosRemover.length && !pedidosAcrescentar.length) {
    return { ok: true, removed: [], added: [], extra: 0 };
  }

  if (!tem(item)) {
    return { ok: false, erro: 'item_nao_personalizavel' };
  }

  if (pedidosRemover.length + pedidosAcrescentar.length > MAX_MODIFICADORES) {
    return { ok: false, erro: 'modificadores_demais' };
  }

  const podeSair = new Set(item.modifiers.removable || []);
  const podeEntrar = new Set(item.modifiers.addable || []);

  // Contradição: tirar e pôr o mesmo ingrediente. Acontece porque vários itens
  // têm o mesmo id nas duas listas — X-Bacon deixa remover o bacon que já vem e
  // acrescentar bacon extra. Pedir os dois é engano, não pedido.
  const conflito = pedidosRemover.filter((id) => pedidosAcrescentar.includes(id));
  if (conflito.length) {
    return { ok: false, erro: 'remover_e_acrescentar_o_mesmo', detalhe: conflito };
  }

  const foraDeRemover = pedidosRemover.filter((id) => !podeSair.has(id));
  if (foraDeRemover.length) {
    return { ok: false, erro: 'nao_removivel', detalhe: foraDeRemover };
  }

  const foraDeAcrescentar = pedidosAcrescentar.filter((id) => !podeEntrar.has(id));
  if (foraDeAcrescentar.length) {
    return { ok: false, erro: 'nao_acrescentavel', detalhe: foraDeAcrescentar };
  }

  const esgotado = pedidosAcrescentar.filter((id) => !availability.isAvailable(id));
  if (esgotado.length) {
    return { ok: false, erro: 'ingrediente_esgotado', detalhe: esgotado };
  }

  return {
    ok: true,
    removed: pedidosRemover,
    added: pedidosAcrescentar,
    extra: precoExtra(pedidosAcrescentar),
  };
}

/** Soma dos adicionais. Remoção nunca entra nesta conta — nem com preço no dicionário. */
function precoExtra(added) {
  return limpar(added).reduce((soma, id) => soma + precoDe(id), 0);
}

// ------------------------------------------------------------ identidade

/**
 * Id do item no carrinho.
 *
 * As duas listas são **ordenadas** antes de virar texto: sem isso, pedir
 * "sem cebola, sem tomate" e "sem tomate, sem cebola" criaria duas linhas
 * separadas para o mesmo sanduíche. Mesmo truque do combo no projeto irmão
 * (`menu.js#pushCombo`).
 *
 * Sem modificador nenhum o id é o do próprio item — assim dois sanduíches
 * padrão somam quantidade em vez de virarem duas linhas.
 */
function cartId(item, { removed = [], added = [] } = {}) {
  const r = [...removed].sort();
  const a = [...added].sort();
  if (!r.length && !a.length) return item.id;

  const partes = [];
  if (r.length) partes.push(`-${r.join(',')}`);
  if (a.length) partes.push(`+${a.join(',')}`);
  return `${item.id}:${partes.join('')}`;
}

/** `X-Bacon (sem cebola, + bacon)` — o que o cliente lê no carrinho e no resumo. */
function rotulo(item, { removed = [], added = [] } = {}, lang) {
  const base = item.name[lang] || item.name.en;
  const partes = [];

  if (removed.length) {
    partes.push(t(lang, 'mod_removed', { items: removed.map((id) => nomeDe(id, lang)).join(', ') }));
  }
  if (added.length) {
    partes.push(t(lang, 'mod_added', { items: added.map((id) => nomeDe(id, lang)).join(', ') }));
  }

  return partes.length ? `${base} (${partes.join(', ')})` : base;
}

/**
 * Linhas indentadas da comanda, em português.
 *
 * Vão para o mesmo array `choices` que o projeto irmão já imprime sob o item —
 * a cozinha lê o que montar sem cruzar com outra linha. O sinal na frente
 * separa o que sai do que entra num relance:
 *
 *     X-Bacon                                x1
 *       - sem cebola
 *       + bacon
 */
function linhasCozinha({ removed = [], added = [] } = {}) {
  return [
    ...removed.map((id) => `- sem ${nomeDe(id, LANG_COZINHA).toLowerCase()}`),
    ...added.map((id) => `+ ${nomeDe(id, LANG_COZINHA).toLowerCase()}`),
  ];
}

// --------------------------------------------------------------- diagnóstico

/**
 * Ids do `menu.json` que não existem no dicionário.
 *
 * Chamado no boot. Um id órfão não quebra nada na hora — `resolver()` o
 * descarta — mas some da lista de opções sem avisar, e o cliente nunca fica
 * sabendo que podia ter pedido sem cebola. Erro de configuração que se anuncia
 * é erro que alguém conserta.
 */
function conferir(menu) {
  const orfaos = [];

  for (const categoria of menu.categories || []) {
    for (const item of categoria.items || []) {
      if (!tem(item)) continue;
      const todos = [
        ...(item.modifiers.removable || []),
        ...(item.modifiers.addable || []),
      ];
      for (const id of todos) {
        if (!porId(id)) orfaos.push({ item: item.id, ingrediente: id });
      }
    }
  }

  return orfaos;
}

module.exports = {
  LANG_COZINHA,
  MAX_MODIFICADORES,
  porId,
  nomeDe,
  precoDe,
  tem,
  removiveis,
  adicionais,
  validar,
  precoExtra,
  cartId,
  rotulo,
  linhasCozinha,
  conferir,
};
