// ============================================
// META CONVERSIONS API (CAPI) SERVICE
// --------------------------------------------
// Envía eventos server-side a Meta para complementar el pixel del navegador.
// Mejora la precisión bajo iOS / adblockers y permite deduplicar con event_id.
//
// Variables de entorno requeridas:
//   META_PIXEL_ID                 — ID numérico del Pixel
//   META_CAPI_ACCESS_TOKEN        — Token de acceso CAPI (Eventos → Configuración → Conversions API)
//   META_TEST_EVENT_CODE          — (opcional) código de Test Events para validar antes de prod
//
// Si falta PIXEL_ID o ACCESS_TOKEN, el módulo queda en no-op (loguea warning una sola vez).
// Nunca lanza ni bloquea el flujo de negocio: errores se loguean como warning.
// ============================================

const crypto = require('crypto');
const axios = require('axios');

let logger = console;
try { logger = require('../utils/logger') || console; } catch (e) { /* fallback */ }

const GRAPH_API_VERSION = 'v22.0';
let _missingConfigLogged = false;

function isConfigured() {
  return Boolean(process.env.META_PIXEL_ID && process.env.META_CAPI_ACCESS_TOKEN);
}

function sha256(value) {
  if (value === undefined || value === null) return undefined;
  const str = String(value).trim().toLowerCase();
  if (!str) return undefined;
  return crypto.createHash('sha256').update(str).digest('hex');
}

// Normaliza teléfono a sólo dígitos antes de hashear (requisito de Meta).
// Fix móviles AR: los formularios suelen guardar el celular sin el "9" móvil
// (ej: +54 11 2275-5331 → 541122755331), pero Facebook/WhatsApp almacenan los
// móviles AR con el "9" intercalado (5491122755331). Sin esa corrección los
// hashes nunca matchean y el Custom Audience pierde a casi todos los usuarios.
// La heurística es conservadora: sólo agrega el 9 si el número tiene 12
// dígitos, empieza con 54, y no tiene ya un 9 móvil. Cualquier otro país o
// fijo internacional queda intacto. Único falso positivo posible: un fijo
// AMBA de 12 dígitos — aceptable porque la app es de cargas/apuestas y el
// 99% de los teléfonos cargados son celulares.
function normalizePhone(phone) {
  if (!phone) return undefined;
  let digits = String(phone).replace(/\D/g, '');
  if (!digits) return undefined;
  if (digits.length === 12 && digits.startsWith('54') && digits[2] !== '9') {
    digits = '549' + digits.slice(2);
  }
  return digits;
}

function newEventId() {
  return crypto.randomUUID();
}

// Construye el bloque user_data hasheando PII según especificación de Meta.
// userInfo: { email, phone, externalId, firstName, lastName, country, city, gender, dateOfBirth }
// requestCtx: { ip, userAgent, fbp, fbc }
function buildUserData(userInfo = {}, requestCtx = {}) {
  const user_data = {};

  const emailHash = sha256(userInfo.email);
  if (emailHash) user_data.em = [emailHash];

  const phoneHash = sha256(normalizePhone(userInfo.phone));
  if (phoneHash) user_data.ph = [phoneHash];

  const externalIdHash = sha256(userInfo.externalId);
  if (externalIdHash) user_data.external_id = [externalIdHash];

  const fnHash = sha256(userInfo.firstName);
  if (fnHash) user_data.fn = [fnHash];

  const lnHash = sha256(userInfo.lastName);
  if (lnHash) user_data.ln = [lnHash];

  const countryHash = sha256(userInfo.country);
  if (countryHash) user_data.country = [countryHash];

  const cityHash = sha256(userInfo.city);
  if (cityHash) user_data.ct = [cityHash];

  const genderHash = sha256(userInfo.gender);
  if (genderHash) user_data.ge = [genderHash];

  const dobHash = sha256(userInfo.dateOfBirth);
  if (dobHash) user_data.db = [dobHash];

  if (requestCtx.ip) user_data.client_ip_address = requestCtx.ip;
  if (requestCtx.userAgent) user_data.client_user_agent = requestCtx.userAgent;
  // fbp / fbc — identificadores de Meta Ads (fbp = navegador, fbc = clic del
  // anuncio, clave para atribuir conversiones a la pauta).
  // Prioridad: la cookie viva del request (eventos browser-side / self-service).
  // Fallback: el valor persistido en el usuario (userInfo.fbc / userInfo.fbp).
  // El fallback es imprescindible para eventos server-side como Purchase
  // disparado desde un request de admin, donde la cookie del jugador no existe
  // en req.headers.cookie.
  const fbp = requestCtx.fbp || userInfo.fbp;
  const fbc = requestCtx.fbc || userInfo.fbc;
  if (fbp) user_data.fbp = fbp;
  if (fbc) user_data.fbc = fbc;

  return user_data;
}

// Extrae fbp/fbc/ip/userAgent de una request Express.
function extractRequestContext(req) {
  if (!req) return {};
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return {
    ip: req.ip || (req.headers && req.headers['x-forwarded-for'] && String(req.headers['x-forwarded-for']).split(',')[0].trim()) || null,
    userAgent: req.headers && req.headers['user-agent'] ? String(req.headers['user-agent']) : null,
    fbp: cookies._fbp || null,
    fbc: cookies._fbc || null
  };
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  cookieHeader.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  });
  return out;
}

// Envía un evento a Conversions API. Nunca lanza.
// args:
//   eventName       — string ('Purchase', 'CompleteRegistration', 'Lead', etc. o custom)
//   userInfo        — datos del usuario (se hashea internamente)
//   customData      — { value, currency, content_name, ... } pasado tal cual a Meta
//   options         — { eventId, eventSourceUrl, actionSource, testEventCode, req }
async function sendEvent(eventName, userInfo, customData, options) {
  if (!isConfigured()) {
    if (!_missingConfigLogged) {
      _missingConfigLogged = true;
      logger.warn('[MetaCAPI] META_PIXEL_ID o META_CAPI_ACCESS_TOKEN no configurados — eventos server-side deshabilitados');
    }
    return { sent: false, reason: 'not_configured' };
  }

  if (!eventName || typeof eventName !== 'string') {
    return { sent: false, reason: 'invalid_event' };
  }

  const opts = options || {};
  const req = opts.req || null;
  const requestCtx = extractRequestContext(req);

  const user_data = buildUserData(userInfo || {}, requestCtx);

  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: opts.eventId || newEventId(),
    action_source: opts.actionSource || 'website',
    user_data,
    custom_data: customData || {}
  };

  if (opts.eventSourceUrl) {
    event.event_source_url = opts.eventSourceUrl;
  } else if (req && req.headers && req.headers.referer) {
    event.event_source_url = String(req.headers.referer);
  }

  const payload = { data: [event] };
  if (opts.testEventCode || process.env.META_TEST_EVENT_CODE) {
    payload.test_event_code = opts.testEventCode || process.env.META_TEST_EVENT_CODE;
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.META_PIXEL_ID}/events`;

  try {
    const response = await axios.post(url, payload, {
      params: { access_token: process.env.META_CAPI_ACCESS_TOKEN },
      timeout: 5000
    });
    return { sent: true, eventId: event.event_id, data: response.data };
  } catch (err) {
    const detail = err.response && err.response.data ? JSON.stringify(err.response.data) : err.message;
    logger.warn(`[MetaCAPI] Error enviando evento ${eventName}: ${detail}`);
    return { sent: false, reason: 'request_failed', error: detail };
  }
}

// Fire-and-forget. Útil para no bloquear el response del endpoint.
function track(eventName, userInfo, customData, options) {
  return sendEvent(eventName, userInfo, customData, options).catch((e) => {
    logger.warn(`[MetaCAPI] track() fallo no esperado: ${e.message}`);
    return { sent: false, reason: 'unexpected', error: e.message };
  });
}

// ============================================
// ADVANCED MATCHING (browser pixel)
// --------------------------------------------
// Devuelve los hashes precalculados que el frontend pasa a `fbq('init', ID, {...})`
// para que cada evento browser-side incluya identificadores hasheados del usuario.
// Mantiene la normalización en un solo lugar (este archivo) y evita exponer PII
// en cleartext al cliente. `country` default 'ar' porque el negocio opera en AR.
// `external_id` se hashea para consistencia con los eventos server-side; Meta
// acepta tanto hasheado como en texto plano.
// ============================================
function buildAdvancedMatching(userInfo) {
  if (!userInfo) return null;
  const matching = {};
  const em = sha256(userInfo.email);
  if (em) matching.em = em;
  const ph = sha256(normalizePhone(userInfo.phone));
  if (ph) matching.ph = ph;
  const ext = sha256(userInfo.externalId);
  if (ext) matching.external_id = ext;
  const fn = sha256(userInfo.firstName);
  if (fn) matching.fn = fn;
  const ln = sha256(userInfo.lastName);
  if (ln) matching.ln = ln;
  const country = sha256(userInfo.country || 'ar');
  if (country) matching.country = country;
  return Object.keys(matching).length ? matching : null;
}

// ============================================
// VALUE BUCKETS (Purchase content_category)
// --------------------------------------------
// Buckets de monto para alimentar Value Optimization de Meta Ads. Los umbrales
// están pensados para cargas en ARS — si cambia la moneda, recalibrar.
// ============================================
function valueCategory(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n < 5000) return 'low';
  if (n < 20000) return 'medium';
  if (n < 50000) return 'high';
  return 'whale';
}

module.exports = {
  isConfigured,
  newEventId,
  extractRequestContext,
  sendEvent,
  track,
  buildAdvancedMatching,
  valueCategory
};
