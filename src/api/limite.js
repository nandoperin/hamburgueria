/**
 * Limitador pequeno para portas com credencial forte.
 *
 * Não tenta substituir firewall: reduz abuso de CPU/banco e repetição de
 * tentativas. A chave usa o endereço da conexão recebido pelo processo, sem
 * confiar em cabeçalhos que o cliente pode forjar.
 */
const baldes = new Map();

function limitar({ nome, max, janelaMs, aoBloquear }) {
  return (req, res, next) => {
    const agora = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || 'desconhecido';
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

module.exports = { limitar, zerar };
