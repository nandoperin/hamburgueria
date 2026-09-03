const assert = require('assert');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const {
  executarProva,
  erroExterno,
  ofertaNaoSolicitada,
} = require(`${PROJECT}/scripts/prova-catalogo`);

function dependencias({
  falasCatalogo = ['Recebi seu X-Bacon. Vai ser entrega ou retirada?'],
  falasCliente = ['Pronto: removi a cebola e acrescentei bacon.'],
  erroCatalogo = null,
  tentarFinalizar = false,
} = {}) {
  const sessoes = new Map();
  const execucoesReais = [];
  const session = {
    get(phone) {
      const sess = { phone, cart: [] };
      sessoes.set(phone, sess);
      return sess;
    },
    clear(phone) {
      sessoes.delete(phone);
    },
  };
  const tools = {
    async executar(nome, args, sess) {
      execucoesReais.push(nome);
      if (nome === 'personalizar_item') {
        sess.cart[0].removed = [...args.remover];
        sess.cart[0].added = [...args.acrescentar];
      }
      return { resultado: 'Alterado.' };
    },
  };
  const agente = {
    async receberCarrinho(_sess, send) {
      if (erroCatalogo) throw erroCatalogo;
      for (const fala of falasCatalogo) await send(fala);
      return true;
    },
    async conversar(sess, _fala, send) {
      await tools.executar(
        'personalizar_item',
        { item_id: 'x_bacon', remover: ['cebola'], acrescentar: ['bacon'] },
        sess,
        send
      );
      if (tentarFinalizar) await tools.executar('finalizar_pedido', {}, sess, send);
      for (const fala of falasCliente) await send(fala);
      return true;
    },
    limpar() {},
  };
  return { deps: { session, tools, agente }, execucoesReais };
}

function verificar(condicao, mensagem, falhas) {
  if (!condicao) falhas.push(mensagem);
}

(async () => {
  const falhas = [];
  const proibidas = [
    'Quer trocar algum ingrediente?',
    'Posso remover ou acrescentar algum ingrediente?',
    'Que tal uma bebida?',
    'Gostaria de uma sobremesa?',
    'Aceita uma porção de batata como acompanhamento?',
    'Posso complementar seu pedido?',
    'Deseja incluir mais algum item?',
    'Mais alguma coisa?',
    'Aproveita e leva uma batata também?',
    'Posso adicionar bacon antes do pagamento?',
    'Quer acrescentar bacon antes de pagar?',
    'Posso incluir bacon e depois confirmar o pagamento?',
    'Bebidas ou sobremesas?',
    'Ingredientes ou adicionais?',
    'Acompanhamentos, porções ou batatas?',
    'Molhos?',
    'Vai uma bebida?',
    'Vai uma sobremesa?',
    'Posso adicionar bacon ao pedido e confirmar seu endereço?',
  ];
  for (const fala of proibidas) {
    verificar(ofertaNaoSolicitada(fala), `não detectou oferta: ${fala}`, falhas);
  }

  const confirmacoes = [
    'Pronto: removi a cebola e acrescentei bacon.',
    'Seu X-Bacon ficou sem cebola e com bacon, como você pediu.',
    'Não incluí bebida nem sobremesa; só fiz a alteração solicitada.',
    'Removi cebola e acrescentei bacon. Vai ser entrega ou retirada?',
    'Posso usar seu endereço anterior?',
    'Posso adicionar seu endereço ao pedido?',
    'Quer pagar com Zelle ou cartão?',
    'O molho foi removido como você pediu?',
    'Os ingredientes foram retirados como solicitado?',
    'O adicional foi retirado como você pediu?',
    'Posso adicionar ao pedido seu endereço?',
    'Posso incluir no pedido o endereço de entrega?',
    'Quer confirmar o pagamento?',
  ];
  for (const fala of confirmacoes) {
    verificar(!ofertaNaoSolicitada(fala), `confirmação virou oferta: ${fala}`, falhas);
  }

  const linhasSucesso = [];
  const sucesso = dependencias();
  const resumoSucesso = await executarProva({
    repeticoes: 1,
    pausaMs: 0,
    deps: sucesso.deps,
    escrever: (linha) => linhasSucesso.push(linha),
  });
  verificar(
    JSON.stringify(resumoSucesso) === JSON.stringify({ passou: 1, falhou: 0, inconclusivo: 0 }),
    `confirmação legítima deveria passar: ${JSON.stringify(resumoSucesso)}`,
    falhas
  );

  const linhasSegundaOferta = [];
  const segundaOferta = dependencias({
    falasCliente: [
      'Pronto: removi a cebola e acrescentei bacon.',
      'Quer aproveitar e pedir uma sobremesa?',
    ],
  });
  const resumoSegundaOferta = await executarProva({
    repeticoes: 1,
    pausaMs: 0,
    deps: segundaOferta.deps,
    escrever: (linha) => linhasSegundaOferta.push(linha),
  });
  verificar(
    resumoSegundaOferta.falhou === 1,
    'oferta na segunda fala após a personalização deveria falhar',
    falhas
  );

  const linhas429 = [];
  const limite = dependencias({
    erroCatalogo: Object.assign(new Error('endpoint secreto'), { statusCode: 429 }),
  });
  const resumo429 = await executarProva({
    repeticoes: 1,
    pausaMs: 0,
    deps: limite.deps,
    escrever: (linha) => linhas429.push(linha),
  });
  verificar(erroExterno(Object.assign(new Error('limit'), { statusCode: 429 })), '429 não classificado', falhas);
  verificar(
    JSON.stringify(resumo429) === JSON.stringify({ passou: 0, falhou: 0, inconclusivo: 1 }),
    `429 deveria ser inconclusivo: ${JSON.stringify(resumo429)}`,
    falhas
  );
  verificar(!linhas429.join('\n').includes('endpoint secreto'), 'mensagem externa vazou', falhas);

  const linhasSanitizadas = [];
  const dadosSensiveis = dependencias({
    falasCatalogo: [
      'Quer uma sobremesa? token=segredo telefone +1 (617) 555-0199',
    ],
  });
  await executarProva({
    repeticoes: 1,
    pausaMs: 0,
    deps: dadosSensiveis.deps,
    escrever: (linha) => linhasSanitizadas.push(linha),
  });
  const saidaSanitizada = linhasSanitizadas.join('\n');
  verificar(!saidaSanitizada.includes('segredo'), 'token vazou na falha lógica', falhas);
  verificar(!saidaSanitizada.includes('617'), 'telefone vazou na falha lógica', falhas);
  verificar(!saidaSanitizada.includes('prova-catalogo-'), 'telefone sintético vazou', falhas);

  const fechamento = dependencias({ tentarFinalizar: true });
  const resumoFechamento = await executarProva({
    repeticoes: 1,
    pausaMs: 0,
    deps: fechamento.deps,
    escrever: () => {},
  });
  verificar(resumoFechamento.falhou === 1, 'tentativa de finalizar deveria falhar', falhas);
  verificar(
    !fechamento.execucoesReais.includes('finalizar_pedido'),
    'finalizar_pedido chegou à implementação real',
    falhas
  );

  if (falhas.length) {
    throw new Error(`prova-catalogo:\n- ${falhas.join('\n- ')}`);
  }
  assert(linhasSucesso.some((linha) => linha.includes('PASSOU 1/1')));
  console.log('Executor determinístico da prova de catálogo passou.');
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
