const express = require('express');
const path = require('path');

const metaWebhook = require('./webhooks/meta');
const cloudprnt = require('./cloudprnt');
const cardapio = require('./cardapio');
const painel = require('./painel');
const pareamento = require('./pareamento');

const app = express();

// O webhook precisa do body raw para validar assinatura — por isso é
// registrado antes de qualquer parser JSON global.
//
// Não há webhook de pagamento: Zelle não tem. A confirmação é humana, pelo
// !liberar do dono — ver docs/PAGAMENTOS.md.
app.use(metaWebhook);
app.use(cloudprnt);
app.use(cardapio);
app.use(painel);
app.use(pareamento);

/**
 * Imagens do cardápio e dos produtos, servidas do próprio repositório.
 *
 * `/img/cardapio` são as artes geradas por `npm run cardapio-img`; `/img/produtos`
 * são as fotos de cada item. Ficam no repo e vão juntas no deploy, então mudar
 * preço e mudar imagem é o mesmo commit — foto servida de outro lugar é foto
 * que envelhece sozinha.
 */
app.use(
  '/img',
  express.static(path.join(__dirname, '..', '..', 'assets'), { maxAge: '7d' })
);

/**
 * Endereço que o monitor externo consulta.
 *
 * Durante a fase de testes, confirma somente que o processo HTTP está de pé.
 * Não consulta banco, WhatsApp nem impressora: esses serviços podem estar
 * desligados sem fazer o Railway reprovar o deploy.
 */
app.get('/health', async (req, res) => {
  try {
    const saude = await require('../services/health').verificar();
    res.status(saude.ok ? 200 : 503).json(saude);
  } catch (err) {
    require('../log').error({ evt: 'saude', err }, 'falha ao apurar a saúde');
    res.status(503).json({ ok: false, falhas: ['desconhecida'] });
  }
});

function start() {
  const port = process.env.PORT || 3000;
  return app.listen(port, () => {
    require('../log').info({ evt: 'boot', porta: port }, `API ouvindo na porta ${port}`);
  });
}

module.exports = { app, start };
