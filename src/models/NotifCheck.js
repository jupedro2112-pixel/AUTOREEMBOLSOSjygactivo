/**
 * Notif Check Campaign.
 *
 * Cuando admin manda una "verificación de notificaciones", crea un
 * NotifCheck. Sirve para medir cuántos users con app + notifs realmente
 * ven el push (no solo lo reciben). El user toca "CONFIRMAR" en la PWA
 * y se registra en NotifCheckConfirm.
 *
 * Métricas:
 *   - audienceTotal: cuántos users target tenian FCM tokens al momento
 *   - sentCount: cuántos pushes mandó FCM con success
 *   - tappedCount: cuántos abrieron el push (vía PushTapLog source='notif-check')
 *   - confirmedCount: cuántos tocaron "CONFIRMAR" (NotifCheckConfirm)
 */
const mongoose = require('mongoose');

const checkSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  title: { type: String, default: '🔔 Test de notificaciones' },
  message: { type: String, required: true, default: '' },

  // Audiencia: por ahora solo broadcast (todos con FCM). Extender a
  // prefix/team si hace falta.
  audienceTotal: { type: Number, default: 0 },
  sentCount: { type: Number, default: 0 },

  // Counters incrementales (también se pueden recomputar desde
  // PushTapLog + NotifCheckConfirm si se desfasan).
  tappedCount: { type: Number, default: 0 },
  confirmedCount: { type: Number, default: 0 },

  // Meta opcional: si admin lo configura, la PWA y el panel admin
  // muestran la barra de progreso "X / goalTaps". Cuando el contador
  // alcanza la meta, admin sabe que cumplió el objetivo del push.
  goalTaps: { type: Number, default: null },
  goalReachedAt: { type: Date, default: null, index: true },

  createdAt: { type: Date, default: Date.now, index: true },
  createdBy: { type: String, default: null },

  // Estado: 'active' (la PWA muestra el card de confirmar mientras
  // esté abierto), 'closed' (admin lo cerró), 'expired' (TTL pasó).
  status: {
    type: String,
    enum: ['active', 'closed', 'expired'],
    default: 'active',
    index: true
  },
  expiresAt: { type: Date, default: null, index: true }
}, { timestamps: true });

module.exports = mongoose.models['NotifCheck'] ||
  mongoose.model('NotifCheck', checkSchema);
