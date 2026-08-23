/**
 * O prompt não pode conter dado pessoal plausível.
 *
 * Relato de produção: *"ele achou que era primeira vez, depois me chamou de
 * nome errado"*.
 *
 * O nome errado tinha origem. O system prompt trazia, como exemplo didático:
 *
 *     "um x-burger, entrega pra Chelsea, 250 Broadway, meu nome é João"
 *
 * Modelo pequeno preenche lacuna com o que tem à mão. Perguntado pelo nome do
 * cliente sem ter recebido nenhum, "João" estava ali, no contexto, com a
 * etiqueta "meu nome é" colada nele. Não é alucinação: é o exemplo sendo lido
 * como dado.
 *
 * ## Por que isto merece uma suíte
 *
 * Porque o exemplo é a coisa mais natural do mundo de escrever, e o dano é
 * invisível de dentro: o prompt fica mais claro para um humano e mais
 * perigoso para o modelo. Nenhum teste de ferramenta pega — `definir_cadastro`
 * recebe um nome válido e faz seu trabalho direito. O erro está em QUAL nome.
 *
 * Chamar o cliente pelo nome de outra pessoa é pior que não usar nome nenhum:
 * quebra a confiança justamente onde o bot tentava criá-la.
 */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';

const PROJECT = require('path').resolve(__dirname, '..');

require('./comentrega').ligar();

const cardapio = require(`${PROJECT}/src/services/cardapio`);
const faq = require(`${PROJECT}/src/bot/handlers/faq`);
const tools = require(`${PROJECT}/src/ai/tools`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

/**
 * Tudo que o modelo lê antes da primeira palavra do cliente.
 *
 * `systemPrompt()` é interno a `agente.js`, então remonto as mesmas partes que
 * ele junta — instruções vêm do arquivo, cardápio e fatos dos services, e o
 * esquema das ferramentas de `tools.js`. O esquema conta: ele vai no payload
 * junto do system, e o modelo lê as descrições igual.
 */
function tudoQueOModeloLe() {
  return [
    require('fs').readFileSync(`${PROJECT}/src/ai/agente.js`, 'utf8'),
    cardapio.paraModelo('pt'),
    faq.paraModelo('pt'),
    JSON.stringify(tools.SCHEMA),
  ].join('\n');
}

(async () => {
  const texto = tudoQueOModeloLe();

  // ------------------------------------------- 1. nomes próprios de pessoa
  console.log('\n\x1b[36m### 1. NENHUM NOME DE PESSOA COMO EXEMPLO ###\x1b[0m');

  // Nomes comuns em exemplo de código em português. A lista não precisa ser
  // exaustiva: ela pega a tentação, que é sempre o primeiro nome que vem à
  // cabeça de quem está escrevendo o exemplo.
  const NOMES = ['João', 'Joao', 'Maria', 'José', 'Jose', 'Ana', 'Pedro', 'Carlos', 'Fulano'];

  for (const nome of NOMES) {
    // Só na parte que vira prompt: o arquivo tem comentários JSDoc que
    // explicam o problema e citam os nomes de propósito. O recorte é o texto
    // entre crases do template literal do systemPrompt.
    const dentroDoPrompt = texto
      .split('return `Você é o atendente virtual')[1]
      ?.split('Responda sempre em ')[0] || '';

    checar(
      !dentroDoPrompt.includes(nome),
      `"${nome}" não aparece no system prompt — nome em exemplo vira nome do cliente`
    );
  }

  // --------------------------- 2. a regra que fecha a porta está declarada
  console.log('\n\x1b[36m### 2. O PROMPT DIZ DE ONDE UM NOME PODE VIR ###\x1b[0m');
  checar(
    /só existem se o CLIENTE os disser|só existem se o cliente os disser|só existem/i.test(texto) ||
      texto.includes('Nome, endereço e telefone só existem'),
    'o prompt declara que nome/endereço só vêm do cliente ou do contexto do sistema'
  );
  checar(
    texto.includes('errar o nome de quem está comprando'),
    'e diz por que: errar o nome é pior que não usar nome nenhum'
  );

  // ------------------------------- 3. o esquema de ferramentas também limpo
  console.log('\n\x1b[36m### 3. AS DESCRICOES DE FERRAMENTA NAO TRAZEM DADO ###\x1b[0m');
  const esquema = JSON.stringify(tools.SCHEMA);

  for (const nome of NOMES) {
    checar(
      !esquema.includes(nome),
      `"${nome}" não aparece na descrição de nenhuma ferramenta`
    );
  }

  // Endereço concreto é a mesma armadilha, um degrau abaixo: menos perigoso
  // que um nome (o endereço é confirmado), mas ainda é dado plausível.
  checar(
    !/\d{2,}\s+(Broadway|Main|Revere)/i.test(esquema),
    'nenhum endereço de exemplo com número e rua na descrição das ferramentas'
  );

  // -------------------------- 4. o cardápio pode ter nome — de COMIDA
  console.log('\n\x1b[36m### 4. O CARDAPIO SEGUE LIVRE ###\x1b[0m');
  checar(
    cardapio.paraModelo('pt').length > 100,
    'o cardápio continua indo inteiro para o prompt — a regra é sobre dado PESSOAL'
  );

  console.log('\n\x1b[32mcontaminacaotest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
