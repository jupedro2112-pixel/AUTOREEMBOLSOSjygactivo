/**
 * Modelo de Notificaciones Programadas
 * Guarda los envíos de notificaciones push agendados (una vez / diario / semanal).
 * Un worker (setInterval) revisa cada minuto y dispara los que corresponden.
 */
const mongoose = require('mongoose');

const scheduledNotifSchema = new mongoose.Schema({
  type: {
    type: String,
    // bono_50/bono_100 eliminados del enum (owner 2026-07-08). Los docs viejos con esos
    // tipos siguen legibles (el enum solo valida al crear/guardar); el worker los
    // auto-desactiva y la migración one-shot del arranque los apaga.
    enum: ['invitacion', 'regalo', 'reembolso'],
    required: true
  },
  plan: {
    type: String,
    enum: ['suave', 'normal', 'activo', 'solo_reembolsos', 'todos'],
    required: true
  },
  mode: {
    type: String,
    enum: ['once', 'daily', 'weekly'],
    required: true
  },
  // 'once': instante exacto de ejecución.
  runAt: { type: Date, default: null },
  // 'daily'/'weekly': hora 'HH:MM' (hora Argentina).
  time: { type: String, default: null },
  // 'weekly': día de la semana (0=domingo … 6=sábado).
  dayOfWeek: { type: Number, default: null, min: 0, max: 6 },
  enabled: { type: Boolean, default: true, index: true },
  lastRunAt: { type: Date, default: null },
  lastResult: { type: String, default: null },
  createdBy: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.models['ScheduledNotif'] || mongoose.model('ScheduledNotif', scheduledNotifSchema);
