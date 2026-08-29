/**
 * O fechamento em uma troca, e a memória que morre junto com o pedido.
 *
 * ## O que esta suíte guarda
 *
 * Um teste real no WhatsApp mostrou o fechamento virando formulário:
 *
 *     Bot: É entrega ou retirada?          Cliente: Entrega
 *     Bot: Pra qual cidade?                Cliente: Everett
 *     Bot: Qual a rua e número?            Cliente: 6 elm st
 *     Bot: Anotei! Qual é o nome?          Cliente: Fernando
 *
 * Quatro idas e voltas para três dados que cabem numa frase. E a causa não
 * estava no prompt: estava aqui, no texto que as ferramentas devolvem.
 * `oQueFalta` fazia `return` na primeira falta encontrada, e `definir_entrega`
 * mandava literalmente *"Agora pergunte a cidade"*. O modelo obedecia.
 *
 * É por isso que o teste vive no lado do código e não numa prova de conversa:
 * o que desenha o formato da conversa é determinístico, e determinístico se
 * mede sem gastar chamada paga.
 *
 * ## E o "Já disse entrega"
 *
 * O outro defeito era invisível na leitura e óbvio na tela: o histórico do
 * modelo nunca era limpo fora de `finalizar_pedido`. Pedido cancelado, `0`,
 * sessão expirada — a sessão zerava `orderType` e o modelo continuava lendo o
 * cliente dizer "Entrega" na conversa anterior. Ele perguntava de novo o que
 * estava escrito na tela, e o cliente respondia *"Já disse entrega"*.
 *
 * Os cenários 3 e 4 são a rede: qualquer reinício futuro que esqueça de levar
 * o histórico junto quebra aqui, e não em produção.
 */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';
process.env.AI_PROVIDER = 'mistral';
process.env.MISTRAL_API_KEY = 'fake';

const PROJECT = require('path').resolve(__dirname, '..');
require('./comentrega').ligar();

const tools = require(`${PROJECT}/src/ai/tools`);
const session = require(`${PROJECT}/src/bot/session`);
// Requerer o agente é o que registra o ouvinte de reinício — em produção quem
// o carrega é o router. Sem esta linha os cenários 3 e 4 passariam por engano.
const agente = require(`${PROJECT}/src/ai/agente`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const X_TUDO = { id: 'x_tudo', name: 'X-Tudo', price: 16, qty: 1 };

let n = 0;
function sessaoCom(extra = {}) {
  const tel = `1666${++n}`;
  session.clear(tel);
  const s = session.get(tel);
  Object.assign(s, { lang: 'pt', cart: [{ ...X_TUDO }] }, extra);
  return s;
}

const chamar = (nome, args, s) =>
  tools.executar(nome, args, s, async () => {}).then((r) => r.resultado);

(async () => {
  // ----------------------------------- 1. a coleta pede tudo o que falta
  console.log('\n\x1b[36m### 1. UMA PERGUNTA, TODOS OS CAMPOS ###\x1b[0m');

  const s1 = sessaoCom();
  const aoEscolherEntrega = await chamar('definir_entrega', { tipo: 'delivery' }, s1);

  checar(
    /cidade/i.test(aoEscolherEntrega) &&
      /rua/i.test(aoEscolherEntrega) &&
      /nome/i.test(aoEscolherEntrega),
    'ao escolher entrega, a ferramenta pede cidade, rua E nome de uma vez'
  );
  checar(
    /na mesma mensagem/i.test(aoEscolherEntrega),
    'e diz explicitamente para pedir na mesma mensagem'
  );
  // A frase pronta, e não só a lista: com a lista o modelo pedia o endereço e
  // esquecia o nome, e o fechamento parava em três trocas em vez de duas.
  checar(
    /me passa seu nome e o endereço completo/i.test(aoEscolherEntrega),
    'e entrega a frase pronta, em vez de pedir ao modelo que a monte'
  );
  checar(
    !/agora pergunte a cidade/i.test(aoEscolherEntrega),
    'não manda mais perguntar a cidade sozinha — era a origem da troca extra'
  );

  // ------------------------------- 2. completado, vai direto ao resumo
  console.log('\n\x1b[36m### 2. COMPLETO -> FINALIZAR, SEM ECO ###\x1b[0m');

  const s2 = sessaoCom({ orderType: 'delivery' });
  await chamar('definir_cidade', { cidade: 'Everett' }, s2);
  await chamar('definir_endereco', { endereco: '6 Elm St' }, s2);
  const aoDarONome = await chamar('definir_cadastro', { nome: 'Fernando' }, s2);

  checar(
    /CHAME finalizar_pedido AGORA/i.test(aoDarONome),
    'com tudo preenchido, a ferramenta manda finalizar na mesma resposta'
  );
  checar(
    /anotei/i.test(aoDarONome) && /repetir o endereço/i.test(aoDarONome),
    'e proíbe o eco ("Anotei! 6 Elm St") que duplicava o resumo'
  );

  // O caminho de trás: finalizar com campo faltando devolve a lista, não um só.
  const s2b = sessaoCom({ orderType: 'delivery' });
  const semNada = await chamar('finalizar_pedido', {}, s2b);
  checar(
    /CIDADE/i.test(semNada) && /NOME/i.test(semNada),
    'finalizar_pedido incompleto também devolve tudo o que falta, não o primeiro'
  );

  // ------------------- 2b. o que já foi decidido não é perguntado de novo
  console.log('\n\x1b[36m### 2b. NÃO REPERGUNTA O RESOLVIDO ###\x1b[0m');

  // "Já havia escolhido retirada, perguntou de novo se era entrega ou
  // retirada" — relato de um teste real. A ferramenta dizia só o que falta; o
  // que já estava decidido ficava implícito, e o modelo reperguntava.
  const s2c = sessaoCom();
  const aoEscolherRetirada = await chamar('definir_entrega', { tipo: 'pickup' }, s2c);

  checar(
    /JÁ SABEMOS/i.test(aoEscolherRetirada) && /RETIRADA/i.test(aoEscolherRetirada),
    'escolhida a retirada, a ferramenta repete que isso já está decidido'
  );
  checar(
    /não pergunte de novo/i.test(aoEscolherRetirada),
    'e diz explicitamente para não reperguntar'
  );

  // Entrega com endereço já registrado: o mesmo vale para os outros campos.
  const s2d = sessaoCom({ orderType: 'delivery' });
  await chamar('definir_cidade', { cidade: 'Everett' }, s2d);
  const aoRegistrarEndereco = await chamar('definir_endereco', { endereco: '6 Elm St' }, s2d);
  checar(
    /Everett/.test(aoRegistrarEndereco) && /6 Elm St/.test(aoRegistrarEndereco),
    'cidade e endereço registrados voltam como "já sabemos", não como pergunta'
  );

  // ----------------------------- 3. reiniciar o pedido apaga o histórico
  console.log('\n\x1b[36m### 3. RESET LEVA O HISTÓRICO JUNTO ###\x1b[0m');

  const s3 = sessaoCom({ orderType: 'delivery', name: 'Fernando' });
  const tel3 = s3.phone;

  // Simula uma conversa já acontecida: é isto que sobrevivia ao reset.
  agente.getHistorico(tel3).push({ role: 'user', content: 'Entrega' });
  checar(
    agente.getHistorico(tel3).length === 1,
    'o histórico do modelo existe enquanto o pedido existe'
  );

  session.reset(tel3);
  checar(
    agente.getHistorico(tel3).length === 0,
    'reiniciar o pedido apaga a conversa antiga do modelo'
  );

  // --------------------------- 4. sessão expirada também limpa
  console.log('\n\x1b[36m### 4. SESSÃO EXPIRADA TAMBÉM ###\x1b[0m');

  const s4 = sessaoCom({ orderType: 'delivery' });
  const tel4 = s4.phone;
  agente.getHistorico(tel4).push({ role: 'user', content: 'Entrega' });

  // Envelhece a sessão além do timeout e força a releitura.
  s4.lastActivity = 0;
  const renovada = session.get(tel4);

  checar(!renovada.orderType, 'sessão expirada volta zerada');
  checar(
    agente.getHistorico(tel4).length === 0,
    'e o histórico do modelo não sobrevive a ela — era o vazamento entre pedidos'
  );

  // --------------------------- 5. a ordem das chamadas de uma mesma resposta
  console.log('\n\x1b[36m### 5. CIDADE ANTES DO ENDEREÇO ###\x1b[0m');

  // Pedir nome e endereço juntos faz o modelo emitir tudo numa resposta só, na
  // ordem em que leu a frase. `definir_endereco` recusa sem cidade.
  const emitidas = [
    { nome: 'definir_endereco' },
    { nome: 'definir_cadastro' },
    { nome: 'definir_cidade' },
    { nome: 'adicionar_item' },
  ];
  const ordem = agente.ordenar(emitidas).map((c) => c.nome);

  checar(
    ordem.indexOf('definir_cidade') < ordem.indexOf('definir_endereco'),
    'a cidade roda antes do endereço, qualquer que seja a ordem do modelo'
  );
  checar(
    ordem[0] === 'adicionar_item',
    'e o item entra no carrinho antes dos setters lerem "o que falta"'
  );

  console.log('\n\x1b[32m✓ fechamentotest passou\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m✗ ${err.message}\x1b[0m`);
  process.exit(1);
});
