/**
 * Código canjeable por bono.
 *
 * El owner crea un código (string corto en mayúsculas) con un monto y
 * un tiempo de vida (en minutos). Cada usuario puede canjearlo 1 sola vez.
 * Al canjear se acredita el monto al saldo del user via JUGAYGANA.
 *
 * Casos típicos: anunciar un canal Telegram con un código adentro, dejar
 * un código en una promo limitada por tiempo, recompensar a quienes
 * cumplieron una acción específica.
 */
const mongoose = require('mongoose');

const claimSchema = new mongoose.Schema({
  userId: { type: String, default: '' },
  username: { type: String, default: '', index: true },
  amount: { type: Number, default: 0 },
  claimedAt: { type: Date, default: Date.now },
  status: {
    type: String,
    enum: ['completed', 'pending_credit_failed'],
    default: 'completed'
  },
  creditError: { type: String, default: '' },
  transactionId: { type: String, default: '' }
}, { _id: false });

const redeemCodeSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  // Código a tipear por el user. Se normaliza a uppercase + trim al guardar.
  // No exponer en URL para evitar enumeración.
  code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 32, index: true },

  // Monto a acreditar por canje
  amountARS: { type: Number, required: true, min: 1 },

  // Tiempo de vida (en minutos) — auto-cierre cuando se cumple.
  durationMinutes: { type: Number, required: true, min: 1 },

  // Calculado al crear: createdAt + durationMinutes
  expiresAt: { type: Date, required: true, index: true },

  // Cap opcional de canjes totales. 0 = ilimitado (cada user 1 vez).
  maxClaims: { type: Number, default: 0, min: 0 },

  status: {
    type: String,
    enum: ['active', 'closed_expired', 'closed_max', 'closed_manual'],
    default: 'active',
    index: true
  },

  // Lista de canjes (1 por user, controlado por unique check abajo).
  claims: { type: [claimSchema], default: [] },

  // Texto descriptivo opcional (visible al admin)
  notes: { type: String, default: '', maxlength: 300 },

  createdBy: { type: String, default: '' }
}, { timestamps: true });

// Búsqueda rápida por (code, username) para anti-doble-canje.
redeemCodeSchema.index({ code: 1, 'claims.username': 1 });

module.exports = mongoose.models['RedeemCode'] ||
  mongoose.model('RedeemCode', redeemCodeSchema);
