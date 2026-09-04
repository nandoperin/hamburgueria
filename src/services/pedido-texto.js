const cardapio = require('./cardapio');
const modifiers = require('./modifiers');
const salsicha = require('./preparo-salsicha');

const normalizar = texto => String(texto || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
const escapar = texto => texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const quantidades = { um: 1, uma: 1, dois: 2, duas: 2 };

// Gramática conservadora para NOVOS itens. Qualquer trecho desconhecido volta
// inteiro à IA; nunca aplicar metade da frase ou descartar uma observação.
function interpretar(texto) {
  if (String(texto).length > 1200 || /[?!]/.test(texto)) return null;
  const itens = cardapio.allItems().filter(i => !i.options?.picks &&
    ['sanduiches', 'hotdogs', 'massas', 'bebidas'].includes(i.category.id));
  const apelidos = { coca_cola: ['coca'], fanta_laranja: ['fanta'] };
  const nomes = itens.flatMap(item => [...new Set([normalizar(item.name.pt), ...(apelidos[item.id] || [])])]
    .map(nome => ({ item, nome })))
    .sort((a, b) => b.nome.length - a.nome.length);
  const padrao = nome => escapar(nome).replace(/^x /, 'x\\s*');
  const inicio = `(?:(?:\\d{1,2}|um|uma|dois|duas)\\s+)?(?:${nomes.map(n => padrao(n.nome)).join('|')})(?=\\s|$)`;
  let input = normalizar(texto).replace(/^(?:quero|vou querer|me ve)\s+/, '');
  if (!input || !nomes.length) return null;
  // "e ovo" continua sendo ingrediente, não outro produto avulso.
  const partes = input.split(new RegExp(`\\s+e\\s+(?=${inicio})`));
  if (partes.length > 20) return null;
  const plano = [];
  for (let parte of partes) {
    let quantidade = 1;
    const q = /^(\d{1,2}|um|uma|dois|duas)\s+/.exec(parte);
    if (q) { quantidade = quantidades[q[1]] || Number(q[1]); parte = parte.slice(q[0].length); }
    if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 20) return null;
    const matches = nomes.map(n => ({ ...n, match: new RegExp(`^${padrao(n.nome)}(?=\\s|$)`).exec(parte) }))
      .filter(n => n.match);
    if (!matches.length) return null;
    const escolhido = matches[0];
    if (matches.filter(n => n.match[0].length === escolhido.match[0].length).length !== 1) return null;
    const { item } = escolhido;
    let resto = parte.slice(escolhido.match[0].length).trim();
    const remover = [], acrescentar = [];
    while (resto) {
      const grupo = /^(sem|com)\s+(.+?)(?=\s+(?:sem|com)\s+|$)/.exec(resto);
      if (!grupo) return null;
      const ids = item.modifiers?.[grupo[1] === 'sem' ? 'removable' : 'addable'] || [];
      for (let ingrediente of grupo[2].split(/\s+e\s+|\s*,\s*/)) {
        if (grupo[1] === 'com') ingrediente = ingrediente.replace(/\s+extra$/, '');
        const encontrados = ids.filter(id => normalizar(modifiers.nomeDe(id, 'pt')) === ingrediente.trim());
        if (encontrados.length !== 1) return null;
        const lista = grupo[1] === 'sem' ? remover : acrescentar;
        if (lista.includes(encontrados[0])) return null; // não reduzir duas porções a uma
        lista.push(encontrados[0]);
      }
      resto = resto.slice(grupo[0].length).trim();
    }
    plano.push({ item, quantidade, remover, acrescentar });
  }
  return plano;
}

async function atender(sess, texto, send) {
  if (!['MENU', 'ORDER'].includes(sess.state) || (sess.lang && sess.lang !== 'pt')) return false;
  // O primeiro pedido pode vir direto após o olá, sem abrir menu/catálogo.
  // Personalização de produto já no carrinho é ambígua sem seleção aberta:
  // a checagem após interpretar deixa a IA distinguir edição de nova unidade.
  // Uma salsicha avulsa já cobrada pode ser destino de personalização, não outra venda.
  if (salsicha.pendente(sess)) return false;
  const plano = interpretar(texto);
  if (!plano) return false;
  if (!sess.menuSelection && plano.some(p =>
    (p.remover.length || p.acrescentar.length) &&
    sess.cart.some(l => (l.productId || String(l.id).split(':')[0]) === p.item.id))) return false;
  if (plano.some(p => p.acrescentar.includes('salsicha')) && sess.cart.some(salsicha.avulsa)) return false;
  for (const p of plano) {
    if (!cardapio.disponivel(p.item)) {
      await send(`${p.item.name.pt} está indisponível agora. Não adicionei os itens dessa mensagem.`);
      return true;
    }
    if (!modifiers.validar(p.item, p).ok) return false;
  }
  const tools = require('../ai/tools');
  const rascunho = { ...sess, cart: structuredClone(sess.cart) };
  const totalAnterior = rascunho.cart.reduce((s, l) => s + l.qty, 0);
  for (const p of plano) {
    await tools.executar('adicionar_item', { item_id: p.item.id, quantidade: p.quantidade,
      remover: p.remover, acrescentar: p.acrescentar }, rascunho, async () => {});
  }
  const totalDepois = rascunho.cart.reduce((s, l) => s + l.qty, 0);
  if (totalDepois !== totalAnterior + plano.reduce((s, p) => s + p.quantidade, 0)) return false;
  sess.cart = rascunho.cart;
  sess.state = 'ORDER';
  sess.menuSelection = null;
  const linhas = plano.map(p => {
    const val = modifiers.validar(p.item, p);
    return `${p.quantidade}x ${modifiers.rotulo(p.item, val, 'pt')} — $${(p.item.price + val.extra).toFixed(2)} cada`;
  });
  const agente = require('../ai/agente');
  agente.registrarSaudacao(sess, 'Itens registrados pelo sistema: ' + sess.cart.map(l => `[${l.id}] ${l.qty}x ${l.name}`).join('; '));
  const pergunta = salsicha.pergunta(sess) || tools.mensagemColeta(sess);
  const fala = `Anotei:\n${linhas.join('\n')}${pergunta ? '\n\n' + pergunta : ''}`;
  await send(fala);
  agente.registrarSaudacao(sess, fala);
  if (!pergunta) await require('../bot/handlers/order').mostrarResumo(sess, send);
  return true;
}

module.exports = { interpretar, atender };
