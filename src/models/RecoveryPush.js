/**
 * RecoveryPush - una fila por cada push de "estrategia de recuperacion"
 * que el admin manda a un usuario en EN_RIESGO/PERDIDO/INACTIVO.
 *
 * Sirve para 2 cosas:
 *   1. Cooldown: evitar que el admin spamee al mismo user.
 *   2. Tracking: saber si la estrategia funciono — si reclamo el bono,
 *      si hizo carga real despues, ROI agregado.
 *
 * outcome se actualiza en el refresh de PlayerStats: para cada push
 * pending, miramos si en JUGAYGANA hay deposito real entre sentAt y now.
 *   - real_deposit_after_send → outcome = 'recovered'
 *   - bonus_claimed pero no deposit → outcome = 'opportunist'
 *   - nada → outcome se queda 'pending' hasta que pasen 14 dias, despues
 *     pasa a 'no_response' y se cierra.
 */
const mongoose = require('mongoose');

const recoveryPushSchema = new mongoose.Schema({
  username: { type: String, required: true, lowercase: true, trim: true, index: true },

  // Snapshot del segmento al momento del envio (para reportes historicos).
  segmentAtSend: { type: String, default: null },          // ej: 'VIP-EN_RIESGO'
  tierAtSend: { type: String, default: null },
  activityStatusAtSend: { type: String, default: null },

  // El bono que le mandamos (puede ser un giveaway o un refund extraordinario).
  // Si solo le mandamos notif sin bono, bonusAmount = 0.
  bonusAmount: { type: Number, default: 0 },
  bonusType: { type: String, enum: ['giveaway', 'promo', 'none'], default: 'none' },

  // Link al row de NotificationHistory creado al enviar (para joinear con
  // los stats de open-rate/click-rate de esa notif).
  notificationHistoryId: { type: String, default: null, index: true },

  // Si el push se mando como parte de un envio masivo a TODO un segmento,
  // este es el id del lote — sirve para agregar metricas por campaña.
  campaignBatchId: { type: String, default: null, index: true },

  sentAt: { type: Date, default: Date.now, index: true },
  sentBy: { type: String, default: null }, // admin username

  // ---- Outcome (se actualiza en el refresh batch posterior) ----
  bonusClaimed: { type: Boolean, default: false },
  bonusClaimedAt: { type: Date, default: null },

  realDepositMade: { type: Boolean, default: false },
  realDepositAt: { type: Date, default: null },
  realDepositAmount: { type: Number, default: 0 },

  outcome: {
    type: String,
    enum: ['pending', 'recovered', 'opportunist', 'no_response'],
    default: 'pending',
    index: true
  },
  outcomeResolvedAt: { type: Date, default: null }
}, { timestamps: true });

// Indices: para cooldown query (latest por user) y para reportes.
recoveryPushSchema.index({ username: 1, sentAt: -1 });
recoveryPushSchema.index({ outcome: 1, sentAt: -1 });

module.exports = mongoose.models['RecoveryPush'] ||
  mongoose.model('RecoveryPush', recoveryPushSchema);
