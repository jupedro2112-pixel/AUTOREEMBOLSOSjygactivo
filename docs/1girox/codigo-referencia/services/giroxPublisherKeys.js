/**
 * giroxPublisherKeys.js — Alta de jugadores con la API key propia del publicista.
 *
 * REEMPLAZA a `jugayganaPublisherSessions.js`, y es MUCHO más simple: en JUGAYGANA
 * cada publicista tenía usuario+contraseña de sub-agente, así que hacía falta un
 * POOL de sesiones con login lazy, TTL de 20 min, firma de creds para detectar
 * cambios, mutex de logins concurrentes y auto-retry ante el HTML de Cloudflare.
 *
 * En 1girox NADA de eso existe: la jerarquía la define la API KEY. El manual es
 * explícito: "los jugadores creados con esa key quedan bajo la cuenta del agente
 * que la creó" y "los depósitos salen del saldo de ese agente". Auth por header
 * `X-Api-Key` fijo → no hay login, no hay token que venza, no hay sesión que
 * invalidar, no hay Cloudflare devolviendo HTML.
 *
 * Resultado: una key por campaña (Campaign.giroxApiKey, select:false) y un POST.
 *
 * QUÉ HACE CADA PIEZA (actualizado 2026-08-05):
 *   - Este módulo hace SOLO el ALTA con la key del publicista. El resto de las
 *     operaciones (cargas, retiros, saldo, stats, SSO, clave) las rutea
 *     giroxService con su keyResolver: los jugadores creados bajo un sub-agente
 *     NO son visibles para la key master por Partner API (comprobado: deposit
 *     devolvía player_not_found), así que TODO lo de ese jugador se firma con la
 *     key de su campaña dueña (User.giroxOwnerCampaign, seteado en el alta).
 *     ⚠️ Consecuencia del manual: los depósitos a esos jugadores salen del SALDO
 *     del sub-agente en 1girox — el principal tiene que mantenerlos fondeados.
 *   - Si la campaña no tiene key, se devuelve NO_CREDS y el caller hace fallback a
 *     la master (giroxService.syncUserToPlatform) — y el jugador queda bajo la
 *     master (sin giroxOwnerCampaign).
 *
 * ⚠️ NO se usa `giroxService.js` para crear el jugador porque ese cliente firma
 * SIEMPRE con la key global. Acá hace falta firmar con OTRA key, así que se duplica
 * lo mínimo del transporte (axios + headers + normalización de errores). El resto
 * (validación de username, etc.) se reusa importándolo.
 */
const axios = require('axios');
const logger = require('../utils/logger');
const Campaign = require('../models/Campaign');
const giroxService = require('./giroxService');

// ============================================================
// CONFIG (lazy — SSM carga DESPUÉS de los require() del top de server.js,
// así que nada de esto puede congelarse en una const de módulo)
// ============================================================

function getBaseUrl() {
  return (process.env.GIROX_API_URL || '').trim().replace(/\/+$/, '');
}

function getTimeoutMs() {
  return Number(process.env.GIROX_TIMEOUT_MS || 20000);
}

function _headers(apiKey) {
  return {
    'X-Api-Key': apiKey,
    'Content-Type': 'application/json',
    // La doc lo pide explícitamente: evita que los errores vuelvan en HTML.
    Accept: 'application/json'
  };
}

/**
 * Extrae { code, message } del cuerpo de error de la Partner API.
 * Formatos posibles: { error: { code, message } } | { code, message } | 422 Laravel.
 */
function _apiError(resp) {
  const body = (resp && resp.data) || {};
  const code = (body.error && body.error.code) || body.code || null;
  let message = (body.error && body.error.message) || body.message || null;

  // 422 de validación estilo Laravel: { message, errors: { campo: [...] } }
  if (!message && body.errors && typeof body.errors === 'object') {
    message = Object.entries(body.errors)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join(' | ');
  }
  return { code, message };
}

// ============================================================
// CREDENCIALES POR CAMPAÑA
// ============================================================

/**
 * Carga la API key de 1girox de una campaña (giroxApiKey está select:false en el
 * schema: hay que pedirlo explícitamente).
 * @returns {Promise<string|null>} la key, o null si no hay / la campaña no aplica
 */
async function _loadApiKey(campaignCode) {
  const code = String(campaignCode || '').toUpperCase().trim();
  if (!code) return null;

  const c = await Campaign.findOne({ code })
    .select('+giroxApiKey isActive')
    .lean();

  if (!c) {
    logger.warn(`[PublisherKeys] Campaña ${code} no existe`);
    return null;
  }
  if (c.isActive === false) {
    logger.warn(`[PublisherKeys] Campaña ${code} desactivada`);
    return null;
  }
  if (!c.giroxApiKey) {
    return null; // sin key — el caller usa fallback a la key master
  }
  return c.giroxApiKey;
}

// ============================================================
// API PÚBLICA
// ============================================================

/**
 * Crea un jugador en 1girox usando la API key del publicista indicado.
 * POST {GIROX_API_URL}/players  con X-Api-Key = key de la campaña.
 *
 * @param {string} campaignCode  código de la Campaign con giroxApiKey configurada
 * @param {{ username: string, password: string }} userData
 * @returns {Promise<{ success, player?, giroxUsername?, alreadyExists?, error?, code? }>}
 *   code:
 *     'NO_CREDS'  → la campaña no tiene API key configurada (usar fallback master)
 *     'API_ERROR' → 1girox respondió error (o falló la red)
 *     undefined   → success === true
 *
 *   ⚠️ NO hay `giroxUserId` en la respuesta: la Partner API no devuelve el ID
 *   numérico del jugador. Ese ID se resuelve después contra el panel, con
 *   `giroxUserLinkService.resolveGiroxUserId`.
 *
 *   (Los códigos 'LOGIN_FAILED' y 'HTML_BLOCKED' del servicio viejo ya no aplican:
 *   sin login no hay login fallido, y la Partner API responde JSON siempre.)
 */
async function createUserAsPublisher(campaignCode, { username, password }) {
  const apiKey = await _loadApiKey(campaignCode);
  if (!apiKey) {
    return { success: false, error: 'Campaña sin API key de 1girox configurada', code: 'NO_CREDS' };
  }

  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    logger.error('[PublisherKeys] GIROX_API_URL no configurada');
    return { success: false, error: 'La plataforma no está configurada. Avisale al soporte.', code: 'API_ERROR' };
  }

  // Mismas reglas de username que el cliente principal (3-18 chars, [A-Za-z0-9_]).
  // Se valida ANTES de gastar el request: la API lo rechazaría con un 422 igual.
  const check = giroxService.validateUsername(username);
  if (!check.valid) {
    return {
      success: false,
      error: `Usuario inválido para la plataforma: ${check.reason}`,
      code: 'API_ERROR'
    };
  }
  if (!password || String(password).length < 6) {
    return { success: false, error: 'La contraseña debe tener al menos 6 caracteres', code: 'API_ERROR' };
  }

  try {
    const resp = await axios.post(
      `${baseUrl}/players`,
      { username: String(username), password: String(password) },
      {
        headers: _headers(apiKey),
        timeout: getTimeoutMs(),
        proxy: false,
        validateStatus: () => true
      }
    );

    if (resp.status >= 200 && resp.status < 300) {
      const player = (resp.data && resp.data.player) || null;
      logger.info(`[PublisherKeys] Jugador ${username} creado en 1girox con la key de ${campaignCode}`);
      return {
        success: true,
        player,
        giroxUsername: (player && player.username) || String(username)
      };
    }

    const { code, message } = _apiError(resp);

    // Username ya tomado → 422 de validación mencionando `username`. Se reporta como
    // "ya existe" (igual que giroxService.createPlatformUser) para que el caller
    // pueda tratarlo como vinculación en vez de error.
    //
    // ⚠️ ATENCIÓN A LA ATRIBUCIÓN: si el jugador YA existía, quedó bajo el agente que
    // lo creó originalmente — crearlo de nuevo con la key del publicista NO lo mueve
    // de rama. En ese caso la comisión sigue yendo a quien lo captó primero.
    if (resp.status === 422 && /username/i.test(JSON.stringify(resp.data || {}))) {
      logger.warn(`[PublisherKeys] ${campaignCode}/${username}: el username ya existe en 1girox`);
      return {
        success: false,
        alreadyExists: true,
        error: message || 'El usuario ya existe en la plataforma',
        code: 'API_ERROR'
      };
    }

    // 401 = la key del publicista es inválida o fue revocada. Se loguea fuerte: sin
    // arreglarla, TODOS los usuarios de ese publicista van a fallar.
    if (resp.status === 401 || code === 'unauthorized') {
      logger.error(`[PublisherKeys] ${campaignCode}: API KEY RECHAZADA (HTTP 401). ` +
        'Revisar la key de la campaña en el panel: ningún usuario nuevo se va a crear bajo este publicista.');
      return { success: false, error: 'La plataforma rechazó la API key del publicista', code: 'API_ERROR' };
    }

    logger.error(`[PublisherKeys] createPlayer ${campaignCode}/${username} falló: ` +
      `HTTP ${resp.status} ${code || ''} ${message || ''}`.trim());
    return {
      success: false,
      error: message || `Error de la plataforma (HTTP ${resp.status})`,
      code: 'API_ERROR',
      httpStatus: resp.status
    };
  } catch (err) {
    logger.error(`[PublisherKeys] createPlayer ${campaignCode}/${username} excepción: ${err.code || ''} ${err.message}`);
    return { success: false, error: err.message, code: 'API_ERROR' };
  }
}

/**
 * Verifica que una API key funcione, sin crear nada.
 *
 * CÓMO: consulta un jugador que con certeza no existe (nombre aleatorio).
 *   - 404 / player_not_found → la key es VÁLIDA (autenticó y sólo faltó el jugador)
 *   - 401 / unauthorized     → la key es inválida o fue revocada
 * Es el equivalente del `testCreds` viejo (que hacía un login real), pero como acá
 * no hay login, la única forma de probar la key es usarla contra un endpoint
 * inocuo — de lectura, para no dejar basura en la plataforma.
 *
 * ⚠️ Devuelve `ok`, NO `success`: así lo consume hoy el panel admin
 * (POST /api/admin/campaigns/:code/test-jugaygana-creds lee `result.ok`).
 *
 * @param {string} apiKey
 * @returns {Promise<{ ok: boolean, error?: string, httpStatus?: number }>}
 */
async function testKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, error: 'API key vacía' };

  const baseUrl = getBaseUrl();
  if (!baseUrl) return { ok: false, error: 'GIROX_API_URL no está configurada' };

  // Username inexistente pero VÁLIDO según las reglas de 1girox (3-18 chars,
  // sólo letras/números/_), para que el 404 sea por "no existe" y no un 422 de
  // validación que no diría nada sobre la key.
  const probe = `zz${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 18);

  try {
    const resp = await axios.get(`${baseUrl}/players/${encodeURIComponent(probe)}`, {
      headers: _headers(key),
      timeout: getTimeoutMs(),
      proxy: false,
      validateStatus: () => true
    });

    const { code, message } = _apiError(resp);

    // La key autenticó bien: sólo faltaba el jugador (que es lo esperado).
    if (resp.status === 404 || code === 'player_not_found') {
      return { ok: true };
    }
    // Improbable (habríamos acertado un username aleatorio), pero también prueba
    // que la key funciona.
    if (resp.status >= 200 && resp.status < 300) {
      return { ok: true };
    }
    if (resp.status === 401 || resp.status === 403 || code === 'unauthorized') {
      return { ok: false, error: 'La plataforma rechazó la API key', httpStatus: resp.status };
    }
    return {
      ok: false,
      error: message || `Error de la plataforma (HTTP ${resp.status})`,
      httpStatus: resp.status
    };
  } catch (err) {
    return { ok: false, error: `No se pudo conectar con la plataforma: ${err.code || err.message}` };
  }
}

/**
 * NO-OP. Se conserva SÓLO por compatibilidad con los 2 call sites de server.js
 * (PUT /api/admin/campaigns/:code y el DELETE permanente) que la llamaban para
 * tirar la sesión cacheada del pool cuando cambiaban las creds del publicista.
 *
 * En 1girox no hay nada que invalidar: no existe sesión ni cache — la key se lee
 * de MongoDB en CADA alta (`_loadApiKey`), así que un cambio de key desde el panel
 * tiene efecto inmediato en todas las instancias, sin coordinación entre ellas.
 * (Con JUGAYGANA esto era un bug real: cada instancia de EB tenía su propio pool
 * en memoria y sólo se invalidaba la que atendía el PUT.)
 *
 * Se puede borrar junto con los 2 call sites cuando se limpie el código de JUGAYGANA.
 */
function invalidateSession(campaignCode) {
  logger.debug(`[PublisherKeys] invalidateSession(${campaignCode}) — no-op: 1girox no cachea sesiones`);
}

module.exports = {
  createUserAsPublisher,
  testKey,
  invalidateSession
};
