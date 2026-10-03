// ============================================================================
// 1) TOPE DEL % DE LOTE (#172) — comparte Config['hgcashAppBonus'] con el bono app (#164)
// Extraído de AUTOREEMBOLSOSjygactivo/server.js (commit 714dd04, 2026-10-03). Pegar tal cual
// salvo lo indicado en README.md.
// ============================================================================

// Si el repo destino NO tiene el bono app, igual hace falta ESTA config (firstCapARS /
// firstExcessPct) y getHgcashAppBonusConfig(): es lo que limita un lote de 100% a $5.000 + 20%.
// Dependencias: getConfig (Config), logger.

// automáticos hgcash"): Config['hgcashAppBonus'] = { firstEnabled, firstPct,
// allEnabled, allPct }. Los defaults reproducen el pedido original (100% / 20%).
// La fecha límite del bono "todas las cargas" queda fija en código.
const HGCASH_APP_BONUS_20_UNTIL = new Date('2026-08-31T23:59:59.999-03:00');
// #164 (owner 2026-09-18): el 100% de primera carga aplica hasta `firstCapARS` ($5.000) y
// el monto que EXCEDE ese tope se bonifica al `firstExcessPct` (20%). Ej.: carga $8.000 →
// $5.000 al 100% + $3.000 al 20% = $5.600 de bono. Todo automático y editable en el panel.
const HGCASH_APP_BONUS_DEFAULTS = { firstEnabled: true, firstPct: 100, firstCapARS: 5000, firstExcessPct: 20, allEnabled: true, allPct: 20 };
// Bono de primera carga con tope: 100% hasta el tope + excedente al % menor.
function _hgcashFirstBonusAmount(amount, cfg) {
  const a = Math.max(0, Number(amount) || 0);
  const cap = Number(cfg.firstCapARS) > 0 ? Number(cfg.firstCapARS) : Infinity;
  const base = Math.min(a, cap);
  const excess = Math.max(0, a - cap);
  return Math.round(base * (Number(cfg.firstPct) || 0) / 100 + excess * (Number(cfg.firstExcessPct) || 0) / 100);
}
// #172 (owner 2026-09-29): el % de un LOTE respeta el MISMO tope que el bono app: el % del
// lote aplica hasta `firstCapARS` ($5.000) y el excedente de la carga se bonifica al
// `firstExcessPct` (20%), nunca más que el % del lote. Ej.: lote 100%, carga $10.000 →
// $5.000 al 100% + $5.000 al 20% = $6.000 (antes daba $10.000). Lote 20% → 20% de todo.
function _loteBonusAmount(amount, pct, cfg) {
  const a = Math.max(0, Number(amount) || 0), p = Math.max(0, Number(pct) || 0);
  const cap = Number(cfg && cfg.firstCapARS) > 0 ? Number(cfg.firstCapARS) : Infinity;
  const exPct = Math.min(p, Number(cfg && cfg.firstExcessPct) || 0);
  return Math.round(Math.min(a, cap) * p / 100 + Math.max(0, a - cap) * exPct / 100);
}
// Texto corto de la regla del tope para un % de lote ('' si el tope no lo afecta).
function _loteCapTxt(pct, cfg) {
  const c = cfg || _hgcashAppBonusCfgCache;
  const p = Number(pct) || 0, cap = Number(c.firstCapARS) || 0, ex = Number(c.firstExcessPct) || 0;
  if (!(cap > 0) || p <= ex) return '';
  return ` (${p}% hasta $${cap.toLocaleString('es-AR')}, el resto al ${ex}%)`;
}
let _hgcashAppBonusCfgCache = Object.assign({}, HGCASH_APP_BONUS_DEFAULTS); // última config leída (para textos sync)

async function getHgcashAppBonusConfig() {
  try {
    const cfg = (await getConfig('hgcashAppBonus', null)) || {};
    const capN = Math.round(Number(cfg.firstCapARS));
    const exN = Math.round(Number(cfg.firstExcessPct));
    return (_hgcashAppBonusCfgCache = {
      firstEnabled: cfg.firstEnabled !== false,
      firstPct: _hgcashBonusPct(cfg.firstPct, HGCASH_APP_BONUS_DEFAULTS.firstPct),
      firstCapARS: Number.isFinite(capN) && capN >= 0 ? capN : HGCASH_APP_BONUS_DEFAULTS.firstCapARS, // 0 = sin tope
      firstExcessPct: Number.isFinite(exN) && exN >= 0 && exN <= 200 ? exN : HGCASH_APP_BONUS_DEFAULTS.firstExcessPct,
      allEnabled: cfg.allEnabled !== false,
      allPct: _hgcashBonusPct(cfg.allPct, HGCASH_APP_BONUS_DEFAULTS.allPct)
    });
  } catch (e) {
    logger.warn(`[hgcash-bonus] no se pudo leer la config (uso defaults): ${e.message}`);
    return Object.assign({}, HGCASH_APP_BONUS_DEFAULTS);
  }
}
