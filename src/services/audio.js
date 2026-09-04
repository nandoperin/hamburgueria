const mistral = require('../ai/mistral');
const custo = require('../ai/custo');

const TIPOS_ACEITOS = new Set([
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
]);

function inteiroSeguro(nome, padrao, maximo) {
  const valor = Number(process.env[nome]);
  if (!Number.isFinite(valor) || valor <= 0) return padrao;
  return Math.min(Math.floor(valor), maximo);
}

function regrasAudio() {
  return {
    maxBytes: inteiroSeguro('AUDIO_MAX_BYTES', 5 * 1024 * 1024, 10 * 1024 * 1024),
    maxSeconds: inteiroSeguro('AUDIO_MAX_SECONDS', 120, 300),
  };
}

function tipoBase(mimetype) {
  return String(mimetype || 'audio/ogg').split(';')[0].trim().toLowerCase();
}

function validar({ buffer, mimetype, seconds = 0 }) {
  const regras = regrasAudio();
  if (!TIPOS_ACEITOS.has(tipoBase(mimetype))) return { ok: false, motivo: 'tipo' };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, motivo: 'vazio' };
  if (buffer.length > regras.maxBytes) return { ok: false, motivo: 'tamanho' };
  if (Number(seconds) > regras.maxSeconds) return { ok: false, motivo: 'duracao' };
  return { ok: true };
}

async function transcrever({ buffer, mimetype, seconds, lang, sess }) {
  const validacao = validar({ buffer, mimetype, seconds });
  if (!validacao.ok) return validacao;

  const permissao = custo.podeChamar(sess);
  if (!permissao.ok) return { ok: false, motivo: 'teto' };

  const resultado = await mistral.transcreverAudio({
    buffer,
    mimetype: tipoBase(mimetype),
    language: lang,
  });
  if (!resultado.texto) return { ok: false, motivo: 'vazio' };

  // A API devolve a duração realmente faturada. O envelope do WhatsApp é só
  // fallback caso uma versão do provedor omita esse campo.
  const duracaoCobrada = resultado.segundos || Number(seconds) || 0;
  custo.registrarAudio(sess, duracaoCobrada, resultado.modelo);
  return { ok: true, texto: resultado.texto };
}

module.exports = { transcrever, validar, regrasAudio, tipoBase };
