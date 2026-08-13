
/**
 * Servicio de Integración JUGAYGANA
 * Gestiona la comunicación con la API de JUGAYGANA
 */
const axios = require('axios');
const FormData = require('form-data');
const { HttpsProxyAgent } = require('https-proxy-agent');
const logger = require('../utils/logger');

// Configuración
const API_URL = process.env.JUGAYGANA_API_URL || 'https://admin.agentesadmin.bet/api/admin/';
const APP_API_URL = process.env.JUGAYGANA_APP_API_URL || 'https://jugaygana44.bet/api/app/';
const PROXY_URL = process.env.PROXY_URL || '';
const PLATFORM_USER = process.env.PLATFORM_USER;
const PLATFORM_PASS = process.env.PLATFORM_PASS;
const TOKEN_TTL_MINUTES = parseInt(process.env.TOKEN_TTL_MINUTES || '20', 10);

// Estado de sesión
let sessionToken = null;
let sessionCookie = null;
let sessionParentId = null;
let lastLogin = 0;

// Configurar agente proxy
let httpsAgent = null;
if (PROXY_URL) {
  httpsAgent = new HttpsProxyAgent(PROXY_URL);
  logger.info('Proxy configurado para JUGAYGANA');
}

// Cliente HTTP
const client = axios.create({
  baseURL: API_URL,
  timeout: 20000,
  httpsAgent,
  proxy: false,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://admin.agentesadmin.bet',
    'Referer': 'https://admin.agentesadmin.bet/users',
    'Accept-Language': 'es-419,es;q=0.9'
  }
});

// Helpers
const toFormUrlEncoded = (data) => {
  return Object.keys(data)
    .filter(k => data[k] !== undefined && data[k] !== null)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(data[k]))
    .join('&');
};

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

// Safe fingerprint helper — shows first 8 chars only, never exposes full value
const safeCookieFingerprint = (value) => {
  if (!value) return '(none)';
  return value.substring(0, 8) + '...';
};

/**
 * Login en JUGAYGANA
 */
const login = async () => {
  if (!PLATFORM_USER || !PLATFORM_PASS) {
    logger.error('Faltan credenciales de JUGAYGANA');
    return false;
  }

  try {
    const body = toFormUrlEncoded({
      action: 'LOGIN',
      username: PLATFORM_USER,
      password: PLATFORM_PASS
    });

    const resp = await client.post('', body, {
      validateStatus: s => s >= 200 && s < 500,
      maxRedirects: 0
    });

    // Parse set-cookie header and store session cookie
    const rawSetCookie = resp.headers['set-cookie'];
    if (rawSetCookie && Array.isArray(rawSetCookie) && rawSetCookie.length > 0) {
      const kept = rawSetCookie.map(c => c.split(';')[0]).filter(p => p && p.includes('='));
      sessionCookie = kept.join('; ');
    } else if (rawSetCookie) {
      // Non-array format (unexpected but handle gracefully)
      const firstPart = String(rawSetCookie).split(';')[0];
      sessionCookie = firstPart;
      logger.warn(
        `[JugayganaService] set-cookie en formato inesperado (no-array) | ` +
        `cookieAlmacenada=true fingerprint=${safeCookieFingerprint(firstPart)}`
      );
    } else {
      sessionCookie = null;
    }
    logger.info(
      `[JugayganaService] login set-cookie parsed | ` +
      `cookieObtained=${!!sessionCookie} cookieLength=${sessionCookie ? sessionCookie.length : 0} ` +
      `fingerprint=${safeCookieFingerprint(sessionCookie)}`
    );

    const data = parseJson(resp.data);
    
    if (isHtmlBlocked(data)) {
      logger.error('Login bloqueado por HTML');
      logger.error(`HTTP status: ${resp.status}, URL: ${API_URL}`);
      return false;
    }

    // Intentar token en múltiples campos por compatibilidad con cambios de API
    const token = data?.token || data?.access_token || data?.sessionToken || data?.data?.token;

    if (!token) {
      logger.error('Login falló: no se recibió token');
      logger.error(`HTTP status: ${resp.status}`);
      logger.error(`Content-Type: ${resp.headers['content-type'] || 'sin content-type'}`);
      logger.error(`URL usada: ${API_URL}`);
      if (typeof data === 'object' && data !== null) {
        const keys = Object.keys(data);
        logger.error(`Campos en respuesta: ${keys.length ? keys.join(', ') : '(objeto vacío)'}`);
        const errMsg = data.error || data.message || data.msg || data.detail;
        if (errMsg) logger.error(`Mensaje de error de API: ${errMsg}`);
      } else if (typeof data === 'string') {
        logger.error(`Respuesta (primeros 200 chars): ${data.substring(0, 200)}`);
      }
      return false;
    }

    sessionToken = token;
    sessionParentId = data?.user?.user_id ?? null;
    lastLogin = Date.now();
    
    logger.info(
      `[JugayganaService] Login exitoso en JUGAYGANA | ` +
      `tokenObtenido=true cookieObtenida=${!!sessionCookie}`
    );
    return true;
  } catch (error) {
    logger.error('Error en login JUGAYGANA:', error.message);
    return false;
  }
};

/**
 * Asegurar sesión válida
 */
const ensureSession = async () => {
  if (!PLATFORM_USER || !PLATFORM_PASS) return false;
  
  const expired = Date.now() - lastLogin > TOKEN_TTL_MINUTES * 60 * 1000;
  if (!sessionToken || expired) {
    sessionToken = null;
    sessionCookie = null;
    return await login();
  }
  return true;
};

/**
 * Invalidar la sesión actual.
 * Útil cuando un endpoint externo rechaza el token con 401/403 para forzar
 * un login fresco en la próxima llamada a ensureSession().
 */
const invalidateSession = () => {
  sessionToken = null;
  sessionCookie = null;
  lastLogin = 0;
  logger.info('[JugayganaService] Sesión invalidada manualmente (forzará re-login en próxima llamada)');
};

/**
 * Obtener información de usuario
 */
const getUserInfo = async (username) => {
  const ok = await ensureSession();
  if (!ok) return null;

  try {
    const body = toFormUrlEncoded({
      action: 'ShowUsers',
      token: sessionToken,
      page: 1,
      pagesize: 50,
      viewtype: 'tree',
      username,
      showhidden: 'false',
      parentid: sessionParentId || undefined
    });

    const headers = {};
    if (sessionCookie) headers.Cookie = sessionCookie;

    const resp = await client.post('', body, { 
      headers, 
      validateStatus: () => true, 
      maxRedirects: 0 
    });

    const data = parseJson(resp.data);
    if (isHtmlBlocked(data)) return null;

    const list = data.users || data.data || (Array.isArray(data) ? data : []);
    const found = list.find(u => 
      String(u.user_name).toLowerCase().trim() === String(username).toLowerCase().trim()
    );
    
    if (!found?.user_id) return null;

    let balanceRaw = Number(found.user_balance ?? found.balance ?? 0);
    let balance = Number.isInteger(balanceRaw) ? balanceRaw / 100 : balanceRaw;

    return { 
      id: found.user_id, 
      balance,
      username: found.user_name,
      email: found.user_email,
      phone: found.user_phone
    };
  } catch (error) {
    logger.error('Error obteniendo info de usuario JUGAYGANA:', error.message);
    return null;
  }
};

/**
 * Crear usuario en JUGAYGANA
 */
const createUser = async ({ username, password, userrole = 'player', currency = 'ARS' }) => {
  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  try {
    const body = toFormUrlEncoded({
      action: 'CREATEUSER',
      token: sessionToken,
      username,
      password,
      userrole,
      currency
    });

    const headers = {};
    if (sessionCookie) headers.Cookie = sessionCookie;

    const resp = await client.post('', body, { 
      headers, 
      validateStatus: () => true, 
      maxRedirects: 0 
    });

    const data = parseJson(resp.data);
    if (isHtmlBlocked(data)) {
      return { success: false, error: 'IP bloqueada / HTML' };
    }

    if (data?.success) {
      return { 
        success: true, 
        user: data.user,
        jugayganaUserId: data.user?.user_id,
        jugayganaUsername: data.user?.user_name
      };
    }
    
    return { success: false, error: data?.error || 'CREATEUSER falló' };
  } catch (error) {
    logger.error('Error creando usuario JUGAYGANA:', error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Sincronizar usuario con JUGAYGANA
 */
const syncUser = async (localUser) => {
  // Verificar si ya existe
  const existingUser = await getUserInfo(localUser.username);
  if (existingUser) {
    return {
      success: true,
      alreadyExists: true,
      jugayganaUserId: existingUser.id,
      jugayganaUsername: localUser.username
    };
  }

  // Crear nuevo usuario
  return await createUser({
    username: localUser.username,
    password: localUser.password || 'asd123',
    userrole: 'player',
    currency: 'ARS'
  });
};

/**
 * Obtener balance de usuario
 */
const getBalance = async (username) => {
  const user = await getUserInfo(username);
  if (!user) return { success: false, error: 'Usuario no encontrado' };
  
  return { 
    success: true, 
    balance: user.balance,
    username: user.username
  };
};

/**
 * Realizar depósito
 */
const deposit = async (username, amount, description = '') => {
  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  try {
    const body = toFormUrlEncoded({
      action: 'CREDITBALANCE',
      token: sessionToken,
      username,
      amount: Math.round(amount * 100),
      description: description || `Depósito - ${new Date().toLocaleString('es-AR')}`
    });

    const headers = {};
    if (sessionCookie) headers.Cookie = sessionCookie;

    const resp = await client.post('', body, { 
      headers, 
      validateStatus: () => true 
    });

    const data = parseJson(resp.data);
    if (isHtmlBlocked(data)) {
      return { success: false, error: 'IP bloqueada / HTML' };
    }

    if (data?.success) {
      return { 
        success: true, 
        data: data.data,
        newBalance: data.data?.user_balance_after
      };
    }
    
    return { success: false, error: data?.error || 'Depósito falló' };
  } catch (error) {
    logger.error('Error en depósito JUGAYGANA:', error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Realizar retiro
 */
const withdraw = async (username, amount, description = '') => {
  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  try {
    const body = toFormUrlEncoded({
      action: 'DEBITBALANCE',
      token: sessionToken,
      username,
      amount: Math.round(amount * 100),
      description: description || `Retiro - ${new Date().toLocaleString('es-AR')}`
    });

    const headers = {};
    if (sessionCookie) headers.Cookie = sessionCookie;

    const resp = await client.post('', body, { 
      headers, 
      validateStatus: () => true 
    });

    const data = parseJson(resp.data);
    if (isHtmlBlocked(data)) {
      return { success: false, error: 'IP bloqueada / HTML' };
    }

    if (data?.success) {
      return { 
        success: true, 
        data: data.data,
        newBalance: data.data?.user_balance_after
      };
    }
    
    return { success: false, error: data?.error || 'Retiro falló' };
  } catch (error) {
    logger.error('Error en retiro JUGAYGANA:', error.message);
    return { success: false, error: error.message };
  }
};

/**
 * Acreditar bonificación de referidos usando DepositMoney + childid
 *
 * Regresión: PR #190 cambió esto de DepositMoney+childid (fix correcto de PR #189) a
 * CREDITBALANCE+username, lo que causa "action does not exist" en la API del proveedor.
 * Esta función restaura el comportamiento correcto: DepositMoney con el numeric childid,
 * idéntico a jugaygana.js::creditUserBalance() que es la integración validada.
 *
 * Retry logic: retry once with a fresh session on HTTP 401/403 or "invalid token".
 * NOTE: "action does not exist" is NOT retried — it is a real provider API error
 * indicating a wrong action, not a stale-session issue.
 */
const bonus = async (username, amount, description = '') => {
  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  // Look up the numeric JUGAYGANA user ID (childid) — required by DepositMoney
  const userInfo = await getUserInfo(username);
  if (!userInfo || !userInfo.id) {
    logger.error(
      `[JugayganaService] bonus: usuario no encontrado en JUGAYGANA ` +
      `username=${username} usesChildId=true usesUsername=false ` +
      `referralPayoutProviderAction=DepositMoney providerCallSource=jugayganaService/bonus ` +
      `finalPayoutStatus=failed`
    );
    return { success: false, error: `Usuario ${username} no encontrado en JUGAYGANA` };
  }

  const childid = userInfo.id;

  logger.info(
    `[JugayganaService] bonus: referralPayoutProviderAction=DepositMoney ` +
    `referralPayoutProviderPayloadShape=childid+amount+currency+deposit_type ` +
    `usesChildId=true usesUsername=false ` +
    `providerCallSource=jugayganaService/bonus ` +
    `username=${username} childid=${childid} amount=${amount}`
  );

  const attemptBonus = async () => {
    // Guard: if sessionToken is null at call time, force retry with fresh login
    if (!sessionToken) {
      logger.warn(
        `[JugayganaService] bonus: sessionToken nulo antes de llamada API, forzando re-login ` +
        `username=${username} childid=${childid}`
      );
      return { success: false, error: { code: 17, message: 'token missing' }, shouldRetry: true };
    }

    try {
      const body = toFormUrlEncoded({
        action: 'DepositMoney',
        token: sessionToken,
        childid,
        amount: Math.round(amount * 100),
        currency: 'ARS',
        deposit_type: 'individual_bonus',
        description: description || `Bonificación referidos - ${new Date().toLocaleString('es-AR')}`
      });

      const headers = {};
      if (sessionCookie) headers.Cookie = sessionCookie;

      const resp = await client.post('', body, {
        headers,
        validateStatus: () => true
      });

      const data = parseJson(resp.data);
      if (isHtmlBlocked(data)) {
        const rawBody = typeof resp.data === 'string' ? resp.data.substring(0, 200) : '(non-string)';
        logger.error(
          `[JugayganaService] bonus: IP bloqueada / HTML username=${username} childid=${childid} ` +
          `referralPayoutProviderAction=DepositMoney usesChildId=true ` +
          `payoutProviderResponse=${rawBody} finalPayoutStatus=failed`
        );
        return { success: false, error: 'IP bloqueada / HTML', shouldRetry: false };
      }

      const rawBody = typeof resp.data === 'string' ? resp.data.substring(0, 500) : JSON.stringify(data).substring(0, 500);

      // Accept both snake_case and camelCase transfer id variants for API compatibility
      if (data?.success || data?.transfer_id || data?.transferId) {
        logger.info(
          `[JugayganaService] bonus: DepositMoney succeeded username=${username} childid=${childid} ` +
          `referralPayoutProviderAction=DepositMoney usesChildId=true ` +
          `providerResponse=${rawBody} finalPayoutStatus=success`
        );
        return {
          success: true,
          data: data.data || data,
          newBalance: data.user_balance_after || data.data?.user_balance_after
        };
      }

      const errMsg = data?.error || data?.message || 'Bonificación falló';
      logger.error(
        `[JugayganaService] bonus: DepositMoney falló username=${username} childid=${childid} ` +
        `referralPayoutProviderAction=DepositMoney usesChildId=true ` +
        `payoutProviderResponse=${rawBody} errorMessage=${JSON.stringify(errMsg)}`
      );

      // Extract string representation for auth-error detection.
      // data.error may be an object like {code:17, message:'token missing'} — handle both.
      const errMsgStr = typeof errMsg === 'string'
        ? errMsg
        : (errMsg?.message || errMsg?.error || '');
      const errCode = (typeof errMsg === 'object' && errMsg !== null) ? errMsg.code : null;

      // Only retry for real session/auth errors — NOT for "action does not exist"
      // which is a provider API contract error, not a stale-token error.
      // JUGAYGANA auth error codes: 12 = token invalid, 17 = token missing.
      const shouldRetry = (errCode === 12 || errCode === 17) || (
        errMsgStr.toLowerCase().includes('invalid token') ||
        errMsgStr.toLowerCase().includes('token missing') ||
        errMsgStr.toLowerCase().includes('login again') ||
        errMsgStr.toLowerCase().includes('session') ||
        resp.status === 401 || resp.status === 403
      );
      return { success: false, error: errMsg, shouldRetry };
    } catch (error) {
      logger.error('Error en bonificación JUGAYGANA:', error.message);
      return { success: false, error: error.message, shouldRetry: false };
    }
  };

  let result = await attemptBonus();

  // Retry once with a fresh session only for auth/session failures
  if (!result.success && result.shouldRetry) {
    logger.warn(
      `[JugayganaService] bonus: retrying after session refresh — ` +
      `username=${username} childid=${childid} originalError="${result.error}"`
    );
    invalidateSession();
    const ok2 = await ensureSession();
    if (ok2) {
      result = await attemptBonus();
      if (!result.success) {
        logger.error(
          `[JugayganaService] bonus: retry also failed — username=${username} childid=${childid} ` +
          `error="${result.error}" referralPayoutProviderAction=DepositMoney usesChildId=true ` +
          `finalPayoutStatus=failed`
        );
      } else {
        logger.info(
          `[JugayganaService] bonus: retry succeeded — username=${username} childid=${childid} ` +
          `referralPayoutProviderAction=DepositMoney usesChildId=true finalPayoutStatus=success`
        );
      }
    } else {
      result = { success: false, error: 'Re-login falló al reintentar bonificación' };
      logger.error(
        `[JugayganaService] bonus: re-login failed during retry — username=${username} childid=${childid} ` +
        `referralPayoutProviderAction=DepositMoney usesChildId=true finalPayoutStatus=failed`
      );
    }
  }

  return result;
};

/**
 * Acreditar bonificación (alias - usa individual_bonus)
 */
const creditBalance = async (username, amount, description = '') => {
  return await bonus(username, amount, description);
};

/**
 * Cambiar contraseña de usuario en JUGAYGANA
 *
 * Flujo correcto (replicando el request real del navegador):
 *   1. POST a APP_API_URL (jugaygana44.bet/api/app/) con action=LOGIN como el usuario
 *      para obtener el token del USUARIO (no el token admin).
 *   2. POST a APP_API_URL con action=ChangePassword usando el token del usuario.
 *
 * Ambas requests usan multipart/form-data, igual que el navegador real.
 *
 * @param {string} username - Nombre de usuario en JUGAYGANA
 * @param {string|null} currentPassword - Contraseña actual (null en reset por teléfono; la API la requiere)
 * @param {string} newPassword - Nueva contraseña
 */
const changeUserPassword = async (username, currentPassword, newPassword) => {
  if (!currentPassword) {
    logger.warn(`⚠️ changeUserPassword: contraseña actual no disponible para ${username} (reset por teléfono). No se puede sincronizar con JUGAYGANA sin la contraseña actual del usuario.`);
    return { success: false, error: 'Contraseña actual requerida para autenticarse en la API de JUGAYGANA' };
  }

  logger.info(`[changeUserPassword] Iniciando cambio de contraseña en JUGAYGANA para: ${username} — URL: ${APP_API_URL}`);

  // Configurar agente proxy para las requests a la app API (igual que el cliente admin)
  const appAxiosConfig = {
    timeout: 20000,
    httpsAgent,
    proxy: false,
    validateStatus: () => true,
    maxRedirects: 0,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://jugaygana44.bet',
      'Referer': 'https://jugaygana44.bet/',
      'Accept-Language': 'es-419,es;q=0.9'
    }
  };

  // ── Paso 1: Login como el usuario para obtener su propio token ────────────────
  let userToken;
  try {
    const loginForm = new FormData();
    loginForm.append('action', 'LOGIN');
    loginForm.append('username', username);
    loginForm.append('password', currentPassword);

    const loginResp = await axios.post(APP_API_URL, loginForm, {
      ...appAxiosConfig,
      headers: { ...appAxiosConfig.headers, ...loginForm.getHeaders() }
    });

    logger.info(`[changeUserPassword] Login como usuario HTTP ${loginResp.status}`);

    const loginData = parseJson(loginResp.data);
    if (isHtmlBlocked(loginData)) {
      logger.warn(`[changeUserPassword] Login usuario bloqueado (HTML/CloudFront) para: ${username}`);
      return { success: false, error: 'IP bloqueada / HTML en login de usuario' };
    }

    userToken = loginData?.token || loginData?.data?.token;
    if (!userToken) {
      const errMsg = loginData?.message || loginData?.error || JSON.stringify(loginData);
      logger.warn(`[changeUserPassword] No se obtuvo token de usuario para ${username}: ${errMsg}`);
      return { success: false, error: `Login de usuario fallido: ${errMsg}` };
    }

    logger.info(`[changeUserPassword] Token de usuario obtenido para: ${username}`);
  } catch (err) {
    logger.error(`[changeUserPassword] Error en login de usuario para ${username}: ${err.message}`);
    return { success: false, error: `Error en login de usuario: ${err.message}` };
  }

  // ── Paso 2: Cambiar contraseña usando el token del usuario ────────────────────
  try {
    const changeForm = new FormData();
    changeForm.append('action', 'ChangePassword');
    changeForm.append('token', userToken);
    changeForm.append('password', currentPassword);
    changeForm.append('newpassword', newPassword);

    const changeResp = await axios.post(APP_API_URL, changeForm, {
      ...appAxiosConfig,
      headers: { ...appAxiosConfig.headers, ...changeForm.getHeaders() }
    });

    logger.info(`[changeUserPassword] ChangePassword HTTP ${changeResp.status} para: ${username}`);

    const changeData = parseJson(changeResp.data);
    if (isHtmlBlocked(changeData)) {
      logger.warn(`[changeUserPassword] ChangePassword bloqueado (HTML/CloudFront) para: ${username}`);
      return { success: false, error: 'IP bloqueada / HTML en ChangePassword' };
    }

    if (changeData?.success) {
      logger.info(`✅ Contraseña cambiada en JUGAYGANA para: ${username}`);
      return { success: true };
    }

    const errMsg = changeData?.message || changeData?.error || JSON.stringify(changeData);
    logger.error(`❌ Error al cambiar contraseña en JUGAYGANA para ${username}: ${errMsg}`);
    return { success: false, error: errMsg };
  } catch (err) {
    logger.error(`[changeUserPassword] Error en ChangePassword para ${username}: ${err.message}`);
    return { success: false, error: err.message };
  }
};

/**
 * Cambiar contraseña de usuario en JUGAYGANA usando el flujo de ADMIN.
 *
 * Usa la sesión admin (token del panel agentesadmin.bet) para cambiar la contraseña
 * sin necesidad de conocer la contraseña actual del usuario.
 * Payload: action=ChangePassword, token=<admin>, password=default, newpassword=<nueva>, childid=<id>
 *
 * @param {string} username - Nombre de usuario en JUGAYGANA
 * @param {string} newPassword - Nueva contraseña
 */
const changeUserPasswordAsAdmin = async (username, newPassword) => {
  const ok = await ensureSession();
  if (!ok) {
    logger.error(`[changeUserPasswordAsAdmin] No hay sesión válida con JUGAYGANA admin para: ${username}`);
    return { success: false, error: 'No hay sesión válida con JUGAYGANA admin' };
  }

  // Obtener el childid numérico del usuario
  const userInfo = await getUserInfo(username);
  if (!userInfo || !userInfo.id) {
    logger.error(`[changeUserPasswordAsAdmin] Usuario no encontrado en JUGAYGANA: ${username}`);
    return { success: false, error: `Usuario ${username} no encontrado en JUGAYGANA` };
  }

  const childid = userInfo.id;
  logger.info(`[changeUserPasswordAsAdmin] Cambiando contraseña via admin para: ${username} childid=${childid}`);

  try {
    const body = toFormUrlEncoded({
      action: 'ChangePassword',
      token: sessionToken,
      // 'password=default' es el valor requerido por el flujo admin de la API externa
      // (confirmado en el request real del navegador contra admin.agentesadmin.bet).
      // No es una contraseña de usuario sino un campo fijo exigido por el endpoint admin.
      password: 'default',
      newpassword: newPassword,
      childid
    });

    const headers = {};
    if (sessionCookie) headers.Cookie = sessionCookie;

    const resp = await client.post('', body, {
      headers,
      validateStatus: () => true
    });

    const data = parseJson(resp.data);
    if (isHtmlBlocked(data)) {
      logger.warn(`[changeUserPasswordAsAdmin] Bloqueado por HTML/CloudFront para: ${username}`);
      return { success: false, error: 'IP bloqueada / HTML en ChangePassword admin' };
    }

    if (data?.success) {
      logger.info(`✅ Contraseña cambiada via admin en JUGAYGANA para: ${username} childid=${childid}`);
      return { success: true };
    }

    const errMsg = data?.message || data?.error || JSON.stringify(data);
    logger.error(`❌ Error cambiando contraseña via admin en JUGAYGANA para ${username}: ${errMsg}`);
    return { success: false, error: errMsg };
  } catch (err) {
    logger.error(`[changeUserPasswordAsAdmin] Error al llamar API admin para ${username}: ${err.message}`);
    return { success: false, error: err.message };
  }
};

/**
 * Login como un usuario específico de JUGAYGANA y devolver su token de sesión.
 * Se usa para el auto-login en la plataforma desde paginacopia.
 */
const loginAsUser = async (username, password) => {
  try {
    const loginForm = new FormData();
    loginForm.append('action', 'LOGIN');
    loginForm.append('username', username);
    loginForm.append('password', password);

    const resp = await axios.post(APP_API_URL, loginForm, {
      timeout: 20000,
      httpsAgent,
      proxy: false,
      validateStatus: () => true,
      maxRedirects: 0,
      headers: {
        ...loginForm.getHeaders(),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://jugaygana44.bet',
        'Referer': 'https://jugaygana44.bet/',
      }
    });

    const data = parseJson(resp.data);
    // `transient: true` ⇒ NO pudimos saber si la contraseña es correcta (la
    // plataforma no respondió bien). Quien use esto para AUTENTICAR debe tratar
    // ese caso como "reintentá en un rato", nunca como "credenciales inválidas":
    // si no, un hipo de Cloudflare deja al usuario afuera de su cuenta.
    if (isHtmlBlocked(data)) return { success: false, error: 'IP bloqueada', transient: true };

    const token = data?.token || data?.data?.token;
    // Acá SÍ hubo respuesta JSON de la plataforma: es un rechazo real de credenciales.
    if (!token) return { success: false, error: data?.error || data?.message || 'Login failed' };

    return { success: true, token };
  } catch (error) {
    // Timeout / ECONNRESET / red: tampoco sabemos nada.
    logger.error('Error en loginAsUser JUGAYGANA:', error.message);
    return { success: false, error: error.message, transient: true };
  }
};

/**
 * Obtener token y cookie de la sesión actual (para compartir con otros servicios)
 */
const getSessionToken = () => sessionToken;
const getSessionCookie = () => sessionCookie;

module.exports = {
  login,
  ensureSession,
  invalidateSession,
  getSessionToken,
  getSessionCookie,
  getUserInfo,
  createUser,
  syncUser,
  getBalance,
  deposit,
  withdraw,
  bonus,
  creditBalance,
  changeUserPassword,
  changeUserPasswordAsAdmin,
  loginAsUser
};