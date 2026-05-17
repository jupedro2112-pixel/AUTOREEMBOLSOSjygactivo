/**
 * Reclamos individuales de un Money Giveaway.
 *
 * Cada vez que un user toca "Reclamar" se inserta un row aca. El indice
 * unique sobre (giveawayId, username) garantiza que el mismo user no
 * pueda reclamar 2 veces el mismo regalo, ni siquiera bajo race
 * conditions o re-instalando la app.
 *
 * status='pending_credit_failed' marca claims donde el insert tuvo exito
 * pero el credit a JUGAYGANA fallo (mismo patron que RefundClaim/welcome
 * bonus). NO se elimina el row para no permitir re-reclamo accidental.
 */
const mongoose = require('mongoose');

const claimSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  giveawayId: { type: String, required: true, index: true },
  userId:     { type: String, required: true, index: true },
  username:   { type: String, required: true, index: true, trim: true },

  amount: { type: Number, required: true, min: 0 },

  claimedAt: { type: Date, default: Date.now, index: true, immutable: true },

  transactionId: { type: String, default: null, index: true },

  status: {
    type: String,
    enum: ['completed', 'pending_credit_failed'],
    default: 'completed',
    index: true
  },
  creditError: { type: String, default: null }
}, { timestamps: true });

// Defensa atomica: el mismo username no puede reclamar 2 veces el mismo
// giveaway. Igual al patron de RefundClaim, prevenimos race conditions
// y reinstalls.
claimSchema.index(
  { giveawayId: 1, username: 1 },
  { name: 'unique_giveaway_username', unique: true }
);
claimSchema.index(
  { giveawayId: 1, userId: 1 },
  { name: 'unique_giveaway_userid', unique: true }
);

module.exports = mongoose.models['MoneyGiveawayClaim'] ||
  mongoose.model('MoneyGiveawayClaim', claimSchema);
