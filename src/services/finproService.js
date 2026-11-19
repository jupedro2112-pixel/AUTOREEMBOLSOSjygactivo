/**
 * Servicio Finpro (banco con API) — segundo banco, paralelo a hgcash (#202 en esta página).
 * Portado del servicio de CARGASGIROXactivo (#217–#220) + MULTI-CUENTA (#202): hasta 3
 * cuentas de Finpro cargadas desde el panel. El estado global (setCredentialsOverride /
 * setSettingsOverride) es la cuenta EN USO; toda operación acepta además `ctx` = el
 * contexto de UNA cuenta puntual ({ key, creds:{apiKey,apiSecret}, baseUrl, bankId,
 * account, fromCvu }) para consultar/pagar/verificar con una cuenta que no es la activa
 * (un pago hecho por la cuenta A se sigue consultando con A aunque después se rote a B).
 * Con `ctx`, baseUrl/bankId caen a env/default si faltan; creds/account/fromCvu NO.
 *
 * Doc oficial: app.finpro.com.ar/docs (transcripción del owner, 2026-10-27). Todo lo que
 * la doc no aclara está marcado como DECISIÓN en los comentarios y en ARCHITECTURE §5.
 *
 * Auth: TODAS las llamadas llevan `X-API-Key` + `X-API-Secret` (el secret Finpro lo
 * muestra UNA vez; regenerarlo invalida el anterior). Algunas operaciones (consulta de
 * titular `accounts/information`) piden además un token de cliente (`x-access-token`,
 * `POST /auth/token/client`, dura `expires_in` s = 1 h): se cachea en memoria y se
 * renueva cuando le quedan < 120 s o ante un 401.
 *
 * Qué se usa:
 *   • Retiros: `POST /transfers/cvu` — UN lote = UNA transferencia (process_id uuid,
 *     transaction_id ≤ 11 chars). `code '0201'` = lote aceptado; el resultado real
 *     (coelsa_id, response_code) sale después por `processes/{id}/result`. La doc pide
 *     mandar las transferencias de un mismo from_cvu de a UNA (si no, error 2454):
 *     `withCvuLock` las encola por proceso.
 *   • Cargas: desde #220 llegan por el WEBHOOK SECUNDARIO de Finpro (eventos bancarios
 *     de nuestros CVUs: `transfer_type 'E'` = entrante; `POST /api/finpro/webhook` en
 *     server.js). Como respaldo sigue la CONSULTA `POST /transfers/verify/incoming`
 *     (coelsa_id | authorization_code | monto+fecha+ventana+CVU) a partir del
 *     comprobante del cliente. verify solo valida acreditadas: NO detecta reversiones.
 *   • Webhooks (doc "Webhooks"): firmados con HMAC-SHA256 sobre `timestamp + "." +
 *     body crudo` → headers `X-Webhook-Signature` (hex) y `X-Webhook-Timestamp` (Unix s).
 *     `verifyWebhookSignature` / `signWebhook` abajo. El PRINCIPAL (resultado de los
 *     retiros) llega al `callback_url` de cada transferencia; el SECUNDARIO a la URL
 *     que se le informa a Finpro en el alta.
 *   • Titular/CVU de un alias o CVU: `POST /accounts/information` (Coelsa).
 *   • Saldo: `POST /accounts/balance` (campos no documentados → parseo defensivo + raw).
 *
 * Configuración (lazy: SSM carga después del require). PANEL > SSM/env:
 *   FINPRO_API_KEY / FINPRO_API_SECRET   credenciales (respaldo del panel, cifrado)
 *   FINPRO_API_URL      base URL. Default `https://mw-dev.finpro.com.ar` = host de
 *                       DESARROLLO de la doc; el de producción no está documentado →
 *                       el panel avisa en rojo cuando la URL contiene "dev".
 *   FINPRO_BANK_ID      `{bankId}` de los paths (doc: `creedence`)
 *   FINPRO_ACCOUNT      número de cuenta interno de Finpro (para el saldo)
 *   FINPRO_FROM_CVU     nuestro CVU (origen de los retiros / destino de las cargas)
 *   FINPRO_EXTRA_CVUS   otros CVUs nuestros del mismo Cliente API (coma; #220: un Cliente
 *                       Finpro agrupa 1..N cuentas/CVUs y el webhook identifica la cuenta
 *                       por CVU y por id interno → las entrantes a CUALQUIERA cuentan)
 *   FINPRO_TIMEOUT_MS   (default 20000)
 *   FINPRO_WEBHOOK_SECRET          secreto de firma de los webhooks (respaldo del panel)
 *   FINPRO_WEBHOOK_MAX_AGE_SEC     ventana del timestamp de la firma (default 300; 0 = sin ventana)
 *
 * ⚠️ Nunca loguear ni devolver la key/secret/token: los helpers solo exponen last4.
 */

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

const DEFAULT_BASE_URL = 'https://mw-dev.finpro.com.ar';
const DEFAULT_BANK_ID = 'creedence';
const TOKEN_RENEW_MARGIN_SEC = 120;

// ───────────────────────── credenciales y settings (panel > env) ─────────────────────────
let _credsOverride = null;   // { apiKey, apiSecret } cargados desde el panel (server.js)
let _settingsOverride = {};  // { baseUrl, bankId, account, fromCvu } del panel

function setCredentialsOverride(c) {
  const k = c && typeof c.apiKey === 'string' ? c.apiKey.trim() : '';
  const s = c && typeof c.apiSecret === 'string' ? c.apiSecret.trim() : '';
  const next = (k && s) ? { apiKey: k, apiSecret: s } : null;
  _credsOverride = next; // el token se cachea por (credenciales + URL + banco): no hace falta invalidarlo
}
function setSettingsOverride(s) {
  const o = s && typeof s === 'object' ? s : {};
  _settingsOverride = {
    baseUrl: typeof o.baseUrl === 'string' ? o.baseUrl.trim() : '',
    bankId: typeof o.bankId === 'string' ? o.bankId.trim() : '',
    account: typeof o.account === 'string' ? o.account.trim() : '',
    fromCvu: typeof o.fromCvu === 'string' ? o.fromCvu.replace(/\D/g, '') : '',
    extraCvus: _parseCvuList(o.extraCvus)
  };
}
/** Lista de CVUs (string con comas/espacios o array) → array de CVUs de 22 dígitos, sin repetidos. */
function _parseCvuList(v) {
  const parts = Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/);
  return Array.from(new Set(parts.map((x) => String(x || '').replace(/\D/g, '')).filter((x) => x.length === 22)));
}
function _envCreds() {
  const k = String(process.env.FINPRO_API_KEY || '').trim();
  const s = String(process.env.FINPRO_API_SECRET || '').trim();
  return (k && s) ? { apiKey: k, apiSecret: s } : null;
}
function getCredentials() { return _credsOverride || _envCreds(); }
function getCredentialSource() { return _credsOverride ? 'panel' : (_envCreds() ? 'ssm' : 'none'); }
function isEnabled() { return !!getCredentials(); }
function baseUrl() { return String(_settingsOverride.baseUrl || process.env.FINPRO_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''); }
function bankId() { return String(_settingsOverride.bankId || process.env.FINPRO_BANK_ID || DEFAULT_BANK_ID).trim(); }
function account() { return String(_settingsOverride.account || process.env.FINPRO_ACCOUNT || '').trim(); }
function fromCvu() { return String(_settingsOverride.fromCvu || process.env.FINPRO_FROM_CVU || '').replace(/\D/g, ''); }
/** Otros CVUs nuestros del mismo Cliente API (panel > FINPRO_EXTRA_CVUS). */
function extraCvus() { return (_settingsOverride.extraCvus && _settingsOverride.extraCvus.length) ? _settingsOverride.extraCvus : _parseCvuList(process.env.FINPRO_EXTRA_CVUS); }
/** TODOS nuestros CVUs (principal + extras), sin repetidos. */
function ourCvus() { return Array.from(new Set([fromCvu()].concat(extraCvus()).filter((x) => x.length === 22))); }
/** ¿Este CVU/CBU es de una cuenta nuestra? (compara dígitos) */
function isOurCvu(cvu) { const c = String(cvu || '').replace(/\D/g, ''); return c.length === 22 && ourCvus().includes(c); }
/** ¿La URL apunta al ambiente de DESARROLLO? (host de la doc: mw-dev.finpro.com.ar) */
function isDevUrl(u) {
  try { return /dev|sandbox|test|staging/i.test(new URL(u || baseUrl()).hostname); } catch (_) { return /dev/i.test(String(u || baseUrl())); }
}
/** Listo para PAGAR retiros: credenciales + nuestro CVU de 22 dígitos. */
function isReadyForPayouts() { return isEnabled() && fromCvu().length === 22; }
/** Listo para VERIFICAR cargas: credenciales + (CVU o cuenta) para acotar la búsqueda. */
function isReadyForIncoming() { return isEnabled() && (fromCvu().length === 22 || !!account()); }
function settingsPublic() {
  return {
    baseUrl: baseUrl(), bankId: bankId(), account: account(), fromCvu: fromCvu(), extraCvus: extraCvus(),
    dev: isDevUrl(), source: _settingsOverride.baseUrl || _settingsOverride.bankId || _settingsOverride.account || _settingsOverride.fromCvu ? 'panel' : 'env'
  };
}

// ───────────────────────── diagnóstico (ring buffer por instancia) ─────────────────────────
const _lastCalls = [];
function _logCall(entry) {
  _lastCalls.unshift(Object.assign({ at: new Date() }, entry));
  if (_lastCalls.length > 40) _lastCalls.length = 40;
}
function getDiag() {
  return {
    credentials: getCredentialSource(),
    settings: settingsPublic(),
    token: (() => { const x = _cx(); const t = x.creds ? _tokens.get(_tokenKey(x)) : null; return { has: !!(t && t.token), expiresAt: t ? new Date(t.expiresAt) : null, secondsLeft: t ? Math.max(0, Math.round((t.expiresAt - Date.now()) / 1000)) : 0, cached: _tokens.size }; })(),
    queue: Array.from(_cvuQueues.keys()).map((k) => ({ fromCvu: '…' + k.slice(-6), inFlight: _cvuInFlight.get(k) || 0 })),
    lastCalls: _lastCalls.slice(0, 25)
  };
}

// ───────────────────────── contexto de cuenta (#202 multi-cuenta) ─────────────────────────
/**
 * Resuelve con QUÉ cuenta se hace una llamada. Sin `ctx` → la cuenta en uso (overrides del
 * panel / env). Con `ctx` → esa cuenta puntual (baseUrl/bankId caen a env/default).
 * `creds` suelto (API vieja) pisa solo las credenciales.
 */
function _cx(ctx, creds) {
  const o = ctx && typeof ctx === 'object' ? ctx : null;
  if (!o) return { key: null, creds: creds || getCredentials(), baseUrl: baseUrl(), bankId: bankId(), account: account(), fromCvu: fromCvu() };
  const c = creds || o.creds || ((o.apiKey && o.apiSecret) ? { apiKey: String(o.apiKey), apiSecret: String(o.apiSecret) } : null);
  return {
    key: o.key != null ? String(o.key) : null,
    creds: (c && c.apiKey && c.apiSecret) ? c : null,
    baseUrl: String(o.baseUrl || process.env.FINPRO_API_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, ''),
    bankId: String(o.bankId || process.env.FINPRO_BANK_ID || DEFAULT_BANK_ID).trim(),
    account: String(o.account || '').trim(),
    fromCvu: String(o.fromCvu || '').replace(/\D/g, '')
  };
}
function _tokenKey(cx) { return _keyTag(cx.creds) + '|' + cx.baseUrl + '|' + cx.bankId; }

// ───────────────────────── request genérico ─────────────────────────
function _path(p, cx) { return `/api/banks/${encodeURIComponent(cx ? cx.bankId : bankId())}${p}`; }
/**
 * Devuelve SIEMPRE un objeto (nunca tira):
 *   { ok, httpStatus, data, code, description, error, ms }
 * `code`/`description` salen del body de Finpro (`code`, `description` / `message`).
 */
async function _request(method, p, { body, cx, token, timeoutMs, kind } = {}) {
  const x = cx || _cx();
  const path = _path(p, x);
  const c = x.creds;
  if (!c) return { ok: false, httpStatus: 0, data: null, code: null, description: null, error: 'Finpro sin credenciales (panel → Finpro, o FINPRO_API_KEY/SECRET en SSM)' };
  const headers = { 'X-API-Key': c.apiKey, 'X-API-Secret': c.apiSecret, 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers['x-access-token'] = token;
  const t0 = Date.now();
  let out;
  try {
    const resp = await axios({
      method, url: x.baseUrl + path, data: body === undefined ? {} : body, headers,
      timeout: Number(timeoutMs || process.env.FINPRO_TIMEOUT_MS || 20000),
      validateStatus: () => true, maxRedirects: 0
    });
    const d = resp.data && typeof resp.data === 'object' ? resp.data : {};
    const code = d.code != null ? String(d.code) : (d.status_code != null ? String(d.status_code) : null);
    const description = d.description || d.message || d.detail || (typeof d.error === 'string' ? d.error : null) || null;
    out = {
      ok: resp.status >= 200 && resp.status < 300,
      httpStatus: resp.status, data: d, code, description,
      error: resp.status >= 400 ? (description || `HTTP ${resp.status}`) : null,
      ms: Date.now() - t0
    };
  } catch (e) {
    out = { ok: false, httpStatus: 0, data: null, code: null, description: null, error: e.code === 'ECONNABORTED' ? 'timeout' : (e.message || 'red'), network: true, ms: Date.now() - t0 };
  }
  _logCall({ kind: kind || p, acct: x.key || null, method, path, ok: out.ok, httpStatus: out.httpStatus, code: out.code, error: out.error ? String(out.error).slice(0, 160) : null, ms: out.ms });
  return out;
}

// ───────────────────────── token de cliente (1 h) ─────────────────────────
const _tokens = new Map(); // (credenciales|url|banco) → { token, expiresAt }
function _keyTag(c) { return c ? crypto.createHash('sha256').update(c.apiKey + ':' + c.apiSecret).digest('hex').slice(0, 12) : null; }
/** Token de cliente (`x-access-token`). Cacheado; se renueva si quedan < 120 s o con force. */
async function getClientToken({ creds, ctx, force } = {}) {
  const x = _cx(ctx, creds);
  if (!x.creds) return { ok: false, error: 'sin credenciales' };
  const tk = _tokenKey(x);
  const hit = _tokens.get(tk);
  if (!force && hit && hit.token && hit.expiresAt - Date.now() > TOKEN_RENEW_MARGIN_SEC * 1000) {
    return { ok: true, token: hit.token, cached: true, expiresAt: hit.expiresAt };
  }
  const r = await _request('POST', '/auth/token/client', { body: {}, cx: x, kind: 'auth/token' });
  const d = r.data || {};
  const tok = d.token || d.access_token || (d.data && (d.data.token || d.data.access_token)) || null;
  if (!r.ok || !tok) {
    return Object.assign(r, { ok: false, error: r.error || (r.ok ? 'respuesta sin token' : 'no se pudo obtener el token') });
  }
  const expiresIn = Number(d.expires_in || (d.data && d.data.expires_in)) || 3600;
  const expiresAt = Date.now() + expiresIn * 1000;
  if (_tokens.size > 20) _tokens.clear(); // credenciales viejas/rotadas: no acumular
  _tokens.set(tk, { token: tok, expiresAt });
  return { ok: true, token: tok, cached: false, expiresAt, tokenType: d.token_type || null, httpStatus: r.httpStatus, code: r.code };
}
function invalidateToken() { _tokens.clear(); }
/** Ejecuta `fn(token)`; ante un 401 renueva el token y reintenta UNA vez. */
async function _withToken(fn, x) {
  let t = await getClientToken({ ctx: x });
  if (!t.ok) return { ok: false, httpStatus: t.httpStatus || 0, error: 'token: ' + (t.error || 'falló'), code: t.code || null, data: t.data || null };
  let r = await fn(t.token);
  if (r.httpStatus === 401) {
    t = await getClientToken({ ctx: x, force: true });
    if (t.ok) r = await fn(t.token);
  }
  return r;
}

// ───────────────────────── helpers ─────────────────────────
function newTrace() { return String(Date.now()) + String(Math.floor(Math.random() * 900) + 100); }         // numérico
function newRetrieval() { return 'VIP' + crypto.randomBytes(6).toString('hex').toUpperCase(); }               // alfanumérico
/** ISO 8601 con offset de Argentina (-03:00), como pide `initial_datetime`. */
function isoWithOffsetAR(date) {
  const d = date ? new Date(date) : new Date();
  const ar = new Date(d.getTime() - 3 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${ar.getUTCFullYear()}-${p(ar.getUTCMonth() + 1)}-${p(ar.getUTCDate())}T${p(ar.getUTCHours())}:${p(ar.getUTCMinutes())}:${p(ar.getUTCSeconds())}-03:00`;
}
/** transaction_id determinístico (≤ 11 chars) a partir del id del payout local. */
function transactionIdFor(payoutId) {
  return 'P' + crypto.createHash('sha1').update(String(payoutId)).digest('hex').slice(0, 10).toUpperCase();
}
/** Busca un número en un objeto por lista de claves (shallow + 1 nivel), para respuestas no documentadas. */
function _pickNumber(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  const scan = (o) => {
    for (const k of keys) {
      if (o[k] != null && o[k] !== '' && Number.isFinite(Number(o[k]))) return Number(o[k]);
    }
    return null;
  };
  let v = scan(obj);
  if (v != null) return v;
  for (const k of Object.keys(obj)) {
    if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) { v = scan(obj[k]); if (v != null) return v; }
  }
  return null;
}
function _pickString(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  const scan = (o) => { for (const k of keys) { if (o[k] != null && String(o[k]).trim()) return String(o[k]).trim(); } return null; };
  let v = scan(obj);
  if (v != null) return v;
  for (const k of Object.keys(obj)) {
    if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) { v = scan(obj[k]); if (v != null) return v; }
  }
  return null;
}

// ───────────────────────── códigos del banco (tabla de la doc) ─────────────────────────
const BANK_CODES = {
  '2449': { msg: 'Saldo insuficiente en la cuenta de Finpro. Cargá saldo y reintentá.', retry: false },
  '2418': { msg: 'La cuenta destino está BLOQUEADA. No se puede pagar a ese CBU/CVU: pedile otro al cliente o pagá por otro banco.', retry: false },
  '2454': { msg: 'Finpro ya tiene una operación en curso desde este CVU. Se reintenta cuando termine la anterior.', retry: true },
  '2455': { msg: 'Finpro rechazó el pedido (bad request; típicamente transaction_id > 11 caracteres). Avisale al desarrollador.', retry: false },
  '0414': { msg: 'El CVU destino no está habilitado para recibir transferencias. Verificá el destino con el cliente.', retry: false },
  '0416': { msg: 'CVU inválido (origen o destino). Revisá nuestro CVU en el panel y el del cliente.', retry: false },
  '0583': { msg: 'Falla transitoria del banco (0583): se puede reintentar con un pedido nuevo.', retry: true },
  '0500': { msg: 'Error genérico del banco (0500). Si persiste, contactar a soporte de Finpro.', retry: false }
};
const SUCCESS_CODES = ['0200', '0201', '200', '201', '0000', '00', '0'];
function describeCode(code, description) {
  const c = code != null ? String(code).trim() : '';
  const known = BANK_CODES[c] || BANK_CODES[c.padStart(4, '0')];
  if (known) return `${known.msg} (código ${c}${description ? ': ' + String(description).slice(0, 120) : ''})`;
  if (c) return `Finpro respondió código ${c}${description ? ': ' + String(description).slice(0, 160) : ''}`;
  return description ? String(description).slice(0, 200) : 'sin detalle';
}
/** ¿El código es de ERROR del banco? (tabla + forma 2xxx / 04xx / 05xx / 4xx / 5xx). DECISIÓN defensiva. */
function isErrorCode(code) {
  if (code == null || code === '') return false;
  const c = String(code).trim();
  if (SUCCESS_CODES.includes(c)) return false;
  if (BANK_CODES[c]) return true;
  return /^(2\d{3}|04\d{2}|05\d{2}|4\d{2}|5\d{2})$/.test(c);
}
function isTransientCode(code) { const c = String(code || '').trim(); return c === '0583' || c === '2454' || c === '583'; }

// ───────────────────────── cola secuencial por from_cvu ─────────────────────────
// La doc recomienda mandar las transferencias de un mismo CVU de a una, esperando el
// resultado de cada proceso (si no, 2454). Cola de promesas por CVU en ESTA instancia
// (con varias instancias de EB el 2454 sigue siendo posible → se reintenta igual).
const _cvuQueues = new Map();
const _cvuInFlight = new Map();
function withCvuLock(cvu, fn) {
  const key = String(cvu || 'default');
  const prev = _cvuQueues.get(key) || Promise.resolve();
  _cvuInFlight.set(key, (_cvuInFlight.get(key) || 0) + 1);
  const run = prev.catch(() => {}).then(() => fn()).finally(() => {
    _cvuInFlight.set(key, Math.max(0, (_cvuInFlight.get(key) || 1) - 1));
    if (_cvuQueues.get(key) === run && !_cvuInFlight.get(key)) _cvuQueues.delete(key);
  });
  _cvuQueues.set(key, run);
  return run;
}

// ───────────────────────── operaciones ─────────────────────────
/** Saldo de la cuenta (`accounts/balance`). Campos no documentados → `balance`/`available` best-effort + `raw`. */
async function getBalance({ account: acc, creds, ctx } = {}) {
  const x = _cx(ctx, creds);
  const a = acc || x.account;
  if (!a) return { ok: false, error: 'Falta el número de cuenta de Finpro (panel → Finpro, o FINPRO_ACCOUNT).' };
  const r = await _request('POST', '/accounts/balance', { body: { account: a, trace: newTrace(), retrieval: newRetrieval() }, cx: x, kind: 'accounts/balance' });
  if (!r.ok) return r;
  const d = r.data || {};
  return Object.assign(r, {
    balance: _pickNumber(d, ['balance', 'saldo', 'total', 'saldo_total', 'current_balance', 'balance_total']),
    available: _pickNumber(d, ['available', 'disponible', 'available_balance', 'saldo_disponible', 'availableBalance', 'balance', 'saldo']),
    currency: _pickString(d, ['currency', 'moneda']) || 'ARS'
  });
}

/**
 * Titular de un CVU o alias (Coelsa). Devuelve { ok, found, nombre, cuit, tipoPersona, cvu, code, description, raw }.
 * `found` = la red devolvió un titular. Un alias resuelto trae `cvu` si la respuesta lo incluye.
 */
async function getAccountInformation({ cvu, alias, creds, ctx } = {}) {
  const x = _cx(ctx, creds);
  const body = {};
  const c = String(cvu || '').replace(/\D/g, '');
  if (c.length === 22) body.cvu = c; else if (alias) body.alias = String(alias).trim().toLowerCase(); else return { ok: false, error: 'CVU (22 dígitos) o alias requerido' };
  const r = await _withToken((token) => _request('POST', '/accounts/information', { body, token, cx: x, kind: 'accounts/information' }), x);
  const d = r.data || {};
  const info = d.data && typeof d.data === 'object' ? Object.assign({}, d, d.data) : d;
  const nombre = _pickString(info, ['nombre', 'name', 'titular', 'holder', 'owner_name', 'denominacion']);
  return Object.assign(r, {
    found: !!nombre,
    nombre,
    cuit: _pickString(info, ['cuit', 'cuil', 'cuit_cuil', 'tax_id']),
    tipoPersona: _pickString(info, ['tipo_persona', 'tipoPersona', 'person_type']),
    cvu: (_pickString(info, ['cvu', 'cbu', 'cbu_cvu', 'account_number']) || (body.cvu || '')).replace(/\D/g, '') || null,
    alias: _pickString(info, ['alias']) || body.alias || null
  });
}

/**
 * Lote de UNA transferencia a CVU. `code '0201'` = aceptado (accepted:true). El resultado
 * final (coelsa_id / response_code) llega después por `getProcessResult`.
 */
async function createCvuTransfer({ processId, transactionId, fromCvu: from, toCvu, amount, description, callbackUrl, initialDatetime, concept, creds, ctx }) {
  const x = _cx(ctx, creds);
  const txId = String(transactionId || '').slice(0, 11);
  const body = {
    process_id: String(processId),
    transaction_count: 1,
    initial_datetime: initialDatetime || isoWithOffsetAR(),
    data: [{
      transaction_id: txId,
      from_cvu: String(from || x.fromCvu).replace(/\D/g, ''),
      to_cvu: String(toCvu || '').replace(/\D/g, ''),
      amount: Number(amount),
      concept: concept || 'VAR',
      description: String(description || 'Retiro').slice(0, 100)
    }]
  };
  if (callbackUrl) body.callback_url = callbackUrl;
  const r = await _request('POST', '/transfers/cvu', { body, cx: x, timeoutMs: 30000, kind: 'transfers/cvu' });
  const code = r.code;
  const accepted = r.ok && (code === '0201' || code === '201' || (code == null && !!(r.data && (r.data.process_id || r.data.processId))));
  return Object.assign(r, { accepted, processId: (r.data && (r.data.process_id || r.data.processId)) || String(processId), transactionId: txId });
}

/** Estado de uno o varios procesos. Normaliza el primero: { status, successCount, failCount, processedCount, raw }. */
async function getProcessStatus(processIds, { creds, ctx } = {}) {
  const ids = (Array.isArray(processIds) ? processIds : [processIds]).map(String).filter(Boolean);
  const r = await _request('POST', '/processes/status', { body: { process_ids: ids }, cx: _cx(ctx, creds), kind: 'processes/status' });
  const d = r.data || {};
  let row = d;
  const list = Array.isArray(d) ? d : (Array.isArray(d.data) ? d.data : (Array.isArray(d.processes) ? d.processes : (Array.isArray(d.results) ? d.results : null)));
  if (list) row = list.find((x) => x && String(x.process_id || x.processId || x.id) === ids[0]) || list[0] || {};
  else if (d.data && typeof d.data === 'object') row = Object.assign({}, d, d.data);
  const status = _pickString(row, ['status', 'state', 'process_status']);
  return Object.assign(r, {
    status: status ? status.toLowerCase() : null,
    finished: /^(finished|finalizado|completed|done|processed|failed|error|rejected|rechazado|cancelled|canceled)$/i.test(status || ''),
    failed: /^(failed|error|rejected|rechazado|cancelled|canceled)$/i.test(status || ''), // el LOTE terminó mal (sin esto quedaba 'en proceso' para siempre)
    successCount: _pickNumber(row, ['transaction_success_count', 'success_count']),
    failCount: _pickNumber(row, ['transaction_fail_count', 'fail_count']),
    processedCount: _pickNumber(row, ['transaction_processed_count', 'processed_count']),
    notFound: r.httpStatus === 404 || (list && !list.length)
  });
}

/** Resultado por transacción de un proceso: { transactions: [{ transactionId, coelsaId, responseCode, responseDescription, amount, cbuFrom, cbuTo, authorizationCode, raw }] }. */
async function getProcessResult(processId, { creds, ctx } = {}) {
  const r = await _request('POST', `/processes/${encodeURIComponent(String(processId))}/result`, { body: {}, cx: _cx(ctx, creds), kind: 'processes/result' });
  const d = r.data || {};
  let list = Array.isArray(d) ? d : (Array.isArray(d.data) ? d.data : (Array.isArray(d.transactions) ? d.transactions : (Array.isArray(d.results) ? d.results : (Array.isArray(d.result) ? d.result : null))));
  if (!list && d.data && typeof d.data === 'object' && Array.isArray(d.data.transactions)) list = d.data.transactions;
  if (!list) list = (d.coelsa_id || d.response_code || d.transaction_id) ? [d] : [];
  const transactions = list.map((t) => ({
    transactionId: _pickString(t, ['transaction_id', 'transactionId']),
    coelsaId: _pickString(t, ['coelsa_id', 'coelsaId', 'coelsa']),
    responseCode: _pickString(t, ['response_code', 'responseCode', 'code']),
    responseDescription: _pickString(t, ['response_description', 'responseDescription', 'description', 'message']),
    amount: _pickNumber(t, ['amount', 'monto']),
    cbuFrom: _pickString(t, ['cbu_from', 'from_cvu', 'cbuFrom']),
    cbuTo: _pickString(t, ['cbu_to', 'to_cvu', 'cbuTo']),
    authorizationCode: _pickString(t, ['authorization_code', 'authorizationCode']),
    status: _pickString(t, ['status', 'state']),
    raw: t
  }));
  const processStatus = _pickString(d, ['status', 'state', 'process_status']);
  return Object.assign(r, { transactions, processStatus: processStatus ? processStatus.toLowerCase() : null });
}

/**
 * Verifica una transferencia ENTRANTE acreditada (`transfers/verify/incoming`). Solo
 * headers X-API-Key/Secret. Devuelve { ok, status: 'confirmed'|'not_found_yet'|'ambiguous'|null,
 * matchedBy, confidence, notification, matches, httpStatus, error, raw }.
 * Un 400/401/403 queda en `error` (sin status). NO detecta reversiones.
 */
async function verifyIncoming({ coelsaId, authorizationCode, amount, occurredAt, windowMinutes, toCvu, toAccount, creds, ctx } = {}) {
  const x = _cx(ctx, creds);
  const body = {};
  if (coelsaId) body.coelsa_id = String(coelsaId).trim();
  else if (authorizationCode) body.authorization_code = String(authorizationCode).trim();
  else {
    if (!(Number(amount) > 0)) return { ok: false, error: 'Para verificar sin coelsa hace falta el monto (y la fecha).' };
    body.amount = Number(amount);
    body.occurred_at = occurredAt ? (occurredAt instanceof Date ? occurredAt.toISOString() : String(occurredAt)) : new Date().toISOString();
    body.window_minutes = Math.min(1440, Math.max(1, Number(windowMinutes) || 180));
    const tc = String(toCvu || x.fromCvu || '').replace(/\D/g, '');
    if (tc.length === 22) body.to_cvu = tc;
    else if (toAccount || x.account) body.to_account = String(toAccount || x.account);
  }
  const r = await _request('POST', '/transfers/verify/incoming', { body, cx: x, kind: 'verify/incoming' });
  const d = r.data || {};
  const info = d.data && typeof d.data === 'object' && !Array.isArray(d.data) ? Object.assign({}, d, d.data) : d;
  const st = _pickString(info, ['status', 'result']);
  const status = /^confirmed$/i.test(st || '') ? 'confirmed' : (/not_found/i.test(st || '') ? 'not_found_yet' : (/ambig/i.test(st || '') ? 'ambiguous' : (st ? st.toLowerCase() : null)));
  const notification = info.notification && typeof info.notification === 'object' ? info.notification : null;
  return Object.assign(r, {
    status: r.ok ? status : null,
    matchedBy: _pickString(info, ['matched_by', 'matchedBy']),
    confidence: (_pickString(info, ['confidence']) || '').toLowerCase() || null,
    notification: notification ? {
      id: notification.id != null ? String(notification.id) : null,
      amount: _pickNumber(notification, ['amount', 'monto']),
      authorizationCode: _pickString(notification, ['authorization_code', 'authorizationCode']),
      coelsaId: _pickString(notification, ['coelsa_id', 'coelsaId']),
      toCvu: _pickString(notification, ['to_cvu', 'toCvu', 'cbu_to']),
      fromCvu: _pickString(notification, ['from_cvu', 'fromCvu', 'cbu_from', 'origin_cvu']),
      fromName: _pickString(notification, ['from_name', 'payer_name', 'origin_name', 'nombre_origen', 'titular_origen', 'holder']),
      fromCuit: _pickString(notification, ['from_cuit', 'payer_cuit', 'origin_cuit', 'cuit_origen', 'cuit']),
      occurredAt: _pickString(notification, ['occurred_at', 'occurredAt', 'credited_at', 'date', 'fecha', 'created_at']),
      raw: notification
    } : null,
    matches: Array.isArray(info.matches) ? info.matches : null,
    searchedScope: info.searched_scope || null,
    requestKind: body.coelsa_id ? 'coelsa_id' : (body.authorization_code ? 'authorization_code' : 'amount_date'),
    requestBody: body
  });
}

// ───────────────────────── webhooks: firma HMAC-SHA256 (#220) ─────────────────────────
// Doc "Webhooks": `signature = HMAC-SHA256(timestamp + "." + payload_json, secret)` en hex,
// donde payload_json es el body EXACTO que mandó Finpro (por eso server.js guarda
// `req.rawBody`). Headers: `X-Webhook-Signature` y `X-Webhook-Timestamp` (Unix en segundos).
// La doc no fija una ventana de validez del timestamp → DECISIÓN: 5 min (configurable con
// FINPRO_WEBHOOK_MAX_AGE_SEC; 0 desactiva la ventana), tolerando el mismo margen hacia el
// futuro por desfase de relojes.
const WEBHOOK_MAX_AGE_SEC_DEFAULT = 300;
function webhookMaxAgeSec() {
  const v = process.env.FINPRO_WEBHOOK_MAX_AGE_SEC;
  if (v === undefined || v === null || v === '') return WEBHOOK_MAX_AGE_SEC_DEFAULT;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : WEBHOOK_MAX_AGE_SEC_DEFAULT;
}
/** Firma un body crudo (string|Buffer) como lo hace Finpro. Para tests y para el botón de prueba. */
function signWebhook(rawBody, secret, ts) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody == null ? '' : rawBody), 'utf8');
  const t = String(ts == null ? Math.floor(Date.now() / 1000) : ts);
  const sig = crypto.createHmac('sha256', String(secret)).update(Buffer.concat([Buffer.from(t + '.', 'utf8'), body])).digest('hex');
  return { timestamp: t, signature: sig };
}
function _hexEqual(a, b) {
  const x = String(a || '').trim().toLowerCase().replace(/^sha256=/, '');
  const y = String(b || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(x) || !/^[0-9a-f]{64}$/.test(y)) return false;
  return crypto.timingSafeEqual(Buffer.from(x, 'hex'), Buffer.from(y, 'hex'));
}
/**
 * Verifica la firma de un webhook de Finpro. Acepta CUALQUIERA de los secretos de la lista
 * (panel y SSM, para no perder avisos mientras se rota). Devuelve { ok, reason }:
 * reason ∈ sin_secreto | sin_firma | sin_timestamp | timestamp_invalido | timestamp_vencido | firma_invalida.
 */
function verifyWebhookSignature({ rawBody, timestamp, signature, secrets, maxAgeSec, now } = {}) {
  const list = (Array.isArray(secrets) ? secrets : [secrets]).filter((x) => typeof x === 'string' && x.length > 0);
  if (!list.length) return { ok: false, reason: 'sin_secreto' };
  if (!signature) return { ok: false, reason: 'sin_firma' };
  const ts = String(timestamp == null ? '' : timestamp).trim();
  if (!ts) return { ok: false, reason: 'sin_timestamp' };
  if (!/^\d{9,13}$/.test(ts)) return { ok: false, reason: 'timestamp_invalido' };
  const maxAge = maxAgeSec == null ? webhookMaxAgeSec() : Number(maxAgeSec);
  if (maxAge > 0) {
    const tsSec = ts.length > 10 ? Math.floor(Number(ts) / 1000) : Number(ts); // tolera milisegundos
    const nowSec = Math.floor((now == null ? Date.now() : Number(now)) / 1000);
    if (Math.abs(nowSec - tsSec) > maxAge) return { ok: false, reason: 'timestamp_vencido', ageSec: nowSec - tsSec };
  }
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody == null ? '' : rawBody), 'utf8');
  for (const sec of list) {
    const expected = crypto.createHmac('sha256', sec).update(Buffer.concat([Buffer.from(ts + '.', 'utf8'), body])).digest('hex');
    if (_hexEqual(signature, expected)) return { ok: true, reason: null };
  }
  return { ok: false, reason: 'firma_invalida' };
}

// ───────────────────────── webhooks: parseo de payloads (#220) ─────────────────────────
/**
 * Webhook SECUNDARIO (eventos bancarios de nuestros CVUs; la MISMA URL recibe entrantes y
 * salientes). Normaliza:
 * { notificationId, bankId, webhookType, notificationType, receivedAt, transferType, incoming,
 *   coelsaId, amount, cbuFrom, cbuTo, fromName, fromCuit, toName, toCuit, concept, reference,
 *   accountId, raw }. `incoming` = transfer_type 'E' (entrante).
 * La doc ("Cómo funciona") dice que el aviso lleva los datos de la transferencia tal como
 * figuran (CVU/CBU origen y destino, titular, CUIT/CUIL, monto, fecha, concepto/referencia) y
 * el id interno de la cuenta Finpro; el ejemplo solo mostró cbu_from/cbu_to/amount/coelsa_id →
 * se leen con varias claves posibles y pueden venir null.
 */
function parseIncomingWebhook(body) {
  const b = body && typeof body === 'object' ? body : {};
  const td = b.transaction_data && typeof b.transaction_data === 'object' ? b.transaction_data : (b.transactionData && typeof b.transactionData === 'object' ? b.transactionData : {});
  const nid = b.notification_id != null ? String(b.notification_id).trim() : (b.notificationId != null ? String(b.notificationId).trim() : '');
  const tt = _pickString(td, ['transfer_type', 'transferType', 'type']);
  const amount = _pickNumber(td, ['amount', 'monto']);
  const both = Object.assign({}, b, td); // claves de primer nivel o dentro de transaction_data
  const cuitOf = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 11 ? d : (v ? String(v).trim() : null); };
  return {
    fromName: _pickString(td, ['cbu_from_name', 'from_name', 'origin_name', 'titular_origen', 'nombre_origen', 'payer_name', 'titular', 'holder', 'nombre', 'from_holder', 'origin_holder']),
    fromCuit: cuitOf(_pickString(td, ['cbu_from_cuit', 'from_cuit', 'origin_cuit', 'cuit_origen', 'origin_document', 'from_document', 'payer_cuit', 'cuit', 'cuil', 'document', 'origin_cuil'])),
    toName: _pickString(td, ['cbu_to_name', 'to_name', 'destination_name', 'titular_destino', 'nombre_destino', 'to_holder', 'destination_holder']),
    toCuit: cuitOf(_pickString(td, ['cbu_to_cuit', 'to_cuit', 'destination_cuit', 'cuit_destino', 'destination_document', 'to_document'])),
    concept: _pickString(td, ['concepto', 'concept', 'description', 'descripcion', 'motivo']),
    reference: _pickString(td, ['referencia', 'reference', 'external_reference', 'descripcion_referencia']),
    accountId: _pickString(both, ['account_id', 'finpro_account_id', 'id_cuenta', 'cuenta_id', 'accountId', 'account_number', 'account']),
    occurredAt: _pickString(td, ['occurred_at', 'date', 'fecha', 'transaction_date', 'credited_at', 'created_at']),
    notificationId: nid || null,
    bankId: _pickString(b, ['bank_id', 'bankId']),
    webhookType: (_pickString(b, ['webhook_type', 'webhookType']) || '').toLowerCase() || null,
    notificationType: _pickString(b, ['notification_type', 'notificationType']),
    receivedAt: _pickString(b, ['received_at', 'receivedAt', 'occurred_at', 'created_at']),
    transferType: tt ? tt.toUpperCase() : null,
    incoming: !!tt && tt.toUpperCase() === 'E',
    coelsaId: _pickString(td, ['coelsa_id', 'coelsaId']),
    amount: Number.isFinite(amount) ? amount : null,
    amountRaw: td.amount != null ? String(td.amount) : null,
    cbuFrom: String(_pickString(td, ['cbu_from', 'from_cvu', 'cbuFrom']) || '').replace(/\D/g, '') || null,
    cbuTo: String(_pickString(td, ['cbu_to', 'to_cvu', 'cbuTo']) || '').replace(/\D/g, '') || null,
    authorizationCode: _pickString(td, ['authorization_code', 'authorizationCode']),
    raw: b
  };
}
/**
 * Webhook PRINCIPAL (resultado de un lote de transferencias salientes = nuestros retiros).
 * { processId, transactionId, status ('completed'|'failed'|otro), successCount, failCount,
 *   rows: [{ transactionId, coelsaId, responseCode, amount, cbuFrom, cbuTo, authorizationCode, raw }], hasRows }
 */
function parsePayoutCallback(body) {
  const b = body && typeof body === 'object' ? body : {};
  const list = Array.isArray(b.data) ? b.data : (Array.isArray(b.transactions) ? b.transactions : []);
  const rows = list.filter((t) => t && typeof t === 'object').map((t) => ({
    transactionId: _pickString(t, ['transaction_id', 'transactionId']),
    coelsaId: _pickString(t, ['coelsa_id', 'coelsaId']),
    responseCode: _pickString(t, ['response_code', 'responseCode', 'code']),
    responseDescription: _pickString(t, ['response_description', 'responseDescription', 'description', 'message']),
    amount: _pickNumber(t, ['amount', 'monto']),
    cbuFrom: _pickString(t, ['cbu_from', 'from_cvu']),
    cbuTo: _pickString(t, ['cbu_to', 'to_cvu']),
    authorizationCode: _pickString(t, ['authorization_code', 'authorizationCode']),
    raw: t
  }));
  const st = _pickString(b, ['status', 'state']);
  return {
    processId: String(b.process_id || b.processId || '').trim() || null,
    transactionId: _pickString(b, ['transaction_id', 'transactionId']),
    status: st ? st.toLowerCase() : null,
    successCount: _pickNumber(b, ['transaction_success_count', 'success_count']),
    failCount: _pickNumber(b, ['transaction_fail_count', 'fail_count']),
    rows, hasRows: rows.length > 0
  };
}

// ───────────────────────── titular de un CVU pagador (cache 24 h, #220) ─────────────────────────
// El webhook secundario NO trae nombre ni CUIT del pagador (solo cbu_from): se consulta
// `accounts/information` por CVU y se cachea por 24 h (el mismo cliente transfiere muchas
// veces; evita gastar el token y la red). Una falla es NO fatal: se devuelve { found:false }.
const PAYER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PAYER_CACHE_MAX = 2000;
const _payerCache = new Map(); // cvu → { at, nombre, cuit, found }
async function lookupPayerCached({ cvu, creds, ctx, force } = {}) {
  const c = String(cvu || '').replace(/\D/g, '');
  if (c.length !== 22) return { ok: false, found: false, error: 'CVU inválido' };
  const hit = _payerCache.get(c);
  if (!force && hit && Date.now() - hit.at < PAYER_CACHE_TTL_MS) return Object.assign({ ok: true, cached: true }, hit);
  let r;
  try { r = await getAccountInformation({ cvu: c, creds, ctx }); } catch (e) { r = { ok: false, found: false, error: e.message }; }
  if (r && r.ok && r.found) {
    const entry = { at: Date.now(), nombre: r.nombre, cuit: r.cuit || null, found: true };
    if (_payerCache.size >= PAYER_CACHE_MAX) _payerCache.delete(_payerCache.keys().next().value); // FIFO
    _payerCache.set(c, entry);
    return Object.assign({ ok: true, cached: false }, entry);
  }
  return { ok: false, found: false, error: (r && (r.error || r.description)) || 'sin titular', httpStatus: r && r.httpStatus };
}
function payerCacheSize() { return _payerCache.size; }

module.exports = {
  // config
  setCredentialsOverride, setSettingsOverride, getCredentialSource, isEnabled, baseUrl, bankId, account, fromCvu,
  isDevUrl, isReadyForPayouts, isReadyForIncoming, settingsPublic, getDiag,
  // token
  getClientToken, invalidateToken,
  // operaciones
  getBalance, getAccountInformation, createCvuTransfer, getProcessStatus, getProcessResult, verifyIncoming,
  // helpers
  withCvuLock, describeCode, isErrorCode, isTransientCode, transactionIdFor, isoWithOffsetAR, newTrace, newRetrieval,
  // webhooks (#220)
  verifyWebhookSignature, signWebhook, webhookMaxAgeSec, parseIncomingWebhook, parsePayoutCallback,
  lookupPayerCached, payerCacheSize, extraCvus, ourCvus, isOurCvu,
  DEFAULT_BASE_URL, DEFAULT_BANK_ID
};
