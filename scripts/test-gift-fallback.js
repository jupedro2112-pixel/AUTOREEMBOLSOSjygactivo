// #222 (réplica #236–#239 de CARGASGIROXactivo) Regalo con rollover a un jugador de jugaygana.io que ya tiene un bono activo:
// por defecto se UNIFICA (un bono nuevo por viejo + regalo, con rollover) — nunca como depósito, que la plataforma muestra como
// Carga. En frío: se simula la Partner API. Al final, chequeos estáticos de que la JUGAYGANA vieja no cambia.
//   node scripts/test-gift-fallback.js
const assert = require('assert');
const path = require('path');
const Module = require('module');
process.env.GIROX_API_URL = 'https://api.prueba.test/v1'; process.env.GIROX_API_KEY = 'k-prueba'; delete process.env.GIROX_GIFT_AS_BONUS;
const calls = [];
const state = { dup: false, bonusLocked: 0, cfg: { bonus: { enabled: true, standalone_enabled: true, multipliers: [0, 3, 5], fixed_min: 2, fixed_max: 500000 } }, bonusFail: null };
const origLoad = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === 'axios') {
    return async ({ method, url, data }) => {
      const p = url.replace(process.env.GIROX_API_URL, ''); const m = String(method).toLowerCase();
      calls.push({ m, p, data });
      if (m === 'get' && p === '/config') return { status: 200, data: state.cfg };
      if (m === 'get' && /^\/players\/[^/]+$/.test(p)) return { status: 200, data: { player: { username: 'jug', balance: 1000, wagering: { available: 1000, locked: state.bonusLocked, bonus_locked: state.bonusLocked, claimable_total: state.claimable || 0 } } } };
      if (m === 'post' && /\/bonus$/.test(p)) {
        if (state.bonusFail && data.multiplier > 0) { const e = new Error('422'); e.response = { status: 422, data: { error: { code: state.bonusFail, message: 'x' }, code: state.bonusFail } }; throw e; }
        // saldo antes = 1000. Con multiplier > 0, 1girox debita el resto del bono viejo y acredita el nuevo.
        const after = data.multiplier > 0 ? 1000 - (state.noDebit ? 0 : state.bonusLocked) + data.amount : 1000 + data.amount;
        if (state.dup) return { status: 200, data: { duplicate: true, balance: 1000, operation: { ledger_id: 70, reference: data.reference, type: 'bonus' } } };
        return { status: 200, data: { balance: after, operation: { ledger_id: 77, reference: data.reference, type: 'bonus' } } };
      }
      if (m === 'post' && /\/deposit$/.test(p)) return { status: 200, data: { operation: { ledger_id: 88, reference: data.reference, type: 'deposit' } } };
      return { status: 200, data: {} };
    };
  }
  if (/utils\/logger$/.test(req)) return { warn() {}, info() {}, error() {}, debug() {}, log() {} };
  return origLoad.call(this, req, parent, ...rest);
};
const girox = require(path.join(__dirname, '..', 'src/services/giroxService'));
let mode = undefined;
girox.setRolloverResolver(async () => 3);          // rollover GLOBAL x3 encendido
girox.setGiftFallbackResolver(async () => mode);
const anomalies = [];
girox.setGiftMergeAnomalyHook((a) => anomalies.push(a));
const posts = () => calls.filter((c) => c.m === 'post').map((c) => c.p.split('/').pop() + (c.data.multiplier != null ? ':x' + c.data.multiplier : ''));
const reset = (o) => { calls.length = 0; anomalies.length = 0; Object.assign(state, { dup: false, bonusLocked: 0, bonusFail: null, claimable: 0, noDebit: false }, o || {}); };

(async () => {
  let n = 0; const ok = (t) => { n++; console.log('  ✅ ' + t); };

  reset(); mode = undefined;
  let r = await girox.creditUserBalance('jug', 1000, 'vip-rf-1', { giftFlow: 'refund' });
  assert.ok(r.success); assert.deepStrictEqual(posts(), ['bonus:x3']); assert.strictEqual(r.creditedAs, 'bonus'); assert.strictEqual(r.rolloverApplied, 3);
  ok('sin bono activo: sale como bono con el rollover global (igual que antes)');

  // ---- #237 UNIFICAR (default) ----
  reset({ bonusLocked: 5000 }); mode = undefined;
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-2', { giftFlow: 'refund' });
  assert.ok(r.success); assert.deepStrictEqual(posts(), ['bonus:x3'], 'un solo bono, nunca /deposit');
  let b = calls.filter((c) => c.m === 'post')[0].data;
  assert.strictEqual(b.amount, 6000, 'bono nuevo = resto del viejo (5000) + regalo (1000)'); assert.strictEqual(b.reference, 'vip-rf-2');
  assert.strictEqual(r.creditedAs, 'bonus'); assert.strictEqual(r.rolloverApplied, 3); assert.strictEqual(r.mergedOld, 5000); assert.strictEqual(r.mergedTotal, 6000);
  assert.strictEqual(anomalies.length, 0);
  ok('jugador CON bono activo: se UNIFICA — bono nuevo por viejo + regalo, con rollover, sin depósito');

  reset({ bonusLocked: 5000 }); mode = 'merge';
  r = await girox.creditGift('jug', 500, { rolloverX: 5, reference: 'vip-roulette-1', description: 'Premio ruleta' });
  b = calls.filter((c) => c.m === 'post')[0].data;
  assert.deepStrictEqual(posts(), ['bonus:x3']); assert.strictEqual(b.amount, 5500); assert.ok(/bono anterior/.test(b.description));
  ok('ruleta / fueguito (creditGift) con bono activo: también unifica');

  reset({ bonusLocked: 5000, noDebit: true }); mode = undefined;
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-2b', { giftFlow: 'refund' });
  assert.ok(r.success); assert.strictEqual(anomalies.length, 1); assert.strictEqual(anomalies[0].gained, 6000); assert.strictEqual(anomalies[0].old, 5000);
  ok('control: si 1girox NO debita el bono viejo (el saldo sube de más) → avisa para apagar la unificación');

  reset({ bonusLocked: 5000, claimable: 300 }); mode = undefined;
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-2c', { giftFlow: 'refund' });
  assert.deepStrictEqual(posts(), ['deposit:x3']); assert.strictEqual(r.creditedAs, 'deposit');
  assert.ok(/^BONO \(contar como BONO, NO como carga\): /.test(calls.filter((c) => c.m === 'post')[0].data.description), '#238 la descripción avisa que es un bono');
  ok('tiene un bono cumplido sin reclamar: no se unifica → depósito con rollover (queda marcado)');

  reset({ bonusLocked: 499500 }); mode = undefined;
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-2d', { giftFlow: 'refund' });
  assert.deepStrictEqual(posts(), ['deposit:x3']);
  ok('unificado superaría el máximo de bono de la plataforma: depósito con rollover');

  reset({ bonusLocked: 40 }); mode = undefined;
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-2e', { giftFlow: 'refund' });
  assert.deepStrictEqual(posts(), ['bonus:x3']); assert.strictEqual(calls.filter((c) => c.m === 'post')[0].data.amount, 1000); assert.strictEqual(r.mergedOld, undefined);
  ok('resto de bono mínimo (hasta $50): bono normal, como siempre');

  reset({ bonusLocked: 5000 }); mode = 'bonus0';
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-2f', { giftFlow: 'refund' });
  assert.deepStrictEqual(posts(), ['bonus:x0']); assert.strictEqual(r.rolloverApplied, 0);
  ok('opción del panel "bono sin rollover": sale como bono 0');

  reset({ bonusLocked: 5000 }); mode = 'deposit';
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-3', { giftFlow: 'refund' });
  assert.ok(r.success); assert.deepStrictEqual(posts(), ['deposit:x3']); assert.strictEqual(r.creditedAs, 'deposit'); assert.strictEqual(r.rolloverApplied, 3); assert.ok(r.fallbackReason);
  ok('opción del panel "depósito con rollover": se comporta como antes y avisa que fue depósito');

  reset({ bonusFail: 'bonus_out_of_range' }); mode = 'bonus0';
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-4', { giftFlow: 'refund' });
  assert.ok(r.success); assert.deepStrictEqual(posts(), ['bonus:x3', 'bonus:x0']); assert.strictEqual(r.creditedAs, 'bonus');
  assert.strictEqual(calls.filter((c) => c.m === 'post')[0].data.reference, calls.filter((c) => c.m === 'post')[1].data.reference, 'misma reference en los dos intentos');
  ok('la plataforma rechaza el bono con rollover: reintenta como bono sin rollover con la MISMA reference');

  reset({ bonusLocked: 5000 }); mode = 'bonus0';
  r = await girox.creditUserBalance('jug', 1, 'vip-rf-5', { giftFlow: 'refund', description: 'Reembolso diario (2026-11-25)' });
  assert.ok(r.success); assert.deepStrictEqual(posts(), ['deposit']); assert.strictEqual(r.creditedAs, 'deposit');
  assert.ok(/contar como BONO.*Reembolso diario.*limitación de la API/.test(calls.filter((c) => c.m === 'post')[0].data.description));
  ok('único caso que sigue yendo a depósito: monto fuera de lo que 1girox acepta como bono (ej. $1) — queda marcado');

  reset(); mode = undefined;
  r = await girox.creditUserBalance('jug', 1000, 'vip-payoutref-bonus-1', { ignoreGlobalRollover: true });
  assert.deepStrictEqual(posts(), ['bonus:x0']);
  ok('devolución / comisión (sin rollover global): no cambia');

  // ---- propio de este repo ----
  // Así llama plat.creditUserBalance con rollover por tipo de regalo (#205): rolloverX del flujo + ignoreGlobalRollover.
  reset({ bonusLocked: 5000 }); mode = undefined;
  r = await girox.creditGift('jug', 800, { reference: 'vip-rf-6', description: 'REEMBOLSO diario', rolloverX: 5, ignoreGlobalRollover: true });
  b = calls.filter((c) => c.m === 'post')[0].data;
  assert.deepStrictEqual(posts(), ['bonus:x5']); assert.strictEqual(b.amount, 5800); assert.strictEqual(b.reference, 'vip-rf-6');
  assert.strictEqual(r.mergedOld, 5000); assert.strictEqual(r.giftAmount, 800); assert.strictEqual(r.rolloverApplied, 5);
  ok('rollover por tipo de regalo (#205): unifica con el rollover DEL FLUJO, misma reference');

  reset({ bonusLocked: 5000 }); mode = undefined;
  r = await girox.creditGift('jug', 800, { reference: 'vip-rf-7', rolloverX: 0, ignoreGlobalRollover: true });
  assert.deepStrictEqual(posts(), ['bonus:x0']); assert.strictEqual(calls.filter((c) => c.m === 'post')[0].data.amount, 800); assert.strictEqual(r.mergedOld, undefined);
  ok('flujo configurado SIN rollover: regalo directo por el monto pedido, no toca el bono en curso');

  reset({ bonusLocked: 6000, dup: true }); mode = undefined;
  r = await girox.creditGift('jug', 1000, { reference: 'vip-rf-2', rolloverX: 3, ignoreGlobalRollover: true });
  assert.ok(r.success); assert.strictEqual(r.duplicate, true); assert.strictEqual(r.mergedOld, undefined); assert.strictEqual(r.mergedTotal, undefined); assert.strictEqual(anomalies.length, 0);
  ok('reintento de una reference ya acreditada (duplicate): no informa unificación ni dispara el control de saldo');

  // ---- estáticos: la JUGAYGANA vieja no cambia y el cableado de server.js está ----
  const fs = require('fs'); const root = path.join(__dirname, '..');
  const platSrc = fs.readFileSync(path.join(root, 'src/services/platform.js'), 'utf8');
  const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const ref = fs.readFileSync(path.join(root, 'src/services/referralPayoutService.js'), 'utf8');
  assert.ok(platSrc.includes('return jugaygana.creditUserBalance(username, amount, jugayganaUserId);'), 'la vieja recibe solo usuario, monto e id');
  assert.ok(platSrc.includes('return jugayganaMovements.makeBonus(username, amount, description);'), 'makeBonus en la vieja: descripción posicional de siempre');
  assert.ok(/plat\.makeBonus\(username, rewardAmount, rewardDesc \+ ' - Sala de Juegos', \{ rolloverFlow: 'fire', description: /.test(srv), 'fueguito: el texto nuevo va en opts (solo jugaygana.io)');
  assert.ok(/: await jugayganaService\.bonus\(\s*jugayganaUsername,\s*totalAmount,\s*description\s*\)/.test(ref), 'referidos en la vieja: descripción de siempre');
  ok('usuario de la JUGAYGANA vieja: mismas llamadas y mismos textos que antes');

  assert.ok(/girox\.setGiftFallbackResolver\(/.test(srv) && /girox\.setGiftMergeAnomalyHook\(/.test(srv), 'resolver y hook cableados');
  assert.ok(/fallback: 'deposit', mergeOffAt/.test(srv), 'la anomalía vuelve a depósito');
  assert.ok(/if \(!r \|\| !r\.success \|\| r\.platform !== 'partner'\) return \{\};/.test(srv), '_giftMetaFields no marca nada fuera de jugaygana.io');
  assert.strictEqual((srv.match(/\.\.\._giftMeta\(depositResult\)/g) || []).length, 4, 'reembolsos x3 + botón Bonificación guardan la marca');
  assert.strictEqual((srv.match(/description: `REEMBOLSO (diario|semanal|mensual) del /g) || []).length, 3, 'los 3 reembolsos mandan descripción detallada');
  assert.ok(!/amount: [^,\n]*mergedTotal/.test(srv), 'nunca se registra mergedTotal como monto del regalo');
  assert.ok(/Object\.assign\(\{\}, prevG, \{ enabled: b\.enabled !== false, x,/.test(srv), 'guardar el rollover general no pisa el modo');
  ok('server.js: resolver, hook de anomalía, marcas de Transaction y descripciones cableados');

  console.log('\n✅ Todo OK (' + n + ')');
})().catch((e) => { console.error('❌ ' + (e && e.stack || e)); console.error(JSON.stringify(calls.slice(-6))); process.exit(1); });
