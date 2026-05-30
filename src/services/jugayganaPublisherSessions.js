/**
 * Pool de sesiones JUGAYGANA por publicista.
 *
 * Cada Campaign puede tener credenciales propias de JUGAYGANA (sub-agente del
 * publicista). Este módulo mantiene una sesión independiente por código de
 * campaña, replicando la lógica del cliente principal `jugaygana.js` pero
 * parametrizado por credenciales.
 *
 * Caso de uso: cuando un publisher_admin crea un usuario, el CREATEUSER se
 * ejecuta usando la cuenta JUGAYGANA del publicista. Así el nuevo usuario
 * queda colgado del sub-agente correcto en la jerarquía y la comisión la
 * cobra el publicista que corresponde.
 *
 * Cargas/retiros NO usan este pool: siguen pasando por la cuenta master del
 * env (`jugaygana.js`), que tiene permiso sobre todos los sub-agentes de su
 * jerarquía.
 *
 * Sesiones: Map<campaignCode, sessionState>. Login lazy con TTL igual al
 * cliente principal (TOKEN_TTL_MINUTES, 20 min por defecto). Si dos requests
 * concurrentes piden la misma sesión y está expirada, comparten el login en
 * curso para no duplicar.
 */
const axios = require('axios');
const crypto = require('crypto');
const { HttpsProxyAgent } = require('https-proxy-agent');
const logger = require('../utils/logger');
const Campaign = require('../models/Campaign');

// Firma de las creds (sha1 sobre username|password) usada para detectar cambios.
// Se guarda junto a la sesión cacheada; antes de reutilizarla comparamos contra
// las creds actuales de la DB y, si cambiaron, re-logueamos. Esto resuelve el
// bug "cambié las creds en el panel pero los nuevos usuarios siguen yendo al
// sub-agente viejo" en despliegues multi-instancia (cada instancia tiene su
// propio pool en memoria; MongoDB es la única fuente de verdad compartida).
function _credsSignature(username, password) {
  return crypto.createHash('sha1').update(String(username) + '|' + String(password)).digest('hex');
}

const API_URL = process.env.JUGAYGANA_API_URL || 'https://admin.agentesadmin.bet/api/admin/';
const PROXY_URL = process.env.PROXY_URL || '';
const TOKEN_TTL_MINUTES = parseInt(process.env.TOKEN_TTL_MINUTES || '20', 10);

// Map<campaignCode, { token, cookie, parentId, lastLogin, loginInProgress }>
const sessions = new Map();

let httpsAgent = null;
if (PROXY_URL) {
  httpsAgent = new HttpsProxyAgent(PROXY_URL);
}

// Cliente HTTP compartido (misma config que el cliente principal). Los headers
// específicos por sesión (Cookie, parentid) se inyectan por request, no acá.
const client = axios.create({
  baseURL: API_URL,
  timeout: 20000,
  httpsAgent,
  proxy: false,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://admin.agentesadmin.bet',
    'Referer': 'https://admin.agentesadmin.bet/users',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Accept-Language': 'es-419,es;q=0.9'
  }
});

function toFormUrlEncoded(data) {
  return Object.keys(data)
    .filter(k => data[k] !== undefined && data[k] !== null)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(data[k]))
    .join('&');
}

function parsePossiblyWrappedJson(data) {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data.substring(data.indexOf('{'), data.lastIndexOf('}') + 1));
  } catch {
    return data;
  }
}

function isHtmlBlocked(data) {
  return typeof data === 'string' && data.trim().startsWith('<');
}

/**
 * Carga la campaña con sus creds (jugayganaPassword está marcado select:false
 * en el schema, hay que pedirlo explícitamente).
 * @returns { username, password } o null si no hay creds configuradas
 */
async function _loadCreds(campaignCode) {
  const c = await Campaign.findOne(
    { code: String(campaignCode).toUpperCase().trim() }
  ).select('+jugayganaPassword jugayganaUsername isActive').lean();

  if (!c) {
    logger.warn(`[PublisherSessions] Campaña ${campaignCode} no existe`);
    return null;
  }
  if (c.isActive === false) {
    logger.warn(`[PublisherSessions] Campaña ${campaignCode} desactivada`);
    return null;
  }
  if (!c.jugayganaUsername || !c.jugayganaPassword) {
    return null; // sin creds — caller usa fallback global
  }
  return { username: c.jugayganaUsername, password: c.jugayganaPassword };
}

/**
 * Login real contra JUGAYGANA con las creds del publicista. Devuelve el state
 * o null si falla. No mantiene la Map — eso lo hace _ensureSession.
 */
async function _doLogin(campaignCode, username, password) {
  const body = toFormUrlEncoded({
    action: 'LOGIN',
    username,
    password
  });

  try {
    const resp = await client.post('', body, {
      validateStatus: s => s >= 200 && s < 500,
      maxRedirects: 0
    });

    let cookie = null;
    const rawSetCookie = resp.headers['set-cookie'];
    if (Array.isArray(rawSetCookie) && rawSetCookie.length > 0) {
      cookie = rawSetCookie.map(c => c.split(';')[0]).filter(p => p && p.includes('=')).join('; ');
    }

    const data = parsePossiblyWrappedJson(resp.data);
    if (isHtmlBlocked(data)) {
      logger.error(`[PublisherSessions] Login ${campaignCode}: bloqueado por HTML (status ${resp.status})`);
      return null;
    }

    const token = data?.token || data?.access_token || data?.sessionToken || data?.data?.token;
    if (!token) {
      logger.error(`[PublisherSessions] Login ${campaignCode}: sin token. msg=${data?.error || data?.message || 'desconocido'}`);
      return null;
    }

    const parentId = data?.user?.user_id ?? null;
    logger.info(`[PublisherSessions] Login exitoso ${campaignCode} (parentId=${parentId})`);
    // credsSignature se setea en _ensureSession (que conoce las creds que se pasaron).
    return { token, cookie, parentId, lastLogin: Date.now(), loginInProgress: null, credsSignature: null };
  } catch (err) {
    logger.error(`[PublisherSessions] Login ${campaignCode}: excepción ${err.message}`);
    return null;
  }
}

/**
 * Asegura que la sesión para `campaignCode` esté válida. Si no existe o está
 * expirada, hace login. Si hay un login en curso (concurrencia), espera al
 * primero en vez de duplicar el request. Devuelve el state o null.
 */
async function _ensureSession(campaignCode) {
  const existing = sessions.get(campaignCode);

  if (existing && existing.loginInProgress) {
    // Otro request ya está logueando — esperamos a que termine.
    await existing.loginInProgress;
    return sessions.get(campaignCode) || null;
  }

  // Cargamos las creds actuales SIEMPRE: las necesitamos para (a) validar que
  // la sesión cacheada sigue usando las mismas creds que están en la DB hoy,
  // y (b) si hay que loguear de nuevo.
  const creds = await _loadCreds(campaignCode);
  if (!creds) return null;
  const curSig = _credsSignature(creds.username, creds.password);

  if (existing && existing.token) {
    const expired = Date.now() - existing.lastLogin > TOKEN_TTL_MINUTES * 60 * 1000;
    if (!expired && existing.credsSignature === curSig) {
      // Sesión válida y las creds no cambiaron desde el login → reusar.
      return existing;
    }
    // Expiró o las creds cambiaron en la DB → descartar y re-loguear.
    if (existing.credsSignature && existing.credsSignature !== curSig) {
      logger.info(`[PublisherSessions] ${campaignCode}: creds cambiaron en la DB → re-login con las nuevas`);
    }
    sessions.delete(campaignCode);
  }

  const inProgressPromise = (async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const state = await _doLogin(campaignCode, creds.username, creds.password);
      if (state) {
        state.credsSignature = curSig;
        sessions.set(campaignCode, state);
        return state;
      }
      logger.warn(`[PublisherSessions] Login ${campaignCode}: intento ${attempt}/3 falló`);
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1500));
    }
    sessions.delete(campaignCode);
    return null;
  })();

  // Marcamos como "en progreso" para coordinar concurrencia.
  sessions.set(campaignCode, {
    token: null, cookie: null, parentId: null, lastLogin: 0,
    loginInProgress: inProgressPromise, credsSignature: null
  });

  try {
    return await inProgressPromise;
  } finally {
    const final = sessions.get(campaignCode);
    if (final) final.loginInProgress = null;
  }
}

/**
 * Crea un usuario en JUGAYGANA usando la sesión del publicista indicado.
 * @param {string} campaignCode  código de la Campaign con creds configuradas
 * @param {{ username, password, userrole?, currency? }} userData
 * @returns {Promise<{ success, user?, jugayganaUserId?, jugayganaUsername?, error?, code? }>}
 *   code:
 *     'NO_CREDS'      → la campaña no tiene creds configuradas (usar fallback global)
 *     'LOGIN_FAILED'  → no se pudo loguear en JUGAYGANA con las creds
 *     'HTML_BLOCKED'  → respuesta HTML (Cloudflare / mantenimiento)
 *     'API_ERROR'     → JUGAYGANA respondió error
 *     undefined       → success===true
 */
async function createUserAsPublisher(campaignCode, { username, password, userrole = 'player', currency = 'ARS' }) {
  // Chequeo previo: si la campaña no tiene creds, retornamos NO_CREDS para que
  // el caller pueda hacer fallback al cliente global (jugaygana.syncUserToPlatform).
  const creds = await _loadCreds(campaignCode);
  if (!creds) {
    return { success: false, error: 'Campaña sin credenciales JUGAYGANA configuradas', code: 'NO_CREDS' };
  }

  const session = await _ensureSession(campaignCode);
  if (!session || !session.token) {
    return { success: false, error: 'No se pudo iniciar sesión con la cuenta del publicista', code: 'LOGIN_FAILED' };
  }

  const buildBody = () => toFormUrlEncoded({
    action: 'CREATEUSER',
    token: session.token,
    username,
    password,
    userrole,
    currency
  });
  const buildHeaders = () => {
    const h = {};
    if (session.cookie) h.Cookie = session.cookie;
    return h;
  };

  try {
    let resp = await client.post('', buildBody(), {
      headers: buildHeaders(),
      validateStatus: () => true,
      maxRedirects: 0
    });
    let data = parsePossiblyWrappedJson(resp.data);

    // Auto-retry transparente cuando JUGAYGANA responde HTML (Cloudflare /
    // mantenimiento). Misma estrategia que el cliente principal.
    if (isHtmlBlocked(data)) {
      logger.warn(`[PublisherSessions] CREATEUSER ${campaignCode}/${username}: HTML, reintentando en 3s...`);
      await new Promise(r => setTimeout(r, 3000));
      resp = await client.post('', buildBody(), {
        headers: buildHeaders(),
        validateStatus: () => true,
        maxRedirects: 0
      });
      data = parsePossiblyWrappedJson(resp.data);
      if (isHtmlBlocked(data)) {
        return { success: false, error: 'API bloqueada (HTML)', code: 'HTML_BLOCKED' };
      }
    }

    // Si la sesión expiró durante la operación, renovar y reintentar UNA vez.
    const errMsg = (data?.error || data?.message || '').toString().toLowerCase();
    const sessionExpired = (
      resp.status === 401 || resp.status === 403 ||
      errMsg.includes('token') || errMsg.includes('session') ||
      errMsg.includes('expired') || errMsg.includes('unauthorized')
    );
    if (sessionExpired) {
      logger.warn(`[PublisherSessions] CREATEUSER ${campaignCode}: sesión inválida, renovando...`);
      sessions.delete(campaignCode);
      const fresh = await _ensureSession(campaignCode);
      if (!fresh || !fresh.token) {
        return { success: false, error: 'Sesión expirada y no se pudo renovar', code: 'LOGIN_FAILED' };
      }
      // Rebuild con la nueva sesión y reintentar.
      const body2 = toFormUrlEncoded({
        action: 'CREATEUSER',
        token: fresh.token,
        username, password, userrole, currency
      });
      const headers2 = {};
      if (fresh.cookie) headers2.Cookie = fresh.cookie;
      resp = await client.post('', body2, { headers: headers2, validateStatus: () => true, maxRedirects: 0 });
      data = parsePossiblyWrappedJson(resp.data);
      if (isHtmlBlocked(data)) {
        return { success: false, error: 'API bloqueada tras renovar sesión', code: 'HTML_BLOCKED' };
      }
    }

    if (data?.success) {
      logger.info(`[PublisherSessions] Usuario ${username} creado en JUGAYGANA bajo ${campaignCode} (id=${data.user?.user_id})`);
      return {
        success: true,
        user: data.user,
        jugayganaUserId: data.user?.user_id,
        jugayganaUsername: data.user?.user_name
      };
    }

    logger.error(`[PublisherSessions] CREATEUSER ${campaignCode}/${username} falló: ${data?.error || 'desconocido'}`);
    return { success: false, error: data?.error || 'CREATEUSER falló', code: 'API_ERROR' };
  } catch (err) {
    logger.error(`[PublisherSessions] CREATEUSER ${campaignCode}/${username} excepción: ${err.message}`);
    return { success: false, error: err.message, code: 'API_ERROR' };
  }
}

/**
 * Invalida la sesión de un publicista. Usar cuando se cambian sus creds
 * desde el panel — la próxima operación va a re-loguear con las creds nuevas.
 */
function invalidateSession(campaignCode) {
  sessions.delete(String(campaignCode).toUpperCase().trim());
}

/**
 * Testea las creds de un publicista intentando hacer login real. Útil para
 * validar desde el panel admin antes de guardar la campaña.
 * @returns {Promise<{ ok: boolean, parentId?: any, error?: string }>}
 */
async function testCreds(username, password) {
  try {
    const state = await _doLogin('__test__', username, password);
    if (state) return { ok: true, parentId: state.parentId };
    return { ok: false, error: 'Login falló (creds inválidas o API bloqueada)' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  createUserAsPublisher,
  invalidateSession,
  testCreds
};
