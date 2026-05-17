/**
 * Snapshot diario de la salud del canal de push notifications.
 *
 * Una fila por día (clave: dateKey en formato YYYY-MM-DD ART). Cuenta cuántos
 * usuarios tienen al mismo tiempo PWA instalada (fcmTokens con context='standalone')
 * Y permiso de notificaciones concedido. Es la base del chip de evolución
 * que se ve en el panel de estadísticas: sirve para detectar a tiempo si la
 * base de canal abierto está creciendo o se está erosionando.
 *
 * Lo escribe un cron diario a las 00:05 ART. El bootstrap de los últimos 30
 * días al primer arranque después del deploy se aproxima usando
 * fcmToken.updatedAt — no es exacto (no resta desinstalaciones del pasado),
 * pero da una curva de referencia hasta que se acumulen snapshots reales.
 */
const mongoose = require('mongoose');

const appNotifSnapshotSchema = new mongoose.Schema({
  // Clave canónica: 'YYYY-MM-DD' en hora Argentina. Único.
  dateKey: { type: String, required: true, unique: true, index: true },

  // Total de usuarios role='user' (no admins) en la base al momento del snapshot.
  // Sirve de denominador para calcular % de cobertura del canal.
  totalUsers: { type: Number, required: true, default: 0 },

  // Usuarios con PWA instalada (algún token con context='standalone').
  withApp: { type: Number, required: true, default: 0 },

  // Usuarios con notif permission='granted' (algún token).
  withNotifs: { type: Number, required: true, default: 0 },

  // Usuarios con AMBAS (la métrica que importa: canal de push abierto).
  withBoth: { type: Number, required: true, default: 0 },

  // Cómo se calculó: 'cron' (snapshot real al fin del día) o 'bootstrap-approx'
  // (reconstrucción desde fcmToken.updatedAt al primer deploy). Permite
  // distinguirlos en la curva.
  source: {
    type: String,
    enum: ['cron', 'bootstrap-approx', 'manual'],
    default: 'cron',
    index: true
  }
}, { timestamps: true });

module.exports = mongoose.models['AppNotifSnapshot'] ||
  mongoose.model('AppNotifSnapshot', appNotifSnapshotSchema);
