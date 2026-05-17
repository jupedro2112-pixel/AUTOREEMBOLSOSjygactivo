/**
 * Recordatorios de Reembolso (singleton config)
 *
 * El admin habilita un push diario a la hora que elija para que los users
 * que tienen un reembolso para reclamar (y no lo reclamaron) reciban un
 * empujón. Hay 3 tipos: daily, weekly, monthly. Cada uno se configura
 * por separado (puede haber solo daily activo, o los 3, etc.).
 *
 * teamFilter: si está seteado, solo manda a users con lineTeamName == teamFilter.
 *             null = todos los equipos.
 *
 * lastFiredKey: YYYY-MM-DD del último día que ese tipo se disparó. Sirve
 *               para que el cron no dispare 2 veces el mismo día.
 *
 * Respeta cap semanal + cooldown del config global (igual que estrategia).
 */
const mongoose = require('mongoose');

const reminderTypeSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  hourART: { type: Number, default: 20, min: 0, max: 23 },     // hora ART (0-23)
  minuteART: { type: Number, default: 0, min: 0, max: 59 },     // minuto
  teamFilter: { type: String, default: null, trim: true },      // null = todos
  customTitle: { type: String, default: null, trim: true },
  customBody: { type: String, default: null, trim: true },
  lastFiredKey: { type: String, default: null },                // YYYY-MM-DD del último fire
  lastFiredAt: { type: Date, default: null },
  totalFiresAllTime: { type: Number, default: 0 }
}, { _id: false });

const refundReminderConfigSchema = new mongoose.Schema({
  id: { type: String, default: 'main', unique: true, index: true },
  daily:   { type: reminderTypeSchema, default: () => ({}) },
  weekly:  { type: reminderTypeSchema, default: () => ({}) },
  monthly: { type: reminderTypeSchema, default: () => ({}) },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.models['RefundReminderConfig'] ||
  mongoose.model('RefundReminderConfig', refundReminderConfigSchema);
