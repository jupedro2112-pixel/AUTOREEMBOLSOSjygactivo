/**
 * Configuración de la estrategia semanal de notificaciones.
 *
 * Es un documento singleton (siempre id='main'). Guarda TODOS los
 * parámetros que el admin puede tocar cada miércoles para ajustar la
 * próxima semana sin tocar código.
 *
 * Dos campañas automáticas:
 *   - netwinGift: lunes — regalo de plata a perdedores de la semana
 *     anterior, segmentado por rango de pérdida.
 *   - tierBonus: jueves — bono % en próxima carga, segmentado por
 *     volumen acumulado de reembolsos en los últimos N días.
 *
 * Cinturones de seguridad:
 *   - weeklyBudgetCapARS: tope máximo de plata regalada por semana.
 *     Si el cómputo de audiencia supera el cap, frena y crea un
 *     WeeklyStrategyReport con status 'budget-exceeded' para que el
 *     admin lo revise antes de soltarlo.
 *   - capPerUserPerWeek: máximo de notifs automáticas que recibe el
 *     mismo usuario en una semana (ISO week). Cuenta separado del
 *     historial general — solo notifs de esta estrategia.
 *   - cooldownHours: tiempo mínimo entre 2 notifs de la estrategia
 *     al mismo usuario.
 *   - pausedUntil: si está seteado y > now, ningún cron de la
 *     estrategia ejecuta.
 *   - emergencyStop: kill switch global. Si true, todo frena.
 */
const mongoose = require('mongoose');

const tierLossRangeSchema = new mongoose.Schema({
  minLoss: { type: Number, required: true },   // pérdida ARS mínima del rango (inclusive)
  maxLoss: { type: Number, required: true },   // pérdida ARS máxima (inclusive)
  giftAmount: { type: Number, required: true } // cuánto regalar en ARS
}, { _id: false });

const tierBonusBucketSchema = new mongoose.Schema({
  code: { type: String, required: true },          // 'oro' | 'plata' | 'bronce'
  label: { type: String, required: true },         // display
  // Filtro: el usuario tiene que cumplir AMBAS — percentil mínimo Y
  // monto absoluto mínimo de reembolsos. Esto evita que cuando hay
  // poca data el "top 5%" sea gente que solo reclamó 200 pesos.
  minPercentile: { type: Number, required: true }, // 0-100
  minRefundsARS: { type: Number, required: true }, // piso absoluto
  bonusPct: { type: Number, required: true }       // % de bono
}, { _id: false });

const weeklyStrategyConfigSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true, default: 'main' },

  // Master switch. Si false, nada de la estrategia se ejecuta.
  enabled: { type: Boolean, default: true },

  // Pausa hasta cierta fecha (ej: "frená 1 semana mientras pruebo otra cosa").
  // Si > now, nada se ejecuta.
  pausedUntil: { type: Date, default: null },

  // Kill switch instantáneo. Más fuerte que pausedUntil.
  emergencyStop: { type: Boolean, default: false },

  // Tope global de plata regalada por semana (ARS). Si la audiencia
  // computada supera este número, no se manda — se loguea y se notifica
  // al admin para revisar.
  weeklyBudgetCapARS: { type: Number, default: 500000 },

  // Cap de notifs automáticas por usuario por semana (ISO).
  capPerUserPerWeek: { type: Number, default: 2 },

  // Cooldown mínimo entre 2 notifs al mismo usuario (en horas).
  cooldownHours: { type: Number, default: 48 },

  // ============= CAMPAÑA 1: REGALO NETWIN (LUNES) =============
  netwinGift: {
    enabled: { type: Boolean, default: true },
    dayOfWeek: { type: Number, default: 1 },  // 0=Dom, 1=Lun ... 6=Sab
    hour: { type: Number, default: 11 },      // ART
    minute: { type: Number, default: 0 },

    // Rangos de pérdida → monto a regalar.
    tiers: {
      type: [tierLossRangeSchema],
      default: () => ([
        { minLoss: 200000, maxLoss: 500000, giftAmount: 20000 },
        { minLoss: 100000, maxLoss: 200000, giftAmount: 20000 },
        { minLoss: 50000,  maxLoss: 100000, giftAmount: 5000  },
        { minLoss: 20000,  maxLoss: 50000,  giftAmount: 2000  }
      ])
    },

    // Pérdidas mayores a esto NO se autoejecutan — van a la cola
    // manual del admin. Es el "freno por whales": si alguien perdió
    // 800k pedimos ojo humano antes de regalarle.
    escalateAboveARS: { type: Number, default: 500000 },

    // Plantilla de mensaje. Soporta {{username}}, {{amount}}, {{loss}}.
    title: { type: String, default: '🎁 Tenemos un regalo para vos' },
    body: { type: String, default: 'Hola {{username}}! Por tu actividad de la semana te regalamos ${{amount}} para que sigas jugando. Tocá para reclamarlo.' },

    // El regalo expira en X minutos.
    durationMinutes: { type: Number, default: 60 * 48 } // 48h
  },

  // ============= CAMPAÑA 2: BONO % CARGA (JUEVES) =============
  tierBonus: {
    enabled: { type: Boolean, default: true },
    dayOfWeek: { type: Number, default: 4 },  // jueves
    hour: { type: Number, default: 18 },      // ART
    minute: { type: Number, default: 0 },

    // Ventana sobre la cual se computa "monto de reembolsos" del usuario.
    refundsLookbackDays: { type: Number, default: 30 },

    // Buckets de tier — orden de mejor a peor. El motor asigna a cada
    // usuario el PRIMER bucket donde matchea (Oro antes que Plata, etc).
    tiers: {
      type: [tierBonusBucketSchema],
      default: () => ([
        { code: 'oro',    label: '🥇 VIP Oro', minPercentile: 95, minRefundsARS: 30000, bonusPct: 100 },
        { code: 'plata',  label: '🥈 Plata',   minPercentile: 80, minRefundsARS: 10000, bonusPct: 50  },
        { code: 'bronce', label: '🥉 Bronce',  minPercentile: 50, minRefundsARS: 3000,  bonusPct: 20  }
      ])
    },

    // Plantilla. Soporta {{username}}, {{tier}}, {{bonusPct}}, {{validHours}}.
    title: { type: String, default: '⚡ Tu bono {{tier}} está listo' },
    body: { type: String, default: 'Hola {{username}}! Cargá ahora y te damos {{bonusPct}}% extra. Válido por {{validHours}}h. Tocá para activar.' },

    // La promo activada por este push dura X horas. El usuario tiene
    // ese tiempo para cargar y aprovechar el bono.
    promoDurationHours: { type: Number, default: 48 }
  },

  // ============= REPORTE MIÉRCOLES =============
  weeklyReport: {
    enabled: { type: Boolean, default: true },
    dayOfWeek: { type: Number, default: 3 },  // miércoles
    hour: { type: Number, default: 9 },       // ART
    minute: { type: Number, default: 0 }
  },

  // ============= STATS DE EJECUCIÓN =============
  // Para que el cron sepa que ya disparó esta semana y no duplique.
  // weekKey formato ISO: '2026-W18'.
  lastNetwinFireWeek: { type: String, default: null },
  lastNetwinFireAt: { type: Date, default: null },
  lastTierBonusFireWeek: { type: String, default: null },
  lastTierBonusFireAt: { type: Date, default: null },
  lastReportWeek: { type: String, default: null },
  lastReportAt: { type: Date, default: null },

  // Contadores históricos.
  totalSpentARS: { type: Number, default: 0 },
  totalNotifsSent: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.models['WeeklyStrategyConfig'] ||
  mongoose.model('WeeklyStrategyConfig', weeklyStrategyConfigSchema);
