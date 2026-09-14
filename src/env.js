const fs = require('node:fs');

/** Carrega o .env local quando existe; no Railway as variáveis já vêm prontas. */
module.exports = function carregarEnv(caminho = '.env') {
  if (fs.existsSync(caminho)) process.loadEnvFile(caminho);
};
