// ============================================
// FB-ADS WEBHOOK SERVICE
// --------------------------------------------
// Notifica al sistema externo `fb-ads` cada conversión clave del sitio
// (CompleteRegistration / Purchase) para que pueda aprender por anuncio y
// calcular LTV / CAC por audiencia.
//
// Diseño:
//   - notify(event, user, opts) es fire-and-forget desde el handler:
//     arma el payload y dispara el POST en background con 3 reintentos
//     inmediatos (1s / 4s / 16s). Si los 3 fallan -> encola en
//     FbAdsWebhookQueue para que el worker periódico reintente más tarde.
//   - 4xx no se reintenta (payload mal armado).
//   - 5xx / timeout / red: se reintenta con backoff.
//   - Todo gated en FBADS_WEBHOOK_URL + FBADS_WEBHOOK_TOKEN; si faltan,
//     el servicio queda en no-op y loguea una sola advertencia.
//
// Variables de entorno:
//   FBADS_WEBHOOK_URL    — endpoint del lado de fb-ads (ej: https://.../sales)
//   FBADS_WEBHOOK_TOKEN  — secret compartido para el header Authorization
// ============================================

const axios = require('axios');
const FbAdsWebhookQueue = require('../models/FbAdsWebhookQueue');

let logger = console;
try { logger = require('../utils/logger') || console; } catch (e) { /* fallback */ }

// Reintentos inmediatos (en ms) desde el handler.
const RETRY_DELAYS_MS = [1000, 4000, 16000];
// Tope total de intentos (inmediatos + cola) antes de descartar.
const MAX_TOTAL_ATTEMPTS = 10;
// Timeout de cada POST.
const POST_TIMEOUT_MS = 8000;

let _missingConfigLogged = false;

function isConfigured() {
  return Boolean(process.env.FBADS_WEBHOOK_URL && process.env.FBADS_WEBHOOK_TOKEN);
}

function _logMissingConfigOnce() {
  if (_missingConfigLogged) return;
  _missingConfigLogged = true;
  logger.warn('[fbAds] FBADS_WEBHOOK_URL o FBADS_WEBHOOK_TOKEN no configurados — webhook deshabilitado (eventos no se envían ni encolan).');
}

// Extrae el `fbclid` original del valor de cookie `_fbc`.
// Formato Meta: `fb.<subdomainIndex>.<creationTimeMs>.<fbclid>`
function fbclidFromFbc(fbc) {
  if (!fbc || typeof fbc !== 'string') return null;
  const m = fbc.match(/^fb\.\d+\.\d+\.(.+)$/);
  return m ? m[1] : null;
}

// Arma el body exacto que espera fb-ads (ver brief técnico).
function buildPayload({ eventName, user, value, currency, eventTime }) {
  const u = user || {};
  const fbc = u.metaFbc || null;
  return {
    event_name: eventName,
    event_time: (eventTime instanceof Date ? eventTime : new Date()).toISOString(),
    customer_id: u.id || null,
    email: u.email || null,
    phone: u.phone || null,
    value: (value === undefined || value === null) ? null : Number(value),
    currency: currency || (value != null ? 'ARS' : null),
    publicista: u.acquisitionCampaign ? String(u.acquisitionCampaign).toLowerCase() : null,
    fbclid: fbclidFromFbc(fbc),
    fbc: fbc,
    landing_url: u.landingUrl || null
  };
}

// Backoff de la cola persistente (después de agotar los 3 inmediatos).
// 1 min, 5 min, 15 min, 30 min, 1 h, 2 h, 4 h, 8 h.
function _queueBackoffMs(attempts) {
  const minutes = [1, 5, 15, 30, 60, 120, 240, 480];
  const idx = Math.max(0, Math.min(attempts - RETRY_DELAYS_MS.length, minutes.length - 1));
  return minutes[idx] * 60 * 1000;
}

// Un único POST con timeout. Lanza si la respuesta no es 2xx.
async function _postOnce(payload) {
  await axios.post(process.env.FBADS_WEBHOOK_URL, payload, {
    timeout: POST_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.FBADS_WEBHOOK_TOKEN}`
    },
    validateStatus: (s) => s >= 200 && s < 300
  });
}

function _isClientError(err) {
  return Boolean(err && err.response && err.response.status >= 400 && err.response.status < 500);
}

async function _enqueue(payload, attempts, lastError) {
  try {
    await FbAdsWebhookQueue.create({
      payload,
      attempts,
      lastError: String(lastError || '').slice(0, 500),
      nextRetryAt: new Date(Date.now() + _queueBackoffMs(attempts))
    });
  } catch (qErr) {
    logger.warn(`[fbAds] No se pudo encolar evento (${payload && payload.event_name}): ${qErr.message}`);
  }
}

// Intentos inmediatos con backoff. Si fallan los 3, encola.
async function _sendWithRetries(payload) {
  let attempts = 0;
  let lastError = null;
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    try {
      await _postOnce(payload);
      attempts = i + 1;
      logger.debug(`[fbAds] OK ${payload.event_name} customer=${payload.customer_id} intento=${attempts}`);
      return;
    } catch (err) {
      lastError = err;
      attempts = i + 1;
      if (_isClientError(err)) {
        // 4xx — payload mal armado, no reintentar ni encolar.
        const status = err.response.status;
        const body = err.response.data;
        logger.warn(`[fbAds] 4xx (no se reintenta) ${payload.event_name}: ${status} ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body || '').slice(0, 200)}`);
        return;
      }
      if (i < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
      }
    }
  }
  // 3 reintentos fallaron: encolar para que el worker siga intentando.
  const errMsg = (lastError && lastError.message) || 'unknown';
  logger.warn(`[fbAds] Encolado ${payload.event_name} tras ${attempts} intentos: ${errMsg}`);
  await _enqueue(payload, attempts, errMsg);
}

// API pública. Fire-and-forget desde los handlers: no bloquea ni lanza al caller.
function notify(eventName, user, opts) {
  if (!isConfigured()) { _logMissingConfigOnce(); return; }
  if (!eventName || typeof eventName !== 'string') return;
  const o = opts || {};
  let payload;
  try {
    payload = buildPayload({
      eventName,
      user,
      value: o.value,
      currency: o.currency,
      eventTime: o.eventTime
    });
  } catch (err) {
    logger.warn(`[fbAds] buildPayload error: ${err.message}`);
    return;
  }
  // No esperamos: cualquier excepción imprevista se loguea y se sigue.
  _sendWithRetries(payload).catch((e) => {
    logger.warn(`[fbAds] _sendWithRetries throw inesperado ${eventName}: ${e && e.message}`);
  });
}

// Worker: reintenta los items vencidos. Lo llama `startWorker` cada N min.
async function processQueue() {
  if (!isConfigured()) return;
  let items;
  try {
    items = await FbAdsWebhookQueue
      .find({ nextRetryAt: { $lte: new Date() } })
      .sort({ nextRetryAt: 1 })
      .limit(50)
      .lean();
  } catch (err) {
    logger.warn(`[fbAds] processQueue find error: ${err.message}`);
    return;
  }
  for (const item of items) {
    try {
      await _postOnce(item.payload);
      await FbAdsWebhookQueue.deleteOne({ _id: item._id });
      logger.debug(`[fbAds] queue OK ${item.payload && item.payload.event_name}`);
    } catch (err) {
      // 4xx — payload mal armado, no se va a arreglar reintentando.
      if (_isClientError(err)) {
        await FbAdsWebhookQueue.deleteOne({ _id: item._id });
        logger.warn(`[fbAds] queue 4xx (descartado): ${err.response.status}`);
        continue;
      }
      const attempts = (item.attempts || 0) + 1;
      if (attempts >= MAX_TOTAL_ATTEMPTS) {
        await FbAdsWebhookQueue.deleteOne({ _id: item._id });
        logger.warn(`[fbAds] queue max attempts (descartado) ${item.payload && item.payload.event_name}: ${err.message}`);
        continue;
      }
      const nextRetryAt = new Date(Date.now() + _queueBackoffMs(attempts));
      try {
        await FbAdsWebhookQueue.updateOne(
          { _id: item._id },
          { $set: { attempts, lastError: String(err.message || '').slice(0, 500), nextRetryAt } }
        );
      } catch (uErr) {
        logger.warn(`[fbAds] queue update error: ${uErr.message}`);
      }
    }
  }
}

let _workerInterval = null;
function startWorker(intervalMs) {
  if (_workerInterval) return;
  const ms = intervalMs || (5 * 60 * 1000); // 5 min default
  _workerInterval = setInterval(() => {
    processQueue().catch((e) => logger.warn(`[fbAds] worker tick error: ${e && e.message}`));
  }, ms);
  if (isConfigured()) {
    logger.info(`[fbAds] worker iniciado (cada ${Math.round(ms / 60000)} min)`);
  }
}

module.exports = {
  isConfigured,
  notify,
  processQueue,
  startWorker,
  // Exports auxiliares (útiles para tests / debug):
  buildPayload,
  fbclidFromFbc
};
