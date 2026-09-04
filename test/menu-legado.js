// Cenários antigos exercitam o motor com uma receita/preço fixos, não o menu da loja.
// O cardápio real de 03/09/2026 é coberto separadamente por cardapiorealtest.
for (const key of ['menu', 'ingredientes']) {
  const file = require.resolve(`../config/${key}.json`);
  require(file);
  require.cache[file].exports = require(`./fixtures/${key}-legado.json`);
}
