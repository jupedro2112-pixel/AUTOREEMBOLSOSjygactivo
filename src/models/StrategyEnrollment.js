/**
 * StrategyEnrollment — inscripción de un usuario en la estrategia de
 * bonos por encuesta.
 *
 * Se crea/actualiza cuando el usuario vota la encuesta de notificaciones
 * (1 por usuario, username único). Guarda CUÁNDO se inscribió — ese es el
 * reloj que usa el cron para mandarle el paso 1 y el paso 2 según los
 * retrasos del plan que votó.
 *
 * step: 0 = inscripto, sin pasos · 1 = ya recibió el bono 50% ·
 *       2 = ya recibió el bono 100% (secuencia completa)
 */
const mongoose = require('mongoose');

const strategyEnrollmentSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  userId: { type: String, default: null, index: true },
  username: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },

  // Plan votado en la encuesta. solo_reembolsos no se inscribe.
  plan: { type: String, enum: ['suave', 'normal', 'activo'], required: true, index: true },

  // Reloj de la estrategia: desde acá se cuentan los retrasos de cada paso.
  enrolledAt: { type: Date, default: Date.now, index: true },

  step: { type: Number, default: 0, min: 0, max: 2, index: true },
  step1At: { type: Date, default: null },
  step2At: { type: Date, default: null }
}, { timestamps: false });

strategyEnrollmentSchema.index({ step: 1, plan: 1 });

module.exports = mongoose.models['StrategyEnrollment'] ||
  mongoose.model('StrategyEnrollment', strategyEnrollmentSchema);
