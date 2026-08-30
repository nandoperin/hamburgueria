/**
 * Endereco nos EUA nao segue a frase brasileira "rua e numero".
 *
 * O cliente pode escrever "2021 Revere Beach Pkwy, Apt 5, Everett, MA" e o
 * modelo normalizar abreviacoes. O bot nao e um validador postal: precisa
 * aceitar o endereco plausivel e seguir, incluindo apartment/unit se houver.
 */

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
  Object.assign(s, {
    lang: 'pt',
    state: 'ORDER',
    orderType: 'delivery',
    city: delivery.getCityById('everett'),
    name: 'Fernando',
    cart: [{ id: 'x_burger', name: 'X-Burger', price: 11, qty: 1 }],
  });

  const escrito = 'moro na 2021 Revere Beach Pkwy apt 5 em Everett MA';
  const normalizado = '2021 Revere Beach Parkway, Apt 5, Everett, Massachusetts';
  const aceito = await tools.executar(
    'definir_endereco',
    { endereco: normalizado },
    s,
    async () => {},
    { textoCliente: escrito }
  );

  checar(!aceito.bloqueiaFluxo, 'aceita o formato normal de endereco americano');
  checar(s.address === normalizado, 'preserva apartment/unit quando informado');

  console.log('\n\x1b[32menderecousatest: tudo passou.\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.message}\x1b[0m`);
  process.exit(1);
});
