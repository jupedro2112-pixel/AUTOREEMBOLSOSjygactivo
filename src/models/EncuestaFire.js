/**
 * EncuestaFire — registro de cada disparo de la estrategia "Encuesta".
 *
 * Cumple dos funciones:
 *   1) Deduplicar: el slotKey es único, así un mismo slot (grupo + día +
 *      tipo en una semana ISO) no se dispara dos veces aunque el cron
 *      corra cada 5 minutos.
 *   2) Alimentar los reportes diarios (Fase 4): cuántos pushes salieron,
 *      a cuánta gente y cuántos bonos se generaron.
 */
const mongoose = require('mongoose');

const encuestaFireSchema = new mongoose.Schema({
  // "<isoWeek>-<cohort>-<dia>-<type>[-<percent>]", p.ej. 2026-W21-normal-jue-bono-100
  slotKey: { type: String, required: true, unique: true, index: true },

  cohort:  { type: String, enum: ['suave', 'normal', 'activo'], required: true, index: true },
  type:    { type: String, enum: ['bono', 'incentivo'], required: true },
  percent: { type: Number, default: 0 },

  title: { type: String, default: '' },
  body:  { type: String, default: '' },

  recipients:   { type: Number, default: 0 }, // a cuánta gente se mandó el push
  bonosCreados: { type: Number, default: 0 }, // PromoBonus generados (slots de bono)

  firedAt: { type: Date, default: Date.now, index: true }
}, { timestamps: false });

module.exports = mongoose.models['EncuestaFire'] ||
  mongoose.model('EncuestaFire', encuestaFireSchema);
