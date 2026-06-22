/**
 * BonusStrategyConfig — config de la "Estrategia de bonos por encuesta".
 *
 * Singleton (key 'default'). Define una secuencia escalonada de 2 pasos
 * que recibe cada usuario que vota la encuesta de notificaciones:
 *   paso 1 → push con bono de carga del 15%
 *   paso 2 → push con bono de carga del 30% (TOPE)
 * El plan que votó (suave/normal/activo) define CADA CUÁNTO le llega cada
 * paso, contado desde que se inscribió (votó). solo_reembolsos no entra.
 *
 * REGLA (owner 2026-06-22): el bono de cada paso es ≤30% (escalonado 15/20/25/30)
 * y dura ≤2h. El tope lo refuerzan la validación del endpoint y activateChargeBonuses.
 *
 * isActive = la estrategia está lanzada; el cron procesa las inscripciones.
 */
const mongoose = require('mongoose');

const stepSchema = new mongoose.Schema({
  percent: { type: Number, default: 15, min: 1, max: 30 },
  durationMinutes: { type: Number, default: 120, min: 5, max: 120 },
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
      percent: 15, durationMinutes: 120,
      title: '🎁 Tenés un bono del 15%',
      body: 'Te activamos un 15% extra para tu próxima carga. Cargá ahora y pedí tu bono al agente — ¡dura 2 horas!'
    })
  },
  step2: {
    type: stepSchema,
    default: () => ({
      percent: 30, durationMinutes: 120,
      title: '🔥 Bono del 30% para vos',
      body: 'Te activamos un 30% de bono para tu próxima carga. Cargá ahora y aprovechá — por tiempo limitado (2 horas).'
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
