#!/usr/bin/env node
/**
 * Validación EN FRÍO de la fórmula del reembolso acumulativo contra la tabla de
 * casos de docs/ESPEC-REEMBOLSO-1GIROX.md §7. Sin DB ni API: sólo la aritmética
 * de src/utils/cashbackFormula.js (que es lo que usa _cashbackStateToday).
 *
 *   node scripts/test-cashback-formula.js
 *
 * Los casos que dependen de la base/plataforma (doble click, timeout/duplicate)
 * se cubren por diseño (índice único + reference estable) y se anotan acá como
 * "por diseño" — no son aritmética.
 */
const { computeCashback, nextFold, FOLD_AFTER_DAYS, FOLD_CHUNK_DAYS } = require('../src/utils/cashbackFormula');

const DAY = 86400000;
let fails = 0;
function check(name, got, exp) {
  const ok = got === exp;
  if (!ok) fails++;
  console.log(`${ok ? '✅' : '❌'} ${name} → ${got}${ok ? '' : ` (esperado ${exp})`}`);
}
const base = { carryNet: 0, carryGranted: 0, giftedLocalBefore: 0, paidLife: 0, paidToday: 0, pct: 5, maxDailyArs: 0, minArs: 0 };

// 1) Carga $20k, regalo $20k, pierde $40k, pct 5% → $1.000 (no $2.000)
check('§7.1 carga 20k + regalo 20k, pierde 40k',
  computeCashback({ ...base, liveNet: 40000, liveGranted: 20000, giftedLocalLive: 20000 }).reclamable, 1000);

// 2) Gana $10M, después pierde $4M → $0 (neto −6M)
check('§7.2 gana 10M, pierde 4M',
  computeCashback({ ...base, liveNet: -10000000 + 4000000, liveGranted: 0, giftedLocalLive: 0 }).reclamable, 0);
// mismo caso con la ganancia ya PLEGADA en el carry (sigue restando para siempre)
check('§7.2b ganancia vieja plegada en carry, pierde 4M en vivo',
  computeCashback({ ...base, carryNet: -10000000, liveNet: 4000000 }).reclamable, 0);

// 3) Pierde $100k, cobra $5k, pierde esos $5k → $0
//    (el reembolso cobrado cuenta como regalo: neto +5k y regalado +5k se cancelan)
check('§7.3 pierde 100k, cobra 5k, pierde los 5k',
  computeCashback({ ...base, liveNet: 105000, giftedLocalLive: 5000, liveGranted: 5000, paidLife: 5000 }).reclamable, 0);

// 4) Pierde $100k, cobra $5k, pierde $100k más → $5.000
//    Continúa el caso 3: perdió los $5k del reembolso (netwin 105k) y DESPUÉS
//    $100k más de plata real → netwin 205k; regalado 5k (el reembolso cobrado,
//    §3.2); cobrado 5k → 5% × 200k − 5k = 5.000.
check('§7.4 pierde 100k, cobra 5k, pierde los 5k y 100k más',
  computeCashback({ ...base, liveNet: 205000, giftedLocalLive: 5000, liveGranted: 5000, paidLife: 5000 }).reclamable, 5000);
//    Variante (§3.2 "efecto aceptado"): si el reembolso NO se perdió (sigue en el
//    saldo) y pierde 100k de plata real, cobra 4.750 — la plataforma no
//    distingue cuál peso perdió y se elige el lado conservador para la casa.
check('§3.2 variante: reembolso NO perdido, pierde 100k reales (lado conservador)',
  computeCashback({ ...base, liveNet: 200000, giftedLocalLive: 5000, liveGranted: 5000, paidLife: 5000 }).reclamable, 4750);

// 5) Regalo $20k bloqueado (no jugado), pierde $10k reales → $0 hasta perder > $20k
check('§7.5 regalo 20k sin jugar, pierde 10k reales',
  computeCashback({ ...base, liveNet: 10000, liveGranted: 20000, giftedLocalLive: 20000 }).reclamable, 0);
check('§7.5b mismo jugador tras perder 30k reales (> 20k)',
  computeCashback({ ...base, liveNet: 30000, liveGranted: 20000, giftedLocalLive: 20000 }).reclamable, 500);

// 8) Bono dado a mano en el panel de 1girox (no está en nuestra base) → igual se descuenta (granted)
check('§7.8 bono a mano en 1girox (local 0, granted 20k), pierde 40k',
  computeCashback({ ...base, liveNet: 40000, liveGranted: 20000, giftedLocalLive: 0 }).reclamable, 1000);
// y al revés: regalo que fue como DEPÓSITO (granted no lo ve) → lo cubre la base local
check('§3.5 regalo como depósito (local 20k, granted 0), pierde 40k',
  computeCashback({ ...base, liveNet: 40000, liveGranted: 0, giftedLocalLive: 20000 }).reclamable, 1000);
// máximo POR TRAMO (no total contra total)
check('§3.3 por tramo: viejo local 10k/granted 0 + vivo local 0/granted 10k, pierde 40k',
  computeCashback({ ...base, liveNet: 40000, giftedLocalBefore: 10000, carryGranted: 0, giftedLocalLive: 0, liveGranted: 10000 }).reclamable, 1000);

// Tope diario y mínimo
check('tope diario: reclamable 5.000, tope 3.000, cobrado hoy 1.000',
  computeCashback({ ...base, liveNet: 100000, maxDailyArs: 3000, paidToday: 1000 }).reclamable, 2000);
check('mínimo: reclamable 200 < min 300 → belowMin',
  computeCashback({ ...base, liveNet: 4000, minArs: 300 }).belowMin, true);
check('floor: 5% de 33.333 = 1.666,65 → 1.666',
  computeCashback({ ...base, liveNet: 33333 }).reclamable, 1666);

// 9) 100 días desde el alta → plegado: un tramo de 60 días al carry, ancla avanza
{
  const alta = new Date('2026-06-01T00:00:00-03:00');
  const hoy100 = new Date(alta.getTime() + 100 * DAY);
  const f = nextFold(alta, hoy100);
  check('§7.9 100 días: hay plegado', !!f, true);
  check('§7.9 tramo plegado arranca en el ancla', f.from.getTime(), alta.getTime());
  check(`§7.9 tramo plegado = [ancla, ancla+${FOLD_CHUNK_DAYS}d) — termina 1 s antes del ancla nueva`,
    f.to.getTime(), f.nextAnchor.getTime() - 1000);
  check(`§7.9 tramo plegado cubre ${FOLD_CHUNK_DAYS} días completos`,
    Math.round((f.to.getTime() - f.from.getTime()) / DAY), FOLD_CHUNK_DAYS);
  check(`§7.9 ancla avanza ${FOLD_CHUNK_DAYS} días`, Math.round((f.nextAnchor.getTime() - alta.getTime()) / DAY), FOLD_CHUNK_DAYS);
  check('§7.9 tras plegar (40 días vivos) ya no pliega', nextFold(f.nextAnchor, hoy100), null);
  check(`${FOLD_AFTER_DAYS} días exactos: todavía no pliega`, nextFold(alta, new Date(alta.getTime() + FOLD_AFTER_DAYS * DAY)), null);
  // el tramo plegado nunca supera el tope de 92 días de la API
  check('tramo plegado ≤ 92 días', Math.round((f.to.getTime() - f.from.getTime()) / DAY) <= 92, true);
}

console.log('\nPor diseño (no aritmética): §7.6 doble click → índice único userId+dateKey+seq + guard 20s;');
console.log('§7.7 timeout y reintento → misma reference vip-cbk-<user>-<día>-<seq> ⇒ duplicate:true (un solo pago).');
console.log(fails ? `\n❌ ${fails} caso(s) fallaron` : '\n✅ Todos los casos de §7 dan lo esperado');
process.exit(fails ? 1 : 0);
