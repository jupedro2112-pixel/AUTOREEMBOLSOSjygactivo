/**
 * Modelo de Movimiento Bancario (hgcash / Urbana)
 *
 * Registro PERMANENTE de cada movimiento que el banco con API (hgcash) nos
 * notifica por su webhook `account-movement`. Sólo nos interesan los Inbound
 * (acreditaciones entrantes) para hacer la carga automática, pero guardamos
 * todos para auditoría.
 *
 * El matcheo con el comprobante del chat (monto + CBU origen + ventana de
 * tiempo) decide a qué usuario corresponde y dispara la carga automática en
 * JUGAYGANA (ver server.js). Toda la lógica está GATEADA por la config
 * `hgcash` (Config) y arranca en modo sombra (no carga sola hasta habilitarlo).
 */
const mongoose = require('mongoose');

const bankMovementSchema = new mongoose.Schema({
  // id interno del movimiento que manda hgcash (UUID). Único → dedupe de webhooks.
  movementId: { type: String, required: true, unique: true, index: true },
  externalId: { type: String, default: null },     // id externo del banco/red
  coelsaCode: { type: String, default: null, index: true },

  amount: { type: Number, default: null },          // monto parseado a número
  amountRaw: { type: String, default: null },       // monto tal como vino (string decimal)
  currency: { type: String, default: null },
  direction: { type: String, default: null, index: true }, // 'Inbound' | 'Outbound'
  status: { type: String, default: null },
  type: { type: String, default: null },
  accountId: { type: String, default: null },

  // Partes
  fromName: { type: String, default: null },
  fromCBU: { type: String, default: null, index: true },
  fromCUIT: { type: String, default: null },
  toName: { type: String, default: null },
  toCBU: { type: String, default: null },
  toCUIT: { type: String, default: null },

  date: { type: Date, default: null },              // fecha del movimiento (banco)
  timezone: { type: String, default: null },
  topic: { type: String, default: null },
  eventType: { type: String, default: null },

  raw: { type: mongoose.Schema.Types.Mixed, default: null }, // payload completo

  // Estado de matcheo / carga
  matchStatus: {
    type: String,
    // pending: recién llegado, sin matchear
    // claiming: tomado por un proceso para evitar doble carga
    // shadow_matched: matcheó pero modo sombra (no se cargó)
    // auto_charged: matcheó y se cargó automáticamente
    // no_match: no se encontró comprobante que coincida
    // ignored: outbound / otra moneda / no aplica
    // error: falló la carga tras matchear
    // manual_charged: un operador cargó manual a ese usuario (consume el movimiento
    // para que no se auto-cargue después cuando JUGAYGANA se recupere).
    // duplicate: re-entrega de una transferencia ya acreditada (mismo coelsa) → NO se cargó de nuevo.
    // needs_review: posible duplicado (mismo usuario+monto que una carga reciente) → frenado para revisión manual.
    enum: ['pending', 'claiming', 'shadow_matched', 'auto_charged', 'manual_charged', 'no_match', 'ignored', 'error', 'duplicate', 'needs_review'],
    default: 'pending',
    index: true
  },
  matchedUserId: { type: String, default: null },
  matchedUsername: { type: String, default: null },
  matchedComprobanteId: { type: String, default: null },
  chargeError: { type: String, default: null },
  chargeAttempts: { type: Number, default: 0 }, // intentos de auto-carga fallidos
  chargedAt: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now, index: true }
}, {
  timestamps: true
});

// Búsqueda de candidatos para matchear con un comprobante.
bankMovementSchema.index({ direction: 1, matchStatus: 1, amount: 1, createdAt: -1 });

module.exports = mongoose.models['BankMovement'] || mongoose.model('BankMovement', bankMovementSchema);
