/**
 * Log de "taps" en push notifications.
 *
 * Cuando el SW recibe un notificationclick, postMessage al cliente.
 * El cliente (refunds.js) llama a /api/push/tap-track con la data del
 * payload. Esto nos permite medir CTR real del push (no solo
 * delivered/seen, sino tapped = el user lo abrió).
 *
 * Útil para "Push de plata": ver cuántos tocaron el push vs cuántos
 * efectivamente reclamaron.
 */
const mongoose = require('mongoose');

const tapSchema = new mongoose.Schema({
  // Tipo de push: 'money-giveaway', 'money-giveaway-broadcast',
  // 'raffle-win', etc. (matchea data.source del FCM payload)
  source: { type: String, required: true, index: true },

  // ID del giveaway / sorteo / lo que sea referenciado (opcional)
  giveawayId: { type: String, default: null, index: true },
  raffleId:   { type: String, default: null, index: true },

  userId:   { type: String, required: true, index: true },
  username: { type: String, required: true, index: true, trim: true },

  tappedAt: { type: Date, default: Date.now, index: true, immutable: true },

  // Anti-spam: el mismo user no debe contar 2 veces el mismo push.
  // El cliente puede disparar tap-track varias veces (refresh, polling
  // postMessage). El unique compound de (userId, source, giveawayId)
  // bloquea inserciones duplicadas.
  ipAddress: { type: String, default: null }
}, { timestamps: false });

// Solo 1 tap por (user, source, giveawayId, raffleId). Si el user toca el
// mismo push 2 veces, solo cuenta el primer tap. Para pushes de sorteos
// (giveawayId=null, raffleId=<id>) cada sorteo es independiente.
tapSchema.index(
  { userId: 1, source: 1, giveawayId: 1, raffleId: 1 },
  { name: 'unique_user_source_giveaway_raffle', unique: true }
);

module.exports = mongoose.models['PushTapLog'] ||
  mongoose.model('PushTapLog', tapSchema);
