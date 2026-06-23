/**
 * hgcashService.js
 *
 * Cliente para los PAGOS SALIENTES (cash-out) de hgcash y la validación de
 * CBU/alias. Lo usa el flujo de retiros: cuando un AGENTE confirma un retiro
 * self-service, se paga automáticamente al CBU del cliente vía la API de hgcash.
 *
 * Auth: Bearer `cash_<hex>` en `process.env.HGCASH_API_TOKEN` (cargado desde SSM
 * en el bootstrap, como el resto de los secrets). Si NO está el token, isEnabled()
 * devuelve false y el pago automático queda inactivo (no rompe nada; se paga manual).
 *
 * Usa axios directo (mismo patrón que los clientes de JUGAYGANA) — sin dependencias nuevas.
 */
const axios = require('axios');
const logger = require('../utils/logger');

const BASE = process.env.HGCASH_API_URL || 'https://hg.cash/api/v1';

function getToken() { return process.env.HGCASH_API_TOKEN || null; }

/** true si hay token de API configurado (el pago automático está disponible). */
function isEnabled() { return !!getToken(); }

function _headers() {
  return { Authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' };
}

// Valida un CBU/CVU o alias y devuelve el titular real (para que el agente confirme
// a quién le está pagando). Servicio pago de hgcash (costo chico por consulta).
// @returns { ok, data: { alias, cvu, cuit, nombre, tipoPersona } } | { ok:false, error }
async function lookupAlias(aliasOrCvu) {
  if (!getToken()) return { ok: false, error: 'HGCASH_API_TOKEN no configurado' };
  const value = String(aliasOrCvu || '').trim();
  if (!value) return { ok: false, error: 'alias/CVU vacío' };
  try {
    const r = await axios.post(`${BASE}/alias-lookup`, { alias: value }, { headers: _headers(), timeout: 15000 });
    return { ok: true, data: r.data || {} };
  } catch (e) {
    const detail = e.response ? `HTTP ${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message;
    logger.warn(`[hgcash-pay] alias-lookup falló (${value}): ${detail}`);
    return { ok: false, error: detail, httpStatus: e.response && e.response.status };
  }
}

// Lista las cuentas hgcash a las que el TOKEN actual tiene acceso. Es la fuente de
// verdad para resolver el accountId a debitar: si cambiás de cuenta/token, esto
// devuelve la cuenta nueva (evita el 403 "No tienes acceso a esta cuenta" por usar
// un accountId viejo cacheado). GET /accounts → { data: [{ id, currency, status, ... }] }.
// @returns { ok, data: [accounts] } | { ok:false, error, httpStatus }
async function getAccounts() {
  if (!getToken()) return { ok: false, error: 'HGCASH_API_TOKEN no configurado' };
  try {
    const r = await axios.get(`${BASE}/accounts`, { headers: _headers(), timeout: 15000 });
    const data = (r.data && Array.isArray(r.data.data)) ? r.data.data : (Array.isArray(r.data) ? r.data : []);
    return { ok: true, data };
  } catch (e) {
    const httpStatus = e.response && e.response.status;
    const detail = e.response ? `HTTP ${httpStatus} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message;
    logger.warn(`[hgcash-pay] get-accounts falló: ${detail}`);
    return { ok: false, error: detail, httpStatus };
  }
}

// Crea un pago saliente (cash-out). El destino debe ser un CBU/CVU de 22 dígitos.
// `externalID` da idempotencia: si se reintenta con el mismo, hgcash devuelve 409
// (Duplicate External ID) en vez de pagar dos veces.
// @returns { ok, data: { id, externalID, createdAt, status } } | { ok:false, error, httpStatus }
async function createCashOut({ accountId, amount, toCBU, toName, toCUIT, concept, externalID, webhookUrl }) {
  if (!getToken()) return { ok: false, error: 'HGCASH_API_TOKEN no configurado' };
  if (!accountId) return { ok: false, error: 'Falta accountId de la cuenta hgcash' };

  const dest = String(toCBU || '').replace(/\D/g, '');
  if (dest.length !== 22) return { ok: false, error: 'CBU/CVU destino inválido (debe tener 22 dígitos)' };
  if (!(Number(amount) > 0)) return { ok: false, error: 'Monto inválido' };

  const body = { accountId: String(accountId), amount: Number(amount), toCBU: dest };
  if (toName) body.toName = String(toName).slice(0, 255);
  if (toCUIT) {
    const c = Number(String(toCUIT).replace(/\D/g, ''));
    if (c) body.toCUIT = c;
  }
  if (concept) body.concept = String(concept).slice(0, 500);
  if (externalID) body.externalID = String(externalID).slice(0, 100);
  if (webhookUrl) body.webhookUrl = webhookUrl;

  try {
    const r = await axios.post(`${BASE}/transactions`, body, { headers: _headers(), timeout: 30000 });
    return { ok: true, data: r.data || {} };
  } catch (e) {
    const httpStatus = e.response && e.response.status;
    const detail = e.response ? `HTTP ${httpStatus} ${JSON.stringify(e.response.data).slice(0, 250)}` : e.message;
    logger.error(`[hgcash-pay] cash-out falló: ${detail}`);
    return { ok: false, error: detail, httpStatus };
  }
}

// Resuelve el id de la TRANSACCIÓN real (ledger) a partir del id del REQUEST que
// devolvió createCashOut. El recibo PDF se pide con el id de transacción, no del
// request. Puede devolver transactionId=null si todavía no se procesó.
// GET /transaction-requests/{id}/transaction-id → { transactionId }
async function getTransactionIdForRequest(requestId) {
  if (!getToken()) return { ok: false, error: 'HGCASH_API_TOKEN no configurado' };
  if (!requestId) return { ok: false, error: 'requestId vacío' };
  try {
    const r = await axios.get(`${BASE}/transaction-requests/${encodeURIComponent(requestId)}/transaction-id`, { headers: _headers(), timeout: 15000 });
    return { ok: true, transactionId: (r.data && r.data.transactionId) || null };
  } catch (e) {
    const httpStatus = e.response && e.response.status;
    const detail = e.response ? `HTTP ${httpStatus} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message;
    logger.warn(`[hgcash-pay] get-transaction-id falló (${requestId}): ${detail}`);
    return { ok: false, error: detail, httpStatus };
  }
}

// Trae una URL firmada para descargar el PDF del comprobante de un pago. La URL
// VENCE en 1 hora (por eso conviene resolverla on-demand, no guardarla).
// GET /transactions/{id}/receipt → { signedUrl }
async function getReceiptUrl(transactionId) {
  if (!getToken()) return { ok: false, error: 'HGCASH_API_TOKEN no configurado' };
  if (!transactionId) return { ok: false, error: 'transactionId vacío' };
  try {
    const r = await axios.get(`${BASE}/transactions/${encodeURIComponent(transactionId)}/receipt`, { headers: _headers(), timeout: 20000 });
    return { ok: true, signedUrl: (r.data && r.data.signedUrl) || null };
  } catch (e) {
    const httpStatus = e.response && e.response.status;
    const detail = e.response ? `HTTP ${httpStatus} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message;
    logger.warn(`[hgcash-pay] get-receipt falló (${transactionId}): ${detail}`);
    return { ok: false, error: detail, httpStatus };
  }
}

// Estado de un pago saliente (cash-out) por su id de REQUEST. Sirve para destrabar
// un payout que quedó en 'paying' (webhook perdido). GET /transaction/{id}/status.
async function getTransactionStatus(requestId) {
  if (!getToken()) return { ok: false, error: 'HGCASH_API_TOKEN no configurado' };
  if (!requestId) return { ok: false, error: 'requestId vacío' };
  try {
    const r = await axios.get(`${BASE}/transaction/${encodeURIComponent(requestId)}/status`, { headers: _headers(), timeout: 15000 });
    const data = r.data || {};
    const status = data.status || data.state || null;
    return { ok: true, status: status ? String(status) : null, data };
  } catch (e) {
    const httpStatus = e.response && e.response.status;
    const detail = e.response ? `HTTP ${httpStatus} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message;
    logger.warn(`[hgcash-pay] get-status falló (${requestId}): ${detail}`);
    return { ok: false, error: detail, httpStatus };
  }
}

// Descarga los BYTES del PDF del comprobante: resuelve un signedUrl fresco y baja
// el archivo. Devuelve { ok, buffer }. La signedUrl es de descarga directa (presignada),
// no necesita el token. Best-effort: ante cualquier error devuelve ok:false.
async function fetchReceiptPdf(transactionId) {
  const r = await getReceiptUrl(transactionId);
  if (!r.ok || !r.signedUrl) return { ok: false, error: r.error || 'sin signedUrl' };
  try {
    const resp = await axios.get(r.signedUrl, { responseType: 'arraybuffer', timeout: 20000 });
    return { ok: true, buffer: Buffer.from(resp.data) };
  } catch (e) {
    const detail = e.response ? `HTTP ${e.response.status}` : e.message;
    logger.warn(`[hgcash-pay] descarga del PDF de recibo falló (${transactionId}): ${detail}`);
    return { ok: false, error: detail };
  }
}

module.exports = { isEnabled, lookupAlias, getAccounts, createCashOut, getTransactionIdForRequest, getTransactionStatus, getReceiptUrl, fetchReceiptPdf, getToken };
