/** Endereco e texto livre; a unica regra de negocio e a cidade atendida. */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://fake.test';
process.env.BUSINESS_NAME = 'Point Burger';
process.env.AI_ENABLED = 'off';

require('./comentrega').ligar();

const tools = require('../src/ai/tools');
const delivery = require('../src/services/delivery');
const session = require('../src/bot/session');

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  const telefone = '15551110001';
  session.clear(telefone);
  const s = session.get(telefone);
  const base = {
    lang: 'pt',
    state: 'ORDER',
    orderType: 'delivery',
    name: 'Fernando',
    cart: [{ id: 'x_burger', name: 'X-Burger', price: 11, qty: 1 }],
  };
  Object.assign(s, base);

  for (const escrito of [
    '6 main st everett',
    '6 main st, everett',
    '6 main st\neverett',
    'Main Street Everett',
  ]) {
    s.city = null;
    s.address = null;
    const aceito = await tools.executar(
      'definir_endereco',
      { endereco: escrito },
      s,
      async () => {},
      { textoCliente: escrito }
    );

    checar(!aceito.bloqueiaFluxo, `aceita endereco livre: ${JSON.stringify(escrito)}`);
    checar(s.city?.id === 'everett', 'encontra Everett dentro do endereco completo');
    checar(s.address === escrito, 'preserva o endereco como o cliente escreveu');
  }

  s.city = null;
  s.address = null;
  const semCidade = await tools.executar(
    'definir_endereco',
    { endereco: '6 Main St' },
    s,
    async () => {},
    { textoCliente: '6 Main St' }
  );

  checar(!semCidade.bloqueiaFluxo, 'endereco sem cidade nao e descartado');
  checar(s.address === '6 Main St', 'guarda a rua para nao pedir o endereco novamente');
  checar(!s.city, 'nao inventa cidade quando ela nao foi informada');
  checar(/cidade/i.test(tools.orientacao(s)), 'o unico dado ainda pendente e a cidade');

  console.log('\n\x1b[32menderecousatest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
