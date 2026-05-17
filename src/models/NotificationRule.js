/**
 * NotificationRule — define cuándo y a quién mandar notificaciones
 * automáticas. Cada fila es una regla que el cron evaluador chequea.
 *
 * Tres tipos de trigger:
 *   - cron: hora ART específica del día/semana/mes (ej: "todos los días
 *     a las 14:00", "lunes 12:00", "día 7 a las 12:00").
 *   - state-change: el usuario pasó de un estado a otro (ej: ACTIVO →
 *     EN_RIESGO). Evaluado contra PlayerStats.
 *   - event: hook disparado desde el código (ej: 'welcome.claimed' +
 *     delay de 24h). Evaluado por el cron mismo basándose en eventos
 *     persistidos.
 *
 * Cada regla declara su audiencia (a quiénes va), su mensaje, y si
 * requiere aprobación humana antes de enviarse (las que regalan plata).
 *
 * El cron corre cada 5 min y para cada regla activa:
 *   1. ¿Tocaba ahora según el trigger? (sino skip)
 *   2. Resolver audiencia.
 *   3. Aplicar cooldown (no mandar 2x al mismo user en X horas).
 *   4. Si requiresAdminApproval: crear NotificationRuleSuggestion
 *      en estado pending para que el admin apruebe con un botón.
 *      Sino: mandar push directo.
 */
const mongoose = require('mongoose');

const notificationRuleSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  // Código humano (B1, B2, A3...) — referencia al "playbook" plasmado.
  code: { type: String, required: true, unique: true, index: true },

  // Display name en el admin.
  name: { type: String, required: true },
  description: { type: String, default: null },

  // Categoría para agrupar en la UI.
  // 'refund' = recordatorios de reembolso (B1-B6)
  // 'welcome' = follow-ups del bono de bienvenida (A3-A5)
  // 'engagement' = positivos para el que juega (C1-C4)
  // 'recovery' = recuperación de inactivos (D1-D3) — todos requieren aprobación
  // 'giveaway' = sugerencias de regalos automáticos (E1-E3) — requieren aprobación
  // 'whatsapp' = listas para agentes humanos (F1-F4) — sin push
  category: {
    type: String,
    enum: ['refund', 'welcome', 'engagement', 'recovery', 'giveaway', 'whatsapp'],
    required: true,
    index: true
  },

  // ¿Está activa esta regla? El admin puede pausarla sin borrarla.
  enabled: { type: Boolean, default: true, index: true },

  // ============= TRIGGER =============
  triggerType: {
    type: String,
    enum: ['cron', 'state-change', 'event'],
    required: true
  },

  // Para triggerType='cron': cuándo debe dispararse.
  // hour/minute en ART (Argentina).
  // dayOfWeek: 0=domingo, 1=lunes, ..., 6=sábado. null = todos los días.
  // dayOfMonth: 1-31. null = todos los días del mes.
  // Combinaciones:
  //   { hour:14, minute:0 } → todos los días a las 14:00 ART
  //   { hour:12, minute:0, dayOfWeek:1 } → lunes 12:00 ART
  //   { hour:18, minute:0, dayOfMonth:14 } → día 14 de cada mes 18:00 ART
  cronSchedule: {
    hour: { type: Number, default: null },
    minute: { type: Number, default: 0 },
    dayOfWeek: { type: Number, default: null },
    dayOfMonth: { type: Number, default: null }
  },

  // Para triggerType='state-change': transición a detectar.
  // Ej: { from: 'ACTIVO', to: 'EN_RIESGO' }
  stateChange: {
    from: { type: String, default: null },
    to: { type: String, default: null }
  },

  // Para triggerType='event': nombre del evento + delay opcional.
  // Ej: { eventName: 'welcome.claimed', delayMinutes: 24*60 }
  // Los eventos los emite el código (server.js) al crearse el hito y
  // se evalúan acá por edad relativa.
  eventTrigger: {
    eventName: { type: String, default: null },
    delayMinutes: { type: Number, default: 0 }
  },

  // ============= AUDIENCIA =============
  // 'has-app-notifs' = todos los con app+notifs (default genérico)
  // 'refund-pending-daily' = los que tienen daily disponible y no reclamaron hoy
  // 'refund-pending-weekly' = idem semanal
  // 'refund-pending-monthly' = idem mensual
  // 'welcome-no-play-since' = reclamaron welcome y no cargaron en X días
  // 'tier-state' = filtro por tier+state (ej VIP+EN_RIESGO)
  // 'state-changed' = los que cambiaron de estado en el último ciclo
  // 'streak' = jugaron N días seguidos
  // 'returned-after' = volvieron tras N días sin jugar
  // 'installed-but-inactive' = instalaron la PWA y no entran (lastLogin) en X horas
  audienceType: {
    type: String,
    enum: [
      'has-app-notifs',
      'refund-pending-daily',
      'refund-pending-weekly',
      'refund-pending-monthly',
      'welcome-no-play-since',
      'tier-state',
      'state-changed',
      'streak',
      'returned-after',
      'installed-but-inactive'
    ],
    required: true
  },

  // Config adicional según audienceType.
  audienceConfig: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },

  // ============= MENSAJE =============
  // Soporta plantillas con {{variable}}: username, amount, days, etc.
  // Ejemplo body: "Hola {{username}}, tu reembolso del 8% de ayer vence en 2 horas"
  title: { type: String, required: true },
  body:  { type: String, required: true },

  // ============= BONUS OPCIONAL =============
  // Si la regla regala plata además del push (giveaway).
  bonus: {
    type: { type: String, enum: ['none', 'giveaway', 'promo'], default: 'none' },
    amount: { type: Number, default: 0 },
    durationMinutes: { type: Number, default: 60 },
    requireZeroBalance: { type: Boolean, default: false },
    promoCode: { type: String, default: null }
  },

  // ============= COMPORTAMIENTO =============
  // Si true → no se manda directo, crea una NotificationRuleSuggestion
  // que el admin tiene que aprobar con un botón. Forzado a true para
  // toda regla con bonus.type !== 'none'.
  requiresAdminApproval: { type: Boolean, default: false },

  // No mandar la misma regla al mismo user dentro de N minutos.
  cooldownMinutes: { type: Number, default: 24 * 60 },

  // Cap global por día (para no spamear si la audiencia es enorme).
  maxFiresPerDay: { type: Number, default: 50000 },

  // ============= STATS =============
  lastEvaluatedAt: { type: Date, default: null },
  lastFiredAt: { type: Date, default: null },
  totalFiresLifetime: { type: Number, default: 0 },
  totalSuggestionsLifetime: { type: Number, default: 0 },

  // ============= AUDIT =============
  createdBy: { type: String, default: null },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

notificationRuleSchema.index({ category: 1, enabled: 1 });

module.exports = mongoose.models['NotificationRule'] ||
  mongoose.model('NotificationRule', notificationRuleSchema);
