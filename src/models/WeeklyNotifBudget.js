/**
 * Tracking del cap semanal de notificaciones de la estrategia.
 *
 * Una fila por (username, weekKey). Cuenta cuántas notifs de la
 * estrategia automática recibió este user esta semana, y guarda el
 * timestamp de la última para enforcer el cooldown entre notifs.
 *
 * No cuenta notifs MANUALES del admin ni notifs de las reglas viejas
 * (B1-B6, A3-A4) — esto es solo para el motor de estrategia semanal.
 *
 * weekKey formato ISO 8601: '2026-W18' (mismo formato que usa
 * computePeriodKey('weekly') en server.js).
 */
const mongoose = require('mongoose');

const weeklyNotifBudgetSchema = new mongoose.Schema({
  username: { type: String, required: true, index: true, trim: true },
  weekKey: { type: String, required: true, index: true },

  count: { type: Number, default: 0 },
  lastSentAt: { type: Date, default: null },

  // Snapshot de cada notif enviada: para debug y para que el reporte
  // miércoles pueda armar el calendario de la semana.
  // type: 'netwin-gift' | 'tier-bonus'
  notifications: [{
    sentAt: Date,
    type: String,
    historyId: String,
    tier: String,            // 'oro' | 'plata' | 'bronce' | null
    giftAmount: Number,      // ARS si fue netwin-gift
    bonusPct: Number,        // % si fue tier-bonus
    _id: false
  }]
}, { timestamps: true });

weeklyNotifBudgetSchema.index({ username: 1, weekKey: 1 }, { unique: true });

module.exports = mongoose.models['WeeklyNotifBudget'] ||
  mongoose.model('WeeklyNotifBudget', weeklyNotifBudgetSchema);
