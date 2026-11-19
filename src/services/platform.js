/**
 * platform.js (#197) — FACHADA de plataforma + MOTOR DE MUDANZA usuario por usuario.
 *
 * Este repo opera sobre JUGAYGANA (jugaygana44.bet) y se está mudando a jugaygana.io
 * (copia de 1girox, Partner API). Las dos plataformas CONVIVEN: cada usuario tiene
 * `User.platform` ('jugaygana' por defecto | 'partner') y esta fachada manda cada
 * operación a la plataforma de ESE usuario.
 *
 * REGLA DE ORO: para un usuario que sigue en 'jugaygana' la fachada llama EXACTAMENTE
 * a la misma función del cliente viejo con los mismos argumentos. Con la mudanza
 * apagada (default) nada cambia respecto de antes de este archivo.
 *
 * Para un usuario 'partner':
 *   - los montos van en PESOS (igual que hoy: el ×100 lo hacía adentro el cliente viejo);
 *   - toda operación de plata lleva una `reference` (la que pase el caller en `opts.reference`
 *     o una generada acá). ⚠️ Un error TRANSITORIO de la Partner API (red, timeout, 429, 5xx)
 *     se devuelve como `{ success:false, ambiguous:true }`: es el MISMO contrato del #151 que
 *     ya respetan todos los callers (frenar + `_alertMoneyAmbiguous`, nunca reintentar ni
 *     liberar la reserva). Un rechazo de negocio (4xx) es un fallo común: no se movió nada.
 *   - los regalos (`creditUserBalance`, `makeBonus`) salen como BONO (regalo directo o con el
 *     rollover global, ver `setRolloverResolver` en giroxService); las devoluciones y las
 *     comisiones pasan `ignoreGlobalRollover`.
 *
 * MUDANZA de un usuario (migrateUser): 1) candado atómico en User → 2) existe en la nueva →
 * 3) leer saldo en la vieja → 4) retirar TODO de la vieja → 5) cargar lo mismo en la nueva
 * con reference fija `vip-mig-<userId>-r<round>` → 6) `User.platform = 'partner'`.
 * Nunca se carga en la nueva sin tener CONFIRMADO el retiro en la vieja. El libro de cada
 * mudanza es `PlatformMigration` (ver ese modelo para los estados).
 *
 * Config (`Config['platformMigration']`, se lee con cache de 10 s — multi-instancia):
 *   { mode: 'off' | 'list' | 'all', usernames: [..], capARS: 200000, paused, pausedReason,
 *     createMissing: true, newUsersOnPartner, pausedTeams: { teamId: motivo }, lockOldAccount: true }
 *
 * CIERRE DE LA CUENTA VIEJA (#198): con `lockOldAccount` (default true), al terminar la mudanza se
 * le cambia la clave en JUGAYGANA por una al azar que NO se guarda → el jugador (ni nadie) puede
 * volver a entrar a la cuenta vieja. Lo de la app sobre la vieja (recheck de saldo, residuos,
 * netwin) usa la sesión del AGENTE, no la del jugador, así que sigue andando. Recién DESPUÉS de
 * la carga confirmada en la nueva; si falla se reintenta en el tick (nunca frena la mudanza).
 *
 * EQUIPOS: cada equipo de jugaygana.io tiene SU API key y uno o más "inicios" de username
 * (atojuan299 → equipo ATOMIC por el inicio "ato"). El usuario se crea con la key de su equipo y
 * `User.partnerTeam` lo deja fijo: todo lo que haga después firma con esa key (ver keyResolver).
 * Sin inicio reconocido → equipo 'default' (la key general).
 */
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const logger = require('../utils/logger');
const jugaygana = require('../../jugaygana');
const jugayganaMovements = require('../../jugaygana-movements');
const jugayganaService = require('./jugayganaService');
const referralRevenueService = require('./referralRevenueService');
const girox = require('./giroxService');
const User = require('../models/User');
const Config = require('../models/Config');
const PlatformMigration = require('../models/PlatformMigration');

const CFG_KEY = 'platformMigration';
const DEFAULT_CFG = Object.freeze({
  mode: 'off',          // off | list | all
  usernames: [],        // modo 'list': usernames en minúscula
  capARS: 200000,       // saldo mayor a esto NO se muda solo: lo aprueba el admin general
  paused: false,        // pausa de emergencia (también la pone sola el motor si la nueva se queda sin fichas)
  pausedReason: null,
  createMissing: true,  // si el jugador no existe en la nueva: true = crearlo en su equipo (default); false = esperar a que lo copien
  pausedTeams: {},      // { <teamId>: motivo } — equipos con la mudanza frenada (p. ej. sin fichas)
  newUsersOnPartner: false, // los que se REGISTRAN desde ahora se crean directo en la nueva
  lockOldAccount: true  // #198: al mudar, clave al azar en la cuenta vieja de JUGAYGANA
});
const MIN_MOVE_ARS = 1;                 // por debajo de $1 no se mueve plata (se muda igual)
const LOCK_STALE_MS = 10 * 60 * 1000;   // una mudanza "running" sin latido por 10 min está colgada
const FAILED_RETRY_MS = 2 * 60 * 1000;       // base: se duplica con cada intento fallido (tope 1 h) — ver _failedWaitMs
const FAILED_ALERT_AFTER = 5;                // intentos fallidos seguidos antes de avisar por Telegram (una vez)
function _failedWaitMs(attempts) { return Math.min(60 * 60 * 1000, FAILED_RETRY_MS * Math.pow(2, Math.max(0, (attempts || 1) - 1))); }
// #201 "Si la API falla, se cancela y se prueba la próxima": cortacorriente. Con 3 fallas seguidas de jugaygana.io
// (o de JUGAYGANA) ANTES de mover plata, no se arrancan mudanzas nuevas por 2 minutos (nadie queda a medias y las
// cargas no esperan a una plataforma caída). El primer éxito lo cierra.
const BREAKER_FAILS = 3;
const BREAKER_OPEN_MS = 2 * 60 * 1000;
let _apiFailStreak = 0;
let _breakerUntil = 0;
function _apiFail(what) {
  _apiFailStreak++;
  if (_apiFailStreak >= BREAKER_FAILS && Date.now() >= _breakerUntil) {
    _breakerUntil = Date.now() + BREAKER_OPEN_MS;
    logger.warn(`[platform] ${_apiFailStreak} fallas seguidas (${what}): no se arrancan mudanzas nuevas por ${BREAKER_OPEN_MS / 60000} min`);
  }
}
function _apiOk() { _apiFailStreak = 0; }
function _breakerOpen() { return Date.now() < _breakerUntil; }
// #201: un retiro DUDOSO en la vieja se re-verifica solo durante esta ventana (con el usuario con candado, para que
// el saldo no lo mueva la app). Saldo intacto = el retiro no se hizo → se cancela sola. Si no se puede saber → persona.
const REVIEW_AUTO_MS = 15 * 60 * 1000;
const HELD_RETRY_MS = 30 * 60 * 1000;   // not_in_new / cap se re-evalúan solos cada 30 min
const APP_OPEN_THROTTLE_MS = 60 * 1000;
// #201: revisiones del saldo de la vieja después de mudar (cada espera cuenta desde la revisión anterior).
const RECHECK_DELAYS_MS = [10 * 60 * 1000, 60 * 60 * 1000, 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000]; // 10 min · 1 h · 1 día · 1 semana · 1 mes (apuestas deportivas que cierran tarde)
// #201: mudanzas en SEGUNDO PLANO (abrió la app / login) simultáneas por instancia. Con "Todos" y miles de usuarios
// entrando a la vez, sin tope se satura a las dos plataformas (429 / Cloudflare) y todo termina en reintentos.
// El botón del casino y las cargas NO pasan por este tope (el usuario está esperando).
const BG_MAX_CONCURRENT = 4;
let _bgRunning = 0;
const MIGRATING_MSG = 'Estamos actualizando tu cuenta. Probá de nuevo en un minuto.';
const PARTNER_USERNAME_RE = /^[A-Za-z0-9_]{3,18}$/;

// ------------------------------------------------------------
// Hooks que inyecta server.js (alertas a Telegram, nota interna en el chat)
// ------------------------------------------------------------
let _hooks = { alert: null, note: null, loadTeams: null };
function setHooks(h) { _hooks = Object.assign({ alert: null, note: null, loadTeams: null }, h || {}); }
async function _alert(text) { try { if (_hooks.alert) await _hooks.alert(text); } catch (_) {} }
async function _note(userId, username, content) { try { if (_hooks.note) await _hooks.note(userId, username, content); } catch (_) {} }

// ------------------------------------------------------------
// EQUIPOS (una API key por equipo, elegida por el inicio del username)
// ------------------------------------------------------------
const DEFAULT_TEAM = 'default';
const UNRESOLVED_KEY = 'pk_sin_resolver'; // key inválida a propósito: la plataforma responde 401 y no se opera con la key equivocada
let _teamsLoaded = false; // recién arrancado el server, los equipos todavía no se leyeron de la base
let _teams = []; // [{ id, name, prefixes:[minúsculas], key }]  — las keys llegan descifradas desde server.js
function setTeams(list) {
  _teams = (Array.isArray(list) ? list : []).map((t) => ({
    id: String(t.id), name: String(t.name || t.id),
    prefixes: (Array.isArray(t.prefixes) ? t.prefixes : []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean),
    key: t.key || null
  }));
  _teamsLoaded = true;
  _teamCache.clear();
}
function getTeam(id) { return _teams.find((t) => t.id === id) || null; }
function teamName(id) { if (!id || id === DEFAULT_TEAM) return 'General'; const t = getTeam(id); return t ? t.name : `equipo ${id}`; }
/** Equipo que le toca a un username por su inicio (gana el inicio más largo). Sin coincidencia → 'default'. */
function teamForUsername(username) {
  const u = String(username || '').toLowerCase();
  let best = null, bestLen = 0;
  for (const t of _teams) for (const pre of t.prefixes) {
    if (pre.length > bestLen && u.startsWith(pre)) { best = t.id; bestLen = pre.length; }
  }
  return best || DEFAULT_TEAM;
}
/** Equipo de un usuario: el que quedó guardado al crearlo en la nueva; si no, el de su inicio. */
function teamOfUserDoc(user) { return (user && user.partnerTeam) || teamForUsername(user && user.username); }
const _teamCache = new Map(); // usernameLower → { team, ts }
function _forgetTeam(username) { _teamCache.delete(String(username || '').toLowerCase()); }
async function _teamOfUsername(username) {
  const k = String(username || '').toLowerCase();
  const hit = _teamCache.get(k);
  if (hit && (Date.now() - hit.ts) < 60000) return hit.team;
  try {
    const doc = await _findUser(username);
    const team = doc ? teamOfUserDoc(doc) : teamForUsername(username);
    _teamCache.set(k, { team, ts: Date.now() });
    return team;
  } catch (e) {
    if (hit) return hit.team; // base caída: último valor conocido
    throw e;
  }
}
/**
 * Resolver `username → API key` que usa giroxService en TODA operación por username.
 * null = key general. Si el equipo no se puede determinar o no tiene key cargada, devuelve una
 * key inválida: la operación falla con 401 (nada se mueve) en vez de salir con la key de otro equipo.
 */
async function keyResolver(username) {
  if (!_teamsLoaded && _hooks.loadTeams) { try { await _hooks.loadTeams(); } catch (_) {} }
  let team;
  try { team = await _teamOfUsername(username); }
  catch (e) { logger.warn(`[platform] no se pudo resolver el equipo de ${username}: ${e.message}`); return UNRESOLVED_KEY; }
  if (!team || team === DEFAULT_TEAM) return null;
  const t = getTeam(team);
  if (!t || !t.key) { logger.error(`[platform] ${username} es del equipo ${team} pero ese equipo no tiene API key cargada`); return UNRESOLVED_KEY; }
  return t.key;
}
girox.setKeyResolver(keyResolver);

// ------------------------------------------------------------
// Config
// ------------------------------------------------------------
let _cfgCache = null;
let _cfgAt = 0;
function _normCfg(raw) {
  const c = Object.assign({}, DEFAULT_CFG, (raw && typeof raw === 'object') ? raw : {});
  c.mode = ['off', 'list', 'all'].includes(c.mode) ? c.mode : 'off';
  c.usernames = Array.from(new Set((Array.isArray(c.usernames) ? c.usernames : [])
    .map((u) => String(u || '').trim().toLowerCase()).filter(Boolean))).slice(0, 5000);
  const cap = Number(c.capARS);
  c.capARS = Number.isFinite(cap) && cap >= 0 ? Math.round(cap) : DEFAULT_CFG.capARS;
  c.paused = c.paused === true;
  c.pausedReason = c.pausedReason ? String(c.pausedReason).slice(0, 300) : null;
  c.createMissing = c.createMissing !== false;
  const pt = {};
  if (c.pausedTeams && typeof c.pausedTeams === 'object') for (const k of Object.keys(c.pausedTeams)) if (c.pausedTeams[k]) pt[String(k)] = String(c.pausedTeams[k]).slice(0, 300);
  c.pausedTeams = pt;
  c.newUsersOnPartner = c.newUsersOnPartner === true; // altas nuevas directo en la plataforma nueva
  c.lockOldAccount = c.lockOldAccount !== false;        // #198: default prendido
  return c;
}
async function getMigrationConfig({ fresh = false } = {}) {
  if (!fresh && _cfgCache && (Date.now() - _cfgAt) < 10000) return _cfgCache;
  try {
    const doc = await Config.findOne({ key: CFG_KEY }).lean();
    _cfgCache = _normCfg(doc && doc.value);
  } catch (e) {
    logger.warn(`[platform] no se pudo leer la config de mudanza: ${e.message}`);
    if (!_cfgCache) _cfgCache = _normCfg(null); // sin config legible = apagado
  }
  _cfgAt = Date.now();
  return _cfgCache;
}
async function saveMigrationConfig(patch, by) {
  const cur = await getMigrationConfig({ fresh: true });
  const next = _normCfg(Object.assign({}, cur, patch || {}));
  next.updatedBy = by || null;
  next.updatedAt = new Date();
  await Config.findOneAndUpdate({ key: CFG_KEY }, { key: CFG_KEY, value: next, updatedAt: new Date() }, { upsert: true });
  _cfgCache = _normCfg(next); _cfgAt = Date.now();
  return _cfgCache;
}
/** true si la plataforma nueva está configurada (URL + key). */
function partnerEnabled() { return girox.isEnabled(); }
function isValidPartnerUsername(u) { return PARTNER_USERNAME_RE.test(String(u || '')); }

// ------------------------------------------------------------
// Ruteo por usuario
// ------------------------------------------------------------
const ROUTE_FIELDS = 'id username role platform platformMigrating platformMigratingAt platformMigratedAt jugayganaUserId partnerTeam';
async function _findUser(username) {
  const u = String(username || '').trim();
  if (!u) return null;
  let doc = await User.findOne({ username: u }).select(ROUTE_FIELDS).lean();
  if (!doc) doc = await User.findOne({ usernameLower: u.toLowerCase() }).select(ROUTE_FIELDS).lean();
  return doc;
}
/**
 * @returns {{provider:'jugaygana'|'partner', user:object|null, migrating:boolean}}
 * Ante un error de DB se asume 'jugaygana' SOLO para lecturas; las operaciones de plata
 * usan _routeStrict, que propaga el error (no se manda plata a ciegas a la plataforma equivocada).
 */
async function routeFor(username) {
  try { return await _routeStrict(username); }
  catch (e) {
    logger.warn(`[platform] routeFor(${username}) falló: ${e.message} — se asume jugaygana (solo lectura)`);
    return { provider: 'jugaygana', user: null, migrating: false };
  }
}
async function _routeStrict(username) {
  const user = await _findUser(username);
  if (!user) return { provider: 'jugaygana', user: null, migrating: false };
  return {
    provider: user.platform === 'partner' ? 'partner' : 'jugaygana',
    user,
    migrating: user.platformMigrating === true
  };
}
async function providerOf(username) { return (await routeFor(username)).provider; }

function _migratingResult() { return { success: false, error: MIGRATING_MSG, code: 'migrating', migrating: true }; }

/** Traduce el resultado de giroxService al contrato de los clientes viejos (#151). */
function _mapPartnerMoney(r, what) {
  if (r && r.success) { r.platform = 'partner'; return r; }
  const code = (r && r.code) || 'unknown';
  const st = r ? r.httpStatus : null;
  const neverSent = code === 'not_configured' || code === 'invalid_amount' || code === 'invalid_username' || code === 'rate_limited_local'; // #201: el freno local NO envió nada → no es ambiguo
  const transient = !neverSent && (st == null || st === 429 || Number(st) >= 500);
  const err = girox.errToString((r && r.error) || 'Error de la plataforma');
  if (transient) {
    return {
      success: false, ambiguous: true, platform: 'partner', code,
      error: `jugaygana.io no confirmó ${what} (${err}). Puede haber entrado o no: verificar antes de repetir.`
    };
  }
  return { success: false, platform: 'partner', code, httpStatus: st, error: err, wagering: (r && r.wagering) || null };
}
function _ref(prefix, opts) {
  if (opts && opts.reference) return String(opts.reference).slice(0, 100);
  return `vip-${prefix}-${uuidv4()}`;
}

// ------------------------------------------------------------
// PLATA
// ------------------------------------------------------------
/**
 * Carga. Misma firma que jugaygana.depositToUser + `opts` al final:
 *   opts.reference  llave de idempotencia (solo plataforma nueva)
 *   opts.noAutoMigrate  true = no intentar mudar al usuario antes de cargar
 */
async function depositToUser(username, amount, description = '', jugayganaUserId = null, opts = {}) {
  let route = await _routeStrict(username);
  // La carga es el momento natural de la mudanza: si le toca, se muda ANTES y la carga
  // ya entra en la plataforma nueva. Si la mudanza no se puede hacer ahora, sigue en la vieja.
  if (route.user && route.provider === 'jugaygana' && !route.migrating && !(opts && opts.noAutoMigrate)) {
    try {
      const m = await migrateUser(route.user.id, { trigger: 'deposit' });
      // Se relee SIEMPRE que la mudanza haya hecho algo: si quedó a mitad de camino el usuario
      // tiene el candado puesto y esta carga NO debe ir a la plataforma vieja.
      if (m && m.status !== 'skip') route = await _routeStrict(username);
    } catch (e) {
      logger.warn(`[platform] mudanza previa a la carga de ${username} falló: ${e.message}`);
      // #201: la ruta leída ANTES de la mudanza ya no vale (pudo haberle retirado el saldo). Se relee; si no se puede, no se carga.
      try { route = await _routeStrict(username); } catch (_) { return _migratingResult(); }
    }
  }
  // #201: si OTRO proceso lo está mudando en este momento, se espera un rato corto a que termine
  // (lo normal son segundos) en vez de rebotar la carga.
  if (route.migrating && route.user) {
    for (let i = 0; i < 8 && route.migrating; i++) {
      const pm = await PlatformMigration.findOne({ userId: route.user.id }).select('status').lean().catch(() => null);
      if (!pm || pm.status !== 'running') break; // deposit_pending / review: no se resuelve en segundos
      await _sleep(1500);
      route = await _routeStrict(username);
    }
  }
  if (route.migrating) return _migratingResult();
  if (route.provider === 'partner') {
    const r = await girox.depositToUser(username, amount, description, _ref('dep', opts), { noBonus: true });
    return _mapPartnerMoney(r, `la carga de $${amount}`);
  }
  return jugaygana.depositToUser(username, amount, description, jugayganaUserId);
}

/** Retiro. Misma firma que jugaygana.withdrawFromUser + `opts.reference`. */
async function withdrawFromUser(username, amount, description = '', jugayganaUserId = null, opts = {}) {
  const route = await _routeStrict(username);
  if (route.migrating) return _migratingResult();
  if (route.provider === 'partner') {
    const r = await girox.withdrawFromUser(username, amount, description, _ref('wd', opts));
    return _mapPartnerMoney(r, `el retiro de $${amount}`);
  }
  return jugaygana.withdrawFromUser(username, amount, description, jugayganaUserId);
}

/**
 * Regalo / bono / reembolso. Misma firma que jugaygana.creditUserBalance + `opts`:
 *   opts.reference, opts.description
 *   opts.ignoreGlobalRollover  true = plata del cliente (devolución, comisión): sin rollover
 */
async function creditUserBalance(username, amount, jugayganaUserId = null, opts = {}) {
  const route = await _routeStrict(username);
  if (route.migrating) return _migratingResult();
  if (route.provider === 'partner') {
    const r = await girox.creditUserBalance(username, amount, _ref('gift', opts), {
      description: (opts && opts.description) || '',
      ignoreGlobalRollover: !!(opts && opts.ignoreGlobalRollover)
    });
    return _mapPartnerMoney(r, `el crédito de $${amount}`);
  }
  return jugaygana.creditUserBalance(username, amount, jugayganaUserId);
}

/** Igual que jugayganaMovements.makeBonus + `opts`. */
async function makeBonus(username, amount, description = '', opts = {}) {
  const route = await _routeStrict(username);
  if (route.migrating) return _migratingResult();
  if (route.provider === 'partner') {
    return creditUserBalance(username, amount, null, Object.assign({ description }, opts || {}));
  }
  return jugayganaMovements.makeBonus(username, amount, description);
}

// ------------------------------------------------------------
// SALDO
// ------------------------------------------------------------
async function _partnerBalance(username, { fresh = true, retry = false, maxAttempts = 3, baseDelayMs = 500 } = {}) {
  const r = retry
    ? await girox.getUserBalanceWithRetry(username, { maxAttempts, baseDelayMs, fresh })
    : await girox.getUserBalance(username, { fresh });
  if (!r.success) return { success: false, error: girox.errToString(r.error), platform: 'partner', attemptsExhausted: r.attemptsExhausted };
  return {
    success: true, platform: 'partner', username: r.username,
    balance: r.balance,
    // Con rollover activo en la plataforma nueva, lo RETIRABLE es `available`, no `balance`.
    available: r.available, locked: r.locked, bonusLocked: r.bonusLocked, claimableTotal: r.claimableTotal
  };
}
/** Mientras la carga en la nueva está pendiente, el saldo "debido" se muestra como saldo. */
async function _pendingBalance(user) {
  try {
    const m = await PlatformMigration.findOne({ userId: user.id, status: { $in: ['deposit_pending', 'running'] } }).lean();
    if (m && (m.status === 'deposit_pending' || m.phase === 'withdrawn' || m.phase === 'depositing')) {
      return { success: true, balance: Number(m.amount) || 0, available: 0, username: user.username, platform: 'migrating', migrating: true };
    }
  } catch (_) {}
  return null;
}
/**
 * Saldo. Para usuarios en la vieja devuelve EXACTAMENTE lo de jugayganaMovements.
 * Para usuarios en la nueva suma `available` (retirable) y `platform:'partner'`.
 * opts.fresh (default true en la nueva) / opts.display true = se puede servir del cache corto.
 */
async function getUserBalance(username, opts = {}) {
  const route = await routeFor(username);
  if (route.migrating && route.user) { const p = await _pendingBalance(route.user); if (p) return p; }
  if (route.provider === 'partner') return _partnerBalance(username, { fresh: !(opts && opts.display) });
  return _flagMigrating(await jugayganaMovements.getUserBalance(username), route);
}
async function getUserBalanceWithRetry(username, opts = {}) {
  const route = await routeFor(username);
  if (route.migrating && route.user) { const p = await _pendingBalance(route.user); if (p) return p; }
  if (route.provider === 'partner') {
    return _partnerBalance(username, { fresh: !(opts && opts.display), retry: true, maxAttempts: (opts && opts.maxAttempts) || 3, baseDelayMs: (opts && opts.baseDelayMs) || 500 });
  }
  return _flagMigrating(await jugayganaMovements.getUserBalanceWithRetry(username, opts), route);
}
// #201: mudanza en curso sin plata en tránsito todavía (o justo retirándose): el saldo leído puede estar a mitad de
// camino. Se marca `migrating` para que quien valida un retiro no lo tome como "saldo insuficiente".
function _flagMigrating(res, route) {
  if (res && route && route.migrating) { try { res.migrating = true; } catch (_) {} }
  return res;
}
/** Lo que el usuario puede RETIRAR según un resultado de saldo de esta fachada. */
function withdrawable(balRes) {
  if (!balRes || !balRes.success) return null;
  return (balRes.available != null && Number.isFinite(Number(balRes.available))) ? Number(balRes.available) : Number(balRes.balance);
}
async function getUserMovements(username, options) {
  const route = await routeFor(username);
  if (route.provider === 'partner') return girox.getUserMovements();
  return jugayganaMovements.getUserMovements(username, options);
}

// ------------------------------------------------------------
// NETWIN (reembolsos / referidos)
// ------------------------------------------------------------
// 'total' (default) = casino + deportes, igual que el GGR total que se usa hoy con JUGAYGANA.
function _netwinScope() { return String(process.env.PARTNER_NETWIN_SCOPE || 'total').toLowerCase() === 'casino' ? 'casino' : 'total'; }
function _fail(error) { return { success: false, error, totalGgr: 0 }; }
/**
 * Misma firma y forma de respuesta que referralRevenueService.getUserNetwinForDateRange
 * (`totalGgr` en pesos; positivo = el jugador perdió — mismo signo en las dos plataformas).
 * Para un usuario ya mudado SUMA lo jugado en la vieja (si el rango empieza antes de su
 * mudanza) + lo jugado en la nueva. Si cualquiera de las dos partes falla, falla todo:
 * no se paga un reembolso calculado con la mitad de los datos.
 */
// ------------------------------------------------------------
// #204 CORTE DEFINITIVO de la lectura de la JUGAYGANA vieja para usuarios MUDADOS (owner 2026-11-19).
// Hasta esta fecha, el reembolso y la comisión de referidos de un mudado suman lo que jugó en
// la vieja ANTES de mudarse (dentro del mismo período). Desde el 1 de enero de 2027, 00:00 hora
// Argentina, un usuario mudado cuenta SOLO lo jugado en jugaygana.io: la vieja ni se consulta.
// ⚠️ FIJO A PROPÓSITO: sin env, sin Config, sin botón en el panel (pedido del owner: "programado
// e irremovible"). Para cambiarlo hay que tocar esta línea y desplegar.
// NO afecta a quien todavía NO se mudó (sigue entero en la vieja) ni a la mudanza en sí (que
// necesita la vieja para pasar el saldo).
// ------------------------------------------------------------
const OLD_NETWIN_CUTOFF_MS = Date.parse('2027-01-01T00:00:00-03:00');
function oldNetwinCut() { return Date.now() >= OLD_NETWIN_CUTOFF_MS; }

async function getUserNetwinForDateRange(username, jugayganaUserId, fromDate, toDate, periodLabel = 'custom') {
  const route = await routeFor(username);
  if (route.provider !== 'partner') {
    return referralRevenueService.getUserNetwinForDateRange(username, jugayganaUserId, fromDate, toDate, periodLabel);
  }
  const st = await girox.getPlayerStats(username, fromDate, toDate, periodLabel, { fresh: true });
  if (!st.success) return _fail(`jugaygana.io: ${girox.errToString(st.error)}`);
  const newGgr = _netwinScope() === 'casino' ? st.casinoNetwin : st.netwin;
  let oldGgr = 0, oldBets = 0, oldWins = 0, oldUsed = false;
  const migratedAt = route.user && route.user.platformMigratedAt ? new Date(route.user.platformMigratedAt) : null;
  const jgId = jugayganaUserId != null ? jugayganaUserId : (route.user && route.user.jugayganaUserId);
  if (!oldNetwinCut() && jgId != null && (!migratedAt || fromDate < migratedAt)) { // #204: desde el corte no se lee la vieja
    const old = await referralRevenueService.getUserNetwinForDateRange(username, jgId, fromDate, toDate, periodLabel);
    if (!old.success) return _fail(`JUGAYGANA (tramo anterior a la mudanza): ${jugaygana.errToString(old.error)}`);
    oldGgr = Number(old.totalGgr) || 0; oldBets = Number(old.totalBets) || 0; oldWins = Number(old.totalWins) || 0; oldUsed = true;
  }
  return {
    success: true, username, period: periodLabel, currency: 'ARS',
    totalBets: oldBets + (Number(st.wagered) || 0),
    totalWins: oldWins + (Number(st.payout) || 0),
    totalGgr: oldGgr + (Number(newGgr) || 0),
    providers: [], totalOwnerRevenue: 0,
    individualRevenueFound: true, usedGlobalAggregate: false, revenueScope: 'perUser',
    platform: 'partner', platformParts: { old: oldUsed ? oldGgr : null, partner: Number(newGgr) || 0 }
  };
}
/**
 * Igual que referralRevenueService.getUserRevenueForPeriod (referidos, período YYYY-MM).
 * `user` = { username, jugayganaUsername, jugayganaUserId, platform, platformMigratedAt }.
 * Usuario en la vieja → llamada idéntica a la de siempre.
 */
async function getUserRevenueForPeriod(user, periodKey) {
  const jgUsername = user.jugayganaUsername || user.username;
  const jgUserId = user.jugayganaUserId != null ? user.jugayganaUserId : null;
  if (user.platform !== 'partner') {
    return referralRevenueService.getUserRevenueForPeriod(jgUsername, periodKey, jgUserId);
  }
  // Mes ARGENTINO anclado a -03:00 (getPeriodRange usa la hora del proceso = UTC en el server).
  const [py, pm] = String(periodKey).split('-').map(Number);
  const fromDate = new Date(`${py}-${String(pm).padStart(2, '0')}-01T00:00:00-03:00`);
  const _ny = pm === 12 ? py + 1 : py; const _nm = pm === 12 ? 1 : pm + 1;
  const toDate = new Date(new Date(`${_ny}-${String(_nm).padStart(2, '0')}-01T00:00:00-03:00`).getTime() - 1000);
  const st = await girox.getPlayerStats(user.username, fromDate, toDate, `ref-${periodKey}`, {});
  if (!st.success) return { success: false, error: `jugaygana.io: ${girox.errToString(st.error)}` };
  const newGgr = Number(_netwinScope() === 'casino' ? st.casinoNetwin : st.netwin) || 0;
  let old = null;
  const migratedAt = user.platformMigratedAt ? new Date(user.platformMigratedAt) : null;
  if (!oldNetwinCut() && jgUserId != null && (!migratedAt || fromDate < migratedAt)) { // #204: desde el corte no se lee la vieja
    old = await referralRevenueService.getUserRevenueForPeriod(jgUsername, periodKey, jgUserId);
    if (!old.success) return old; // con la mitad de los datos no se calcula comisión
  }
  const oldGgr = old ? (Number(old.totalGgr) || 0) : 0;
  return {
    success: true, username: user.username, period: periodKey, currency: 'ARS',
    totalBets: (old ? Number(old.totalBets) || 0 : 0) + (Number(st.wagered) || 0),
    totalWins: (old ? Number(old.totalWins) || 0 : 0) + (Number(st.payout) || 0),
    totalGgr: oldGgr + newGgr,
    providers: old ? (old.providers || []) : [],
    totalOwnerRevenue: old ? (Number(old.totalOwnerRevenue) || 0) : 0,
    individualRevenueFound: true, usedGlobalAggregate: false, revenueScope: 'perUser',
    revenueSourceField: 'partner_stats', commissionCalculationMode: 'individual_revenue',
    platform: 'partner', platformParts: { old: old ? oldGgr : null, partner: newGgr }
  };
}

// ------------------------------------------------------------
// CONTRASEÑA / CASINO
// ------------------------------------------------------------
/** Cambio de clave hecho por un admin: se replica en la plataforma del usuario. */
async function changeUserPasswordAsAdmin(username, newPassword) {
  const route = await routeFor(username);
  if (route.provider === 'partner') {
    const r = await girox.changeUserPassword(username, newPassword);
    if (r.success && route.user) await User.updateOne({ id: route.user.id }, { $set: { partnerPasswordSynced: true } }).catch(() => {});
    return r.success ? { success: true, platform: 'partner' } : { success: false, error: girox.errToString(r.error), platform: 'partner' };
  }
  return jugayganaService.changeUserPasswordAsAdmin(username, newPassword);
}
/**
 * Réplica de la clave real en jugaygana.io, una sola vez por usuario (en un login: es el
 * único momento en que la tenemos en claro). Best-effort, nunca frena el login.
 */
async function syncPartnerPasswordOnLogin(user, plainPassword) {
  try {
    if (!user || user.platform !== 'partner' || user.partnerPasswordSynced === true) return;
    if (!plainPassword || String(plainPassword).length < 6 || !partnerEnabled()) return;
    const r = await girox.changeUserPassword(user.username, plainPassword);
    if (r.success) await User.updateOne({ id: user.id }, { $set: { partnerPasswordSynced: true } });
    else logger.warn(`[platform] réplica de clave de ${user.username} en jugaygana.io falló: ${girox.errToString(r.error)}`);
  } catch (e) { logger.warn(`[platform] réplica de clave excepción: ${e.message}`); }
}
/**
 * Link de entrada directa al casino (un solo uso, vence en 60 s) para un usuario ya mudado.
 * @returns {{success:true, redirectUrl}} | {success:false, notPartner?:true, error}
 */
async function createCasinoSession(username) {
  const route = await routeFor(username);
  if (route.provider !== 'partner') return { success: false, notPartner: true };
  const r = await girox.createSession(username);
  if (!r.success) return { success: false, error: girox.errToString(r.error), code: r.code, playUrl: girox.getPlayUrl() };
  return { success: true, redirectUrl: r.redirectUrl };
}

// ------------------------------------------------------------
// MOTOR DE MUDANZA
// ------------------------------------------------------------
const _appOpenSeen = new Map(); // userId → ts (throttle del disparo por "abrió la app")
setInterval(() => {
  const cut = Date.now() - 5 * APP_OPEN_THROTTLE_MS;
  for (const [k, ts] of _appOpenSeen) if (ts < cut) _appOpenSeen.delete(k);
}, 5 * 60 * 1000).unref();

function _floor2(n) { return Math.floor(Number(n) * 100 + 1e-6) / 100; }
function _money(n) { return '$' + Number(n || 0).toLocaleString('es-AR'); }

/** ¿A este usuario le toca mudarse según la config? (no mira su saldo). */
function _eligible(cfg, user, force) {
  if (!user || user.role !== 'user') return 'no_user';
  if (user.platform === 'partner') return 'already';
  if (!partnerEnabled()) return 'not_configured';
  if (force) return null;
  if (cfg.mode === 'off') return 'off';
  if (cfg.paused) return 'paused';
  if (cfg.mode === 'list' && !cfg.usernames.includes(String(user.username).toLowerCase())) return 'not_listed';
  if (cfg.pausedTeams[teamOfUserDoc(user)]) return 'team_paused';
  return null;
}

async function _mig(userId, set, extra) {
  const upd = { $set: Object.assign({ lockedAt: new Date() }, set || {}) };
  if (extra) Object.assign(upd, extra);
  return PlatformMigration.findOneAndUpdate({ userId }, upd, { new: true });
}
async function _unlockUser(userId) {
  await User.updateOne({ id: userId }, { $set: { platformMigrating: false, platformMigratingAt: null } }).catch(() => {});
}
async function _hold(user, reason, detail, alertText) {
  const prev = await PlatformMigration.findOne({ userId: user.id }).lean();
  const firstTime = !prev || prev.status !== 'held' || prev.reason !== reason;
  await _mig(user.id, { status: 'held', phase: 'check', reason, lastError: detail || null });
  await _unlockUser(user.id);
  if (firstTime && alertText) {
    await PlatformMigration.updateOne({ userId: user.id }, { $set: { alertedAt: new Date() } }).catch(() => {});
    await _alert(alertText);
  }
  return { touched: false, status: 'held', reason };
}
async function _failSoft(user, detail, extraSet) {
  const m = await _mig(user.id, Object.assign({ status: 'failed', phase: 'check', lastError: String(detail || '').slice(0, 300) }, extraSet || {}), { $inc: { attempts: 1 } });
  await _unlockUser(user.id);
  // #201: una mudanza que falla una y otra vez no puede pasar desapercibida.
  if (m && m.attempts === FAILED_ALERT_AFTER) {
    await _alert(`⚠️ La mudanza de @${user.username} ya falló ${m.attempts} veces seguidas (${String(detail || '').slice(0, 200)}). No se movió plata y sigue operando en la plataforma vieja. Se sigue reintentando cada vez más espaciado; mirala en el panel → Mudanza.`);
  }
  return { touched: false, status: 'failed', error: detail };
}
/**
 * #201 Retiro DUDOSO en la vieja: queda en revisión CON candado y el tick lo re-verifica por saldo durante
 * REVIEW_AUTO_MS. Recién si no se puede saber se libera el candado y se avisa a una persona.
 */
async function _toReview(userId, detail) {
  await _mig(userId, { status: 'review', lastError: String(detail || '').slice(0, 300), reviewAutoUntil: new Date(Date.now() + REVIEW_AUTO_MS) });
  await User.updateOne({ id: userId }, { $set: { platformMigrating: true, platformMigratingAt: new Date() } }).catch(() => {});
  return { touched: false, status: 'review' };
}
async function _reviewToHuman(m) {
  await PlatformMigration.updateOne({ userId: m.userId, status: 'review' }, { $set: { reviewAutoUntil: null } });
  await _unlockUser(m.userId);
  const txt = `🛑 MUDANZA de @${m.username} en REVISIÓN: JUGAYGANA no confirmó el retiro de ${_money(m.amount)} para trasladar el saldo y no se pudo verificar solo. NO se cargó nada en jugaygana.io. Mirá en JUGAYGANA si el retiro se hizo y resolvelo en el panel → Mudanza.`;
  await _alert(txt);
  await _note(m.userId, m.username, txt);
}

/**
 * Carga en la nueva el monto ya retirado de la vieja. Idempotente por `reference`:
 * se puede llamar las veces que haga falta. Al entrar, marca al usuario como mudado.
 */
async function _finishDeposit(userId) {
  const m = await PlatformMigration.findOne({ userId });
  if (!m) return { touched: false, status: 'none' };
  if (m.status === 'done') return { touched: true, status: 'done' };
  const amount = Number(m.amount) || 0;
  const reference = m.reference || `vip-mig-${userId}-r${m.round || 1}`;
  // #201: UN solo proceso a la vez hace esta carga (tick de otra instancia + apertura de la app + panel). Sin esto,
  // el que pierde podía pisar con "pendiente" una mudanza que el otro ya había terminado. Claim optimista sobre
  // depositClaimAt, y solo desde un estado donde el retiro en la vieja YA está confirmado.
  const DEPOSIT_CLAIM_STALE_MS = 4 * 60 * 1000;
  if (m.depositClaimAt && (Date.now() - new Date(m.depositClaimAt).getTime()) < DEPOSIT_CLAIM_STALE_MS) return { touched: false, status: 'busy' };
  const claimAt = new Date();
  const mine = await PlatformMigration.findOneAndUpdate(
    { userId, depositClaimAt: m.depositClaimAt || null, $or: [{ status: 'deposit_pending' }, { status: 'running', phase: { $in: ['withdrawn', 'depositing'] } }] },
    { $set: { status: 'running', phase: 'depositing', reference, depositClaimAt: claimAt, lockedAt: new Date() } });
  if (!mine) return { touched: false, status: 'busy' };
  let newTransferId = null;
  if (amount >= MIN_MOVE_ARS) {
    const r = await girox.depositToUser(m.username, amount, 'Saldo trasladado desde la plataforma anterior', reference, { noBonus: true });
    if (!r.success) {
      const err = girox.errToString(r.error);
      const prev = m.status;
      // Solo si la mudanza sigue siendo de ESTE proceso (otro pudo terminarla mientras tanto → no se pisa).
      const still = await PlatformMigration.findOneAndUpdate({ userId, status: 'running', depositClaimAt: claimAt },
        { $set: { status: 'deposit_pending', phase: 'withdrawn', depositClaimAt: null, lockedAt: new Date(), lastError: `${r.code || ''} ${err}`.trim().slice(0, 300) }, $inc: { attempts: 1 } });
      if (!still) return { touched: false, status: 'busy', error: err };
      // El usuario queda con el candado puesto (no opera en ninguna de las dos hasta que entre).
      await User.updateOne({ id: userId }, { $set: { platformMigrating: true, platformMigratingAt: new Date() } }).catch(() => {});
      if (r.code === 'insufficient_funds') {
        // El agente de la plataforma nueva se quedó sin fichas: se frenan las mudanzas nuevas.
        const cfg = await getMigrationConfig({ fresh: true });
        const tm = m.team || DEFAULT_TEAM;
        if (!cfg.pausedTeams[tm]) {
          await saveMigrationConfig({ pausedTeams: Object.assign({}, cfg.pausedTeams, { [tm]: 'Sin fichas suficientes en jugaygana.io' }) }, 'sistema');
          await _alert(`⛔ MUDANZA del equipo ${teamName(tm)} PAUSADA: ese equipo no tiene fichas en jugaygana.io. A @${m.username} se le retiraron ${_money(amount)} de la plataforma vieja y todavía no se le pudieron cargar en la nueva. Cargale fichas al equipo: la carga pendiente entra sola; después reanudá el equipo desde el panel → Mudanza. Los demás equipos siguen.`);
        }
      } else if (prev !== 'deposit_pending') {
        await _alert(`⏳ Mudanza de @${m.username}: se retiraron ${_money(amount)} de la plataforma vieja y la carga en jugaygana.io todavía no entró (${err}). Se reintenta sola con la misma referencia.`);
      }
      return { touched: false, status: 'deposit_pending', error: err };
    }
    newTransferId = (r.data && (r.data.transfer_id || r.data.reference)) || null;
  }
  const now = new Date();
  await User.updateOne({ id: userId }, { $set: { platform: 'partner', platformMigratedAt: now, platformMigrating: false, platformMigratingAt: null, partnerTeam: m.team || DEFAULT_TEAM } });
  _forgetTeam(m.username);
  await _mig(userId, {
    status: 'done', phase: 'done', reason: null, lastError: null, newTransferId, finishedAt: now, depositClaimAt: null, attempts: 0, reviewAutoUntil: null,
    oldRecheckAt: new Date(now.getTime() + RECHECK_DELAYS_MS[0]), oldRecheckCount: 0
  });
  logger.info(`[platform] MUDADO ${m.username} → jugaygana.io | saldo trasladado ${_money(amount)} ref=${reference}`);
  // #198: cerrar la cuenta vieja en segundo plano (no demora el botón del casino ni la carga).
  setImmediate(() => { lockOldAccount(userId).catch((e) => logger.warn(`[platform] cierre de la cuenta vieja de ${m.username}: ${e.message}`)); });
  return { touched: true, status: 'done', amount };
}

// ------------------------------------------------------------
// #198 Cierre de la cuenta vieja (clave al azar en JUGAYGANA)
// ------------------------------------------------------------
const OLD_LOCK_ALERT_AFTER = 6;              // intentos fallidos antes de avisar por Telegram (una vez)
const OLD_LOCK_MAX_ATTEMPTS = 30;            // después de esto deja de intentar solo (queda el botón del panel)
function _oldLockBackoffMs(n) { return Math.min(6 * 60 * 60 * 1000, 2 * 60 * 1000 * Math.pow(2, Math.max(0, n - 1))); }
function _randomOldPassword() {
  // Solo letras y números (no sabemos qué caracteres acepta JUGAYGANA), 20 de largo, con al menos uno de cada.
  const L = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', D = '23456789', A = L + D;
  let p = L[crypto.randomInt(L.length)] + D[crypto.randomInt(D.length)];
  while (p.length < 20) p += A[crypto.randomInt(A.length)];
  return p.split('').sort(() => crypto.randomInt(3) - 1).join('');
}
/**
 * Le pone a la cuenta VIEJA (JUGAYGANA) de un usuario ya mudado una clave al azar que no se guarda.
 * Idempotente a efectos prácticos (cambiarla de nuevo es inocuo). `force` = desde el panel: ignora
 * el interruptor y el tope de intentos.
 * @returns {{ok:true, already?:true} | {ok:false, error, skipped?:true}}
 */
async function lockOldAccount(userId, { force = false, by = null } = {}) {
  const cfg = await getMigrationConfig();
  if (!force && !cfg.lockOldAccount) return { ok: false, skipped: true, error: 'El cierre de la cuenta vieja está apagado.' };
  const m = await PlatformMigration.findOne({ userId }).lean();
  if (!m || m.status !== 'done') return { ok: false, skipped: true, error: 'La mudanza de ese usuario no está terminada.' };
  if (m.oldLocked && !force) return { ok: true, already: true };
  if (!force && (m.oldLockAttempts || 0) >= OLD_LOCK_MAX_ATTEMPTS) return { ok: false, skipped: true, error: 'Demasiados intentos fallidos: usá el botón del panel.' };
  // Claim: un solo proceso por usuario a la vez (multi-instancia) — corre el próximo intento 3 min.
  const now = new Date();
  const claim = await PlatformMigration.findOneAndUpdate(
    force ? { userId } : { userId, oldLocked: { $ne: true }, $or: [{ oldLockNextAt: null }, { oldLockNextAt: { $lte: now } }] },
    { $set: { oldLockNextAt: new Date(now.getTime() + 3 * 60 * 1000) } });
  if (!claim) return { ok: false, skipped: true, error: 'Otro proceso lo está cerrando.' };
  let r;
  try {
    r = await jugayganaService.changeUserPasswordAsAdmin(m.username, _randomOldPassword()); // directo a la VIEJA (plat.* ya rutea a la nueva)
  } catch (e) { r = { success: false, error: e.message }; }
  if (r && r.success) {
    await PlatformMigration.updateOne({ userId }, { $set: { oldLocked: true, oldLockedAt: new Date(), oldLockNextAt: null, oldLockError: null } });
    logger.info(`[platform] cuenta VIEJA de ${m.username} cerrada (clave al azar en JUGAYGANA)${by ? ' por ' + by : ''}`);
    return { ok: true };
  }
  const err = jugaygana.errToString(r && r.error).slice(0, 300) || 'error desconocido';
  const n = (m.oldLockAttempts || 0) + 1;
  await PlatformMigration.updateOne({ userId }, { $set: { oldLockError: err, oldLockAttempts: n, oldLockNextAt: new Date(Date.now() + _oldLockBackoffMs(n)) } });
  logger.warn(`[platform] no se pudo cerrar la cuenta vieja de ${m.username} (intento ${n}): ${err}`);
  if (n === OLD_LOCK_ALERT_AFTER) await _alert(`🔐 No se pudo cerrar la cuenta VIEJA de @${m.username} en JUGAYGANA después de ${n} intentos (${err}). Ya está mudado y con su saldo en jugaygana.io; solo falta cambiarle la clave en la vieja. Se sigue reintentando; también hay un botón en el panel → Mudanza.`);
  return { ok: false, error: err };
}

/**
 * Muda a UN usuario. Devuelve `{ touched, status, ... }`; `touched:true` = ahora opera en la nueva.
 * opts: { trigger, force (admin: saltea modo/lista/pausa/tope y los "held"), by }
 */
async function migrateUser(userId, opts = {}) {
  const force = opts.force === true;
  const cfg = await getMigrationConfig();
  // Atajo barato: con la mudanza apagada y sin force, ni se toca la base.
  if (!force && (cfg.mode === 'off' || cfg.paused || !partnerEnabled())) return { touched: false, status: 'skip' };
  // #201: plataforma fallando → no se arranca nada nuevo (las que ya movieron plata siguen por el tick).
  if (!force && _breakerOpen()) return { touched: false, status: 'skip', reason: 'api_down' };
  // #201: sin la tabla de equipos cargada NO se decide equipo (un "ato…" caería en la key general y quedaría
  // fijado al equipo equivocado). Se intenta cargar; si no se puede, no se muda ahora.
  if (!_teamsLoaded && _hooks.loadTeams) { try { await _hooks.loadTeams(); } catch (_) {} }
  if (!_teamsLoaded && _hooks.loadTeams) return { touched: false, status: 'skip', reason: 'teams_not_loaded' };

  let user = await User.findOne({ id: userId }).select(ROUTE_FIELDS + ' isBlocked').lean();
  const why = _eligible(cfg, user, force);
  if (why === 'already') return { touched: true, status: 'done' };
  if (why) return { touched: false, status: 'skip', reason: why };

  const prev = await PlatformMigration.findOne({ userId }).lean();
  if (prev) {
    const age = Date.now() - new Date(prev.updatedAt || 0).getTime();
    if (prev.status === 'done') return { touched: true, status: 'done' };
    if (prev.status === 'review') return { touched: false, status: 'review' };
    if (prev.status === 'deposit_pending') return _finishDeposit(userId);
    if (prev.status === 'held' && !force) {
      const autoRetry = prev.reason === 'not_in_new' || prev.reason === 'cap' || prev.reason === 'team_no_key';
      if (!autoRetry || age < HELD_RETRY_MS) return { touched: false, status: 'held', reason: prev.reason };
    }
    if (prev.status === 'failed' && !force && age < _failedWaitMs(prev.attempts)) return { touched: false, status: 'failed' };
    if (prev.status === 'running' && prev.lockedAt && (Date.now() - new Date(prev.lockedAt).getTime()) < LOCK_STALE_MS) {
      return { touched: false, status: 'busy' };
    }
    if (prev.status === 'running') return _recoverStale(prev);
  }

  if (!isValidPartnerUsername(user.username)) {
    await PlatformMigration.updateOne({ userId }, { $setOnInsert: { id: uuidv4(), userId, username: user.username, startedAt: new Date() } }, { upsert: true });
    return _hold(user, 'invalid_username', 'El username no cumple la regla de jugaygana.io (3 a 18 caracteres, solo letras, números y guion bajo)', null);
  }

  // Equipo (API key) con el que se crea / opera este usuario en la nueva.
  const team = teamOfUserDoc(user);
  if (team !== DEFAULT_TEAM && !(getTeam(team) && getTeam(team).key)) {
    await PlatformMigration.updateOne({ userId }, { $setOnInsert: { id: uuidv4(), userId, username: user.username, startedAt: new Date() } }, { upsert: true });
    await _mig(userId, { team });
    return _hold(user, 'team_no_key', `El equipo ${teamName(team)} no tiene API key cargada`,
      `🔑 Mudanza de @${user.username} FRENADA: es del equipo ${teamName(team)} y ese equipo no tiene API key cargada. Cargala en el panel → Mudanza.`);
  }

  // 1) Candado atómico: una sola instancia muda a este usuario.
  const staleBefore = new Date(Date.now() - LOCK_STALE_MS);
  const claimed = await User.findOneAndUpdate(
    { id: userId, platform: { $ne: 'partner' }, $or: [{ platformMigrating: { $ne: true } }, { platformMigratingAt: { $lt: staleBefore } }] },
    { $set: { platformMigrating: true, platformMigratingAt: new Date() } },
    { new: true }
  ).select(ROUTE_FIELDS).lean();
  if (!claimed) return { touched: false, status: 'busy' };
  user = claimed;

  try {
    await PlatformMigration.updateOne({ userId }, {
      $setOnInsert: { id: uuidv4(), userId, username: user.username, startedAt: new Date() }
    }, { upsert: true });
    await _mig(userId, { status: 'running', phase: 'check', reason: null, trigger: opts.trigger || null, by: opts.by || null, username: user.username, team });

    // 2) ¿Existe en la plataforma nueva?
    const lk = await girox.lookupPlayer(user.username);
    if (lk.state === 'error') { _apiFail('jugaygana.io'); return await _failSoft(user, `jugaygana.io no respondió al buscar al jugador: ${girox.errToString(lk.error)}`); }
    _apiOk();
    let newBalance = 0;
    if (lk.state === 'not_found') {
      if (!cfg.createMissing && !force) {
        return await _hold(user, 'not_in_new', 'Todavía no existe en jugaygana.io (¿falta copiarlo?)', null);
      }
      // Se crea en SU equipo (la key la elige keyResolver por el inicio del username), con una
      // clave provisoria: la real se replica en su próximo inicio de sesión y entra por el botón.
      const pass = 'M' + uuidv4().replace(/-/g, '').slice(0, 14);
      const cr = await girox.createPlatformUser({ username: user.username, password: pass });
      if (!cr.success) {
        if (cr.alreadyExists) {
          return await _hold(user, 'foreign', `El nombre ya existe en jugaygana.io fuera del equipo ${teamName(team)}: esa key no lo ve`,
            `🧭 Mudanza de @${user.username} FRENADA: ese nombre ya existe en jugaygana.io pero fuera del equipo ${teamName(team)} (esa key no lo ve). Revisá a qué equipo pertenece o movelo desde el panel de la plataforma.`);
        }
        return await _failSoft(user, `No se pudo crear en jugaygana.io: ${girox.errToString(cr.error)}`);
      }
    } else {
      newBalance = Number(lk.player.balance) || 0;
      if (newBalance >= MIN_MOVE_ARS && !force) {
        await _mig(userId, { newBalanceBefore: newBalance });
        return await _hold(user, 'new_has_balance', `Ya tiene ${_money(newBalance)} en jugaygana.io`,
          `⚠️ Mudanza de @${user.username} FRENADA: ya tiene ${_money(newBalance)} en jugaygana.io antes de mudarse (¿la copia vino con saldo?). No se movió nada. Revisalo en el panel → Mudanza.`);
      }
    }
    await _mig(userId, { newBalanceBefore: newBalance });
    // El jugador existe en la nueva bajo ESTE equipo: queda fijo (aunque después cambie la tabla de inicios).
    if (user.partnerTeam !== team) { await User.updateOne({ id: userId }, { $set: { partnerTeam: team } }); _forgetTeam(user.username); }

    // 3) Saldo en la vieja.
    const bal = await jugayganaMovements.getUserBalanceWithRetry(user.username);
    if (!bal || !bal.success) { _apiFail('JUGAYGANA'); return await _failSoft(user, `JUGAYGANA no respondió al leer el saldo: ${jugaygana.errToString(bal && bal.error)}`); }
    const oldBalance = Number(bal.balance) || 0;
    const amount = _floor2(oldBalance);
    // #201: el intento anterior terminó con la vieja "rechazando" el retiro. Si ahora el saldo bajó justo ese
    // monto, ese retiro en realidad SE HIZO: no se muda "lo que queda" (se perdería lo retirado) → revisión.
    if (prev && Number(prev.wdFailAmount) >= MIN_MOVE_ARS) {
      if (oldBalance <= Number(prev.wdFailBalance) - Number(prev.wdFailAmount) + 1) {
        await _mig(userId, { phase: 'withdrawing', oldBalance: Number(prev.wdFailBalance), amount: Number(prev.wdFailAmount), reference: `vip-mig-${userId}-r${prev.round || 1}`, wdFailBalance: 0, wdFailAmount: 0 });
        return await _toReview(userId, `El retiro anterior de ${_money(prev.wdFailAmount)} figuraba rechazado pero el saldo de la vieja bajó de ${_money(prev.wdFailBalance)} a ${_money(oldBalance)}`);
      }
      await _mig(userId, { wdFailBalance: 0, wdFailAmount: 0 });
    }
    if (amount > cfg.capARS && !force) {
      await _mig(userId, { oldBalance });
      return await _hold(user, 'cap', `Saldo ${_money(amount)} mayor al tope ${_money(cfg.capARS)}`,
        `🔐 Mudanza de @${user.username} espera tu aprobación: tiene ${_money(amount)} (tope ${_money(cfg.capARS)}). Aprobala en el panel → Mudanza.`);
    }

    // 4) Retirar TODO de la vieja (si hay algo que mover).
    const round = (prev && prev.round) || 1;
    const reference = `vip-mig-${userId}-r${round}`;
    if (amount >= MIN_MOVE_ARS) {
      // El estado 'withdrawing' se persiste ANTES de llamar: si el proceso muere acá, la
      // mudanza queda para revisión humana (nunca se reintenta sola un retiro dudoso).
      await _mig(userId, { phase: 'withdrawing', oldBalance, amount, reference });
      const w = await jugaygana.withdrawFromUser(user.username, amount, 'Traslado de saldo a jugaygana.io', user.jugayganaUserId || null);
      if (!w || !w.success) {
        if (w && w.ambiguous) return await _toReview(userId, jugaygana.errToString(w.error));
        return await _failSoft(user, `JUGAYGANA rechazó el retiro: ${jugaygana.errToString(w && w.error)}`, { wdFailBalance: oldBalance, wdFailAmount: amount });
      }
      await _mig(userId, { phase: 'withdrawn', withdrawnAt: new Date(), oldTransferId: String((w.data && (w.data.transfer_id || w.data.transferId)) || '') || null });
    } else {
      await _mig(userId, { phase: 'withdrawn', oldBalance, amount: 0, reference, withdrawnAt: new Date() });
    }

    // 5) y 6) Cargar en la nueva y marcar al usuario.
    return await _finishDeposit(userId);
  } catch (e) {
    logger.error(`[platform] migrateUser(${user && user.username}) excepción: ${e.message}`);
    // Qué hacer con el candado depende de hasta dónde llegó.
    const cur = await PlatformMigration.findOne({ userId }).lean().catch(() => null);
    if (cur && cur.status === 'running') {
      try { return await _recoverStale(cur, e.message); }
      catch (e2) { logger.error(`[platform] no se pudo recuperar la mudanza de ${user && user.username}: ${e2.message} — queda con candado, la retoma el tick`); return { touched: false, status: 'busy', error: e.message }; }
    }
    // #201: el candado SOLO se suelta si es seguro (no se movió plata). Con la plata en tránsito
    // (deposit_pending / review) o sin poder leer el estado, el candado queda: lo resuelve el tick.
    if (cur && (cur.status === 'failed' || cur.status === 'held')) await _unlockUser(userId);
    else if (cur && cur.status !== 'deposit_pending' && cur.status !== 'review' && cur.phase === 'check') await _unlockUser(userId);
    return { touched: false, status: cur ? cur.status : 'busy', error: e.message };
  }
}

/** Una mudanza "running" sin dueño (proceso muerto / excepción): decidir según la fase. */
async function _recoverStale(m, detail) {
  if (m.phase === 'withdrawn' || m.phase === 'depositing') {
    await _mig(m.userId, { status: 'deposit_pending', phase: 'withdrawn', lastError: detail || 'se retomó una mudanza interrumpida' });
    await User.updateOne({ id: m.userId }, { $set: { platformMigrating: true, platformMigratingAt: new Date() } }).catch(() => {});
    return _finishDeposit(m.userId);
  }
  if (m.phase === 'withdrawing') return _toReview(m.userId, detail || 'el proceso se interrumpió mientras retiraba en JUGAYGANA');
  await _mig(m.userId, { status: 'failed', phase: 'check', lastError: detail || 'mudanza interrumpida antes de mover plata' });
  await _unlockUser(m.userId);
  return { touched: false, status: 'failed' };
}

/** Disparo "abrió la app": en segundo plano, con throttle por usuario. Nunca tira. */
function migrateInBackground(userId, trigger = 'app_open') {
  try {
    if (!userId) return;
    const last = _appOpenSeen.get(userId) || 0;
    if (Date.now() - last < APP_OPEN_THROTTLE_MS) return;
    if (_bgRunning >= BG_MAX_CONCURRENT) return; // cupo lleno: se muda en su próxima apertura / carga / toque del casino
    _appOpenSeen.set(userId, Date.now());
    if (_appOpenSeen.size > 50000) _appOpenSeen.clear();
    _bgRunning++;
    migrateUser(userId, { trigger })
      .catch((e) => logger.warn(`[platform] mudanza en segundo plano de ${userId} falló: ${e.message}`))
      .finally(() => { _bgRunning = Math.max(0, _bgRunning - 1); });
  } catch (_) {}
}

/** ¿A este usuario le toca mudarse ahora según la config? (para que la PWA sepa si el botón del casino tiene que esperar). */
async function wouldMigrate(user) {
  try { return _eligible(await getMigrationConfig(), user, false) === null; } catch (_) { return false; }
}
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Botón del casino: muda al usuario si le toca y ESPERA a que termine (hasta ~20 s), para no
 * abrirle la plataforma vieja con el saldo ya retirado.
 * @returns {{partner:boolean, pending:boolean}}  pending = su cuenta todavía se está actualizando
 */
async function prepareCasino(userId) {
  try { await migrateUser(userId, { trigger: 'casino' }); } catch (e) { logger.warn(`[platform] mudanza al abrir el casino falló: ${e.message}`); }
  let u = null;
  try {
    for (let i = 0; i < 12; i++) {
      u = await User.findOne({ id: userId }).select(ROUTE_FIELDS).lean();
      if (!u || u.platform === 'partner' || u.platformMigrating !== true) break;
      await _sleep(1500);
    }
  } catch (e) {
    // #200: sin poder leer la base no se sabe en qué plataforma está → no se abre ninguna.
    logger.warn(`[platform] prepareCasino de ${userId}: ${e.message}`);
    return { partner: false, pending: false, error: true };
  }
  if (!u) return { partner: false, pending: false, error: true };
  return { partner: u.platform === 'partner', pending: u.platform !== 'partner' && u.platformMigrating === true };
}
/**
 * Login: muda al usuario si le toca y, ya mudado, replica su clave real en jugaygana.io
 * (el login es el único momento en que la tenemos en claro). En segundo plano, nunca tira.
 */
function migrateThenSyncPassword(userId, plainPassword) {
  (async () => {
    try {
      if (_bgRunning < BG_MAX_CONCURRENT) {
        _bgRunning++;
        try { await migrateUser(userId, { trigger: 'app_open' }); } finally { _bgRunning = Math.max(0, _bgRunning - 1); }
      }
      const u = await User.findOne({ id: userId }).select('id username platform partnerPasswordSynced').lean();
      if (u) await syncPartnerPasswordOnLogin(u, plainPassword);
    } catch (e) { logger.warn(`[platform] mudanza + clave en el login de ${userId}: ${e.message}`); }
  })();
}

/**
 * Un admin resuelve una mudanza en REVISIÓN diciendo qué pasó con el retiro en la vieja.
 *   withdrawn:true  → el retiro SÍ se hizo: se carga ese monto en la nueva y se muda.
 *   withdrawn:false → NO se hizo: vuelve a "failed" (se reintenta sola más tarde).
 */
async function resolveReview(userId, { withdrawn, by } = {}) {
  const m = await PlatformMigration.findOne({ userId }).lean();
  if (!m || m.status !== 'review') return { ok: false, error: 'Esa mudanza no está en revisión.' };
  if (withdrawn === true) {
    const claimed = await PlatformMigration.findOneAndUpdate({ userId, status: 'review' },
      { $set: { status: 'deposit_pending', phase: 'withdrawn', by: by || null, withdrawnAt: new Date(), lockedAt: new Date(), reviewAutoUntil: null } }, { new: true });
    if (!claimed) return { ok: false, error: 'Otro proceso ya la tomó.' };
    await User.updateOne({ id: userId }, { $set: { platformMigrating: true, platformMigratingAt: new Date() } });
    const r = await _finishDeposit(userId);
    return { ok: true, result: r };
  }
  await PlatformMigration.updateOne({ userId, status: 'review' }, { $set: { status: 'failed', phase: 'check', by: by || null, reviewAutoUntil: null, lastError: 'Revisión: el retiro en JUGAYGANA NO se había hecho' } });
  await _unlockUser(userId);
  return { ok: true, result: { status: 'failed' } };
}

/** Tick periódico (cada instancia): reintenta cargas pendientes, destraba colgadas, revisa residuos. */
let _tickRunning = false;
async function migrationTick() {
  if (_tickRunning || !partnerEnabled()) return;
  _tickRunning = true;
  try {
    const now = Date.now();
    // #201: presupuesto de tiempo por vuelta. Con jugaygana.io caída cada carga pendiente puede tardar más de un
    // minuto en fallar: sin tope, una vuelta duraba media hora y frenaba todo lo demás (colgadas, residuos, cierres).
    const over = () => (Date.now() - now) > 45000;

    // b0) Retiros DUDOSOS en ventana de verificación automática (usuario con candado): se mira el saldo de la vieja.
    //     Saldo intacto = el retiro no se hizo → la mudanza se cancela sola y se reintenta en su próxima entrada.
    //     Si cambió (o no se puede leer) hasta el final de la ventana → se suelta el candado y lo define una persona.
    const rv = await PlatformMigration.find({ status: 'review', reviewAutoUntil: { $ne: null } }).sort({ lockedAt: 1 }).limit(20).lean();
    for (const m of rv) {
      if (over()) break;
      const c = await PlatformMigration.findOneAndUpdate({ userId: m.userId, status: 'review', lockedAt: m.lockedAt || null }, { $set: { lockedAt: new Date() } });
      if (!c) continue;
      const b = await jugayganaMovements.getUserBalance(m.username).catch(() => null);
      if (b && b.success && Math.abs(Number(b.balance) - Number(m.oldBalance)) <= 0.01) {
        const done = await PlatformMigration.findOneAndUpdate({ userId: m.userId, status: 'review' },
          { $set: { status: 'failed', phase: 'check', reviewAutoUntil: null, lastError: 'Verificado solo: el retiro en JUGAYGANA no se había hecho (saldo intacto). Se reintenta en su próxima entrada.' } });
        if (done) { await _unlockUser(m.userId); logger.info(`[platform] retiro dudoso de ${m.username} verificado: NO se hizo → mudanza cancelada, se reintenta`); }
      } else if (new Date(m.reviewAutoUntil).getTime() <= Date.now()) {
        await _reviewToHuman(m);
      }
    }
    // a) Cargas pendientes en la nueva: reintento idempotente (claim por lockedAt para no pisarse).
    const pend = await PlatformMigration.find({ status: 'deposit_pending', $or: [{ lockedAt: null }, { lockedAt: { $lt: new Date(now - 45000) } }] }).sort({ lockedAt: 1 }).limit(20).lean();
    for (const m of pend) {
      if (over()) break;
      const c = await PlatformMigration.findOneAndUpdate(
        { userId: m.userId, status: 'deposit_pending', $or: [{ lockedAt: null }, { lockedAt: { $lt: new Date(now - 45000) } }] },
        { $set: { lockedAt: new Date() } });
      if (c) await _finishDeposit(m.userId).catch((e) => logger.warn(`[platform] reintento de carga de ${m.username}: ${e.message}`));
    }
    // b) Mudanzas colgadas.
    const stale = await PlatformMigration.find({ status: 'running', lockedAt: { $lt: new Date(now - LOCK_STALE_MS) } }).sort({ lockedAt: 1 }).limit(20).lean();
    for (const m of stale) {
      if (over()) break;
      const c = await PlatformMigration.findOneAndUpdate({ userId: m.userId, status: 'running', lockedAt: m.lockedAt }, { $set: { lockedAt: new Date() } });
      if (c) await _recoverStale(m).catch(() => {});
    }
    // c) Plata que aparece en la vieja después de mudarse (apuesta que pagó tarde, carga que entró en el medio).
    //    #201: 5 revisiones (10 min, 1 h, 1 día, 1 semana, 1 mes) y el traslado es AUTOMÁTICO (mismo cuidado que la mudanza);
    //    por encima del tope queda para aprobar a mano.
    const rc = await PlatformMigration.find({ status: 'done', oldRecheckAt: { $ne: null, $lte: new Date(now) } }).sort({ oldRecheckAt: 1 }).limit(10).lean();
    for (const m of rc) {
      if (over()) break;
      const n = (m.oldRecheckCount || 0) + 1;
      const next = n >= RECHECK_DELAYS_MS.length ? null : new Date(now + RECHECK_DELAYS_MS[n]);
      const c = await PlatformMigration.findOneAndUpdate({ userId: m.userId, oldRecheckAt: m.oldRecheckAt }, { $set: { oldRecheckAt: next, oldRecheckCount: n } });
      if (!c) continue;
      const b = await jugayganaMovements.getUserBalance(m.username).catch(() => null);
      if (b && b.success && Number(b.balance) >= MIN_MOVE_ARS) {
        await PlatformMigration.updateOne({ userId: m.userId }, { $set: { oldResidual: Number(b.balance) } });
        const cfgR = await getMigrationConfig();
        if (Number(b.balance) > cfgR.capARS) {
          await _alert(`💸 @${m.username} ya está en jugaygana.io pero le aparecieron ${_money(b.balance)} en la plataforma vieja (más que el tope). Pasáselos desde el panel → Mudanza.`);
        } else {
          const mv = await moveOldResidual(m.userId, 'auto').catch((e) => ({ ok: false, error: e.message }));
          if (mv.ok && mv.amount) logger.info(`[platform] residuo de ${m.username} trasladado solo: ${_money(mv.amount)}`);
          else if (!mv.ok && !mv.ambiguous && !mv.pendingDeposit) await _alert(`💸 @${m.username} ya está en jugaygana.io y le aparecieron ${_money(b.balance)} en la plataforma vieja; no se pudieron pasar solos (${mv.error}). Pasáselos desde el panel → Mudanza.`);
        }
      } else if (b && b.success && m.oldResidual) {
        await PlatformMigration.updateOne({ userId: m.userId }, { $set: { oldResidual: 0 } });
      } else if ((!b || !b.success) && next === null) {
        // La última revisión no pudo leer el saldo: se reprograma (no se da por revisado sin haber mirado).
        await PlatformMigration.updateOne({ userId: m.userId }, { $set: { oldRecheckAt: new Date(now + 60 * 60 * 1000), oldRecheckCount: RECHECK_DELAYS_MS.length - 1 } });
      }
    }
    // c2) Residuos retirados de la vieja cuya carga en la nueva todavía no entró: reintento con la MISMA reference.
    const rp = await PlatformMigration.find({ status: 'done', residualPhase: 'withdrawn', residualAt: { $lt: new Date(now - 45000) } }).limit(10).lean();
    for (const m of rp) {
      const c = await PlatformMigration.findOneAndUpdate({ userId: m.userId, residualPhase: 'withdrawn', residualAt: m.residualAt }, { $set: { residualAt: new Date() } });
      if (c) await _finishResidual(m.userId).catch((e) => logger.warn(`[platform] reintento de residuo de ${m.username}: ${e.message}`));
    }
    // c3) Retiro de residuo colgado (el proceso murió mientras retiraba): no se sabe si se hizo → aviso, una vez.
    const rs = await PlatformMigration.find({ status: 'done', residualPhase: 'withdrawing', residualAlertedAt: null, residualAt: { $lt: new Date(now - LOCK_STALE_MS) } }).limit(5).lean();
    for (const m of rs) {
      const c = await PlatformMigration.findOneAndUpdate({ userId: m.userId, residualPhase: 'withdrawing', residualAlertedAt: null }, { $set: { residualAlertedAt: new Date() } });
      if (c) await _alert(`🛑 Residuo de @${m.username}: el traslado de ${_money(m.residualAmount)} desde la plataforma vieja quedó a medias (no se sabe si el retiro se hizo). NO se cargó nada en jugaygana.io. Verificá en JUGAYGANA; si el retiro SÍ se hizo, cargale ${_money(m.residualAmount)} en jugaygana.io con la referencia ${m.residualRef}.`);
    }
    // d) #198: cuentas viejas de usuarios ya mudados que todavía no se cerraron (incluye los mudados
    //    antes de existir esto, o con el interruptor apagado en su momento). El claim va en lockOldAccount.
    const cfgNow = await getMigrationConfig();
    if (cfgNow.lockOldAccount) {
      const toLock = await PlatformMigration.find({
        status: 'done', oldLocked: { $ne: true }, oldLockAttempts: { $not: { $gte: OLD_LOCK_MAX_ATTEMPTS } },
        $or: [{ oldLockNextAt: null }, { oldLockNextAt: { $lte: new Date(now) } }]
      }).select('userId').limit(3).lean();
      for (const m of toLock) if (!over()) await lockOldAccount(m.userId).catch((e) => logger.warn(`[platform] cierre de cuenta vieja: ${e.message}`));
    }
  } catch (e) {
    logger.warn(`[platform] tick de mudanza: ${e.message}`);
  } finally { _tickRunning = false; }
}

/**
 * Traslada a la nueva la plata que le quedó/apareció en la vieja a un usuario YA mudado.
 * Mismo cuidado que la mudanza: retiro confirmado en la vieja → carga con reference propia.
 */
async function moveOldResidual(userId, by) {
  const user = await User.findOne({ id: userId }).select(ROUTE_FIELDS).lean();
  if (!user || user.platform !== 'partner') return { ok: false, error: 'El usuario no está mudado.' };
  const m = await PlatformMigration.findOne({ userId }).lean();
  if (!m || m.status !== 'done') return { ok: false, error: 'La mudanza de ese usuario no está terminada.' };
  // Un traslado anterior quedó retirado y sin cargar: se termina ese (misma reference) antes de mover nada más.
  if (m.residualPhase === 'withdrawn') return _finishResidual(userId);
  if (m.residualPhase === 'claiming') { // todavía no se movió nada
    if (Date.now() - new Date(m.residualAt || 0).getTime() < 3 * 60 * 1000) return { ok: false, error: 'Ya hay un traslado en curso para este usuario.' };
    await PlatformMigration.updateOne({ userId, residualPhase: 'claiming', residualAt: m.residualAt }, { $set: { residualPhase: null, residualAt: null } });
  }
  if (m.residualPhase === 'withdrawing') {
    if (Date.now() - new Date(m.residualAt || 0).getTime() < LOCK_STALE_MS) return { ok: false, error: 'Ya hay un traslado en curso para este usuario.' };
    return { ok: false, ambiguous: true, error: `Un traslado anterior de ${_money(m.residualAmount)} quedó a medias (no se sabe si el retiro en JUGAYGANA se hizo). Verificá a mano; referencia ${m.residualRef}.` };
  }
  // Claim atómico ANTES de leer el saldo y de armar la reference (dos procesos a la vez —tick + botón del panel—
  // no pueden calcular la misma reference con datos viejos: el segundo retiro se perdería como "duplicado").
  const claim = await PlatformMigration.findOneAndUpdate(
    { userId, status: 'done', residualPhase: null },
    { $set: { residualPhase: 'claiming', residualAmount: 0, residualRef: null, residualAt: new Date(), residualAlertedAt: null, by: by || null } }, { new: true });
  if (!claim) return { ok: false, error: 'Otro proceso ya está trasladando ese saldo.' };
  const release = () => PlatformMigration.updateOne({ userId, residualPhase: 'claiming' }, { $set: { residualPhase: null, residualAt: null } }).catch(() => {});
  let bal;
  try { bal = await jugayganaMovements.getUserBalanceWithRetry(user.username); } catch (e) { bal = null; }
  if (!bal || !bal.success) { await release(); return { ok: false, error: 'JUGAYGANA no respondió al leer el saldo.' }; }
  const amount = _floor2(bal.balance);
  if (amount < MIN_MOVE_ARS) { await PlatformMigration.updateOne({ userId, residualPhase: 'claiming' }, { $set: { residualPhase: null, residualAt: null, oldResidual: 0 } }); return { ok: true, amount: 0 }; }
  const round = (claim.round || 1) + 1; // del documento ya reclamado, no de una lectura anterior
  const reference = `vip-mig-${userId}-r${round}`;
  // Estado persistido ANTES de retirar (proceso que muere en el medio → revisión, nunca reintento a ciegas).
  await PlatformMigration.updateOne({ userId, residualPhase: 'claiming' }, { $set: { residualPhase: 'withdrawing', residualAmount: amount, residualRef: reference, residualAt: new Date() } });
  let w;
  try { w = await jugaygana.withdrawFromUser(user.username, amount, 'Traslado de saldo residual a jugaygana.io', user.jugayganaUserId || null); }
  catch (e) { w = { success: false, ambiguous: true, error: e.message }; } // excepción a mitad del retiro = no se sabe
  if (!w || !w.success) {
    if (w && w.ambiguous) {
      await PlatformMigration.updateOne({ userId }, { $set: { residualAlertedAt: new Date() } });
      await _alert(`🛑 Residuo de @${user.username}: JUGAYGANA no confirmó el retiro de ${_money(amount)}. NO se cargó nada en jugaygana.io. Verificá a mano; si el retiro SÍ se hizo, cargale ese monto en jugaygana.io con la referencia ${reference}.`);
      return { ok: false, ambiguous: true, error: 'JUGAYGANA no confirmó el retiro. Verificá a mano antes de repetir.' };
    }
    await PlatformMigration.updateOne({ userId }, { $set: { residualPhase: null, residualAmount: 0, residualRef: null } });
    return { ok: false, error: `JUGAYGANA rechazó el retiro: ${jugaygana.errToString(w && w.error)}` };
  }
  await PlatformMigration.updateOne({ userId }, { $set: { residualPhase: 'withdrawn', residualAt: new Date(), round, oldResidual: 0 } });
  return _finishResidual(userId);
}
/** Carga en la nueva un residuo ya retirado de la vieja. Idempotente por `residualRef`. */
async function _finishResidual(userId) {
  const m = await PlatformMigration.findOne({ userId }).lean();
  if (!m || m.residualPhase !== 'withdrawn') return { ok: false, error: 'No hay un residuo pendiente de cargar.' };
  const amount = Number(m.residualAmount) || 0, reference = m.residualRef;
  const r = await girox.depositToUser(m.username, amount, 'Saldo residual trasladado desde la plataforma anterior', reference, { noBonus: true });
  if (!r.success) {
    const err = girox.errToString(r.error);
    if (!m.residualAlertedAt) {
      await PlatformMigration.updateOne({ userId }, { $set: { residualAlertedAt: new Date() } });
      await _alert(`⏳ Residuo de @${m.username}: se retiraron ${_money(amount)} de la vieja y la carga en jugaygana.io todavía no entró (${err}). Se reintenta sola con la misma referencia (${reference}).`);
    }
    return { ok: false, pendingDeposit: true, reference, amount, error: `Se retiró de la vieja y la carga en la nueva todavía no entró (${err}). Se reintenta sola.` };
  }
  // Solo se limpia si sigue siendo ESTE residuo (otro proceso pudo terminarlo: la plataforma devuelve duplicate).
  const done = await PlatformMigration.findOneAndUpdate({ userId, residualPhase: 'withdrawn', residualRef: reference },
    { $set: { residualPhase: null, residualAmount: 0, residualAt: null, residualAlertedAt: null }, $inc: { residualMoved: amount } });
  if (done) logger.info(`[platform] residuo de ${m.username} cargado en jugaygana.io: ${_money(amount)} ref=${reference}`);
  return { ok: true, amount, reference };
}
/** Reintento de la carga de un residuo que quedó retirado y sin cargar (misma reference). */
async function retryResidualDeposit(userId, amount, reference) {
  const user = await User.findOne({ id: userId }).select(ROUTE_FIELDS).lean();
  if (!user || user.platform !== 'partner') return { ok: false, error: 'El usuario no está mudado.' };
  if (!/^vip-mig-/.test(String(reference || '')) || !String(reference).includes(userId)) return { ok: false, error: 'Referencia inválida.' };
  const r = await girox.depositToUser(user.username, amount, 'Saldo residual trasladado desde la plataforma anterior', reference, { noBonus: true });
  if (r.success) await PlatformMigration.updateOne({ userId, residualRef: reference }, { $set: { residualPhase: null, residualAmount: 0, residualAt: null, residualAlertedAt: null } }).catch(() => {});
  return r.success ? { ok: true, duplicate: !!r.duplicate } : { ok: false, error: girox.errToString(r.error) };
}
/**
 * #201 Un traslado de residuo quedó a medias ('withdrawing': no se sabe si el retiro en la vieja se hizo).
 * Lo resuelve una persona después de mirar JUGAYGANA: withdrawn=true → se carga en la nueva (misma reference);
 * false → no se movió nada, se libera para poder repetirlo.
 */
async function resolveResidual(userId, { withdrawn, by } = {}) {
  const m = await PlatformMigration.findOne({ userId }).lean();
  if (!m || m.status !== 'done' || m.residualPhase !== 'withdrawing') return { ok: false, error: 'Ese usuario no tiene un traslado de residuo a medias.' };
  if (withdrawn === true) {
    const c = await PlatformMigration.findOneAndUpdate({ userId, residualPhase: 'withdrawing' },
      { $set: { residualPhase: 'withdrawn', residualAt: new Date(), residualAlertedAt: null, oldResidual: 0, by: by || null }, $inc: { round: 1 } });
    if (!c) return { ok: false, error: 'Otro proceso ya lo resolvió.' };
    return _finishResidual(userId);
  }
  await PlatformMigration.updateOne({ userId, residualPhase: 'withdrawing' }, { $set: { residualPhase: null, residualAmount: 0, residualRef: null, residualAt: null, residualAlertedAt: null, by: by || null } });
  return { ok: true, amount: 0, released: true };
}

// ------------------------------------------------------------
// Vistas para el panel
// ------------------------------------------------------------
async function migrationStats() {
  const [byStatus, heldByReason, totalUsers, migratedUsers, moved, byTeamRows] = await Promise.all([
    PlatformMigration.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    PlatformMigration.aggregate([{ $match: { status: 'held' } }, { $group: { _id: '$reason', n: { $sum: 1 } } }]),
    User.countDocuments({ role: 'user' }),
    User.countDocuments({ role: 'user', platform: 'partner' }),
    PlatformMigration.aggregate([{ $match: { status: 'done' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    User.aggregate([{ $match: { role: 'user', platform: 'partner' } }, { $group: { _id: '$partnerTeam', n: { $sum: 1 } } }])
  ]);
  const byTeam = {}; for (const r of byTeamRows) byTeam[r._id || DEFAULT_TEAM] = (byTeam[r._id || DEFAULT_TEAM] || 0) + r.n;
  const st = {}; for (const r of byStatus) st[r._id] = r.n;
  const held = {}; for (const r of heldByReason) held[r._id || 'otro'] = r.n;
  return { totalUsers, migratedUsers, pendingUsers: Math.max(0, totalUsers - migratedUsers), byStatus: st, heldByReason: held, byTeam, movedARS: (moved[0] && moved[0].total) || 0 };
}
async function listMigrations({ status, q, limit = 100 } = {}) {
  const f = {};
  if (status) f.status = status;
  if (q) f.username = new RegExp('^' + String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return PlatformMigration.find(f).sort({ updatedAt: -1 }).limit(Math.min(500, Math.max(1, Number(limit) || 100))).lean();
}

module.exports = {
  setHooks,
  // equipos
  setTeams, getTeam, teamName, teamForUsername, teamOfUserDoc, keyResolver, DEFAULT_TEAM,
  wouldMigrate, prepareCasino, migrateThenSyncPassword,
  // config
  getMigrationConfig, saveMigrationConfig, partnerEnabled, isValidPartnerUsername, DEFAULT_CFG,
  // ruteo
  routeFor, providerOf,
  // plata
  depositToUser, withdrawFromUser, creditUserBalance, makeBonus,
  // saldo
  getUserBalance, getUserBalanceWithRetry, withdrawable, getUserMovements,
  // netwin
  getUserNetwinForDateRange, getUserRevenueForPeriod, oldNetwinCut, OLD_NETWIN_CUTOFF_MS,
  // clave / casino
  changeUserPasswordAsAdmin, syncPartnerPasswordOnLogin, createCasinoSession,
  // mudanza
  migrateUser, migrateInBackground, resolveReview, migrationTick, moveOldResidual, retryResidualDeposit, resolveResidual, lockOldAccount,
  migrationStats, listMigrations,
  MIGRATING_MSG
};
