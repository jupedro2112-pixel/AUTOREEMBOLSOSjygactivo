/**
 * UserNotification — inbox por usuario para que pueda releer los pushes
 * que recibió desde dentro de la PWA. Se crea 1 row por (user, push)
 * cuando se manda algo a un user.
 *
 * Distinto de NotificationHistory (que es admin-side, agregado por broadcast).
 * Acá tenemos granularidad usuario: cada user ve solo SUS notifs.
 *
 * Tipos:
 *   'quiniela'   = resultado de quiniela publicado
 *   'complaint'  = mensaje del admin en una queja del user
 *   'broadcast'  = push masivo del admin (whatsapp_promo / money_giveaway)
 *   'plain'      = otros
 *
 * `data` guarda el payload original del FCM (ej: complaintId, quinielaId)
 * para que el front pueda hacer deep-link si el user toca la notif del
 * inbox.
 *
 * Retención: el cron de stats puede borrar rows con sentAt < hoy - 60d
 * para que no crezca infinito. Default sin cleanup.
 */
const mongoose = require('mongoose');

const userNotificationSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  // Usuario destinatario. username lowercase para queries case-insensitive.
  userId:   { type: String, required: true, index: true },
  username: { type: String, required: true, lowercase: true, trim: true, index: true },

  // Tipo + contenido del push.
  type: {
    type: String,
    enum: ['quiniela', 'complaint', 'broadcast', 'plain'],
    default: 'plain',
    index: true
  },
  title: { type: String, required: true, maxlength: 200, trim: true },
  body:  { type: String, required: true, maxlength: 600, trim: true },

  // Payload extra (complaintId, quinielaId, url, etc.).
  data: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Tracking de lectura. Por default no leída. Cuando el user abre el
  // inbox y la mira, setea readAt. El front muestra un dot rojo si readAt
  // es null.
  readAt: { type: Date, default: null },

  sentAt: { type: Date, default: Date.now, index: true }
}, {
  collection: 'user_notifications',
  timestamps: false,
  versionKey: false
});

// Index compound principal: inbox del user ordenado por más reciente.
userNotificationSchema.index({ username: 1, sentAt: -1 });
// Para contar no leídas rápido.
userNotificationSchema.index({ username: 1, readAt: 1 });

module.exports = mongoose.models['UserNotification'] ||
  mongoose.model('UserNotification', userNotificationSchema);
