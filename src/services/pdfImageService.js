/**
 * pdfImageService.js — convierte la 1ª página de un PDF a imagen PNG.
 *
 * Lo usa el envío del comprobante de pago al cliente "como foto". Usa `mupdf`
 * (WebAssembly, sin binarios nativos), que es una **dependencia OPCIONAL**: se
 * carga LAZY con import() dinámico (mupdf es ESM) y TODO va envuelto en try/catch.
 * Si la dependencia no está instalada o la conversión falla, devuelve `null` y el
 * caller cae a mandar el link al PDF. NUNCA tira: es best-effort y no debe romper
 * el flujo de pago.
 */
const logger = require('../utils/logger');

// Cache del módulo WASM (se carga una sola vez). Si el import falla, se resetea
// para permitir reintento en una llamada futura.
let _mupdfPromise = null;
function _getMupdf() {
  if (!_mupdfPromise) {
    _mupdfPromise = import('mupdf').catch(e => { _mupdfPromise = null; throw e; });
  }
  return _mupdfPromise;
}

// Convierte la PRIMERA página de un PDF (Buffer) a PNG (Buffer). `scale` = factor de
// resolución (2 ≈ 144 DPI, nítido para un comprobante). Devuelve null si falla.
async function pdfBufferToPng(pdfBuffer, { scale = 2 } = {}) {
  try {
    if (!pdfBuffer || !pdfBuffer.length) return null;
    const m = await _getMupdf();
    const doc = m.Document.openDocument(pdfBuffer, 'application/pdf');
    try {
      if (doc.countPages() < 1) return null;
      const page = doc.loadPage(0);
      try {
        const pix = page.toPixmap(m.Matrix.scale(scale, scale), m.ColorSpace.DeviceRGB, false, true);
        try {
          return Buffer.from(pix.asPNG());
        } finally { pix.destroy(); }
      } finally { page.destroy(); }
    } finally { doc.destroy(); }
  } catch (e) {
    logger.warn(`[pdf-img] conversión PDF→PNG falló (se usará el link): ${e.message}`);
    return null;
  }
}

module.exports = { pdfBufferToPng };
