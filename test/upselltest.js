/**
 * A sugestão de bebida: quando sai, quando cala, e uma vez só.
 *
 * Decisão do dono: oferecer **no fechamento**, não a cada item. Cliente que
 * escolheu só sanduíche recebe uma sugestão de bebida antes do resumo.
 *
 * ## O risco que esta suíte guarda
 *
 * O defeito mais caro deste projeto foi o modelo **não** chamar
 * `finalizar_pedido` — ele escrevia o resumo sozinho, o estado nunca ia para
 * CONFIRM, e o "sim" do cliente não fechava pedido nenhum. Consertado fazendo a
 * ferramenta gritar "CHAME finalizar_pedido AGORA".
 *
 * Upsell mexe exatamente aí: dá ao modelo uma razão para adiar o fechamento.
 * Por isso a oferta é **uma por pedido** (`upsellFeito`), e o texto manda fechar
 * assim que o cliente responder — aceitando ou não.
 *
 * ## Por que a regra é do código e o texto é do modelo
 *
 * Sugestão em template sai igual para todo mundo, toda vez, e vira a resposta
 * enlatada que este projeto recusou no FAQ. O código decide **se** e **o quê**;
 * o modelo já vai responder de qualquer forma, e encaixa a oferta na fala dele
 * sem custar uma chamada a mais.
 *
 * Nada aqui chama a API — a regra é determinística, e é isso que se testa.
 */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';

const PROJECT = require('path').resolve(__dirname, '..');
require('./comentrega').ligar();

const tools = require(`${PROJECT}/src/ai/tools`);
const session = require(`${PROJECT}/src/bot/session`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

/** A dica de upsell saiu no resultado da ferramenta? */
const ofereceu = (texto) => /o carrinho não tem bebida/i.test(texto);

let n = 0;
/** Fecha um pedido com o carrinho dado e devolve o resultado do último setter. */
async function fechar(cart, extra = {}) {
  const tel = `1555${++n}`;
  session.clear(tel);
  const s = session.get(tel);
  Object.assign(s, { lang: 'pt', cart, orderType: 'pickup' }, extra);
  const r = await tools.executar('definir_cadastro', { nome: 'Fernando' }, s, async () => {});
  return { texto: r.resultado, sess: s };
}

(async () => {
  // ------------------------------------------- 1. quando a sugestão sai
  console.log('\n\x1b[36m### 1. COMIDA SEM BEBIDA -> SUGERE ###\x1b[0m');

  checar(
    ofereceu((await fechar([{ id: 'x_bacon', qty: 1, price: 14 }])).texto),
    'sanduíche sozinho no carrinho gera a sugestão'
  );
  checar(
    ofereceu((await fechar([{ id: 'macarrao_frango', qty: 1, price: 17 }])).texto),
    'massa também conta como refeição'
  );

  // O carrinho guarda o id COMPOSTO (`x_bacon:-cebola+ovo`), que não existe no
  // cardápio. Sem desfazer a fusão, `itemById` devolve null e a sugestão nunca
  // sairia — falha calada, sem erro nenhum.
  checar(
    ofereceu((await fechar([{ id: 'x_bacon:-cebola+ovo', qty: 1, price: 15 }])).texto),
    'item PERSONALIZADO também — o id composto é desfeito antes de olhar a categoria'
  );

  // ------------------------------------------ 2. quando ela fica calada
  console.log('\n\x1b[36m### 2. QUANDO NAO SUGERE ###\x1b[0m');

  checar(
    !ofereceu(
      (
        await fechar([
          { id: 'x_bacon', qty: 1, price: 14 },
          { id: 'coca_cola', qty: 1, price: 3 },
        ])
      ).texto
    ),
    'já tem bebida — não oferece de novo'
  );
  // Esta asserção já foi o contrário: "só acompanhamento não é refeição — não
  // puxa bebida". Era regra minha, não do dono, e ela calava o upsell
  // justamente para quem leva só batata — quem mais provavelmente esqueceu a
  // bebida. A decisão dele é de uma linha: "se não pediu refrigerante, ofereça
  // refrigerante, simples".
  checar(
    ofereceu((await fechar([{ id: 'batata_frita', qty: 1, price: 6 }])).texto),
    'acompanhamento sem bebida também puxa a oferta — a regra é só "não tem bebida"'
  );
  checar(
    !ofereceu((await fechar([{ id: 'coca_cola', qty: 1, price: 3 }])).texto),
    'só bebida, obviamente, não sugere bebida'
  );

  // ------------------------------- 2b. a pergunta é curta, sem cardápio
  console.log('\n\x1b[36m### 2b. PERGUNTA DE SIM OU NÃO ###\x1b[0m');

  // O texto anterior mandava "ofereça uma do cardápio" e o modelo respondia
  // *"Quer uma bebida pra acompanhar? Temos refrigerante, suco ou água! 🥤"* —
  // recitando as opções numa pergunta que pede só sim ou não, e transformando
  // o fecho numa segunda escolha. Decisão do dono: "uma bebida para
  // acompanhar? não precisa dizer mais nada de exemplo".
  const dica = (await fechar([{ id: 'x_bacon', qty: 1, price: 14 }])).texto;

  checar(
    /NÃO liste opções/i.test(dica) && /NÃO cite exemplos/i.test(dica),
    'a instrução proíbe listar opções e dar exemplos'
  );
  checar(
    /sim ou não/i.test(dica),
    'e diz o formato esperado: pergunta de sim ou não'
  );
  checar(
    /NÃO diga preço/i.test(dica),
    'preço só entra se ele quiser ver o que tem'
  );

  // --------------------------------------- 3. uma vez por pedido, e só
  console.log('\n\x1b[36m### 3. UMA OFERTA POR PEDIDO ###\x1b[0m');

  const tel = '15559999';
  session.clear(tel);
  const s = session.get(tel);
  Object.assign(s, { lang: 'pt', cart: [{ id: 'x_bacon', qty: 1, price: 14 }], orderType: 'pickup' });

  const a = await tools.executar('definir_cadastro', { nome: 'Fernando' }, s, async () => {});
  const b = await tools.executar('definir_cadastro', { nome: 'Fernando' }, s, async () => {});

  checar(ofereceu(a.resultado), 'a primeira passagem oferece');
  checar(!ofereceu(b.resultado), 'a segunda NÃO repete — insistir afasta cliente');
  checar(s.upsellFeito === true, 'e a sessão registra que já ofereceu');

  // ----------------------------- 4. a oferta não pode engolir o fechamento
  console.log('\n\x1b[36m### 4. A OFERTA NAO SUBSTITUI O FECHAMENTO ###\x1b[0m');

  checar(
    /finalizar_pedido/.test(a.resultado),
    'o texto da oferta manda chamar finalizar_pedido assim que ele responder'
  );
  checar(
    /TUDO PRONTO/.test(b.resultado),
    'e a passagem seguinte volta ao empurrão puro de fechar'
  );

  // ------------------------------ 5. pedido incompleto não vira upsell
  console.log('\n\x1b[36m### 5. FALTA DADO -> NAO OFERECE NADA ###\x1b[0m');

  const semNome = await fechar([{ id: 'x_bacon', qty: 1, price: 14 }], { orderType: null });
  checar(
    !ofereceu(semNome.texto),
    'sem tipo de entrega, a prioridade é o que falta — não é hora de vender bebida'
  );

  console.log('\n\x1b[32mupselltest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
