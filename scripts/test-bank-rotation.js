#!/usr/bin/env node
/**
 * Test en frío de la ROTACIÓN AUTOMÁTICA de cuentas de banco (#207) — sin red ni Mongo.
 * Recorta el bloque real de server.js y lo corre con las cuentas, los movimientos y los bancos
 * simulados. Uso: node scripts/test-bank-rotation.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const a = src.indexOf('const BANK_ROT_DEFAULTS = ');
const b = src.indexOf('async function _bankRotationPayload(', a);
if (a < 0 || b < 0) throw new Error('no encuentro el bloque de rotación en server.js');
const block = src.slice(a, b).replace(/setInterval\(\(\) => \{ _bankRotationTick\(\); \}, [^\n]*\n/, '');

const cfgStore = new Map();
const alerts = [];
const down = new Set();      // ids de cuentas que no responden
const usage = {};            // id → { day, month }
const S = {
  _hgAccounts: [], _fpAccounts: [], _hgActiveKey: null, _fpActiveKey: null, shown: 'hgcash', provider: 'hgcash',
  hgEnabled: true, fpEnabled: true,
  getConfig: async (k, d) => (cfgStore.has(k.toLowerCase()) ? JSON.parse(JSON.stringify(cfgStore.get(k.toLowerCase()))) : d),
  setConfig: async (k, v) => { cfgStore.set(k.toLowerCase(), JSON.parse(JSON.stringify(v))); },
  Config: {
    async findOneAndUpdate(q, u) { const cur = cfgStore.get('bankrotationlock'); if (!cur) return null; const lim = q.$or[0]['value.at'].$lt; if (cur.at == null || cur.at < lim) { cfgStore.set('bankrotationlock', u.$set.value); return {}; } return null; },
    findOne() { return { select() { return { lean: async () => (cfgStore.has('bankrotationlock') ? {} : null) }; } }; },
    async create(d) { cfgStore.set(d.key, d.value); },
    async set(k, v) { if (k === 'bankShown') S.shown = v; if (k === 'bankProvider') S.provider = v; }
  },
  _hgAccountLabel: (x) => x.label, _fpAccountLabel: (x) => x.label,
  BankMovement: { aggregate: async (p) => { const m = p[0].$match; const id = (m.provider === 'finpro' ? 'finpro:' : 'hgcash:') + m.accountKey; return usage[id] ? [usage[id]] : []; } },
  hgcashPay: { getAccounts: async (tok) => (down.has('hgcash:' + tok.slice(2)) ? { ok: false, error: 'timeout' } : { ok: true, data: [] }) },
  finpro: { getBalance: async ({ ctx }) => (down.has('finpro:' + ctx.key) ? { ok: false, httpStatus: 503, error: 'caído' } : { ok: true, balance: 1 }) },
  _fpHasCreds: (x) => !!x.apiKey, _fpCtx: (x) => ({ key: x.key }), _fpReadyPayouts: (x) => !!x.apiKey && String(x.fromCvu || '').length === 22,
  getBankShown: async () => S.shown,
  getHgcashConfig: async () => ({ enabled: S.hgEnabled }), getFinproConfig: async () => ({ enabled: S.fpEnabled }),
  _loadHgcashCredentials: async () => {}, _loadFinproCredentials: async () => {},
  _hgActivateAccount: async (k) => { S._hgActiveKey = k; return { warnings: [] }; },
  _fpActivateAccount: async (k) => { S._fpActiveKey = k; return { warnings: [] }; },
  _bankLabel: (p) => (p === 'finpro' ? 'Finpro' : 'hgcash'), _emitHgcashUpdate: () => {}, _projectLabel: () => 'TEST',
  logger: { info() {}, warn() {}, error() {} },
  telegramAlert: { isEnabled: () => true, esc: (x) => x, send: async (t) => { alerts.push(t); } },
  __out: null
};
new Function('S', 'with (S) {\n' + block + '\n__out = { _bankRotationTick, _rotFails, getBankRotation, _rotPeriodStarts, _rotNorm }; }')(S);
const X = S.__out;

const CVU = (n) => String(n).padStart(22, '0');
function reset(cfg) {
  cfgStore.clear(); alerts.length = 0; down.clear(); X._rotFails.clear();
  for (const k of Object.keys(usage)) delete usage[k];
  S._hgAccounts = [{ key: 'a1', label: 'HG uno', token: 't-a1', cbu: '1' }, { key: 'a2', label: 'HG dos', token: 't-a2', cbu: '2' }];
  S._fpAccounts = [{ key: 'f1', label: 'FP uno', apiKey: 'k', account: '10', fromCvu: CVU(5) }];
  S._hgActiveKey = 'a1'; S._fpActiveKey = 'f1'; S.shown = 'hgcash'; S.provider = 'hgcash'; S.hgEnabled = true; S.fpEnabled = true;
  cfgStore.set('bankrotation', Object.assign({ enabled: true }, cfg || {}));
}
const tick = () => X._bankRotationTick();
let fails = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('apagada por defecto: no toca nada aunque la cuenta esté caída', async () => {
  reset(); cfgStore.delete('bankrotation'); down.add('hgcash:a1');
  for (let i = 0; i < 5; i++) await tick();
  assert.strictEqual(S._hgActiveKey, 'a1'); assert.strictEqual(alerts.length, 0);
  assert.strictEqual((await X.getBankRotation()).enabled, false);
});
t('caída: rota recién al 3er control seguido sin respuesta', async () => {
  reset(); down.add('hgcash:a1');
  await tick(); await tick();
  assert.strictEqual(S._hgActiveKey, 'a1');
  const r = await tick();
  assert.ok(r && r.ok); assert.strictEqual(S._hgActiveKey, 'a2');
  assert.strictEqual(alerts.length, 1); assert.ok(/HG uno/.test(alerts[0]) && /HG dos/.test(alerts[0]));
  assert.strictEqual(cfgStore.get('bankrotation').log[0].reason, 'failure');
});
t('una respuesta buena en el medio reinicia la cuenta de fallas', async () => {
  reset(); down.add('hgcash:a1');
  await tick(); await tick(); down.clear(); await tick(); down.add('hgcash:a1'); await tick(); await tick();
  assert.strictEqual(S._hgActiveKey, 'a1');
});
t('tope del día: rota apenas se alcanza', async () => {
  reset({ limits: { 'hgcash:a1': { day: 1000000, month: 0 } } });
  usage['hgcash:a1'] = { day: 999999, month: 999999 };
  await tick(); assert.strictEqual(S._hgActiveKey, 'a1');
  usage['hgcash:a1'] = { day: 1000000, month: 1000000 };
  const r = await tick();
  assert.ok(r.ok); assert.strictEqual(S._hgActiveKey, 'a2'); assert.ok(/tope del DÍA/.test(alerts[0]));
});
t('tope del mes y candidata también en su tope → se la saltea', async () => {
  reset({ crossBank: true, limits: { 'hgcash:a1': { day: 0, month: 500 }, 'hgcash:a2': { day: 100, month: 0 } } });
  usage['hgcash:a1'] = { day: 10, month: 500 }; usage['hgcash:a2'] = { day: 100, month: 100 };
  const r = await tick();
  assert.ok(r.ok); assert.strictEqual(S.shown, 'finpro'); assert.strictEqual(S._fpActiveKey, 'f1');
  assert.strictEqual(S.provider, 'hgcash', 'por tope NO se mueven los retiros');
});
t('sin permiso de pasar al otro banco: no rota y avisa una sola vez', async () => {
  reset({ limits: { 'hgcash:a1': { day: 1, month: 0 }, 'hgcash:a2': { day: 1, month: 0 } } });
  usage['hgcash:a1'] = { day: 5, month: 5 }; usage['hgcash:a2'] = { day: 5, month: 5 };
  const r = await tick(); await tick();
  assert.strictEqual(r.ok, false); assert.strictEqual(S._hgActiveKey, 'a1'); assert.strictEqual(S.shown, 'hgcash');
  assert.strictEqual(alerts.length, 1); assert.ok(/NO hay otra cuenta/.test(alerts[0]));
});
t('la candidata caída o pausada no se elige', async () => {
  reset({ crossBank: true }); S._hgAccounts.push({ key: 'a3', label: 'HG tres', token: 't-a3', cbu: '3' });
  S._hgAccounts[1].incomingEnabled = false; down.add('hgcash:a1'); down.add('hgcash:a3');
  await tick(); await tick(); const r = await tick();
  assert.ok(r.ok); assert.strictEqual(S.shown, 'finpro');
});
t('caída + otro banco + mover retiros: los retiros pasan también', async () => {
  reset({ crossBank: true, movePayouts: true }); S._hgAccounts = [S._hgAccounts[0]]; down.add('hgcash:a1');
  await tick(); await tick(); const r = await tick();
  assert.ok(r.ok); assert.strictEqual(S.shown, 'finpro'); assert.strictEqual(S.provider, 'finpro');
});
t('no rota hacia un banco que no recibe cargas automáticas', async () => {
  reset({ crossBank: true }); S._hgAccounts = [S._hgAccounts[0]]; S.fpEnabled = false; down.add('hgcash:a1');
  await tick(); await tick(); const r = await tick();
  assert.strictEqual(r.ok, false); assert.strictEqual(S.shown, 'hgcash');
});
t('dos rotaciones seguidas no se encadenan (5 min de espera)', async () => {
  reset({ limits: { 'hgcash:a1': { day: 1, month: 0 }, 'hgcash:a2': { day: 1, month: 0 } }, crossBank: true });
  usage['hgcash:a1'] = { day: 5, month: 5 };
  await tick(); assert.strictEqual(S._hgActiveKey, 'a2');
  usage['hgcash:a2'] = { day: 5, month: 5 };
  const r = await tick();
  assert.strictEqual(r.ok, false); assert.strictEqual(S._hgActiveKey, 'a2'); assert.strictEqual(S.shown, 'hgcash');
  cfgStore.set('bankrotationlock', { at: Date.now() - 6 * 60 * 1000 });
  await tick(); assert.strictEqual(S.shown, 'finpro');
});
t('el cliente ve una cuenta cargada a mano: no hay nada que rotar', async () => {
  reset(); S.shown = 'manual'; down.add('hgcash:a1');
  for (let i = 0; i < 4; i++) await tick();
  assert.strictEqual(S._hgActiveKey, 'a1'); assert.strictEqual(alerts.length, 0);
});
t('rota desde Finpro (la que ve el cliente) hacia otra cuenta Finpro', async () => {
  reset(); S.shown = 'finpro'; S._fpAccounts.push({ key: 'f2', label: 'FP dos', apiKey: 'k2', account: '20', fromCvu: CVU(6) }); down.add('finpro:f1');
  await tick(); await tick(); const r = await tick();
  assert.ok(r.ok); assert.strictEqual(S._fpActiveKey, 'f2'); assert.strictEqual(S._hgActiveKey, 'a1');
});
t('día y mes en hora Argentina', async () => {
  const st = X._rotPeriodStarts(Date.UTC(2026, 11, 1, 2, 30)); // 30-nov 23:30 AR
  assert.strictEqual(st.day.toISOString(), '2026-11-30T03:00:00.000Z'); assert.strictEqual(st.month.toISOString(), '2026-11-01T03:00:00.000Z');
});
t('config: topes inválidos se descartan', async () => {
  const c = X._rotNorm({ enabled: 'si', failChecks: 99, limits: { 'hgcash:a1': { day: -5, month: 'x' }, 'otro:a1': { day: 5 }, 'finpro:f1': { day: 10.4 } } });
  assert.strictEqual(c.enabled, false); assert.strictEqual(c.failChecks, 10); assert.deepStrictEqual(c.limits, { 'finpro:f1': { day: 10, month: 0 } });
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✅ ' + name); } catch (e) { fails++; console.log('  ❌ ' + name + '\n     ' + (e && e.message)); }
  }
  console.log(fails ? `\n❌ ${fails} fallas` : `\n✅ Todo OK (${tests.length})`);
  process.exit(fails ? 1 : 0);
})();
