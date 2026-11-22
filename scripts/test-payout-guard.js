#!/usr/bin/env node
/**
 * Test en frío del CANDADO ANTI PAGO DOBLE entre cuentas / bancos (#219) — sin red ni Mongo.
 * Recorta el bloque real de server.js (`const PAYOUT_RESEND_COOLDOWN_MS` … `async function
 * _payPayoutViaFinpro`): si se renombran esos marcadores, actualizar acá.
 * Uso: node scripts/test-payout-guard.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const a = src.indexOf('const PAYOUT_RESEND_COOLDOWN_MS = ');
const b = src.indexOf('async function _payPayoutViaFinpro(', a);
if (a < 0 || b < 0) throw new Error('no encuentro el bloque del candado de pagos en server.js');
const block = src.slice(a, b);

let movements = [];
const updates = [];
const match = (m, q) => {
  if (q.direction && m.direction !== q.direction) return false;
  if (q.$or && !q.$or.some((c) => Object.keys(c).every((k) => m[k] === c[k]))) return false;
  if (q.createdAt && !(new Date(m.createdAt) >= q.createdAt.$gte)) return false;
  if (q.amount && !(m.amount >= q.amount.$gte && m.amount <= q.amount.$lte)) return false;
  return true;
};
const S = {
  BankMovement: { find: (q) => ({ sort() { return this; }, limit() { return this; }, lean: async () => movements.filter((m) => match(m, q)) }) },
  PendingPayout: { updateOne: async (q, u) => { updates.push({ q, u }); } },
  _hgAccountByKey: (k) => ({ a1: { key: 'a1', label: 'GRMA' }, a2: { key: 'a2', label: 'VANTUM' } }[k] || null),
  _fpAccountByKey: (k) => (k === 'f1' ? { key: 'f1', label: 'QUICKPAY' } : null),
  _hgAccountLabel: (x) => x.label, _fpAccountLabel: (x) => x.label,
  _hgAccountLabelFor: (m) => (m.accountKey ? { label: m.accountKey === 'a1' ? 'GRMA' : 'VANTUM' } : null),
  _bankLabel: (p) => (p === 'finpro' ? 'Finpro' : 'hgcash'),
  _digits: (x) => String(x || '').replace(/\D/g, ''),
  logger: { info() {}, warn() {}, error() {} },
  __out: null
};
new Function('S', 'with (S) {\n' + block + '\n__out = { _payoutResendGuard, _payoutNoteSend, _payoutNoteResult, PAYOUT_RESEND_COOLDOWN_MS }; }')(S);
const X = S.__out;

const CBU = '0000003100097335288307';
const ago = (ms) => new Date(Date.now() - ms);
const P = (o) => Object.assign({ id: 'p1', amount: 999000, username: 'anto', sendLog: [] }, o || {});
let fails = 0;
const tests = [];
const t = (name, fn) => tests.push([name, async () => { movements = []; updates.length = 0; await fn(); }]);

t('primer envío de un retiro: pasa', async () => {
  assert.strictEqual(await X._payoutResendGuard(P(), 'hgcash', 'a1', CBU, false), null);
});
t('ya hay una SALIDA del banco con el id del retiro: no se paga otra vez (ni confirmando)', async () => {
  movements = [{ direction: 'Outbound', externalId: 'p1', payoutId: 'p1', amount: 999000, toCBU: CBU, status: 'done', accountKey: 'a1', createdAt: ago(40000) }];
  const g = await X._payoutResendGuard(P({ lastSendAt: ago(45000), lastSendBank: 'hgcash', lastSendAccount: 'a1', lastSendResult: 'unknown' }), 'hgcash', 'a2', CBU, true);
  assert.ok(g && g.http === 409 && g.body.alreadySent === true); assert.ok(/YA SALIÓ/.test(g.body.error) && /GRMA/.test(g.body.error));
  // aunque sea el primer intento anotado (pedido viejo sin lastSendAt)
  const g2 = await X._payoutResendGuard(P(), 'finpro', 'f1', CBU, true);
  assert.ok(g2 && g2.body.alreadySent === true);
});
t('una salida con estado de error / reversada no cuenta como pagada', async () => {
  movements = [{ direction: 'Outbound', externalId: 'p1', payoutId: 'p1', amount: 999000, toCBU: CBU, status: 'REVERSED', createdAt: ago(600000) }];
  const g = await X._payoutResendGuard(P({ lastSendAt: ago(600000), lastSendBank: 'hgcash', lastSendAccount: 'a1', lastSendResult: 'rejected' }), 'hgcash', 'a2', CBU, false);
  assert.strictEqual(g, null);
});
t('incidente GRMA → VANTUM a los 46 s: se frena por la espera', async () => {
  const g = await X._payoutResendGuard(P({ lastSendAt: ago(46000), lastSendBank: 'hgcash', lastSendAccount: 'a1', lastSendResult: 'rejected' }), 'hgcash', 'a2', CBU, true);
  assert.ok(g && g.http === 409 && g.body.wait === true && g.body.retryInSec > 60 && g.body.retryInSec <= 75);
  assert.ok(/GRMA/.test(g.body.error));
});
t('incidente Finpro → hgcash a los 35 s: se frena por la espera', async () => {
  const g = await X._payoutResendGuard(P({ lastSendAt: ago(35000), lastSendBank: 'finpro', lastSendAccount: 'f1', lastSendResult: 'rejected' }), 'hgcash', 'a1', CBU, false);
  assert.ok(g && g.body.wait === true && /Finpro · QUICKPAY/.test(g.body.error));
});
t('reintento por la MISMA cuenta: no espera (ahí vale la idempotencia del banco)', async () => {
  const g = await X._payoutResendGuard(P({ lastSendAt: ago(5000), lastSendBank: 'hgcash', lastSendAccount: 'a1', lastSendResult: 'unknown' }), 'hgcash', 'a1', CBU, false);
  assert.strictEqual(g, null);
});
t('pasada la espera: rechazo CLARO del banco anterior → pasa sin preguntar', async () => {
  const g = await X._payoutResendGuard(P({ lastSendAt: ago(X.PAYOUT_RESEND_COOLDOWN_MS + 1000), lastSendBank: 'hgcash', lastSendAccount: 'a1', lastSendResult: 'rejected' }), 'hgcash', 'a2', CBU, false);
  assert.strictEqual(g, null);
});
t('pasada la espera: envío anterior SIN respuesta clara → pide confirmación; confirmado pasa', async () => {
  for (const res of ['unknown', 'sending', 'accepted']) {
    const p = P({ lastSendAt: ago(X.PAYOUT_RESEND_COOLDOWN_MS + 1000), lastSendBank: 'hgcash', lastSendAccount: 'a1', lastSendResult: res });
    const g = await X._payoutResendGuard(p, 'finpro', 'f1', CBU, false);
    assert.ok(g && g.http === 409 && g.body.needsConfirm === true, res);
    assert.strictEqual(await X._payoutResendGuard(p, 'finpro', 'f1', CBU, true), null, res);
  }
});
t('después del envío salió el mismo monto al mismo CBU sin ligar (Finpro no trae nuestro id): pide confirmación', async () => {
  movements = [{ provider: 'finpro', direction: 'Outbound', amount: 999000, toCBU: CBU, status: 'done', outKind: 'unknown', createdAt: ago(200000) }];
  const p = P({ lastSendAt: ago(210000), lastSendBank: 'finpro', lastSendAccount: 'f1', lastSendResult: 'rejected', sendLog: [{ at: ago(210000) }] });
  const g = await X._payoutResendGuard(p, 'hgcash', 'a1', CBU, false);
  assert.ok(g && g.body.needsConfirm === true && /SALIÓ del banco/.test(g.body.error));
  // otro destino, otro monto, ligada a OTRO retiro o una bajada → no frena
  for (const m of [{ toCBU: '1'.repeat(22) }, { amount: 5000 }, { payoutId: 'otro' }, { outKind: 'sweep' }, { createdAt: ago(900000) }]) {
    movements = [Object.assign({ provider: 'finpro', direction: 'Outbound', amount: 999000, toCBU: CBU, status: 'done', outKind: 'unknown', createdAt: ago(200000) }, m)];
    assert.strictEqual(await X._payoutResendGuard(p, 'hgcash', 'a1', CBU, false), null, JSON.stringify(m));
  }
});
t('anotar el envío y su resultado deja el rastro en el retiro', async () => {
  await X._payoutNoteSend('p1', 'hgcash', 'a1', 'PagosGabriel');
  await X._payoutNoteResult('p1', 'unknown', 'timeout');
  assert.strictEqual(updates.length, 2);
  const s0 = updates[0].u.$set; assert.strictEqual(s0.lastSendBank, 'hgcash'); assert.strictEqual(s0.lastSendAccount, 'a1'); assert.strictEqual(s0.lastSendResult, 'sending');
  assert.strictEqual(updates[0].u.$push.sendLog.$each[0].label, 'hgcash · GRMA');
  assert.strictEqual(updates[1].u.$set.lastSendResult, 'unknown');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✅ ' + name); } catch (e) { fails++; console.log('  ❌ ' + name + '\n     ' + (e && e.message)); }
  }
  console.log(fails ? `\n❌ ${fails} fallas` : `\n✅ Todo OK (${tests.length})`);
  process.exit(fails ? 1 : 0);
})();
