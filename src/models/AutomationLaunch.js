/**
 * Modelo de Lanzamientos de Automatización
 *
 * Cada vez que el admin lanza una campaña desde la sección 🤖 Automatización,
 * se guarda un AutomationLaunch que sirve para:
 *   - Auditoría: quien lanzo que, cuando, con que parametros.
 *   - Veredicto: a las 48-72h se calcula si la campaña fue rentable
 *     (carga real / costo bono) y si despertó la base (% aperturas).
 *   - Comparativa: que % de bono convirtió mejor en cada cohorte.
 *
 * El doc nunca se borra ni se edita despues del launch (excepto el bloque
 * de outcomes que se actualiza una sola vez cuando vence la ventana).
 */
const mongoose = require('mongoose');

const automationLaunchSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  launchedAt: { type: Date, default: Date.now, index: true },
  launchedBy: { type: String, default: null },

  // Rango de datos analizado para armar la cohorte.
  analysisFrom: { type: Date, required: true },
  analysisTo: { type: Date, required: true },
  preset: {
    type: String,
    enum: ['daily', 'weekly', 'monthly', 'custom', null],
    default: 'custom'
  },

  // Resumen del split 70/30 que se aplicó.
  totalTargets: { type: Number, default: 0 },
  engagementCount: { type: Number, default: 0 },
  bonusCount: { type: Number, default: 0 },
  totalCostARS: { type: Number, default: 0 },

  // Breakdown por segmento, para reporting agregado.
  // [{ segment, label, count, engagementCount, bonusCount, costARS, avgBonusPct, avgGiftAmount }]
  segments: { type: [mongoose.Schema.Types.Mixed], default: [] },

  // Detalle per-user (lo mandado a cada uno). Liviano, sin datos sensibles.
  // [{ username, segment, kind, giftAmount, bonusPct, copyTitle, copyBody, sentAt? }]
  targets: { type: [mongoose.Schema.Types.Mixed], default: [] },

  // Resultado del envio mismo (FCM).
  sentCount: { type: Number, default: 0 },
  failureCount: { type: Number, default: 0 },

  // Punteros a entidades creadas por este launch.
  notificationHistoryId: { type: String, default: null, index: true },
  giveawayIds: { type: [String], default: [] },

  // Veredicto calculado a las 48h del launch.
  // 'pending' = aun no se evaluo
  // 'good' = ratio carga real / costo >= 3 (o aperturas >= +20% del baseline)
  // 'regular' = ratio entre 1 y 3 (o +5%-20% del baseline)
  // 'bad' = ratio < 1 (o sin lift)
  verdict: {
    type: String,
    enum: ['pending', 'good', 'regular', 'bad'],
    default: 'pending',
    index: true
  },
  verdictComputedAt: { type: Date, default: null },

  // Metricas usadas en el veredicto.
  outcomeChargesAfterCount: { type: Number, default: 0 },
  outcomeChargesAfterARS: { type: Number, default: 0 },
  outcomeAppOpensAfter: { type: Number, default: 0 },
  outcomeRoiRatio: { type: Number, default: 0 } // chargesARS / totalCostARS
}, { timestamps: true });

automationLaunchSchema.index({ launchedAt: -1 });
automationLaunchSchema.index({ verdict: 1, launchedAt: -1 });

module.exports = mongoose.models['AutomationLaunch'] ||
  mongoose.model('AutomationLaunch', automationLaunchSchema);
