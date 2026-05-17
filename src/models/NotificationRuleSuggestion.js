/**
 * NotificationRuleSuggestion — cola de aprobación para reglas con
 * bonus (regalan plata) o que están marcadas como requiresAdminApproval.
 *
 * El cron evaluador, cuando una regla matchea pero requiere aprobación,
 * crea una fila acá con el snapshot de la audiencia resuelta + el
 * mensaje + el bonus configurado. El admin ve la cola en el panel
 * (con un badge 🔔(N) en el sidebar) y puede:
 *   - ✅ Aprobar y enviar → dispara el push real, crea NotificationHistory,
 *     crea MoneyGiveaway si tiene bonus, marca el suggestion como 'approved'.
 *   - ❌ Descartar → marca como 'rejected', no se envía nada.
 *   - Editar el copy/monto antes de aprobar (futuro, no en MVP).
 *
 * Las suggestions tienen TTL de 48h: pasado ese tiempo se marcan como
 * 'expired' (la audiencia ya cambió, el momento se perdió).
 */
const mongoose = require('mongoose');

const notificationRuleSuggestionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  // Referencia a la regla que la generó.
  ruleId: { type: String, required: true, index: true },
  ruleCode: { type: String, required: true }, // copia para mostrar sin lookup
  ruleName: { type: String, required: true },
  ruleCategory: { type: String, required: true, index: true },

  // Snapshot del contenido al momento de sugerir.
  title: { type: String, required: true },
  body: { type: String, required: true },

  // Audiencia resuelta — los usernames a los que iría el push si se aprueba.
  // Al aprobar, NO recalculamos audiencia (sino corremos el riesgo de cambios).
  audienceUsernames: { type: [String], default: [] },
  audienceCount: { type: Number, default: 0 },
  audienceSummary: { type: String, default: null }, // ej: "47 ORO + 35 BRONCE en EN_RIESGO"

  // Bonus copiado del rule.
  bonus: {
    type: { type: String, enum: ['none', 'giveaway', 'promo'], default: 'none' },
    amount: { type: Number, default: 0 },
    durationMinutes: { type: Number, default: 60 },
    requireZeroBalance: { type: Boolean, default: false },
    promoCode: { type: String, default: null }
  },

  // Estado de la sugerencia.
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'expired'],
    default: 'pending',
    index: true
  },

  suggestedAt: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, required: true, index: true },

  // Admin que aprobó o descartó.
  resolvedAt: { type: Date, default: null },
  resolvedBy: { type: String, default: null },
  rejectionReason: { type: String, default: null },

  // Si fue aprobada: referencia al row de NotificationHistory creado.
  notificationHistoryId: { type: String, default: null },
  // Si tenía bonus.type='giveaway': referencia al MoneyGiveaway creado.
  giveawayId: { type: String, default: null },
  // Conteo de envíos efectivos al momento del approve.
  pushDelivered: { type: Number, default: null },
  pushFailed: { type: Number, default: null }
}, { timestamps: true });

notificationRuleSuggestionSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.models['NotificationRuleSuggestion'] ||
  mongoose.model('NotificationRuleSuggestion', notificationRuleSuggestionSchema);
