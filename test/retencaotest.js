/**
 * Retenção de 2 meses (13/11/2026): nada antigo é apagado; só pedidos criados
 * depois do marco, e só quando passam de 60 dias.
 */
process.env.DATABASE_URL = 'postgresql://fake';

const PROJECT = require('path').resolve(__dirname, '..');
const settings = new Map();
const DIA = 24 * 60 * 60 * 1000;
let pedidos = [];
const dbPath = require.resolve(`${PROJECT}/src/db/queries`);
require(dbPath);
require.cache[dbPath].exports = new Proxy({
  getSetting: async (k) => settings.get(k) ?? null,
  setSetting: async (k, v) => { settings.set(k, v); },
  apagarPedidosAntigos: async (desde, ate, limite = 500) => {
    const alvo = pedidos.filter((p) => p.em >= new Date(desde) && p.em < new Date(ate)).slice(0, limite);
    pedidos = pedidos.filter((p) => !alvo.includes(p));
    return { pedidos: alvo.length, pagamentos: alvo.length };
  },
}, { get: (alvo, k) => alvo[k] || (async () => null) });

const schedule = require(`${PROJECT}/src/services/schedule`);
let aberto = false;
schedule.isOpen = () => aberto;
const retencao = require(`${PROJECT}/src/services/retencao`);

function checar(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`\x1b[32m   OK: ${msg}\x1b[0m`);
}

(async () => {
  const hoje = new Date('2026-11-13T12:00:00Z');
  const antes = (d, base = hoje) => new Date(base.getTime() - d * DIA);
  const depois = (d, base = hoje) => new Date(base.getTime() + d * DIA);
  pedidos = [{ id: 'velho1', em: antes(200) }, { id: 'velho2', em: antes(61) }, { id: 'velho3', em: antes(1) }];

  let r = await retencao.limpar(hoje);
  checar(settings.get('retencao_desde') === hoje.toISOString(), 'primeira volta grava o marco de hoje');
  checar(r.pedidos === 0 && pedidos.length === 3, 'nada antigo é apagado, nem o de 200 dias');

  // Pedidos novos, depois do marco.
  pedidos.push({ id: 'novo1', em: depois(1) }, { id: 'novo2', em: depois(30) });

  r = await retencao.limpar(depois(50));
  checar(r.pedidos === 0 && pedidos.length === 5, 'com 49 dias: nada sai');

  r = await retencao.limpar(depois(62));
  checar(r.pedidos === 1 && !pedidos.some((p) => p.id === 'novo1'), 'com 61 dias: sai o pedido novo de mais de 2 meses');
  checar(['velho1', 'velho2', 'velho3', 'novo2'].every((id) => pedidos.some((p) => p.id === id)), '   os antigos e o recente ficam');

  r = await retencao.limpar(depois(400));
  checar(pedidos.length === 3 && pedidos.every((p) => p.id.startsWith('velho')), 'muito tempo depois: só os de antes do marco continuam');

  checar((await retencao.marco(depois(500))).toISOString() === hoje.toISOString(), 'o marco não muda depois de gravado');

  // Loja aberta: não mexe.
  pedidos.push({ id: 'novo3', em: depois(5) });
  aberto = true;
  r = await retencao.limpar(depois(300));
  checar(r.pulou === 'aberto' && pedidos.some((p) => p.id === 'novo3'), 'loja aberta: espera fechar');
  aberto = false;

  // Lotes: mais de 500 sai em várias voltas.
  for (let i = 0; i < 1200; i += 1) pedidos.push({ id: 'lote' + i, em: depois(2) });
  r = await retencao.limpar(depois(300));
  checar(r.pedidos === 1201 && pedidos.length === 3, 'muitos pedidos: apaga em lotes');

  console.log('\n\x1b[32mretencaotest: tudo passou.\x1b[0m');
  process.exit(0);
})().catch((err) => {
  console.error(`\x1b[31m   FALHOU: ${err.stack || err.message}\x1b[0m`);
  process.exit(1);
});
