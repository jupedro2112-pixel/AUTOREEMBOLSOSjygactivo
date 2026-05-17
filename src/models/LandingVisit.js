/**
 * LandingVisit — registro de cada visita a una landing de campaña.
 *
 * Casos de uso:
 *   - El admin arma una campaña (ej: postear el link en Facebook). Manda gente
 *     a /promo2k. Cada vez que alguien carga la pagina, se inserta un row.
 *   - El panel admin lo lee para mostrar contador (totales, unicos por IP-hash,
 *     ultimas 24h, ultima semana, breakdown por dia).
 *
 * Privacidad:
 *   - NUNCA guardamos la IP en plano. La hasheamos con un salt fijo
 *     (LANDING_IP_SALT, env var) + sha256. Asi podemos contar unicos
 *     sin exponer datos personales.
 *   - El userAgent va truncado a 200 chars.
 *
 * Indices:
 *   - code + at -> queries de "ultimas N visitas a /promo2k" y group-by-day.
 *   - ipHash -> count distinct para "visitantes unicos".
 */
const mongoose = require('mongoose');

const landingVisitSchema = new mongoose.Schema({
  // Codigo de la campaña/landing. Para /promo2k el codigo es 'promo2k'.
  // Slug-style (lowercase, alfanumerico). Lo controla el caller.
  code: { type: String, required: true, index: true, lowercase: true, trim: true, maxlength: 60 },

  // sha256(IP + LANDING_IP_SALT). Ver _hashIp en server.js.
  ipHash: { type: String, default: null, index: true, maxlength: 64 },

  // User-agent del browser (truncado, sirve para distinguir mobile vs desktop).
  userAgent: { type: String, default: null, maxlength: 200 },

  // Referer (de donde vino), si lo expone el browser.
  referer: { type: String, default: null, maxlength: 200 },

  // Si el visitante esta logueado, lo registramos (lowercased). Si no, null.
  username: { type: String, default: null, index: true, lowercase: true, trim: true, maxlength: 80 },

  at: { type: Date, default: Date.now, index: true, immutable: true }
}, { timestamps: true });

// Para "visitas a /promo2k de las ultimas 24h ordenadas por fecha".
landingVisitSchema.index({ code: 1, at: -1 });

module.exports = mongoose.models['LandingVisit'] ||
  mongoose.model('LandingVisit', landingVisitSchema);
