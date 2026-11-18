/**
 * vipLevels.js — Niveles VIP por APOSTADO ACUMULADO (réplica del programa de Stake).
 *
 * REGLA DE NEGOCIO (owner, 2026-08-03):
 *
 *   Se progresa por el TOTAL APOSTADO DE POR VIDA en el casino (wagered de la
 *   Partner API), NO por pérdidas ni por depósitos. Cada apuesta suma, gane o
 *   pierda. El nivel NUNCA baja ni se resetea.
 *
 *   Los umbrales son los de Stake (en USD) convertidos a PESOS ARGENTINOS a la
 *   tasa fija de $1.500 por dólar (decisión del owner, 2026-08-03; se puede
 *   pisar con la env VIP_USD_ARS_RATE sin tocar código).
 *
 * ⚠️ NO CONFUNDIR con los rangos de reembolso (src/utils/refundTiers.js): esos son
 * Bronce/Plata/Oro POR PERÍODO sobre la pérdida, y se resetean en cada reclamo.
 * Estos niveles son PERMANENTES y por apostado. En la UI los reembolsos muestran
 * sólo el % (3/6/10) justamente para que los nombres de rango queden exclusivos
 * del nivel VIP y el cliente no crea que "bajó de categoría".
 *
 * Qué destraba cada nivel:
 *   - Bono one-time al alcanzarlo (levelUpBonusArs) — lo acredita el motor de
 *     sincronización con reference idempotente `vip-lvl-{userId}-{idx}`, así es
 *     IMPOSIBLE pagarlo dos veces aunque el cron corra en N instancias.
 *   - Rakeback semanal (rakebackPct % del apostado de casino de la semana pasada,
 *     gane o pierda) — se reclama con un botón, como los reembolsos.
 *
 * Sostenibilidad: el bono de nivel es ~0,07% del apostado del umbral (el mismo
 * ratio que usa Stake) y el rakeback 0,10–0,65% del apostado semanal — muy por
 * debajo de la ventaja de la casa (~3%+). No se regala más de lo que el volumen
 * ya dejó.
 */

// Tasa de conversión USD→ARS de los umbrales. Override por env (VIP_USD_ARS_RATE).
const DEFAULT_USD_ARS_RATE = 1500;

function _rate() {
  const r = Number(process.env.VIP_USD_ARS_RATE);
  return Number.isFinite(r) && r > 0 ? r : DEFAULT_USD_ARS_RATE;
}

/**
 * La escalera, de menor a mayor. `usd` es el umbral original de Stake; el umbral
 * real en pesos es `usd × tasa` (ver thresholdArs en listLevels).
 * `levelUpBonusArs` y `rakebackPct` son directamente en ARS / % — editables acá.
 *
 * idx es 1-based; 0 = sin nivel todavía. ⚠️ NO reordenar ni insertar niveles en el
 * medio: el idx se persiste en User.vipLevel y en las references de los bonos
 * (`vip-lvl-{userId}-{idx}`) — cambiarlo pagaría bonos de nuevo o salteados.
 */
const VIP_LEVELS = [
  { idx: 1,  key: 'bronce',       name: 'Bronce',       emoji: '🥉', color: '#cd7f32', usd: 10000,     levelUpBonusArs: 10000,     rakebackPct: 0.10 },
  { idx: 2,  key: 'plata',        name: 'Plata',        emoji: '🥈', color: '#c0c0c0', usd: 50000,     levelUpBonusArs: 50000,     rakebackPct: 0.12 },
  { idx: 3,  key: 'oro',          name: 'Oro',          emoji: '🥇', color: '#ffd700', usd: 100000,    levelUpBonusArs: 100000,    rakebackPct: 0.15 },
  { idx: 4,  key: 'platino1',     name: 'Platino I',    emoji: '💠', color: '#7fd4e0', usd: 250000,    levelUpBonusArs: 250000,    rakebackPct: 0.20 },
  { idx: 5,  key: 'platino2',     name: 'Platino II',   emoji: '💠', color: '#7fd4e0', usd: 500000,    levelUpBonusArs: 500000,    rakebackPct: 0.22 },
  { idx: 6,  key: 'platino3',     name: 'Platino III',  emoji: '💠', color: '#7fd4e0', usd: 1000000,   levelUpBonusArs: 1000000,   rakebackPct: 0.25 },
  { idx: 7,  key: 'platino4',     name: 'Platino IV',   emoji: '💠', color: '#7fd4e0', usd: 2500000,   levelUpBonusArs: 2500000,   rakebackPct: 0.30 },
  { idx: 8,  key: 'platino5',     name: 'Platino V',    emoji: '💠', color: '#7fd4e0', usd: 5000000,   levelUpBonusArs: 5000000,   rakebackPct: 0.35 },
  { idx: 9,  key: 'platino6',     name: 'Platino VI',   emoji: '💠', color: '#7fd4e0', usd: 10000000,  levelUpBonusArs: 10000000,  rakebackPct: 0.40 },
  { idx: 10, key: 'diamante1',    name: 'Diamante I',   emoji: '💎', color: '#b9f2ff', usd: 25000000,  levelUpBonusArs: 25000000,  rakebackPct: 0.45 },
  { idx: 11, key: 'diamante2',    name: 'Diamante II',  emoji: '💎', color: '#b9f2ff', usd: 50000000,  levelUpBonusArs: 50000000,  rakebackPct: 0.50 },
  { idx: 12, key: 'diamante3',    name: 'Diamante III', emoji: '💎', color: '#b9f2ff', usd: 100000000, levelUpBonusArs: 100000000, rakebackPct: 0.55 },
  { idx: 13, key: 'diamante4',    name: 'Diamante IV',  emoji: '💎', color: '#b9f2ff', usd: 250000000, levelUpBonusArs: 250000000, rakebackPct: 0.60 },
  { idx: 14, key: 'diamante5',    name: 'Diamante V',   emoji: '💎', color: '#b9f2ff', usd: 500000000, levelUpBonusArs: 500000000, rakebackPct: 0.65 }
];

/** Un nivel con su umbral ya convertido a pesos. */
function _withArs(level) {
  return { ...level, thresholdArs: level.usd * _rate() };
}

/** La escalera completa con umbrales en ARS (para la UI y el motor). */
function listLevels() {
  return VIP_LEVELS.map(_withArs);
}

/** Nivel por idx (1-based). null si no existe (idx 0 = sin nivel). */
function getLevel(idx) {
  const i = Number(idx) || 0;
  if (i < 1 || i > VIP_LEVELS.length) return null;
  return _withArs(VIP_LEVELS[i - 1]);
}

/**
 * Nivel que corresponde a un apostado acumulado.
 *
 * @param {number} lifetimeWagered - apostado acumulado en pesos
 * @returns {{levelIndex, level|null, next|null, faltaParaSubir|null, progressPct}}
 *   levelIndex 0 = todavía sin nivel. progressPct es el avance (0-100) dentro del
 *   tramo actual (del umbral del nivel actual al del siguiente), para la barrita.
 */
function getVipLevel(lifetimeWagered) {
  const wagered = Math.max(0, Number(lifetimeWagered) || 0);
  const levels = listLevels();

  let levelIndex = 0;
  for (const l of levels) {
    if (wagered >= l.thresholdArs) levelIndex = l.idx;
    else break;
  }

  const level = levelIndex > 0 ? levels[levelIndex - 1] : null;
  const next = levelIndex < levels.length ? levels[levelIndex] : null;

  let progressPct = 100;
  let faltaParaSubir = null;
  if (next) {
    const base = level ? level.thresholdArs : 0;
    const span = next.thresholdArs - base;
    progressPct = span > 0 ? Math.min(100, Math.max(0, ((wagered - base) / span) * 100)) : 0;
    faltaParaSubir = Math.max(0, next.thresholdArs - wagered);
  }

  return { levelIndex, level, next, faltaParaSubir, progressPct };
}

/** % de rakeback semanal para un nivel (0 si todavía no tiene nivel). */
function getRakebackPct(levelIndex) {
  const l = getLevel(levelIndex);
  return l ? l.rakebackPct : 0;
}

module.exports = {
  VIP_LEVELS,
  listLevels,
  getLevel,
  getVipLevel,
  getRakebackPct
};
