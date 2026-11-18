/**
 * bonusRollover.js — ROLLOVER GLOBAL de bonos (ESPEC-ROLLOVER-GLOBAL-Y-MULTICUENTA-
 * TITULAR.md §A, 2026-09-16). Parte PURA: sin DB ni API, para poder validarla en
 * frío (`scripts/test-rollover-multicuenta.js`). `getGlobalBonusRollover` (server.js)
 * lee Config['bonusRolloverGlobal'] + bonus.multipliers de 1girox y llama a esto.
 *
 * Regla: x elegido en el panel ∈ OPTIONS; si la plataforma NO lo permite
 * (bonus.multipliers de la cuenta), se usa el permitido MÁS CERCANO HACIA ARRIBA
 * (o el máximo permitido) y `snapped` avisa. Sin la validación 1girox rechaza el
 * bono con `invalid_multiplier`.
 */
const BONUS_ROLLOVER_OPTIONS = [0, 2, 3, 5, 10];
const BONUS_ROLLOVER_DEFAULT = { enabled: true, x: 3 };

/** Normaliza la lista de multiplicadores de bono de la plataforma (o null). */
function normalizeAllowed(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const list = raw.map(Number).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  return list.length ? Array.from(new Set(list)) : null;
}

/**
 * @param {object|null} rawCfg  Config['bonusRolloverGlobal'] = { enabled, x } (o null)
 * @param {number[]|null} allowedRaw  bonus.multipliers de GET /config (o null si no hay)
 * @returns {{enabled, x, effective, allowed, snapped, options}}
 */
function resolveGlobalRollover(rawCfg, allowedRaw) {
  let enabled = BONUS_ROLLOVER_DEFAULT.enabled, x = BONUS_ROLLOVER_DEFAULT.x;
  if (rawCfg && typeof rawCfg === 'object') {
    enabled = rawCfg.enabled !== false;
    const n = Math.round(Number(rawCfg.x));
    if (BONUS_ROLLOVER_OPTIONS.includes(n)) x = n;
  }
  const allowed = normalizeAllowed(allowedRaw);
  let effective = x;
  if (allowed && !allowed.includes(x)) {
    const up = allowed.find((n) => n > x);
    effective = up != null ? up : allowed[allowed.length - 1];
  }
  return { enabled, x, effective, allowed, snapped: effective !== x, options: BONUS_ROLLOVER_OPTIONS.slice() };
}

/** Rollover a usar en un flujo: el GLOBAL si está encendido, si no el propio del flujo. */
function pickRollover(global, flowValue) {
  if (global && global.enabled) return global.effective;
  return Math.max(0, Math.round(Number(flowValue) || 0));
}

module.exports = { BONUS_ROLLOVER_OPTIONS, BONUS_ROLLOVER_DEFAULT, normalizeAllowed, resolveGlobalRollover, pickRollover };
