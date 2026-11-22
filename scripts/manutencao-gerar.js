/**
 * Gera as variáveis da entrada de manutenção (docs/MANUTENCAO_ACESSO.md).
 *
 *   node scripts/manutencao-gerar.js
 *
 * Pede a senha (sem mostrar na tela), e imprime:
 *  - MANUTENCAO_SENHA_HASH  → colar no Railway
 *  - MANUTENCAO_TOTP_SECRET → colar no Railway
 *  - a chave para o Google Authenticator ("Inserir chave de configuração")
 *
 * Nada é salvo em arquivo nem enviado. Feche o terminal depois de copiar.
 */
const crypto = require('crypto');
const readline = require('readline');
const acesso = require('../src/services/manutencao-acesso');

function perguntarEscondido(pergunta) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let escondendo = false;
    rl._writeToOutput = (texto) => { if (!escondendo) rl.output.write(texto); else if (texto.includes('\n')) rl.output.write('\n'); };
    rl.question(pergunta, (resposta) => { rl.close(); resolve(resposta); });
    escondendo = true;
  });
}

(async () => {
  const senha = await perguntarEscondido('Senha nova (12+ caracteres): ');
  if (senha.length < 12) {
    console.error('\nSenha curta demais: use pelo menos 12 caracteres.');
    process.exit(1);
  }
  const repetida = await perguntarEscondido('Repita a senha: ');
  if (repetida !== senha) {
    console.error('\nAs senhas não batem.');
    process.exit(1);
  }

  const segredo = acesso.base32Codificar(crypto.randomBytes(20));
  const chaveLegivel = segredo.match(/.{1,4}/g).join(' ');

  console.log('\n--- Cole no Railway (serviço do bot → Variables) ---\n');
  console.log(`MANUTENCAO_SENHA_HASH=${acesso.gerarHashSenha(senha)}`);
  console.log(`MANUTENCAO_TOTP_SECRET=${segredo}`);
  console.log('\n--- No Google Authenticator: "+" → "Inserir chave de configuração" ---\n');
  console.log('Nome da conta: Painel manutenção');
  console.log(`Chave: ${chaveLegivel}`);
  console.log('Tipo: baseado no tempo\n');
  console.log('Não gere QR code em site nenhum com essa chave. Feche este terminal depois de copiar.');
})();
