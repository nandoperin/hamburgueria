const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  // Em hospedagem, "faltando" quase sempre é erro de digitação no nome ou
  // variável cadastrada no lugar errado. Mostrar o que o processo realmente
  // enxerga transforma o palpite em diagnóstico.
  const parecidas = Object.keys(process.env)
    .filter((k) => /SUP|BASE|SERVICE_ROLE/i.test(k))
    .sort();

  throw new Error(
    'SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.\n' +
      `  SUPABASE_URL:              ${url ? 'presente' : 'AUSENTE'}\n` +
      `  SUPABASE_SERVICE_ROLE_KEY: ${key ? 'presente' : 'AUSENTE'}\n` +
      `  Variáveis parecidas visíveis: ${parecidas.length ? parecidas.join(', ') : '(nenhuma)'}\n` +
      `  Total de variáveis no processo: ${Object.keys(process.env).length}`
  );
}

const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

module.exports = supabase;
