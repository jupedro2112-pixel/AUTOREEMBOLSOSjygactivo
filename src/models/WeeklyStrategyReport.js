/**
 * Reporte semanal de la estrategia.
 *
 * Una fila por (weekKey, kind). Generado automáticamente cada miércoles
 * 09:00 ART (configurable). Resume:
 *   - qué se envió (netwin-gift, tier-bonus)
 *   - quién respondió (claims, clicks, cargas post-push)
 *   - delta-venta atribuible vs grupo control
 *   - ROI = (Δ carga − costo) / costo
 *   - recomendaciones automáticas para la próxima semana
 *
 * Se guarda como persistente para que el admin pueda ver el histórico
 * y comparar semanas. La generación es idempotente: si ya existe el
 * reporte para una weekKey, se sobreescribe.
 */
const mongoose = require('mongoose');

const campaignStatsSchema = new mongoose.Schema({
  campaign: String,            // 'netwin-gift' | 'tier-bonus'
  notifsSent: Number,          // pushes entregados
  audienceSize: Number,        // a cuántos targets se intentó mandar
  controlGroupSize: Number,    // gente que cumplía pero no recibió (cap)
  totalGiftedARS: Number,      // plata regalada (suma de claims, no del budget)
  totalClaimedCount: Number,
  waClicks: Number,
  // Carga (deposits JUGAYGANA) en ARS:
  chargesBefore48hARS: Number, // suma de deposits 48h antes del push
  chargesAfter48hARS: Number,  // suma de deposits 48h después
  controlChargesBefore48hARS: Number,
  controlChargesAfter48hARS: Number,
  // Δ atribuible (post-pre del segmento, normalizado contra control)
  deltaSalesAttributableARS: Number,
  roi: Number,                 // (Δ - costo) / costo. >0 = ganancia
  perTier: { type: mongoose.Schema.Types.Mixed, default: null }
}, { _id: false });

const weeklyStrategyReportSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  weekKey: { type: String, required: true, index: true },

  // 'auto' = generado por cron miércoles. 'manual' = forzado por admin.
  kind: { type: String, enum: ['auto', 'manual'], default: 'auto' },

  // Cuándo se generó (no la weekKey, sino el momento de cómputo).
  generatedAt: { type: Date, default: Date.now },

  // 'ok' = todo bien.
  // 'budget-exceeded' = se quiso disparar pero superaba weeklyBudgetCapARS,
  //   se frenó y se loguea para review humano.
  // 'partial' = algunas campañas fallaron.
  // 'paused' = la estrategia estaba pausada.
  status: { type: String, enum: ['ok', 'budget-exceeded', 'partial', 'paused'], default: 'ok' },

  // Resumen agregado de la semana.
  totalSpentARS: { type: Number, default: 0 },     // costo (regalos + bonos pagados)
  totalDeltaSalesARS: { type: Number, default: 0 },// Δ carga atribuible
  totalROI: { type: Number, default: 0 },

  // Stats por campaña.
  campaigns: { type: [campaignStatsSchema], default: [] },

  // Recomendaciones generadas por el motor para la próxima semana.
  // Texto plano, mostrado al admin en un banner.
  recommendations: { type: [String], default: [] },

  // Snapshot del config con el que se ejecutó (para auditar cambios).
  configSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },

  // Mensaje de error si status != 'ok'.
  errorMessage: { type: String, default: null }
}, { timestamps: true });

weeklyStrategyReportSchema.index({ weekKey: -1, kind: 1 });

module.exports = mongoose.models['WeeklyStrategyReport'] ||
  mongoose.model('WeeklyStrategyReport', weeklyStrategyReportSchema);
