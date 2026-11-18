/**
 * bonusKind.js — BONO NORMAL vs BONO WAGER (#226/#227). Parte PURA: sin DB ni API,
 * para validarla en frío (`node scripts/test-bonus-kind.js`). server.js lee
 * Config['bonusKind'] y llama acá.
 *
 * QUÉ ES EL WAGER: saldo PROMOCIONAL de 1girox (plata ficticia de la casa, balde
 * `wager` aparte del saldo real; no sale del saldo del agente, no es retirable, sin
 * rollover; se juega después del saldo real y se convierte en real de a 5% de lo
 * apostado por ronda; hoy solo en los juegos de Pulse).
 *
 * CÓMO SE OTORGA (#227, PROBADO contra la API el 2026-11-13; documentado desde el manual v1.19/v1.20 §2.9.1 — el v1.18 no lo
 * documenta): `POST /players/{u}/promo { amount, reference, description }` =
 * PROMOCIONAL SUELTO. Da wager de verdad con el motor de bonos en "clásico" Y en
 * "unificado", responde `promo_bonus { status:'ok', amount }` + `wager`, y un
 * reintento con la misma reference devuelve `duplicate:true` con el mismo detalle.
 * ⚠️ NO se usa `wager_percent` / `wager_amount` ADENTRO del depósito: con el motor
 * "unificado" la plataforma lo convierte en BONO REAL sin rollover (retirable al
 * instante). El suelto es seguro en los dos motores, por eso es el único camino.
 *
 * Entonces, en una carga: el depósito sale como siempre (con el bono NORMAL adjunto
 * de los bonos que van como normal) y DESPUÉS se acredita aparte el promocional de
 * los bonos que van como wager, por el monto que calculamos nosotros.
 *
 * Config['bonusKind'] = {
 *   enabled,                       // interruptor general (default APAGADO = todo normal)
 *   fallback: 'normal' | 'skip',   // si el wager no se pudo dar: bono normal / no dar nada
 *   flows: { <flujo>: 'normal' | 'wager' }   // ver DEPOSIT_FLOWS y GIFT_FLOWS
 * }
 */
// Bonos que se aplican ADENTRO de una carga (los decide el sistema).
const DEPOSIT_FLOWS = ['install', 'publisher', 'roulette', 'story', 'lote'];
// Regalos SIN carga (cada uno se acredita solo).
const GIFT_FLOWS = ['refund', 'cashback', 'roulette_cash', 'fire', 'rakeback', 'vip_levelup', 'lote_fichas', 'welcome_code', 'manual_bonus'];
// El bono que pone el agente a mano al CARGAR no está acá a propósito: lo elige el
// agente en cada carga (modal Depositar, arranca siempre en "normal"). Tampoco las
// comisiones de referidos ni las devoluciones de retiro: es plata del cliente.
const FLOWS = DEPOSIT_FLOWS.concat(GIFT_FLOWS);
const FLOW_LABELS = {
  install: 'Bono por instalar la app',
  publisher: 'Bono de 1ª carga por publicista',
  roulette: 'Ruleta diaria: % EXTRA en la próxima carga',
  story: 'Bono de una historia (+% en la próxima carga)',
  lote: 'Lote con regalo: % automático en la carga',
  refund: 'Reembolsos (diario / semanal / mensual)',
  cashback: 'Reembolso en vivo',
  roulette_cash: 'Ruleta diaria: premios en $',
  fire: 'Fueguito (premios de la racha)',
  rakeback: 'Rakeback semanal VIP',
  vip_levelup: 'Bono por subir de nivel VIP',
  lote_fichas: 'Lote con regalo: fichas',
  welcome_code: 'Código de bienvenida (premio en $)',
  manual_bonus: 'Botón "Bonificación" del panel (bono suelto del agente)'
};
const KINDS = ['normal', 'wager'];
const FALLBACKS = ['normal', 'skip'];

function defaultConfig() {
  const flows = {};
  FLOWS.forEach((f) => { flows[f] = 'normal'; });
  return { enabled: false, fallback: 'normal', flows };
}

/** Lee lo guardado (tolerante: lo inválido se descarta y vale el default). */
function normalizeConfig(raw) {
  const out = defaultConfig();
  if (!raw || typeof raw !== 'object') return out;
  out.enabled = raw.enabled === true;
  out.fallback = FALLBACKS.includes(raw.fallback) ? raw.fallback : 'normal';
  const rf = (raw.flows && typeof raw.flows === 'object') ? raw.flows : {};
  FLOWS.forEach((f) => { out.flows[f] = rf[f] === 'wager' ? 'wager' : 'normal'; });
  return out;
}

/**
 * Valida lo que manda el panel (estricta: un dato inválido es error).
 * Devuelve { ok:true, config, warnings[] } | { ok:false, error }.
 */
function validateConfig(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = defaultConfig();
  out.enabled = b.enabled === true;
  if (b.fallback != null && !FALLBACKS.includes(b.fallback)) return { ok: false, error: 'Opción inválida para "si el wager no se puede dar".' };
  out.fallback = FALLBACKS.includes(b.fallback) ? b.fallback : 'normal';
  const rf = (b.flows && typeof b.flows === 'object') ? b.flows : {};
  for (const f of FLOWS) {
    const v = rf[f] == null ? 'normal' : rf[f];
    if (!KINDS.includes(v)) return { ok: false, error: `Tipo de bono inválido para "${FLOW_LABELS[f]}".` };
    out.flows[f] = v;
  }
  const warnings = [];
  const wagerFlows = FLOWS.filter((f) => out.flows[f] === 'wager');
  if (!out.enabled && wagerFlows.length) warnings.push('Hay bonos puestos en "Wager" pero el interruptor general está APAGADO: siguen saliendo como bono normal.');
  return { ok: true, config: out, warnings };
}

/** ¿Este flujo sale como wager? (interruptor general + tipo del flujo) */
function flowIsWager(cfg, flow) {
  return !!(cfg && cfg.enabled && cfg.flows && cfg.flows[flow] === 'wager');
}

/**
 * Plan de los bonos AUTOMÁTICOS de una carga.
 * @param cfg    config normalizada
 * @param items  [{ kind:'publisher'|'install'|'roulette'|'story'|'lote', pct, amount }]
 *               (`amount` = lo que le corresponde por ese bono, calculado por nosotros)
 * @returns { wagerItems, wagerTotal, normalItems, normalTotal }
 *   - normalItems/normalTotal: van como bono NORMAL adjunto al depósito (como siempre).
 *   - wagerItems/wagerTotal: van como promocional suelto DESPUÉS del depósito.
 * Sin wagerItems la carga sale EXACTAMENTE como antes.
 */
function planDeposit(cfg, items) {
  const out = { wagerItems: [], wagerTotal: 0, normalItems: [], normalTotal: 0 };
  (Array.isArray(items) ? items : []).forEach((it) => {
    const a = Number(it && it.amount) || 0;
    if (!(a > 0)) return;
    if (flowIsWager(cfg, it.kind)) { out.wagerItems.push(it); out.wagerTotal += a; }
    else { out.normalItems.push(it); out.normalTotal += a; }
  });
  return out;
}

/**
 * ¿La respuesta del promocional suelto confirma que se otorgó?
 * @param data  body crudo de POST /players/{u}/promo
 * @returns { granted, amount, wagerBalance }
 */
function readPromoResponse(data) {
  const d = data || {};
  const pb = d.promo_bonus || null;
  const granted = !!(pb && String(pb.status || '').toLowerCase() === 'ok' && Number(pb.amount) > 0);
  return {
    granted,
    amount: granted ? Number(pb.amount) : 0,
    wagerBalance: (d.wager != null && Number.isFinite(Number(d.wager))) ? Number(d.wager) : null
  };
}

/**
 * ¿Un fallo del promocional es TRANSITORIO (red / 429 / 5xx)? En ese caso NO se
 * cambia de vía ni se da respaldo: un timeout puede haber acreditado, y el reintento
 * con la MISMA reference lo resuelve (duplicate). Un rechazo de negocio (4xx: feat
 * apagado, tope, validación) NO movió nada → ahí sí vale el respaldo.
 */
function isTransientFailure(r) {
  if (!r) return true;
  const s = Number(r.httpStatus);
  if (!Number.isFinite(s) || s === 0) return true; // sin respuesta HTTP
  return s === 429 || s >= 500;
}

module.exports = {
  DEPOSIT_FLOWS, GIFT_FLOWS, FLOWS, FLOW_LABELS, KINDS, FALLBACKS,
  defaultConfig, normalizeConfig, validateConfig,
  flowIsWager, planDeposit, readPromoResponse, isTransientFailure
};
