/**
 * A porta de `/pareamento`.
 *
 * A página existe porque o QR no log do Railway é ilegível e o código de oito
 * caracteres, na 7.0.0-rc13 do Baileys, passou uma noite inteira sendo recusado.
 * Mas o que ela serve **é credencial**: quem escaneia aquele QR passa a falar
 * como a hamburgueria, manda mensagem para a base de clientes inteira e lê tudo
 * que chega.
 *
 * Ou seja, é a mesma classe de risco do painel — e por isso ganha a mesma
 * atenção. O que estes cenários travam:
 *
 *   - sem `PAINEL_SECRET`, a rota não existe
 *   - token errado não passa, e a resposta é **idêntica** à de "não há QR":
 *     quem erra o token não descobre se há pareamento pendente
 *   - conectado (sem QR guardado), não há o que servir
 *   - a página nunca é cacheada nem indexada
 *
 * Nada aqui sobe rede: o router do Express é chamado direto, com req/res
 * fingidos. O teste roda em qualquer máquina, sem porta e sem WhatsApp.
 */

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fakekey';
process.env.BASE_URL = 'https://loja.test';

const PROJECT = require('path').resolve(__dirname, '..');

const SEGREDO = 'p'.repeat(40);

// O router chama `require('../bot/index').qrPendente()`. Substituir o módulo no
// cache evita subir o Baileys — que abriria socket de verdade num teste.
const botPath = require.resolve(`${PROJECT}/src/bot/index`);
let qrDeMentira = null;
require.cache[botPath] = {
  id: botPath,
  filename: botPath,
  loaded: true,
  exports: { qrPendente: () => qrDeMentira },
};

const router = require(`${PROJECT}/src/api/pareamento`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

/** Chama a rota e devolve o que ela respondeu. */
function pedir(query = {}) {
  return new Promise((resolve) => {
    const resposta = { status: 200, corpo: '', tipo: null, cabecalhos: {} };

    const req = { method: 'GET', url: '/pareamento', query, headers: {} };
    const res = {
      status(c) { resposta.status = c; return this; },
      type(t) { resposta.tipo = t; return this; },
      set(k, v) { resposta.cabecalhos[String(k).toLowerCase()] = v; return this; },
      send(corpo) { resposta.corpo = String(corpo); resolve(resposta); return this; },
    };

    router.handle(req, res, () => {
      resposta.status = 404;
      resposta.corpo = '(nenhuma rota casou)';
      resolve(resposta);
    });
  });
}

(async () => {
  // ------------------------------------------- 1. sem segredo, sem rota
  console.log('\n\x1b[36m### 1. SEM PAINEL_SECRET ###\x1b[0m');

  delete process.env.PAINEL_SECRET;
  qrDeMentira = { valor: 'QR-DE-VERDADE', em: Date.now() };

  let r = await pedir({ token: 'qualquer' });
  checar(r.status === 404, 'sem PAINEL_SECRET a rota responde 404');
  checar(
    !r.corpo.includes('QR-DE-VERDADE'),
    'e o QR nao vaza no corpo — a porta fecha antes de desenhar'
  );

  // -------------------------------------------- 2. token errado nao passa
  console.log('\n\x1b[36m### 2. TOKEN ERRADO ###\x1b[0m');

  process.env.PAINEL_SECRET = SEGREDO;

  const semToken = await pedir({});
  const tokenCurto = await pedir({ token: 'p' });
  const tokenQuase = await pedir({ token: 'p'.repeat(39) + 'q' });

  for (const [nome, resp] of [
    ['sem token', semToken],
    ['token curto', tokenCurto],
    ['token quase certo', tokenQuase],
  ]) {
    checar(resp.status === 404, `${nome}: recusado com 404`);
    checar(!resp.corpo.includes('QR-DE-VERDADE'), `${nome}: nao vaza o QR`);
  }

  // O ponto: errar o token e nao haver QR dao a MESMA resposta. Se diferissem,
  // um estranho descobriria pelo status quando o bot esta esperando pareamento
  // — que e exatamente a janela em que ele valeria a pena atacar.
  qrDeMentira = null;
  const semQr = await pedir({ token: SEGREDO });
  checar(
    semQr.status === tokenQuase.status,
    'token errado e "sem QR" respondem o mesmo status — nao da para sondar'
  );

  // ----------------------------------- 3. conectado: nao ha o que servir
  console.log('\n\x1b[36m### 3. SEM PAREAMENTO PENDENTE ###\x1b[0m');

  checar(semQr.status === 404, 'conectado (sem QR guardado), responde 404');
  checar(
    /sem pareamento pendente/i.test(semQr.corpo),
    'e diz o motivo a quem tem o token, para nao parecer defeito'
  );

  // ------------------------------------------ 4. com token e com QR
  console.log('\n\x1b[36m### 4. O CAMINHO QUE FUNCIONA ###\x1b[0m');

  qrDeMentira = { valor: 'QR-DE-VERDADE', em: Date.now() - 7000 };
  r = await pedir({ token: SEGREDO });

  checar(r.status === 200, 'token certo e QR pendente: 200');
  checar(r.tipo === 'html', 'responde HTML');
  checar(/<pre>/.test(r.corpo) && r.corpo.length > 200, 'a arte do QR vai no corpo');
  checar(
    /Aparelhos conectados/.test(r.corpo),
    'com a instrucao do celular na tela, nao so o quadrado'
  );
  checar(/tem 7s/.test(r.corpo), 'e diz a idade do QR — eles vencem em ~20s');

  checar(
    /no-store/.test(r.cabecalhos['cache-control'] || ''),
    'nao pode ser cacheada: o QR de agora nao vale daqui a pouco'
  );
  checar(
    /noindex/.test(r.cabecalhos['x-robots-tag'] || ''),
    'nem indexada por buscador'
  );

  console.log('\n\x1b[32m✓ pareamentotest passou\x1b[0m');
})().catch((err) => {
  console.error(`\x1b[31m✗ ${err.message}\x1b[0m`);
  process.exit(1);
});
