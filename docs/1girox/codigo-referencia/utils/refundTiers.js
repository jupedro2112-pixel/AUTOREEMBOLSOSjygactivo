/**
 * refundTiers.js — Rangos de reembolso (% según la pérdida del período).
 *
 * REGLA DE NEGOCIO (owner, 2026-07-31; configurable desde el panel 2026-08-05):
 *
 * Desde 2026-08-05 los rangos son EDITABLES DESDE EL PANEL y cada período
 * (diario / semanal / mensual) tiene su PROPIA escalera — pueden ser distintas
 * entre sí (pedido del owner). La config vive en Config['refundTiersByPeriod']
 * con la forma { daily: [...], weekly: [...], monthly: [...] } donde cada tier
 * es { name, pct, max } (max null = sin techo, el último). Si no hay config
 * guardada (o es inválida), rige DEFAULT_TIERS (la tabla histórica):
 *
 *   Pérdida del período        Rango    Reembolso
 *   ─────────────────────      ──────   ─────────
 *   hasta $30.000              Bronce      3%
 *   $30.001 a $100.000         Plata       6%
 *   más de $100.000            Oro        10%
 *
 * ⚠️ EL RANGO SE CALCULA SOBRE LA PÉRDIDA DEL PERÍODO QUE SE RECLAMA, no sobre un
 * acumulado histórico (decisión del owner). O sea: cada reembolso mira su propio
 * período. Si esta semana perdió $120.000, ESE reembolso se paga al % del tope,
 * aunque el mes pasado hubiera sido el rango más bajo. No hay medalla permanente
 * ni progreso que se arrastre entre períodos.
 *
 * Consecuencia práctica: un mismo jugador puede estar en el tope del mensual y en
 * el rango más bajo del diario al mismo tiempo, porque son períodos distintos con
 * pérdidas distintas. La UI muestra el rango POR REEMBOLSO, no uno solo.
 *
 * Los umbrales son en PESOS y se comparan contra el netwin (apostado − ganado) que
 * devuelve la plataforma para ese rango de fechas.
 */

/** Estética por posición del escalón (el admin edita nombre/umbral/%, no colores). */
const TIER_STYLES = [
  { emoji: '🥉', color: '#cd7f32' },
  { emoji: '🥈', color: '#c0c0c0' },
  { emoji: '🥇', color: '#ffd700' },
  { emoji: '💠', color: '#7fd7ff' },
  { emoji: '💎', color: '#b9f2ff' },
  { emoji: '👑', color: '#ff9de2' }
];
const MAX_TIERS = TIER_STYLES.length;

/**
 * Escalera default (la histórica), de menor a mayor. `max: null` = sin techo.
 * Es la que rige cuando el panel nunca guardó una config (o quedó inválida).
 */
const DEFAULT_TIERS = normalizeTiers([
  { name: 'Bronce', pct: 3, max: 30000 },
  { name: 'Plata', pct: 6, max: 100000 },
  { name: 'Oro', pct: 10, max: null }
]);

/**
 * Normaliza y VALIDA una escalera cruda (del panel o de la config guardada).
 * Devuelve los tiers completos (con key/emoji/color/min derivados) o TIRA un
 * Error con mensaje en castellano para mostrarle al admin.
 *
 * Reglas: 1 a 6 escalones; % entre 0 y 100 (hasta 1 decimal); umbrales `max`
 * enteros > 0 ESTRICTAMENTE crecientes; el último (y solo el último) sin techo.
 * Se ordena solo por `max` (nulls al final), así el panel no depende del orden.
 */
function normalizeTiers(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('La escalera tiene que tener al menos 1 rango.');
  }
  if (raw.length > MAX_TIERS) {
    throw new Error(`Máximo ${MAX_TIERS} rangos por escalera.`);
  }

  const tiers = raw.map((t, i) => {
    const name = String((t && t.name) || '').trim().slice(0, 20) || `Rango ${i + 1}`;
    const pct = Math.round(Number(t && t.pct) * 10) / 10;
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new Error(`El % de "${name}" tiene que ser un número entre 0 y 100.`);
    }
    let max = t && t.max;
    if (max === null || max === undefined || max === '') {
      max = null;
    } else {
      max = Math.round(Number(max));
      if (!Number.isFinite(max) || max <= 0) {
        throw new Error(`El umbral "hasta $" de "${name}" tiene que ser un número mayor a 0 (o vacío en el último rango).`);
      }
    }
    return { name, pct, max };
  });

  // Orden por umbral, sin techo al final.
  tiers.sort((a, b) => {
    if (a.max === null) return 1;
    if (b.max === null) return -1;
    return a.max - b.max;
  });

  const sinTecho = tiers.filter((t) => t.max === null).length;
  if (sinTecho > 1) {
    throw new Error('Solo el ÚLTIMO rango puede quedar sin techo ("más de $X"). Dejá un solo "hasta $" vacío.');
  }
  if (sinTecho === 0) {
    // El último siempre cubre "más de X": si el admin le puso techo, se lo sacamos.
    tiers[tiers.length - 1].max = null;
  }
  for (let i = 1; i < tiers.length; i++) {
    const prev = tiers[i - 1];
    const cur = tiers[i];
    if (cur.max !== null && cur.max <= prev.max) {
      throw new Error(`Los umbrales tienen que ser crecientes: "${cur.name}" ($${cur.max}) no puede ser menor o igual que "${prev.name}" ($${prev.max}).`);
    }
  }

  return tiers.map((t, i) => ({
    key: `tier${i + 1}`,
    name: t.name,
    emoji: TIER_STYLES[i].emoji,
    color: TIER_STYLES[i].color,
    pct: t.pct,
    min: i === 0 ? 0 : tiers[i - 1].max,
    max: t.max
  }));
}

/**
 * Devuelve el rango que corresponde a una pérdida.
 *
 * Los límites son INCLUSIVOS por abajo del corte: "hasta 30.000" significa que
 * $30.000 exactos todavía es el rango bajo, y $30.001 ya es el siguiente. Se
 * define así a propósito para que coincida con cómo lo dijo el owner ("hasta
 * 30.000", "más de 100.000") y para que el usuario no vea un salto de rango justo
 * en el número redondo que le mostramos como objetivo.
 *
 * @param {number} netLoss - pérdida del período, en pesos
 * @param {Array} [tiers] - escalera normalizada (default: DEFAULT_TIERS)
 * @returns {{key,name,emoji,color,pct,min,max,next,faltaParaSubir}}
 */
function getRefundTier(netLoss, tiers = DEFAULT_TIERS) {
  const loss = Number(netLoss) || 0;

  let idx = 0;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (t.max === null || loss <= t.max) { idx = i; break; }
    idx = i; // por si el for termina sin cortar (no debería: el último no tiene techo)
  }

  const tier = tiers[idx];
  const next = tiers[idx + 1] || null;

  return {
    ...tier,
    // Cuánto MÁS tendría que perder para subir de rango. null si ya está en el tope.
    // Es +1 peso sobre el techo actual porque el corte es "más de X".
    faltaParaSubir: next ? Math.max(0, (tier.max + 1) - loss) : null,
    next: next ? { key: next.key, name: next.name, emoji: next.emoji, pct: next.pct } : null
  };
}

/**
 * Calcula el monto del reembolso aplicando el rango correspondiente.
 * @param {number} netLoss - pérdida del período, en pesos
 * @param {Array} [tiers] - escalera normalizada (default: DEFAULT_TIERS)
 * @returns {{amount, pct, tier}}
 */
function calcRefund(netLoss, tiers = DEFAULT_TIERS) {
  const loss = Math.max(0, Number(netLoss) || 0);
  const tier = getRefundTier(loss, tiers);
  return {
    amount: Math.round(loss * (tier.pct / 100)),
    pct: tier.pct,
    tier
  };
}

/** Escalera para mostrar en la UI (copia defensiva). */
function listTiers(tiers = DEFAULT_TIERS) {
  return tiers.map((t) => ({ ...t }));
}

module.exports = {
  DEFAULT_TIERS,
  // 🪦 Alias del nombre viejo (pre panel-configurable), por si quedó algún import.
  REFUND_TIERS: DEFAULT_TIERS,
  MAX_TIERS,
  normalizeTiers,
  getRefundTier,
  calcRefund,
  listTiers
};
