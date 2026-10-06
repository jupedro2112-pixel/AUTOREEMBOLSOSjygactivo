/**
 * ReferralMilestoneClaim — premio EXTRA por cantidad de referidos que cargaron (#168).
 *
 * Config['referralMilestones'] define los hitos ({count, amountARS}) y el mínimo cargado
 * por referido para contar. Cada hito se cobra UNA sola vez por usuario (índice único
 * userId+count = candado atómico contra doble cobro, patrón "reservar antes de acreditar"
 * de los reembolsos). Se acredita como fichas (individual_bonus) sin condiciones y es un
 * extra: la comisión mensual del 7% sigue aparte.
 */
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  username: { type: String, required: true, index: true },
  count: { type: Number, required: true },          // hito (3, 5, 10, …)
  amountARS: { type: Number, required: true },
  qualifiedAtClaim: { type: Number, default: 0 },   // referidos calificados en el momento del reclamo
  status: { type: String, enum: ['pending', 'credited', 'verify', 'failed'], default: 'pending', index: true },
  txId: { type: String, default: null },
  error: { type: String, default: null },
  claimedAt: { type: Date, default: Date.now },
  creditedAt: { type: Date, default: null }
}, { timestamps: true });

schema.index({ userId: 1, count: 1 }, { unique: true, name: 'unique_user_milestone' });

module.exports = mongoose.models['ReferralMilestoneClaim'] || mongoose.model('ReferralMilestoneClaim', schema);
