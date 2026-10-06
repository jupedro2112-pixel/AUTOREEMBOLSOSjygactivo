/**
 * referralTierService — NIVELES de comisión de referidos (#171, owner 2026-09-29).
 *
 * Reemplaza los premios en plata por cantidad de referidos (#168: 3 → $10.000, etc.), que
 * eran estafables (3 cuentas × $3.000 = $9.000 puestos → $10.000 retirables). Ahora la
 * cantidad de referidos ACTIVOS define el % de comisión sobre el netwin (pérdida neta):
 *
 *   referidos activos < 3  → basePct (0% por defecto)
 *   3 referidos activos    → 1%
 *   5                      → 2%
 *   10                     → 3%  (máximo)
 *
 * Todo editable desde el panel (COMANDOS → "Niveles de comisión por referidos"), en
 * `Config['referralMilestones']` = { enabled, minChargedARS, basePct, tiers:[{count, pct}] }.
 * "Referido activo" = referido con cargas reales acumuladas ≥ `minChargedARS` (Transaction
 * deposit completed, sin regalos/bonos). Sin netwin no hay comisión → una cuenta falsa que
 * carga y retira no genera nada.
 *
 * Prioridad de la tasa (resolveReferralRate): override por usuario > niveles (si enabled)
 * > tasa global plana (`Config['referralRate']`, #169). Los callers de plata
 * (referralCalculationService) tienen que usar ESTE resolver, no getReferralRateForUser
 * (que es sync y sólo conoce la global).
 */
const Config = require('../models/Config');
const { Transaction, User } = require('../models');
const { getGlobalReferralRate } = require('../utils/referralRate');

const CONFIG_KEY = 'referralMilestones';
const DEFAULTS = { enabled: true, minChargedARS: 3000, basePct: 0, tiers: [{ count: 3, pct: 1 }, { count: 5, pct: 2 }, { count: 10, pct: 3 }] };
// Fuentes de Transaction deposit que NO son plata del cliente (regalos, bonos, reembolsos).
const NON_BANK_SOURCES = ['install_bonus', 'welcome_gift', 'payout_refund', 'notif_batch', 'notif_batch_auto', 'auto_hgcash_bonus'];

let _cache = { at: 0, cfg: null };
const CACHE_MS = 60 * 1000;

function normalizeTiers(raw) {
  const tiers = (Array.isArray(raw) ? raw : [])
    .map(t => ({ count: Math.round(Number(t && t.count) || 0), pct: Math.round((Number(t && t.pct) || 0) * 100) / 100 }))
    .filter(t => t.count > 0 && t.pct > 0 && t.pct <= 50)
    .sort((a, b) => a.count - b.count);
  const seen = new Set();
  return tiers.filter(t => { if (seen.has(t.count)) return false; seen.add(t.count); return true; });
}

function normalizeConfig(c) {
  c = c || {};
  // Formato viejo (#168: tiers con amountARS y sin pct) → se ignora y se usan los defaults.
  const hasNew = Array.isArray(c.tiers) && c.tiers.some(t => t && Number(t.pct) > 0);
  const tiers = hasNew ? normalizeTiers(c.tiers) : DEFAULTS.tiers.slice();
  const basePct = Number(c.basePct);
  return {
    enabled: c.enabled !== false,
    minChargedARS: Number(c.minChargedARS) >= 0 ? Math.round(Number(c.minChargedARS)) : DEFAULTS.minChargedARS,
    basePct: Number.isFinite(basePct) && basePct >= 0 && basePct <= 50 ? Math.round(basePct * 100) / 100 : DEFAULTS.basePct,
    tiers: tiers.length ? tiers : DEFAULTS.tiers.slice()
  };
}

async function getReferralTiersConfig({ force = false } = {}) {
  if (!force && _cache.cfg && Date.now() - _cache.at < CACHE_MS) return _cache.cfg;
  let cfg;
  try {
    const doc = await Config.findOne({ key: CONFIG_KEY }).lean();
    cfg = normalizeConfig(doc ? doc.value : null);
  } catch (_) { cfg = normalizeConfig(null); }
  _cache = { at: Date.now(), cfg };
  return cfg;
}
function invalidateCache() { _cache = { at: 0, cfg: null }; }

/** Cargas reales acumuladas por referido del referidor → Map(userId → { total, count, last }). */
async function depositsByReferred(referrerId) {
  const refs = await User.find({ referredByUserId: referrerId }).select('id').lean();
  const ids = refs.map(r => r.id);
  if (!ids.length) return new Map();
  const agg = await Transaction.aggregate([
    { $match: { userId: { $in: ids }, type: 'deposit', status: 'completed', 'metadata.source': { $nin: NON_BANK_SOURCES } } },
    { $group: { _id: '$userId', total: { $sum: '$amount' }, count: { $sum: 1 }, last: { $max: '$timestamp' } } }
  ]);
  return new Map(agg.map(a => [a._id, { total: Number(a.total) || 0, count: a.count, last: a.last }]));
}

async function countActiveReferrals(referrerId, minChargedARS) {
  const by = await depositsByReferred(referrerId);
  let n = 0;
  for (const v of by.values()) if (v.total >= minChargedARS) n++;
  return n;
}

/** Nivel que corresponde a `active` referidos activos. */
function levelForCount(cfg, active) {
  let tier = null;
  for (const t of cfg.tiers) if (active >= t.count) tier = t;
  const nextTier = cfg.tiers.find(t => active < t.count) || null;
  const pct = tier ? tier.pct : cfg.basePct;
  return { pct, rate: pct / 100, tier, nextTier, missing: nextTier ? nextTier.count - active : 0 };
}

function maxPct(cfg) { return cfg.tiers.length ? cfg.tiers[cfg.tiers.length - 1].pct : cfg.basePct; }

/**
 * Tasa efectiva del referidor.
 * @returns {{ rate:number, pct:number, mode:'override'|'tiers'|'flat', active:number, tier, nextTier, missing:number, maxPct:number, cfg }}
 */
async function resolveReferralRate(user, { activeCount = null } = {}) {
  const cfg = await getReferralTiersConfig();
  const base = { cfg, maxPct: cfg.enabled ? maxPct(cfg) : Math.round(getGlobalReferralRate() * 10000) / 100 };
  if (user && typeof user.referralRateOverride === 'number') {
    return Object.assign(base, { rate: user.referralRateOverride, pct: Math.round(user.referralRateOverride * 10000) / 100, mode: 'override', active: null, tier: null, nextTier: null, missing: 0 });
  }
  if (!cfg.enabled) {
    const rate = getGlobalReferralRate();
    return Object.assign(base, { rate, pct: Math.round(rate * 10000) / 100, mode: 'flat', active: null, tier: null, nextTier: null, missing: 0 });
  }
  const active = activeCount != null ? activeCount : (user && user.id ? await countActiveReferrals(user.id, cfg.minChargedARS) : 0);
  const lv = levelForCount(cfg, active);
  return Object.assign(base, { rate: lv.rate, pct: lv.pct, mode: 'tiers', active, tier: lv.tier, nextTier: lv.nextTier, missing: lv.missing });
}

module.exports = {
  DEFAULTS, NON_BANK_SOURCES, CONFIG_KEY,
  getReferralTiersConfig, invalidateCache, normalizeConfig, normalizeTiers,
  depositsByReferred, countActiveReferrals, levelForCount, maxPct, resolveReferralRate
};
