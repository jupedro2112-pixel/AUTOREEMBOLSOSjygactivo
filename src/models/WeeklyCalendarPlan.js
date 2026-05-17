/**
 * WeeklyCalendarPlan — calendario semanal de difusiones planificadas.
 *
 * Cada plan corresponde a UNA semana ISO (YYYY-Www). Tiene 7 days[]
 * (lunes=0 .. domingo=6) y dentro de cada day un array de strategies.
 *
 * Cada strategy es un "proyecto" individual que el admin planifico
 * para ese dia (ej. martes 10:00, push a EN_RIESGO con bono 50%).
 * Empieza en pendiente; el admin puede dispararla con "Lanzar ahora",
 * lo que llama internamente a sendNotificationToAllUsers y guarda el
 * snapshot del envio. Despues, la performance se actualiza con un
 * boton "Refrescar rendimiento" que mide cargas reales de los
 * targets en JUGAYGANA durante los X dias post-lanzamiento.
 *
 * Estados de la strategy:
 *   pendiente  : planificada, no enviada
 *   lanzando   : envio en curso (mientras corre el bulk push)
 *   lanzado    : push enviado, esperando datos para medir ROI
 *   completado : >= 7 dias pos-lanzamiento, ROI medido
 *   cancelado  : admin la cancelo antes de lanzar
 *
 * El historial NO se borra: cuando arranca otra semana, el plan queda
 * archivado y consultable. Esto evita repetir copys/segmentos.
 */
const mongoose = require('mongoose');

const performanceSchema = new mongoose.Schema({
  measuredAt: { type: Date, default: null },
  daysObserved: { type: Number, default: 0 },
  // Cuantos targets cargaron despues del envio (al menos 1 carga real).
  respondersCount: { type: Number, default: 0 },
  responseRate: { type: Number, default: 0 }, // respondersCount / sentCount
  // Suma de cargas reales de los targets en la ventana.
  newDepositsCount: { type: Number, default: 0 },
  newDepositsAmountARS: { type: Number, default: 0 },
  // Total de bonos efectivamente entregados (claimed).
  bonusGivenARS: { type: Number, default: 0 },
  bonusClaimedCount: { type: Number, default: 0 },
  // ROI = depositos generados / (bono entregado + costo notif). Lo que
  // medimos: depositos / bonusGiven. Si > 1, fue rentable.
  roi: { type: Number, default: 0 },
  // Veredicto cualitativo para que el owner mida de un vistazo.
  sentiment: { type: String, enum: ['positivo', 'neutro', 'negativo', 'sin_datos'], default: 'sin_datos' }
}, { _id: false });

const strategySchema = new mongoose.Schema({
  id: { type: String, required: true },
  dayIndex: { type: Number, required: true, min: 0, max: 6 }, // 0=Lunes
  order: { type: Number, default: 0 }, // orden dentro del dia

  // Tipo de strategy.
  // 'push'     : difusion generica (titulo + body) a un segmento
  // 'refund'   : recordatorio de reembolso pendiente (auto-fijo todos los dias)
  // 'bonus'    : push + ofrece bono (porcentaje sobre la siguiente carga)
  type: { type: String, enum: ['push', 'refund', 'bonus'], default: 'push' },

  // Detalle del proyecto.
  title: { type: String, default: '', maxlength: 100 },
  body: { type: String, default: '', maxlength: 500 },
  // Bono (50% a 100% segun pedido del owner).
  bonusPercent: { type: Number, default: 0, min: 0, max: 100 },
  bonusFlatARS: { type: Number, default: 0 }, // alternativa: monto fijo

  // Audiencia.
  // Combina segmento custom (CALIENTE/EN_RIESGO/PERDIDO/INACTIVO/ACTIVO/all)
  // + tier opcional + lista de equipos a abarcar (vacio = todos).
  targetSegment: { type: String, default: 'all' },
  targetTier: { type: String, default: null }, // VIP/ORO/PLATA/BRONCE/null=all
  targetTeams: { type: [String], default: [] }, // si vacio, todos los equipos
  hasAppOnly: { type: Boolean, default: true }, // por default solo a los con app

  // Para type='refund': qué tipos de reembolso incluir (cualquiera con
  // claim disponible HOY). Default = los 3 (diario/semanal/mensual). El
  // service refundReminderService computa quien tiene cada tipo, los
  // unimos en la audiencia final.
  refundTypes: {
    type: [{ type: String, enum: ['daily', 'weekly', 'monthly'] }],
    default: ['daily', 'weekly', 'monthly']
  },

  // Estado.
  status: { type: String, enum: ['pendiente', 'lanzando', 'lanzado', 'completado', 'cancelado'], default: 'pendiente', index: true },

  // Snapshot del lanzamiento (poblado al hacer launch).
  launchedAt: { type: Date, default: null },
  launchedBy: { type: String, default: null },
  // Lista de usernames a los que se envio (para medir rendimiento).
  // Se limita a 5000 para no inflar el doc; las notifs masivas usan eso.
  targetUsernames: { type: [String], default: [] },
  sentCount: { type: Number, default: 0 },
  deliveredCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },

  // Auto-fijo? (true para el refund-reminder diario).
  isPinned: { type: Boolean, default: false },

  // Performance (ROI medido despues del lanzamiento).
  performance: { type: performanceSchema, default: () => ({}) },

  // Notas del admin.
  notes: { type: String, default: '', maxlength: 500 }
}, { _id: false, timestamps: true });

const weeklyCalendarPlanSchema = new mongoose.Schema({
  // ISO week key (e.g. "2026-W19"). Unique.
  weekKey: { type: String, required: true, unique: true, index: true },
  // Lunes 00:00 ARG de la semana (para sort facil y queries por rango).
  weekStartDate: { type: Date, required: true, index: true },

  status: { type: String, enum: ['draft', 'active', 'completed', 'archived'], default: 'draft', index: true },

  // 7 days, cada uno con strategies[]
  days: [{
    dayIndex: { type: Number, required: true, min: 0, max: 6 },
    label: { type: String, default: '' },
    strategies: { type: [strategySchema], default: [] }
  }],

  // Resumen agregado de la semana (recalculado al refrescar performance).
  summary: {
    totalStrategies: { type: Number, default: 0 },
    launchedCount: { type: Number, default: 0 },
    pendingCount: { type: Number, default: 0 },
    totalSent: { type: Number, default: 0 },
    totalResponders: { type: Number, default: 0 },
    totalNewDeposits: { type: Number, default: 0 },
    totalBonusGiven: { type: Number, default: 0 },
    aggregateRoi: { type: Number, default: 0 },
    sentiment: { type: String, enum: ['positivo', 'neutro', 'negativo', 'sin_datos'], default: 'sin_datos' }
  },

  createdBy: { type: String, default: null }
}, { timestamps: true, optimisticConcurrency: true });

weeklyCalendarPlanSchema.index({ weekStartDate: -1 });

module.exports = mongoose.models['WeeklyCalendarPlan'] ||
  mongoose.model('WeeklyCalendarPlan', weeklyCalendarPlanSchema);
