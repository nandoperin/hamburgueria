/**
 * Limitador pequeno para portas com credencial forte.
 *
 * Não tenta substituir firewall: reduz abuso de CPU/banco e repetição de
 * tentativas. A chave usa o endereço da conexão recebido pelo processo, sem
 * confiar em cabeçalhos que o cliente pode forjar.
 */
const baldes = new Map();

/**
 * O IP de quem conectou. Primeiro o `X-Real-IP`, que a borda da Railway
 * escreve com o IP do cliente (auditoria do food truck, 10/2026); na falta
 * dele (fora da Railway), o `req.ip` de sempre, com `trust proxy` 1.
 */
function ipDe(req) {
  const real = String(req.headers?.['x-real-ip'] || '').trim();
  if (real && real.length <= 64) return real;
  return req.ip || req.socket?.remoteAddress || 'desconhecido';
}

function limitar({ nome, max, janelaMs, aoBloquear }) {
  return (req, res, next) => {
    const agora = Date.now();
    const ip = ipDe(req);
    const chave = `${nome}:${ip}`;
    let balde = baldes.get(chave);
    if (!balde || balde.ate <= agora) {
      balde = { quantidade: 0, ate: agora + janelaMs };
      baldes.set(chave, balde);
    }
    balde.quantidade += 1;

    // Limpeza oportunista evita crescimento sem criar outro temporizador.
    if (baldes.size > 1000) {
      for (const [k, v] of baldes) if (v.ate <= agora) baldes.delete(k);
    }

    if (balde.quantidade <= max) return next();
    res.set('Retry-After', String(Math.max(1, Math.ceil((balde.ate - agora) / 1000))));
    if (aoBloquear) return aoBloquear(req, res);
    return res.status(429).json({ erro: 'muitas_tentativas' });
  };
}

function zerar() {
  baldes.clear();
}

module.exports = { limitar, zerar, ipDe };
