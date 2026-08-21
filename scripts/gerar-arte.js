#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

/**
 * Gera a arte de marca usada como imagem de todos os produtos do catálogo.
 *
 *   npm run arte
 *
 * Foto de espetinho cru não vende, então até haver fotografia decente todos os
 * itens compartilham esta arte. Quando um produto ganhar foto própria, basta
 * adicionar `"image": "/img/produtos/x.jpg"` ao item no menu.json — o feed
 * passa a usá-la e ignora esta (ver src/services/catalog.js).
 *
 * O desenho é pensado para miniatura: no catálogo o cliente vê ~128px, então
 * o texto é grande e o espeto tem traço grosso para não virar borrão.
 */

const S = 1024;
const MARCA = process.env.FOOD_TRUCK_NAME || 'Passarela Espetinho';

/** Espeto com três pedaços de carne, centralizado em (cx, cy). */
function espeto(cx, cy, escala) {
  const w = 150 * escala;
  const h = 112 * escala;
  const gap = 20 * escala;
  const total = w * 3 + gap * 2;
  const x0 = cx - total / 2;
  const y = cy - h / 2;

  const pedacos = [0, 1, 2]
    .map((i) => {
      const x = x0 + i * (w + gap);
      return `
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${26 * escala}" fill="url(#carne)"/>
      <rect x="${x}" y="${y + h * 0.30}" width="${w}" height="${11 * escala}" rx="5" fill="#3d1408" opacity="0.45"/>
      <rect x="${x}" y="${y + h * 0.60}" width="${w}" height="${11 * escala}" rx="5" fill="#3d1408" opacity="0.45"/>
      <rect x="${x + 14 * escala}" y="${y + 12 * escala}" width="${w - 28 * escala}" height="${16 * escala}" rx="8" fill="#ffb072" opacity="0.32"/>`;
    })
    .join('');

  return `
    <rect x="${x0 - 80 * escala}" y="${cy - 9 * escala}" width="${total + 160 * escala}" height="${18 * escala}" rx="9" fill="url(#espeto)"/>
    ${pedacos}`;
}

const svg = `
<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="fundo" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a1a12"/>
      <stop offset="0.55" stop-color="#1a100a"/>
      <stop offset="1" stop-color="#0f0906"/>
    </linearGradient>
    <radialGradient id="brasa" cx="0.5" cy="0.36" r="0.62">
      <stop offset="0" stop-color="#ff8f3c" stop-opacity="0.32"/>
      <stop offset="0.55" stop-color="#e2561d" stop-opacity="0.11"/>
      <stop offset="1" stop-color="#e2561d" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="carne" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#c05f2c"/>
      <stop offset="0.5" stop-color="#96401c"/>
      <stop offset="1" stop-color="#6d2a11"/>
    </linearGradient>
    <linearGradient id="espeto" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#dcae6c"/>
      <stop offset="1" stop-color="#9c7038"/>
    </linearGradient>
  </defs>

  <rect width="${S}" height="${S}" fill="url(#fundo)"/>
  <rect width="${S}" height="${S}" fill="url(#brasa)"/>

  ${espeto(512, 358, 1.12)}

  <text x="512" y="614" text-anchor="middle"
        font-family="Segoe UI, Arial, Helvetica, sans-serif"
        font-size="88" font-weight="600" letter-spacing="20" fill="#f0a34a">PASSARELA</text>

  <text x="512" y="754" text-anchor="middle"
        font-family="Segoe UI, Arial, Helvetica, sans-serif"
        font-size="136" font-weight="800" letter-spacing="4" fill="#f8efe4">ESPETINHO</text>

  <rect x="392" y="820" width="240" height="5" rx="2.5" fill="#f0a34a" opacity="0.85"/>
</svg>`;

const destino = path.join(__dirname, '..', 'assets');
fs.mkdirSync(destino, { recursive: true });

const arquivo = path.join(destino, 'passarela-espetinho.jpg');

sharp(Buffer.from(svg))
  .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
  .toFile(arquivo)
  .then((info) => {
    console.log(`${arquivo}`);
    console.log(`${info.width}x${info.height}  ${(info.size / 1024).toFixed(0)} KB  (${MARCA})`);
    console.log('\nSuba em: /img/marca/passarela-espetinho.jpg no site do estabelecimento.');
  })
  .catch((err) => {
    console.error('Falha ao gerar a arte:', err.message);
    process.exit(1);
  });
