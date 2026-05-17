/**
 * TeamCampaign — campaña de notificaciones por equipo/línea con horario fijo.
 *
 * Reemplaza la automatización per-user de la encuesta (que disparaba pushes
 * a horas random dentro de una ventana). Ahora el admin define campañas
 * concretas: "Bono 50% para equipo Atomic, miércoles 18-20 hs" y el cron
 * dispara los pushes a los users del equipo/línea en una hora random dentro
 * del rango horario configurado.
 *
 * Cada campaña puede crear opcionalmente un promo (cartel wa.link) o un
 * giveaway (botón Reclamar) — siempre scoped por user (audienceWhitelist).
 *
 * El cron corre cada 60s y dispara campañas matching: día = hoy + hora actual
 * dentro de [startHour, endHour). Idempotente vía lastFiredOnDate (solo
 * dispara una vez por día, no importa cuántos ticks pasen dentro del rango).
 */
const mongoose = require('mongoose');

const teamCampaignSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  name: { type: String, required: true, maxlength: 120 },

  // Target — qué users alcanza la campaña.
  teamFilter: { type: String, default: null, trim: true },   // "Atomic" o null=todos
  lineFilter: { type: String, default: null, trim: true },   // "Atomic · 1" o null=todas las líneas
  tierFilter: { type: String, enum: ['suave', 'normal', 'activo', null], default: null }, // tier de encuesta o null=todos

  // De dónde salió la campaña — 'manual' (admin la creó a mano) o 'auto-strategy' (generada por la auto-estrategia mensual).
  origin: { type: String, enum: ['manual', 'auto-strategy'], default: 'manual', index: true },
  autoStrategyMonth: { type: String, default: null }, // 'YYYY-MM' si origin='auto-strategy'

  // Categoría del push (afecta el icono/copy default).
  category: { type: String, enum: ['bonos', 'juegos', 'regalos', 'notif'], default: 'notif' },

  // Cuándo se dispara:
  //   dayOfWeek: 0=domingo .. 6=sábado, null=cualquier día
  //   specificDate: si se setea, dispara SOLO ese día (formato YYYY-MM-DD)
  //   startHour/endHour: rango horario dentro del día (0-23)
  dayOfWeek: { type: Number, default: null, min: 0, max: 6 },
  specificDate: { type: String, default: null }, // 'YYYY-MM-DD'
  startHour: { type: Number, required: true, min: 0, max: 23 },
  endHour: { type: Number, required: true, min: 1, max: 24 },

  // Contenido del push.
  title: { type: String, required: true, maxlength: 80 },
  body: { type: String, required: true, maxlength: 200 },

  // Extras opcionales (server crea promo/giveaway scoped por user al disparar).
  extraType: { type: String, enum: ['none', 'promo', 'giveaway'], default: 'none' },

  // Si extraType=promo
  promoCode: { type: String, default: null, maxlength: 40 },
  promoMessage: { type: String, default: null, maxlength: 200 },
  promoDurationHours: { type: Number, default: 6, min: 1, max: 168 },

  // Si extraType=giveaway
  giveawayAmount: { type: Number, default: null, min: 0 },
  giveawayDurationMinutes: { type: Number, default: 360, min: 10, max: 10080 }, // 10min..7d

  // Filtros adicionales sobre el universo del equipo.
  requireApp: { type: Boolean, default: true },          // solo users con fcmToken
  requireSurveyAnswered: { type: Boolean, default: true }, // solo users con notifPreference seteado
  requireActiveDays: { type: Number, default: null, min: 0, max: 365 }, // últimos N días con lastSeenApp

  // Usernames a excluir explícitamente de esta campaña al disparar. Se usa
  // por la auto-estrategia para sacar de los regalos a los "regalo-hunters"
  // detectados (users que reclaman pero no cargan). Snapshot al commit, así
  // queda fija para el mes aunque la actividad del user cambie después.
  excludeUsernames: { type: [String], default: [] },

  // Estado.
  isActive: { type: Boolean, default: false, index: true },
  lastFiredOnDate: { type: String, default: null }, // 'YYYY-MM-DD' del último disparo
  totalFires: { type: Number, default: 0 },
  totalUsersImpactedLastFire: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now },
  createdBy: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: String, default: null }
}, { collection: 'team_campaigns', versionKey: false });

teamCampaignSchema.index({ isActive: 1, dayOfWeek: 1 });

module.exports = mongoose.models['TeamCampaign'] ||
  mongoose.model('TeamCampaign', teamCampaignSchema);
