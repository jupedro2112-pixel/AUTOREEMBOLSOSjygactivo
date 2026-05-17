/**
 * JugayganaImport - audit log de cada CSV de transacciones que el admin
 * sube. Guardamos solo metadata (periodo, conteos, fingerprint) — las
 * transacciones crudas NO se persisten. Despues del procesamiento solo
 * queda el agregado en PlayerStats.
 *
 * Sirve para:
 *   - Mostrar al admin el historial de imports en el panel.
 *   - Idempotencia: si vuelve a subir el mismo archivo, detectamos por
 *     fingerprint (sha256 del contenido) y lo reusamos en vez de
 *     re-procesar.
 *   - Saber el periodo cubierto: ultimo periodo importado define el
 *     "as of" de las stats.
 */
const mongoose = require('mongoose');

const jugayganaImportSchema = new mongoose.Schema({
  // sha256 del contenido del CSV (despues de normalizar) — idempotencia.
  contentHash: { type: String, required: true, index: true },

  uploadedBy: { type: String, default: null }, // admin username
  uploadedAt: { type: Date, default: Date.now, index: true },

  // Tamaño y conteos.
  rawSizeBytes: { type: Number, default: 0 },
  totalRows: { type: Number, default: 0 },
  validRows: { type: Number, default: 0 },
  skippedRows: { type: Number, default: 0 },

  // Conteos por operacion.
  depositCount: { type: Number, default: 0 },
  withdrawCount: { type: Number, default: 0 },
  bonusCount: { type: Number, default: 0 },
  depositSum: { type: Number, default: 0 },
  withdrawSum: { type: Number, default: 0 },
  bonusSum: { type: Number, default: 0 },

  // Periodo cubierto por el archivo (min/max fecha de las transacciones).
  periodFrom: { type: Date, default: null },
  periodTo: { type: Date, default: null },

  // Usuarios distintos en el archivo.
  uniqueUsers: { type: Number, default: 0 },

  // Detalles del parsing detectado (formato fecha, delimiter, etc).
  detectedFormat: {
    delimiter: { type: String, default: null },     // ',' o ';' o '\t'
    dateFormat: { type: String, default: null },    // 'iso' / 'dmy' / 'mdy'
    headerRow: { type: Boolean, default: true }
  },

  status: {
    type: String,
    enum: ['processing', 'completed', 'failed'],
    default: 'processing',
    index: true
  },
  errorMsg: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.models['JugayganaImport'] ||
  mongoose.model('JugayganaImport', jugayganaImportSchema);
