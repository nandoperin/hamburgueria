/**
 * Base de exemplos corrigidos da IA leitora (src/ai/exemplos-leitor.json).
 *
 * Todo exemplo precisa: citar só produtos do cardápio de produção, ser
 * encontrado por uma frase parecida, e — passando pelo validador — dar o
 * carrinho que o dono aprovou. Exemplo quebrado ensina errado; é aqui que ele
 * é pego, antes do deploy.
 */
process.env.DATABASE_URL = 'postgresql://fake';

const PROJECT = require('path').resolve(__dirname, '..');
const menuProducao = require('./fixtures/menu-producao.json');
const config = require(`${PROJECT}/src/services/config`);
const getReal = config.get;
config.get = (chave) => (chave === 'menu' ? menuProducao : getReal(chave));

const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({}, { get: () => async () => null });

const cardapio = require(`${PROJECT}/src/services/cardapio`);
const exemplos = require(`${PROJECT}/src/ai/exemplos`);
const leitor = require(`${PROJECT}/src/ai/leitor`);
const guiado = require(`${PROJECT}/src/ai/guiado`);
const session = require(`${PROJECT}/src/bot/session`);
const tools = require(`${PROJECT}/src/ai/tools`);

let seq = 0;
function sessaoCom(ids = []) {
  const s = session.get(`1555777${String(++seq).padStart(4, '0')}`);
  s.lang = 'pt';
  for (const id of ids) tools.carrinho.adicionar(s, { item_id: id, quantidade: 1 });
  return s;
}

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

const VAZIA = {
  itens: [], ambiguos: [], correcoes: [], refazer_lista: false, concluiu_itens: false,
  entrega: null, cidade: null, endereco: null, nome: null, pagamento: null, troco: null,
  confirma_resumo: null, pergunta: null, cancelar: false,
};

const lista = exemplos.carregar();
checar(lista.length > 0 && lista.length <= exemplos.MAX_EXEMPLOS, `${lista.length} exemplos carregados`);

for (const e of lista) {
  const ids = [
    ...(e.leitura.itens || []).map((i) => i.produto),
    ...(e.leitura.ambiguos || []).flatMap((a) => a.opcoes),
    ...(e.leitura.correcoes || []).map((c) => String(c.linha).split(':')[0]),
  ];
  const faltando = ids.filter((id) => !cardapio.itemById(id));
  checar(!faltando.length, `"${e.texto.split('\n').join(' / ')}": produtos existem (${faltando.join(', ') || 'ok'})`);
  checar(exemplos.parecidos(e.texto, 3, sessaoCom(e.carrinho_ids))[0] === e, '   e é o primeiro achado pela própria frase');

  // O formulário do exemplo, como se a leitora tivesse devolvido, pelo validador.
  if (!e.carrinho && e.leitura.itens?.length) {
    const sess = session.get(`1555888${String(lista.indexOf(e)).padStart(4, '0')}`);
    sess.lang = 'pt';
    const leitura = leitor.normalizar({ ...VAZIA, ...JSON.parse(JSON.stringify(e.leitura)) });
    const plano = guiado.validar(sess, leitura, e.texto);
    const esperado = e.leitura.itens.map((i) => `${i.qtd || 1}x ${i.produto}`).sort().join(', ');
    // O sachê que a regra da maionese acrescenta não é leitura: fica de fora.
    const deu = plano.itens.filter((i) => i.item_id !== 'sache_maionese').map((i) => `${i.quantidade}x ${i.item_id}`).sort().join(', ');
    checar(deu === esperado, `   o validador mantém a leitura corrigida (${deu})`);
  }
}

checar(/2 xegg burguer 1 sem maionese/.test(exemplos.paraLeitura('2 x egg burger, 1 sem maionese')),
  'frase parecida traz o caso corrigido');
checar(exemplos.paraLeitura('boa noite') === '' && exemplos.paraLeitura('troco pra 50') === '',
  'frase sem nada a ver não traz exemplo');
// Prova de 18/09: "Tira tomate egg bacon" (corrigido com X Egg Bacon no
// carrinho) mostrado com Egg Bacon no carrinho ensinou a trocar os dois.
checar(!/Tira tomate egg bacon/.test(exemplos.paraLeitura('tira o tomate do egg bacon', sessaoCom(['egg_bacon']))) &&
  /Tira tomate egg bacon/.test(exemplos.paraLeitura('tira o tomate do egg bacon', sessaoCom(['x_tudo', 'xeggbacon']))),
  'exemplo que depende do carrinho só aparece com o mesmo carrinho');

const sess = session.get('15558880999');
sess.lang = 'pt';
const msg = leitor.montarMensagem(sess, '2 xegg burger 1 sem maionese');
checar(/o dono corrigiu/.test(msg) && msg.indexOf('o dono corrigiu') < msg.indexOf('Mensagem do cliente:'),
  'o exemplo entra na mensagem da leitora, antes da fala do cliente');
checar(!/o dono corrigiu/.test(leitor.montarSystem(sess)), 'o system não muda (continua no cache)');

console.log('\n\x1b[32mexemplostest: tudo passou.\x1b[0m');
process.exit(0);
