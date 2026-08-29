/**
 * Servicio de Ingresos de Referidos
 * Consulta el endpoint royalty-statistics de JUGAYGANA
 * para calcular el revenue mensual por usuario referido.
 *
 * Autenticación: usa el header X-Token, igual que el panel oficial de JUGAYGANA.
 * El token se obtiene desde la sesión clásica de jugayganaService (PLATFORM_USER/PLATFORM_PASS).
 * NO se usa Authorization: Bearer para este endpoint.
 * NO se usa Cookie para este endpoint.
 *
 * Variables de entorno relevantes:
 *   JUGAYGANA_ADMIN_REPORTS_URL        - URL completa del endpoint (default: /api/v2/admin/reports/royalty-statistics)
 *   PLATFORM_USER / PLATFORM_PASS      - credenciales principales (mismo login que el resto de operaciones)
 *                                        La sesión clásica de jugayganaService se usa como fuente primaria de auth.
 *   JUGAYGANA_API_KEY                  - API key estática (override opcional; si se configura, se usa en lugar del login)
 *   JUGAYGANA_REPORTS_LOGIN_URL        - (opcional/deprecated) URL de login REST JSON dedicado para reports.
 *                                        Solo se usa si jugayganaService no obtiene token. Si no se configura, se ignora.
 *   JUGAYGANA_REPORTS_USER             - (opcional) usuario para el login dedicado de reports (default: PLATFORM_USER)
 *   JUGAYGANA_REPORTS_PASS             - (opcional) contraseña para el login dedicado de reports (default: PLATFORM_PASS)
 *   JUGAYGANA_REPORTS_LOGIN_BODY_FIELD - (opcional) campo de usuario en el body del login dedicado (default: "login")
 *   JUGAYGANA_REVENUE_CHILD_USER_ID_FIELD - campo para el ID numérico del usuario referido (default: "child_user_id").
 *                                        El panel oficial usa "child_user_id" con el ID numérico del proveedor.
 *                                        Enviar un campo login/username devuelve el agregado global del agente.
 *   JUGAYGANA_REVENUE_LOGIN_FIELD      - DEPRECATED: ya no se usa para identificar al usuario referido.
 *   JUGAYGANA_REVENUE_DATE_FORMAT      - formato de fechas ("iso", "epoch_ms", "epoch_s" – default: "iso")
 *   JUGAYGANA_REVENUE_DATE_FROM_FIELD  - nombre del campo fecha inicio en el body (default: "date_from")
 *   JUGAYGANA_REVENUE_DATE_TO_FIELD    - nombre del campo fecha fin en el body (default: "date_to")
 *   JUGAYGANA_REPORTS_TOKEN_IN_BODY    - si "true", también envía el token como campo "token" en el body JSON
 */
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const logger = require('../utils/logger');
const { getPeriodRange } = require('../utils/periodKey');
const jugayganaService = require('./jugayganaService');

const ADMIN_API_URL = process.env.JUGAYGANA_ADMIN_REPORTS_URL ||
  'https://admin.agentesadmin.bet/api/v2/admin/reports/royalty-statistics';
const PROXY_URL = process.env.PROXY_URL || '';

// API key estática: override opcional. Si se configura, se usa directamente sin login.
const JUGAYGANA_API_KEY = process.env.JUGAYGANA_API_KEY || '';

// Login dedicado para reports (opcional/deprecated – solo se usa si jugayganaService no puede obtener token)
const REPORTS_LOGIN_URL = process.env.JUGAYGANA_REPORTS_LOGIN_URL || '';
const REPORTS_USER = process.env.JUGAYGANA_REPORTS_USER || process.env.PLATFORM_USER || '';
const REPORTS_PASS = process.env.JUGAYGANA_REPORTS_PASS || process.env.PLATFORM_PASS || '';

// El panel oficial usa X-Token para royalty-statistics; este servicio replica ese esquema.
const JUGAYGANA_AUTH_SCHEME = 'X-Token';

// Si true, también agrega el token como campo "token" en el body JSON (compatibilidad con API legacy)
const REPORTS_TOKEN_IN_BODY = (process.env.JUGAYGANA_REPORTS_TOKEN_IN_BODY || '').toLowerCase() === 'true';

// Campo de usuario en el body del login dedicado (solo relevante si REPORTS_LOGIN_URL está configurado)
const ALLOWED_LOGIN_BODY_FIELDS = ['login', 'username', 'email'];
const REPORTS_LOGIN_BODY_FIELD_RAW = process.env.JUGAYGANA_REPORTS_LOGIN_BODY_FIELD || 'login';
const REPORTS_LOGIN_BODY_FIELD = ALLOWED_LOGIN_BODY_FIELDS.includes(REPORTS_LOGIN_BODY_FIELD_RAW)
  ? REPORTS_LOGIN_BODY_FIELD_RAW
  : (() => {
      logger.warn(
        `[ReferralRevenue] JUGAYGANA_REPORTS_LOGIN_BODY_FIELD="${REPORTS_LOGIN_BODY_FIELD_RAW}" no válido ` +
        `(permitidos: ${ALLOWED_LOGIN_BODY_FIELDS.join(', ')}). Usando "login".`
      );
      return 'login';
    })();

// Campo que identifica al usuario hijo (referido) en el body de revenue.
// El panel oficial usa "child_user_id" con el ID numérico del proveedor.
// Enviar solo un campo "login"/username devuelve el agregado global del agente, no datos individuales.
const REVENUE_CHILD_USER_ID_FIELD = process.env.JUGAYGANA_REVENUE_CHILD_USER_ID_FIELD || 'child_user_id';

// DEPRECATED: JUGAYGANA_REVENUE_LOGIN_FIELD ya no se usa para identificar al usuario referido.
// El panel oficial usa child_user_id (ID numérico) — no un campo login/username.
// Esta constante se mantiene solo para no romper configuraciones existentes, pero no se aplica al revenue.
const REVENUE_LOGIN_FIELD = process.env.JUGAYGANA_REVENUE_LOGIN_FIELD || 'login';

// Formato de fechas para el body del endpoint de revenue (#148):
//   "iso"          = "YYYY-MM-DD" en UTC (comportamiento histórico). ⚠️ JUGAYGANA lo
//                    interpreta como medianoche UTC (fin EXCLUSIVO) → el "día" queda corrido
//                    3 h: [21:00 ART de ayer, 21:00 ART de hoy). Probado con logs (WORKLOG #148).
//   "iso_art"      = "YYYY-MM-DD" en hora Argentina (mismo problema de granularidad).
//   "datetime_utc" = "YYYY-MM-DD HH:mm:ss" en UTC.
//   "datetime_art" = "YYYY-MM-DD HH:mm:ss" en hora Argentina.
//   "epoch_s" / "epoch_ms" = timestamps.
// Prioridad: override en runtime (Config privada → setDateFormat) > env > "iso".
const ALLOWED_DATE_FORMATS = ['iso', 'iso_art', 'datetime_utc', 'datetime_art', 'epoch_ms', 'epoch_s'];
// Default "epoch_s" desde 2026-08-29 (#148): probado con el diagnóstico que epoch_s /
// epoch_ms / datetime_utc devuelven EXACTAMENTE lo que muestra el panel de JUGAYGANA
// para el día argentino; "iso" (histórico) y "datetime_art" devuelven el día corrido
// 3 h (JUGAYGANA interpreta fechas/horas sin zona como UTC).
const REVENUE_DATE_FORMAT_RAW = process.env.JUGAYGANA_REVENUE_DATE_FORMAT || 'epoch_s';
const REVENUE_DATE_FORMAT_ENV = ALLOWED_DATE_FORMATS.includes(REVENUE_DATE_FORMAT_RAW)
  ? REVENUE_DATE_FORMAT_RAW
  : (() => {
      logger.warn(
        `[ReferralRevenue] JUGAYGANA_REVENUE_DATE_FORMAT="${REVENUE_DATE_FORMAT_RAW}" no es un valor válido ` +
        `(permitidos: ${ALLOWED_DATE_FORMATS.join(', ')}). Usando "iso".`
      );
      return 'epoch_s';
    })();
let _dateFormatOverride = null;
function setDateFormat(fmt) { _dateFormatOverride = ALLOWED_DATE_FORMATS.includes(fmt) ? fmt : null; }
function getDateFormat() { return _dateFormatOverride || REVENUE_DATE_FORMAT_ENV; }

// Nombres de los campos de fecha inicio/fin en el body del endpoint de revenue
const REVENUE_DATE_FROM_FIELD = process.env.JUGAYGANA_REVENUE_DATE_FROM_FIELD || 'date_from';
const REVENUE_DATE_TO_FIELD = process.env.JUGAYGANA_REVENUE_DATE_TO_FIELD || 'date_to';

let httpsAgent = null;
if (PROXY_URL) {
  httpsAgent = new HttpsProxyAgent(PROXY_URL);
}

const reportsClient = axios.create({
  timeout: 30000,
  httpsAgent,
  proxy: false,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://admin.agentesadmin.bet',
    'Referer': 'https://admin.agentesadmin.bet/',
    'Accept-Language': 'es-419,es;q=0.9'
  }
});

// Log de configuración de autenticación al cargar el módulo
(() => {
  if (JUGAYGANA_API_KEY) {
    logger.info(
      `[ReferralRevenue] Auth: JUGAYGANA_API_KEY configurada (override estático) | ` +
      `authScheme=${JUGAYGANA_AUTH_SCHEME} (X-Token, igual que el panel oficial) endpoint=${ADMIN_API_URL}`
    );
  } else {
    logger.info(
      `[ReferralRevenue] Auth: fuente primaria = jugayganaService (PLATFORM_USER/PLATFORM_PASS) | ` +
      `authScheme=${JUGAYGANA_AUTH_SCHEME} (X-Token, igual que el panel oficial) ` +
      `authorizationBearerUsed=false endpoint=${ADMIN_API_URL}` +
      (REPORTS_LOGIN_URL ? ` | fallback secundario: JUGAYGANA_REPORTS_LOGIN_URL=${REPORTS_LOGIN_URL}` : '')
    );
  }
})();

const parseJson = (data) => {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data.substring(data.indexOf('{'), data.lastIndexOf('}') + 1));
  } catch {
    return data;
  }
};

const isHtmlBlocked = (data) => {
  return typeof data === 'string' && data.trim().startsWith('<');
};

/**
 * Genera una huella segura del token para logging (sin exponer el valor completo).
 * Para tokens de sesión muestra: "len=128 prefix=eyJhbGci..."
 * Para API keys estáticas muestra solo la longitud (nunca el prefijo).
 * @param {string|null} token
 * @param {boolean} [isStaticSecret=false] - true para API keys estáticas; nunca expone prefijo
 */
function safeTokenFingerprint(token, isStaticSecret = false) {
  if (!token) return '(null)';
  if (isStaticSecret) return `len=${token.length}`;
  if (token.length <= 12) return `len=${token.length}`;
  return `len=${token.length} prefix=${token.substring(0, 8)}...`;
}

/**
 * Obtener token activo para autenticar la llamada al endpoint de revenue.
 *
 * Prioridad:
 *   1. JUGAYGANA_API_KEY (override estático; si está configurada, se usa directamente)
 *   2. Sesión clásica de jugayganaService via PLATFORM_USER / PLATFORM_PASS (fuente primaria)
 *   3. Login REST JSON a JUGAYGANA_REPORTS_LOGIN_URL (fallback opcional; solo si está configurado
 *      y jugayganaService no pudo obtener token)
 *
 * La sesión de jugayganaService ya maneja su propio caché y TTL; no se duplica aquí.
 *
 * @returns {{ token: string|null, source: string, cookie: string|null }}
 */
async function getActiveToken() {
  // 1. API key estática (override opcional)
  if (JUGAYGANA_API_KEY) {
    logger.debug('[ReferralRevenue] Usando JUGAYGANA_API_KEY como token estático (override)');
    return { token: JUGAYGANA_API_KEY, source: 'env:JUGAYGANA_API_KEY', cookie: null };
  }

  // 2. Sesión clásica de jugayganaService (PLATFORM_USER / PLATFORM_PASS) — fuente primaria
  // Verificar si ya hay una sesión cacheada antes de llamar ensureSession()
  const tokenBeforeEnsure = jugayganaService.getSessionToken();
  const sessionWasCached = !!tokenBeforeEnsure;

  logger.info(
    `[ReferralRevenue] Obteniendo sesión de jugayganaService (PLATFORM_USER/PLATFORM_PASS) para revenue | ` +
    `sesionPrevia=${sessionWasCached ? 'reutilizada' : 'login-fresco'}`
  );

  const sessionOk = await jugayganaService.ensureSession();
  if (sessionOk) {
    const token = jugayganaService.getSessionToken();
    const sessionReused = sessionWasCached && token === tokenBeforeEnsure;
    logger.info(
      `[ReferralRevenue] jugayganaService.ensureSession() exitoso | ` +
      `tokenPresente=${!!token} ` +
      `tokenSource=jugayganaService sessionState=${sessionReused ? 'reutilizada' : 'login-fresco'} ` +
      `tokenFingerprint=${safeTokenFingerprint(token)} authModeTested=X-Token`
    );
    if (token) {
      return {
        token,
        source: 'jugayganaService',
        cookie: null,
        sessionReused
      };
    }
    logger.warn(
      '[ReferralRevenue] jugayganaService.ensureSession() respondió ok pero no hay token en la sesión'
    );
  } else {
    logger.warn(
      '[ReferralRevenue] jugayganaService.ensureSession() falló — ' +
      'verificar PLATFORM_USER y PLATFORM_PASS'
    );
  }

  // 3. Fallback opcional: login REST JSON a JUGAYGANA_REPORTS_LOGIN_URL (si está configurado)
  if (REPORTS_LOGIN_URL && REPORTS_USER && REPORTS_PASS) {
    logger.info(
      `[ReferralRevenue] jugayganaService no pudo obtener token. ` +
      `Intentando login REST JSON en JUGAYGANA_REPORTS_LOGIN_URL (fallback) | ` +
      `url=${REPORTS_LOGIN_URL} user=${REPORTS_USER} loginBodyField=${REPORTS_LOGIN_BODY_FIELD}`
    );
    try {
      const loginBody = { [REPORTS_LOGIN_BODY_FIELD]: REPORTS_USER, password: REPORTS_PASS };
      if (REPORTS_LOGIN_BODY_FIELD !== 'username') loginBody.username = REPORTS_USER;

      const resp = await reportsClient.post(REPORTS_LOGIN_URL, loginBody, {
        validateStatus: s => s >= 200 && s < 500
      });
      let data = resp.data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch {
          logger.debug(`[ReferralRevenue] Login REST JSON (${REPORTS_LOGIN_URL}): body llegó como string no parseable (status=${resp.status})`);
        }
      }

      if (resp.status === 200 && data && typeof data === 'object') {
        const token = data?.token || data?.access_token || data?.sessionToken ||
                      data?.data?.token || data?.data?.access_token ||
                      data?.result?.token || data?.jwt || data?.authToken;
        if (token) {
          logger.info(
            `[ReferralRevenue] Login REST JSON en JUGAYGANA_REPORTS_LOGIN_URL exitoso | ` +
            `tokenSource=reports:dedicated-login`
          );
          return { token, source: 'reports:dedicated-login', cookie: null };
        }
        logger.warn(
          `[ReferralRevenue] Login REST JSON respondió 200 pero sin token reconocido | ` +
          `url=${REPORTS_LOGIN_URL} camposRespuesta=${Object.keys(data || {}).join(', ') || '(vacío)'}`
        );
      } else {
        logger.warn(
          `[ReferralRevenue] Login REST JSON en JUGAYGANA_REPORTS_LOGIN_URL falló | ` +
          `status=${resp.status} respuesta=${JSON.stringify(data).substring(0, 200)}`
        );
      }
    } catch (err) {
      logger.warn(`[ReferralRevenue] Error en login REST JSON (${REPORTS_LOGIN_URL}): ${err.message}`);
    }
  }

  logger.error(
    '[ReferralRevenue] No se pudo obtener token para revenue. ' +
    'Verificar PLATFORM_USER y PLATFORM_PASS (fuente primaria). ' +
    (!REPORTS_LOGIN_URL ? 'JUGAYGANA_REPORTS_LOGIN_URL no configurado (fallback no disponible). ' : '')
  );
  return { token: null, source: 'none', cookie: null };
}

/**
 * Construir los headers de autenticación para la solicitud al endpoint de revenue.
 * Usa X-Token (igual que el panel oficial de JUGAYGANA). NO usa Authorization: Bearer.
 */
function buildAuthHeaders(token) {
  const headers = { 'Content-Type': 'application/json' };

  if (token) {
    headers['X-Token'] = token;
    logger.debug('[ReferralRevenue] Auth header: X-Token <token presente> | authorizationBearerUsed=false');
  } else {
    logger.warn('[ReferralRevenue] Token no disponible: X-Token header no será enviado | xTokenPresent=false');
  }

  return headers;
}

/**
 * Formatear fechas para el body según REVENUE_DATE_FORMAT
 */
function _artParts(date) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(date);
  const g = (t) => (p.find(x => x.type === t) || {}).value;
  return { ymd: `${g('year')}-${g('month')}-${g('day')}`, hms: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}:${g('second')}` };
}
function formatRevenueDate(date, epochSecs, fmtOverride) {
  const fmt = fmtOverride || getDateFormat();
  if (fmt === 'epoch_s') return epochSecs;
  if (fmt === 'epoch_ms') return date.getTime();
  if (fmt === 'datetime_utc') return date.toISOString().slice(0, 19).replace('T', ' ');
  if (fmt === 'datetime_art') { const a = _artParts(date); return `${a.ymd} ${a.hms}`; }
  if (fmt === 'iso_art') return _artParts(date).ymd;
  // default: "iso" → "YYYY-MM-DD" (UTC)
  return date.toISOString().split('T')[0];
}

/**
 * Ejecutar la llamada POST al endpoint de revenue con X-Token (igual que el panel oficial).
 * Usa child_user_id (ID numérico del proveedor) para filtrar por usuario referido individual,
 * replicando exactamente el payload que el panel oficial envía.
 * Retorna el objeto de respuesta de axios.
 *
 * @param {string} username - username del referido (solo para logging)
 * @param {string|number} fromFormatted - fecha inicio
 * @param {string|number} toFormatted - fecha fin
 * @param {Object} authInfo - info de autenticación con token
 * @param {number|string} jugayganaUserId - ID numérico del usuario en el proveedor (child_user_id)
 */
async function callRevenueEndpoint(username, fromFormatted, toFormatted, authInfo, jugayganaUserId) {
  const { token } = authInfo;
  const headers = buildAuthHeaders(token);

  // El panel oficial usa { child_user_id: <numeric_id>, date_from, date_to }.
  // Enviar { login: username } en lugar de child_user_id devuelve el agregado global del agente,
  // NO datos individuales del usuario referido — ese era el bug original.
  const body = {
    [REVENUE_CHILD_USER_ID_FIELD]: jugayganaUserId,
    [REVENUE_DATE_FROM_FIELD]: fromFormatted,
    [REVENUE_DATE_TO_FIELD]: toFormatted
  };

  // Compatibilidad con APIs que aceptan el token en el body
  if (REPORTS_TOKEN_IN_BODY && token) {
    body.token = token;
  }

  const xTokenPresent = !!token;
  logger.info(
    `[ReferralRevenue] POST royalty-statistics | referredUser=${username} referredUserId=${jugayganaUserId} ` +
    `revenueScope=perUser commissionCalculationMode=individual_revenue ` +
    `authModeTested=X-Token authorizationBearerUsed=false xTokenPresent=${xTokenPresent} ` +
    `childUserIdField=${REVENUE_CHILD_USER_ID_FIELD} ${REVENUE_DATE_FROM_FIELD}=${fromFormatted} ${REVENUE_DATE_TO_FIELD}=${toFormatted} ` +
    `dateFormat=${getDateFormat()} tokenSource=${authInfo.source} ` +
    `tokenEnBody=${REPORTS_TOKEN_IN_BODY} endpoint=${ADMIN_API_URL}`
  );
  // Ocultar token en body antes de loguear para no exponer credenciales
  const { token: _tokenField, ...safeBody } = body;
  if (_tokenField) safeBody.token = '<redacted>';
  logger.debug(`[ReferralRevenue] Request body: ${JSON.stringify(safeBody)}`);

  return reportsClient.post(ADMIN_API_URL, body, {
    headers,
    validateStatus: () => true
  });
}

/**
 * Consultar royalty-statistics para un usuario referido y período.
 * Usa X-Token igual que el panel oficial de JUGAYGANA.
 * Usa child_user_id (ID numérico del proveedor) para obtener datos individuales del usuario referido.
 * NO usa Authorization: Bearer. NO usa Cookie.
 * NO usa login/username como identificador de usuario (eso retorna el agregado global del agente).
 *
 * @param {string} username - username del referido (para logging)
 * @param {string} periodKey - e.g. "2026-04"
 * @param {number|string|null} jugayganaUserId - ID numérico del usuario en el proveedor (child_user_id).
 *   Si es null, se retorna error explícito porque sin este ID la API devolvería el agregado global.
 * @returns {Object} resultado de revenue calculado
 */
async function getUserRevenueForPeriod(username, periodKey, jugayganaUserId) {
  const { fromEpoch, toEpoch, fromDate, toDate } = getPeriodRange(periodKey);
  const fromFormatted = formatRevenueDate(fromDate, fromEpoch);
  const toFormatted = formatRevenueDate(toDate, toEpoch);

  // VERIFICACIÓN CRÍTICA: sin jugayganaUserId no es posible obtener revenue individual.
  // El endpoint royalty-statistics requiere child_user_id (ID numérico del proveedor) para filtrar
  // por usuario referido. Sin este campo, la API devuelve el agregado global del agente —
  // lo que causaba que todos los referidos mostraran los mismos valores enormes.
  if (jugayganaUserId === null || jugayganaUserId === undefined) {
    logger.warn(
      `[ReferralRevenue] referredUser=${username} jugayganaUserId=null | ` +
      `individualRevenueFound=false revenueScope=unknown usedGlobalAggregate=false ` +
      `commissionCalculationMode=individual_revenue_unavailable | ` +
      `royalty-statistics does not provide individual referred-user revenue without child_user_id. ` +
      `El usuario no tiene jugayganaUserId asignado. Sincronizarlo con JUGAYGANA para habilitar ` +
      `revenue individual. Revenue forzado a 0 para evitar usar el agregado global del agente.`
    );
    return {
      success: false,
      error: 'jugayganaUserId no disponible: no se puede obtener revenue individual sin child_user_id. ' +
        'Sincronizar el usuario con JUGAYGANA para obtener su ID numérico de proveedor.',
      individualRevenueFound: false,
      usedGlobalAggregate: false,
      commissionCalculationMode: 'individual_revenue_unavailable'
    };
  }

  const authInfo = await getActiveToken();
  const isStaticApiKey = authInfo.source === 'env:JUGAYGANA_API_KEY';
  // Compute token fingerprint without ever passing the static API key value to any function
  let tokenFp;
  if (isStaticApiKey) {
    tokenFp = '(static-api-key)';
  } else {
    tokenFp = safeTokenFingerprint(authInfo.token);
  }

  if (!authInfo.token) {
    logger.error(
      `[ReferralRevenue] Sin token para X-Token | referredUser=${username} referredUserId=${jugayganaUserId} ` +
      `tokenSource=${authInfo.source} xTokenPresent=false authorizationBearerUsed=false`
    );
    return {
      success: false,
      error: 'No hay sesión válida en JUGAYGANA. Verificar PLATFORM_USER y PLATFORM_PASS.',
      diagnosisCategory: 'provider_response_inconclusive',
      conclusion: 'No se pudo obtener token desde jugayganaService (PLATFORM_USER/PLATFORM_PASS). Verificar credenciales.',
      authDetail: {
        authModeTested: 'X-Token',
        authorizationBearerUsed: false,
        xTokenPresent: false,
        tokenSource: authInfo.source,
        reportsEndpoint: ADMIN_API_URL
      }
    };
  }

  logger.info(
    `[ReferralRevenue] Iniciando royalty-statistics con X-Token | ` +
    `referredUser=${username} referredUserId=${jugayganaUserId} período=${periodKey} ` +
    `revenueScope=perUser commissionCalculationMode=individual_revenue ` +
    `authModeTested=X-Token xTokenPresent=true xTokenFingerprint=${tokenFp} ` +
    `tokenSource=${authInfo.source} authorizationBearerUsed=false ` +
    `sessionState=${authInfo.sessionReused ? 'reutilizada' : 'login-fresco'} ` +
    `endpoint=${ADMIN_API_URL}`
  );

  try {
    const resp = await callRevenueEndpoint(username, fromFormatted, toFormatted, authInfo, jugayganaUserId);

    const rawBody = resp.data == null
      ? '(empty)'
      : typeof resp.data === 'string'
        ? resp.data.substring(0, 500)
        : JSON.stringify(resp.data).substring(0, 500);
    const parsed = parseJson(resp.data);
    const providerMsg = !isHtmlBlocked(parsed) && typeof parsed === 'object'
      ? (parsed?.error?.message || parsed?.message || parsed?.error || null)
      : null;
    const providerCode = !isHtmlBlocked(parsed) && typeof parsed === 'object'
      ? (parsed?.error?.code || parsed?.code || null)
      : null;

    logger.info(
      `[ReferralRevenue] royalty-statistics respuesta | authModeTested=X-Token authorizationBearerUsed=false ` +
      `providerStatus=${resp.status} referredUser=${username} referredUserId=${jugayganaUserId} ` +
      `revenueScope=perUser revenueSourceField=${REVENUE_CHILD_USER_ID_FIELD} ` +
      `providerMsg="${providerMsg || '(sin mensaje)'}" providerCode=${providerCode || '(sin código)'} | ` +
      `body=${rawBody}`
    );

    // Éxito
    if (resp.status === 200) {
      const hasData = resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data);
      const isExplicitFailure = hasData && 'success' in resp.data && !resp.data.success;
      if (hasData && !isExplicitFailure) {
        logger.info(
          `[ReferralRevenue] Éxito con X-Token | referredUser=${username} referredUserId=${jugayganaUserId} período=${periodKey} ` +
          `individualRevenueFound=true usedGlobalAggregate=false revenueScope=perUser ` +
          `revenueSourceField=${REVENUE_CHILD_USER_ID_FIELD} commissionCalculationMode=individual_revenue ` +
          `authModeTested=X-Token providerStatus=200 ` +
          `conclusion=El endpoint de revenue responde correctamente con X-Token como en el panel oficial`
        );
        return parseRoyaltyResponse(resp.data, username, periodKey);
      }
      logger.warn(
        `[ReferralRevenue] Respuesta 200 pero no exitosa para referredUser=${username} referredUserId=${jugayganaUserId}: ${rawBody} | ` +
        `authModeTested=X-Token`
      );
      return { success: false, error: 'Respuesta no exitosa del endpoint', rawBody };
    }

    // Error de validación
    if (resp.status === 422) {
      logger.warn(
        `[ReferralRevenue] HTTP 422 - Validation error del proveedor para referredUser=${username} referredUserId=${jugayganaUserId} | ` +
        `authModeTested=X-Token childUserIdField=${REVENUE_CHILD_USER_ID_FIELD} (valor=${jugayganaUserId}), ` +
        `dateFromField=${REVENUE_DATE_FROM_FIELD} (valor="${fromFormatted}"), ` +
        `dateToField=${REVENUE_DATE_TO_FIELD} (valor="${toFormatted}"), ` +
        `dateFormat=${REVENUE_DATE_FORMAT} | Respuesta proveedor: ${rawBody}`
      );
    }

    // Error de autenticación
    if (resp.status === 401 || resp.status === 403) {
      const conclusion = `authModeTested=X-Token providerStatus=${resp.status} ` +
        `Incluso con X-Token el endpoint fue rechazado; revisar permisos o headers/contexto adicionales del panel oficial`;
      logger.error(
        `[ReferralRevenue] Autenticación rechazada (${resp.status}) para referredUser=${username} referredUserId=${jugayganaUserId} | ` +
        `authModeTested=X-Token xTokenPresent=true xTokenFingerprint=${tokenFp} ` +
        `authorizationBearerUsed=false tokenSource=${authInfo.source} ` +
        `sessionState=${authInfo.sessionReused ? 'reutilizada' : 'login-fresco'} ` +
        `providerMsg="${providerMsg || 'Access denied'}" providerCode=${providerCode || '(sin código)'} | ` +
        `endpoint=${ADMIN_API_URL} | CONCLUSIÓN: ${conclusion}`
      );
      return {
        success: false,
        error: `HTTP ${resp.status}`,
        statusCode: resp.status,
        providerMessage: providerMsg,
        providerCode,
        diagnosisCategory: 'classic_token_rejected_by_endpoint',
        conclusion,
        authDetail: {
          authModeTested: 'X-Token',
          authorizationBearerUsed: false,
          xTokenPresent: true,
          xTokenFingerprint: tokenFp,
          tokenSource: authInfo.source,
          sessionState: authInfo.sessionReused ? 'reutilizada' : 'login-fresco',
          reportsEndpoint: ADMIN_API_URL,
          conclusion
        },
        rawProviderBody: rawBody
      };
    }

    // Otro status de error
    logger.warn(
      `[ReferralRevenue] HTTP ${resp.status} para referredUser=${username} referredUserId=${jugayganaUserId} | ` +
      `authModeTested=X-Token authorizationBearerUsed=false xTokenPresent=${!!authInfo.token} ` +
      `providerMsg="${providerMsg || '(sin mensaje)'}" providerCode=${providerCode || '(sin código)'} | ` +
      `endpoint=${ADMIN_API_URL} | respuesta=${rawBody}`
    );
    return {
      success: false,
      error: `HTTP ${resp.status}`,
      statusCode: resp.status,
      providerMessage: providerMsg,
      providerCode,
      authDetail: {
        authModeTested: 'X-Token',
        authorizationBearerUsed: false,
        xTokenPresent: !!authInfo.token,
        tokenSource: authInfo.source,
        reportsEndpoint: ADMIN_API_URL
      },
      rawProviderBody: rawBody
    };

  } catch (err) {
    logger.error(`[ReferralRevenue] Error consultando royalty-statistics para referredUser=${username} referredUserId=${jugayganaUserId}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Parsear la respuesta del endpoint royalty-statistics y calcular revenue
 * @param {Object} data - respuesta cruda del endpoint
 * @param {string} username
 * @param {string} periodKey
 * @returns {Object}
 */
function parseRoyaltyResponse(data, username, periodKey) {
  try {
    const currency = 'ARS';
    // La API v2 puede devolver { data: { totals, providers } } o { totals, providers } directamente
    const inner = data?.data || data;
    const totals = inner?.totals?.[currency] || {};
    const providers = inner?.providers || [];

    const totalBets = Number(totals.total_bets || 0) / 100;
    const totalWins = Number(totals.total_wins || 0) / 100;
    const totalGgr = Number(totals.total_ggr || 0) / 100;

    const providersBreakdown = [];
    let totalOwnerRevenue = 0;

    for (const provider of providers) {
      const stats = provider?.stats_by_currency?.[currency];
      if (!stats) continue;

      const ggr = Number(stats.ggr || 0) / 100;
      const ownerCommissionRate = Number(stats.owner_commission || 0);

      if (typeof ownerCommissionRate !== 'number' || isNaN(ownerCommissionRate)) {
        logger.warn(`[ReferralRevenue] owner_commission inválido para provider ${provider.name}, usuario ${username}`);
        continue;
      }

      // Solo revenue positivo genera comisión
      const providerOwnerRevenue = Math.max(0, ggr) * ownerCommissionRate;

      providersBreakdown.push({
        providerName: provider.name || 'unknown',
        ggr,
        ownerCommissionRate,
        ownerRevenue: providerOwnerRevenue
      });

      totalOwnerRevenue += providerOwnerRevenue;
    }

    logger.info(
      `[ReferralRevenue] referredUser=${username} período ${periodKey}: ` +
      `individualRevenueFound=true usedGlobalAggregate=false revenueScope=perUser ` +
      `revenueSourceField=${REVENUE_CHILD_USER_ID_FIELD} commissionCalculationMode=individual_revenue | ` +
      `GGR=$${totalGgr.toFixed(2)}, ownerRevenue=$${totalOwnerRevenue.toFixed(2)}`
    );

    return {
      success: true,
      username,
      period: periodKey,
      currency,
      totalBets,
      totalWins,
      totalGgr,
      providers: providersBreakdown,
      totalOwnerRevenue,
      individualRevenueFound: true,
      usedGlobalAggregate: false,
      revenueScope: 'perUser',
      revenueSourceField: REVENUE_CHILD_USER_ID_FIELD,
      commissionCalculationMode: 'individual_revenue'
    };
  } catch (err) {
    logger.error(`[ReferralRevenue] Error parseando respuesta para ${username}:`, err.message);
    return { success: false, error: `Error parseando respuesta: ${err.message}` };
  }
}

/**
 * Obtener NETWIN (GGR) de un usuario para un rango de fechas arbitrario.
 * Reutiliza la misma autenticación y lógica que getUserRevenueForPeriod.
 * Usado por el sistema de reembolsos diario, semanal y mensual.
 *
 * @param {string} username - username del usuario
 * @param {number|string|null} jugayganaUserId - ID numérico del usuario en la plataforma (child_user_id)
 * @param {Date} fromDate - fecha inicio (objeto Date)
 * @param {Date} toDate - fecha fin (objeto Date)
 * @param {string} [periodLabel='custom'] - etiqueta del período (solo para logging)
 * @returns {Object} { success, totalGgr, totalBets, totalWins, ... } o { success: false, error, totalGgr: 0 }
 */
async function getUserNetwinForDateRange(username, jugayganaUserId, fromDate, toDate, periodLabel = 'custom') {
  if (jugayganaUserId === null || jugayganaUserId === undefined) {
    logger.warn(
      `[ReferralRevenue] [Refund] referredUser=${username} jugayganaUserId=null | ` +
      `No se puede obtener NETWIN sin jugayganaUserId. Período: ${periodLabel}`
    );
    return {
      success: false,
      error: 'jugayganaUserId no disponible: no se puede obtener NETWIN individual sin child_user_id.',
      totalGgr: 0
    };
  }

  const fromEpoch = Math.floor(fromDate.getTime() / 1000);
  const toEpoch = Math.floor(toDate.getTime() / 1000);
  const fromFormatted = formatRevenueDate(fromDate, fromEpoch);
  const toFormatted = formatRevenueDate(toDate, toEpoch);

  const authInfo = await getActiveToken();
  if (!authInfo.token) {
    logger.error(
      `[ReferralRevenue] [Refund] Sin token para NETWIN | user=${username} userId=${jugayganaUserId} período=${periodLabel}`
    );
    return { success: false, error: 'No hay sesión válida en JUGAYGANA.', totalGgr: 0 };
  }

  try {
    const resp = await callRevenueEndpoint(username, fromFormatted, toFormatted, authInfo, jugayganaUserId);

    if (resp.status === 200) {
      const hasData = resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data);
      const isExplicitFailure = hasData && 'success' in resp.data && !resp.data.success;
      if (hasData && !isExplicitFailure) {
        const parsed = parseRoyaltyResponse(resp.data, username, periodLabel);
        if (parsed.success) {
          logger.info(
            `[ReferralRevenue] [Refund] NETWIN obtenido | user=${username} userId=${jugayganaUserId} ` +
            `período=${periodLabel} GGR=$${parsed.totalGgr.toFixed(2)}`
          );
        }
        return parsed;
      }
    }

    const rawBody = typeof resp.data === 'string'
      ? resp.data.substring(0, 300)
      : JSON.stringify(resp.data || '').substring(0, 300);
    logger.warn(
      `[ReferralRevenue] [Refund] Error obteniendo NETWIN | user=${username} userId=${jugayganaUserId} ` +
      `período=${periodLabel} status=${resp.status} body=${rawBody}`
    );
    return { success: false, error: `HTTP ${resp.status}`, totalGgr: 0 };
  } catch (err) {
    logger.error(
      `[ReferralRevenue] [Refund] Excepción obteniendo NETWIN | user=${username} userId=${jugayganaUserId} ` +
      `período=${periodLabel}: ${err.message}`
    );
    return { success: false, error: err.message, totalGgr: 0 };
  }
}

/**
 * #148 Diagnóstico: consulta el NETWIN del mismo rango con CADA formato de fecha y
 * devuelve los resultados lado a lado, para elegir el que coincide con el panel
 * de JUGAYGANA. Solo lectura (no toca reembolsos).
 */
async function diagnoseDateFormats(username, jugayganaUserId, fromDate, toDate) {
  const authInfo = await getActiveToken();
  if (!authInfo.token) return { ok: false, error: 'No hay sesión válida en JUGAYGANA.' };
  const out = [];
  for (const fmt of ALLOWED_DATE_FORMATS) {
    const fromF = formatRevenueDate(fromDate, Math.floor(fromDate.getTime() / 1000), fmt);
    const toF = formatRevenueDate(toDate, Math.floor(toDate.getTime() / 1000), fmt);
    const row = { format: fmt, active: fmt === getDateFormat(), sent: { [REVENUE_DATE_FROM_FIELD]: fromF, [REVENUE_DATE_TO_FIELD]: toF } };
    try {
      const resp = await callRevenueEndpoint(username, fromF, toF, authInfo, jugayganaUserId);
      row.status = resp.status;
      const hasData = resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data);
      if (resp.status === 200 && hasData && !('success' in resp.data && !resp.data.success)) {
        const parsed = parseRoyaltyResponse(resp.data, username, 'diagnostic-' + fmt);
        row.ok = !!parsed.success; row.netwin = parsed.totalGgr; row.bets = parsed.totalBets; row.wins = parsed.totalWins;
      } else {
        row.ok = false; row.error = typeof resp.data === 'string' ? resp.data.slice(0, 160) : JSON.stringify(resp.data || '').slice(0, 160);
      }
    } catch (e) { row.ok = false; row.error = e.message; }
    out.push(row);
  }
  return { ok: true, results: out, activeFormat: getDateFormat() };
}

module.exports = {
  setDateFormat,
  getDateFormat,
  diagnoseDateFormats,
  ALLOWED_DATE_FORMATS,
  getUserRevenueForPeriod,
  getUserNetwinForDateRange
};
