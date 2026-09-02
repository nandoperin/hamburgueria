const path = require('path');
const PROJECT = path.resolve(__dirname, '..');

let itens = [
  { id: 'x_bacon', name: { pt: 'X-Bacon' }, price: 14, available: true },
  { id: 'x_tudo', name: { pt: 'X Tudo' }, price: 17, available: true },
];

const cardapioPath = require.resolve(`${PROJECT}/src/services/cardapio`);
require.cache[cardapioPath] = {
  id: cardapioPath,
  filename: cardapioPath,
  loaded: true,
  exports: {
    allItems: () => itens,
    itemsOfCategory: () => [],
  },
};

delete require.cache[require.resolve(`${PROJECT}/src/services/catalog`)];
const catalog = require(`${PROJECT}/src/services/catalog`);

function checar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
}

checar(catalog.resolverNomePt('x bacon').item.id === 'x_bacon', 'ignora hífen');
checar(catalog.resolverNomePt('  X–BÁCON! ').item.id === 'x_bacon', 'ignora acento e pontuação');

itens = [{ id: 'novo', name: { pt: 'Novo Lanche' }, price: 9, available: true }];
checar(catalog.allItems()[0].id === 'novo', 'não congela o menu no require');

itens = [
  { id: 'a', name: { pt: 'X Bacon' }, price: 1, available: true },
  { id: 'b', name: { pt: 'X-Bacon' }, price: 2, available: true },
];
const ambiguo = catalog.resolverNomePt('x bacon');
checar(!ambiguo.ok && ambiguo.erro === 'ambiguo', 'não escolhe entre nomes duplicados');
