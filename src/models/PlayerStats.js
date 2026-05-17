/**
 * PlayerStats - cache por jugador con todo lo necesario para el panel
 * estrategico de segmentacion + recuperacion.
 *
 * IMPORTANTE: Los campos *30d se refrescan en BATCH desde el endpoint
 * POST /api/admin/stats/refresh — cada llamada pega JUGAYGANA por user
 * (throttled). lastSeenApp se actualiza en cada authed request del user
 * (hook en authMiddleware), asi que esta SIEMPRE fresco aunque el batch
 * no haya corrido.
 *
 * tier + activityStatus se calculan tambien en el refresh, segun los
 * thresholds documentados en TIER_RULES (ver server.js stats helpers).
 */
const mongoose = require('mongoose');

const playerStatsSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },

  // Identidad
  userId: { type: String, default: null },

  // ---- Actividad en NUESTRA app (touched on cada request authed) ----
  // Esto es la "ultima vez que abrio la PWA", NO la ultima carga real.
  lastSeenApp: { type: Date, default: null, index: true },

  // ---- Datos de JUGAYGANA (refrescados via batch) ----
  // CARGA REAL: deposito que el user hizo con su plata, NO bonos nuestros.
  // Excluimos lo que credit-amos via creditUserBalance descontando los
  // claims de RefundClaim/MoneyGiveawayClaim del totalDeposits de JUGAYGANA.
  lastRealDepositDate: { type: Date, default: null, index: true },
  realDeposits30d: { type: Number, default: 0 },     // monto $
  realChargesCount30d: { type: Number, default: 0 }, // cantidad de cargas
  withdraws30d: { type: Number, default: 0 },

  // ---- Bonos que NOSOTROS le dimos (suma de RefundClaim + MoneyGiveawayClaim, 30d) ----
  bonusGiven30d: { type: Number, default: 0 },
  bonusCount30d: { type: Number, default: 0 },

  // ---- Neto a la casa = realDeposits − withdraws − bonusGiven (30d) ----
  // Positivo = la casa gano plata con este jugador. Negativo = el user gano.
  netToHouse30d: { type: Number, default: 0 },

  // ---- Segmentacion calculada ----
  // Tier por volumen+frecuencia de cargas reales en 30d.
  tier: {
    type: String,
    enum: ['VIP', 'ORO', 'PLATA', 'BRONCE', 'NUEVO', 'SIN_DATOS'],
    default: 'SIN_DATOS',
    index: true
  },

  // Estado de actividad por dias desde ultima carga real.
  activityStatus: {
    type: String,
    enum: ['ACTIVO', 'EN_RIESGO', 'PERDIDO', 'INACTIVO', 'NUEVO'],
    default: 'NUEVO',
    index: true
  },

  // ---- Banderas de oportunista ----
  // Cuenta de bonos reclamados sin hacer carga real despues (rolling 30d).
  // Si supera UN umbral (configurable, default 3), isOpportunist = true.
  bonusesClaimedWithoutDeposit30d: { type: Number, default: 0 },
  isOpportunist: { type: Boolean, default: false, index: true },

  // ---- Tracking de pushes de recuperacion ----
  lastRecoveryPushAt: { type: Date, default: null, index: true },
  recoveryAttemptsLifetime: { type: Number, default: 0 },

  // ---- Cache freshness ----
  refreshedAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

// Indices compuestos para los queries del panel.
playerStatsSchema.index({ tier: 1, activityStatus: 1 });
playerStatsSchema.index({ activityStatus: 1, lastRealDepositDate: -1 });
playerStatsSchema.index({ netToHouse30d: -1 });

module.exports = mongoose.models['PlayerStats'] ||
  mongoose.model('PlayerStats', playerStatsSchema);
