/**
 * O convite para pedir pelo site, acrescentado a quatro falas do bot (dono,
 * 09/10/2026): boas-vindas, catálogo que falhou, pergunta do cardápio e
 * confirmação do pedido. Só sugere — o cliente continua podendo pedir aqui.
 *
 * Desligado junto com a página: sem `PEDIR_ATIVO`, ninguém recebe link para
 * um site que não aceita pedido. O `?origem=whatsapp` é o que deixa contar,
 * no `!relatorio`, quantos pedidos do site vieram do convite.
 */
const PADRAO = 'https://pointburgerjg.com/pedido.html';

function url() {
  if (!/^(1|true|sim|on)$/i.test(process.env.PEDIR_ATIVO || '')) return null;
  const base = String(process.env.PEDIR_SITE_URL || PADRAO).trim();
  if (!/^https:\/\//.test(base)) return null;
  return `${base}${base.includes('?') ? '&' : '?'}origem=whatsapp`;
}

const FRASES = {
  boas_vindas: {
    pt: '🛒 Se preferir, monte seu pedido pelo site, escolhendo os ingredientes com calma:',
    en: '🛒 If you prefer, build your order on our website:',
    es: '🛒 Si prefieres, arma tu pedido en nuestro sitio:',
  },
  catalogo_falhou: {
    pt: 'Ou monte seu pedido pelo site:',
    en: 'Or build your order on our website:',
    es: 'O arma tu pedido en nuestro sitio:',
  },
  cardapio: {
    pt: 'Veja o cardápio completo e peça pelo site:',
    en: 'See the full menu and order on our website:',
    es: 'Mira el menú completo y pide en nuestro sitio:',
  },
  pos_pedido: {
    pt: '💡 Da próxima vez, você também pode pedir pelo site:',
    en: '💡 Next time, you can also order on our website:',
    es: '💡 La próxima vez, también puedes pedir en nuestro sitio:',
  },
};

/** A frase com o link, ou '' quando o site está desligado. */
function frase(tipo, lang = 'pt') {
  const link = url();
  const textos = FRASES[tipo];
  if (!link || !textos) return '';
  return `${textos[lang] || textos.pt}\n${link}`;
}

/** Acrescenta a frase no fim de um texto, separada por uma linha em branco. */
function acrescentar(texto, tipo, lang = 'pt') {
  const extra = frase(tipo, lang);
  return extra ? `${texto}\n\n${extra}` : texto;
}

module.exports = { url, frase, acrescentar };
