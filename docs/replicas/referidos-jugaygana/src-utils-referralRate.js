/**
 * Utilidad: tasa de comisión de referido
 * Retorna la tasa aplicable para un usuario referidor.
 * Por defecto 7%. Preparado para tiers/overrides futuros.
 */

const DEFAULT_REFERRAL_RATE = 0.03; // #169 (owner 2026-09-29): 3% (antes 7%). Editable en panel → COMANDOS.
// Tasa GLOBAL editable desde el panel (Config['referralRate']); server.js la carga al arrancar y
// la refresca cada 60 s (`_loadAiConfigIntoService`). null = usar DEFAULT_REFERRAL_RATE.
let _globalRate = null;
function setGlobalReferralRate(rate) { const n = Number(rate); _globalRate = Number.isFinite(n) && n >= 0 && n <= 1 ? n : null; }
function getGlobalReferralRate() { return _globalRate != null ? _globalRate : DEFAULT_REFERRAL_RATE; }

/**
 * Obtener la tasa de comisión de referido para un usuario
 * @param {Object} user - documento de usuario del referidor
 * @returns {number} tasa decimal (e.g. 0.07)
 */
function getReferralRateForUser(user) {
  if (user && typeof user.referralRateOverride === 'number') {
    return user.referralRateOverride;
  }
  // Futura lógica de tiers:
  // if (user && user.referralTier === 'vip') return 0.10;
  return getGlobalReferralRate();
}

module.exports = {
  DEFAULT_REFERRAL_RATE,
  getReferralRateForUser,
  setGlobalReferralRate,
  getGlobalReferralRate
};
