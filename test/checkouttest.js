/**
 * O checkout conduzido pela IA.
 *
 * O agente passou a conduzir entrega, cidade, endereço e cadastro conversando,
 * em vez de entregar o cliente a um menu numerado no momento mais delicado do
 * pedido. Estas suítes travam o que **não** mudou junto: quem decide.
 *
 * O teste central é o da cobertura. O modelo extrai a cidade de uma frase
 * solta, mas quem responde "atende ou não" é o `delivery.json`. Se essa linha
 * ceder, "moro em Boston mas é bem pertinho" passa a funcionar — e uma vez
 * basta para sair entregador para fora da área.
 *
 * Nada aqui chama a API do modelo: as ferramentas são exercitadas direto, que é
 * o que torna a suíte determinística e de graça.
 */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';
process.env.ADMIN_PHONE = '16174449612';

const PROJECT = require('path').resolve(__dirname, '..');

require('./comentrega').ligar();

const tools = require(`${PROJECT}/src/ai/tools`);
const session = require(`${PROJECT}/src/bot/session`);

const TEL = '15551234567';

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const enviados = [];
const send = async (t) => enviados.push(t);

/** Chama uma ferramenta como o agente chamaria. */
async function chamar(nome, args = {}) {
  const sess = session.get(TEL);
  const r = await tools.executar(nome, args, sess, send);
  return r.resultado;
}

(async () => {
  // ------------------------------------------- 1. cidade fora da area
  console.log('\n\x1b[36m### 1. CIDADE QUE NAO ATENDEMOS ###\x1b[0m');
  session.clear(TEL);
  const s = session.get(TEL);
  s.lang = 'pt';

  await chamar('adicionar_item', { item_id: 'x_bacon' });

  let r = await chamar('definir_cidade', { cidade: 'Boston' });
  console.log('   ' + r.replace(/\n/g, ' '));

  checar(/NÃO ATENDEMOS/.test(r), 'a ferramenta recusa Boston, em voz alta');
  checar(/Everett/.test(r), 'e diz quais cidades existem, para o modelo oferecer');
  checar(/retirada/i.test(r), 'e manda oferecer a retirada — o cliente nao fica sem saida');
  checar(!s.city, 'a cidade NAO foi gravada na sessao');

  // ------------------------------------------- 2. insistir nao funciona
  console.log('\n\x1b[36m### 2. INSISTIR NAO ABRE A PORTA ###\x1b[0m');
  for (const tentativa of ['Boston mas e pertinho', 'Somerville', 'Cambridge, bem do lado']) {
    const resp = await chamar('definir_cidade', { cidade: tentativa });
    checar(/NÃO ATENDEMOS/.test(resp) && !s.city, `"${tentativa}" continua recusado`);
  }

  // ------------------------------------------ 3. finalizar barra o furo
  console.log('\n\x1b[36m### 3. FINALIZAR SEM CIDADE NAO PASSA ###\x1b[0m');
  await chamar('definir_entrega', { tipo: 'delivery' });
  await chamar('definir_cadastro', { nome: 'Maria Souza' });

  r = await chamar('finalizar_pedido');
  // A asserção era `/CIDADE/` — a palavra exata, em maiúsculas. Ela deixou de
  // casar quando cidade e endereço passaram a ser pedidos juntos ("o ENDEREÇO
  // COMPLETO — rua, número E cidade"), que é a mudança que tirou uma pergunta
  // do fechamento. O que este cenário guarda não é a palavra: é que finalizar
  // **recusa** enquanto a cidade não estiver gravada, e diz o que falta.
  checar(!s.city, 'a cidade continua sem ser gravada');
  checar(
    /endereço completo|CIDADE/i.test(r) && /falta/i.test(r),
    'finalizar_pedido recusa e diz que falta o endereço (cidade inclusa)'
  );
  checar(
    enviados.length === 0,
    'e nenhum resumo foi enviado ao cliente — nada de pedido pela metade'
  );

  // ------------------------------------------------- 4. cidade atendida
  console.log('\n\x1b[36m### 4. CIDADE ATENDIDA ###\x1b[0m');
  r = await chamar('definir_cidade', { cidade: 'moro em chelsea' });
  console.log('   ' + r.replace(/\n/g, ' '));
  checar(s.city?.id === 'chelsea', 'reconhece a cidade dentro da frase solta');
  checar(/7\.00/.test(r), 'e devolve a taxa que o delivery.json manda');

  // -------------------------------------------- 5. a taxa nao vem do modelo
  console.log('\n\x1b[36m### 5. A TAXA NAO E NEGOCIAVEL ###\x1b[0m');
  const cidade = require(`${PROJECT}/src/services/delivery`).acharCidade('chelsea');
  checar(
    Number(cidade.delivery_fee) === Number(s.city.delivery_fee),
    'a taxa da sessao e exatamente a do arquivo — nao ha por onde o modelo mudar'
  );
  // Nenhuma ferramenta aceita valor: e a garantia estrutural, nao uma checagem.
  const aceitamValor = tools.SCHEMA.filter((f) =>
    /taxa|preco|price|valor|total|desconto/i.test(JSON.stringify(f.input_schema))
  );
  checar(
    aceitamValor.length === 0,
    'NENHUMA ferramenta recebe preco, taxa ou desconto como parametro'
  );

  // ------------------------------------------------- 6. endereco e cadastro
  console.log('\n\x1b[36m### 6. ENDERECO E CADASTRO ###\x1b[0m');
  r = await chamar('definir_endereco', { endereco: '' });
  checar(/vazio/i.test(r) && !s.address, 'endereco vazio e recusado');

  await chamar('definir_endereco', { endereco: '250' });
  checar(s.address === '250', 'endereco livre nao exige formato postal');

  await chamar('definir_endereco', { endereco: '250 Broadway, apt 5' });
  checar(s.address === '250 Broadway, apt 5', 'apartamento, quando informado, e preservado');

  await chamar('definir_cadastro', { nome: 'Maria', email: 'nao-e-email' });
  checar(!s.email, 'email malformado nao entra');
  await chamar('definir_cadastro', { nome: 'Maria', email: 'maria@teste.com' });
  checar(s.email === 'maria@teste.com', 'email valido entra');

  // ---------------------------------------------- 7. o resumo e do codigo
  console.log('\n\x1b[36m### 7. O RESUMO E DO CODIGO ###\x1b[0m');
  enviados.length = 0;
  r = await chamar('finalizar_pedido');

  checar(enviados.length === 1, 'agora sim o resumo foi enviado');
  const resumo = enviados[0];
  console.log('   ' + resumo.replace(/\n/g, ' | '));

  checar(/Chelsea/.test(resumo), 'o resumo traz a cidade');
  checar(/7\.00/.test(resumo), 'a taxa vem do arquivo');
  checar(/21\.00/.test(resumo), 'o total e subtotal + taxa, somado pelo codigo ($14 + $7)');
  checar(
    /nao repita|não repita/i.test(r),
    'e a ferramenta manda o modelo NAO repetir os valores'
  );
  checar(s.state === 'CONFIRM', 'o estado foi para CONFIRM — o compromisso e do codigo');

  // ----------------------------------------------------- 8. retirada
  console.log('\n\x1b[36m### 8. RETIRADA DISPENSA CIDADE E ENDERECO ###\x1b[0m');
  session.clear(TEL);
  const s2 = session.get(TEL);
  s2.lang = 'pt';
  await chamar('adicionar_item', { item_id: 'x_burger' });
  await chamar('definir_entrega', { tipo: 'pickup' });
  await chamar('definir_cadastro', { nome: 'Joao' });

  enviados.length = 0;
  await chamar('finalizar_pedido');
  checar(enviados.length === 1, 'fecha sem pedir cidade nem endereco');
  checar(!/Taxa de entrega/i.test(enviados[0]), 'e sem taxa de entrega no resumo');

  console.log('\n\x1b[32mcheckouttest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
