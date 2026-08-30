/**
 * Cliente conhecido escolheu entrega: antes de pedir que redigite tudo, o bot
 * deve oferecer o ultimo endereco e aceitar um simples "sim".
 */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'off';

require('./comentrega').ligar();

const tools = require('../src/ai/tools');
const session = require('../src/bot/session');

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  const telefone = '15551110002';
  session.clear(telefone);
  const s = session.get(telefone);
  const endereco = '2021 Revere Beach Parkway, Everett, MA 02149';
  Object.assign(s, {
    lang: 'pt',
    state: 'ORDER',
    name: 'Fernando',
    lastAddress: endereco,
    lastCityId: 'everett',
    cart: [{ id: 'x_burger', name: 'X-Burger', price: 11, qty: 1 }],
  });

  const enviadas = [];
  const entrega = await tools.executar(
    'definir_entrega',
    { tipo: 'delivery' },
    s,
    async (texto) => enviadas.push(texto),
    { textoCliente: 'entrega' }
  );
  const oferta = tools.mensagemAposEntrega(s);

  checar(!entrega.bloqueiaFluxo, 'a escolha de entrega foi aceita');
  checar(!enviadas.length, 'nenhuma mensagem sai antes de o lote inteiro ser validado');
  checar(Boolean(oferta), 'a oferta sai direto pelo codigo, sem outra chamada a IA');
  checar(oferta.includes(endereco), 'mostra o endereco conhecido completo ao escolher entrega');
  checar(/\?/.test(oferta), 'pede apenas a confirmacao do endereco conhecido');
  checar(
    !/Falta o ENDERE[CÇ]O COMPLETO/i.test(oferta),
    'nao pede para o cliente conhecido redigitar o endereco'
  );
  checar(s.confirmandoEnderecoAnterior === true, 'registra que a proxima resposta confirma o endereco');

  const confirmou = await tools.confirmarEnderecoPendente(
    s,
    'sim',
    async (texto) => enviadas.push(texto)
  );

  checar(confirmou, 'um simples sim e resolvido pelo codigo, sem chamar a IA');
  checar(s.city?.label === 'Everett', 'cidade conhecida e reaproveitada');
  checar(s.address === endereco, 'endereco anterior vira o endereco atual');
  checar(!s.confirmandoEnderecoAnterior, 'confirmacao pendente e encerrada depois do sim');
  checar(s.state === 'CONFIRM', 'abre diretamente o resumo para confirmacao do pedido');

  s.city = null;
  s.address = null;
  s.confirmandoEnderecoAnterior = true;
  s.enderecoAnteriorRecusado = false;
  tools.observarMensagem(s, 'não, mudei de endereço');
  const depoisDaRecusa = tools.orientacao(s);

  checar(!s.confirmandoEnderecoAnterior, 'nao encerra a confirmacao pendente');
  checar(s.enderecoAnteriorRecusado, 'marca que o endereco anterior foi recusado');
  checar(!depoisDaRecusa.includes(endereco), 'nao oferece novamente o endereco recusado');
  checar(/street|endere[cç]o/i.test(depoisDaRecusa), 'pede o novo endereco sem travar');

  console.log('\n\x1b[32mconfirmarenderecotest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
