/**
 * Notificación programada para envío futuro.
 *
 * El admin la crea con un scheduledFor en el futuro (hasta 1 semana).
 * Un worker en background cada 60s busca filas con status='pending' y
 * scheduledFor <= ahora, las dispara, y las marca como 'sent' o 'failed'.
 *
 * payload incluye TODO lo necesario para replicar el envío exactamente
 * como si el admin hubiera tocado "Enviar ahora": title, body, prefix,
 * promo (si aplica), giveaway (si aplica).
 */
const mongoose = require('mongoose');

const scheduledNotificationSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  scheduledFor: { type: Date, required: true, index: true },

  status: {
    type: String,
    enum: ['pending', 'processing', 'sent', 'failed', 'cancelled'],
    default: 'pending',
    index: true
  },

  // Marcado al pasar a 'processing' para detectar rows abandonadas si
  // el server crashea entre claim y completion.
  processingStartedAt: { type: Date, default: null },

  // Payload completo para replicar el envio. Mismo shape que el admin
  // pasa a sendBulkNotification.
  title: { type: String, required: true },
  body:  { type: String, required: true },
  audiencePrefix: { type: String, default: null, trim: true },
  // Lista de prefijos a EXCLUIR del broadcast. Solo aplica cuando NO hay
  // audiencePrefix (es decir, broadcast a todos menos estos equipos). Útil
  // para casos como "mandar a todos pero NO al equipo zz_crazy".
  excludePrefixes: { type: [String], default: null },

  // Target por username EXACTO (case-insensitive). Si está seteado, gana
  // sobre audiencePrefix y manda solo a ese usuario. Pensado para notifs
  // disparadas por flows automáticos (ej: post-welcome-bonus → recordatorio
  // 10 min después con el código de retiro).
  targetUsername: { type: String, default: null, trim: true, lowercase: true },

  // Tipo de extra: 'none' | 'promo' | 'giveaway'
  extraType: { type: String, enum: ['none', 'promo', 'giveaway'], default: 'none' },

  // Si extraType === 'promo'
  promoMessage:        { type: String, default: null },
  promoCode:           { type: String, default: null },
  promoDurationHours:  { type: Number, default: null },

  // Si extraType === 'giveaway'
  giveawayAmount:           { type: Number, default: null },
  giveawayBudget:           { type: Number, default: null },
  giveawayMaxClaims:        { type: Number, default: null },
  giveawayDurationMinutes:  { type: Number, default: null },
  // Texto que se muestra en el card de la PWA del giveaway cuando el
  // user entra a reclamar. Si null → fallback al texto genérico.
  giveawayCustomMessage:    { type: String, default: null },
  giveawayCustomEmoji:      { type: String, default: null },
  // Si está en true, el regalo creado por esta notif programada solo lo
  // pueden reclamar usuarios con saldo <= 0 en JUGAYGANA.
  giveawayRequireZeroBalance: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now, index: true },
  createdBy: { type: String, default: null },

  // Cuando efectivamente se ejecuto (== scheduledFor + drift del worker).
  executedAt: { type: Date, default: null },
  errorMsg:   { type: String, default: null },

  // Vinculo al row de NotificationHistory creado al ejecutar (para que
  // el admin pueda hacer click y ver los contadores de respuesta).
  notificationHistoryId: { type: String, default: null }
}, { timestamps: true });

scheduledNotificationSchema.index({ status: 1, scheduledFor: 1 });

module.exports = mongoose.models['ScheduledNotification'] ||
  mongoose.model('ScheduledNotification', scheduledNotificationSchema);
