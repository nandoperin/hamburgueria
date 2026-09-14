const sharp = require('sharp');

// Fotos de atendimento passam pelo gerador de miniaturas do WhatsApp.
// Conferir o envelope ANTES do decodificador: HEIF/AVIF, SVG, PDF e nomes de
// arquivo/URLs nunca chegam ao sharp, mesmo declarados como image/jpeg.
const MAX_PIXELS = 25_000_000;
const FORMATOS = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

async function validar(buffer, mimetype) {
  if (!Buffer.isBuffer(buffer)) return { ok: false, motivo: 'nao_e_imagem' };
  // Mesma lista de tipos e teto real de bytes dos comprovantes, sem mudar
  // o fluxo de pagamento. Importação tardia evita ciclos na inicialização.
  const envelope = require('./comprovante').validar(buffer, mimetype);
  if (!envelope.ok) return envelope;

  try {
    const imagem = sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'warning' });
    const meta = await imagem.metadata();
    if (FORMATOS[meta.format] !== envelope.mimetype || (meta.pages || 1) !== 1 ||
        !meta.width || !meta.height || meta.width * meta.height > MAX_PIXELS) {
      return { ok: false, motivo: 'imagem_invalida' };
    }
    // Metadata/magic bytes sozinhos aceitam arquivos truncados. stats força
    // a leitura dos pixels sem criar outro arquivo nem mudar a foto original.
    await imagem.stats();
    return envelope;
  } catch (_) {
    // Erros nativos podem conter metadados do remetente: não os repassar nem
    // registrar. Nenhum arquivo inválido deve chegar ao envio de miniaturas.
    return { ok: false, motivo: 'imagem_invalida' };
  }
}

module.exports = { validar, MAX_PIXELS };
