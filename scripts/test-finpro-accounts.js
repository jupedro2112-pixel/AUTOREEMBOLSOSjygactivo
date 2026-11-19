#!/usr/bin/env node
/**
 * Test en frío de las CUENTAS FINPRO (#202) — sin red, sin Mongo, sin node_modules.
 *
 * Recorta de server.js el bloque de Finpro (cuentas, webhooks, verificación) y el de los
 * endpoints del panel (bancos + cuentas), y los corre en un sandbox con Config / modelos en
 * memoria y la API de Finpro simulada. Verifica lo que más duele si falla:
 *   • alta de cuentas (prueba antes de guardar, cifrado, tope de 3, CVU repetido)
 *   • rotación de la cuenta EN USO y qué ve el cliente (Config['cbu'] según bankShown)
 *   • webhooks: firma por cuenta, cuenta por CVU, pausa / "solo la en uso", reentregas
 *   • verificación de comprobantes contra TODAS las cuentas que reciben
 *   • "Bancos automáticos": validaciones y llaves que escribe
 *
 * Uso: node scripts/test-finpro-accounts.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
function cut(from, to) {
  const a = src.indexOf(from); const b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error('no encuentro el bloque: ' + from.slice(0, 40) + ' … ' + to.slice(0, 40));
  return src.slice(a, b);
}
const core = cut('const FINPRO_DEFAULTS = ', "app.post('/api/hgcash/webhook'");
const admin = cut('async function _banksPayload() {', "app.get('/api/admin/hgcash/config'");
const statusHandler = cut('async function handlePayoutStatusWebhook(p, provider) {', '// Avisa al panel (en vivo) que hubo un cambio en los movimientos hgcash');
const pay = cut('const _finproLastProcessByCvu = ', "app.post('/api/admin/payouts/:id/pay'");

// ───────────────────────── dobles ─────────────────────────
// En Tails no hay node_modules: si faltan axios/winston se stubean (acá no se usa la red ni el log).
const Module = require('module');
const _origLoad = Module._load;
const noop = () => {};
Module._load = function (request) {
  if (request === '../utils/logger') return { info: noop, warn: noop, error: noop, debug: noop }; // logger (winston) no hace falta acá
  try { return _origLoad.apply(this, arguments); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && request === 'axios') return function () { throw new Error('sin red en el test'); };
    throw e;
  }
};
const realFinpro = require(path.join(ROOT, 'src/services/finproService.js'));
const calls = [];
const world = { tokens: {}, balances: {}, holders: {}, incoming: {} }; // por apiKey
const finpro = Object.assign({}, realFinpro, {
  async getClientToken({ ctx } = {}) { const k = ctx && ctx.creds && ctx.creds.apiKey; calls.push(['token', k]); return world.tokens[k] ? { ok: true, token: 't-' + k } : { ok: false, httpStatus: 401, error: 'credenciales inválidas' }; },
  async getBalance({ account, ctx } = {}) { const k = ctx && ctx.creds && ctx.creds.apiKey; calls.push(['balance', k, account]); const b = world.balances[k]; return b == null ? { ok: false, httpStatus: 404, error: 'cuenta inexistente' } : { ok: true, balance: b, available: b, currency: 'ARS' }; },
  async getAccountInformation({ cvu, ctx } = {}) { calls.push(['info', ctx && ctx.creds && ctx.creds.apiKey, cvu]); const h = world.holders[cvu]; return h ? { ok: true, found: true, nombre: h, cuit: '20111111112' } : { ok: true, found: false }; },
  async lookupPayerCached({ cvu } = {}) { const h = world.holders[cvu]; return h ? { found: true, nombre: h, cuit: '20999999993' } : { found: false, error: 'no encontrado' }; },
  async createCvuTransfer(a = {}) { const k = a.ctx && a.ctx.creds && a.ctx.creds.apiKey; calls.push(['transfer', k, a.processId, a.fromCvu, a.toCvu, a.amount]); return world.transfer ? world.transfer(a) : { accepted: true, code: '0201', httpStatus: 200 }; },
  async getProcessStatus(ids, { ctx } = {}) { const k = ctx && ctx.creds && ctx.creds.apiKey; calls.push(['status', k, ids[0]]); return world.status ? world.status(ids[0], k) : { ok: true, status: 'finished', finished: true, successCount: 0, failCount: 0, notFound: false }; }, // por defecto: el lote anterior ya terminó (no hay espera)
  async getProcessResult(id, { ctx } = {}) { const k = ctx && ctx.creds && ctx.creds.apiKey; calls.push(['result', k, id]); return world.result ? world.result(id, k) : { ok: true, transactions: [] }; },
  async verifyIncoming(q = {}) { const k = q.ctx && q.ctx.creds && q.ctx.creds.apiKey; calls.push(['verify', k, q.coelsaId || q.amount]); return (world.incoming[k] || (() => ({ ok: true, status: 'not_found_yet' })))(q); }
});

const configStore = new Map();
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
async function getConfig(key, def) { return configStore.has(key) ? clone(configStore.get(key)) : def; }
async function setConfig(key, value) { configStore.set(key, clone(value)); }
const Config = { set: async (k, v) => setConfig(k, v), findOne: () => ({ lean: async () => null }) };

function memModel(name) {
  const rows = [];
  const match = (r, q) => Object.keys(q || {}).every((k) => {
    if (k === '$or') return q.$or.some((s) => match(r, s));
    const want = q[k]; const got = r[k] === undefined ? null : r[k];
    if (want && typeof want === 'object' && !(want instanceof Date)) {
      if ('$in' in want) return want.$in.includes(got);
      if ('$ne' in want) return got !== want.$ne;
      if ('$nin' in want) return !want.$nin.includes(got);
      if ('$gte' in want || '$lte' in want || '$lt' in want || '$gt' in want) return true;
      return true;
    }
    return got === want;
  });
  const chain = (val) => { const c = { select: () => c, sort: () => c, limit: () => c, lean: async () => clone(val), then: (ok, ko) => Promise.resolve(clone(val)).then(ok, ko) }; return c; };
  const apply = (r, upd) => {
    if (upd.$set) Object.assign(r, upd.$set);
    if (upd.$addToSet) for (const k of Object.keys(upd.$addToSet)) { r[k] = r[k] || []; if (!r[k].includes(upd.$addToSet[k])) r[k].push(upd.$addToSet[k]); }
    if (upd.$inc) for (const k of Object.keys(upd.$inc)) r[k] = (r[k] || 0) + upd.$inc[k];
  };
  return {
    rows, name,
    async create(doc) { if (doc.movementId && rows.some((r) => r.movementId === doc.movementId)) throw Object.assign(new Error('dup'), { code: 11000 }); rows.push(clone(doc)); return doc; },
    findOne(q) { return chain(rows.find((r) => match(r, q)) || null); },
    find(q) { return chain(rows.filter((r) => match(r, q))); },
    async updateOne(q, upd) { const r = rows.find((x) => match(x, q)); if (r) { apply(r, upd); r.updatedAt = new Date(); } return { modifiedCount: r ? 1 : 0, matchedCount: r ? 1 : 0 }; },
    async findOneAndUpdate(q, upd) { const r = rows.find((x) => match(x, q)); if (r) apply(r, upd); return r ? clone(r) : null; },
    async countDocuments(q) { return rows.filter((r) => match(r, q)).length; }
  };
}
const BankMovement = memModel('BankMovement');
const PendingPayout = memModel('PendingPayout');
const Comprobante = memModel('Comprobante');

const routes = {};
const reg = (m) => (p, ...h) => { routes[m + ' ' + p] = h[h.length - 1]; };
const app = { get: reg('GET'), post: reg('POST'), delete: reg('DELETE') };
const KEY = crypto.createHash('sha256').update('test-secret').digest();
const matched = [];
const hgCalls = [];
const logs = [];
const notes = [];
const charged = [];
const paidNotified = [];
const log = (lvl) => (m) => { logs.push(lvl + ' ' + m); };

const stubs = {
  require, console, process, Buffer, crypto, Promise, Object, Array, String, Number, Boolean, Date, Math, JSON, Map, Set, RegExp, Error, Symbol, isNaN, parseInt, parseFloat, encodeURIComponent, undefined,
  setTimeout: (fn, ms) => { if (ms <= 5000) setImmediate(fn); return 0; }, setInterval: () => 0, // las esperas cortas corren ya; los crons no
  uuidv4: () => crypto.randomUUID(), _pollPayingPayouts: () => {}, _emitAdminOnlyChatNote: async (...a) => { notes.push(a[2]); },
  _deductChipsAtConfirm: async () => ({ ok: true }), clearTimeout: () => {}, clearInterval: () => {},
  finpro, app, getConfig, setConfig, Config, BankMovement, PendingPayout, Comprobante,
  logger: { info: log('I'), warn: log('W'), error: log('E'), debug: () => {} },
  rateLimit: () => (req, res, next) => next && next(), makeRateStore: () => null,
  authMiddleware: null, adminMiddleware: null,
  getPublicBaseUrl: () => 'https://test.example',
  _credKey: () => KEY,
  _credEncrypt: (s) => 'enc:' + Buffer.from(String(s)).toString('base64'),
  _credDecrypt: (s) => { if (!String(s).startsWith('enc:')) throw new Error('no descifra'); return Buffer.from(String(s).slice(4), 'base64').toString(); },
  _bankFromKey: (s) => (s ? String(s).toUpperCase().replace(/[^A-Z]/g, '') : null),
  _emitHgcashUpdate: () => {},
  _bankCanView: (req) => ['admin', 'depositor', 'withdrawer'].includes(req.user.role),
  hgcashMatchFromMovement: async (m) => { matched.push(m.movementId); },
  notifyPayoutPaid: async (p) => { paidNotified.push(p.id); }, maybeSendPayoutReceipt: async () => {}, _handleSweepStatusWebhook: async () => {}, BankSweep: { findOne: () => ({ select: () => ({ lean: async () => null }) }) },
  getHgcashConfig: async () => Object.assign({ enabled: false, mode: 'shadow', accountName: 'HG SA', cbu: '' }, (await getConfig('hgcash', null)) || {}),
  hgcashPay: { getTokenSource: () => 'none', isEnabled: () => false },
  _hgcashWebhookSecrets: () => [], _hgActiveAccount: () => null, _hgAccountLabel: (a) => (a && a.label) || '', _hgAccounts: [],
  _hgApplyActiveToConfigs: async () => [],
  _amountsEqual: (a, b) => Math.abs(Number(a) - Number(b)) < 0.005,
  _digits: (x) => String(x || '').replace(/\D/g, ''),
  _nameMatch: (a, b) => String(a || '').toUpperCase().trim() === String(b || '').toUpperCase().trim(),
  _cbuSameAccount: (a, b) => { const da = String(a || '').replace(/\D/g, ''), db = String(b || '').replace(/\D/g, ''); const n = Math.min(da.length, db.length); return n < 6 ? null : da.slice(-n) === db.slice(-n); },
  telegramAlert: { isEnabled: () => false, send: async () => {}, esc: (x) => x },
  hgcashAutoCarga: async (a) => { charged.push([a.movement.movementId, a.mode]); return { ok: true }; }
};
const missing = new Set();
const sandbox = new Proxy(stubs, {
  has: (_t, k) => typeof k === 'string',
  get: (t, k) => { if (k === Symbol.unscopables) return undefined; if (k in t) return t[k]; if (typeof k === 'string' && k in globalThis) return globalThis[k]; missing.add(String(k)); throw new ReferenceError('[sandbox] falta el doble de: ' + String(k)); }
});
const EXPORT = ['_loadFinproCredentials', '_fpList', '_fpActiveAccount', '_fpAccountByKey', '_fpAccountReceives', '_fpReceivingAccounts', '_fpCtxFor', '_fpMovementAutoOff', '_fpAccountForCvu',
  '_finproVerifyAcross', '_fpWebhookSecretEntries', '_finproWebhookStats', '_fpAccountLabelFor', '_fpActivateAccount', 'getBankProvider', 'getBankShown', 'getFinproConfig', '_payPayoutViaFinpro', '_finproSyncPayout', '_finproVerifyComprobante', 'handlePayoutStatusWebhook'];
// eslint-disable-next-line no-new-func
const boot = new Function('sandbox', '__out', 'with (sandbox) {\n' + core + '\n' + admin + '\n' + pay + '\n' + statusHandler + '\n__out({' + EXPORT.map((n) => n + ': typeof ' + n + ' !== "undefined" ? ' + n + ' : undefined').join(', ') + '});\n}');
let X = null;
stubs.__out = (o) => { X = o; }; // dentro del `with` todo nombre libre se resuelve en el sandbox
boot(sandbox, stubs.__out);

// ───────────────────────── utilidades ─────────────────────────
function mkRes() { const r = { code: 200, body: null, headersSent: false, status(c) { r.code = c; return r; }, json(b) { r.body = b; r.headersSent = true; return r; } }; return r; }
async function call(route, { body, params, query, role = 'admin', headers, rawBody } = {}) {
  const h = routes[route]; if (!h) throw new Error('ruta no registrada: ' + route);
  const hd = {}; for (const k of Object.keys(headers || {})) hd[k.toLowerCase()] = headers[k];
  const res = mkRes();
  await h({ body: body || {}, params: params || {}, query: query || {}, user: { role, username: 'tester', userId: 'u1' }, ip: '1.2.3.4', rawBody, get: (n) => hd[String(n).toLowerCase()] }, res);
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  return res;
}
function signed(payload, secret) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', secret).update(ts + '.').update(raw).digest('hex');
  return { body: payload, rawBody: raw, headers: { 'X-Webhook-Timestamp': ts, 'X-Webhook-Signature': sig } };
}
const CVU1 = '0000001100000000000011', CVU2 = '0000002200000000000022', CVU3 = '0000003300000000000033', CVUX = '0000009900000000000099', PAYER = '0000007700000000000077';
const SEC1 = 'secreto-webhook-cuenta-uno-1', SEC2 = 'secreto-webhook-cuenta-dos-2';
let nId = 0;
const incomingEvt = (toCvu, amount, coelsa) => ({ webhook_type: 'notification', notification_type: 'transfer', notification_id: 'n' + (++nId), transaction_data: { transfer_type: 'E', amount, coelsa_id: coelsa, cbu_from: PAYER, cbu_to: toCvu, created_at: new Date().toISOString() } });

let pass = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('sin cuentas: nada cargado y los bancos por defecto', async () => {
  await X._loadFinproCredentials();
  assert.strictEqual(X._fpList().length, 0);
  assert.strictEqual(await X.getBankProvider(), 'hgcash');
  assert.strictEqual(await X.getBankShown(), 'hgcash');
  const r = await call('GET /api/admin/banks');
  assert.strictEqual(r.body.incoming, 'none'); assert.strictEqual(r.body.payouts, 'hgcash');
});
t('alta: credenciales malas NO se guardan', async () => {
  const r = await call('POST /api/admin/finpro/accounts', { body: { label: 'Finpro 1', apiKey: 'k-mala', apiSecret: 's1', fromCvu: CVU1 } });
  assert.strictEqual(r.code, 400); assert.ok(/rechazó/.test(r.body.error));
  assert.strictEqual(configStore.has('finproAccounts'), false);
});
t('alta: validaciones de forma (CVU, secreto corto, URL, rol)', async () => {
  world.tokens.k1 = true; world.balances.k1 = 1000; world.holders[CVU1] = 'TITULAR UNO SA';
  const base = { label: 'Finpro 1', apiKey: 'k1', apiSecret: 's1' };
  assert.strictEqual((await call('POST /api/admin/finpro/accounts', { body: Object.assign({}, base, { fromCvu: '123' }) })).code, 400);
  assert.strictEqual((await call('POST /api/admin/finpro/accounts', { body: Object.assign({}, base, { webhookSecret: 'corto' }) })).code, 400);
  assert.strictEqual((await call('POST /api/admin/finpro/accounts', { body: Object.assign({}, base, { baseUrl: 'http://inseguro.example' }) })).code, 400);
  assert.strictEqual((await call('POST /api/admin/finpro/accounts', { body: base, role: 'depositor' })).code, 403);
  assert.strictEqual(configStore.has('finproAccounts'), false);
});
t('alta de la primera cuenta: queda EN USO, cifrada y con titular', async () => {
  const r = await call('POST /api/admin/finpro/accounts', { body: { label: 'Finpro 1', apiKey: 'k1', apiSecret: 'api-secret-largo-de-la-uno', webhookSecret: SEC1, fromCvu: CVU1, account: '1001', alias: 'uno.alias', bank: 'Finpro' } });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.key, 'f1'); assert.strictEqual(r.body.activeKey, 'f1');
  assert.strictEqual(r.body.balance.available, 1000); assert.strictEqual(r.body.holder.nombre, 'TITULAR UNO SA');
  const stored = JSON.stringify(configStore.get('finproAccounts'));
  assert.ok(!stored.includes('api-secret-largo-de-la-uno'), 'secret en claro'); assert.ok(!stored.includes(SEC1), 'secreto webhook en claro'); assert.ok(!/"apiKeyEnc":"k1"/.test(stored), 'key en claro');
  const pub = r.body.accounts[0];
  assert.ok(pub.active && pub.hasCreds && pub.hasWebhookSecret && pub.receives && pub.readyPayouts);
  assert.ok(!JSON.stringify(r.body).includes(SEC1), 'la respuesta no devuelve secretos');
});
t('segunda y tercera cuenta; la cuarta se rechaza; CVU repetido se rechaza', async () => {
  world.tokens.k2 = true; world.balances.k2 = 2000; world.holders[CVU2] = 'TITULAR DOS SRL';
  world.tokens.k3 = true; world.balances.k3 = 3000;
  let r = await call('POST /api/admin/finpro/accounts', { body: { label: 'Finpro dup', apiKey: 'k2', apiSecret: 's2', fromCvu: CVU1 } });
  assert.strictEqual(r.code, 400); assert.ok(/ya está cargado/.test(r.body.error));
  r = await call('POST /api/admin/finpro/accounts', { body: { label: 'Finpro 2', apiKey: 'k2', apiSecret: 's2', webhookSecret: SEC2, fromCvu: CVU2, account: '2002', alias: 'dos.alias' } });
  assert.strictEqual(r.body.key, 'f2'); assert.strictEqual(r.body.activeKey, 'f1', 'la nueva queda de respaldo');
  r = await call('POST /api/admin/finpro/accounts', { body: { label: 'Finpro 3', apiKey: 'k3', apiSecret: 's3', fromCvu: CVU3, account: '3003' } });
  assert.strictEqual(r.body.key, 'f3');
  assert.ok(r.body.warnings.some((w) => /secreto de firma/.test(w)), 'avisa que sin secreto no llegan solas');
  world.tokens.k4 = true;
  r = await call('POST /api/admin/finpro/accounts', { body: { label: 'Finpro 4', apiKey: 'k4', apiSecret: 's4' } });
  assert.strictEqual(r.code, 400); assert.ok(/Máximo 3/.test(r.body.error));
  assert.strictEqual(X._fpList().length, 3);
});
t('editar sin reescribir secretos conserva los guardados', async () => {
  const r = await call('POST /api/admin/finpro/accounts', { body: { key: 'f2', label: 'Finpro DOS', fromCvu: CVU2, account: '2002', alias: 'dos.alias' } });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  const a = X._fpAccountByKey('f2');
  assert.strictEqual(a.label, 'Finpro DOS'); assert.strictEqual(a.apiKey, 'k2'); assert.strictEqual(a.webhookSecret, SEC2);
});
t('contexto por cuenta: cada pago consulta con SU cuenta', async () => {
  const c1 = X._fpCtxFor('f1'), c2 = X._fpCtxFor('f2');
  assert.ok(c1.ok && c2.ok);
  assert.strictEqual(c1.ctx.creds.apiKey, 'k1'); assert.strictEqual(c2.ctx.creds.apiKey, 'k2'); assert.strictEqual(c2.ctx.fromCvu, CVU2);
  assert.strictEqual(X._fpCtxFor('f9').ok, false, 'una cuenta que ya no existe no cae en otra');
});
t('bancos: validaciones y llaves que escribe', async () => {
  let r = await call('POST /api/admin/banks', { body: { incoming: 'raro', payouts: 'hgcash' } });
  assert.strictEqual(r.code, 400);
  r = await call('POST /api/admin/banks', { body: { incoming: 'both', payouts: 'finpro', shown: 'finpro' }, role: 'depositor' });
  assert.strictEqual(r.code, 403);
  r = await call('POST /api/admin/banks', { body: { incoming: 'both', payouts: 'finpro', shown: 'finpro' } });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.incoming, 'both'); assert.strictEqual(r.body.payouts, 'finpro'); assert.strictEqual(r.body.shown, 'finpro');
  assert.strictEqual(configStore.get('hgcash').enabled, true); assert.strictEqual(configStore.get('finpro').enabled, true);
  assert.strictEqual(configStore.get('bankProvider'), 'finpro');
  const cbu = configStore.get('cbu');
  assert.strictEqual(cbu.number, CVU1); assert.strictEqual(cbu.alias, 'uno.alias'); assert.strictEqual(cbu.titular, 'TITULAR UNO SA');
  assert.ok(r.body.warnings.some((w) => /Finpro 3/.test(w)), 'avisa de la cuenta sin secreto');
});
t('USAR ESTA: rota la cuenta en uso y cambia lo que ve el cliente', async () => {
  const r = await call('POST /api/admin/finpro/accounts/:key/activate', { params: { key: 'f2' }, role: 'withdrawer' });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  assert.strictEqual(X._fpActiveAccount().key, 'f2');
  assert.strictEqual(configStore.get('cbu').number, CVU2); assert.strictEqual(configStore.get('cbu').alias, 'dos.alias');
  assert.strictEqual((await call('POST /api/admin/finpro/accounts/:key/activate', { params: { key: 'f9' } })).code, 404);
});
t('si el cliente ve hgcash, rotar Finpro NO toca el CBU', async () => {
  await call('POST /api/admin/banks', { body: { incoming: 'both', payouts: 'finpro', shown: 'manual' } });
  await setConfig('cbu', { bank: 'X', titular: 'MANUAL', number: '1'.repeat(22), alias: 'manual' });
  await call('POST /api/admin/finpro/accounts/:key/activate', { params: { key: 'f1' } });
  assert.strictEqual(configStore.get('cbu').titular, 'MANUAL');
  assert.strictEqual(X._fpActiveAccount().key, 'f1');
});
t('webhook: firma inválida → 401; sin firma → 401', async () => {
  const ev = incomingEvt(CVU1, 5000, 'COELSAAAA1');
  let r = await call('POST /api/finpro/webhook', signed(ev, 'otro-secreto-cualquiera-xx'));
  assert.strictEqual(r.code, 401);
  r = await call('POST /api/finpro/webhook', { body: ev, rawBody: Buffer.from(JSON.stringify(ev)) });
  assert.strictEqual(r.code, 401);
  assert.strictEqual(BankMovement.rows.length, 0);
});
t('webhook entrante a la cuenta EN USO: crea movimiento con su cuenta y lo manda a matchear', async () => {
  const r = await call('POST /api/finpro/webhook', signed(incomingEvt(CVU1, 5000, 'COELSAAAA1'), SEC1));
  assert.strictEqual(r.code, 200);
  assert.strictEqual(BankMovement.rows.length, 1);
  const m = BankMovement.rows[0];
  assert.strictEqual(m.provider, 'finpro'); assert.strictEqual(m.accountKey, 'f1'); assert.strictEqual(m.amount, 5000); assert.strictEqual(m.matchStatus, 'pending');
  assert.deepStrictEqual(matched, [m.movementId]);
  assert.strictEqual(X._fpMovementAutoOff(m), null);
});
t('webhook entrante a la cuenta de RESPALDO: entra igual (la cuenta sale del CVU, no de la firma)', async () => {
  // Finpro firma con el secreto de la cuenta 1 pero la plata fue al CVU de la 2.
  const r = await call('POST /api/finpro/webhook', signed(incomingEvt(CVU2, 7000, 'COELSABBB2'), SEC1));
  assert.strictEqual(r.code, 200);
  const m = BankMovement.rows.find((x) => x.coelsaCode === 'COELSABBB2');
  assert.strictEqual(m.accountKey, 'f2');
  assert.strictEqual(X._fpMovementAutoOff(m), null);
  assert.deepStrictEqual(X._fpAccountLabelFor(m), { key: 'f2', label: 'Finpro DOS', active: false, bank: 'finpro' });
});
t('reentrega del mismo aviso y mismo COELSA con otro id: NO duplica', async () => {
  const before = BankMovement.rows.length; const m0 = matched.length;
  const ev = incomingEvt(CVU1, 5000, 'COELSAAAA1');
  await call('POST /api/finpro/webhook', signed(ev, SEC1));
  await call('POST /api/finpro/webhook', signed(ev, SEC1));
  assert.strictEqual(BankMovement.rows.length, before); assert.strictEqual(matched.length, m0, 'no se vuelve a matchear');
});
t('pausar una cuenta: su movimiento se registra pero queda con la auto-carga apagada', async () => {
  let r = await call('POST /api/admin/finpro/accounts/:key/incoming', { params: { key: 'f2' }, body: { enabled: false }, role: 'depositor' });
  assert.strictEqual(r.code, 200);
  await call('POST /api/finpro/webhook', signed(incomingEvt(CVU2, 900, 'COELSACCC3'), SEC2));
  const m = BankMovement.rows.find((x) => x.coelsaCode === 'COELSACCC3');
  assert.ok(m, 'se registra en el libro');
  assert.ok(/PAUSADA/.test(X._fpMovementAutoOff(m)));
  assert.strictEqual(X._fpAccountReceives(X._fpAccountByKey('f2')), false);
  r = await call('POST /api/admin/finpro/accounts/:key/incoming', { params: { key: 'f2' }, body: { enabled: true } });
  assert.strictEqual(X._fpMovementAutoOff(m), null);
});
t('modo "solo la cuenta en uso": las de respaldo dejan de cargar solas', async () => {
  await call('POST /api/admin/finpro/accounts/incoming-mode', { body: { mode: 'active' } });
  assert.deepStrictEqual(X._fpReceivingAccounts().map((a) => a.key), ['f1']);
  assert.ok(/solo carga la cuenta Finpro en uso/.test(X._fpMovementAutoOff({ provider: 'finpro', accountKey: 'f2' })));
  assert.strictEqual(X._fpMovementAutoOff({ provider: 'finpro', accountKey: 'f1' }), null);
  await call('POST /api/admin/finpro/accounts/incoming-mode', { body: { mode: 'all' } });
  assert.strictEqual(X._fpReceivingAccounts().length, 3);
});
t('entrante a un CVU que no es nuestro: al libro como ignorado, sin matchear', async () => {
  const m0 = matched.length;
  await call('POST /api/finpro/webhook', signed(incomingEvt(CVUX, 1234, 'COELSAXXX9'), SEC1));
  const m = BankMovement.rows.find((x) => x.coelsaCode === 'COELSAXXX9');
  assert.ok(m); assert.strictEqual(m.matchStatus, 'ignored'); assert.strictEqual(matched.length, m0);
});
t('verificación de comprobante: pregunta a todas las cuentas y devuelve la que confirma', async () => {
  world.incoming.k2 = (q) => ({ ok: true, status: 'confirmed', matchedBy: 'coelsa', confidence: 'high', notification: { id: 'v1', amount: 4321, coelsaId: q.coelsaId, toCvu: CVU2 } });
  calls.length = 0;
  const r = await X._finproVerifyAcross({ kind: 'coelsa_id', coelsaId: 'COELSAVVV7' }, X._fpReceivingAccounts());
  assert.strictEqual(r.status, 'confirmed'); assert.strictEqual(r.acct.key, 'f2');
  assert.ok(calls.some((c) => c[0] === 'verify' && c[1] === 'k1') && calls.some((c) => c[0] === 'verify' && c[1] === 'k2'));
});
t('verificación: dos cuentas confirman transferencias DISTINTAS → ambigua (no se carga)', async () => {
  world.incoming.k1 = () => ({ ok: true, status: 'confirmed', matchedBy: 'amount', confidence: 'medium', notification: { id: 'vA', amount: 100, coelsaId: 'AAA', toCvu: CVU1 } });
  world.incoming.k2 = () => ({ ok: true, status: 'confirmed', matchedBy: 'amount', confidence: 'medium', notification: { id: 'vB', amount: 100, coelsaId: 'BBB', toCvu: CVU2 } });
  const r = await X._finproVerifyAcross({ kind: 'amount', amount: 100, occurredAt: new Date(), windowMinutes: 180 }, X._fpReceivingAccounts());
  assert.strictEqual(r.status, 'ambiguous');
  delete world.incoming.k1; delete world.incoming.k2;
});
t('borrar: no la EN USO, no con pagos en curso; la de respaldo sí', async () => {
  let r = await call('DELETE /api/admin/finpro/accounts/:key', { params: { key: 'f1' } });
  assert.strictEqual(r.code, 400); assert.ok(/EN USO/.test(r.body.error));
  PendingPayout.rows.push({ id: 'p1', status: 'paying', paidVia: 'finpro', fpAccountKey: 'f3' });
  r = await call('DELETE /api/admin/finpro/accounts/:key', { params: { key: 'f3' } });
  assert.strictEqual(r.code, 400); assert.ok(/EN PROCESO/.test(r.body.error));
  PendingPayout.rows[0].status = 'paid';
  r = await call('DELETE /api/admin/finpro/accounts/:key', { params: { key: 'f3' }, role: 'depositor' });
  assert.strictEqual(r.code, 403);
  r = await call('DELETE /api/admin/finpro/accounts/:key', { params: { key: 'f3' } });
  assert.strictEqual(r.code, 200); assert.strictEqual(X._fpList().length, 2);
  assert.strictEqual(X._fpCtxFor('f3').ok, false);
});
t('pasar los retiros a Finpro exige cuenta en uso con CVU; hgcash siempre se puede', async () => {
  let r = await call('POST /api/admin/bank-provider', { body: { provider: 'hgcash' } });
  assert.strictEqual(r.code, 200); assert.strictEqual(await X.getBankProvider(), 'hgcash');
  r = await call('POST /api/admin/bank-provider', { body: { provider: 'finpro' } });
  assert.strictEqual(r.code, 200); assert.strictEqual(await X.getBankProvider(), 'finpro');
  r = await call('POST /api/admin/bank-provider', { body: { provider: 'otro' } });
  assert.strictEqual(r.code, 400);
});
t('callback de un retiro: sin firma válida NUNCA decide desde el payload', async () => {
  PendingPayout.rows.push({ id: 'p2', status: 'paying', paidVia: 'finpro', fpAccountKey: 'f1', fpProcessId: 'aaaaaaaa-1111-2222-3333-444444444444', fpTransactionId: 'TX000000001' });
  const body = { process_id: 'aaaaaaaa-1111-2222-3333-444444444444', status: 'completed', data: [{ transaction_id: 'TX000000001', response_code: '0000', coelsa_id: 'COELSAPAY1' }] };
  hgCalls.length = 0;
  await call('POST /api/finpro/callback', { body, rawBody: Buffer.from(JSON.stringify(body)) });
  assert.strictEqual(PendingPayout.rows.find((x) => x.id === 'p2').status, 'paying', 'sin firma no se marca pagado desde el aviso');
  await call('POST /api/finpro/callback', signed(body, 'secreto-trucho-de-un-tercero'));
  assert.strictEqual(PendingPayout.rows.find((x) => x.id === 'p2').status, 'paying', 'con firma inválida tampoco');
  // Aviso firmado de OTRO lote (uno anterior de este mismo pago): tampoco decide.
  await call('POST /api/finpro/callback', signed(Object.assign({}, body, { process_id: 'bbbbbbbb-1111-2222-3333-444444444444', transaction_id: 'TX000000001' }), SEC1));
  assert.strictEqual(PendingPayout.rows.find((x) => x.id === 'p2').status, 'paying', 'un lote que no es el vigente no decide');
});
t('callback firmado del lote vigente: marca PAGADO por Finpro con su COELSA', async () => {
  const body = { process_id: 'aaaaaaaa-1111-2222-3333-444444444444', status: 'completed', data: [{ transaction_id: 'TX000000001', response_code: '0000', coelsa_id: 'COELSAPAY1' }] };
  await call('POST /api/finpro/callback', signed(body, SEC2)); // firma de CUALQUIER cuenta cargada
  const p2 = PendingPayout.rows.find((x) => x.id === 'p2');
  assert.strictEqual(p2.status, 'paid'); assert.strictEqual(p2.fpCoelsaId, 'COELSAPAY1'); assert.ok(paidNotified.includes('p2'), 'se le avisa al cliente');
});

// ───────────────────────── pago de retiros por Finpro ─────────────────────────
const DEST = '0000005500000000000055';
const payReq = (id) => ({ params: { id }, user: { role: 'withdrawer', username: 'cajero', userId: 'w1' }, body: {} });
async function payCall(id) { const res = mkRes(); await X._payPayoutViaFinpro(payReq(id), res); return res; }
const newPayout = (id, extra) => { const r = Object.assign({ id, userId: 'u-' + id, username: 'cli_' + id, amount: 15000, cbu: DEST, status: 'pending_review', deductAtPay: false, updatedAt: new Date() }, extra || {}); PendingPayout.rows.push(r); return r; };
const row = (id) => PendingPayout.rows.find((x) => x.id === id);
const transfers = () => calls.filter((c) => c[0] === 'transfer');

t('pago: sale por la cuenta EN USO y el pago recuerda su cuenta', async () => {
  assert.strictEqual(X._fpActiveAccount().key, 'f1');
  newPayout('w10'); calls.length = 0;
  const r = await payCall('w10');
  assert.strictEqual(r.code, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.status, 'paying');
  const tr = transfers(); assert.strictEqual(tr.length, 1);
  assert.strictEqual(tr[0][1], 'k1'); assert.strictEqual(tr[0][3], CVU1); assert.strictEqual(tr[0][4], DEST); assert.strictEqual(tr[0][5], 15000);
  const p = row('w10');
  assert.strictEqual(p.status, 'paying'); assert.strictEqual(p.paidVia, 'finpro'); assert.strictEqual(p.fpAccountKey, 'f1'); assert.strictEqual(p.fpAccepted, true); assert.strictEqual(p.fpProcessId, tr[0][2]);
});
t('pago: un segundo clic NO manda otra transferencia', async () => {
  calls.length = 0;
  const r = await payCall('w10');
  assert.strictEqual(r.code, 400); assert.strictEqual(transfers().length, 0);
});
t('pago: tras ROTAR la cuenta, el estado se consulta con la cuenta que pagó', async () => {
  await call('POST /api/admin/finpro/accounts/:key/activate', { params: { key: 'f2' } });
  assert.strictEqual(X._fpActiveAccount().key, 'f2');
  const p = row('w10');
  world.status = () => ({ ok: true, status: 'finished', finished: true, successCount: 1, failCount: 0 });
  world.result = () => ({ ok: true, transactions: [{ transactionId: p.fpTransactionId, coelsaId: 'COELSAW10', responseCode: '0000' }] });
  calls.length = 0; hgCalls.length = 0;
  const r = await X._finproSyncPayout(clone(p), 'test');
  assert.strictEqual(r.status, 'paid');
  assert.ok(calls.filter((c) => c[0] === 'status' || c[0] === 'result').every((c) => c[1] === 'k1'), 'consulta con k1 aunque la cuenta en uso sea la 2');
  assert.strictEqual(row('w10').status, 'paid'); assert.strictEqual(row('w10').fpCoelsaId, 'COELSAW10');
  world.status = null; world.result = null;
});
t('pago: el nuevo sale por la cuenta 2 (la que está en uso ahora)', async () => {
  newPayout('w11'); calls.length = 0;
  const r = await payCall('w11');
  assert.strictEqual(r.code, 200);
  const tr = transfers(); assert.strictEqual(tr[0][1], 'k2'); assert.strictEqual(tr[0][3], CVU2);
  assert.strictEqual(row('w11').fpAccountKey, 'f2');
});
t('pago SIN RESPUESTA de Finpro: queda en proceso y NO se reenvía a ciegas', async () => {
  newPayout('w12'); calls.length = 0;
  world.transfer = () => ({ accepted: false, network: true, error: 'timeout', httpStatus: 0 });
  const r = await payCall('w12');
  assert.strictEqual(r.code, 200); assert.strictEqual(r.body.status, 'paying');
  const p = row('w12');
  assert.strictEqual(p.status, 'paying'); assert.strictEqual(p.fpAccepted, null); assert.strictEqual(p.hgStatus, 'sin_respuesta');
  world.transfer = null;
  // Finpro todavía no conoce el proceso y el envío es reciente → sigue en proceso (no se da por fallado).
  world.status = () => ({ ok: true, notFound: true, finished: false });
  hgCalls.length = 0;
  let s1 = await X._finproSyncPayout(Object.assign(clone(p), { updatedAt: new Date() }), 'test');
  assert.strictEqual(s1.status, 'paying'); assert.strictEqual(row('w12').status, 'paying');
  // Pasado el margen y Finpro sigue sin conocerlo → falló (reintentable).
  s1 = await X._finproSyncPayout(Object.assign(clone(p), { updatedAt: new Date(Date.now() - 5 * 60 * 1000) }), 'test');
  assert.strictEqual(s1.status, 'failed');
  assert.strictEqual(row('w12').status, 'failed'); assert.strictEqual(row('w12').fpAccepted, false);
  world.status = null;
});
t('reintento de un pago fallado: lote NUEVO (otro process_id)', async () => {
  const before = row('w12').fpProcessId; calls.length = 0;
  const r = await payCall('w12');
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  assert.strictEqual(transfers().length, 1); assert.notStrictEqual(row('w12').fpProcessId, before);
});
t('pago sin respuesta que SÍ había entrado: al reintentar se detecta y no se paga dos veces', async () => {
  newPayout('w13');
  world.transfer = () => ({ accepted: false, network: true, error: 'timeout', httpStatus: 0 });
  await payCall('w13'); world.transfer = null;
  const p = row('w13'); p.status = 'failed'; // un agente lo ve "trabado" y vuelve a tocar Pagar
  world.status = () => ({ ok: true, status: 'processing', finished: false, notFound: false });
  calls.length = 0;
  const r = await payCall('w13');
  assert.strictEqual(transfers().length, 0, 'no se manda otro lote mientras el anterior exista en Finpro');
  assert.ok(r.code === 409 || (r.body && r.body.success), JSON.stringify(r.body));
  world.status = null;
});
t('pago RECHAZADO en el acto: queda fallado con el motivo y se puede reintentar', async () => {
  newPayout('w14'); calls.length = 0;
  world.transfer = () => ({ accepted: false, code: '2001', httpStatus: 400, description: 'rechazada' });
  const r = await payCall('w14'); world.transfer = null;
  assert.strictEqual(r.code, 400);
  assert.strictEqual(row('w14').status, 'failed'); assert.strictEqual(row('w14').fpAccepted, false);
});
t('pago aceptado por la cuenta 1 y la cuenta en uso es la 2: NO se manda desde la 2', async () => {
  newPayout('w15', { status: 'failed', paidVia: 'finpro', fpProcessId: 'cccccccc-1111-2222-3333-444444444444', fpAccepted: true, fpAccountKey: 'f1' });
  calls.length = 0;
  const r = await payCall('w15');
  assert.strictEqual(r.code, 200); assert.strictEqual(transfers().length, 0);
  assert.strictEqual(row('w15').fpAccountKey, 'f1', 'sigue atado a la cuenta que lo aceptó');
});
t('pago: destino = nuestra propia cuenta, o sin CVU de origen → no sale', async () => {
  newPayout('w16', { cbu: CVU2 }); calls.length = 0;
  let r = await payCall('w16');
  assert.strictEqual(r.code, 400); assert.strictEqual(transfers().length, 0); assert.strictEqual(row('w16').status, 'pending_review');
  // Con pagos EN PROCESO de la cuenta 2 no se le puede cambiar el CVU/credenciales (se consultan con esos datos)…
  r = await call('POST /api/admin/finpro/accounts', { body: { key: 'f2', label: 'Finpro DOS', fromCvu: '', account: '2002' } });
  assert.strictEqual(r.code, 400); assert.ok(/EN PROCESO/.test(r.body.error));
  // …pero el nombre/alias sí.
  r = await call('POST /api/admin/finpro/accounts', { body: { key: 'f2', label: 'Finpro DOS', fromCvu: CVU2, account: '2002', alias: 'dos.nuevo' } });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  const held = PendingPayout.rows.filter((x) => x.status === 'paying' && x.fpAccountKey === 'f2');
  held.forEach((x) => { x.status = 'paid'; });
  r = await call('POST /api/admin/finpro/accounts', { body: { key: 'f2', label: 'Finpro DOS', fromCvu: '', account: '2002' } });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  held[0].status = 'paying'; // se deja uno en proceso para la prueba de borrado
  newPayout('w17');
  r = await payCall('w17');
  assert.strictEqual(r.code, 400); assert.ok(/CVU de origen/.test(r.body.error)); assert.strictEqual(transfers().length, 0);
});
t('borrar la cuenta que pagó un retiro EN PROCESO está bloqueado', async () => {
  await call('POST /api/admin/finpro/accounts/:key/activate', { params: { key: 'f1' } });
  assert.ok(PendingPayout.rows.some((x) => x.status === 'paying' && x.fpAccountKey === 'f2'));
  const r = await call('DELETE /api/admin/finpro/accounts/:key', { params: { key: 'f2' } });
  assert.strictEqual(r.code, 400); assert.ok(/EN PROCESO/.test(r.body.error));
});

t('un lote que todavía se está ENVIANDO no se da por fallado aunque Finpro no lo conozca', async () => {
  const p = newPayout('w20', { status: 'paying', paidVia: 'finpro', fpAccountKey: 'f1', fpProcessId: 'dddddddd-1111-2222-3333-444444444444', fpAccepted: null, hgStatus: 'enviando', updatedAt: new Date(Date.now() - 5 * 60 * 1000) });
  world.status = () => ({ ok: true, notFound: true, finished: false });
  hgCalls.length = 0; calls.length = 0;
  let r = await X._finproSyncPayout(clone(p), 'poll');
  assert.strictEqual(r.status, 'paying'); assert.strictEqual(row('w20').status, 'paying'); assert.strictEqual(calls.filter((c) => c[0] === 'status').length, 0);
  // Un 'enviando' de hace 20 min es de un proceso que murió: ahí sí se consulta y se resuelve.
  r = await X._finproSyncPayout(Object.assign(clone(p), { updatedAt: new Date(Date.now() - 20 * 60 * 1000) }), 'poll');
  assert.strictEqual(r.status, 'failed');
  world.status = null;
});
t('respuesta que no se entiende (2xx con otro código, 5xx) NO es un rechazo: queda en proceso', async () => {
  for (const [i, resp] of [{ accepted: false, code: '0200', httpStatus: 200 }, { accepted: false, code: '0500', httpStatus: 500 }, { accepted: false, httpStatus: 502 }].entries()) {
    const id = 'w3' + i; newPayout(id); world.transfer = () => resp;
    const r = await payCall(id); world.transfer = null;
    assert.strictEqual(r.code, 200, JSON.stringify(r.body)); assert.strictEqual(row(id).status, 'paying'); assert.strictEqual(row(id).fpAccepted, null);
  }
});
t('un lote que Finpro informa como FALLADO se resuelve (no queda en proceso para siempre)', async () => {
  const p = newPayout('w40', { status: 'paying', paidVia: 'finpro', fpAccountKey: 'f1', fpProcessId: 'eeeeeeee-1111-2222-3333-444444444444', fpTransactionId: 'TXW40', fpAccepted: true });
  world.status = () => ({ ok: true, status: 'failed', finished: true, failed: true, successCount: 0, failCount: 0 });
  world.result = () => ({ ok: true, transactions: [] });
  const r = await X._finproSyncPayout(clone(p), 'poll');
  assert.strictEqual(r.status, 'failed', 'un lote con estado failed se resuelve (antes quedaba en proceso para siempre)');
  world.status = null; world.result = null;
});
t('intento anterior por HGCASH sin respuesta: Finpro NO paga sin que el agente confirme', async () => {
  newPayout('w50', { status: 'failed', paidVia: 'hgcash', hgSendUnknown: true }); calls.length = 0;
  let r = await payCall('w50');
  assert.strictEqual(r.code, 409); assert.strictEqual(r.body.needsConfirm, true); assert.strictEqual(transfers().length, 0);
  const res = mkRes(); await X._payPayoutViaFinpro(Object.assign(payReq('w50'), { body: { confirmOtherBank: true } }), res);
  assert.strictEqual(res.code, 200, JSON.stringify(res.body)); assert.strictEqual(transfers().length, 1); assert.strictEqual(row('w50').hgSendUnknown, false);
});
t('estado del banco: un aviso tardío NO revive un pago cancelado ni desmarca uno pagado', async () => {
  newPayout('w60', { status: 'cancelled', paidVia: 'finpro', fpProcessId: 'ffffffff-1111-2222-3333-444444444444' });
  await X.handlePayoutStatusWebhook({ externalID: 'w60', id: 'ffffffff-1111-2222-3333-444444444444', status: 'ERROR', errorCode: 'x' }, 'finpro');
  assert.strictEqual(row('w60').status, 'cancelled');
  newPayout('w61', { status: 'paid', paidVia: 'finpro', fpProcessId: 'ffffffff-2222-2222-3333-444444444444' });
  await X.handlePayoutStatusWebhook({ externalID: 'w61', id: 'ffffffff-2222-2222-3333-444444444444', status: 'ERROR', errorCode: 'x' }, 'finpro');
  assert.strictEqual(row('w61').status, 'paid');
});
t('estado del banco: hgcash no toca un pago de Finpro (y un DONE cruzado avisa posible pago doble)', async () => {
  newPayout('w62', { status: 'paying', paidVia: 'finpro', fpProcessId: 'ffffffff-3333-2222-3333-444444444444' });
  notes.length = 0;
  await X.handlePayoutStatusWebhook({ externalID: 'w62', id: 'hg-1', status: 'ERROR' }, 'hgcash');
  assert.strictEqual(row('w62').status, 'paying'); assert.strictEqual(notes.length, 0);
  await X.handlePayoutStatusWebhook({ externalID: 'w62', id: 'hg-1', status: 'DONE' }, 'hgcash');
  assert.strictEqual(row('w62').status, 'paying', 'no lo marca pagado por hgcash');
  assert.ok(notes.some((x) => /POSIBLE PAGO DOBLE/.test(x)));
});
t('estado del banco: un aviso de un lote VIEJO de Finpro no decide el pago', async () => {
  newPayout('w63', { status: 'paying', paidVia: 'finpro', fpProcessId: 'ffffffff-4444-2222-3333-444444444444' });
  await X.handlePayoutStatusWebhook({ externalID: 'w63', id: 'ffffffff-0000-0000-0000-000000000000', status: 'DONE', coelsaId: 'ZZZ' }, 'finpro');
  assert.strictEqual(row('w63').status, 'paying');
  await X.handlePayoutStatusWebhook({ externalID: 'w63', id: 'ffffffff-4444-2222-3333-444444444444', status: 'DONE', coelsaId: 'COELSAW63' }, 'finpro');
  assert.strictEqual(row('w63').status, 'paid'); assert.strictEqual(row('w63').fpCoelsaId, 'COELSAW63');
});
const comp = (id, extra) => Object.assign({ id, isComprobante: true, userId: 'u9', username: 'cli9', amount: 8000, operationNumber: null, createdAt: new Date() }, extra || {});
t('comprobante con destino hgcash: NO se le pregunta a Finpro', async () => {
  await setConfig('hgcash', Object.assign({}, configStore.get('hgcash'), { cbu: '0000008800000000000088' }));
  calls.length = 0;
  const r = await X._finproVerifyComprobante(comp('c1', { destCbu: '...000088' }), { source: 'comprobante' });
  assert.strictEqual(r.skipped, 'destino hgcash'); assert.strictEqual(calls.filter((c) => c[0] === 'verify').length, 0);
});
t('verificación: Finpro confirma pero SIN monto → no se carga sola', async () => {
  world.incoming.k1 = (q) => ({ ok: true, status: 'confirmed', matchedBy: 'coelsa', confidence: 'exact', notification: { id: 'vz1', coelsaId: q.coelsaId, toCvu: CVU1 } });
  charged.length = 0;
  const r = await X._finproVerifyComprobante(comp('c2', { operationNumber: 'COELSASINMONTO1', coelsaCode: 'COELSASINMONTO1' }), { source: 'comprobante' });
  assert.strictEqual(r.ambiguous, true, JSON.stringify(r)); assert.strictEqual(charged.length, 0);
  assert.ok(notes.some((x) => /no informó el monto/.test(x)), 'le avisa al agente por qué no cargó');
  delete world.incoming.k1;
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ✅ ' + name); }
    catch (e) { console.log('  ❌ ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e)); if (missing.size) console.log('     dobles faltantes:', Array.from(missing).join(', ')); process.exitCode = 1; }
  }
  console.log(`\n${pass}/${tests.length} tests OK`);
  if (pass !== tests.length) process.exitCode = 1;
})();
