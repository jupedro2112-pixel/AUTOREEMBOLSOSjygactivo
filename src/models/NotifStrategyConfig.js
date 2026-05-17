/**
 * NotifStrategyConfig: configuracion mensual editable desde el panel
 * admin (seccion Encuesta) para definir cuantos pushes y cuanta plata
 * destinamos a cada uno de los 4 niveles que el user puede elegir.
 *
 * Singleton: existe UN solo doc activo. La key es 'monthly-default'.
 * Cada vez que el admin guarda, se actualiza ese doc — el historial de
 * cambios queda en `revisions` (append-only) para poder revertir o
 * auditar quien movio que.
 */
const mongoose = require('mongoose');

const tierConfigSchema = new mongoose.Schema({
  bonos: { type: Number, default: 0, min: 0 },
  juegos: { type: Number, default: 0, min: 0 },     // "juga con nosotros"
  regalos: { type: Number, default: 0, min: 0 },
  budget: { type: Number, default: 0, min: 0 },     // monto total $ por user/mes
  refundsOnly: { type: Boolean, default: false }    // true = solo notifica si hay refund disponible
}, { _id: false });

const revisionSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  by: { type: String, default: 'admin' },
  prefs: { type: mongoose.Schema.Types.Mixed, default: {} },
  monthlyCap: { type: Number, default: 0 }
}, { _id: false });

const notifStrategyConfigSchema = new mongoose.Schema({
  // Singleton key — siempre 'monthly-default' por ahora. Si en el
  // futuro queremos perfiles distintos (ej por equipo) se agregan keys.
  key: { type: String, required: true, unique: true, default: 'monthly-default', index: true },

  preferences: {
    // Defaults estandar — matchean la pregunta de la encuesta:
    //  SUAVE  = 2 bonos · 5 invitaciones · 2 regalos · presupuesto 100k/user
    //  NORMAL = 4 bonos · 5 invitaciones · 2 regalos · presupuesto 100k/user
    //  ACTIVO = 6 bonos · 10 invitaciones · 3 regalos · presupuesto 100k/user
    //  SOLO_REEMBOLSOS = 0/0/0 (refundsOnly:true)
    suave: { type: tierConfigSchema, default: () => ({ bonos: 2, juegos: 5, regalos: 2, budget: 100000 }) },
    normal: { type: tierConfigSchema, default: () => ({ bonos: 4, juegos: 5, regalos: 2, budget: 100000 }) },
    activo: { type: tierConfigSchema, default: () => ({ bonos: 6, juegos: 10, regalos: 3, budget: 100000 }) },
    solo_reembolsos: { type: tierConfigSchema, default: () => ({ bonos: 0, juegos: 0, regalos: 0, budget: 0, refundsOnly: true }) }
  },

  // Tope mensual GLOBAL de regalos (suma de "regalos" * "budget" por
  // user no debe exceder esto). El admin elige.
  monthlyCap: { type: Number, default: 1000000, min: 0 },

  // Plata total que el admin destina a regalos al mes (suma a repartir
  // entre TODOS los users no-opt). El sistema auto-calcula cuanto le
  // toca a cada uno cruzando con su tier + actividad.
  monthlyTotalToDistribute: { type: Number, default: 250000, min: 0 },

  // Tipo de bono que el admin quiere usar este mes. Free-form para no
  // limitar el negocio. Default standard: 50% en cargas + 1 vez 100%/mes.
  bonusType: { type: String, default: '50% en cargas + 1× 100% al mes', maxlength: 120 },

  // Defaults de los 2 bonos clasicos sugeridos por el owner.
  bonus50pctEnabled: { type: Boolean, default: true },
  bonus100pctTimedEnabled: { type: Boolean, default: true },
  bonus100pctStartHour: { type: Number, default: 19, min: 0, max: 23 },
  bonus100pctDurationHours: { type: Number, default: 2, min: 1, max: 24 },

  // Ventana horaria de envío de las waves de la estrategia. Cuando una
  // wave se dispara (auto +100 o test fire), cada user recibe el push
  // a una hora RANDOM dentro de [windowStartHour, windowEndHour). Si la
  // ventana de hoy ya pasó (now >= endHour), se reprograma para mañana.
  // Default 18-21hs (3 horas de ventana, ratos de tráfico alto).
  windowStartHour: { type: Number, default: 18, min: 0, max: 23 },
  windowEndHour: { type: Number, default: 21, min: 1, max: 24 },

  // Estrategia activa: si true, los pushes auto-programados respetan
  // este config. Si false, queda como borrador.
  isActive: { type: Boolean, default: false },
  activatedAt: { type: Date, default: null },
  activatedBy: { type: String, default: null },

  // Auto-repeat por cohorte +100. Cuando isActive=true y autoRepeatEnabled,
  // cada vez que la cantidad de users con notifPreference cruza un múltiplo
  // de autoRepeatThreshold (default 100), disparamos fireStrategyWave una
  // sola vez para esa cohorte. lastAutoFiredAtRespCount sirve como idempotencia.
  autoRepeatEnabled: { type: Boolean, default: true },
  autoRepeatThreshold: { type: Number, default: 100, min: 10, max: 10000 },
  lastAutoFiredAt: { type: Date, default: null },
  lastAutoFiredAtRespCount: { type: Number, default: 0 },
  autoFireCount: { type: Number, default: 0 },

  // Historial de cambios (ultimos 50). Append-only.
  revisions: { type: [revisionSchema], default: [] },

  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: String, default: 'admin' }
}, { timestamps: false });

module.exports = mongoose.models['NotifStrategyConfig'] ||
  mongoose.model('NotifStrategyConfig', notifStrategyConfigSchema);
