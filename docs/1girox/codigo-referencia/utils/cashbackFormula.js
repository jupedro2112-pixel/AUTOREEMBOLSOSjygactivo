/**
 * cashbackFormula.js — la FÓRMULA PURA del reembolso acumulativo de por vida
 * (ESPEC-REEMBOLSO-1GIROX.md §3, 2026-09-11). Sin DB ni API: recibe números y
 * devuelve números, así se puede validar en frío contra la tabla de casos de §7
 * (`scripts/test-cashback-formula.js`). `_cashbackStateToday` (server.js) junta
 * los datos y llama a esto.
 *
 *   netoDePorVida = carryNet + liveNet               (§3.4, plegado en tramos)
 *   regalado      = max(localViejo, grantedViejo)
 *                 + max(localVivo,  grantedVivo)     (§3.3, tramo a tramo)
 *   pérdidaReal   = max(0, netoDePorVida − regalado)
 *   reclamable    = floor(pct% × pérdidaReal − cobrado)
 *   reclamable    = min(reclamable, topeDiario − cobradoHoy)
 *   belowMin      = 0 < reclamable < mínimo
 *
 * `cobrado` incluye los reclamos pending + credited (§4.2). Lo cobrado ADEMÁS
 * viene dentro de `localVivo/localViejo` como regalo (§3.2): si el jugador
 * pierde el reembolso, neto y regalado suben lo mismo y se cancelan.
 */

const DAY_MS = 86400000;
/** Cuando el tramo vivo supera esto se pliega (< 92 días, tope de la API). */
const FOLD_AFTER_DAYS = 85;
/** Cuánto se consolida por plegado. */
const FOLD_CHUNK_DAYS = 60;

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * @param {object} p
 * @param {number} p.carryNet          neto consolidado de tramos viejos (puede ser negativo)
 * @param {number} p.liveNet           netwin casino del tramo vivo (ancla → hoy)
 * @param {number} p.carryGranted      bonus.granted de los tramos plegados
 * @param {number} p.liveGranted       bonus.granted del tramo vivo
 * @param {number} p.giftedLocalBefore regalos locales con timestamp < ancla
 * @param {number} p.giftedLocalLive   regalos locales con timestamp ≥ ancla
 * @param {number} p.paidLife          cashback cobrado de por vida (pending + credited)
 * @param {number} p.paidToday         cashback cobrado hoy (para el tope diario)
 * @param {number} p.pct               % del reembolso
 * @param {number} [p.maxDailyArs]     tope por día por jugador (0 = sin tope)
 * @param {number} [p.minArs]          mínimo para reclamar (0 = sin mínimo)
 */
function computeCashback(p) {
  const carryNet = n(p.carryNet), liveNet = n(p.liveNet);
  const carryGranted = n(p.carryGranted), liveGranted = n(p.liveGranted);
  const giftedLocalBefore = n(p.giftedLocalBefore), giftedLocalLive = n(p.giftedLocalLive);
  const paidLife = n(p.paidLife), paidToday = n(p.paidToday);
  const pct = n(p.pct), maxDailyArs = n(p.maxDailyArs), minArs = n(p.minArs);

  const lifeNet = carryNet + liveNet;
  const giftedLocal = giftedLocalBefore + giftedLocalLive;
  const giftedPlatform = carryGranted + liveGranted;
  const giftedLife = Math.max(giftedLocalBefore, carryGranted) + Math.max(giftedLocalLive, liveGranted);
  const lossLife = Math.max(0, lifeNet - giftedLife);

  let reclamable = Math.floor(Math.max(0, (pct / 100) * lossLife - paidLife));
  if (maxDailyArs > 0) reclamable = Math.min(reclamable, Math.max(0, maxDailyArs - paidToday));

  return {
    lifeNet, giftedLocal, giftedPlatform, giftedLife, lossLife,
    paidLife, paidToday, reclamable,
    belowMin: reclamable > 0 && reclamable < minArs
  };
}

/**
 * Plan de plegado (§3.4): dado el ancla y "hoy", devuelve el próximo tramo a
 * consolidar o null si el tramo vivo todavía entra en una consulta.
 * @returns {{from: Date, to: Date, nextAnchor: Date} | null}
 */
function nextFold(anchorAt, now) {
  const anchor = new Date(anchorAt);
  const today = new Date(now);
  if ((today.getTime() - anchor.getTime()) / DAY_MS <= FOLD_AFTER_DAYS) return null;
  const nextAnchor = new Date(anchor.getTime() + FOLD_CHUNK_DAYS * DAY_MS);
  // Intervalo semiabierto [ancla, ancla+60d): hasta 1 segundo antes del ancla
  // nueva (la API evalúa el rango con precisión de segundos) — ni se solapa con
  // el tramo vivo ni deja un día sin contar.
  const to = new Date(nextAnchor.getTime() - 1000);
  return { from: anchor, to, nextAnchor };
}

module.exports = { computeCashback, nextFold, FOLD_AFTER_DAYS, FOLD_CHUNK_DAYS };
