/**
 * Modelo de Comprobante (anti-duplicado con IA)
 *
 * Registro PERMANENTE (sin TTL, como Transaction) de cada imagen de comprobante
 * que un cliente envía por el chat. Una IA (Claude vision) lee la imagen, decide
 * si es un comprobante y extrae los datos clave. Con la "huella" (dedupeKey) se
 * detecta si un comprobante ya fue usado por OTRO usuario (reutilización/estafa).
 *
 * La colección es nueva → no requiere migración. La detección sólo corre si está
 * configurada la ANTHROPIC_API_KEY (ver src/services/comprobanteAiService.js);
 * si no, no se crea ningún registro y nada se rompe.
 */
const mongoose = require('mongoose');

const comprobanteSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  // Cliente que envió la imagen
  userId: { type: String, index: true },
  username: { type: String, index: true, trim: true },
  // id del Message de tipo 'image' que lo originó (para enlazar al chat)
  messageId: { type: String, default: null },

  // Resultado del análisis de IA
  isComprobante: { type: Boolean, default: false, index: true },
  aiConfidence: { type: Number, default: 0 }, // 0..1

  // Datos extraídos del comprobante (los que la IA pudo leer)
  operationNumber: { type: String, default: null, trim: true },
  amount: { type: Number, default: null },
  originHolder: { type: String, default: null, trim: true }, // titular / origen
  originCbu: { type: String, default: null, trim: true },    // CBU/CVU/alias origen
  destHolder: { type: String, default: null, trim: true },   // titular / destino (quién recibe)
  destCbu: { type: String, default: null, trim: true },      // CBU/CVU/alias destino (a quién se envió)
  bank: { type: String, default: null, trim: true },
  paymentDate: { type: String, default: null, trim: true },  // fecha/hora tal como figura
  rawText: { type: String, default: null },                  // texto crudo leído (debug)

  // Huella para detectar duplicados. Se arma con el N° de operación normalizado;
  // si no hay, con un combo monto|cbu|fecha. Indexada para búsqueda rápida.
  dedupeKey: { type: String, default: null, index: true },
  // Hash SHA-256 de la imagen. Si se reenvía LA MISMA imagen, el hash coincide y
  // se detecta como duplicado al 100%, sin depender de cómo la IA leyó los datos
  // (la lectura OCR puede variar entre envíos). Sólo se calcula para imágenes
  // base64 (data:) — el caso típico de capturas; para URLs https queda null.
  imageHash: { type: String, default: null, index: true },

  // Estado del análisis
  status: {
    type: String,
    enum: ['unique', 'duplicate', 'not_comprobante', 'no_key', 'error'],
    default: 'unique',
    index: true
  },
  // Si es duplicado, a quién pertenece el comprobante ORIGINAL
  duplicateOfUserId: { type: String, default: null },
  duplicateOfUsername: { type: String, default: null },
  duplicateOfComprobanteId: { type: String, default: null },

  // Matcheo con el banco con API (hgcash) → carga automática
  toApiBank: { type: Boolean, default: false }, // el destino es el CBU del banco con API
  bankMatchStatus: {
    type: String,
    enum: ['none', 'pending', 'claiming', 'shadow_matched', 'auto_charged', 'manual_charged', 'matched', 'duplicate', 'needs_review'],
    default: 'none',
    index: true
  },
  matchedMovementId: { type: String, default: null }, // movementId de BankMovement matcheado
  autoCharged: { type: Boolean, default: false },

  // Meta
  model: { type: String, default: null },        // modelo de IA que lo analizó
  errorReason: { type: String, default: null },  // si status==='error'
  createdAt: { type: Date, default: Date.now, index: true }
}, {
  timestamps: true
});

// Búsqueda de duplicados: por huella, sólo entre los que son comprobantes reales.
comprobanteSchema.index({ dedupeKey: 1, isComprobante: 1 });

module.exports = mongoose.models['Comprobante'] || mongoose.model('Comprobante', comprobanteSchema);
