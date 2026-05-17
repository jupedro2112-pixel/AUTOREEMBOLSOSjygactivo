
// ============================================
// INTEGRACIÓN JUGAYGANA API
// ============================================

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const FormData = require('form-data');

const API_URL = process.env.JUGAYGANA_API_URL || 'https://admin.agentesadmin.bet/api/admin/';
const PROXY_URL = process.env.PROXY_URL || '';

// Variables de sesión
let SESSION_TOKEN = null;
let SESSION_COOKIE = null;
let SESSION_PARENT_ID = null;
let SESSION_LAST_LOGIN = 0;
let loginInProgress = null;

const PLATFORM_USER = process.env.PLATFORM_USER;
const PLATFORM_PASS = process.env.PLATFORM_PASS;
const TOKEN_TTL_MINUTES = parseInt(process.env.TOKEN_TTL_MINUTES || '20', 10);

// Configurar agente proxy si existe
let httpsAgent = null;
if (PROXY_URL) {
  httpsAgent = new HttpsProxyAgent(PROXY_URL);
  console.log('✅ Proxy configurado:', PROXY_URL.replace(/:.*@/, ':****@'));
}

// Cliente HTTP
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

// Helper para formatear datos
function toFormUrlEncoded(data) {
  return Object.keys(data)
    .filter(k => data[k] !== undefined && data[k] !== null)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(data[k]))
    .join('&');
}

// Parsear JSON que puede venir envuelto
function parsePossiblyWrappedJson(data) {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data.substring(data.indexOf('{'), data.lastIndexOf('}') + 1));
  } catch {
    return data;
  }
}

// Detectar bloqueo por HTML
function isHtmlBlocked(data) {
  return typeof data === 'string' && data.trim().startsWith('<');
}

// Detectar si una respuesta indica sesión inválida/expirada
function isSessionError(data, httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) return true;
  if (isHtmlBlocked(data)) return true;
  const err = data?.error;
  if (typeof err === 'string') {
    const errLower = err.toLowerCase();
    return errLower.includes('token') || errLower.includes('session') ||
           errLower.includes('expired') || errLower.includes('invalid') ||
           errLower.includes('unauthorized') || errLower.includes('auth');
  }
  // Handle object-type error (e.g. {code:12, message:'Your token is not valid'} or {code:17, message:'token missing'})
  if (typeof err === 'object' && err !== null) {
    const code = err.code;
    if (code === 12 || code === 17) return true;
    const msgLower = (err.message || '').toLowerCase();
    return msgLower.includes('token') || msgLower.includes('session') ||
           msgLower.includes('expired') || msgLower.includes('invalid') ||
           msgLower.includes('unauthorized') || msgLower.includes('auth');
  }
  return false;
}

// Invalidar sesión actual para forzar re-login
function invalidateSession() {
  SESSION_TOKEN = null;
  SESSION_COOKIE = null;
  SESSION_PARENT_ID = null;
  SESSION_LAST_LOGIN = 0;
}

// Verificar IP pública
async function logProxyIP() {
  try {
    const res = await axios.get('https://api.ipify.org?format=json', {
      httpsAgent,
      proxy: false,
      timeout: 10000
    });
    console.log('🌐 IP pública saliente:', res.data.ip);
    return res.data.ip;
  } catch (e) {
    console.error('❌ No se pudo verificar IP pública:', e.message);
    return null;
  }
}

// Login y obtener token
async function loginAndGetToken() {
  if (!PLATFORM_USER || !PLATFORM_PASS) {
    console.error('❌ Faltan PLATFORM_USER o PLATFORM_PASS');
    return false;
  }

  console.log('🔑 Intentando login en JUGAYGANA...');

  const body = toFormUrlEncoded({
    action: 'LOGIN',
    username: PLATFORM_USER,
    password: PLATFORM_PASS
  });

  try {
    const resp = await client.post('', body, {
      validateStatus: s => s >= 200 && s < 500,
      maxRedirects: 0
    });

    if (resp.headers['set-cookie']) {
      SESSION_COOKIE = resp.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
    }

    let data = parsePossiblyWrappedJson(resp.data);
    if (isHtmlBlocked(data)) {
      console.error('❌ Login bloqueado: respuesta HTML (posible bloqueo de IP)');
      console.error('   HTTP status:', resp.status);
      console.error('   URL usada:', API_URL);
      return false;
    }

    // Intentar token en múltiples campos por compatibilidad con cambios de API
    const token = data?.token || data?.access_token || data?.sessionToken || data?.data?.token;

    if (!token) {
      console.error('❌ Login falló: no se recibió token');
      console.error('   HTTP status:', resp.status);
      console.error('   Content-Type:', resp.headers['content-type'] || 'sin content-type');
      console.error('   URL usada:', API_URL);
      if (typeof data === 'object' && data !== null) {
        const keys = Object.keys(data);
        console.error('   Campos en respuesta:', keys.length ? keys.join(', ') : '(objeto vacío)');
        const errMsg = data.error || data.message || data.msg || data.detail;
        if (errMsg) console.error('   Mensaje de error de API:', errMsg);
      } else if (typeof data === 'string') {
        console.error('   Respuesta (primeros 200 chars):', data.substring(0, 200));
      }
      return false;
    }

    SESSION_TOKEN = token;
    SESSION_PARENT_ID = data?.user?.user_id ?? null;
    SESSION_LAST_LOGIN = Date.now();
    
    console.log('✅ Login exitoso. Parent ID:', SESSION_PARENT_ID);
    return true;
  } catch (error) {
    console.error('❌ Error en login:', error.message);
    return false;
  }
}

// Asegurar sesión válida (con reintentos y mutex anti-colisión)
async function ensureSession() {
  if (PLATFORM_USER && PLATFORM_PASS) {
    const expired = Date.now() - SESSION_LAST_LOGIN > TOKEN_TTL_MINUTES * 60 * 1000;
    if (!SESSION_TOKEN || expired) {
      // Si ya hay un login en curso, esperar a que termine
      if (loginInProgress) {
        await loginInProgress;
        return !!SESSION_TOKEN;
      }

      loginInProgress = (async () => {
        SESSION_TOKEN = null;
        SESSION_COOKIE = null;
        SESSION_PARENT_ID = null;

        // Reintentar login hasta 3 veces con espera progresiva
        for (let attempt = 1; attempt <= 3; attempt++) {
          const ok = await loginAndGetToken();
          if (ok) return true;
          console.error(`❌ ensureSession: login intento ${attempt}/3 falló`);
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, attempt * 1500));
          }
        }
        console.error('❌ ensureSession: no se pudo renovar sesión después de 3 intentos');
        return false;
      })();

      try {
        const result = await loginInProgress;
        return result;
      } finally {
        loginInProgress = null;
      }
    }
    return true;
  }
  return false;
}

// ============================================
// CREATEUSER - Crear usuario en JUGAYGANA
// ============================================

async function createPlatformUser({ username, password, userrole = 'player', currency = 'ARS' }) {
  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  console.log('👤 Creando usuario en JUGAYGANA:', username);

  const body = toFormUrlEncoded({
    action: 'CREATEUSER',
    token: SESSION_TOKEN,
    username,
    password,
    userrole,
    currency
  });

  const headers = {};
  if (SESSION_COOKIE) headers.Cookie = SESSION_COOKIE;

  try {
    const resp = await client.post('', body, { 
      headers, 
      validateStatus: () => true, 
      maxRedirects: 0 
    });

    let data = parsePossiblyWrappedJson(resp.data);
    if (isHtmlBlocked(data)) {
      console.error('❌ CREATEUSER bloqueado: respuesta HTML');
      return { success: false, error: 'IP bloqueada / HTML' };
    }

    if (data?.success) {
      console.log('✅ Usuario creado en JUGAYGANA:', data.user?.user_name);
      return { 
        success: true, 
        user: data.user,
        jugayganaUserId: data.user?.user_id,
        jugayganaUsername: data.user?.user_name
      };
    }
    
    console.error('❌ CREATEUSER falló:', data?.error || 'Error desconocido');
    return { success: false, error: data?.error || 'CREATEUSER falló' };
  } catch (error) {
    console.error('❌ Error en CREATEUSER:', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================
// ShowUsers - Buscar usuario
// ============================================

async function getUserInfoByName(username) {
  const ok = await ensureSession();
  if (!ok) return null;

  const body = toFormUrlEncoded({
    action: 'ShowUsers',
    token: SESSION_TOKEN,
    page: 1,
    pagesize: 50,
    viewtype: 'tree',
    username,
    showhidden: 'false',
    parentid: SESSION_PARENT_ID || undefined
  });

  const headers = {};
  if (SESSION_COOKIE) headers.Cookie = SESSION_COOKIE;

  try {
    const resp = await client.post('', body, { 
      headers, 
      validateStatus: () => true, 
      maxRedirects: 0 
    });

    let data = parsePossiblyWrappedJson(resp.data);
    if (isHtmlBlocked(data)) return null;

    // Detectar sesión inválida y reintentar una vez
    if (isSessionError(data, resp.status)) {
      console.error('🔄 getUserInfoByName: sesión inválida detectada, renovando...');
      invalidateSession();
      const renewed = await ensureSession();
      if (!renewed) return null;
      const retryBody = toFormUrlEncoded({
        action: 'ShowUsers',
        token: SESSION_TOKEN,
        page: 1,
        pagesize: 50,
        viewtype: 'tree',
        username,
        showhidden: 'false',
        parentid: SESSION_PARENT_ID || undefined
      });
      const retryHeaders = {};
      if (SESSION_COOKIE) retryHeaders.Cookie = SESSION_COOKIE;
      const retryResp = await client.post('', retryBody, { headers: retryHeaders, validateStatus: () => true, maxRedirects: 0 });
      data = parsePossiblyWrappedJson(retryResp.data);
      if (isHtmlBlocked(data)) return null;
    }

    const list = data.users || data.data || (Array.isArray(data) ? data : []);
    const found = list.find(u => 
      String(u.user_name).toLowerCase().trim() === String(username).toLowerCase().trim()
    );
    
    if (!found?.user_id) return null;

    let balanceRaw = Number(found.user_balance ?? found.balance ?? found.balance_amount ?? found.available_balance ?? 0);
    let balance = Number.isInteger(balanceRaw) ? balanceRaw / 100 : balanceRaw;

    return { 
      id: found.user_id, 
      balance,
      username: found.user_name,
      email: found.user_email,
      phone: found.user_phone
    };
  } catch (error) {
    console.error('❌ Error en ShowUsers:', error.message);
    return null;
  }
}

// ============================================
// Verificar si usuario existe en JUGAYGANA
// ============================================

async function checkUserExists(username) {
  const user = await getUserInfoByName(username);
  return user !== null;
}

// ============================================
// Sincronización completa: crear usuario local + JUGAYGANA
// ============================================

async function syncUserToPlatform(localUser) {
  console.log('🔄 Sincronizando usuario con JUGAYGANA:', localUser.username);

  // 1. Verificar si ya existe en JUGAYGANA
  const existingUser = await getUserInfoByName(localUser.username);
  if (existingUser) {
    console.log('✅ Usuario ya existe en JUGAYGANA:', existingUser.id);
    return {
      success: true,
      alreadyExists: true,
      jugayganaUserId: existingUser.id,
      jugayganaUsername: localUser.username
    };
  }

  // 2. Crear en JUGAYGANA
  const result = await createPlatformUser({
    username: localUser.username,
    password: localUser.password || 'asd123',
    userrole: 'player',
    currency: 'ARS'
  });

  return result;
}

// ============================================
// FECHAS ARGENTINA
// ============================================

function getYesterdayRangeArgentinaEpoch() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const now = new Date();
  const parts = formatter.formatToParts(now);
  const yyyy = parts.find(p => p.type === 'year').value;
  const mm = parts.find(p => p.type === 'month').value;
  const dd = parts.find(p => p.type === 'day').value;

  const todayLocal = new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`);
  const yesterdayLocal = new Date(todayLocal.getTime() - 24 * 60 * 60 * 1000);

  const yparts = formatter.formatToParts(yesterdayLocal);
  const y = yparts.find(p => p.type === 'year').value;
  const m = yparts.find(p => p.type === 'month').value;
  const d = yparts.find(p => p.type === 'day').value;

  const from = new Date(`${y}-${m}-${d}T00:00:00-03:00`);
  const to = new Date(`${y}-${m}-${d}T23:59:59-03:00`);

  return {
    fromEpoch: Math.floor(from.getTime() / 1000),
    toEpoch: Math.floor(to.getTime() / 1000),
    dateStr: `${y}-${m}-${d}`
  };
}

function getTodayRangeArgentinaEpoch() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const now = new Date();
  const parts = formatter.formatToParts(now);
  const yyyy = parts.find(p => p.type === 'year').value;
  const mm = parts.find(p => p.type === 'month').value;
  const dd = parts.find(p => p.type === 'day').value;

  const from = new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`);
  const to = new Date(`${yyyy}-${mm}-${dd}T23:59:59-03:00`);

  return {
    fromEpoch: Math.floor(from.getTime() / 1000),
    toEpoch: Math.floor(to.getTime() / 1000),
    dateStr: `${yyyy}-${mm}-${dd}`
  };
}

// ============================================
// OBTENER MOVIMIENTOS DE AYER (para reembolsos)
// ============================================

async function getUserNetYesterday(username) {
  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  if (!SESSION_PARENT_ID) {
    return { success: false, error: 'No se pudo obtener Admin ID' };
  }

  try {
    const { fromEpoch, toEpoch, dateStr } = getYesterdayRangeArgentinaEpoch();

    console.log(`📊 Consultando movimientos de ${username} para ${dateStr} (epoch: ${fromEpoch} - ${toEpoch})`);

    const body = toFormUrlEncoded({
      action: 'ShowUserTransfersByAgent',
      token: SESSION_TOKEN,
      page: 1,
      pagesize: 100,
      fromtime: fromEpoch,
      totime: toEpoch,
      username: username,
      userrole: 'player',
      direct: 'False',
      childid: SESSION_PARENT_ID
    });

    const headers = {};
    if (SESSION_COOKIE) headers.Cookie = SESSION_COOKIE;

    const resp = await client.post('', body, { headers });

    let data = parsePossiblyWrappedJson(resp.data);
    if (isHtmlBlocked(data)) {
      console.error('❌ ShowUserTransfersByAgent bloqueado: respuesta HTML');
      return { success: false, error: 'IP Bloqueada (HTML)' };
    }

    console.log('📊 Respuesta de ShowUserTransfersByAgent:', JSON.stringify(data).substring(0, 500));

    // Los montos vienen en centavos
    const totalDepositsCents = Number(data?.total_deposits || 0);
    const totalWithdrawsCents = Number(data?.total_withdraws || 0);
    const netCents = totalDepositsCents - totalWithdrawsCents;

    const totalDeposits = totalDepositsCents / 100;
    const totalWithdraws = totalWithdrawsCents / 100;
    const net = netCents / 100;

    console.log(`📊 ${username}: Depósitos=$${totalDeposits}, Retiros=$${totalWithdraws}, Neto=$${net}`);

    return {
      success: true,
      net: Number(net.toFixed(2)),
      totalDeposits: Number(totalDeposits.toFixed(2)),
      totalWithdraws: Number(totalWithdraws.toFixed(2)),
      fromEpoch,
      toEpoch,
      dateStr
    };
  } catch (err) {
    console.error('❌ Error en ShowUserTransfersByAgent:', err.message);
    return { success: false, error: err.message };
  }
}

// ============================================
// VERIFICAR SI RECLAMÓ HOY
// ============================================

async function checkClaimedToday(username) {
  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  if (!SESSION_PARENT_ID) {
    return { success: false, error: 'No se pudo obtener Admin ID' };
  }

  try {
    const { fromEpoch, toEpoch } = getTodayRangeArgentinaEpoch();

    const body = toFormUrlEncoded({
      action: 'ShowUserTransfersByAgent',
      token: SESSION_TOKEN,
      page: 1,
      pagesize: 30,
      fromtime: fromEpoch,
      totime: toEpoch,
      username: username,
      userrole: 'player',
      direct: 'False',
      childid: SESSION_PARENT_ID
    });

    const headers = {};
    if (SESSION_COOKIE) headers.Cookie = SESSION_COOKIE;

    const resp = await client.post('', body, { headers });

    let data = parsePossiblyWrappedJson(resp.data);
    const totalBonusCents = Number(data?.total_bonus || 0);
    const totalBonus = totalBonusCents / 100;

    return { success: true, claimed: totalBonus > 0, totalBonus };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================
// DEPOSITAR BONUS (reembolso)
// ============================================

async function creditUserBalance(username, amount) {
  console.log(`💰 Cargando $${amount} a ${username}`);

  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  const userInfo = await getUserInfoByName(username);
  if (!userInfo) return { success: false, error: 'Usuario no encontrado' };

  try {
    const amountCents = Math.round(parseFloat(amount) * 100);

    const body = toFormUrlEncoded({
      action: 'DepositMoney',
      token: SESSION_TOKEN,
      childid: userInfo.id,
      amount: amountCents,
      currency: 'ARS',
      deposit_type: 'individual_bonus'
    });

    const headers = {};
    if (SESSION_COOKIE) headers.Cookie = SESSION_COOKIE;

    // validateStatus: () => true → no tirar excepción en 5xx para que podamos
    // parsear el body. Si la respuesta tiene transfer_id en el body aunque el
    // status sea 502/504, la operación SÍ se aplicó. Sin esto, axios tiraba
    // y el catch marcaba el claim como pending_credit_failed con la plata YA
    // acreditada → riesgo de doble crédito en reconciliación.
    const resp = await client.post('', body, { headers, validateStatus: () => true });

    let data = parsePossiblyWrappedJson(resp.data);
    if (isHtmlBlocked(data)) {
      return { success: false, error: 'IP Bloqueada (HTML)' };
    }

    // Detectar sesión inválida y reintentar una vez
    if (isSessionError(data, resp.status)) {
      console.error('🔄 creditUserBalance: sesión inválida detectada, renovando...');
      invalidateSession();
      const renewed = await ensureSession();
      if (!renewed) return { success: false, error: 'No se pudo renovar la sesión' };
      const retryUserInfo = await getUserInfoByName(username);
      if (!retryUserInfo) return { success: false, error: 'Usuario no encontrado tras renovar sesión' };
      const retryBody = toFormUrlEncoded({
        action: 'DepositMoney',
        token: SESSION_TOKEN,
        childid: retryUserInfo.id,
        amount: amountCents,
        currency: 'ARS',
        deposit_type: 'individual_bonus'
      });
      const retryHeaders = {};
      if (SESSION_COOKIE) retryHeaders.Cookie = SESSION_COOKIE;
      const retryResp = await client.post('', retryBody, { headers: retryHeaders, validateStatus: () => true });
      data = parsePossiblyWrappedJson(retryResp.data);
      if (isHtmlBlocked(data)) return { success: false, error: 'IP Bloqueada (HTML)' };
    }

    console.log("📩 Resultado DepositMoney:", JSON.stringify(data), "status:", resp.status);

    // Aceptar como éxito si: data.success === true, O si la API devolvió
    // un transfer_id (señal de que la operación se aplicó). Mantiene paridad
    // con depositToUser y withdrawFromUser que ya hacían este check.
    if (data && (data.success || data.transfer_id || data.transferId)) {
      return { success: true, data: data };
    } else {
      // Fallback: si data es un string (HTML mal parseado / 5xx con error)
      // o null, no podemos asumir success. Devolvemos error con el status
      // para que el server lo loguee con contexto.
      const errMsg = (data && (data.error || data.message))
        || ('API Error (HTTP ' + resp.status + ')');
      return { success: false, error: errMsg, httpStatus: resp.status };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================
// DEPÓSITO NORMAL (deposit_type: deposit)
// ============================================

async function depositToUser(username, amount, description = '') {
  console.log(`💰 Depositando $${amount} a ${username}`);

  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  let userInfo = await getUserInfoByName(username);
  
  // Si no existe, crear el usuario con reintentos
  if (!userInfo) {
    console.log(`👤 Usuario no encontrado, creando: ${username}`);
    
    // Intentar crear el usuario hasta 3 veces
    let createSuccess = false;
    let createError = '';
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`🔄 Intento ${attempt}/3 de crear usuario: ${username}`);
      const createResult = await createPlatformUser({
        username: username,
        password: 'asd123',
        userrole: 'player',
        currency: 'ARS'
      });
      
      if (createResult.success) {
        createSuccess = true;
        console.log(`✅ Usuario creado exitosamente en intento ${attempt}`);
        break;
      } else {
        createError = typeof createResult.error === 'string'
          ? createResult.error
          : (createResult.error?.message || JSON.stringify(createResult.error) || 'Error desconocido');
        console.log(`❌ Intento ${attempt} falló: ${createError}`);
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 2000 * attempt)); // Espera progresiva
        }
      }
    }
    
    // Esperar más tiempo y buscar el usuario
    if (createSuccess) {
      console.log(`⏳ Esperando a que el usuario esté disponible...`);
      for (let waitAttempt = 1; waitAttempt <= 5; waitAttempt++) {
        await new Promise(r => setTimeout(r, 1500));
        userInfo = await getUserInfoByName(username);
        if (userInfo) {
          console.log(`✅ Usuario encontrado después de ${waitAttempt} intentos de espera`);
          break;
        }
      }
    }
    
    if (!userInfo) {
      console.error(`❌ No se pudo crear o encontrar el usuario después de múltiples intentos`);
      return { success: false, error: `No se pudo crear el usuario: ${createError}. Por favor, intente nuevamente.` };
    }
  }

  try {
    const amountCents = Math.round(parseFloat(amount) * 100);

    const body = toFormUrlEncoded({
      action: 'DepositMoney',
      token: SESSION_TOKEN,
      childid: userInfo.id,
      amount: amountCents,
      currency: 'ARS',
      deposit_type: 'deposit',
      description: description || 'Depósito desde Sala de Juegos'
    });

    const headers = {};
    if (SESSION_COOKIE) headers.Cookie = SESSION_COOKIE;

    // validateStatus: () => true para parsear el body aunque sea 5xx (igual
    // que creditUserBalance). Sin esto, axios tira en 502/504 y el catch
    // genérico oculta el transfer_id si la operación SÍ se aplicó.
    const resp = await client.post('', body, { headers, validateStatus: () => true });

    let data = parsePossiblyWrappedJson(resp.data);
    if (isHtmlBlocked(data)) {
      return { success: false, error: 'IP Bloqueada (HTML)' };
    }

    // Detectar sesión inválida y reintentar una vez
    if (isSessionError(data, resp.status)) {
      console.error('🔄 depositToUser: sesión inválida detectada, renovando...');
      invalidateSession();
      const renewed = await ensureSession();
      if (!renewed) return { success: false, error: 'No se pudo renovar la sesión' };
      const retryUserInfo = await getUserInfoByName(username);
      if (!retryUserInfo) return { success: false, error: 'Usuario no encontrado tras renovar sesión' };
      const retryBody = toFormUrlEncoded({
        action: 'DepositMoney',
        token: SESSION_TOKEN,
        childid: retryUserInfo.id,
        amount: amountCents,
        currency: 'ARS',
        deposit_type: 'deposit',
        description: description || 'Depósito desde Sala de Juegos'
      });
      const retryHeaders = {};
      if (SESSION_COOKIE) retryHeaders.Cookie = SESSION_COOKIE;
      const retryResp = await client.post('', retryBody, { headers: retryHeaders, validateStatus: () => true });
      data = parsePossiblyWrappedJson(retryResp.data);
      if (isHtmlBlocked(data)) return { success: false, error: 'IP Bloqueada (HTML)' };
    }

    console.log("📩 Resultado DepositMoney:", JSON.stringify(data));

    if (data && (data.success || data.transfer_id || data.transferId)) {
      return { success: true, data };
    } else {
      return { success: false, error: data.error || data.message || 'API Error' };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================
// RETIRO (WithdrawMoney)
// ============================================

async function withdrawFromUser(username, amount, description = '') {
  console.log(`💸 Retirando $${amount} de ${username}`);

  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  let userInfo = await getUserInfoByName(username);
  
  // Si no existe, crear el usuario con reintentos
  if (!userInfo) {
    console.log(`👤 Usuario no encontrado, creando: ${username}`);
    
    // Intentar crear el usuario hasta 3 veces
    let createSuccess = false;
    let createError = '';
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`🔄 Intento ${attempt}/3 de crear usuario: ${username}`);
      const createResult = await createPlatformUser({
        username: username,
        password: 'asd123',
        userrole: 'player',
        currency: 'ARS'
      });
      
      if (createResult.success) {
        createSuccess = true;
        console.log(`✅ Usuario creado exitosamente en intento ${attempt}`);
        break;
      } else {
        createError = typeof createResult.error === 'string'
          ? createResult.error
          : (createResult.error?.message || JSON.stringify(createResult.error) || 'Error desconocido');
        console.log(`❌ Intento ${attempt} falló: ${createError}`);
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 2000 * attempt)); // Espera progresiva
        }
      }
    }
    
    // Esperar más tiempo y buscar el usuario
    if (createSuccess) {
      console.log(`⏳ Esperando a que el usuario esté disponible...`);
      for (let waitAttempt = 1; waitAttempt <= 5; waitAttempt++) {
        await new Promise(r => setTimeout(r, 1500));
        userInfo = await getUserInfoByName(username);
        if (userInfo) {
          console.log(`✅ Usuario encontrado después de ${waitAttempt} intentos de espera`);
          break;
        }
      }
    }
    
    if (!userInfo) {
      console.error(`❌ No se pudo crear o encontrar el usuario después de múltiples intentos`);
      return { success: false, error: `No se pudo crear el usuario: ${createError}. Por favor, intente nuevamente.` };
    }
  }

  try {
    const amountCents = Math.round(parseFloat(amount) * 100);

    const body = toFormUrlEncoded({
      action: 'WithdrawMoney',
      token: SESSION_TOKEN,
      childid: userInfo.id,
      amount: amountCents,
      currency: 'ARS',
      description: description || 'Retiro desde Sala de Juegos'
    });

    const headers = {};
    if (SESSION_COOKIE) headers.Cookie = SESSION_COOKIE;

    // validateStatus: () => true para parsear el body aunque sea 5xx (igual
    // que creditUserBalance/depositToUser). Sin esto, axios tira en 502/504
    // y el catch genérico oculta el transfer_id si la operación se aplicó.
    const resp = await client.post('', body, { headers, validateStatus: () => true });

    let data = parsePossiblyWrappedJson(resp.data);
    if (isHtmlBlocked(data)) {
      return { success: false, error: 'IP Bloqueada (HTML)' };
    }

    // Detectar sesión inválida y reintentar una vez
    if (isSessionError(data, resp.status)) {
      console.error('🔄 withdrawFromUser: sesión inválida detectada, renovando...');
      invalidateSession();
      const renewed = await ensureSession();
      if (!renewed) return { success: false, error: 'No se pudo renovar la sesión' };
      const retryUserInfo = await getUserInfoByName(username);
      if (!retryUserInfo) return { success: false, error: 'Usuario no encontrado tras renovar sesión' };
      const retryBody = toFormUrlEncoded({
        action: 'WithdrawMoney',
        token: SESSION_TOKEN,
        childid: retryUserInfo.id,
        amount: amountCents,
        currency: 'ARS',
        description: description || 'Retiro desde Sala de Juegos'
      });
      const retryHeaders = {};
      if (SESSION_COOKIE) retryHeaders.Cookie = SESSION_COOKIE;
      const retryResp = await client.post('', retryBody, { headers: retryHeaders, validateStatus: () => true });
      data = parsePossiblyWrappedJson(retryResp.data);
      if (isHtmlBlocked(data)) return { success: false, error: 'IP Bloqueada (HTML)' };
    }

    console.log("📩 Resultado WithdrawMoney:", JSON.stringify(data));

    if (data && (data.success || data.transfer_id || data.transferId)) {
      return { success: true, data };
    } else {
      return { success: false, error: data.error || data.message || 'API Error' };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================
// OBTENER MOVIMIENTOS SEMANALES (semana pasada: lunes a domingo)
// ============================================

// Rango de la SEMANA ACTUAL (lunes 00:00 hasta HOY 23:59 hora Argentina).
// Sirve para mostrar "cargaste esta semana" / "perdiste neto esta semana"
// en tiempo real — distinto de getLastWeekRangeArgentinaEpoch que apunta a
// la semana ya cerrada (para reembolsos del lunes).
function getCurrentWeekRangeArgentinaEpoch() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const now = new Date();
  const parts = formatter.formatToParts(now);
  const yyyy = parts.find(p => p.type === 'year').value;
  const mm = parts.find(p => p.type === 'month').value;
  const dd = parts.find(p => p.type === 'day').value;
  const todayLocal = new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`);

  const dayOfWeek = todayLocal.getDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const thisMonday = new Date(todayLocal.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);

  const mondayParts = formatter.formatToParts(thisMonday);
  const from = new Date(`${mondayParts.find(p => p.type === 'year').value}-${mondayParts.find(p => p.type === 'month').value}-${mondayParts.find(p => p.type === 'day').value}T00:00:00-03:00`);
  const to = new Date(`${yyyy}-${mm}-${dd}T23:59:59-03:00`);

  return {
    fromEpoch: Math.floor(from.getTime() / 1000),
    toEpoch: Math.floor(to.getTime() / 1000),
    fromDateStr: `${mondayParts.find(p => p.type === 'year').value}-${mondayParts.find(p => p.type === 'month').value}-${mondayParts.find(p => p.type === 'day').value}`,
    toDateStr: `${yyyy}-${mm}-${dd}`
  };
}

async function getUserNetCurrentWeek(username) {
  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };
  if (!SESSION_PARENT_ID) return { success: false, error: 'No se pudo obtener Admin ID' };
  try {
    const { fromEpoch, toEpoch, fromDateStr, toDateStr } = getCurrentWeekRangeArgentinaEpoch();
    console.log(`📊 Consultando movimientos SEMANA ACTUAL de ${username}: ${fromDateStr} a ${toDateStr}`);
    const body = toFormUrlEncoded({
      AdminID: SESSION_PARENT_ID,
      UserName: username,
      FromDate: fromEpoch,
      ToDate: toEpoch
    });
    const headers = {
      'Cookie': await getCookieString(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/Default.aspx`
    };
    const resp = await axios.post(`${BASE_URL}/ShowUserTransfersByAgent.aspx/GetData`,
      body,
      { headers, validateStatus: () => true, timeout: 12000 }
    );
    if (resp.status < 200 || resp.status >= 300) {
      return { success: false, error: `HTTP ${resp.status}` };
    }
    let parsed = resp.data;
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch (_) {} }
    const d = parsed && parsed.d;
    if (!d) return { success: false, error: 'Respuesta sin payload .d' };
    const list = Array.isArray(d) ? d : (d.Transfers || d.transfers || []);
    let totalDeposits = 0, totalWithdraws = 0;
    for (const t of list) {
      const amt = parseFloat(t.Amount || t.amount || 0) || 0;
      const op = String(t.OperationType || t.operationType || t.Operation || t.operation || '').toLowerCase();
      if (op.includes('deposit') || op.includes('credit') || op.includes('carga')) totalDeposits += Math.abs(amt);
      else if (op.includes('withdraw') || op.includes('debit') || op.includes('retiro')) totalWithdraws += Math.abs(amt);
      else if (amt > 0) totalDeposits += amt;
      else if (amt < 0) totalWithdraws += Math.abs(amt);
    }
    return { success: true, totalDeposits, totalWithdraws, range: { fromDateStr, toDateStr } };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function getLastWeekRangeArgentinaEpoch() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const now = new Date();
  const parts = formatter.formatToParts(now);
  const yyyy = parts.find(p => p.type === 'year').value;
  const mm = parts.find(p => p.type === 'month').value;
  const dd = parts.find(p => p.type === 'day').value;

  // Fecha actual en Argentina
  const todayLocal = new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`);
  
  // Día de la semana (0 = domingo, 1 = lunes, etc.)
  const dayOfWeek = todayLocal.getDay();
  
  // Días desde el lunes de esta semana
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  
  // Lunes de esta semana
  const thisMonday = new Date(todayLocal.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
  
  // Lunes de la semana pasada (7 días antes)
  const lastMonday = new Date(thisMonday.getTime() - 7 * 24 * 60 * 60 * 1000);
  
  // Domingo de la semana pasada (6 días después del lunes pasado)
  const lastSunday = new Date(lastMonday.getTime() + 6 * 24 * 60 * 60 * 1000);

  const mondayParts = formatter.formatToParts(lastMonday);
  const sundayParts = formatter.formatToParts(lastSunday);

  const from = new Date(`${mondayParts.find(p => p.type === 'year').value}-${mondayParts.find(p => p.type === 'month').value}-${mondayParts.find(p => p.type === 'day').value}T00:00:00-03:00`);
  const to = new Date(`${sundayParts.find(p => p.type === 'year').value}-${sundayParts.find(p => p.type === 'month').value}-${sundayParts.find(p => p.type === 'day').value}T23:59:59-03:00`);

  return {
    fromEpoch: Math.floor(from.getTime() / 1000),
    toEpoch: Math.floor(to.getTime() / 1000),
    fromDateStr: `${mondayParts.find(p => p.type === 'year').value}-${mondayParts.find(p => p.type === 'month').value}-${mondayParts.find(p => p.type === 'day').value}`,
    toDateStr: `${sundayParts.find(p => p.type === 'year').value}-${sundayParts.find(p => p.type === 'month').value}-${sundayParts.find(p => p.type === 'day').value}`
  };
}

async function getUserNetLastWeek(username) {
  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  if (!SESSION_PARENT_ID) {
    return { success: false, error: 'No se pudo obtener Admin ID' };
  }

  try {
    const { fromEpoch, toEpoch, fromDateStr, toDateStr } = getLastWeekRangeArgentinaEpoch();

    console.log(`📊 Consultando movimientos semanales de ${username}: ${fromDateStr} a ${toDateStr}`);

    const body = toFormUrlEncoded({
      action: 'ShowUserTransfersByAgent',
      token: SESSION_TOKEN,
      page: 1,
      pagesize: 200,
      fromtime: fromEpoch,
      totime: toEpoch,
      username: username,
      userrole: 'player',
      direct: 'False',
      childid: SESSION_PARENT_ID
    });

    const headers = {};
    if (SESSION_COOKIE) headers.Cookie = SESSION_COOKIE;

    const resp = await client.post('', body, { headers });

    let data = parsePossiblyWrappedJson(resp.data);
    if (isHtmlBlocked(data)) {
      return { success: false, error: 'IP Bloqueada (HTML)' };
    }

    const totalDepositsCents = Number(data?.total_deposits || 0);
    const totalWithdrawsCents = Number(data?.total_withdraws || 0);
    const netCents = totalDepositsCents - totalWithdrawsCents;

    const totalDeposits = totalDepositsCents / 100;
    const totalWithdraws = totalWithdrawsCents / 100;
    const net = netCents / 100;

    console.log(`📊 ${username} semana pasada: Depósitos=$${totalDeposits}, Retiros=$${totalWithdraws}, Neto=$${net}`);

    return {
      success: true,
      net: Number(net.toFixed(2)),
      totalDeposits: Number(totalDeposits.toFixed(2)),
      totalWithdraws: Number(totalWithdraws.toFixed(2)),
      fromEpoch,
      toEpoch,
      fromDateStr,
      toDateStr
    };
  } catch (err) {
    console.error('❌ Error en getUserNetLastWeek:', err.message);
    return { success: false, error: err.message };
  }
}

// ============================================
// OBTENER MOVIMIENTOS MENSUALES (mes pasado completo)
// ============================================

function getLastMonthRangeArgentinaEpoch() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const now = new Date();
  const parts = formatter.formatToParts(now);
  const yyyy = parseInt(parts.find(p => p.type === 'year').value);
  const mm = parseInt(parts.find(p => p.type === 'month').value);

  // Mes pasado
  let lastMonth = mm - 1;
  let lastMonthYear = yyyy;
  if (lastMonth === 0) {
    lastMonth = 12;
    lastMonthYear = yyyy - 1;
  }

  // Último día del mes pasado
  const lastDayOfLastMonth = new Date(lastMonthYear, lastMonth, 0).getDate();

  const from = new Date(`${lastMonthYear}-${String(lastMonth).padStart(2, '0')}-01T00:00:00-03:00`);
  const to = new Date(`${lastMonthYear}-${String(lastMonth).padStart(2, '0')}-${lastDayOfLastMonth}T23:59:59-03:00`);

  return {
    fromEpoch: Math.floor(from.getTime() / 1000),
    toEpoch: Math.floor(to.getTime() / 1000),
    fromDateStr: `${lastMonthYear}-${String(lastMonth).padStart(2, '0')}-01`,
    toDateStr: `${lastMonthYear}-${String(lastMonth).padStart(2, '0')}-${lastDayOfLastMonth}`
  };
}

async function getUserNetLastMonth(username) {
  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  if (!SESSION_PARENT_ID) {
    return { success: false, error: 'No se pudo obtener Admin ID' };
  }

  try {
    const { fromEpoch, toEpoch, fromDateStr, toDateStr } = getLastMonthRangeArgentinaEpoch();

    console.log(`📊 Consultando movimientos mensuales de ${username}: ${fromDateStr} a ${toDateStr}`);

    const body = toFormUrlEncoded({
      action: 'ShowUserTransfersByAgent',
      token: SESSION_TOKEN,
      page: 1,
      pagesize: 500,
      fromtime: fromEpoch,
      totime: toEpoch,
      username: username,
      userrole: 'player',
      direct: 'False',
      childid: SESSION_PARENT_ID
    });

    const headers = {};
    if (SESSION_COOKIE) headers.Cookie = SESSION_COOKIE;

    const resp = await client.post('', body, { headers });

    let data = parsePossiblyWrappedJson(resp.data);
    if (isHtmlBlocked(data)) {
      return { success: false, error: 'IP Bloqueada (HTML)' };
    }

    const totalDepositsCents = Number(data?.total_deposits || 0);
    const totalWithdrawsCents = Number(data?.total_withdraws || 0);
    const netCents = totalDepositsCents - totalWithdrawsCents;

    const totalDeposits = totalDepositsCents / 100;
    const totalWithdraws = totalWithdrawsCents / 100;
    const net = netCents / 100;

    console.log(`📊 ${username} mes pasado: Depósitos=$${totalDeposits}, Retiros=$${totalWithdraws}, Neto=$${net}`);

    return {
      success: true,
      net: Number(net.toFixed(2)),
      totalDeposits: Number(totalDeposits.toFixed(2)),
      totalWithdraws: Number(totalWithdraws.toFixed(2)),
      fromEpoch,
      toEpoch,
      fromDateStr,
      toDateStr
    };
  } catch (err) {
    console.error('❌ Error en getUserNetLastMonth:', err.message);
    return { success: false, error: err.message };
  }
}

// ============================================
// ChangePassword - Cambiar contraseña de usuario en JUGAYGANA
// Usa la API de usuario (jugaygana44.bet/api/app/) con multipart/form-data
// y el token del propio usuario (no el token admin).
// ============================================

const APP_API_URL = process.env.JUGAYGANA_APP_API_URL || 'https://jugaygana44.bet/api/app/';

async function changeUserPassword(username, currentPassword, newPassword) {
  if (!currentPassword) {
    console.warn(`[changeUserPassword] Contraseña actual no disponible para ${username} (reset por teléfono). No se puede sincronizar sin contraseña actual.`);
    return { success: false, error: 'Contraseña actual requerida para autenticarse en la API de JUGAYGANA' };
  }

  // Cliente dedicado para la API de usuario (jugaygana44.bet/api/app/)
  const appClient = axios.create({
    baseURL: APP_API_URL,
    timeout: 20000,
    httpsAgent,
    proxy: false,
    validateStatus: () => true,
    maxRedirects: 0,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://jugaygana44.bet',
      'Referer': 'https://jugaygana44.bet/user/password',
      'Accept-Language': 'es-419,es;q=0.9'
    }
  });

  try {
    // Paso 1: Login como el usuario para obtener SU token
    const loginForm = new FormData();
    loginForm.append('action', 'LOGIN');
    loginForm.append('username', username);
    loginForm.append('password', currentPassword);

    console.log(`[changeUserPassword] Paso 1: login como ${username} en ${APP_API_URL}`);
    const loginResp = await appClient.post('', loginForm, {
      headers: loginForm.getHeaders()
    });

    const loginData = parsePossiblyWrappedJson(loginResp.data);
    if (isHtmlBlocked(loginData)) {
      return { success: false, error: 'IP bloqueada / HTML en login' };
    }

    const userToken = loginData?.token || loginData?.data?.token;
    if (!userToken) {
      const errMsg = loginData?.message || loginData?.error || JSON.stringify(loginData);
      console.error(`[changeUserPassword] Login fallido para ${username}: ${errMsg}`);
      return { success: false, error: `Login fallido: ${errMsg}` };
    }

    console.log(`[changeUserPassword] Login OK para ${username}, procediendo a cambiar contraseña`);

    // Paso 2: Cambiar contraseña usando el token del usuario
    const changeForm = new FormData();
    changeForm.append('action', 'ChangePassword');
    changeForm.append('token', userToken);
    changeForm.append('password', currentPassword);
    changeForm.append('newpassword', newPassword);

    const changeResp = await appClient.post('', changeForm, {
      headers: changeForm.getHeaders()
    });

    const changeData = parsePossiblyWrappedJson(changeResp.data);
    if (isHtmlBlocked(changeData)) {
      return { success: false, error: 'IP bloqueada / HTML en cambio de contraseña' };
    }

    if (changeData?.success) {
      console.log(`✅ Contraseña cambiada en JUGAYGANA para: ${username}`);
      return { success: true };
    }

    const errMsg = changeData?.message || changeData?.error || JSON.stringify(changeData);
    console.error(`❌ Error al cambiar contraseña en JUGAYGANA para ${username}: ${errMsg}`);
    return { success: false, error: errMsg };
  } catch (err) {
    console.error('❌ Error en changeUserPassword JUGAYGANA:', err.message);
    return { success: false, error: err.message };
  }
}

// ============================================
// Exportar funciones
// ============================================

module.exports = {
  logProxyIP,
  ensureSession,
  loginAndGetToken,
  createPlatformUser,
  getUserInfoByName,
  checkUserExists,
  syncUserToPlatform,
  getUserNetYesterday,
  getUserNetLastWeek,
  getUserNetLastMonth,
  checkClaimedToday,
  creditUserBalance,
  depositToUser,
  withdrawFromUser,
  changeUserPassword,
  getYesterdayRangeArgentinaEpoch,
  getLastWeekRangeArgentinaEpoch,
  getCurrentWeekRangeArgentinaEpoch,
  getUserNetCurrentWeek,
  getLastMonthRangeArgentinaEpoch,
  /** Returns the current session token, or null if no session is active. */
  getSessionToken: () => SESSION_TOKEN,
  /** Returns the current session cookie string, or null if no session is active. */
  getSessionCookie: () => SESSION_COOKIE
};