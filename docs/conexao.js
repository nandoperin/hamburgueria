/**
 * Descobre por onde falar com o banco, sem ninguém digitar senha.
 *
 * São três caminhos, e a ordem importa:
 *
 *   1. `DB_TUNNEL_PORT` — túnel SSH aberto por
 *      `railway connect <servico> --tunnel-only --port N`. O banco continua
 *      sem endereço público; a credencial vem do ambiente que a CLI injeta.
 *   2. `DATABASE_PUBLIC_URL` — o proxy TCP público, se alguém o tiver ativado.
 *   3. `DATABASE_URL` — o host `.railway.internal`, que só resolve de dentro
 *      da rede do Railway (é o que o bot usa em produção).
 *
 * O túnel vem primeiro de propósito: é o único que funciona da máquina do dono
 * sem expor o Postgres à internet.
 */

function resolver() {
  const porta = process.env.DB_TUNNEL_PORT;

  if (porta) {
    const user = process.env.PGUSER || process.env.POSTGRES_USER || 'postgres';
    const senha = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || '';
    const base = process.env.PGDATABASE || process.env.POSTGRES_DB || 'railway';

    if (!senha) {
      throw new Error(
        'DB_TUNNEL_PORT definido, mas sem PGPASSWORD no ambiente.\n' +
          'Rode por dentro da CLI:  railway run node scripts/<script>.js'
      );
    }

    return {
      url: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(senha)}@127.0.0.1:${porta}/${base}`,
      via: `túnel local na porta ${porta}`,
      ssl: false, // o túnel já é o canal cifrado
    };
  }

  const publica = process.env.DATABASE_PUBLIC_URL;
  if (publica) {
    return { url: publica, via: 'proxy TCP público', ssl: { rejectUnauthorized: false } };
  }

  const privada = process.env.DATABASE_URL;
  if (privada) {
    return {
      url: privada,
      via: 'rede privada do Railway',
      ssl: /localhost|127\.0\.0\.1/.test(privada) ? false : { rejectUnauthorized: false },
    };
  }

  throw new Error(
    'Nenhuma forma de alcançar o banco.\n' +
      '  Abra o túnel:  railway connect Postgres-nTup --tunnel-only --port 55432\n' +
      '  E rode:        DB_TUNNEL_PORT=55432 railway run node scripts/<script>.js\n' +
      `  (variáveis vistas: ${Object.keys(process.env).filter((k) => /DATABASE|^PG|POSTGRES/.test(k)).join(', ') || 'nenhuma'})`
  );
}

module.exports = { resolver };
