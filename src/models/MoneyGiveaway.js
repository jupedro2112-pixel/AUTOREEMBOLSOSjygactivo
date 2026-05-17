/**
 * Modelo de Difusión con Regalo de Plata
 *
 * Una "difusión con regalo" es una promo donde el admin le manda push a
 * los usuarios, y los que entran a la app dentro de la ventana de tiempo
 * tocan un botón "Reclamá $X" que les acredita plata directo en JUGAYGANA.
 *
 * Limitado por DOS topes simultaneos:
 *   - totalBudget: cuanta plata maxima estamos dispuestos a regalar.
 *   - maxClaims:   cuantos usuarios maximo pueden reclamar.
 * Cualquiera que se alcance primero cierra la promo (status='closed_*').
 *
 * Tambien tiene expiresAt: pasada esa fecha, la promo no se puede
 * reclamar mas aunque queden slots y plata.
 *
 * Solo puede haber UNA promo activa a la vez por simplicidad. Cuando el
 * admin crea una nueva, las anteriores activas pasan a 'cancelled'.
 */
const mongoose = require('mongoose');

const moneyGiveawaySchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  amount: { type: Number, required: true, min: 1 },         // por persona
  totalBudget: { type: Number, required: true, min: 1 },    // tope global de plata
  maxClaims: { type: Number, required: true, min: 1 },      // tope de personas

  expiresAt: { type: Date, required: true, index: true },
  createdAt: { type: Date, default: Date.now, index: true },
  createdBy: { type: String, default: null },

  prefix: { type: String, default: null, trim: true },

  // Lista de PREFIXES de equipos a EXCLUIR del broadcast. Cuando se setea,
  // el giveaway es "para TODOS los users EXCEPTO los que pertenezcan a
  // estos equipos". Sirve para campañas masivas donde el admin elige a
  // dedo qué equipos NO incluir (ej: "regalo $500 a todos menos al equipo
  // de prueba interno"). Si está vacía o null y NO hay prefix/whitelist,
  // es 100% abierto (sólo si broadcastAll=true para evitar accidentes).
  excludeTeams: { type: [String], default: [] },
  broadcastAll: { type: Boolean, default: false },

  // Mensaje custom que se muestra en el banner del home en la PWA. Si está
  // vacío, se usa el texto default "🎁 RECLAMÁ $X — premio especial". Sirve
  // para que el admin escriba algo concreto tipo "Por tu fidelidad — reclamá
  // $500 ahora 🎁" o lo que quiera. Cap 200 chars.
  customMessage: { type: String, default: '', maxlength: 200 },
  customEmoji: { type: String, default: '🎁', maxlength: 8 },

  // Whitelist EXACTA de usernames habilitados para reclamar este regalo.
  // Si está poblada (length > 0), SOLO esos usernames pueden reclamar —
  // se ignoran prefix y todo el resto de la base. Pensado para regalos
  // sugeridos por el motor de NotificationRule donde la audiencia ya está
  // resuelta server-side (ej: "VIP en riesgo") y el regalo NO debe estar
  // expuesto al resto de la plataforma vía polling de /active.
  // Si está vacía o null, fallback al filtro por prefix (compatibilidad).
  audienceWhitelist: { type: [String], default: null, index: true },

  notificationHistoryId: { type: String, default: null, index: true },

  // Marca el origen del giveaway. Permite que la estrategia automática
  // semanal cancele SOLO sus propios giveaways viejos sin tocar los que
  // creó el admin manualmente.
  //   'auto-strategy' = creado por motor de estrategia (lunes netwin)
  //   'auto-rule'     = creado por aprobación de notification rule
  //   'manual'        = creado por admin desde panel o scheduled notif
  //   null            = legacy (pre-feature, asume manual)
  strategySource: {
    type: String,
    enum: ['auto-strategy', 'auto-rule', 'manual', 'individual_grant', null],
    default: 'manual',
    index: true
  },

  // Si está en true, solo pueden reclamar usuarios con saldo en JUGAYGANA
  // <= 0. El check se hace en el endpoint POST /api/money-giveaway/claim
  // consultando jugaygana.getUserInfoByName(username) antes de acreditar.
  // Si el balance lookup falla (timeout, JUGAYGANA caído), se rechaza por
  // defecto (fail-safe — no regalamos plata sin verificar).
  requireZeroBalance: { type: Boolean, default: false, index: true },

  // Contadores (incrementos atomicos via $inc).
  claimedCount: { type: Number, default: 0 },
  totalGiven: { type: Number, default: 0 },

  // 'active' = sigue abierta.
  // 'closed_expired' = vencio el tiempo.
  // 'closed_budget' = se agoto la plata.
  // 'closed_max' = se llego al maximo de personas.
  // 'cancelled' = el admin la cancelo.
  status: {
    type: String,
    enum: ['active', 'closed_expired', 'closed_budget', 'closed_max', 'cancelled'],
    default: 'active',
    index: true
  }
}, { timestamps: true });

moneyGiveawaySchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.models['MoneyGiveaway'] ||
  mongoose.model('MoneyGiveaway', moneyGiveawaySchema);
