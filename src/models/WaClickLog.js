/**
 * Log de clicks en el cartel de promo WhatsApp.
 *
 * Cada vez que un user toca el boton "RECLAMÁ" (cartel de promo activo
 * sobre QUIERO CARGAR), insertamos un row aca. Sirve para reportes de
 * engagement (top usuarios que mas interactuan con las difusiones).
 *
 * No hay unique index porque el user puede tocar varias promos distintas.
 * Si quisieramos contar usuarios unicos por promo, usariamos un
 * compound unique sobre (notificationHistoryId, username); por ahora
 * preferimos contar todos los clicks (engagement bruto).
 */
const mongoose = require('mongoose');

const waClickLogSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  userId:   { type: String, required: true, index: true },
  username: { type: String, required: true, index: true, trim: true },

  // promoId del activePromoAlert (no es FK fuerte, solo trace).
  promoId: { type: String, default: null, index: true },

  // Vinculo al row de NotificationHistory para correlacionar.
  notificationHistoryId: { type: String, default: null, index: true },

  clickedAt: { type: Date, default: Date.now, index: true, immutable: true }
}, { timestamps: true });

waClickLogSchema.index({ username: 1, clickedAt: -1 });

module.exports = mongoose.models['WaClickLog'] ||
  mongoose.model('WaClickLog', waClickLogSchema);
