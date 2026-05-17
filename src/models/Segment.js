/**
 * Segment: lista de usernames cargada por admin (CSV upload o URL Sheets)
 * para analizar conversion. Usado para top jugadores, recuperacion, clientes
 * con app, bonus 5k/10k/2k, participantes de un relampago, etc.
 *
 * Lifecycle: el admin sube un archivo o pega una URL. La lista actual
 * (`usernames`) se reemplaza por la nueva, pero queda registro en `uploads`
 * (historial de cuando se subio cada vez).
 *
 * Conversion: post-upload, cruzamos cada username contra Transaction.deposit
 * (real, JUGAYGANA via getUserMovements) con timestamp posterior a la subida
 * para ver quien volvio a cargar.
 */
const mongoose = require('mongoose');

const uploadEntrySchema = new mongoose.Schema({
  at: { type: Date, default: Date.now, required: true },
  by: { type: String, default: 'admin', maxlength: 100 },
  source: { type: String, enum: ['file', 'sheets-url', 'lightning', 'manual'], default: 'file' },
  sourceDetail: { type: String, default: '', maxlength: 500 }, // filename, sheets URL, raffleId, etc.
  rowsCount: { type: Number, default: 0, min: 0 }
}, { _id: false });

const segmentSchema = new mongoose.Schema({
  // Slug interno (kebab-case): top-jugadores, recuperacion, sin-wp, con-app,
  // bonus-5k, bonus-10k, bonus-2k, relampago-N1, etc.
  slug: { type: String, required: true, unique: true, index: true, maxlength: 64, lowercase: true, trim: true },
  // Nombre visible para el admin.
  name: { type: String, required: true, maxlength: 120 },
  // Descripcion opcional (para que recuerden de que se trata el segmento).
  description: { type: String, default: '', maxlength: 500 },
  // Categoria visual (color/icon). Cualquier string corto que el front mapea.
  // Ej: 'top', 'recovery', 'wp', 'app', 'bonus', 'lightning', 'custom'.
  kind: { type: String, default: 'custom', maxlength: 32 },
  // Si es true, este segmento es la "fuente maestra" usada por otras
  // secciones del admin (ej. analisis de relampago) cuando el admin pide
  // "Analizar con archivo maestro" en vez de cruzar contra JUGAYGANA live.
  // Solo UN segmento puede ser master a la vez (validacion en server).
  isMaster: { type: Boolean, default: false, index: true },

  // Lista de usernames del ultimo upload. Se REEMPLAZA en cada subida.
  // Lowercase + trim para matching consistente.
  usernames: { type: [String], default: [] },

  // Filas crudas del ultimo upload (opcional): si el CSV tenia mas columnas
  // (monto, fecha, tipo) las guardamos por si despues queremos analizarlas.
  // Capeamos a 5000 filas por sanidad.
  rows: { type: [mongoose.Schema.Types.Mixed], default: [] },

  // Historial de subidas. Append-only.
  uploads: { type: [uploadEntrySchema], default: [] },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

segmentSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Segment', segmentSchema);
