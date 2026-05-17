/**
 * Modelo de Historial de Notificaciones
 * Cada vez que se manda un push masivo (con o sin promo), se guarda una
 * entrada con: titulo, cuerpo, audiencia, tipo de promo, contadores de
 * clicks WhatsApp y reclamos de regalo, y stats del envio.
 *
 * Sirve para que el admin tenga analisis historico: que mando, a quien,
 * cuando, y cuanta gente respondio.
 */
const mongoose = require('mongoose');

const notificationHistorySchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  // Cuando se mando realmente (si fue inmediato == createdAt; si fue
  // programado == el momento real de envio).
  sentAt: { type: Date, default: Date.now, index: true },

  // Si fue programado para el futuro, registramos cuando se programo y
  // cuando se ejecuto. scheduledFor=null significa envio inmediato.
  scheduledFor: { type: Date, default: null },

  // Audiencia: 'all', 'prefix', 'single' (a un user específico) o 'list'
  // (lista exacta calculada server-side, ej: campañas de recovery por
  // segmento). En 'list' el conteo va en audienceCount.
  audienceType: { type: String, enum: ['all', 'prefix', 'single', 'list'], default: 'all' },
  audiencePrefix: { type: String, default: null, trim: true },
  audienceCount: { type: Number, default: null },

  // Contenido del push.
  title: { type: String, required: true },
  body:  { type: String, required: true },

  // Tipo de notificacion. 'plain' = solo push.
  // 'whatsapp_promo' = ademas activo cartel "RECLAMÁ" con codigo + WA.
  // 'money_giveaway' = ademas activo regalo de plata reclamable on-tap.
  type: {
    type: String,
    enum: ['plain', 'whatsapp_promo', 'money_giveaway', 'line_down'],
    default: 'plain',
    index: true
  },

  // Snapshot de la promo (para display historico aunque la promo se borre).
  promoMessage: { type: String, default: null },
  promoCode:    { type: String, default: null },
  promoExpiresAt: { type: Date, default: null },

  // Snapshot del giveaway (para display historico).
  giveawayAmount:        { type: Number, default: null },
  giveawayDurationMins:  { type: Number, default: null },
  giveawayExpiresAt:     { type: Date, default: null },

  // Stats del envio FCM.
  totalUsers:    { type: Number, default: 0 },
  successCount:  { type: Number, default: 0 },
  failureCount:  { type: Number, default: 0 },
  cleanedTokens: { type: Number, default: 0 },

  // Contadores de respuesta del usuario.
  // waClicks = veces que un user toco el cartel/boton de WhatsApp
  //   habilitado por esta notificacion.
  // giveawayClaims = veces que un user reclamo el regalo de esta notif
  //   (idealmente = users distintos porque el endpoint es one-time per user).
  waClicks:        { type: Number, default: 0 },
  giveawayClaims:  { type: Number, default: 0 },

  // Marcador de "caída de línea": cuando el admin difunde aviso de cambio
  // de número por una línea caída, guardamos acá el lineTeamName afectado.
  // Permite listar el historial de caídas por separado del resto de pushes.
  // null en cualquier otro envío.
  lineDownTeam: { type: String, default: null, index: true },

  // Snapshot del cambio de teléfono (para auditoría en historial).
  lineDownOldPhone: { type: String, default: null },
  lineDownNewPhone: { type: String, default: null },

  // ============= ESTRATEGIA SEMANAL =============
  // Marcadores para identificar pushes generados por el motor de
  // estrategia automática (lunes netwin / jueves tier bonus).
  // Permite filtrar el historial y computar ROI por campaña.
  strategyType: { type: String, default: null, index: true }, // 'netwin-gift' | 'tier-bonus' | null
  strategyMeta: { type: mongoose.Schema.Types.Mixed, default: null },
  // weekKey al que pertenece este push (si es de estrategia).
  strategyWeekKey: { type: String, default: null, index: true },

  // FORECAST per-user: snapshot del plan ejecutado, una entrada por user.
  // Incluye QUÉ se le iba a dar y CONTEXTO usado (pérdida de la semana,
  // acumulado de reembolsos, percentil, etc). Se llena cuando se dispara
  // la campaña, antes/durante el envío. Es el "detalle del plan" que
  // pediste para ver en ROI por difusión apenas se confirma la estrategia.
  strategyDetails: {
    type: [{
      username: String,
      // Para netwin-gift:
      lossARS: Number,            // pérdida computada de la semana
      giftAmount: Number,         // monto ARS regalado
      tierLabel: String,          // "200k–500k", "100k–200k", etc.
      // Para tier-bonus:
      tier: String,               // 'oro' | 'plata' | 'bronce'
      bonusPct: Number,
      refundsARS: Number,         // reembolsos acumulados en lookback
      percentile: Number,         // posición en ranking
      // Comunes (post-fact, llenados por el ROI tracker o claim handler):
      claimed: { type: Boolean, default: false },     // ¿reclamó el regalo?
      claimedAt: Date,
      claimedAmount: Number,                          // monto efectivamente acreditado
      pushDelivered: { type: Boolean, default: null },// ¿le llegó el push? (per-user FCM result)
      // Carga per-user (opcional, requiere on-demand recompute):
      chargedBefore48hARS: Number,
      chargedAfter48hARS: Number,
      // Reactivación: detalle del comportamiento post-push para detectar
      // si el regalo "despertó" al usuario y cargó nueva plata.
      depositCountAfter: Number,                  // cuántas cargas distintas hizo en 48h post-push
      firstDepositAfterAt: Date,                  // timestamp del PRIMER depósito post-push
      firstDepositAfterAmountARS: Number,         // monto del primer depósito post-push
      // Si reclamó el regalo, cuánto cargó DESPUÉS de reclamar (ventana de
      // 48h desde sentAt — solo cuenta lo posterior a claimedAt).
      // chargedAfterClaimARS=null si no reclamó. Es la métrica más limpia
      // para "el regalo lo reactivó".
      chargedAfterClaimARS: Number,
      depositCountAfterClaim: Number,
      perUserChargesTrackedAt: Date,
      classification: String,     // 'converter' | 'passive' | 'no_response' | 'regressive' | null
      _id: false
    }],
    default: []
  },

  // Resumen de clasificación per-user (lo computa el endpoint de
  // performance, así no recalculamos cada vez que se abre el detalle).
  classificationCounts: {
    converter: { type: Number, default: 0 },     // claimed + cargó más
    passive: { type: Number, default: 0 },       // claimed pero no cargó más
    no_response: { type: Number, default: 0 },   // no claimed
    regressive: { type: Number, default: 0 },    // cargó MENOS post-push
    classifiedAt: Date
  },

  // ============= TRACKING DE ROI =============
  // Cuándo el cron de tracking corrió y llenó los campos de carga.
  // Si null, todavía no se midió. El cron busca histories con
  // sentAt < now-48h y roiTrackedAt = null.
  roiTrackedAt: { type: Date, default: null },
  // Sumas de carga (deposits JUGAYGANA) en ARS de los usuarios target,
  // medidas 48h antes del push y 48h después.
  chargesBefore48hARS: { type: Number, default: 0 },
  chargesAfter48hARS: { type: Number, default: 0 },
  chargedUsersAfter: { type: Number, default: 0 }, // cuántos cargaron post-push

  // Grupo control: usuarios que cumplían el criterio de audiencia pero
  // NO recibieron por cap o cooldown. Se mide su carga igual para
  // neutralizar estacionalidad. Solo se llena para pushes de estrategia.
  controlGroupCount: { type: Number, default: 0 },
  controlChargesBefore48hARS: { type: Number, default: 0 },
  controlChargesAfter48hARS: { type: Number, default: 0 },
  controlChargedUsersAfter: { type: Number, default: 0 },

  // Lista de usernames del control group (snapshot al momento de envío).
  // Lo guardamos para que el cron de ROI sepa exactamente a quién medir
  // (no se puede recomputar después porque el estado cambia).
  controlGroupUsernames: { type: [String], default: [] },
  // Lista de usernames del segmento target (idem snapshot).
  audienceUsernames: { type: [String], default: [] },

  sentBy: { type: String, default: null },
}, {
  timestamps: true
});

notificationHistorySchema.index({ sentAt: -1 });
notificationHistorySchema.index({ type: 1, sentAt: -1 });

module.exports = mongoose.models['NotificationHistory'] ||
  mongoose.model('NotificationHistory', notificationHistorySchema);
