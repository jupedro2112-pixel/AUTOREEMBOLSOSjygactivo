/**
 * BonusStrategyConfig — config de la "Estrategia de bonos por encuesta".
 *
 * Singleton (key 'default'). Define una secuencia escalonada de 2 pasos
 * que recibe cada usuario que vota la encuesta de notificaciones:
 *   paso 1 → push con bono de carga del 50%
 *   paso 2 → push con bono de carga del 100%
 * El plan que votó (suave/normal/activo) define CADA CUÁNTO le llega cada
 * paso, contado desde que se inscribió (votó). solo_reembolsos no entra.
 *
 * isActive = la estrategia está lanzada; el cron procesa las inscripciones.
 */
const mongoose = require('mongoose');

const stepSchema = new mongoose.Schema({
  percent: { type: Number, default: 50, min: 1, max: 1000 },
  durationMinutes: { type: Number, default: 120, min: 5 },
  title: { type: String, default: '' },
  body: { type: String, default: '' }
}, { _id: false });

const planDelaySchema = new mongoose.Schema({
  step1Hours: { type: Number, default: 24, min: 0 },
  step2Hours: { type: Number, default: 96, min: 0 }
}, { _id: false });

const bonusStrategyConfigSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'default', index: true },

  isActive: { type: Boolean, default: false },
  activatedAt: { type: Date, default: null },
  activatedBy: { type: String, default: null },

  step1: {
    type: stepSchema,
    default: () => ({
      percent: 50, durationMinutes: 120,
      title: '🎁 Tenés un bono del 50%',
      body: 'Te activamos un 50% extra para tu próxima carga. Cargá ahora y pedí tu bono al agente.'
    })
  },
  step2: {
    type: stepSchema,
    default: () => ({
      percent: 100, durationMinutes: 120,
      title: '🔥 Bono del 100% — ¡doble carga!',
      body: 'Te activamos un 100% de bono. Cargá ahora y se te duplica. Por tiempo limitado.'
    })
  },

  // Retraso de cada paso por plan votado (en horas desde la inscripción).
  planDelays: {
    suave:  { type: planDelaySchema, default: () => ({ step1Hours: 24, step2Hours: 120 }) },
    normal: { type: planDelaySchema, default: () => ({ step1Hours: 6,  step2Hours: 72 }) },
    activo: { type: planDelaySchema, default: () => ({ step1Hours: 1,  step2Hours: 24 }) }
  },

  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: String, default: null }
}, { timestamps: false });

module.exports = mongoose.models['BonusStrategyConfig'] ||
  mongoose.model('BonusStrategyConfig', bonusStrategyConfigSchema);
