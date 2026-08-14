// ⚠️ ARCHIVO EN PROCESO DE MIGRACIÓN
// La arquitectura modular refactorizada está en server-new.js + /src/
// Este archivo se mantiene como entry point principal hasta completar la migración.
// NO agregar funcionalidad nueva aquí — usar /src/controllers/ y /src/routes/

// Cargar .env primero (Render / dev local). En AWS EB con SSM_PATH, las vars
// sensibles se cargarán desde Parameter Store en el bootstrap async de abajo.
require('dotenv').config();

const { loadSecretsFromSSM } = require('./src/config/loadSecrets');

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const winston = require('winston');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');

// ============================================
// LOGGER (Winston)
// ============================================
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// ============================================
// IMPORTAR MODELOS DE MONGODB
// ============================================
const {
  connectDB,
  User,
  Message,
  Command,
  Config,
  RefundClaim,
  FireStreak,
  ChatStatus,
  Transaction,
  ExternalUser,
  UserActivity,
  getConfig,
  setConfig,
  getAllCommands,
  saveCommand,
  deleteCommand,
  incrementCommandUsage
} = require('./config/database');

// Importar modelos de referidos (usados por el handler de registro inline)
const ReferralEvent = require('./src/models/ReferralEvent');
const Campaign = require('./src/models/Campaign');
const CampaignClick = require('./src/models/CampaignClick');
const InfluencerStory = require('./src/models/InfluencerStory');
const ChatDelay = require('./src/models/ChatDelay');
const Comprobante = require('./src/models/Comprobante');
const comprobanteAi = require('./src/services/comprobanteAiService');
const BankMovement = require('./src/models/BankMovement');
const HgcashCharge = require('./src/models/HgcashCharge');
const PendingPayout = require('./src/models/PendingPayout');
const hgcashPay = require('./src/services/hgcashService');
const pdfImage = require('./src/services/pdfImageService');
const { generateReferralCode } = require('./src/utils/referralCode');
const { setRedisClient, getRedisClient } = require('./src/utils/redisClient');
const { generateAndSendOTP, verifyOTP } = require('./src/services/otpService');
const { sendSMS } = require('./src/services/smsService');
const { validateInternationalPhone, normalizePhoneKey } = require('./src/middlewares/security');

// ============================================
// SEGURIDAD - RATE LIMITING
// NOTE: generalLimiter usa store en memoria por instancia. authLimiter y
// sensitiveLimiter usan el store Redis de abajo (compartido entre instancias)
// con fallback a memoria.
// ============================================

// Store de rate-limit con backend en Redis (contador compartido entre instancias)
// y FALLBACK automático al MemoryStore de la propia librería. Si no hay Redis o si
// Redis falla, se comporta EXACTAMENTE como hoy (memoria por instancia). No agrega
// dependencias. Si la lib no expusiera MemoryStore, makeRateStore devuelve undefined
// y el limiter usa su store por defecto (= comportamiento actual).
const ERLMemoryStore = rateLimit.MemoryStore;
class RedisBackedRateStore {
  constructor(prefix) {
    this.prefix = prefix;
    this.localKeys = false;
    this.windowMs = 60 * 1000;
    this.memory = new ERLMemoryStore();
  }
  init(options) {
    this.windowMs = options.windowMs;
    if (this.memory && typeof this.memory.init === 'function') this.memory.init(options);
  }
  _rk(key) { return `erl:${this.prefix}:${key}`; }
  async increment(key) {
    const redis = getRedisClient();
    if (redis) {
      try {
        const rk = this._rk(key);
        const totalHits = await redis.incr(rk);
        if (totalHits === 1) await redis.expire(rk, Math.ceil(this.windowMs / 1000));
        return { totalHits, resetTime: new Date(Date.now() + this.windowMs) };
      } catch (err) {
        logger.warn(`Redis rate-limit error (${this.prefix}), usando fallback en memoria: ${err.message}`);
      }
    }
    return this.memory.increment(key);
  }
  async decrement(key) {
    const redis = getRedisClient();
    if (redis) {
      try { await redis.decr(this._rk(key)); return; } catch (err) { /* fallback */ }
    }
    return this.memory.decrement(key);
  }
  async resetKey(key) {
    const redis = getRedisClient();
    if (redis) {
      try { await redis.del(this._rk(key)); } catch (err) { /* ignore */ }
    }
    return this.memory.resetKey(key);
  }
}
function makeRateStore(prefix) {
  if (!ERLMemoryStore) return undefined; // sin MemoryStore → store por defecto de la lib
  return new RedisBackedRateStore(prefix);
}

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  // Cada admin logueado tiene su PROPIO cupo, keyeado por su cookie de sesión
  // (admin_api_session). Así varios agentes detrás de la misma IP (oficina/NAT)
  // NO comparten el límite y no se 429-ean entre ellos. Los clientes de la PWA
  // (que se autentican por header Bearer, sin esa cookie) siguen limitados por IP.
  keyGenerator: (req) => {
    const sess = getAdminApiSessionCookie(req);
    return sess ? ('sess:' + sess) : req.ip;
  },
  // Desactiva la validación de IPv6-fallback de la lib: usamos cookie para admins
  // e IP para clientes a propósito (no necesitamos el helper de IPv6 acá).
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'Demasiadas solicitudes. Intenta más tarde.' }
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRateStore('auth'),
  message: { error: 'Demasiados intentos de autenticación. Intenta más tarde.' }
});

// Rate limiter for sensitive unauthenticated endpoints (phone lookup, password reset)
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRateStore('sensitive'),
  message: { error: 'Demasiados intentos. Intenta más tarde.' }
});

// ============================================
// IP-BASED SMS RATE LIMITING (in-memory Map)
// ============================================

// Tracks SMS requests per IP: { ip -> [timestamp, ...] }
const smsIpStore = new Map();
// Tracks bulk SMS requests per IP: { ip -> [timestamp, ...] }
const bulkSmsIpStore = new Map();
// Tracks user registrations per IP: { ip -> [timestamp, ...] }
// Anti-multicuenta: limita creación masiva de cuentas desde una misma IP.
const registerIpStore = new Map();

// Periodically clean up expired entries to prevent memory leaks (every 30 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of smsIpStore) {
    const valid = timestamps.filter(ts => ts > now - 15 * 60 * 1000);
    if (valid.length === 0) smsIpStore.delete(ip);
    else smsIpStore.set(ip, valid);
  }
  for (const [ip, timestamps] of bulkSmsIpStore) {
    const valid = timestamps.filter(ts => ts > now - 60 * 60 * 1000);
    if (valid.length === 0) bulkSmsIpStore.delete(ip);
    else bulkSmsIpStore.set(ip, valid);
  }
  for (const [ip, timestamps] of registerIpStore) {
    const valid = timestamps.filter(ts => ts > now - 60 * 60 * 1000);
    if (valid.length === 0) registerIpStore.delete(ip);
    else registerIpStore.set(ip, valid);
  }
}, 30 * 60 * 1000).unref();

/**
 * Crea un middleware de rate-limit por IP. Usa un contador compartido en Redis
 * cuando está disponible (el límite se respeta entre TODAS las instancias) y cae a
 * un Map en memoria (ventana deslizante) si no hay Redis o si Redis falla. Así, en
 * multi-instancia el límite deja de ser ~N× (antes cada instancia contaba por su lado).
 * @param {Map} store - Map de fallback (IP -> timestamps)
 * @param {number} windowMs - Ventana de tiempo en ms
 * @param {number} max - Máximo de requests por ventana
 * @param {string} message - Mensaje de error al exceder el límite
 * @param {string} keyPrefix - Prefijo de la clave Redis (separa cada limiter)
 */
function createIpSmsLimiter(store, windowMs, max, message, keyPrefix) {
  const windowSec = Math.ceil(windowMs / 1000);
  return async (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress;
    if (!ip) {
      return res.status(429).json({ error: message });
    }

    // Camino preferido: contador compartido en Redis (ventana fija con INCR+EXPIRE).
    const redis = getRedisClient();
    if (redis) {
      try {
        const key = `rl:${keyPrefix}:${ip}`;
        const count = await redis.incr(key);
        if (count === 1) {
          // Primer hit de la ventana: fijar el TTL para que el contador expire solo.
          await redis.expire(key, windowSec);
        }
        if (count > max) {
          return res.status(429).json({ error: message });
        }
        return next();
      } catch (err) {
        logger.warn(`Redis rate-limit error (${keyPrefix}), usando fallback en memoria: ${err.message}`);
        // cae al fallback en memoria de abajo
      }
    }

    // Fallback en memoria (ventana deslizante) — comportamiento original sin Redis.
    const now = Date.now();
    const windowStart = now - windowMs;
    const timestamps = (store.get(ip) || []).filter(ts => ts > windowStart);
    if (timestamps.length >= max) {
      return res.status(429).json({ error: message });
    }
    timestamps.push(now);
    store.set(ip, timestamps);
    next();
  };
}

// 5 SMS requests per IP per 15 minutes (for OTP endpoints)
const smsIpLimiter = createIpSmsLimiter(
  smsIpStore,
  15 * 60 * 1000,
  5,
  'Demasiadas solicitudes de SMS. Por favor, intenta nuevamente más tarde.',
  'sms'
);

// 1 bulk SMS request per IP per hour
const bulkSmsIpLimiter = createIpSmsLimiter(
  bulkSmsIpStore,
  60 * 60 * 1000,
  1,
  'Demasiadas solicitudes de SMS masivo. Por favor, intenta nuevamente en una hora.',
  'bulksms'
);

// Anti-multicuenta: máximo 3 registros por IP por hora. Bloquea la creación
// masiva de cuentas desde el mismo dispositivo/conexión para abusar del bono.
// Se aplica tanto a /api/auth/register como a /api/auth/register-quick.
const registerIpLimiter = createIpSmsLimiter(
  registerIpStore,
  60 * 60 * 1000,
  3,
  'Demasiados registros desde tu conexión. Esperá una hora antes de crear otra cuenta.',
  'register'
);

// ============================================
// SEGURIDAD - HEADERS DE SEGURIDAD
// ============================================
// CSP precomputada una vez (antes se armaba el array + join en CADA request).
const CSP_HEADER_VALUE = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://www.google.com https://apis.google.com https://cdn.jsdelivr.net https://unpkg.com https://connect.facebook.net",
  "script-src-elem 'self' 'unsafe-inline' https://www.gstatic.com https://www.google.com https://apis.google.com https://cdn.jsdelivr.net https://unpkg.com https://connect.facebook.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.google.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://fcm.googleapis.com https://firebaseinstallations.googleapis.com https://www.facebook.com https://connect.facebook.net",
  "frame-src 'self' https://*.firebaseapp.com https://*.google.com https://www.facebook.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "media-src 'self' data: blob:"
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '0'); // recomendación moderna: 0 — la CSP es la defensa real
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  // HSTS: only set in production (HTTPS). In development the server may run
  // on plain HTTP where HSTS would cause the browser to block future HTTP requests.
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  // CSP compatible con Firebase Auth, FCM, Socket.IO WebSocket y PWA service workers.
  // 'unsafe-inline' en script-src/style-src es necesario por el stack actual de frontend.
  // worker-src incluye blob: para Workbox/sw.js generados en runtime.
  // connect-src incluye wss: para Socket.IO WebSocket y dominios Firebase necesarios.
  res.setHeader('Content-Security-Policy', CSP_HEADER_VALUE);
  next();
}

// ============================================
// SEGURIDAD - VALIDACIÓN DE INPUT
// ============================================

// Helper para comparación segura de strings (previene timing attacks).
// Usa HMAC con clave aleatoria por llamada: ambos HMACs son siempre de 32 bytes,
// por lo que timingSafeEqual nunca revela diferencias de longitud ni de contenido.
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // A random per-call key ensures the attacker cannot predict the HMAC output
  // and prevents multi-call timing oracle attacks.
  const key = crypto.randomBytes(32);
  const hmacA = crypto.createHmac('sha256', key).update(a).digest();
  const hmacB = crypto.createHmac('sha256', key).update(b).digest();
  return crypto.timingSafeEqual(hmacA, hmacB);
}

function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  return input
    .replace(/[<>]/g, '')
    .trim()
    .substring(0, 1000);
}

// Escapar caracteres especiales de regex para evitar ReDoS/inyección
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================
// BÚSQUEDA DE USUARIO CASE-INSENSITIVE (camino rápido + red de seguridad)
// ============================================
// Camino RÁPIDO: usernameLower (indexado, lo mantiene el pre-save de User +
// backfill al arranque). Red de seguridad: el regex case-insensitive histórico
// (COLLSCAN) — SOLO se usa si el camino rápido no encontró nada Y el backfill
// del arranque todavía no está confirmado en esta instancia. Así el peor caso
// de este cambio es exactamente el comportamiento de antes: NADIE puede quedar
// afuera de su cuenta.
// opts.critical: el LOGIN usa fallback SIEMPRE (aunque el backfill esté OK) —
// cubre hasta la ventana de un rolling deploy donde una instancia vieja creó
// un usuario sin el campo. El costo solo se paga cuando el username NO existe
// (tipeos), que además está rate-limiteado.
let _usernameLowerReady = false; // la pone en true el backfill del bootstrap
async function findUserByUsernameCI(username, opts = {}) {
  const raw = String(username || '').trim();
  if (!raw) return null;
  const build = (filter) => {
    let q = User.findOne(filter);
    if (opts.select) q = q.select(opts.select);
    if (opts.lean) q = q.lean();
    return q;
  };
  let user = await build({ usernameLower: raw.toLowerCase() });
  if (!user && (!_usernameLowerReady || opts.critical)) {
    user = await build({ username: { $regex: new RegExp('^' + escapeRegex(raw) + '$', 'i') } });
    if (user) {
      // Auto-reparación: si el camino lento lo encontró, dejarle el campo
      // rápido para la próxima (fire-and-forget, no bloquea la respuesta).
      User.updateOne(
        { _id: user._id },
        { $set: { usernameLower: String(user.username || '').toLowerCase() } }
      ).catch(() => {});
    }
  }
  return user;
}

function validateUsername(username) {
  if (!username || typeof username !== 'string') return false;
  const sanitized = username.trim();
  return /^[a-zA-Z0-9_.-]{3,30}$/.test(sanitized);
}

function validatePassword(password) {
  if (!password || typeof password !== 'string') return false;
  return password.length >= 6 && password.length <= 100;
}

// Integración JUGAYGANA
const jugaygana = require('./jugaygana');
const jugayganaMovements = require('./jugaygana-movements');
const jugayganaService = require('./src/services/jugayganaService');
// Pool de sesiones JUGAYGANA por publicista — se usa cuando un publisher_admin
// crea un usuario y la campaña tiene credenciales propias configuradas.
const jugayganaPublisherSessions = require('./src/services/jugayganaPublisherSessions');
// Analítica de clientes por publicista (segmentación churn, ranking, recuperación).
const publisherAnalytics = require('./src/services/publisherAnalyticsService');
const refunds = require('./models/refunds');
const referralRevenueService = require('./src/services/referralRevenueService');
const { resolveJugayganaUserId } = require('./src/services/jugayganaUserLinkService');
const metaCapi = require('./src/services/metaCapiService');
const fbAdsWebhook = require('./src/services/fbAdsWebhookService');

// Valida y normaliza un valor de cookie _fbc / _fbp de Meta antes de
// persistirlo o reenviarlo a Conversions API. El formato real es
// `fb.<subdomainIndex>.<creationTimeMs>.<payload>` (ej: fb.1.1747531860000.IwAR0...).
// Devuelve el string saneado, o null si no tiene una forma válida.
function sanitizeFbCookie(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 6 || trimmed.length > 512) return null;
  if (!/^fb\.\d\.\d+\..+$/.test(trimmed)) return null;
  return trimmed;
}

// ============================================
// BLOQUEO DE REEMBOLSOS
// ============================================
// Maps de fallback (se mantienen para cuando Redis no está disponible)
const refundLocksMemory = new Map();
const cbuRequestTimestampsMemory = new Map();

// Mantener referencias de compatibilidad (usadas por el cleanup interval)
const refundLocks = refundLocksMemory;
const cbuRequestTimestamps = cbuRequestTimestampsMemory;

async function acquireRefundLock(userId, type) {
  const key = `refund-lock:${userId}:${type}`;
  const redis = getRedisClient();
  if (redis) {
    try {
      const result = await redis.set(key, '1', { NX: true, EX: 300 });
      return result === 'OK';
    } catch (err) {
      logger.warn(`Redis lock error, usando fallback en memoria: ${err.message}`);
    }
  }
  // Fallback en memoria
  if (refundLocksMemory.has(key)) return false;
  refundLocksMemory.set(key, Date.now());
  return true;
}

async function releaseRefundLock(userId, type) {
  const key = `refund-lock:${userId}:${type}`;
  const redis = getRedisClient();
  if (redis) {
    try { await redis.del(key); } catch (err) { /* fallback */ }
  }
  refundLocksMemory.delete(key);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of refundLocksMemory.entries()) {
    if (now - timestamp > 5 * 60 * 1000) {
      refundLocksMemory.delete(key);
    }
  }
}, 60 * 1000);

// ============================================
// RATE LIMITING POR USUARIO (CBU requests)
// Máximo 1 solicitud de CBU cada 10 segundos por usuario
// ============================================
const CBU_RATE_WINDOW_MS = 10000;

function checkCbuRateLimit(userId) {
  // TODO: Convertir a async en una futura refactorización para usar Redis
  const redis = getRedisClient();
  if (redis) {
    // Async no se puede usar aquí directamente, usar fallback en memoria
  }
  // Fallback en memoria
  const last = cbuRequestTimestampsMemory.get(userId);
  const now = Date.now();
  if (last && now - last < CBU_RATE_WINDOW_MS) {
    return false; // Bloqueado
  }
  cbuRequestTimestampsMemory.set(userId, now);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - CBU_RATE_WINDOW_MS * 2;
  for (const [userId, ts] of cbuRequestTimestampsMemory.entries()) {
    if (ts < cutoff) cbuRequestTimestampsMemory.delete(userId);
  }
}, 60000);

const app = express();
// Trust the first proxy hop (AWS ALB / Elastic Beanstalk / Cloudflare) so that
// Express sees the real client IP and HTTPS status from X-Forwarded-* headers.
// Without this, req.ip returns the internal LB address and Socket.IO/CORS may
// behave incorrectly when accessed through a custom domain like vipcargas.com.
app.set('trust proxy', 1);

// ============================================
// CORS ORIGIN RESOLVER (centralizado)
// ============================================
// En producción: usa la allowlist de ALLOWED_ORIGINS (obligatorio).
// Si no se configura, restringe a mismo origen (no wildcard).
// En desarrollo: acepta localhost como fallback seguro.
const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:10000'];
function resolveAllowedOrigins() {
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean);
  }
  if (process.env.NODE_ENV === 'production') {
    // En producción sin ALLOWED_ORIGINS, no permitir orígenes cruzados.
    // Las peticiones same-origin (sin cabecera Origin) siempre pasan.
    return [];
  }
  return DEV_ORIGINS;
}

function corsOriginFn(origin, callback) {
  const allowed = resolveAllowedOrigins();
  // Requests sin cabecera Origin (same-origin, curl, mobile) siempre se permiten.
  if (!origin) return callback(null, true);
  if (allowed.includes(origin)) return callback(null, true);
  logger.warn(`CORS bloqueado para origen: ${origin}`);
  return callback(new Error('No autorizado por CORS'));
}

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: corsOriginFn,
    methods: ["GET", "POST"],
    credentials: true
  },
  // WebSocket primero (baja latencia detrás de ALB/NLB); polling como respaldo
  // para redes que bloquean WebSocket. El cliente (public/js/socket.js) pide la
  // misma lista, así que un cliente con WS bloqueado igual entra por polling.
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 5 * 1024 * 1024 // 5MB — suficiente para imágenes base64 razonables
});

// ============================================
// REDIS ADAPTER FOR SOCKET.IO (horizontal scaling)
// Provide REDIS_URL (e.g. redis://user:pass@host:6379) or individual
// REDIS_HOST / REDIS_PORT / REDIS_USERNAME / REDIS_PASSWORD env vars.
// When none are set the app runs in single-instance (in-memory) mode.
// ============================================
async function setupRedisAdapter() {
  const redisUrl = process.env.REDIS_URL;
  const redisHost = process.env.REDIS_HOST;

  if (!redisUrl && !redisHost) {
    logger.warn('Redis not configured (REDIS_URL / REDIS_HOST missing). Socket.IO running in single-instance mode.');
    return;
  }

  try {
    const connectionOptions = redisUrl
      ? { url: redisUrl }
      : {
          socket: {
            host: redisHost,
            port: parseInt(process.env.REDIS_PORT || '6379', 10)
          },
          username: process.env.REDIS_USERNAME || undefined,
          password: process.env.REDIS_PASSWORD || undefined
        };

    const pubClient = createClient(connectionOptions);
    const subClient = pubClient.duplicate();

    pubClient.on('error', (err) => logger.error(`Redis pub client error: ${err.message}`));
    subClient.on('error', (err) => logger.error(`Redis sub client error: ${err.message}`));

    await Promise.all([pubClient.connect(), subClient.connect()]);

    io.adapter(createAdapter(pubClient, subClient));
    setRedisClient(pubClient);
    logger.info('Socket.IO Redis adapter initialized — multi-instance mode active');
  } catch (err) {
    logger.error(`Failed to initialize Redis adapter: ${err.message}. Falling back to single-instance mode.`);
  }
}

const PORT = process.env.PORT || 3000;
// JWT_SECRET se valida dentro del bootstrap async (después de cargar SSM).
let JWT_SECRET;

// ============================================
// MIDDLEWARE DE SEGURIDAD
// ============================================
const compression = require('compression');
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));
app.use(securityHeaders);
if (!process.env.ALLOWED_ORIGINS && process.env.NODE_ENV === 'production') {
  logger.warn('⚠️ SEGURIDAD: ALLOWED_ORIGINS no configurado en producción. CORS rechazará orígenes cruzados.');
}
app.use(cors({
  origin: corsOriginFn,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['X-Total-Count', 'X-RateLimit-Remaining']
}));
app.use('/api/', generalLimiter);
// Guardamos el body CRUDO (Buffer) en req.rawBody para poder validar firmas
// HMAC de webhooks (ej. hgcash) sobre los bytes exactos. No cambia el parseo
// normal: req.body sigue siendo el JSON parseado.
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(mongoSanitize());
app.use(xss());

// Fields exposed to the authenticated user about their own profile.
// Keep this list minimal – internal fields (jugaygana IDs, FCM tokens, etc.)
// are excluded intentionally to reduce accidental data exposure.
const USER_PUBLIC_FIELDS = 'id username email phone phoneVerified phoneVerificationPending whatsapp accountNumber role balance isActive referralCode referredByUserId referralStatus createdAt lastLogin mustChangePassword acquisitionCampaign acquisitionSource notificationPlan';

// Admin roles are internal VIPCARGAS accounts that have NO counterpart in
// JUGAYGANA. They must never be routed through any JUGAYGANA sync, default-
// password detection, or mustChangePassword flow.
// "Admin roles" abarca todo lo que NO es un jugador de JUGAYGANA: admin general,
// agentes de carga/retiro, y publisher_admin (cuenta dedicada a un publicista).
// Estas cuentas se saltan toda la lógica de JUGAYGANA sync, default-password
// detection, mustChangePassword forzado, Meta CAPI tracking, etc.
const ADMIN_ROLES = ['admin', 'depositor', 'withdrawer', 'publisher_admin', 'comunidad'];
const isAdminRole = (role) => ADMIN_ROLES.includes(role);

// Rutas que un publisher_admin puede tocar. Cualquier otra ruta devuelve 403.
// El authMiddleware aplica este lockdown sólo para ese rol; admin / depositor /
// withdrawer mantienen su acceso normal.
const PUBLISHER_ADMIN_ALLOWED_PATHS = [
  '/api/auth/change-password',
  '/api/auth/change-password/send-otp',
  '/api/auth/change-password/pending',
  '/api/auth/logout',
  '/api/auth/admin-logout',
  '/api/auth/verify',
  '/api/users/me',
  '/api/admin/me',
  '/api/admin/change-own-password',
  '/api/admin/publisher-admin',
  '/api/health'
];

// Maximum character length for a block reason stored on a user account.
// Must match the maxlength attribute in the admin panel block modal HTML.
const MAX_BLOCK_REASON_LENGTH = 500;

// Paths that are reachable while a user has `mustChangePassword: true`.
// Everything else returns 403 with `code: 'MUST_CHANGE_PASSWORD'` (enforced
// inside `authMiddleware`) so the client can re-open the mandatory change
// modal even after a page reload or a manual API call.
const MUST_CHANGE_PASSWORD_ALLOWED_PATHS = [
  '/api/auth/change-password',
  '/api/auth/change-password/send-otp',
  '/api/auth/change-password/pending',
  '/api/users/me',
  '/api/auth/logout',
  '/api/auth/admin-logout',
  '/api/auth/verify',
  '/api/health'
];

// Regex used by the SPA fallback to detect static asset paths that should
// never be served as HTML (would trigger X-Content-Type-Options: nosniff).
const STATIC_ASSET_EXT_RE = /\.(css|js|map|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|json|webp|mp3|mp4|wav|ogg)$/i;

// Cache-Control: no-store para rutas sensibles de autenticación y administración.
// Evita que proxies, CDNs o el browser cacheen respuestas con datos personales o tokens.
app.use(['/api/auth', '/api/admin', '/api/users/me'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ============================================
// ADMIN PAGE SECURITY
// ============================================

// ADMIN_HOST: if set, admin pages are ONLY served when the request Host matches.
// Configuring this env var is the primary server-side control to prevent the
// public domain from ever serving the admin panel.
const ADMIN_HOST = process.env.ADMIN_HOST || null;

// Legacy / debug HTML files that must never be served publicly.
// Use a Set for O(1) look-ups on every request.
const BLOCKED_LEGACY_ADMIN_PATHS = new Set([
  '/admin-masivo.html',
  '/admin-masivo-simple.html',
  '/admin-notificaciones-v2.html',
  '/admin-notifications.html',
  '/admin-panel.html',
  '/diagnostico-fcm.html',
  '/test-firebase.html',
  '/test-pwa.html',
]);

// Helper: parse the admin_session httpOnly cookie value.
function getAdminSessionCookie(req) {
  const cookieHeader = req.headers.cookie || '';
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key === 'admin_session') return val;
  }
  return null;
}

// Helper: parse the admin_api_session httpOnly cookie value (Path=/api).
function getAdminApiSessionCookie(req) {
  const cookieHeader = req.headers.cookie || '';
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key === 'admin_api_session') return val;
  }
  return null;
}

// Helper: extract the bare hostname (without port) from a request.
function parseRequestHost(req) {
  const rawHost = req.hostname || (req.headers.host || '');
  return rawHost.split(':')[0].toLowerCase();
}

// Helper: build the Set-Cookie header values for the admin session cookies.
// Returns an array: [page-scoped cookie, api-scoped cookie].
function buildAdminSessionCookieHeaders(token) {
  const maxAge = 8 * 60 * 60; // 8 hours in seconds
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return [
    `admin_session=${token}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/adminprivado2026${secure}`,
    `admin_api_session=${token}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/api${secure}`
  ];
}

// Middleware: check ADMIN_HOST restriction.
// Returns 404 (not 403) to avoid revealing that an admin endpoint exists.
function adminHostCheck(req, res, next) {
  if (!ADMIN_HOST) return next();
  if (parseRequestHost(req) !== ADMIN_HOST.toLowerCase()) {
    return res.status(404).send('Not found');
  }
  next();
}

// Middleware: verify admin_session cookie for asset requests.
// Returns 403 if cookie is absent or JWT is not an admin role.
// NOTE: Currently not applied to admin.css/admin.js because those assets are
// needed to render the login form (catch-22: can't require auth to load the
// login page). Kept here for future use when the admin login form is split
// into a separate lightweight page.
function requireAdminCookie(req, res, next) {
  const cookieVal = getAdminSessionCookie(req);
  if (!cookieVal) {
    return res.status(403).send('Forbidden');
  }
  try {
    const decoded = jwt.verify(cookieVal, JWT_SECRET, { algorithms: ['HS256'] });
    const adminRoles = ['admin', 'depositor', 'withdrawer', 'comunidad'];
    if (!adminRoles.includes(decoded.role)) {
      return res.status(403).send('Forbidden');
    }
    next();
  } catch {
    return res.status(403).send('Forbidden');
  }
}

// Block legacy admin HTML files before express.static can serve them.
app.use((req, res, next) => {
  if (BLOCKED_LEGACY_ADMIN_PATHS.has(req.path.toLowerCase())) {
    return res.status(404).send('Not found');
  }
  next();
});

// Redirigir /index.html → / para que el HTML siempre pase por el handler
// que inyecta META_PIXEL_ID (de lo contrario express.static lo serviría
// con el placeholder sin reemplazar).
app.get('/index.html', (req, res) => res.redirect(301, '/'));

// ── Admin page routes ──────────────────────────────────────────────────────
// These are registered BEFORE express.static so that:
//  1. Host-based checks run before the file system is touched.
//  2. Sub-paths like /adminprivado2026/index.html return 404 (must use the
//     canonical /adminprivado2026 URL).
//  3. admin.css and admin.js are served through guarded handlers only.

// Helper: read a file or return null (defined early for these handlers).
function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`Error leyendo archivo ${filePath}:`, err.message);
    return null;
  }
}

// Cache en memoria de assets estáticos que se sirven por handler propio
// (index.html, admin.html/css/js). Estos archivos SOLO cambian con un redeploy
// (que reinicia el proceso en EB), así que leerlos del disco en cada request
// era I/O síncrona que bloqueaba el event loop al pedo. No cachea errores
// (null): si la lectura falla, se reintenta en el próximo request.
const _fileCache = new Map();
function readFileCached(filePath) {
  if (_fileCache.has(filePath)) return _fileCache.get(filePath);
  const content = readFileSafe(filePath);
  if (content !== null) _fileCache.set(filePath, content);
  return content;
}

// Admin panel HTML (serves the login form + app shell; cookie NOT required
// here so first-time visitors can authenticate via the login form).
let _adminHtmlRendered = null;
app.get(['/adminprivado2026', '/adminprivado2026/'], adminHostCheck, (req, res) => {
  if (_adminHtmlRendered === null) {
    const adminPath = path.join(__dirname, 'public', 'adminprivado2026', 'index.html');
    const content = readFileCached(adminPath);
    if (!content) return res.status(500).send('Error loading admin page');
    // Inyectar la URL pública canónica (vipcargas.com) para que el admin
    // genere los links de pauta con el dominio correcto y no con el de AWS.
    // El PUBLIC_BASE_URL viene de env var; ver constante más abajo en este archivo.
    const publicBaseUrl = (process.env.PUBLIC_BASE_URL || 'https://vipcargas.com').replace(/\/$/, '');
    _adminHtmlRendered = content.replace(/__VIP_PUBLIC_BASE_URL_PLACEHOLDER__/g, publicBaseUrl);
  }
  const rendered = _adminHtmlRendered;
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.send(rendered);
});

// Admin CSS asset — host check only (cookie check intentionally omitted; see
// requireAdminCookie comment above for the rationale).
app.get('/adminprivado2026/admin.css', adminHostCheck, (req, res) => {
  const cssPath = path.join(__dirname, 'public', 'adminprivado2026', 'admin.css');
  const content = readFileCached(cssPath);
  if (!content) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/css');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(content);
});

// Admin JS asset — host check only (same rationale as admin.css above).
app.get('/adminprivado2026/admin.js', adminHostCheck, (req, res) => {
  const jsPath = path.join(__dirname, 'public', 'adminprivado2026', 'admin.js');
  const content = readFileCached(jsPath);
  if (!content) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(content);
});

// Catch-all: block every other path under /adminprivado2026/ (e.g. direct
// access to /adminprivado2026/index.html, /adminprivado2026/manifest.json).
// This runs BEFORE express.static so static never serves these files.
app.use('/adminprivado2026/', adminHostCheck, (req, res) => {
  res.status(404).send('Not found');
});

// Slugifier para matching de vanity URL contra publisher names. Convierte
// "Juan Pérez" → "juan-perez". Quita acentos, espacios → guion, normaliza
// case y limpia caracteres especiales. Idempotente.
function _slugifyPublisher(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar acentos
    .replace(/\s+/g, '-')                              // espacios → guiones
    .replace(/[^a-z0-9_-]/g, '')                       // sólo seguros
    .replace(/-+/g, '-')                               // colapsar guiones
    .replace(/^-+|-+$/g, '');                          // trim guiones
}

// Cache corto (30s) de campañas activas para el matching por SLUG del vanity.
// Ese branch corre en CADA page-view SPA de un segmento (/register, /chat, …)
// y traía TODAS las campañas activas de la DB por request. El matching por
// CODE exacto NO usa este cache (sigue directo a la DB, indexado y barato),
// así una campaña recién creada funciona por code al instante; por slug
// aparece a los ≤30s.
let _campaignSlugCache = { at: 0, items: [] };
async function _getActiveCampaignsCached() {
  if (Date.now() - _campaignSlugCache.at < 30000) return _campaignSlugCache.items;
  const items = await Campaign.find({ isActive: true })
    .select('code publisher name createdAt')
    .lean();
  _campaignSlugCache = { at: Date.now(), items };
  return items;
}

// Vanity URL para links de pauta:
//   - https://vipcargas.com/MI_CODIGO          (matchea por Campaign.code)
//   - https://vipcargas.com/juan-perez         (matchea por slug del publisher)
//
// Ambos sirven la home con atribución activa. Si el path no matchea ninguno,
// next() para que express.static lo intente servir o caiga al 404.
app.get('/:code', async (req, res, next) => {
  const candidate = req.params.code || '';
  // Sólo procesar si parece un código/slug válido: 3-40 chars, letras/números/_/-
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(candidate)) return next();
  // Excluir extensiones de archivo (favicons, etc.) y nombres conocidos del SW
  if (/\.(html|css|js|png|jpg|jpeg|ico|svg|json|webp|woff2?|map|txt|xml)$/i.test(candidate)) return next();
  if (['robots', 'sitemap', 'favicon', 'manifest'].includes(candidate.toLowerCase())) return next();

  try {
    // Match 1: por código exacto (uppercase). Comportamiento legacy.
    const normalizedCode = candidate.toUpperCase();
    let campaign = await Campaign.findOne({ code: normalizedCode, isActive: true }).lean();

    // Match 2: si no hay code, probar slug del publisher. Permite links
    // amigables tipo /juan-perez sin tener que crear un code con ese nombre.
    if (!campaign) {
      const candidateSlug = _slugifyPublisher(candidate);
      if (candidateSlug) {
        // Filtrar por slug del publisher en memoria sobre el cache de 30s
        // (no hay un campo slug indexado; la cantidad de campañas es chica).
        // Si hay varias, elegimos la creada más recientemente — asumimos que
        // es la activa del publicista.
        const candidates = await _getActiveCampaignsCached();
        const matches = candidates.filter(c => _slugifyPublisher(c.publisher) === candidateSlug);
        if (matches.length > 0) {
          matches.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          campaign = matches[0];
        }
      }
    }

    if (!campaign) return next();

    const rendered = renderIndexHtml({ campaignCode: campaign.code });
    if (!rendered) return res.status(500).send('Error loading page');
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    // Persistir la pauta en una cookie: en las cargas siguientes (home / recarga)
    // el server reinyecta el código aunque la URL ya no sea /juan-perez.
    res.setHeader('Set-Cookie', buildCampaignCookieHeader(campaign.code));
    res.send(rendered);
  } catch (err) {
    logger.warn(`[vanity /:code] error: ${err.message}`);
    return next();
  }
});

// Manifest con `start_url` personalizado para el traspaso de sesión a la PWA.
// Va ANTES de express.static para poder interceptar `/manifest.json?al=TOKEN`.
// Sin el parámetro devuelve el archivo tal cual (el static de abajo lo sirve).
//
// Por qué: en iOS la app instalada NO comparte localStorage con Safari, así que
// abre deslogueada. El `start_url` es la única URL que se ejecuta DENTRO del
// contenedor de la app, así que es por donde se le puede pasar la sesión.
// El token es de un solo uso: sirve para el primer arranque y se muere ahí.
app.get('/manifest.json', (req, res, next) => {
  const al = typeof req.query.al === 'string' ? req.query.al.trim() : '';
  // Sin token o con basura → manifest normal. El formato es base64url de 32
  // bytes (43 chars); validamos forma, no validez: el canje ya la verifica.
  if (!al || !/^[A-Za-z0-9_-]{20,120}$/.test(al)) return next();

  try {
    const raw = readFileCached(path.join(__dirname, 'public', 'manifest.json'));
    if (!raw) return next();
    const manifest = JSON.parse(raw);
    manifest.start_url = `/?al=${encodeURIComponent(al)}`;
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    // Nunca cachear: este manifest es de un solo usuario y de un solo uso.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return res.send(JSON.stringify(manifest));
  } catch (e) {
    logger.warn(`[manifest] no se pudo personalizar start_url: ${e.message}`);
    return next();
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',
  index: false,
  // Default: cache static assets for 1 day. HTML, JS, CSS and service-worker
  // files override this below so that a redeploy is picked up immediately by
  // installed PWAs and browsers without waiting 24 hours.
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    // Never cache files that change with every deploy so installed PWAs always
    // get fresh code after a redeploy on AWS Elastic Beanstalk.
    const noCache =
      filePath.endsWith('.html') ||
      filePath.endsWith('.js') ||
      filePath.endsWith('.css') ||
      filePath.includes('firebase-messaging-sw') ||
      filePath.includes('user-sw') ||
      filePath.includes('admin-sw') ||
      filePath.includes('manifest.json');
    if (noCache) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    // Serve manifest.json with the correct Content-Type for PWA installability.
    // Chrome requires application/manifest+json (or application/json) to recognise
    // the file as a Web App Manifest. Express static defaults to application/json
    // which Chrome accepts, but setting the canonical type is best practice.
    if (path.basename(filePath) === 'manifest.json') {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    }
  }
}));

// ============================================
// RUTAS DE NOTIFICACIONES PUSH (FCM)
// ============================================
const notificationRoutes = require('./src/routes/notificationRoutes');
app.use('/api/notifications', notificationRoutes);
notificationRoutes.setIo(io);

const { sendNotificationToUser: _sendPushToUser, pruneInvalidFcmTokens, sendNotificationToAllUsers, sendNotificationToUsernames } = require('./src/services/notificationService');

// ============================================
// CRON DIARIO: LIMPIEZA DE TOKENS FCM MUERTOS
// Valida cada token vía dry-run de FCM (no envía push real al dispositivo) y
// borra de la BD los que devuelven error de token inválido. Esto mantiene
// limpio el array fcmTokens y reduce la tasa de fallidos en envíos masivos.
//
// Guarda anti-overlap: si la corrida anterior aún no terminó (ej: 100K users),
// se omite la siguiente para no superponer escrituras a la misma colección.
// ============================================
const FCM_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
let _fcmPruneRunning = false;
async function _runFcmPrune(reason) {
  if (_fcmPruneRunning) {
    logger.warn(`[FCM-prune] (${reason}) saltado: corrida anterior aún en curso`);
    return;
  }
  _fcmPruneRunning = true;
  const startedAt = Date.now();
  try {
    const result = await pruneInvalidFcmTokens(User);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (result && result.success) {
      logger.info(`[FCM-prune] (${reason}) total=${result.total} valid=${result.valid} cleaned=${result.cleaned} errors=${result.errors} (${elapsed}s)`);
    } else {
      logger.warn(`[FCM-prune] (${reason}) sin resultado: ${result && result.error}`);
    }
  } catch (e) {
    logger.error(`[FCM-prune] (${reason}) excepción: ${e.message}`);
  } finally {
    _fcmPruneRunning = false;
  }
}
// Primera corrida 5 min después del arranque para no impactar el inicio del proceso
setTimeout(() => { _runFcmPrune('startup-delayed'); }, 5 * 60 * 1000);
setInterval(() => { _runFcmPrune('cron-24h'); }, FCM_PRUNE_INTERVAL_MS);

// Helper: dado un receiverId y un mensaje de chat, dispara push FCM si el user
// tiene tokens registrados. Usado por: (a) usuarios offline (canal directo
// fallido) y (b) usuarios "online" cuyo socket directo no acusó recibo en 3s
// (socket fantasma — pestaña suspendida por el SO, conexión TCP sin proceso).
// La doble entrega (sala + push) se mitiga con tag:'chat-message' que reemplaza
// notificaciones del mismo chat en el dispositivo.
function _maybeSendPushFallback(receiverId, message) {
  if (!receiverId) return;
  // Solo los campos que usa sendPushIfOffline (corre por cada mensaje de chat
  // con fallback push; el doc completo era hidratación innecesaria).
  User.findOne({ id: receiverId }).select('id username fcmToken fcmTokens').lean()
    .then(function (targetUser) {
      const hasTokens = targetUser && (targetUser.fcmToken || (targetUser.fcmTokens && targetUser.fcmTokens.length > 0));
      if (!hasTokens) return;
      const pushTitle = 'Nuevo mensaje';
      const pushBody = message && message.type === 'image' ? '📸 Imagen'
                     : message && message.type === 'video' ? '🎥 Video'
                     : (message && message.content || '').substring(0, 100);
      sendPushIfOffline(targetUser, pushTitle, pushBody, { tag: 'chat-message' }).catch(function (e) {
        logger.warn(`[FCM] sendPushIfOffline (chat) falló para ${targetUser.username}: ${e.message}`);
      });
    })
    .catch(function (dbErr) {
      logger.warn(`[FCM] Error buscando usuario para push (chat): ${dbErr.message}`);
    });
}

// Helper: enviar push FCM a un usuario solo si no tiene socket activo.
// Evita duplicado: si el usuario ya recibió el mensaje por Socket.IO (online),
// no enviamos además un push. Solo enviamos push a usuarios offline.
//
// NOTA DE INICIALIZACIÓN: connectedUsers (const Map) se declara en la sección
// de Socket.IO más abajo (~línea 3205). Esta función nunca se invoca antes de
// esa declaración (solo se llama desde route handlers y socket handlers), por lo
// que la referencia es segura en runtime.
async function sendPushIfOffline(user, title, body, data = {}) {
  // Recopilar todos los tokens activos del usuario (array multi-token + fallback al campo individual)
  const allTokens = new Set();
  if (user.fcmTokens && user.fcmTokens.length > 0) {
    for (const entry of user.fcmTokens) {
      if (entry.token) allTokens.add(entry.token);
    }
  }
  if (user.fcmToken) allTokens.add(user.fcmToken);

  if (allTokens.size === 0) return;

  // Si el usuario tiene un socket activo, ya recibió el mensaje en tiempo real;
  // no enviamos push para evitar notificación duplicada. En su lugar emitimos
  // un evento socket 'admin_notification' para que el frontend muestre un
  // cartel in-app cuando la PWA está abierta en foreground.
  if (connectedUsers && connectedUsers.has(user.id)) {
    logger.debug(`[FCM] Usuario ${user.username} online (socket activo), omitiendo push duplicado`);
    try {
      const userSocket = connectedUsers.get(user.id);
      if (userSocket && typeof userSocket.emit === 'function') {
        userSocket.emit('admin_notification', {
          title: title,
          body: body,
          icon: (data && data.icon) || '/icons/icon-192x192.png',
          timestamp: Date.now(),
          data: data || {}
        });
        logger.info(`[NOTIF] Emitido por socket a usuario online: ${user.username}`);
      }
    } catch (emitErr) {
      logger.warn(`[NOTIF] Error emitiendo admin_notification por socket a ${user.username}: ${emitErr.message}`);
    }
    return;
  }

  for (const token of allTokens) {
    try {
      const result = await _sendPushToUser(token, title, body, data);
      if (result.success) {
        logger.info(`[FCM] Push enviado a ${user.username} (offline) token ...${token.slice(-8)}`);
      } else if (result.invalidToken) {
        // Limpiar solo ese token específico, no todos los del usuario
        try {
          await User.updateOne(
            { _id: user._id, fcmToken: token },
            { $set: { fcmToken: null, fcmTokenUpdatedAt: null } }
          );
          await User.updateOne(
            { _id: user._id },
            { $pull: { fcmTokens: { token: token } } }
          );
          logger.warn(`[FCM] Token inválido eliminado para ${user.username} (${token.slice(-8)})`);
        } catch (cleanErr) {
          logger.warn(`[FCM] Error limpiando token inválido de ${user.username}: ${cleanErr.message}`);
        }
      } else {
        logger.warn(`[FCM] Error enviando push a ${user.username}: ${result.error}`);
      }
    } catch (err) {
      logger.warn(`[FCM] Excepción enviando push a ${user.username}: ${err.message}`);
    }
  }
}

// ============================================
// FUNCIONES HELPER PARA MONGODB
// ============================================

// Generar número de cuenta
const generateAccountNumber = () => {
  return 'ACC' + Date.now().toString().slice(-8) + Math.random().toString(36).substr(2, 4).toUpperCase();
};

// Buscar usuario por teléfono
async function findUserByPhone(phone) {
  const user = await User.findOne({ $or: [{ phone }, { whatsapp: phone }] }).lean();
  if (user) {
    return { username: user.username, phone: user.phone, source: 'main' };
  }
  
  const externalUser = await ExternalUser.findOne({ $or: [{ phone }, { whatsapp: phone }] }).lean();
  if (externalUser) {
    return { username: externalUser.username, phone: externalUser.phone, source: 'external' };
  }
  
  return null;
}

// Cambiar contraseña por teléfono
async function changePasswordByPhone(phone, newPassword) {
  const user = await User.findOne({ $or: [{ phone }, { whatsapp: phone }] });
  
  if (!user) {
    return { success: false, error: 'Usuario no encontrado con ese número de teléfono' };
  }
  
  user.password = newPassword;
  user.passwordChangedAt = new Date();
  await user.save();
  
  return { success: true, username: user.username };
}

// Renderiza el texto de un mensaje automático editable desde la sección COMANDOS.
// Busca el Command por nombre; si existe y está activo usa su `response`, sino
// usa el `fallback` hardcodeado. Reemplaza variables {clave} por su valor.
//
// Convención de variables (igual que los comandos /sys_deposit existentes):
//   - Montos: el template escribe "${amount}" y acá reemplazamos "{amount}" por
//     el número → queda "$50000" (el $ es el signo de peso literal del template).
//   - Texto (username, bank, etc.): el template escribe "{username}" sin $ y se
//     reemplaza por el valor.
// Si el comando EXISTE (activo) pero su respuesta quedó VACÍA, se interpreta como
// "desactivado a propósito" → devuelve null para que el caller NO envíe el mensaje.
// Si el comando NO existe (instalación nueva, antes del seed) usa el fallback.
// Nunca lanza: ante error de DB devuelve el fallback ya renderizado.
async function renderSystemCommand(name, fallback, vars = {}) {
  let template = fallback;
  try {
    const cmd = await Command.findOne({ name, isActive: true }).lean();
    if (cmd) {
      // El comando existe: si lo vaciaron desde el panel, no se envía nada.
      if (!cmd.response || !String(cmd.response).trim()) return null;
      template = cmd.response;
    }
  } catch (e) {
    logger.warn(`[renderSystemCommand] ${name}: ${e.message} — usando fallback`);
  }
  if (template == null) return null;
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), v == null ? '' : String(v));
  }
  return out;
}

// Igual que renderSystemCommand pero a partir de un Command ya cargado (los flujos
// que ya hacían Command.findOne directo). Devuelve null si el comando existe pero su
// respuesta está vacía (desactivado a propósito); usa el fallback si no existe.
function resolveSysContent(cmd, fallback) {
  if (cmd) {
    if (!cmd.response || !String(cmd.response).trim()) return null;
    return cmd.response;
  }
  return fallback;
}

// Tras una carga (manual o automática), ofrece al cliente el "100% de recuperación"
// para que entre a la Comunidad. NO se envía si el cliente ya está etiquetado
// 'comunidad' (ya está) o 'no comunidad' (ya dijo que no quiere) — anti-spam.
// Texto editable desde COMANDOS (/sys_recover_100); si se vacía, no se envía.
async function maybeSendRecoveryMessage(user) {
  try {
    if (!user) return;
    const tags = Array.isArray(user.tags) ? user.tags.map(t => String(t).toLowerCase()) : [];
    if (tags.includes('comunidad') || tags.includes('no comunidad')) return;
    const content = await renderSystemCommand(
      '/sys_recover_100',
      '🎁 ¿Querés reclamar el 100% de tu carga?\n\nSi jugaste y perdiste lo que cargaste, ¡podés recuperarlo! 💪\n\nPara reclamarlo: sumate a nuestra Comunidad y tené la app instalada. ✅\n\n¡Te esperamos! 🚀',
      {}
    );
    if (!content) return;
    const msg = await Message.create({
      id: uuidv4(), senderId: 'admin', senderUsername: 'Sistema', senderRole: 'admin',
      receiverId: user.id, receiverRole: 'user', content, type: 'system', timestamp: new Date(), read: false
    });
    const data = { id: msg.id, senderId: 'admin', senderUsername: 'Sistema', senderRole: 'admin', receiverId: user.id, receiverRole: 'user', content, timestamp: new Date(), type: 'system' };
    io.to(`user_${user.id}`).emit('new_message', data);
    io.to(`chat_${user.id}`).emit('new_message', data);
    notifyAdmins('new_message', { message: data, userId: user.id, username: user.username });
  } catch (e) {
    logger.warn(`[recovery-msg] ${e.message}`);
  }
}

// Agregar usuario externo
async function addExternalUser(userData) {
  try {
    const { v4: uuidv4 } = require('uuid');
    await ExternalUser.findOneAndUpdate(
      { username: userData.username },
      {
        username: userData.username,
        phone: userData.phone || null,
        whatsapp: userData.whatsapp || null,
        lastSeen: new Date(),
        $inc: { messageCount: 1 },
        $setOnInsert: { 
          id: uuidv4(),
          firstSeen: new Date() 
        }
      },
      { upsert: true, new: true }
    );
  } catch (error) {
    console.error('Error agregando usuario externo:', error);
  }
}

// Registrar actividad de usuario (para fueguito)
async function recordUserActivity(userId, type, amount) {
  try {
    const today = new Date().toDateString();
    
    await UserActivity.findOneAndUpdate(
      { userId, date: today },
      {
        $inc: { [type === 'deposit' ? 'deposits' : 'withdrawals']: amount },
        lastActivity: new Date()
      },
      { upsert: true, new: true }
    );
  } catch (error) {
    console.error('Error registrando actividad:', error);
  }
}

// Verificar si tiene actividad hoy
async function hasActivityToday(userId) {
  try {
    const today = new Date().toDateString();
    const activity = await UserActivity.findOne({ userId, date: today });
    
    if (!activity) return false;
    return (activity.deposits > 0 || activity.withdrawals > 0);
  } catch (error) {
    console.error('Error verificando actividad:', error);
    return false;
  }
}

// Funciones para fecha Argentina
function getArgentinaDateString(date = new Date()) {
  const argentinaTime = new Date(date.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  return argentinaTime.toDateString();
}

function getArgentinaYesterday() {
  const now = new Date();
  const argentinaNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  argentinaNow.setDate(argentinaNow.getDate() - 1);
  return argentinaNow.toDateString();
}

// ============================================
// COMPROBANTES — detección de reutilización con IA (anti-estafa)
// ============================================
// Normaliza una huella de comprobante para comparar duplicados (sólo alfanumérico).
function _normComprobanteKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Crea y emite un mensaje de sistema adminOnly (sólo lo ven los admins en el
// chat; el cliente NO lo recibe). Reusa el mismo patrón que la alerta de bonus.
async function _emitAdminOnlyChatNote(userId, username, content) {
  try {
    const msg = await Message.create({
      id: uuidv4(),
      senderId: 'admin',
      senderUsername: 'Sistema',
      senderRole: 'admin',
      receiverId: userId,
      receiverRole: 'user',
      content,
      type: 'system',
      adminOnly: true,
      timestamp: new Date(),
      read: false
    });
    const data = {
      id: msg.id, senderId: 'admin', senderUsername: 'Sistema', senderRole: 'admin',
      receiverId: userId, receiverRole: 'user', content, timestamp: new Date(),
      type: 'system', adminOnly: true
    };
    // Sólo a la sala del chat (admins viéndolo) + a todos los admins. NO a user_<id>.
    io.to(`chat_${userId}`).emit('new_message', data);
    notifyAdmins('new_message', { message: data, userId, username });
  } catch (e) {
    logger.warn(`[comprobante] no se pudo emitir aviso admin: ${e.message}`);
  }
}

// Analiza una imagen enviada por un cliente: detecta si es comprobante, lo
// registra (colección Comprobante) y avisa SÓLO a los admins si es duplicado o
// no. Pensado para correr fire-and-forget: NUNCA frena la entrega del mensaje.
async function analyzeComprobanteFromMessage({ userId, username, content, messageId }) {
  try {
    if (!comprobanteAi.isEnabled()) return; // sin ANTHROPIC_API_KEY → dormido
    const result = await comprobanteAi.analyzeComprobante(content);

    // La IA no pudo analizar (error técnico): registrar y salir en silencio.
    if (!result.ok) {
      try {
        await Comprobante.create({
          id: uuidv4(), userId, username, messageId,
          isComprobante: false, status: 'error',
          errorReason: String(result.error || '').slice(0, 300),
          rawText: result.rawText || null, model: comprobanteAi.getModel(), createdAt: new Date()
        });
      } catch (_) {}
      return;
    }

    // No es comprobante (captura de error, foto cualquiera): registrar liviano, sin avisar.
    if (!result.isComprobante) {
      try {
        await Comprobante.create({
          id: uuidv4(), userId, username, messageId,
          isComprobante: false, aiConfidence: result.confidence || 0,
          status: 'not_comprobante', rawText: result.rawText || null,
          model: result.model, createdAt: new Date()
        });
      } catch (_) {}
      return;
    }

    // Huella de la IMAGEN (SHA-256). Detecta re-envíos de la misma imagen al 100%,
    // sin depender de la lectura OCR (que puede variar entre envíos). Sólo para
    // imágenes base64 (data:) — capturas; para URLs https no hay bytes a mano.
    let imageHash = null;
    try {
      if (typeof content === 'string' && content.startsWith('data:')) {
        const m = content.match(/;base64,(.*)$/s);
        if (m) imageHash = crypto.createHash('sha256').update(m[1]).digest('hex');
      }
    } catch (_) {}

    // Es comprobante → armar huella para dedupe (N° de operación; si no, combo).
    let opKey = _normComprobanteKey(result.operationNumber);
    // Defensa anti falso-duplicado: si el "N° de operación" es en realidad un CBU/cuenta
    // o un CUIT/CUIL, NO lo usamos como huella — esos datos se REPITEN entre transferencias
    // distintas y marcan duplicados falsos. Caso real: la IA leía el CUIT del destino
    // (ej. 30-71876498-6) como "N° de operación" → todos los comprobantes a ese destino
    // chocaban entre sí y se reportaban como "ya utilizado por" el primero que lo mandó.
    const _destDig = _digits(result.destCbu);
    const _origDig = _digits(result.originCbu);
    const _rawOp = String(result.operationNumber || '').replace(/\s/g, '');
    // CUIT/CUIL = 11 dígitos con prefijo válido (20/23/24/27/30/33/34), con o sin guiones.
    const _looksLikeCuit = /^(20|23|24|27|30|33|34)-?\d{8}-?\d$/.test(_rawOp) || /^(20|23|24|27|30|33|34)\d{9}$/.test(opKey);
    if (opKey && (
      (_destDig && opKey === _destDig) ||
      (_origDig && opKey === _origDig) ||
      /^\d{18,}$/.test(opKey) ||
      _looksLikeCuit
    )) {
      opKey = '';
    }
    let dedupeKey = opKey || null;
    // Fallback: combo que incluye el NOMBRE de origen (más único que el CBU repetido).
    if (!dedupeKey && result.amount && (result.originHolder || result.originCbu || result.paymentDate)) {
      dedupeKey = _normComprobanteKey(`${result.amount}|${result.originHolder || ''}|${result.originCbu || ''}|${result.paymentDate || ''}`);
    }

    const base = {
      id: uuidv4(), userId, username, messageId,
      isComprobante: true, aiConfidence: result.confidence || 0,
      operationNumber: result.operationNumber || null,
      amount: result.amount, originHolder: result.originHolder || null,
      originCbu: result.originCbu || null,
      destHolder: result.destHolder || null, destCbu: result.destCbu || null,
      bank: result.bank || null,
      paymentDate: result.paymentDate || null, rawText: result.rawText || null,
      dedupeKey, imageHash, model: result.model, createdAt: new Date()
    };

    const montoStr = result.amount ? `$${Number(result.amount).toLocaleString('es-AR')}` : 's/monto';
    const opStr = result.operationNumber ? `op. N°${result.operationNumber}` : 's/N° operación';
    const dataDesc = `${opStr} · ${montoStr}${result.paymentDate ? ' · ' + result.paymentDate : ''}`;

    // Buscar un comprobante ANTERIOR duplicado: por IMAGEN idéntica (imageHash) O por
    // huella de datos (dedupeKey). El hash de imagen se chequea SIEMPRE (aunque no haya
    // N° de operación), así un re-envío de la misma imagen se detecta igual.
    const dupOr = [];
    if (imageHash) dupOr.push({ imageHash });
    if (dedupeKey) dupOr.push({ dedupeKey });
    let original = null;
    if (dupOr.length) {
      try {
        original = await Comprobante.findOne({ isComprobante: true, $or: dupOr })
          .sort({ createdAt: 1 }).lean();
      } catch (e) {
        logger.warn(`[comprobante] error buscando duplicado: ${e.message}`);
      }
    }

    if (original) {
      const sameUser = String(original.userId) === String(userId);
      try {
        await Comprobante.create({
          ...base, status: 'duplicate',
          duplicateOfUserId: original.userId || null,
          duplicateOfUsername: original.username || null,
          duplicateOfComprobanteId: original.id || null
        });
      } catch (_) {}
      if (sameUser) {
        await _emitAdminOnlyChatNote(userId, username,
          `🧾 Comprobante REPETIDO (${dataDesc}). El propio cliente ya lo había enviado antes. Revisá antes de cargar.`);
      } else {
        await _emitAdminOnlyChatNote(userId, username,
          `🚨 COMPROBANTE YA UTILIZADO POR: @${original.username || original.userId}\n${dataDesc}\n⚠️ Ya lo había enviado otro usuario. NO cargar sin verificar.`);
      }
      return;
    }

    // No es duplicado. Si tenemos alguna huella (datos o imagen) → verificado OK.
    // Si no hay NINGUNA (ni N° de operación ni hash de imagen) → avisar verificá a mano.
    const hasDedup = !!dedupeKey || !!imageHash;
    const status = dedupeKey ? 'unique' : 'no_key';
    try { await Comprobante.create({ ...base, status }); } catch (_) {}
    if (hasDedup) {
      await _emitAdminOnlyChatNote(userId, username,
        `✅ Comprobante verificado — no es duplicado (${dataDesc}).`);
    } else {
      await _emitAdminOnlyChatNote(userId, username,
        `🧾 Comprobante recibido (${dataDesc}). ⚠️ No se pudieron extraer datos para chequear duplicado — verificá a mano.`);
    }
    // Banco automático: si fue al CBU con API, intentar matchear + cargar.
    hgcashMatchFromComprobante({ ...base, status }).catch(() => {});
  } catch (e) {
    // Defensa total: este análisis NUNCA debe romper nada del chat.
    logger.warn(`[comprobante] analyzeComprobanteFromMessage falló: ${e.message}`);
  }
}

// ============================================
// BANCO AUTOMÁTICO (hgcash / Urbana) — carga automática por match de comprobante
// ============================================
// Config en Config['hgcash']:
//   { enabled, cbu, accountId, mode ('shadow'|'auto'), windowMinutes, currency }
//   enabled=false → TODO apagado. mode='shadow' → matchea y avisa pero NO carga.
// El secreto de firma del webhook va en process.env.HGCASH_WEBHOOK_SECRET (SSM).
// Nota: el payload real de hgcash NO trae CBUs (sólo fromName/toName/amount/status/
// externalID). Por eso el matcheo es por monto + NOMBRE de origen + ventana de tiempo,
// con guard de ambigüedad. `accountName` = el toName de tu cuenta hgcash (ej. el titular)
// para confirmar que el comprobante fue a tu banco con API. `acceptStatuses` = estados del
// movimiento que cuentan como acreditado (hgcash manda status:"done").
// windowMinutes: ventana para el matcheo DESDE el comprobante (el cliente manda el
//   comprobante y se busca su transferencia pendiente — el disparador principal).
// raceWindowMinutes: ventana CORTA para el matcheo DESDE la transferencia (solo cubre
//   el caso raro en que el comprobante llega segundos ANTES que el webhook). Mantenerla
//   chica evita que una transferencia nueva cargue contra un comprobante viejo/sobrante.
const HGCASH_DEFAULTS = { enabled: false, cbu: '', accountId: '', accountName: '', mode: 'shadow', windowMinutes: 60, raceWindowMinutes: 10, currency: 'ARS', acceptStatuses: ['done'], duplicateGuardMinutes: 8, minChargeARS: 2000 };

async function getHgcashConfig() {
  const cfg = await getConfig('hgcash', null);
  const merged = Object.assign({}, HGCASH_DEFAULTS, cfg || {});
  if (!Array.isArray(merged.acceptStatuses) || merged.acceptStatuses.length === 0) merged.acceptStatuses = ['done'];
  return merged;
}

// Sólo dígitos (para comparar CBUs sin importar formato/espacios).
function _digits(s) { return String(s || '').replace(/\D/g, ''); }

// Igualdad de montos en centavos (evita errores de coma flotante).
function _amountsEqual(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
}

// Normaliza un nombre para comparar (mayúsculas, sin acentos, sin puntuación, espacios simples).
function _normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ¿Coinciden dos nombres? Igual normalizado, o uno contiene al otro (≥5 chars).
function _nameMatch(a, b) {
  const na = _normName(a), nb = _normName(b);
  if (!na || !nb || na.length < 5 || nb.length < 5) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// ¿El estado del movimiento cuenta como acreditado?
function _statusAccredited(status, cfg) {
  const list = (cfg.acceptStatuses || ['done']).map(s => String(s).toLowerCase());
  return list.includes(String(status || '').toLowerCase());
}

// ¿El comprobante apunta a NUESTRA cuenta hgcash? (por CBU si lo hubiera, o por nombre de cuenta)
function _comprobanteToOurBank(comprobante, cfg) {
  const cfgCbu = _digits(cfg.cbu);
  if (cfgCbu && _digits(comprobante.destCbu) === cfgCbu) return true;
  if (cfg.accountName && _nameMatch(comprobante.destHolder, cfg.accountName)) return true;
  return false;
}

// ¿El destino confirma nuestra cuenta, O el comprobante no muestra destino?
// Muchos comprobantes no muestran el CBU/nombre de destino. Como el webhook de
// hgcash es prueba REAL de que la plata entró a NUESTRA cuenta, aceptamos el match
// también cuando el comprobante no trae datos de destino (con el guard de
// ambigüedad + monto + nombre de origen + ventana, el riesgo es mínimo).
function _destOkOrUnknown(comprobante, cfg) {
  if (_comprobanteToOurBank(comprobante, cfg)) return true;
  return !comprobante.destHolder && !comprobante.destCbu;
}

// ¿El destino del comprobante es consistente con el del movimiento (o no se sabe)?
// Usa el destino REAL del movimiento (toName/toCBU de la cuenta hgcash que recibió),
// así funciona para CUALQUIER cuenta hgcash sin depender de la config. Si el
// comprobante no muestra destino, se acepta (el movimiento ya prueba que entró a
// nuestra cuenta).
function _destConsistentOk(comprobante, movement, cfg) {
  if (!comprobante.destHolder && !comprobante.destCbu) return true;
  if (movement) {
    if (comprobante.destCbu && movement.toCBU && _digits(comprobante.destCbu) === _digits(movement.toCBU)) return true;
    if (comprobante.destHolder && movement.toName && _nameMatch(comprobante.destHolder, movement.toName)) return true;
  }
  if (_comprobanteToOurBank(comprobante, cfg)) return true;
  return false;
}

// ¿Este comprobante corresponde a ESTE movimiento entrante? Debe coincidir el MONTO y,
// además, UNO de estos (en orden de fuerza):
//   (1) N° de transacción del comprobante == coelsaCode/externalID del movimiento.
//       Es DEFINITIVO y funciona para cualquier banco (no necesita el nombre del que envía).
//   (2) Nombre de ORIGEN del comprobante == fromName del movimiento, con destino consistente.
// Si no se cumple ninguno → no es match (queda manual).
function _comprobanteMatchesMovement(comprobante, movement, cfg) {
  if (!_amountsEqual(comprobante.amount, movement.amount)) return false;

  // (1) Match definitivo por número de transacción / coelsa.
  const opKey = _normComprobanteKey(comprobante.operationNumber);
  if (opKey && opKey.length >= 6) {
    const coelsa = _normComprobanteKey(movement.coelsaCode);
    const ext = _normComprobanteKey(movement.externalId);
    if (coelsa && coelsa === opKey) return true;
    if (ext && opKey.length >= 8 && ext.includes(opKey)) return true;
  }

  // (2) Fallback por nombre de origen + destino consistente.
  if (comprobante.originHolder && movement.fromName &&
      _nameMatch(comprobante.originHolder, movement.fromName) &&
      _destConsistentOk(comprobante, movement, cfg)) {
    return true;
  }
  return false;
}

// Maneja un fallo de auto-carga (JUGAYGANA caído, etc.) de forma REINTENTABLE:
// cuenta el intento y, si no superó el tope (3), devuelve el movimiento a 'pending'
// para que un nuevo comprobante pueda reintentar. Pasado el tope, lo deja en 'error'
// (carga manual). El comprobante vuelve a 'pending' para no quedar consumido.
const HGCASH_MAX_CHARGE_ATTEMPTS = 3;
async function hgcashHandleChargeFailure(movement, comprobante, errMsg, dataDesc, user) {
  let attempts = (movement.chargeAttempts || 0) + 1;
  try {
    const upd = await BankMovement.findOneAndUpdate(
      { movementId: movement.movementId },
      { $inc: { chargeAttempts: 1 }, $set: { chargeError: String(errMsg || '').slice(0, 300) } },
      { new: true }
    );
    if (upd && typeof upd.chargeAttempts === 'number') attempts = upd.chargeAttempts;
  } catch (_) {}
  const terminal = attempts >= HGCASH_MAX_CHARGE_ATTEMPTS;
  await BankMovement.updateOne({ movementId: movement.movementId }, { $set: { matchStatus: terminal ? 'error' : 'pending' } });
  await Comprobante.updateOne({ id: comprobante.id }, { $set: { bankMatchStatus: 'pending' } });
  if (user) {
    const prefijo = terminal ? `Se agotaron los ${HGCASH_MAX_CHARGE_ATTEMPTS} intentos automáticos. ` : '';
    await _emitAdminOnlyChatNote(user.id, user.username,
      `🏦 MATCH hgcash — ${dataDesc}\n⚠️ La AUTO-CARGA FALLÓ en JUGAYGANA (${errMsg || 's/detalle'}). ${prefijo}Cargá MANUAL a este usuario por el mismo monto: al hacerlo se marca como usado (no se duplica).`);
  }
}

// Cuando un operador carga MANUAL a un usuario, si había un movimiento hgcash
// matcheado a ese usuario por el MISMO monto (que no se pudo auto-cargar), lo
// marcamos como `manual_charged` y consumimos el comprobante. Así esa transferencia
// /foto NO vuelve a auto-cargar cuando JUGAYGANA se recupere (evita doble carga).
async function hgcashConsumeOnManualDeposit(userId, username, amount) {
  try {
    const cfg = await getHgcashConfig();
    if (!cfg.enabled) return false;
    if (!userId || !(Number(amount) > 0)) return false;

    // Candidatos: movimientos matcheados a ese usuario, todavía no cargados.
    // Incluye 'needs_review' (frenados por la red de seguridad) para que, si el
    // agente confirma y carga a mano, ese movimiento quede consumido y no quede
    // colgado como pendiente en el panel.
    const cands = await BankMovement.find({
      matchedUserId: userId,
      matchStatus: { $in: ['pending', 'error', 'needs_review'] }
    }).sort({ createdAt: -1 }).limit(10).lean();
    const target = cands.find(m => _amountsEqual(m.amount, amount));
    if (!target) return false;

    // Claim atómico (evita choque con un reintento automático).
    const claimed = await BankMovement.findOneAndUpdate(
      { movementId: target.movementId, matchStatus: { $in: ['pending', 'error', 'needs_review'] } },
      { $set: { matchStatus: 'manual_charged', chargedAt: new Date() } },
      { new: true }
    );
    if (!claimed) return false;

    if (target.matchedComprobanteId) {
      await Comprobante.updateOne({ id: target.matchedComprobanteId },
        { $set: { bankMatchStatus: 'manual_charged', autoCharged: true } });
    }
    await _emitAdminOnlyChatNote(userId, username,
      `🏦 Transferencia hgcash marcada como CARGADA MANUAL ($${Number(target.amount).toLocaleString('es-AR')}). Ese comprobante no se va a auto-cargar de nuevo.`);
    logger.info(`[hgcash] movimiento ${target.movementId} → manual_charged (carga manual de ${username})`);
    return true;
  } catch (e) {
    logger.warn(`[hgcash] consume on manual deposit falló: ${e.message}`);
    return false;
  }
}

// Guarda el accountId de nuestra cuenta hgcash en la config si todavía no está
// (lo necesitamos para los pagos salientes / cash-out).
async function ensureHgcashAccountIdSaved(accountId) {
  try {
    const cfg = await getHgcashConfig();
    if (!cfg.accountId && accountId) {
      await setConfig('hgcash', Object.assign({}, cfg, { accountId: String(accountId) }));
      logger.info(`[hgcash] accountId auto-guardado: ${accountId}`);
    }
  } catch (_) {}
}

// Avisa al cliente (y a los admins) que su retiro fue pagado. El texto es editable
// desde COMANDOS (/sys_payout_paid); si se vacía ese comando, no se envía nada.
async function notifyPayoutPaid(payout) {
  try {
    const content = await renderSystemCommand(
      '/sys_payout_paid',
      '💸✅ ¡Tu retiro de ${amount} fue enviado a tu cuenta! Puede tardar unos minutos en acreditarse.',
      { amount: Number(payout.amount).toLocaleString('es-AR') }
    );
    if (!content) return; // comando vaciado a propósito → no enviar
    const msg = await Message.create({
      id: uuidv4(), senderId: 'admin', senderUsername: 'Sistema', senderRole: 'admin',
      receiverId: payout.userId, receiverRole: 'user', content, type: 'system', timestamp: new Date(), read: false
    });
    const data = { id: msg.id, senderId: 'admin', senderUsername: 'Sistema', senderRole: 'admin', receiverId: payout.userId, receiverRole: 'user', content, timestamp: new Date(), type: 'system' };
    io.to(`user_${payout.userId}`).emit('new_message', data);
    io.to(`chat_${payout.userId}`).emit('new_message', data);
    notifyAdmins('new_message', { message: data, userId: payout.userId, username: payout.username });
  } catch (e) {
    logger.warn(`[hgcash-pay] notifyPayoutPaid falló: ${e.message}`);
  }
}

// Resuelve el id de la TRANSACCIÓN real (para el comprobante PDF) a partir del payout.
// Usa el hgTxId si ya lo tenemos; si no, lo pide a la API con el id del REQUEST
// (que guardamos en hgTransactionId) y lo cachea. Devuelve null si todavía no está.
async function resolvePayoutTxId(payout) {
  if (!payout) return null;
  if (payout.hgTxId) return payout.hgTxId;
  const reqId = payout.hgTransactionId; // ojo: este campo guarda el id del REQUEST del cash-out
  if (!reqId) return null;
  try {
    const r = await hgcashPay.getTransactionIdForRequest(reqId);
    if (r.ok && r.transactionId) {
      const txId = String(r.transactionId);
      try { await PendingPayout.updateOne({ id: payout.id }, { $set: { hgTxId: txId } }); } catch (_) {}
      return txId;
    }
  } catch (_) {}
  return null;
}

// Envía AUTOMÁTICAMENTE el comprobante PDF del pago al cliente cuando el retiro se
// confirma (DONE). El mensaje lleva un link PERMANENTE nuestro (/api/payout-receipt/:id)
// que en cada click resuelve un signedUrl fresco de hgcash (la URL firmada vence en 1h,
// por eso no la mandamos directa). Idempotente: marca receiptSentAt y reclama atómico
// para no enviar dos veces (webhook DONE + pago inmediato).
async function maybeSendPayoutReceipt(payout) {
  try {
    if (!hgcashPay.isEnabled()) return;
    let cur = await PendingPayout.findOne({ id: payout.id }).lean();
    if (!cur || cur.receiptSentAt) return;

    // El id de transacción puede tardar unos segundos en asociarse: reintentar.
    let txId = await resolvePayoutTxId(cur);
    for (let i = 0; i < 3 && !txId; i++) {
      await new Promise(r => setTimeout(r, 4000));
      cur = await PendingPayout.findOne({ id: payout.id }).lean();
      if (!cur || cur.receiptSentAt) return;
      txId = await resolvePayoutTxId(cur);
    }
    if (!txId) { logger.warn(`[hgcash-pay] sin txId para comprobante payout=${payout.id} (se omite el envío)`); return; }

    // Reclamo atómico del envío (no duplicar entre webhook y pago inmediato).
    const claimed = await PendingPayout.findOneAndUpdate(
      { id: payout.id, receiptSentAt: null },
      { $set: { receiptSentAt: new Date() } }, { new: true }
    );
    if (!claimed) return; // otro proceso ya lo envió

    // Helper para emitir un mensaje del sistema al cliente (chat + socket + admins).
    const _sendClientMsg = async (content, type) => {
      const msg = await Message.create({
        id: uuidv4(), senderId: 'admin', senderUsername: 'Sistema', senderRole: 'admin',
        receiverId: payout.userId, receiverRole: 'user', content, type, timestamp: new Date(), read: false
      });
      const data = { id: msg.id, senderId: 'admin', senderUsername: 'Sistema', senderRole: 'admin', receiverId: payout.userId, receiverRole: 'user', content, timestamp: new Date(), type };
      io.to(`user_${payout.userId}`).emit('new_message', data);
      io.to(`chat_${payout.userId}`).emit('new_message', data);
      notifyAdmins('new_message', { message: data, userId: payout.userId, username: payout.username });
    };

    // 1) Mandar el comprobante COMO FOTO (rasterizar la 1ª página del PDF). Best-effort:
    //    si falla (dep opcional ausente, error de descarga/render, imagen muy grande),
    //    se manda sólo el link. Nunca rompe el flujo de pago.
    let photoSent = false;
    try {
      const pdf = await hgcashPay.fetchReceiptPdf(txId);
      if (pdf.ok && pdf.buffer && pdf.buffer.length) {
        const png = await pdfImage.pdfBufferToPng(pdf.buffer);
        if (png && png.length && png.length < 4 * 1024 * 1024) {
          await _sendClientMsg(`data:image/png;base64,${png.toString('base64')}`, 'image');
          photoSent = true;
        }
      }
    } catch (e) {
      logger.warn(`[hgcash-pay] comprobante como foto falló (se manda link): ${e.message}`);
    }

    // 2) Link al PDF oficial (siempre). Si no se pudo mandar la foto, este es el comprobante principal.
    const link = `${PUBLIC_BASE_URL}/api/payout-receipt/${payout.id}`;
    const linkMsg = photoSent
      ? `🧾 Comprobante oficial (PDF): ${link}`
      : `🧾✅ Comprobante de tu pago de $${Number(payout.amount).toLocaleString('es-AR')}:\n${link}`;
    await _sendClientMsg(linkMsg, 'system');
    logger.info(`[hgcash-pay] comprobante enviado a ${payout.username} payout=${payout.id} txId=${txId} foto=${photoSent}`);
  } catch (e) {
    logger.warn(`[hgcash-pay] maybeSendPayoutReceipt falló: ${e.message}`);
  }
}

// Procesa el webhook de estado de un cash-out (pago saliente). Matchea por externalID
// (que es nuestro payout.id) o por el id de la transacción hgcash.
async function handlePayoutStatusWebhook(p) {
  try {
    const status = String(p.status || '').toUpperCase();
    const ext = p.externalID ? String(p.externalID) : null;
    const hgId = p.id ? String(p.id) : null;
    const query = ext ? { id: ext } : (hgId ? { hgTransactionId: hgId } : null);
    if (!query) return;
    const payout = await PendingPayout.findOne(query);
    if (!payout) {
      logger.warn(`[hgcash-pay] webhook de pago sin payout local: ext=${ext} hgId=${hgId} status=${status}`);
      return;
    }
    // Guardar el hgTransactionId si todavía no lo teníamos.
    if (hgId && !payout.hgTransactionId) {
      await PendingPayout.updateOne({ id: payout.id }, { $set: { hgTransactionId: hgId } });
    }
    // El webhook 'transaction_associated' trae el id de la TRANSACCIÓN real (≠ request)
    // → lo guardamos para poder pedir el comprobante PDF.
    if (p.transactionId && !payout.hgTxId) {
      await PendingPayout.updateOne({ id: payout.id }, { $set: { hgTxId: String(p.transactionId) } });
      payout.hgTxId = String(p.transactionId);
    }

    if (status === 'DONE') {
      if (payout.status === 'paid') return; // idempotente
      await PendingPayout.updateOne({ id: payout.id }, { $set: { status: 'paid', hgStatus: status, paidAt: new Date() } });
      await notifyPayoutPaid(payout);
      maybeSendPayoutReceipt(payout).catch(() => {}); // comprobante PDF automático (con reintentos)
      logger.info(`[hgcash-pay] PAGADO payout=${payout.id} user=${payout.username} $${payout.amount}`);
    } else if (status === 'ERROR' || status === 'CANCELLED') {
      const reason = p.errorCode || p.error || status;
      await PendingPayout.updateOne({ id: payout.id }, { $set: { status: 'failed', hgStatus: status, error: String(reason).slice(0, 300) } });
      // Si las fichas ya se descontaron (flujo nuevo confirmado), aclararlo: NO devolver.
      const yaDescontado = (payout.deductAtPay === true && payout.debitConfirmed === true);
      await _emitAdminOnlyChatNote(payout.userId, payout.username,
        `💸 ⚠️ El PAGO automático FALLÓ en hgcash (${reason}) — $${Number(payout.amount).toLocaleString('es-AR')} a ${payout.titular || payout.cbu}. ` +
        (yaDescontado ? 'Las fichas YA fueron descontadas: NO devuelvas. Pagá manual ("otro banco") o reintentá.' : 'Revisá y pagá manual.'));
      logger.warn(`[hgcash-pay] FALLÓ payout=${payout.id} status=${status} reason=${reason}`);
    } else {
      // PENDING / AWAITING_REVIEW / PROCESSING → sólo actualizar hgStatus.
      await PendingPayout.updateOne({ id: payout.id }, { $set: { hgStatus: status } });
    }
  } catch (e) {
    logger.warn(`[hgcash-pay] handlePayoutStatusWebhook falló: ${e.message}`);
  }
}

// Avisa al panel (en vivo) que hubo un cambio en los movimientos hgcash, para que
// refresque la tabla sin recargar. Fire-and-forget; nunca rompe nada.
function _emitHgcashUpdate(kind) {
  try { notifyAdmins('hgcash_movement', { kind: kind || 'update', at: Date.now() }); } catch (_) {}
}

// Acredita la carga (modo 'auto') o sólo avisa (modo 'shadow'). Reclama de forma
// ATÓMICA el movimiento Y el comprobante para que nunca se cargue dos veces.
async function hgcashAutoCarga({ movement, comprobante, mode }) {
  const shadow = mode !== 'auto';

  // 1) Reclamar el movimiento (pending → claiming).
  const movClaim = await BankMovement.findOneAndUpdate(
    { movementId: movement.movementId, matchStatus: 'pending' },
    { $set: { matchStatus: 'claiming' } }, { new: true }
  );
  if (!movClaim) return; // ya lo tomó otro proceso

  // 2) Reclamar el comprobante (no cargado/tomado todavía).
  const compClaim = await Comprobante.findOneAndUpdate(
    { id: comprobante.id, autoCharged: { $ne: true }, bankMatchStatus: { $nin: ['claiming', 'auto_charged', 'shadow_matched'] } },
    { $set: { bankMatchStatus: 'claiming', toApiBank: true } }, { new: true }
  );
  if (!compClaim) {
    // El comprobante ya fue tomado por otro movimiento → devolver el movimiento.
    await BankMovement.updateOne({ movementId: movement.movementId }, { $set: { matchStatus: 'pending' } });
    return;
  }

  const user = await User.findOne({ id: comprobante.userId });
  if (!user) {
    await BankMovement.updateOne({ movementId: movement.movementId }, { $set: { matchStatus: 'error', chargeError: 'usuario no encontrado' } });
    await Comprobante.updateOne({ id: comprobante.id }, { $set: { bankMatchStatus: 'pending' } });
    return;
  }

  // Registrar a quién matcheó el movimiento (sirve para reconciliar y para que una
  // carga MANUAL a este usuario consuma el movimiento aunque la auto-carga falle).
  try {
    await BankMovement.updateOne({ movementId: movement.movementId },
      { $set: { matchedUserId: user.id, matchedUsername: user.username, matchedComprobanteId: comprobante.id } });
  } catch (_) {}

  const amount = movement.amount;
  const opDesc = `op. hgcash ${movement.coelsaCode || movement.externalId || movement.movementId}`;
  const dataDesc = `$${Number(amount).toLocaleString('es-AR')} · ${movement.fromName || movement.fromCBU || 's/origen'} · ${opDesc}`;

  // Modo sombra: NO cargar, sólo avisar al admin que el match está listo.
  if (shadow) {
    await BankMovement.updateOne({ movementId: movement.movementId }, {
      $set: { matchStatus: 'shadow_matched', matchedUserId: user.id, matchedUsername: user.username, matchedComprobanteId: comprobante.id }
    });
    await Comprobante.updateOne({ id: comprobante.id }, { $set: { bankMatchStatus: 'shadow_matched', matchedMovementId: movement.movementId } });
    await _emitAdminOnlyChatNote(user.id, user.username,
      `🏦 MATCH hgcash (MODO SOMBRA) — ${dataDesc}\n✅ La transferencia coincide con el comprobante. Lista para cargar (auto-carga DESACTIVADA — cargá vos).`);
    logger.info(`[hgcash] shadow match user=${user.username} amount=$${amount} movement=${movement.movementId}`);
    return;
  }

  // ── MÍNIMO DE CARGA ──────────────────────────────────────────────────────
  // Si la transferencia es MENOR al mínimo del casino, NO se carga automático.
  // El comprobante quedó verificado igual: se avisa al agente para que le pida al
  // cliente la diferencia y, cuando llegue, se cargue la suma a mano. Se deja el
  // movimiento en needs_review (lo consume la carga manual; no se pierde plata).
  try {
    const _minCfg = await getHgcashConfig();
    const minCharge = Number(_minCfg.minChargeARS) > 0 ? Number(_minCfg.minChargeARS) : 2000;
    if (Number(amount) < minCharge) {
      await BankMovement.updateOne({ movementId: movement.movementId },
        { $set: { matchStatus: 'needs_review', matchedUserId: user.id, matchedUsername: user.username, matchedComprobanteId: comprobante.id, chargeError: `monto $${Number(amount)} menor al mínimo $${minCharge}` } });
      await Comprobante.updateOne({ id: comprobante.id }, { $set: { bankMatchStatus: 'needs_review', matchedMovementId: movement.movementId } });
      await _emitAdminOnlyChatNote(user.id, user.username,
        `🏦 ✅ Comprobante CORRECTO (${dataDesc}) — PERO el monto es menor al mínimo de carga ($${minCharge.toLocaleString('es-AR')}). NO se cargó automático.\n👉 Pedile al cliente que envíe la diferencia para llegar al mínimo y cargá la suma a mano.`);
      logger.info(`[hgcash] bajo mínimo user=${user.username} $${amount} < $${minCharge} mov=${movement.movementId}`);
      return;
    }
  } catch (minErr) {
    logger.warn(`[hgcash] chequeo de mínimo falló (sigue la carga): ${minErr.message}`);
  }

  // ── IDEMPOTENCIA POR TRANSFERENCIA REAL (coelsa) ─────────────────────────
  // Candado ATÓMICO entre instancias: la MISMA transferencia (mismo coelsaCode)
  // se acredita UNA sola vez, sin importar cuántos movimientos/comprobantes haya.
  // Si hgcash reenvía el movimiento con otro id (o hay 2 docs del mismo recibo),
  // el segundo intento choca con el índice único y NO se carga de nuevo.
  const chargeKey = String(movement.coelsaCode || movement.externalId || '').trim();
  let chargeLocked = false;
  if (chargeKey) {
    try {
      await HgcashCharge.create({
        chargeKey, userId: user.id, username: user.username,
        amount: Number(amount), movementId: movement.movementId, comprobanteId: comprobante.id
      });
      chargeLocked = true;
    } catch (lockErr) {
      if (lockErr && lockErr.code === 11000) {
        // Esta transferencia YA fue acreditada → NO recargar (duplicado real).
        await BankMovement.updateOne({ movementId: movement.movementId },
          { $set: { matchStatus: 'duplicate', matchedUserId: user.id, matchedUsername: user.username, matchedComprobanteId: comprobante.id, chargeError: `duplicado: coelsa ${chargeKey} ya acreditada` } });
        await Comprobante.updateOne({ id: comprobante.id }, { $set: { bankMatchStatus: 'duplicate' } });
        await _emitAdminOnlyChatNote(user.id, user.username,
          `🏦 ⚠️ Movimiento DUPLICADO de la misma transferencia (coelsa ${chargeKey}) — NO se cargó de nuevo (ya estaba acreditado).`);
        logger.warn(`[hgcash] DUPLICADO bloqueado coelsa=${chargeKey} user=${user.username} mov=${movement.movementId}`);
        return;
      }
      // Otro error de DB: no bloqueamos la carga por eso (la red de seguridad de abajo igual protege).
      logger.warn(`[hgcash] no se pudo crear el candado de carga (coelsa=${chargeKey}): ${lockErr.message}`);
    }
  }

  // ── RED DE SEGURIDAD ─────────────────────────────────────────────────────
  // ¿Ya hubo una carga del MISMO monto a este usuario hace pocos minutos (manual
  // o automática)? Cubre el caso "el agente cargó a mano y DESPUÉS llega el aviso
  // del banco" (no hay coelsa que linkee la manual) y cualquier duplicado sin
  // coelsa confiable. No carga sola: la deja para revisión manual (nunca pierde
  // plata, sólo pide confirmar si son 2 transferencias reales).
  try {
    const _hgCfg = await getHgcashConfig();
    const guardMin = Number(_hgCfg.duplicateGuardMinutes) >= 0 ? Number(_hgCfg.duplicateGuardMinutes) : 8;
    if (guardMin > 0) {
      const sinceGuard = new Date(Date.now() - guardMin * 60 * 1000);
      const recent = await Transaction.findOne({
        userId: user.id, type: 'deposit', amount: Number(amount), timestamp: { $gte: sinceGuard }
      }).lean();
      if (recent) {
        if (chargeLocked) { try { await HgcashCharge.deleteOne({ chargeKey }); } catch (_) {} }
        await BankMovement.updateOne({ movementId: movement.movementId },
          { $set: { matchStatus: 'needs_review', matchedUserId: user.id, matchedUsername: user.username, matchedComprobanteId: comprobante.id, chargeError: `posible duplicado: ya hubo carga de $${Number(amount)} hace <${guardMin}min` } });
        await Comprobante.updateOne({ id: comprobante.id }, { $set: { bankMatchStatus: 'needs_review' } });
        await _emitAdminOnlyChatNote(user.id, user.username,
          `🏦 ⚠️ POSIBLE DUPLICADO — a este cliente ya se le cargó $${Number(amount).toLocaleString('es-AR')} hace pocos minutos. NO se cargó automático.\nVerificá si son DOS transferencias REALES (dos comprobantes con N° distinto) y, si corresponde, cargá a mano.`);
        logger.warn(`[hgcash] HOLD posible duplicado user=${user.username} $${amount} mov=${movement.movementId}`);
        return;
      }
    }
  } catch (guardErr) {
    logger.warn(`[hgcash] red de seguridad falló (sigue la carga): ${guardErr.message}`);
  }

  // Modo auto: cargar de verdad en JUGAYGANA.
  let charged = false; // true una vez que la acreditación se confirmó (evita reintentos que dupliquen)
  try {
    const result = await jugaygana.depositToUser(user.username, Number(amount), 'Carga automática (hgcash)', user.jugayganaUserId || null);
    if (!result.success) {
      if (chargeLocked) { try { await HgcashCharge.deleteOne({ chargeKey }); } catch (_) {} }
      await hgcashHandleChargeFailure(movClaim || movement, comprobante, result.error || 'fallo deposit', dataDesc, user);
      return;
    }

    await BankMovement.updateOne({ movementId: movement.movementId }, {
      $set: { matchStatus: 'auto_charged', matchedUserId: user.id, matchedUsername: user.username, matchedComprobanteId: comprobante.id, chargedAt: new Date() }
    });
    await Comprobante.updateOne({ id: comprobante.id }, { $set: { bankMatchStatus: 'auto_charged', matchedMovementId: movement.movementId, autoCharged: true } });
    charged = true; // ya acreditó: cualquier error posterior NO debe disparar reintento

    try { await recordUserActivity(user.id, 'deposit', Number(amount)); } catch (_) {}
    await Transaction.create({
      id: uuidv4(), type: 'deposit', amount: Number(amount),
      username: user.username, userId: user.id,
      description: `Carga automática hgcash (${opDesc})`,
      adminUsername: 'auto-hgcash', adminRole: 'system',
      transactionId: result.data?.transfer_id || result.data?.transferId,
      metadata: { source: 'auto_hgcash', movementId: movement.movementId, comprobanteId: comprobante.id },
      timestamp: new Date()
    });

    // Mensaje al cliente (usa /sys_deposit si está; si no, fallback).
    let newBalance = null;
    try {
      const balRes = await jugayganaMovements.getUserBalanceWithRetry(user.username);
      if (balRes.success) newBalance = balRes.balance;
    } catch (_) {}
    const balStr = newBalance !== null ? `$${newBalance}` : 'actualizándose 🔄';
    const depositCmd = await Command.findOne({ name: '/sys_deposit', isActive: true });
    const depositTpl = resolveSysContent(depositCmd, `🔒💰 Depósito de $${Number(amount).toLocaleString('es-AR')} acreditado con éxito. ✅\n💸 Tu nuevo saldo es ${balStr} 💸`);
    if (depositTpl) { // null = comando vaciado a propósito → no enviar mensaje al cliente
      const clientMsg = depositTpl.replace(/\{amount\}/g, Number(amount)).replace(/\{bonus\}/g, 0).replace(/\{balance\}/g, newBalance !== null ? newBalance : 'actualizándose');
      const sysMsg = await Message.create({
        id: uuidv4(), senderId: 'admin', senderUsername: 'Sistema', senderRole: 'admin',
        receiverId: user.id, receiverRole: 'user', content: clientMsg, type: 'system', timestamp: new Date(), read: false
      });
      const msgData = { id: sysMsg.id, senderId: 'admin', senderUsername: 'Sistema', senderRole: 'admin', receiverId: user.id, receiverRole: 'user', content: clientMsg, timestamp: new Date(), type: 'system' };
      io.to(`user_${user.id}`).emit('new_message', msgData);
      io.to(`chat_${user.id}`).emit('new_message', msgData);
      notifyAdmins('new_message', { message: msgData, userId: user.id, username: user.username });
    }
    const uSock = connectedUsers.get(user.id);
    if (uSock && newBalance !== null) uSock.emit('balance_updated', { balance: newBalance });

    // SLA: la auto-carga ES la respuesta al cliente → frena el reloj de demoras
    // (antes quedaba como "sin respuesta" porque la carga es automática, no un agente).
    try { await delayClockResolve(user.id, { responded: true, agentId: 'auto-hgcash', agentUsername: 'auto-hgcash', via: 'auto_carga', queueHint: 'cargas' }); } catch (_) {}
    // Oferta de recuperación 100% (no se envía si está etiquetado comunidad/no comunidad).
    await maybeSendRecoveryMessage(user);

    await _emitAdminOnlyChatNote(user.id, user.username, `🏦 ✅ CARGA AUTOMÁTICA hgcash — ${dataDesc}. Acreditado.`);
    _emitHgcashUpdate('cargado');
    logger.info(`[hgcash] auto-carga OK user=${user.username} amount=$${amount} movement=${movement.movementId}`);
  } catch (e) {
    if (charged) {
      // La carga YA se acreditó; el error fue en un paso posterior (mensaje/transacción).
      // NO reintentar (sería doble carga). Solo dejamos constancia.
      logger.error(`[hgcash] carga OK pero falló paso posterior user=${user.username}: ${e.message}`);
    } else {
      // La carga no llegó a confirmarse → liberar el candado y dejarlo reintentable.
      if (chargeLocked) { try { await HgcashCharge.deleteOne({ chargeKey }); } catch (_) {} }
      await hgcashHandleChargeFailure(movClaim || movement, comprobante, e.message, dataDesc, user);
      logger.error(`[hgcash] auto-carga excepción user=${user.username}: ${e.message}`);
    }
  }
}

// Desde un MOVIMIENTO entrante (webhook): SOLO red de seguridad para el caso raro en
// que el comprobante llegó segundos ANTES que el aviso del banco. Usa una ventana
// CORTA (raceWindowMinutes) para NO cargar contra comprobantes viejos/sobrantes — el
// disparador principal es el comprobante (hgcashMatchFromComprobante). Match por
// MONTO + NOMBRE de origen. Si hay varios candidatos (ambigüedad) → NO carga.
async function hgcashMatchFromMovement(movement) {
  try {
    const cfg = await getHgcashConfig();
    if (!cfg.enabled) return;
    if (!movement || movement.direction !== 'Inbound' || movement.matchStatus !== 'pending') return;
    if (!_statusAccredited(movement.status, cfg)) return; // todavía no acreditado (status != done)
    if (cfg.currency && movement.currency && String(movement.currency).toUpperCase() !== String(cfg.currency).toUpperCase()) return;

    // Ventana CORTA: solo comprobantes enviados en los últimos raceWindowMinutes.
    const raceMin = Math.min(cfg.windowMinutes || 60, cfg.raceWindowMinutes || 10);
    const since = new Date(Date.now() - raceMin * 60 * 1000);
    const candidates = await Comprobante.find({
      isComprobante: true,
      autoCharged: { $ne: true },
      status: { $ne: 'duplicate' }, // un comprobante re-enviado/duplicado NO es objetivo de carga
      bankMatchStatus: { $in: ['none', 'pending'] },
      createdAt: { $gte: since }
    }).sort({ createdAt: -1 }).limit(80).lean();

    const matches = candidates.filter(c => _comprobanteMatchesMovement(c, movement, cfg));
    if (matches.length === 0) {
      // Diagnóstico: por qué no matcheó (para ver en los logs de Render).
      const resumen = candidates.slice(0, 8).map(c => `$${c.amount}/op:${c.operationNumber || '?'}/"${c.originHolder || '?'}"`).join(' , ');
      logger.info(`[hgcash] movimiento SIN match: $${movement.amount} de "${movement.fromName}" coelsa=${movement.coelsaCode || '-'} (status=${movement.status}). ${candidates.length} comprobantes en ventana: ${resumen}`);
      return; // queda pending; un comprobante posterior puede matchearlo
    }
    if (matches.length > 1) {
      logger.warn(`[hgcash] AMBIGUO: ${matches.length} comprobantes coinciden con movimiento ${movement.movementId} ($${movement.amount} de ${movement.fromName}). No se auto-carga.`);
      notifyAdmins('hgcash_ambiguous', { movementId: movement.movementId, amount: movement.amount, fromName: movement.fromName, count: matches.length });
      return;
    }
    await hgcashAutoCarga({ movement, comprobante: matches[0], mode: cfg.mode });
  } catch (e) {
    logger.warn(`[hgcash] match desde movimiento falló: ${e.message}`);
  }
}

// Desde un COMPROBANTE recién recibido: si fue a NUESTRA cuenta hgcash, buscar un
// movimiento entrante que coincida por MONTO + NOMBRE de origen + ventana de tiempo.
async function hgcashMatchFromComprobante(comprobante) {
  try {
    const cfg = await getHgcashConfig();
    if (!cfg.enabled) return;
    if (!comprobante || !comprobante.isComprobante || comprobante.autoCharged) return;

    // Buscamos un movimiento entrante que corresponda (por N° de transacción/coelsa,
    // o por nombre de origen + destino). NO dependemos de la config de cuenta: el
    // match se valida contra el movimiento real (sirve para cualquier banco/cuenta).
    const since = new Date(Date.now() - (cfg.windowMinutes || 60) * 60 * 1000);
    const candidates = await BankMovement.find({
      direction: 'Inbound', matchStatus: 'pending', createdAt: { $gte: since }
    }).sort({ createdAt: -1 }).limit(80).lean();

    const matches = candidates.filter(m =>
      _statusAccredited(m.status, cfg) &&
      _comprobanteMatchesMovement(comprobante, m, cfg)
    );
    if (matches.length === 0) {
      logger.info(`[hgcash] comprobante SIN movimiento aún: $${comprobante.amount} op=${comprobante.operationNumber || '-'} de "${comprobante.originHolder || '?'}" — ${candidates.length} movimientos pendientes en ventana`);
      return; // todavía no llegó el movimiento; el webhook lo matcheará al llegar
    }
    if (matches.length > 1) {
      logger.warn(`[hgcash] AMBIGUO: ${matches.length} movimientos coinciden con comprobante ${comprobante.id}. No se auto-carga.`);
      await _emitAdminOnlyChatNote(comprobante.userId, comprobante.username,
        `🏦 Hay ${matches.length} transferencias que coinciden con este comprobante (mismo monto y nombre en la ventana). Verificá y cargá a mano.`);
      return;
    }
    await hgcashAutoCarga({ movement: matches[0], comprobante, mode: cfg.mode });
  } catch (e) {
    logger.warn(`[hgcash] match desde comprobante falló: ${e.message}`);
  }
}

// Webhook de hgcash: movimientos de cuenta (acreditaciones entrantes). SIN
// authMiddleware (lo llama el banco). Valida firma HMAC sobre el body CRUDO,
// guarda el movimiento (dedupe por id), responde 2xx rápido y matchea en
// segundo plano. NUNCA carga si la config está apagada (modo sombra por defecto).
// ============================================
// FAN-OUT del webhook hgcash → autoreembolsos
// ============================================
// hgcash permite UNA sola URL de webhook por cuenta. vipcargas la recibe y la
// reenvía al proyecto hermano (autoreembolsos, misma cuenta hgcash; cada uno
// matchea sus propios comprobantes, no hay doble carga). Se reenvía el body
// CRUDO (bytes exactos) con la firma ORIGINAL (X-HG-Webhook-Signature) para que
// el destino valide el mismo HMAC con el secret compartido. Fire-and-forget con
// 1 reintento a los 15s: si el destino está caído o lento, el procesamiento
// local NO se ve afectado en nada (ni demora la respuesta 200 a hgcash).
// URL configurable por env/SSM: HGCASH_FANOUT_URL (leída lazy — SSM carga en el
// bootstrap async). Poner 'off' para desactivar el reenvío sin deploy de código.
function _hgcashFanoutUrl() {
  const v = String(process.env.HGCASH_FANOUT_URL || '').trim();
  if (v.toLowerCase() === 'off') return null;
  return v || 'https://www.autoreembolsos.com/api/hgcash/webhook';
}

function _fanoutHgcashWebhook(req) {
  try {
    const url = _hgcashFanoutUrl();
    if (!url) return;
    const axios = require('axios');
    const rawBody = req.rawBody ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}), 'utf8');
    const headers = {
      'Content-Type': req.get('Content-Type') || 'application/json',
      'X-Forwarded-By': 'vipcargas'
    };
    const sig = req.get('X-HG-Webhook-Signature');
    if (sig) headers['X-HG-Webhook-Signature'] = sig;
    // maxRedirects:0 a propósito: un redirect (http→https, www↔apex) rompería la
    // entrega del POST — mejor que falle y quede visible en los logs.
    const send = () => axios.post(url, rawBody, { headers, timeout: 8000, maxRedirects: 0 });
    send().catch((e1) => {
      logger.warn(`[hgcash-fanout] primer intento falló (${e1.message}) — reintento en 15s`);
      const t = setTimeout(() => {
        send().catch((e2) => {
          logger.warn(`[hgcash-fanout] reenvío a ${url} falló definitivamente: ${e2.message}`);
        });
      }, 15000);
      if (t.unref) t.unref();
    });
  } catch (e) {
    logger.warn(`[hgcash-fanout] error preparando reenvío: ${e.message}`);
  }
}

app.post('/api/hgcash/webhook', async (req, res) => {
  try {
    const secret = process.env.HGCASH_WEBHOOK_SECRET || null;
    if (secret) {
      const sigHeader = req.get('X-HG-Webhook-Signature') || '';
      const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
      const expected = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
      const provided = sigHeader.toLowerCase().startsWith('sha256=') ? sigHeader.slice(7).toLowerCase() : sigHeader.toLowerCase();
      if (!safeCompare(expected, provided)) {
        logger.warn('[hgcash] webhook con firma inválida — rechazado');
        return res.status(401).json({ error: 'firma inválida' });
      }
    } else {
      // Fail-closed en producción: sin secreto no se puede validar la firma → NO se
      // procesa el webhook (evita inyección de movimientos/cargas falsas). En dev se permite.
      if (process.env.NODE_ENV === 'production') {
        logger.error('[hgcash] webhook RECHAZADO en producción: falta HGCASH_WEBHOOK_SECRET en SSM');
        return res.status(503).json({ error: 'webhook no configurado' });
      }
      logger.warn('[hgcash] webhook recibido SIN HGCASH_WEBHOOK_SECRET — no se valida firma (solo dev)');
    }

    // Fan-out al proyecto hermano (autoreembolsos): recién DESPUÉS de validar la
    // firma (solo se reenvían webhooks auténticos) y ANTES de cualquier filtro
    // local (el destino recibe TODO — movimientos y estados de pago — y decide
    // qué es suyo). Fire-and-forget: no bloquea nada de lo que sigue.
    _fanoutHgcashWebhook(req);

    const p = req.body || {};
    if (!p.id) return res.status(400).json({ error: 'payload sin id' });

    // Webhook de ESTADO de un PAGO saliente (cash-out): topic TRANSACTION_REQUEST.
    // Lo manejamos aparte (no es un movimiento entrante).
    if (String(p.topic || '').toUpperCase() === 'TRANSACTION_REQUEST') {
      res.status(200).json({ ok: true });
      handlePayoutStatusWebhook(p).catch(() => {});
      return;
    }

    // Auto-capturar el accountId de NUESTRA cuenta hgcash (para los pagos salientes)
    // la primera vez que llega un movimiento, si todavía no está en la config.
    if (p.accountId) { ensureHgcashAccountIdSaved(p.accountId).catch(() => {}); }

    const amountNum = (p.amount !== undefined && p.amount !== null)
      ? (Number(String(p.amount).replace(/[^\d.-]/g, '')) || null) : null;
    const doc = {
      movementId: String(p.id),
      externalId: p.externalID || null,
      coelsaCode: p.coelsaCode || null,
      amount: amountNum, amountRaw: (p.amount !== undefined && p.amount !== null) ? String(p.amount) : null,
      currency: p.currency || null, direction: p.direction || null,
      status: p.status || null, type: p.type || null, accountId: p.accountId || null,
      fromName: p.fromName || null, fromCBU: p.fromCBU || null, fromCUIT: p.fromCUIT || null,
      toName: p.toName || null, toCBU: p.toCBU || null, toCUIT: p.toCUIT || null,
      date: p.date ? new Date(p.date) : null, timezone: p.timezone || null,
      topic: p.topic || null, eventType: p.eventType || null, raw: p
    };

    let isNew = false;
    try {
      await BankMovement.create({
        ...doc,
        matchStatus: (doc.direction === 'Inbound') ? 'pending' : 'ignored',
        createdAt: new Date()
      });
      isNew = true;
    } catch (e) {
      if (e && e.code === 11000) {
        // Reentrega / created+status_change: actualizar datos sin pisar el matchStatus.
        await BankMovement.updateOne({ movementId: doc.movementId }, { $set: { status: doc.status, eventType: doc.eventType, raw: doc.raw } });
      } else { throw e; }
    }

    // Responder 2xx YA (el banco reintenta si no; el matcheo corre aparte).
    res.status(200).json({ ok: true });

    if (isNew) _emitHgcashUpdate('movimiento'); // panel en vivo (entrantes y salientes)
    if (isNew && doc.direction === 'Inbound') {
      BankMovement.findOne({ movementId: doc.movementId }).lean()
        .then(fresh => { if (fresh) return hgcashMatchFromMovement(fresh); })
        .catch(() => {});
    }
  } catch (error) {
    logger.error(`[hgcash] webhook error: ${error.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'error interno' });
  }
});

// Comprobante PDF de un pago (link PERMANENTE que se le manda al cliente). En cada
// visita resuelve un signedUrl FRESCO de hgcash (la URL firmada vence en 1h) y redirige.
// Público (sin auth): la clave es el payout.id (UUID inadivinable) y muestra el recibo
// del propio pago del cliente. NO requiere authMiddleware (como el webhook).
app.get('/api/payout-receipt/:payoutId', async (req, res) => {
  try {
    if (!hgcashPay.isEnabled()) return res.status(503).send('Comprobante no disponible en este momento.');
    const payout = await PendingPayout.findOne({ id: String(req.params.payoutId || '') }).lean();
    if (!payout) return res.status(404).send('Comprobante no encontrado.');
    let txId = payout.hgTxId;
    if (!txId && payout.hgTransactionId) {
      const r = await hgcashPay.getTransactionIdForRequest(payout.hgTransactionId);
      if (r.ok && r.transactionId) {
        txId = String(r.transactionId);
        try { await PendingPayout.updateOne({ id: payout.id }, { $set: { hgTxId: txId } }); } catch (_) {}
      }
    }
    if (!txId) return res.status(404).send('El comprobante todavía no está disponible. Probá de nuevo en unos minutos.');
    const rec = await hgcashPay.getReceiptUrl(txId);
    if (!rec.ok || !rec.signedUrl) return res.status(404).send('No se pudo obtener el comprobante. Probá más tarde.');
    return res.redirect(302, rec.signedUrl);
  } catch (e) {
    logger.warn(`[hgcash-pay] endpoint payout-receipt falló: ${e.message}`);
    return res.status(500).send('Error al obtener el comprobante.');
  }
});

// ============================================
// CONTROL DE DEMORAS DE RESPUESTA EN CHATS (SLA de atención)
// ============================================
// El "reloj" de espera vive en ChatStatus (pendingSince/pendingPreview/pendingType),
// en MongoDB → funciona en multi-instancia sin estado en memoria. Cuando un agente
// responde (o se cierra el chat) se calcula la demora y, si supera el umbral, se
// guarda un registro permanente en ChatDelay (snapshot que sobrevive al TTL de
// Message). TODO va envuelto en try/catch: una falla acá NUNCA debe romper la
// entrega de un mensaje.
const DEFAULT_CHAT_DELAY_THRESHOLD = 120;        // cargas: 2 minutos
const DEFAULT_CHAT_DELAY_THRESHOLD_PAGOS = 1800; // pagos: 30 minutos

// Umbral según la cola. Pagos tolera demoras mucho mayores (el pago tarda), cargas no.
async function getChatDelayThreshold(category) {
  const isPagos = category === 'pagos';
  const key = isPagos ? 'chatDelayThresholdPagosSeconds' : 'chatDelayThresholdSeconds';
  const def = isPagos ? DEFAULT_CHAT_DELAY_THRESHOLD_PAGOS : DEFAULT_CHAT_DELAY_THRESHOLD;
  try {
    const v = await getConfig(key);
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  } catch (_) {
    return def;
  }
}

// Deriva la cola (cargas/pagos) del estado del chat.
function deriveChatQueue(cs) {
  return (cs && (cs.status === 'payments' || cs.category === 'pagos')) ? 'pagos' : 'cargas';
}

// Cola según el rol del agente que respondió: el withdrawer solo atiende pagos y el
// depositor solo cargas. El admin general atiende ambas → null (se deriva del chat).
function roleQueueHint(role) {
  if (role === 'withdrawer') return 'pagos';
  if (role === 'depositor') return 'cargas';
  return null;
}

function buildDelayPreview(content, type) {
  if (type === 'image') return '📸 Imagen';
  if (type === 'video') return '🎥 Video';
  const s = (content == null ? '' : String(content)).replace(/\s+/g, ' ').trim();
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

// Cliente manda un mensaje → arrancar el reloj SI no hay una espera en curso
// (la demora se mide desde el PRIMER mensaje sin responder, no desde el último).
async function delayClockOnUserMessage(userId, content, type) {
  if (!userId) return;
  try {
    await ChatStatus.updateOne(
      { userId, $or: [{ pendingSince: null }, { pendingSince: { $exists: false } }] },
      { $set: {
        pendingSince: new Date(),
        pendingPreview: buildDelayPreview(content, type),
        pendingType: type || 'text'
      } }
    );
  } catch (e) {
    logger.error(`[chatDelay] start failed (${userId}): ${e.message}`);
  }
}

// Resolver el reloj. responded=true → un agente respondió; responded=false → el
// chat se cerró sin responder. Registra ChatDelay sólo si la demora ≥ umbral.
// Siempre limpia el reloj.
async function delayClockResolve(userId, { responded, agentId = null, agentUsername = null, via = null, queueHint = null } = {}) {
  if (!userId) return;
  try {
    // Limpiar el reloj de forma ATÓMICA y quedarse con el valor previo. Si dos
    // agentes responden a la vez, sólo el que efectivamente "tomó" el pendingSince
    // (filtro pendingSince != null) registra la demora → sin doble conteo.
    const cs = await ChatStatus.findOneAndUpdate(
      { userId, pendingSince: { $ne: null } },
      { $set: { pendingSince: null, pendingPreview: null, pendingType: null } },
      { new: false }
    ).select('username assignedTo pendingSince pendingPreview pendingType category status').lean();

    if (!cs || !cs.pendingSince) return; // no había espera en curso (o ya la tomó otro)

    const now = new Date();
    const delaySeconds = Math.round((now - new Date(cs.pendingSince)) / 1000);
    // Gana "pagos" si hay CUALQUIER señal de pagos: el chat está en la pestaña Pagos
    // (status:'payments'), o la operación fue un retiro, o respondió un withdrawer.
    // Si no hay ninguna señal de pagos → cargas. Esto matchea el flujo real: una vez
    // que el chat pasa a Pagos, toda demora ahí es de la cola de pagos.
    const queue = (queueHint === 'pagos' || deriveChatQueue(cs) === 'pagos') ? 'pagos' : 'cargas';
    const threshold = await getChatDelayThreshold(queue);

    if (delaySeconds >= threshold) {
      await ChatDelay.create({
        id: uuidv4(),
        userId,
        username: cs.username || null,
        userMessageAt: cs.pendingSince,
        userMessagePreview: cs.pendingPreview || '',
        userMessageType: cs.pendingType || 'text',
        respondedAt: responded ? now : null,
        delaySeconds,
        respondedById: responded ? agentId : null,
        respondedByUsername: responded ? agentUsername : null,
        respondedVia: responded ? (via || 'message') : null,
        assignedTo: cs.assignedTo || null,
        status: responded ? 'responded' : 'unanswered',
        category: queue
      });
    }
  } catch (e) {
    logger.error(`[chatDelay] resolve failed (${userId}): ${e.message}`);
  }
}

// Limpiar el reloj sin registrar nada (cuando el chat sale del estado "esperando
// agente" por un motivo que no es ni respuesta ni cierre, ej: pasa a pagos).
async function delayClockClear(userId) {
  if (!userId) return;
  try {
    await ChatStatus.updateOne(
      { userId },
      { $set: { pendingSince: null, pendingPreview: null, pendingType: null } }
    );
  } catch (e) {
    logger.error(`[chatDelay] clear failed (${userId}): ${e.message}`);
  }
}

// Comunidad: cuando un cliente cuyo chat está en estado 'comunidad' vuelve a
// escribir, re-avisar a los agentes de Comunidad (badge + sonido en el panel)
// aunque ya no estén mirando esa pestaña. Sin esto, un cliente derivado que
// responde después de ser atendido quedaba sin aviso y se generaban demoras.
// Fire-and-forget: NUNCA frena la entrega del mensaje.
async function maybeNotifyComunidadActivity(userId, username) {
  if (!userId) return;
  try {
    const cs = await ChatStatus.findOne({ userId }).select('status username').lean();
    if (cs && cs.status === 'comunidad') {
      notifyAdmins('comunidad_activity', { userId, username: username || cs.username || null });
    }
  } catch (_) { /* nunca rompe la entrega del mensaje */ }
}

// ============================================
// MIDDLEWARE DE AUTENTICACIÓN
// ============================================
const authMiddleware = async (req, res, next) => {
  // Accept token from Authorization header first; fall back to admin_api_session
  // httpOnly cookie (sent automatically by the browser for same-origin requests
  // to /api/*).  This allows the admin panel to work purely via cookie without
  // storing the JWT in localStorage.
  let token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    token = getAdminApiSessionCookie(req) || null;
  }
  
  if (!token) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });

    // Buscar usuario por 'id' primero, luego por '_id' como fallback.
    // Solo los campos que este middleware usa (corre en CADA request; hidratar
    // el doc completo con fcmTokens/tagHistory/etc. era costo puro).
    // ⚠️ Si un chequeo futuro necesita otro campo del user: agregarlo acá.
    const AUTH_USER_FIELDS = 'id username role isActive isBlocked blockReason tokenVersion mustChangePassword';
    let user = await User.findOne({ id: decoded.userId }).select(AUTH_USER_FIELDS);

    if (!user) {
      // Intentar buscar por _id (para usuarios migrados)
      try {
        user = await User.findById(decoded.userId).select(AUTH_USER_FIELDS);
      } catch (e) {
        // _id inválido, ignorar
      }
    }
    
    if (!user) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }

    if (!user.isActive) {
      return res.status(401).json({ error: 'Usuario desactivado' });
    }

    if (user.isBlocked === true) {
      return res.status(403).json({
        error: 'Tu cuenta está bloqueada. Contactá a soporte.',
        code: 'USER_BLOCKED',
        reason: user.blockReason || null
      });
    }
    
    // Revocación de sesión: comparar siempre, normalizando ausentes a 0.
    // Antes la condición usaba `user.tokenVersion &&`, que con tokenVersion 0
    // (falsy) salteaba la verificación.
    if ((decoded.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
      return res.status(401).json({ error: 'Sesión expirada. Por favor, vuelve a iniciar sesión.' });
    }
    
    req.user = decoded;

    // Lockdown del rol publisher_admin: sólo puede tocar las rutas listadas en
    // PUBLISHER_ADMIN_ALLOWED_PATHS. Cualquier otra ruta devuelve 403, así no
    // puede llegar a endpoints de cargas/retiros/chats/usuarios aunque el JWT
    // sea válido. Match exacto o por prefijo (con "/" final) para soportar
    // sub-rutas (/api/admin/publisher-admin/create-user, /api/admin/publisher-admin/my-stats).
    if (user.role === 'publisher_admin') {
      const reqPath = req.path || '';
      const allowed = PUBLISHER_ADMIN_ALLOWED_PATHS.some(p =>
        reqPath === p || reqPath.startsWith(p + '/')
      );
      if (!allowed) {
        return res.status(403).json({
          error: 'Acceso denegado para tu rol.',
          code: 'PUBLISHER_ADMIN_FORBIDDEN'
        });
      }
    }

    // Enforce mandatory password change server-side.
    // If the user has `mustChangePassword: true` (set by JUGAYGANA import,
    // login default-password detection, or admin reset), only the allow-listed
    // endpoints are reachable. Any other authenticated request returns 403 so
    // the SPA can re-open the mandatory change modal — even after a reload.
    if (user.mustChangePassword === true) {
      if (isAdminRole(user.role)) {
        // Self-heal: admins must NEVER carry the mustChangePassword flag.
        // Clean it on the fly so the request proceeds normally. This handles
        // admins that were marked before the role-isolation fix (PR #286)
        // and would otherwise be permanently blocked by this middleware.
        try {
          user.mustChangePassword = false;
          await User.updateOne({ _id: user._id }, { $set: { mustChangePassword: false } });
          logger.info(`[authMiddleware] Auto-cleared mustChangePassword for admin ${user.username}`);
        } catch (e) {
          logger.warn(`[authMiddleware] Failed to auto-clear mustChangePassword for ${user.username}: ${e.message}`);
        }
      } else {
        const path = req.path || '';
        const allowed = MUST_CHANGE_PASSWORD_ALLOWED_PATHS.some(p => path === p || path.startsWith(p + '/'));
        if (!allowed) {
          return res.status(403).json({
            error: 'Debés cambiar tu contraseña antes de continuar',
            code: 'MUST_CHANGE_PASSWORD'
          });
        }
      }
    }

    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido' });
  }
};

const adminMiddleware = (req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'depositor' && req.user.role !== 'withdrawer' && req.user.role !== 'comunidad') {
    return res.status(403).json({ error: 'Acceso denegado. Solo administradores.' });
  }
  next();
};

const depositorMiddleware = (req, res, next) => {
  // 'comunidad' funciona como un depositor (mismas funciones de carga) + ve la sección Comunidad.
  if (req.user.role !== 'admin' && req.user.role !== 'depositor' && req.user.role !== 'comunidad') {
    return res.status(403).json({ error: 'Acceso denegado. Solo agentes de carga.' });
  }
  next();
};

const withdrawerMiddleware = (req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'withdrawer') {
    return res.status(403).json({ error: 'Acceso denegado. Solo agentes de retiro.' });
  }
  next();
};

// Sólo cuentas con role='publisher_admin' pueden tocar los endpoints
// /api/admin/publisher-admin/*. El admin general usa otros endpoints (CRUD
// /api/admin/publisher-admins) para gestionar a estos publisher_admins.
const publisherAdminMiddleware = (req, res, next) => {
  if (req.user.role !== 'publisher_admin') {
    return res.status(403).json({ error: 'Acceso denegado. Sólo cuentas publisher_admin.' });
  }
  next();
};

// ============================================
// RUTAS DE AUTENTICACIÓN
// ============================================

// Verificar disponibilidad de username
app.get('/api/auth/check-username', authLimiter, async (req, res) => {
  try {
    const { username } = req.query;
    
    if (!username || username.length < 3) {
      return res.json({ available: false, message: 'Usuario muy corto' });
    }
    
    // Buscar case-insensitive (camino rápido indexado + fallback)
    const localExists = await findUserByUsernameCI(username);
    
    if (localExists) {
      return res.json({ available: false, message: 'Usuario ya registrado' });
    }
    
    try {
      const jgUser = await jugaygana.getUserInfoByName(username);
      if (jgUser) {
        return res.json({ 
          available: false, 
          message: 'Este nombre de usuario no está disponible. Intenta con otro nombre.'
        });
      }
    } catch (jgError) {
      logger.warn(`JUGAYGANA check failed: ${jgError.message}`);
    }
    
    res.json({ 
      available: true, 
      message: 'Usuario disponible'
    });
  } catch (error) {
    console.error('Error verificando username:', error);
    res.status(500).json({ available: false, message: 'Error del servidor' });
  }
});

// Endpoint para enviar CBU al chat
app.post('/api/admin/send-cbu', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    const cbuConfig = await getConfig('cbu');
    
    if (!cbuConfig || !cbuConfig.number) {
      return res.status(400).json({ error: 'CBU no configurado' });
    }
    
    const timestamp = new Date();

    // 1. Mensaje completo con todos los datos (editable desde COMANDOS /sys_cbu)
    const fullMessage = await renderSystemCommand(
      '/sys_cbu',
      '💳 *Datos para transferir:*\n\n🏦 Banco: {bank}\n👤 Titular: {titular}\n🔢 CBU: {cbu}\n📱 Alias: {alias}\n\n✅ Una vez realizada la transferencia, envianos el comprobante por aquí.',
      { bank: cbuConfig.bank, titular: cbuConfig.titular, cbu: cbuConfig.number, alias: cbuConfig.alias }
    );

    if (fullMessage) await Message.create({ // null = /sys_cbu vaciado → solo se manda el CBU
      id: uuidv4(),
      senderId: req.user.userId,
      senderUsername: req.user.username,
      senderRole: 'admin',
      receiverId: userId,
      receiverRole: 'user',
      content: fullMessage,
      type: 'text',
      timestamp: timestamp,
      read: false
    });

    // 2. CBU solo para copiar y pegar
    await Message.create({
      id: uuidv4(),
      senderId: req.user.userId,
      senderUsername: req.user.username,
      senderRole: 'admin',
      receiverId: userId,
      receiverRole: 'user',
      content: cbuConfig.number,
      type: 'text',
      timestamp: new Date(Date.now() + 100),
      read: false
    });

    // SLA: enviar el CBU es responderle al cliente (resuelve el reloj de demora).
    await delayClockResolve(userId, { responded: true, agentId: req.user.userId, agentUsername: req.user.username, via: 'message', queueHint: 'cargas' });
    
    // Notificar al usuario por socket si está conectado
    const userSocket = connectedUsers.get(userId);
    if (userSocket) {
      if (fullMessage) userSocket.emit('new_message', {
        senderId: req.user.userId,
        senderUsername: req.user.username,
        content: fullMessage,
        timestamp: timestamp,
        type: 'text'
      });
      setTimeout(() => {
        userSocket.emit('new_message', {
          senderId: req.user.userId,
          senderUsername: req.user.username,
          content: cbuConfig.number,
          timestamp: new Date(),
          type: 'text'
        });
      }, 100);
    }
    
    res.json({ success: true, message: 'CBU enviado' });
  } catch (error) {
    console.error('Error enviando CBU:', error);
    res.status(500).json({ error: 'Error enviando CBU' });
  }
});

// Health check endpoint
// Endpoint público para que el cliente reporte eventos del Meta Pixel del
// navegador y el server los reenvíe a Conversions API con el mismo event_id
// (deduplicación). Sólo eventos genéricos de funnel (PageView, ViewContent).
// Las conversiones críticas (registro, depósito, retiro, refund) se disparan
// directamente desde sus handlers — este endpoint no las admite para evitar
// que un cliente falsifique conversiones.
const PIXEL_TRACK_ALLOWED_EVENTS = new Set([
  'PageView', 'ViewContent', 'Search', 'Contact'
]);
app.post('/api/pixel/track', async (req, res) => {
  try {
    const { event, eventId, customData } = req.body || {};
    if (!event || typeof event !== 'string') {
      return res.status(400).json({ error: 'event requerido' });
    }
    if (!PIXEL_TRACK_ALLOWED_EVENTS.has(event)) {
      return res.status(400).json({ error: 'evento no permitido' });
    }

    // Si hay JWT válido, enriquecer con datos del usuario (hash de email/phone/id).
    let userInfo = {};
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
        const u = await User.findOne({ id: decoded.userId }).lean();
        if (u) {
          userInfo = { email: u.email, phone: u.phone, externalId: u.id };
        }
      } catch (e) { /* token inválido: enviar evento anónimo */ }
    }

    metaCapi.track(event, userInfo, customData || {}, { eventId, req });
    res.json({ ok: true });
  } catch (err) {
    logger.warn(`[pixel/track] error: ${err.message}`);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============================================
// CAMPAÑAS PUBLICITARIAS — tracking de clicks
// ============================================

// Rate limit independiente: el endpoint es público y se llama una vez por visita.
const campaignTrackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes' }
});

// Registra un clic de campaña. Llamado por el frontend cuando detecta `?p=CODE`
// en la URL. No requiere autenticación. Si el código no existe o está inactivo,
// devuelve 200 igualmente para no leakear qué códigos son válidos.
app.post('/api/campaigns/track-click', campaignTrackLimiter, async (req, res) => {
  try {
    const { code, visitorId, utm } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'code requerido' });
    }
    const normalizedCode = String(code).toUpperCase().trim();
    if (!/^[A-Z0-9_-]{3,40}$/.test(normalizedCode)) {
      return res.status(400).json({ error: 'code inválido' });
    }

    const campaign = await Campaign.findOne({ code: normalizedCode, isActive: true }).lean();
    if (!campaign) {
      // Silencioso: no leakeamos si el código existe o no.
      return res.json({ ok: true });
    }

    const ip = req.ip || (req.headers['x-forwarded-for'] && String(req.headers['x-forwarded-for']).split(',')[0].trim()) || '';
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 500);
    const fingerprint = crypto.createHash('sha256').update(`${ip}|${userAgent}|${normalizedCode}`).digest('hex');

    // Deduplicar: si el mismo fingerprint ya hizo click en esta campaña en los
    // últimos 30 minutos, no contar de nuevo (evita inflar clicks por F5).
    const recentCutoff = new Date(Date.now() - 30 * 60 * 1000);
    const existing = await CampaignClick.findOne({
      campaignCode: normalizedCode,
      fingerprint,
      clickedAt: { $gte: recentCutoff }
    }).lean();
    if (existing) return res.json({ ok: true, deduped: true });

    await CampaignClick.create({
      id: crypto.randomUUID(),
      campaignCode: normalizedCode,
      fingerprint,
      visitorId: visitorId && typeof visitorId === 'string' ? visitorId.slice(0, 100) : null,
      userAgent,
      referer: String(req.headers.referer || '').slice(0, 500) || null,
      utm: {
        source: utm && utm.source ? String(utm.source).slice(0, 100) : null,
        medium: utm && utm.medium ? String(utm.medium).slice(0, 100) : null,
        campaign: utm && utm.campaign ? String(utm.campaign).slice(0, 100) : null,
        content: utm && utm.content ? String(utm.content).slice(0, 100) : null,
        term: utm && utm.term ? String(utm.term).slice(0, 100) : null
      },
      clickedAt: new Date()
    });
    res.json({ ok: true });
  } catch (err) {
    logger.warn(`[track-click] error: ${err.message}`);
    res.status(500).json({ error: 'Error interno' });
  }
});

// GET /api/campaigns/public/:code
// Endpoint público (sin auth) que devuelve sólo los datos no-sensibles de una
// campaña activa: code, publisher y name. Lo usa el frontend para personalizar
// el welcome modal con el nombre del publicista cuando el cliente entra por la
// vanity URL. NUNCA expone creds, notas, comisiones ni datos internos.
app.get('/api/campaigns/public/:code', async (req, res) => {
  try {
    const normalizedCode = String(req.params.code).toUpperCase().trim();
    if (!/^[A-Z0-9_-]{3,40}$/.test(normalizedCode)) {
      return res.status(400).json({ error: 'Código inválido' });
    }
    const campaign = await Campaign.findOne({ code: normalizedCode, isActive: true })
      .select('code publisher name')
      .lean();
    if (!campaign) {
      return res.status(404).json({ error: 'Campaña no encontrada' });
    }
    res.json({
      code: campaign.code,
      publisher: campaign.publisher,
      name: campaign.name
    });
  } catch (err) {
    logger.warn(`[campaigns/public] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/health', async (req, res) => {
  const mongoOk = mongoose.connection.readyState === 1;
  res.json({
    status: mongoOk ? 'ok' : 'degraded'
  });
});

// Endpoint opcional para subir imágenes a S3 (requiere configuración de AWS)
app.post('/api/upload/presigned-url', authMiddleware, async (req, res) => {
  try {
    if (!process.env.S3_BUCKET) {
      return res.status(501).json({ error: 'Upload a S3 no configurado. Usar envío por base64.' });
    }
    const { filename, contentType } = req.body;
    if (!filename || !contentType) {
      return res.status(400).json({ error: 'filename y contentType requeridos' });
    }
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(contentType)) {
      return res.status(400).json({ error: 'Tipo de archivo no permitido' });
    }
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const safeName = String(filename).replace(/[^\w.\-]/g, '_').slice(0, 120);
    const key = `chat-images/${req.user.userId}/${Date.now()}-${safeName}`;
    const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      ContentType: contentType
    });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
    const publicUrl = `https://${process.env.S3_BUCKET}.s3.amazonaws.com/${key}`;
    res.json({ uploadUrl, publicUrl });
  } catch (error) {
    logger.error('Error generando presigned URL:', error.message);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Registro de usuario
app.post('/api/auth/register', authLimiter, registerIpLimiter, async (req, res) => {
  try {
    const { username, password, email, phone, referralCode, otpCode, campaignCode, utm, fbc, fbp, landingUrl } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }

    // Validar el formato del username: evita XSS almacenado (un username con
    // HTML/JS se ejecutaría en el panel admin al listar usuarios o abrir el chat).
    if (!validateUsername(username)) {
      return res.status(400).json({ error: 'Usuario inválido. Usá 3-30 caracteres: letras, números, punto, guion o guion bajo.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    
    // El registro es solo usuario + contraseña: el SMS dejó de ser obligatorio.
    // Si igualmente llega un teléfono con su OTP (flujo legacy o verificación
    // opcional), se valida; si no, la cuenta se crea con el teléfono pendiente
    // de verificar y se le ofrece el SMS al primer ingreso.
    const hasPhone = !!(phone && phone.trim().length >= 8);
    let normalizedPhone = null;

    if (hasPhone) {
      normalizedPhone = phone.trim();

      if (!otpCode) {
        return res.status(400).json({ error: 'Se requiere el código de verificación SMS' });
      }
      if (!validateInternationalPhone(normalizedPhone)) {
        return res.status(400).json({ error: 'Número de teléfono inválido. Usa formato internacional con código de país (ej: +5491155551234)' });
      }
      const otpResult = await verifyOTP(normalizedPhone, otpCode, 'register');
      if (!otpResult.valid) {
        return res.status(400).json({ error: otpResult.error || 'Código de verificación incorrecto o expirado' });
      }
      // Unicidad por clave NORMALIZADA (el mismo número en distinto formato = misma clave).
      const existingPhoneUser = await User.findOne({ phoneKey: normalizePhoneKey(normalizedPhone), phoneVerified: true }).lean();
      if (existingPhoneUser) {
        return res.status(400).json({ error: 'Este número de teléfono ya está registrado por otra cuenta' });
      }
    }
    
    // Buscar case-insensitive (camino rápido indexado + fallback)
    const existingUser = await findUserByUsernameCI(username);
    
    if (existingUser) {
      return res.status(400).json({ error: 'El usuario ya existe' });
    }

    // Unicidad de EMAIL: no permitir dos cuentas con el mismo email (case-insensitive).
    // Solo se valida si el cliente cargó un email (es opcional).
    const normalizedEmail = email ? String(email).toLowerCase().trim() : null;
    if (normalizedEmail) {
      const existingEmail = await User.findOne({ email: normalizedEmail }).lean();
      if (existingEmail) {
        return res.status(400).json({ error: 'Este email ya está registrado en otra cuenta.' });
      }
    }

    // Resolver código de referido si fue proporcionado
    const normalizedReferralCode = referralCode ? String(referralCode).toUpperCase().trim() : null;
    let referrer = null;
    if (normalizedReferralCode) {
      referrer = await User.findOne({ referralCode: normalizedReferralCode }).lean();
      if (!referrer) {
        logger.warn(`[Register] Código de referido inválido: ${normalizedReferralCode}`);
      }
    }
    
    // Crear usuario en JUGAYGANA PRIMERO
    let jgResult = null;
    try {
      jgResult = await jugaygana.syncUserToPlatform({
        username: username,
        password: password
      });
      
      if (!jgResult.success && !jgResult.alreadyExists) {
        // `error` ya viene normalizado a string desde el cliente; errToString es
        // defensa en profundidad para que NUNCA se le muestre "[object Object]"
        // al cliente (concatenar un objeto de error era el bug original).
        const jgErr = jugaygana.errToString(jgResult.error);
        logger.warn(`[Register] JUGAYGANA rechazó a ${username}: [${jgResult.code || 'n/a'}] ${jgErr}`);
        // transient = la plataforma no respondió (no es culpa del nombre elegido):
        // el mensaje ya viene redactado para el cliente, sin prefijo técnico.
        return res.status(400).json({
          error: jgResult.transient ? jgErr : `No se pudo crear el usuario en JUGAYGANA: ${jgErr}`
        });
      }

      // El registro PÚBLICO nunca VINCULA una cuenta preexistente de JUGAYGANA:
      // como el username es la única prueba de identidad acá, cualquiera podría
      // registrarse con el nombre de otro y quedarse con su cuenta y su saldo.
      // Vincular es una operación de confianza y queda reservada a la creación
      // por ADMIN (POST /api/admin/users y POST /api/users), que ya valida que
      // el username no exista localmente antes de vincular.
      if (jgResult.alreadyExists) {
        logger.warn(`[Register] ${username} ya existe en JUGAYGANA — registro público rechazado (vincular es solo por admin)`);
        return res.status(400).json({
          error: 'Ese nombre de usuario ya está en uso. Si ya tenés una cuenta, iniciá sesión.',
          code: 'USERNAME_TAKEN'
        });
      }

      logger.info(`User created in JUGAYGANA: ${username}`);
    } catch (jgError) {
      logger.error(`Error creating user in JUGAYGANA: ${jgError.message}`);
      return res.status(400).json({ error: 'Error al crear usuario en la plataforma. Intenta con otro nombre de usuario.' });
    }
    
    // Crear usuario localmente
    const userId = uuidv4();

    // Validar referido (evitar auto-referido)
    const isValidReferral = referrer && referrer.id !== userId;

    // Generar referralCode único para el nuevo usuario (con control de colisiones)
    let newReferralCode = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = generateReferralCode();
      const collision = await User.findOne({ referralCode: candidate }).lean();
      if (!collision) { newReferralCode = candidate; break; }
    }
    if (!newReferralCode) {
      logger.warn(`[Register] No se pudo generar un referralCode único para ${username} después de 10 intentos. El usuario se creará sin código.`);
    }
    
    // Si vino con un campaignCode válido, guardar atribución (no bloquea si no existe).
    let attributedCampaign = null;
    if (campaignCode && typeof campaignCode === 'string') {
      const normalizedCampaignCode = String(campaignCode).toUpperCase().trim();
      if (/^[A-Z0-9_-]{3,40}$/.test(normalizedCampaignCode)) {
        const c = await Campaign.findOne({ code: normalizedCampaignCode, isActive: true }).lean();
        if (c) attributedCampaign = normalizedCampaignCode;
      }
    }

    // Identificadores de Meta Ads: vienen en el body desde el front; si no,
    // se leen de la cookie del request. Se persisten en el usuario para que
    // los eventos server-side futuros (Purchase) puedan atribuirse al clic.
    const _regFbCtx = metaCapi.extractRequestContext(req);
    const metaFbc = sanitizeFbCookie(fbc) || sanitizeFbCookie(_regFbCtx.fbc);
    const metaFbp = sanitizeFbCookie(fbp) || sanitizeFbCookie(_regFbCtx.fbp);

    const newUser = await User.create({
      id: userId,
      username,
      password: password,
      email: normalizedEmail,
      phone: normalizedPhone,
      phoneKey: hasPhone ? normalizePhoneKey(normalizedPhone) : null,
      phoneVerified: hasPhone,
      phoneVerificationPending: !hasPhone,
      role: 'user',
      accountNumber: generateAccountNumber(),
      balance: jgResult.user?.balance || jgResult.user?.user_balance || 0,
      createdAt: new Date(),
      lastLogin: null,
      isActive: true,
      jugayganaUserId: jgResult.jugayganaUserId || jgResult.user?.user_id,
      jugayganaUsername: jgResult.jugayganaUsername || jgResult.user?.user_name,
      jugayganaSyncStatus: jgResult.alreadyExists ? 'linked' : 'synced',
      // Campos de referido
      referralCode: newReferralCode,
      referredByUserId: isValidReferral ? referrer.id : null,
      referredByCode: isValidReferral ? normalizedReferralCode : null,
      referredAt: isValidReferral ? new Date() : null,
      referralStatus: isValidReferral ? 'referred' : 'none',
      // Atribución de campaña (si vino por link de pauta y eligió flujo OTP)
      acquisitionCampaign: attributedCampaign,
      acquisitionUtm: attributedCampaign ? {
        source: utm && utm.source ? String(utm.source).slice(0, 100) : null,
        medium: utm && utm.medium ? String(utm.medium).slice(0, 100) : null,
        campaign: utm && utm.campaign ? String(utm.campaign).slice(0, 100) : null,
        content: utm && utm.content ? String(utm.content).slice(0, 100) : null,
        term: utm && utm.term ? String(utm.term).slice(0, 100) : null
      } : undefined,
      acquiredAt: attributedCampaign ? new Date() : null,
      // Identificadores de Meta Ads para atribución vía Conversions API.
      metaFbc,
      metaFbp,
      // Landing URL: la usa fbAdsWebhookService para mandarla a fb-ads.
      landingUrl: (typeof landingUrl === 'string' && landingUrl.length <= 2000) ? landingUrl : null,
      // Anti-multicuenta: huella de origen del registro.
      registrationIp: req.ip || req.socket?.remoteAddress || null,
      registrationUserAgent: (req.get('User-Agent') || '').slice(0, 500) || null
    });

    // Registrar evento de referido para trazabilidad
    if (isValidReferral) {
      try {
        await ReferralEvent.create({
          id: uuidv4(),
          referrerUserId: referrer.id,
          referrerUsername: referrer.username,
          referredUserId: userId,
          referredUsername: newUser.username,
          codeUsed: normalizedReferralCode,
          meta: { ip: req.ip || null, registeredAt: new Date() }
        });
        logger.info(`[Register] Referido registrado: ${newUser.username} referido por ${referrer.username} (código: ${normalizedReferralCode})`);
      } catch (refErr) {
        logger.error(`[Register] Error registrando evento de referido: ${refErr.message}`);
        // No interrumpir el flujo de registro
      }
    }
    
    // CORREGIDO: El mensaje de bienvenida se envía desde el cliente (app.js) con el formato actualizado incluyendo CBU
    // No enviamos mensaje de bienvenida desde el servidor para evitar duplicados y usar el formato correcto

    // Crear chat status
    await ChatStatus.create({
      userId: userId,
      username: username,
      status: 'open',
      category: 'cargas',
      lastMessageAt: new Date()
    });

    // Generar token con expiración de 90 días
    const token = jwt.sign(
      { userId: newUser.id, username: newUser.username, role: newUser.role, tokenVersion: newUser.tokenVersion ?? 0 },
      JWT_SECRET,
      { expiresIn: '90d' }
    );

    // Meta CAPI — CompleteRegistration (conversión clave del funnel).
    metaCapi.track(
      'CompleteRegistration',
      { email: newUser.email, phone: newUser.phone, externalId: newUser.id, fbc: metaFbc, fbp: metaFbp },
      {
        content_name: 'signup',
        status: true,
        referred: isValidReferral,
        campaign_code: attributedCampaign || null,
        utm_source: newUser.acquisitionUtm?.source || null,
        utm_campaign: newUser.acquisitionUtm?.campaign || null
      },
      { eventId: req.body && req.body.metaEventId, req }
    );

    // Webhook a fb-ads: conversión clave del embudo. Fire-and-forget.
    fbAdsWebhook.notify('CompleteRegistration', newUser);

    res.status(201).json({
      message: 'Usuario creado exitosamente',
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        phone: newUser.phone,
        phoneVerified: newUser.phoneVerified === true,
        phoneVerificationPending: newUser.phoneVerificationPending === true,
        accountNumber: newUser.accountNumber,
        role: newUser.role,
        balance: newUser.balance,
        jugayganaLinked: true,
        needsPasswordChange: false,
        firstLogin: true,
        referralCode: newUser.referralCode,
        referredBy: isValidReferral ? referrer.username : null,
        metaMatching: metaCapi.buildAdvancedMatching({
          email: newUser.email,
          phone: newUser.phone,
          externalId: newUser.id
        })
      }
    });
  } catch (error) {
    logger.error(`Registration error: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Registro RÁPIDO — para usuarios que llegan por un link de pauta (?p=CODE).
// No requiere teléfono ni OTP. Crea el usuario con phoneVerificationPending:true;
// el primer retiro le exigirá verificar un teléfono real antes de procesarse.
// Requiere campaignCode válido y activo para evitar abuso (un atacante no puede
// crear cuentas sin OTP a discreción — necesita un código real de pauta).
app.post('/api/auth/register-quick', authLimiter, registerIpLimiter, async (req, res) => {
  try {
    const { username, password, email, campaignCode, visitorId, utm, metaEventId, fbc, fbp, landingUrl } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }
    if (!validateUsername(username)) {
      return res.status(400).json({ error: 'Usuario inválido (3-30 caracteres, letras/números/._-)' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'La contraseña debe tener entre 6 y 100 caracteres' });
    }
    if (!campaignCode || typeof campaignCode !== 'string') {
      return res.status(400).json({ error: 'campaignCode requerido para registro rápido' });
    }

    const normalizedCode = String(campaignCode).toUpperCase().trim();
    const campaign = await Campaign.findOne({ code: normalizedCode, isActive: true }).lean();
    if (!campaign) {
      return res.status(400).json({ error: 'Código de pauta inválido o inactivo' });
    }

    const existingUser = await findUserByUsernameCI(username, { lean: true });
    if (existingUser) {
      return res.status(400).json({ error: 'El usuario ya existe' });
    }

    // Unicidad de EMAIL: no permitir dos cuentas con el mismo email (case-insensitive).
    const normalizedEmail = email ? String(email).toLowerCase().trim() : null;
    if (normalizedEmail) {
      const existingEmail = await User.findOne({ email: normalizedEmail }).lean();
      if (existingEmail) {
        return res.status(400).json({ error: 'Este email ya está registrado en otra cuenta.' });
      }
    }

    // Crear en JUGAYGANA primero (igual que el flujo normal).
    let jgResult = null;
    try {
      jgResult = await jugaygana.syncUserToPlatform({ username, password });
      if (!jgResult.success && !jgResult.alreadyExists) {
        // Mismo criterio que /api/auth/register (ver comentario allá).
        const jgErr = jugaygana.errToString(jgResult.error);
        logger.warn(`[register-quick] JUGAYGANA rechazó a ${username}: [${jgResult.code || 'n/a'}] ${jgErr}`);
        return res.status(400).json({
          error: jgResult.transient ? jgErr : `No se pudo crear el usuario en JUGAYGANA: ${jgErr}`
        });
      }
      // Mismo criterio que /api/auth/register: el registro público no vincula
      // cuentas preexistentes de JUGAYGANA (ver comentario allá).
      if (jgResult.alreadyExists) {
        logger.warn(`[register-quick] ${username} ya existe en JUGAYGANA — registro público rechazado`);
        return res.status(400).json({
          error: 'Ese nombre de usuario ya está en uso. Si ya tenés una cuenta, iniciá sesión.',
          code: 'USERNAME_TAKEN'
        });
      }
    } catch (jgError) {
      logger.error(`[register-quick] Error JUGAYGANA: ${jgError.message}`);
      return res.status(400).json({ error: 'Error al crear usuario en la plataforma. Intenta con otro nombre de usuario.' });
    }

    const userId = uuidv4();
    let newReferralCode = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = generateReferralCode();
      const collision = await User.findOne({ referralCode: candidate }).lean();
      if (!collision) { newReferralCode = candidate; break; }
    }

    // Identificadores de Meta Ads (ver comentario en /api/auth/register).
    const _rqFbCtx = metaCapi.extractRequestContext(req);
    const metaFbc = sanitizeFbCookie(fbc) || sanitizeFbCookie(_rqFbCtx.fbc);
    const metaFbp = sanitizeFbCookie(fbp) || sanitizeFbCookie(_rqFbCtx.fbp);

    const newUser = await User.create({
      id: userId,
      username,
      password,
      email: normalizedEmail,
      phone: null,
      phoneVerified: false,
      phoneVerificationPending: true,
      role: 'user',
      accountNumber: generateAccountNumber(),
      balance: jgResult.user?.balance || jgResult.user?.user_balance || 0,
      createdAt: new Date(),
      isActive: true,
      jugayganaUserId: jgResult.jugayganaUserId || jgResult.user?.user_id,
      jugayganaUsername: jgResult.jugayganaUsername || jgResult.user?.user_name,
      jugayganaSyncStatus: jgResult.alreadyExists ? 'linked' : 'synced',
      referralCode: newReferralCode,
      // Atribución de campaña
      acquisitionCampaign: normalizedCode,
      acquisitionUtm: {
        source: utm && utm.source ? String(utm.source).slice(0, 100) : null,
        medium: utm && utm.medium ? String(utm.medium).slice(0, 100) : null,
        campaign: utm && utm.campaign ? String(utm.campaign).slice(0, 100) : null,
        content: utm && utm.content ? String(utm.content).slice(0, 100) : null,
        term: utm && utm.term ? String(utm.term).slice(0, 100) : null
      },
      acquiredAt: new Date(),
      // Identificadores de Meta Ads para atribución vía Conversions API.
      metaFbc,
      metaFbp,
      // Landing URL: la usa fbAdsWebhookService para mandarla a fb-ads.
      landingUrl: (typeof landingUrl === 'string' && landingUrl.length <= 2000) ? landingUrl : null,
      // Anti-multicuenta: huella de origen del registro.
      registrationIp: req.ip || req.socket?.remoteAddress || null,
      registrationUserAgent: (req.get('User-Agent') || '').slice(0, 500) || null
    });

    await ChatStatus.create({
      userId,
      username,
      status: 'open',
      category: 'cargas',
      lastMessageAt: new Date()
    });

    const token = jwt.sign(
      { userId: newUser.id, username: newUser.username, role: newUser.role, tokenVersion: newUser.tokenVersion ?? 0 },
      JWT_SECRET,
      { expiresIn: '90d' }
    );

    // Meta CAPI — CompleteRegistration con campaign_code en custom_data.
    metaCapi.track(
      'CompleteRegistration',
      { email: newUser.email, externalId: newUser.id, fbc: metaFbc, fbp: metaFbp },
      {
        content_name: 'signup_quick',
        status: true,
        campaign_code: normalizedCode,
        publisher: campaign.publisher,
        utm_source: newUser.acquisitionUtm?.source || null,
        utm_campaign: newUser.acquisitionUtm?.campaign || null
      },
      { eventId: metaEventId, req }
    );

    // Webhook a fb-ads: conversión clave del embudo. Fire-and-forget.
    fbAdsWebhook.notify('CompleteRegistration', newUser);

    res.status(201).json({
      message: 'Cuenta creada. Ya podes ingresar a jugar — para retirar tendrás que verificar un teléfono.',
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        phone: null,
        phoneVerified: false,
        phoneVerificationPending: true,
        accountNumber: newUser.accountNumber,
        role: newUser.role,
        balance: newUser.balance,
        jugayganaLinked: true,
        needsPasswordChange: false,
        referralCode: newUser.referralCode,
        acquisitionCampaign: normalizedCode,
        metaMatching: metaCapi.buildAdvancedMatching({
          email: newUser.email,
          externalId: newUser.id
        })
      }
    });
  } catch (error) {
    logger.error(`register-quick error: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Login
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { username, phone, password, temporaryCode, fbc, fbp, landingUrl } = req.body;

    if ((!username && !phone) || (!password && !temporaryCode)) {
      return res.status(400).json({ error: 'Usuario o teléfono, y contraseña (o código temporal) requeridos' });
    }
    
    // No registrar el teléfono completo en logs (dato personal): se enmascara.
    logger.debug(`Login attempt for: ${username || (phone ? '***' + String(phone).slice(-4) : 'desconocido')}`);
    
    // Buscar usuario case-insensitive (para soportar usernames con mayúsculas/minúsculas)
    let user;
    let dbReadFailed = false;

    if (phone && !username) {
      // Phone-based login
      const normalizedPhone = phone.trim();
      try {
        user = await User.findOne({ phone: normalizedPhone, phoneVerified: true });
      } catch (dbErr) {
        logger.error(`[Login] MongoDB read failed for phone ${normalizedPhone}: ${dbErr.message}`);
        dbReadFailed = true;
      }
    } else {
      // Username-based login. critical:true → el fallback lento queda SIEMPRE
      // disponible: nadie puede quedar afuera de su cuenta por el camino rápido.
      try {
        user = await findUserByUsernameCI(username, { critical: true });
      } catch (dbErr) {
        logger.error(`[Login] MongoDB read failed for ${username}: ${dbErr.message}`);
        dbReadFailed = true;
      }
    }

    // Fallback controlado si MongoDB no está disponible: solo con credenciales de env vars
    if (dbReadFailed) {
      const fallbackAdminUsername = process.env.ADMIN_USERNAME;
      const fallbackAdminPassword = process.env.ADMIN_PASSWORD;
      const isAdminFallback = fallbackAdminUsername && fallbackAdminPassword &&
        username === fallbackAdminUsername &&
        safeCompare(password, fallbackAdminPassword);
      if (!isAdminFallback) {
        return res.status(503).json({ error: 'Servicio temporalmente no disponible. Intenta más tarde.' });
      }
      const fallbackToken = jwt.sign(
        { userId: 'fallback-admin', username: fallbackAdminUsername, role: 'admin', tokenVersion: 0 },
        JWT_SECRET,
        { expiresIn: '4h' }
      );
      logger.warn(`[Login] Fallback admin login used (${fallbackAdminUsername}) - MongoDB was unavailable`);
      return res.json({
        token: fallbackToken,
        user: { id: 'fallback-admin', username: fallbackAdminUsername, role: 'admin', balance: 0, needsPasswordChange: false }
      });
    }
    
    // Si no existe localmente, verificar en JUGAYGANA (solo para login por username)
    if (!user && username) {
      logger.debug(`User ${username} not found locally, checking JUGAYGANA...`);

      // ⚠️ Sin contraseña no se importa nada: el `temporaryCode` sólo puede
      // existir para un usuario que YA está en esta base.
      if (!password) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }

      const jgUser = await jugaygana.getUserInfoByName(username);

      if (jgUser) {
        // La contraseña se valida CONTRA JUGAYGANA antes de importar nada.
        // Antes se creaba el usuario con la contraseña FIJA 'asd123' y después
        // se comparaba contra ese mismo valor → cualquiera que supiera un
        // username entraba escribiendo "asd123" y se quedaba con la cuenta.
        const jgLogin = await jugayganaService.loginAsUser(username, password);

        if (!jgLogin.success) {
          if (jgLogin.transient) {
            // La plataforma no respondió: NO podemos afirmar que la contraseña
            // esté mal. Decirle "credenciales inválidas" a alguien que la tiene
            // bien lo manda a resetearla al pedo.
            logger.warn(`[Login] No se pudo validar ${username} contra JUGAYGANA: ${jgLogin.error}`);
            return res.status(503).json({
              error: 'La plataforma no está respondiendo en este momento. Probá de nuevo en 1-2 minutos.',
              code: 'PLATFORM_UNAVAILABLE'
            });
          }
          logger.debug(`[Login] JUGAYGANA rechazó la contraseña de ${username}`);
          return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        logger.info(`[Login] ${username} validado contra JUGAYGANA — importando localmente`);

        const userId = uuidv4();

        user = await User.create({
          id: userId,
          username: jgUser.username,
          // Su contraseña REAL de JUGAYGANA (el pre-save del modelo la hashea).
          password: password,
          email: jgUser.email || null,
          phone: jgUser.phone || null,
          role: 'user',
          accountNumber: generateAccountNumber(),
          balance: jgUser.balance || 0,
          createdAt: new Date(),
          lastLogin: null,
          isActive: true,
          jugayganaUserId: jgUser.id,
          jugayganaUsername: jgUser.username,
          jugayganaSyncStatus: 'linked',
          source: 'jugaygana',
          tokenVersion: 0
          // Nota: ya NO forzamos cambio de contraseña por la default "asd123".
          // Los usuarios importados de JUGAYGANA pueden usar la app con su
          // contraseña inicial. Removido a pedido.
        });
        
        // Crear chat status
        await ChatStatus.create({
          userId: userId,
          username: jgUser.username,
          status: 'open',
          category: 'cargas'
        });
        
        logger.info(`User ${username} auto-created from JUGAYGANA`);
      } else {
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }
    } else if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    
    // Convertir a objeto plano para acceder a los campos correctamente
    const userObj = user.toObject ? user.toObject() : user;
    
    // Usar 'id' si existe, sino usar '_id' como fallback
    const userId = userObj.id || userObj._id?.toString();
    
    logger.debug(`User found: ${userObj.username}, ID: ${userId}`);
    
    const loginIdentifier = username || phone;
    
    if (!userId) {
      logger.error(`User ${loginIdentifier} has no valid ID`);
      return res.status(500).json({ error: 'Error de configuración de usuario. Contacta al administrador.' });
    }
    
    if (!userObj.isActive) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Reject login for blocked users before doing any further work.
    if (userObj.isBlocked === true) {
      return res.status(403).json({
        error: `Tu cuenta está bloqueada: ${userObj.blockReason || 'Contactá a soporte.'}`,
        code: 'USER_BLOCKED'
      });
    }
    
    // Verificar que el usuario tenga una contraseña válida
    if (!userObj.password) {
      logger.error(`User ${loginIdentifier} has no password configured`);
      return res.status(500).json({ error: 'Error de configuración de usuario. Contacta al administrador.' });
    }
    
    // Verificar si la contraseña almacenada es un hash bcrypt válido
    const isValidBcryptHash = userObj.password.startsWith('$2') || userObj.password.startsWith('$2a$') || userObj.password.startsWith('$2b$');
    if (!isValidBcryptHash) {
      logger.error(`User ${loginIdentifier} has password in invalid format`);
      return res.status(500).json({ error: 'Error de configuración de usuario. Contacta al administrador.' });
    }
    
    // Cambio de contraseña obligatorio por contraseña default "asd123": REMOVIDO.
    // Los usuarios de JUGAYGANA pueden usar la app con su contraseña inicial sin
    // estar obligados a cambiarla. El único caso que todavía fuerza un cambio es
    // el reset MANUAL hecho por un admin (POST /api/admin/users/:id/reset-password),
    // que setea mustChangePassword:true sobre una contraseña nueva — ese flag se
    // respeta más abajo a través de user.mustChangePassword.
    const isDefaultPassword = password === 'asd123';
    const needsPasswordChange = false;
    
    let isValidPassword = false;

    if (userObj.loginWithoutPassword === true && !isAdminRole(userObj.role)) {
      // Un admin habilitó "entrar solo con usuario" para este cliente:
      // se ignora la contraseña y el SMS por completo.
      logger.info(`Login sin clave (habilitado por admin) para ${loginIdentifier}`);
      isValidPassword = true;
    } else if (temporaryCode && !password) {
      // Login con código temporal de acceso: fallback para usuarios que entraron
      // en "modo temporal" al cambiar la contraseña y todavía no verificaron su
      // teléfono. El código vale mientras phoneVerificationPending siga en true
      // (al verificar el teléfono por SMS el código deja de funcionar).
      const code = String(temporaryCode).trim();
      const codeOk = userObj.pendingAccessCode
        && userObj.phoneVerificationPending === true
        && safeCompare(code, String(userObj.pendingAccessCode));
      if (!codeOk) {
        logger.debug(`Invalid temporary code for ${loginIdentifier}`);
        return res.status(401).json({ error: 'Código temporal inválido o vencido' });
      }
      isValidPassword = true;
    } else {
      try {
        isValidPassword = await bcrypt.compare(password, userObj.password);
      } catch (bcryptError) {
        logger.error(`Error comparing password for ${loginIdentifier}: ${bcryptError.message}`);
      }

      // ELIMINADO (2026-08-13, a pedido del owner): el fallback que aceptaba la
      // contraseña FIJA "asd123" para usuarios con source==='jugaygana' que aún
      // no la habían cambiado. Era un atajo de contraseña conocida: alcanzaba
      // con saber un username para entrar a esa cuenta. La importación desde
      // JUGAYGANA ahora valida la contraseña REAL contra la plataforma
      // (jugayganaService.loginAsUser) y la guarda hasheada, así que este
      // atajo dejó de ser necesario. Rollback: git revert.
    }
    
    if (!isValidPassword) {
      logger.debug(`Wrong password for ${loginIdentifier}`);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    
    logger.info(`Login successful for ${loginIdentifier}`);
    
    // Actualizar lastLogin usando el modelo de Mongoose
    user.lastLogin = new Date();
    // Self-heal del flag mustChangePassword:
    //  - Admins NUNCA deben llevarlo (cuenta interna, sin contraparte JUGAYGANA).
    //  - Usuarios que quedaron marcados por la vieja lógica del default "asd123"
    //    y están logueando justamente con "asd123": limpiamos el flag para que no
    //    queden trabados. NO afecta los resets manuales de admin, porque ésos
    //    setean una contraseña nueva distinta de "asd123".
    if (user.mustChangePassword === true && (isAdminRole(user.role) || isDefaultPassword)) {
      user.mustChangePassword = false;
      logger.info(`[login] Auto-limpieza de mustChangePassword para ${user.username} (${isAdminRole(user.role) ? 'admin' : 'default-password'})`);
    }

    // Atribución last-touch: si el visitante vuelve por un anuncio nuevo, el
    // front manda fbc/fbp/landingUrl en el body. Actualizamos el User para
    // que las próximas conversiones (Purchase, etc.) atribuyan al click más
    // reciente, no al de cuando se registró.
    const _loginFbc = sanitizeFbCookie(fbc);
    const _loginFbp = sanitizeFbCookie(fbp);
    if (_loginFbc && _loginFbc !== user.metaFbc) user.metaFbc = _loginFbc;
    if (_loginFbp && _loginFbp !== user.metaFbp) user.metaFbp = _loginFbp;
    if (typeof landingUrl === 'string' && landingUrl.length > 0 && landingUrl.length <= 2000 && landingUrl !== user.landingUrl) {
      user.landingUrl = landingUrl;
    }

    await user.save();
    
    // Token con expiración de 30 días para persistencia de sesión
    const token = jwt.sign(
      { userId: userId, username: userObj.username, role: userObj.role, tokenVersion: userObj.tokenVersion ?? 0 },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    
    // Intentar login en JUGAYGANA para obtener token de sesión (best-effort).
    // Admin roles have no counterpart in JUGAYGANA, so skip entirely.
    let jugayganaToken = null;
    if (!isAdminRole(userObj.role)) {
      try {
        const jgLogin = await jugayganaService.loginAsUser(userObj.username, password);
        if (jgLogin.success) {
          jugayganaToken = jgLogin.token;
          logger.info(`Token JUGAYGANA obtenido para: ${loginIdentifier}`);
        } else {
          logger.warn(`No se pudo obtener token JUGAYGANA para ${loginIdentifier}: ${jgLogin.error}`);
        }
      } catch (jgErr) {
        logger.warn(`Error obteniendo token JUGAYGANA para ${loginIdentifier}: ${jgErr.message}`);
      }
    }
    
    // Set an httpOnly admin session cookie for admin roles so that the server
    // can verify, on subsequent page requests, that the browser was genuinely
    // authenticated — not just checking localStorage (client-side only).
    // An httpOnly, SameSite=Strict, path-scoped cookie is the recommended
    // alternative to localStorage for session tokens: it is inaccessible to
    // JavaScript (XSS-safe) and is scoped to the admin path only.
    // publisher_admin también entra al panel /adminprivado2026 (vista limitada),
    // por eso recibe la misma cookie que los otros roles administrativos.
    const adminRoles = ['admin', 'depositor', 'withdrawer', 'publisher_admin', 'comunidad'];
    if (adminRoles.includes(userObj.role)) {
      // Set two httpOnly cookies: one for page access, one for API calls.
      // Neither can be read by client-side scripts (XSS-safe).
      const adminCookieToken = jwt.sign(
        { userId: userId, username: userObj.username, role: userObj.role, tokenVersion: userObj.tokenVersion ?? 0 },
        JWT_SECRET,
        { expiresIn: '8h' }
      );
      res.setHeader('Set-Cookie', buildAdminSessionCookieHeaders(adminCookieToken));
    }

    // Meta CAPI — Login (custom event) sólo para usuarios finales, no admins.
    if (!isAdminRole(userObj.role)) {
      metaCapi.track(
        'Login',
        { email: userObj.email, phone: userObj.phone, externalId: userId, fbc: userObj.metaFbc, fbp: userObj.metaFbp },
        { content_name: 'login' },
        { eventId: req.body && req.body.metaEventId, req }
      );
    }

    res.json({
      message: 'Login exitoso',
      token,
      jugayganaToken,
      user: {
        id: userId,
        username: userObj.username,
        email: userObj.email,
        phone: userObj.phone || null,
        phoneVerified: userObj.phoneVerified || false,
        phoneVerificationPending: userObj.phoneVerificationPending === true,
        firstLogin: !userObj.lastLogin,
        notificationPlan: userObj.notificationPlan || null,
        whatsapp: userObj.whatsapp || null,
        accountNumber: userObj.accountNumber,
        role: userObj.role,
        balance: userObj.balance,
        jugayganaLinked: !!userObj.jugayganaUserId,
        needsPasswordChange: needsPasswordChange,
        // Leemos del doc vivo `user` (no del snapshot `userObj`) para reflejar
        // la auto-limpieza recién hecha. Sólo queda true si un admin reseteó
        // manualmente la contraseña a una nueva (distinta de "asd123").
        mustChangePassword: isAdminRole(user.role) ? false : (user.mustChangePassword === true),
        metaMatching: isAdminRole(userObj.role) ? null : metaCapi.buildAdvancedMatching({
          email: userObj.email,
          phone: userObj.phone,
          externalId: userId
        })
      }
    });
  } catch (error) {
    logger.error(`Login error: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// User logout — limpia el token FCM actual del backend para que las
// notificaciones no sigan llegando a este dispositivo después de cerrar
// sesión. Acepta el fcmToken por body o por query; si no viene, intenta
// inferirlo del header Authorization (último token registrado del user).
// Nunca devuelve 401: cerrar sesión siempre es válido aunque el token JWT
// esté expirado.
app.post('/api/auth/logout', async (req, res) => {
  try {
    const fcmToken = (req.body && req.body.fcmToken) || (req.query && req.query.fcmToken) || null;

    // Intentar identificar al usuario por el JWT. Si está expirado o ausente,
    // hacemos best-effort: borramos el fcmToken provisto donde sea que esté.
    let userId = null;
    const authHeader = req.headers.authorization || '';
    const authToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (authToken) {
      try {
        const decoded = jwt.verify(authToken, JWT_SECRET, { algorithms: ['HS256'] });
        userId = decoded.userId;
      } catch (_) {
        // JWT expirado/inválido: igual seguimos para limpiar por token si vino
      }
    }

    if (fcmToken) {
      const tokenStr = String(fcmToken);
      // Borrar del array fcmTokens y del campo individual donde coincida
      if (userId) {
        await User.updateOne(
          { id: userId },
          { $pull: { fcmTokens: { token: tokenStr } } }
        );
        await User.updateOne(
          { id: userId, fcmToken: tokenStr },
          { $set: { fcmToken: null, fcmTokenUpdatedAt: null } }
        );
      } else {
        // Sin userId verificado: borrar el token donde sea que esté.
        await User.updateMany(
          { 'fcmTokens.token': tokenStr },
          { $pull: { fcmTokens: { token: tokenStr } } }
        );
        await User.updateMany(
          { fcmToken: tokenStr },
          { $set: { fcmToken: null, fcmTokenUpdatedAt: null } }
        );
      }
      logger.info(`[AUTH] logout: token FCM eliminado (user=${userId || 'unknown'}, token=...${tokenStr.slice(-8)})`);
    }

    res.json({ success: true });
  } catch (error) {
    // Logout siempre debe responder OK al cliente; loggeamos para diagnóstico.
    logger.warn(`[AUTH] logout: error limpiando token FCM: ${error.message}`);
    res.json({ success: true });
  }
});

// Admin logout — clears both admin httpOnly cookies.
// No authentication required: clearing a cookie is harmless.
app.post('/api/auth/admin-logout', (req, res) => {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `admin_session=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/adminprivado2026${secure}`,
    `admin_api_session=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/api${secure}`
  ]);
  res.json({ success: true });
});

// Verify token
app.get('/api/auth/verify', authMiddleware, async (req, res) => {
  try {
    // Buscar usuario completo
    const user = await User.findOne({ id: req.user.userId }).select('-password').lean();
    
    if (!user) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }
    
    res.json({
      valid: true,
      user: {
        userId: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        balance: user.balance,
        mustChangePassword: user.mustChangePassword === true,
        metaMatching: isAdminRole(user.role) ? null : metaCapi.buildAdvancedMatching({
          email: user.email,
          phone: user.phone,
          externalId: user.id
        })
      }
    });
  } catch (error) {
    console.error('Error verificando token:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/me — verify admin session via httpOnly cookie and return admin info.
// The frontend uses this on page load instead of reading from localStorage.
// Also returns a short-lived token for in-memory Socket.IO authentication.
app.get('/api/admin/me', async (req, res) => {
  const cookieToken = getAdminApiSessionCookie(req);
  if (!cookieToken) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  try {
    const decoded = jwt.verify(cookieToken, JWT_SECRET, { algorithms: ['HS256'] });
    // publisher_admin también accede al panel (vista limitada) y por eso entra
    // en la lista de roles permitidos para /api/admin/me.
    const adminRoles = ['admin', 'depositor', 'withdrawer', 'publisher_admin', 'comunidad'];
    if (!adminRoles.includes(decoded.role)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    // Fetch fresh user info from DB
    let user = await User.findOne({ id: decoded.userId }).select('-password').lean();
    if (!user) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }
    if (!user.isActive) {
      return res.status(401).json({ error: 'Usuario desactivado' });
    }
    if (user.isBlocked === true) {
      return res.status(403).json({ error: 'Cuenta bloqueada' });
    }
    // El rol y el tokenVersion se revalidan contra la DB: un admin degradado
    // o con la sesión revocada no debe seguir entrando con la cookie vieja.
    if (!adminRoles.includes(user.role)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    if ((decoded.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
      return res.status(401).json({ error: 'Sesión expirada' });
    }
    // Issue a fresh short-lived in-memory token for Socket.IO auth.
    // This is NOT stored in localStorage — only held in JavaScript memory.
    const freshToken = jwt.sign(
      { userId: user.id, username: user.username, role: user.role, tokenVersion: user.tokenVersion ?? 0 },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        phone: user.phone || null,
        phoneVerified: user.phoneVerified || false,
        role: user.role,
        balance: user.balance,
        needsPasswordChange: !user.passwordChangedAt,
        // Sólo se llena para role='publisher_admin'. El front lo usa para mostrar
        // qué publicista representa la cuenta y para filtrar el mini-dashboard.
        publisherCampaignCode: user.publisherCampaignCode || null
      },
      token: freshToken
    });
  } catch (error) {
    return res.status(401).json({ error: 'Sesión inválida o expirada' });
  }
});

// Obtener información del usuario actual
app.get('/api/users/me', authMiddleware, async (req, res) => {
  try {
    // Buscar por 'id' primero, luego por '_id' como fallback
    let user = await User.findOne({ id: req.user.userId })
      .select(USER_PUBLIC_FIELDS)
      .lean();
    
    if (!user) {
      try {
        user = await User.findById(req.user.userId)
          .select(USER_PUBLIC_FIELDS)
          .lean();
      } catch (e) {
        // _id inválido, ignorar
      }
    }
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Hashes para Advanced Matching del pixel browser (sólo usuarios finales).
    // El frontend re-inicializa fbq con estos valores para mejorar el match en
    // todos los eventos client-side.
    const metaMatching = isAdminRole(user.role) ? null : metaCapi.buildAdvancedMatching({
      email: user.email,
      phone: user.phone,
      externalId: user.id
    });
    res.json({ ...user, metaMatching });
  } catch (error) {
    console.error('Error obteniendo usuario:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Sincroniza la contraseña con JUGAYGANA reintentando hasta 3 veces.
// Si tras los 3 intentos no se puede sincronizar, crea un mensaje interno
// (adminOnly) en el chat del usuario para que los admins sepan que la
// contraseña quedó desincronizada y puedan corregirla manualmente.
async function syncPasswordToJugaygana(user, newPassword, context) {
  if (isAdminRole(user.role)) {
    return { success: true, skipped: true };
  }

  const MAX_ATTEMPTS = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const jgResult = await jugayganaService.changeUserPasswordAsAdmin(user.username, newPassword);
      if (jgResult.success) {
        logger.info(`[pwd-sync] Sincronizada con JUGAYGANA (${context}) para ${user.username} en intento ${attempt}/${MAX_ATTEMPTS}`);
        return { success: true, attempts: attempt };
      }
      lastError = jgResult.error || 'Error desconocido';
      logger.warn(`[pwd-sync] Intento ${attempt}/${MAX_ATTEMPTS} falló para ${user.username}: ${lastError}`);
    } catch (err) {
      lastError = err.message;
      logger.error(`[pwd-sync] Intento ${attempt}/${MAX_ATTEMPTS} con excepción para ${user.username}: ${lastError}`);
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }
  }

  logger.error(`[pwd-sync] Falló sync con JUGAYGANA para ${user.username} tras ${MAX_ATTEMPTS} intentos. Último error: ${lastError}`);

  try {
    await Message.create({
      id: uuidv4(),
      senderId: 'system',
      senderUsername: 'SYSTEM',
      senderRole: 'system',
      receiverId: user.id,
      receiverRole: 'user',
      content: `⚠️ SYNC FALLIDO: el usuario cambió su contraseña en VIPCARGAS pero no se pudo sincronizar con jugaygana44.bet tras ${MAX_ATTEMPTS} intentos. Último error: "${lastError}". Revisar y actualizar la contraseña manualmente en la plataforma. Contexto: ${context}.`,
      type: 'system',
      adminOnly: true,
      read: true,
      timestamp: new Date()
    });
    logger.info(`[pwd-sync] Mensaje interno creado para admins en chat de ${user.username}`);
  } catch (msgErr) {
    logger.error(`[pwd-sync] No se pudo crear mensaje interno para ${user.username}: ${msgErr.message}`);
  }

  return { success: false, attempts: MAX_ATTEMPTS, error: lastError };
}

// Cambiar contraseña
app.post('/api/auth/change-password', authMiddleware, authLimiter, async (req, res) => {
  try {
    const { newPassword, whatsapp, phone, otpCode, closeAllSessions } = req.body;

    // Buscar por 'id' primero, luego por '_id' como fallback
    let user = await User.findOne({ id: req.user.userId });
    
    if (!user) {
      try {
        user = await User.findById(req.user.userId);
      } catch (e) {
        // _id inválido, ignorar
      }
    }
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    // Determinar si el usuario YA tiene un teléfono verificado vía OTP.
    // Solo en ese caso se permite cambiar la contraseña sin volver a verificar nada.
    const hasVerifiedPhone = !!(user.phone && user.phoneVerified === true);

    // Resolver el "nuevo teléfono" propuesto: priorizar `phone` (formato internacional),
    // y como fallback aceptar `whatsapp` por compatibilidad con el cliente actual.
    const requestedPhoneRaw = (typeof phone === 'string' && phone.trim())
      || (typeof whatsapp === 'string' && whatsapp.trim())
      || null;
    const requestedPhone = requestedPhoneRaw ? requestedPhoneRaw.trim() : null;

    // ¿Se está intentando agregar/cambiar el teléfono?
    // - Si el usuario NO tiene teléfono verificado y se envió un teléfono → exigir OTP.
    // - Si el usuario YA tiene teléfono verificado y se envió un teléfono distinto → exigir OTP.
    // - Si el usuario YA tiene teléfono verificado y NO se envió teléfono (o coincide) → no se exige OTP,
    //   solo se valida la contraseña actual del usuario (esto cubre el caso "cambio de contraseña sin tocar teléfono").
    let isPhoneChange = false;
    if (requestedPhone) {
      if (!hasVerifiedPhone) {
        isPhoneChange = true;
      } else if (requestedPhone !== user.phone) {
        isPhoneChange = true;
      }
    } else if (!hasVerifiedPhone) {
      // No tiene teléfono verificado y no envió uno → no podemos guardar phoneVerified=true,
      // pero permitimos cambiar la contraseña. (No debería ocurrir desde el flujo forzado,
      // ya que el front exige el teléfono cuando no hay uno verificado.)
      isPhoneChange = false;
    }

    if (isPhoneChange) {
      // Validar formato del teléfono propuesto.
      if (!validateInternationalPhone(requestedPhone)) {
        return res.status(400).json({
          error: 'Número de teléfono inválido. Usá formato internacional con código de país (ej: +5491155551234)'
        });
      }
      // Exigir código OTP previamente enviado vía /api/auth/change-password/send-otp.
      if (!otpCode || String(otpCode).trim().length < 6) {
        return res.status(400).json({ error: 'Se requiere el código de verificación SMS' });
      }
      // Verificar que el teléfono no esté ya registrado y verificado por otro usuario
      // (por clave normalizada: detecta el mismo número en distinto formato).
      const _reqPhoneKey = normalizePhoneKey(requestedPhone);
      const otherUser = await User.findOne({
        phoneKey: _reqPhoneKey,
        phoneVerified: true,
        id: { $ne: user.id }
      }).lean();
      if (otherUser) {
        return res.status(400).json({ error: 'Este número de teléfono ya está registrado por otra cuenta' });
      }
      const otpResult = await verifyOTP(requestedPhone, String(otpCode).trim(), 'change-password');
      if (!otpResult.valid) {
        return res.status(400).json({ error: otpResult.error || 'Código de verificación incorrecto o expirado' });
      }
      // OTP válido: persistir teléfono verificado.
      user.phone = requestedPhone;
      user.phoneKey = _reqPhoneKey;
      user.phoneVerified = true;
      user.smsConsent = true;
      // Mantener `whatsapp` sincronizado para compatibilidad con vistas que lo siguen leyendo.
      user.whatsapp = requestedPhone;
    }

    // Defensa contra robo de token: si NO es un cambio de teléfono (donde el
    // OTP ya prueba identidad) y NO es el cambio obligatorio de primer ingreso,
    // exigir la contraseña actual antes de permitir el cambio.
    if (!isPhoneChange && user.mustChangePassword !== true) {
      const currentPassword = req.body && req.body.currentPassword;
      let currentOk = false;
      if (currentPassword) {
        try {
          currentOk = await bcrypt.compare(String(currentPassword), user.password);
        } catch (e) {
          currentOk = false;
        }
      }
      if (!currentOk) {
        return res.status(401).json({ error: 'La contraseña actual es incorrecta', code: 'BAD_CURRENT_PASSWORD' });
      }
    }

    // Asignar contraseña en texto plano; el middleware pre-save del modelo la hasheará
    user.password = newPassword;
    user.passwordChangedAt = new Date();
    // The user just changed their password (and verified the OTP for any new
    // phone, if applicable). Lift the mandatory-change flag so the rest of the
    // API stops returning 403 MUST_CHANGE_PASSWORD on subsequent requests.
    user.mustChangePassword = false;
    
    if (closeAllSessions) {
      user.tokenVersion = (user.tokenVersion || 0) + 1;
    }
    
    await user.save();

    await syncPasswordToJugaygana(user, newPassword, 'change-password');

    res.json({
      message: 'Contraseña cambiada exitosamente',
      sessionsClosed: closeAllSessions || false,
      phoneVerified: !!user.phoneVerified,
      phone: user.phone || null
    });
  } catch (error) {
    logger.error(`Error en change-password: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Enviar OTP para verificar el teléfono nuevo durante un cambio de contraseña
// (aplica tanto al cambio obligatorio del primer login como al cambio desde el perfil).
// Reutiliza generateAndSendOTP/verifyOTP del PR #260 con un nuevo `purpose`.
app.post('/api/auth/change-password/send-otp', authMiddleware, sensitiveLimiter, smsIpLimiter, async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ error: 'Número de teléfono requerido' });
    }

    const normalizedPhone = phone.trim();
    if (!validateInternationalPhone(normalizedPhone)) {
      return res.status(400).json({
        error: 'Número de teléfono inválido. Usá formato internacional con código de país (ej: +5491155551234)'
      });
    }

    // Buscar el usuario autenticado.
    let user = await User.findOne({ id: req.user.userId }).lean();
    if (!user) {
      try {
        user = await User.findById(req.user.userId).lean();
      } catch (e) { /* ignorar id inválido */ }
    }
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Si otro usuario distinto ya tiene este teléfono verificado, rechazar (por clave normalizada).
    const _normPhoneKey = normalizePhoneKey(normalizedPhone);
    const otherUser = await User.findOne({
      phoneKey: _normPhoneKey,
      phoneVerified: true,
      id: { $ne: user.id }
    }).lean();
    if (otherUser) {
      return res.status(400).json({ error: 'Este número de teléfono ya está registrado por otra cuenta' });
    }

    const result = await generateAndSendOTP(normalizedPhone, 'change-password');
    if (!result.success) {
      return res.status(429).json({ error: result.error });
    }

    const maskedPhone = normalizedPhone.replace(/(\+\d{1,4})\d+(\d{4})$/, '$1****$2');
    res.json({
      success: true,
      pendingVerification: true,
      phone: maskedPhone,
      message: 'Te enviamos un código SMS al número indicado'
    });
  } catch (error) {
    logger.error(`Error en change-password/send-otp: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Cambio de contraseña en "modo temporal": cuando al usuario no le llega el SMS
// o el OTP le da error repetido, puede entrar igual. Cambia la contraseña SIN
// verificar el teléfono, lo guarda como NO verificado y deja al usuario en
// estado `phoneVerificationPending: true`. Genera un `pendingAccessCode` al azar
// (6 dígitos). El usuario puede usar la app pero NO puede retirar hasta verificar
// el teléfono por SMS (lo exige /api/withdrawal/request).
app.post('/api/auth/change-password/pending', authMiddleware, authLimiter, async (req, res) => {
  try {
    const { newPassword, whatsapp, phone, closeAllSessions } = req.body;

    let user = await User.findOne({ id: req.user.userId });
    if (!user) {
      try { user = await User.findById(req.user.userId); } catch (e) { /* _id inválido */ }
    }
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const requestedPhoneRaw = (typeof phone === 'string' && phone.trim())
      || (typeof whatsapp === 'string' && whatsapp.trim())
      || null;
    const requestedPhone = requestedPhoneRaw ? requestedPhoneRaw.trim() : null;

    if (requestedPhone && !validateInternationalPhone(requestedPhone)) {
      return res.status(400).json({
        error: 'Número de teléfono inválido. Usá formato internacional con código de país (ej: +5491155551234)'
      });
    }

    // Código de acceso temporal al azar (6 dígitos).
    const pendingCode = String(crypto.randomInt(0, 1000000)).padStart(6, '0');

    user.password = newPassword;
    user.passwordChangedAt = new Date();
    user.mustChangePassword = false;
    user.pendingAccessCode = pendingCode;
    // El usuario entra, pero queda con verificación de teléfono pendiente:
    // no podrá retirar hasta verificar por SMS.
    user.phoneVerificationPending = true;
    user.phoneVerified = false;
    if (requestedPhone) {
      // Guardar el teléfono como NO verificado.
      user.phone = requestedPhone;
      user.whatsapp = requestedPhone;
    }

    if (closeAllSessions) {
      user.tokenVersion = (user.tokenVersion || 0) + 1;
    }

    await user.save();

    await syncPasswordToJugaygana(user, newPassword, 'change-password');

    res.json({
      message: 'Contraseña cambiada. Entraste en modo temporal.',
      temporaryAccess: true,
      pendingAccessCode: pendingCode,
      phoneVerificationPending: true,
      sessionsClosed: closeAllSessions || false
    });
  } catch (error) {
    logger.error(`Error en change-password/pending: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Platform login: obtener token de JUGAYGANA para auto-login
app.post('/api/auth/platform-login', authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'Contraseña requerida' });
    }

    const user = await User.findOne({ id: req.user.userId });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    const jgLogin = await jugayganaService.loginAsUser(user.username, password);
    if (!jgLogin.success) {
      return res.status(502).json({ error: `No se pudo iniciar sesión en la plataforma: ${jgLogin.error}` });
    }

    res.json({
      success: true,
      jugayganaToken: jgLogin.token,
      platformUrl: 'https://www.jugaygana44.bet'
    });
  } catch (error) {
    logger.error(`Error en platform-login: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// RUTAS PÚBLICAS - OTP / VERIFICACIÓN SMS
// ============================================

// Enviar OTP para verificación de teléfono en el registro
app.post('/api/auth/send-register-otp', sensitiveLimiter, smsIpLimiter, async (req, res) => {
  try {
    const { phone, username } = req.body;

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ error: 'Número de teléfono requerido' });
    }

    const normalizedPhone = phone.trim();
    if (!validateInternationalPhone(normalizedPhone)) {
      return res.status(400).json({ error: 'Número de teléfono inválido. Usa formato internacional con código de país (ej: +5491155551234)' });
    }

    // Validar username si fue proporcionado
    if (username) {
      const existing = await findUserByUsernameCI(String(username).trim(), { lean: true });
      if (existing) {
        return res.status(400).json({ error: 'El nombre de usuario ya está en uso' });
      }
    }

    // Verificar que el teléfono no esté ya registrado y verificado
    const existingPhone = await User.findOne({ phone: normalizedPhone, phoneVerified: true }).lean();
    if (existingPhone) {
      return res.status(400).json({ error: 'Este número de teléfono ya está registrado' });
    }

    const result = await generateAndSendOTP(normalizedPhone, 'register');

    if (!result.success) {
      return res.status(429).json({ error: result.error });
    }

    const maskedPhone = normalizedPhone.replace(/(\+\d{1,4})\d+(\d{4})$/, '$1****$2');

    // Meta CAPI — Lead (intención de registro, OTP enviado).
    metaCapi.track(
      'Lead',
      { phone: normalizedPhone },
      { content_name: 'register_otp_sent' },
      { eventId: req.body && req.body.metaEventId, req }
    );

    res.json({
      success: true,
      pendingVerification: true,
      phone: maskedPhone,
      message: 'Te enviamos un código SMS al número indicado'
    });
  } catch (error) {
    logger.error(`Error en send-register-otp: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Solicitar OTP para login por teléfono (anti-enumeration: siempre responde igual)
app.post('/api/auth/login-otp-request', authLimiter, smsIpLimiter, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ error: 'Número de teléfono requerido' });
    }
    const normalizedPhone = phone.trim();
    if (!validateInternationalPhone(normalizedPhone)) {
      return res.status(400).json({ error: 'Número de teléfono inválido' });
    }

    // Check if user exists with this phone (verified)
    const user = await User.findOne({ phone: normalizedPhone, phoneVerified: true }).lean();

    // ANTI-ENUMERATION: Always respond the same way
    if (user) {
      try {
        await generateAndSendOTP(normalizedPhone, 'login');
      } catch (err) {
        logger.warn(`[LoginOTP] Error generando OTP: ${err.message}`);
      }
    }

    // Always return success to prevent phone enumeration
    const maskedPhone = normalizedPhone.replace(/(\+\d{1,4})\d+(\d{4})$/, '$1****$2');
    res.json({
      success: true,
      message: 'Si el número está registrado, recibirás un código SMS',
      phone: maskedPhone
    });
  } catch (error) {
    logger.error(`[LoginOTP] Error: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Verificar OTP para login por teléfono
app.post('/api/auth/login-otp-verify', authLimiter, async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ error: 'Teléfono y código requeridos' });
    }
    const normalizedPhone = phone.trim();

    const otpResult = await verifyOTP(normalizedPhone, code, 'login');
    if (!otpResult.valid) {
      return res.status(400).json({ error: otpResult.error || 'Código incorrecto o expirado' });
    }

    const user = await User.findOne({ phone: normalizedPhone, phoneVerified: true });
    if (!user) {
      return res.status(400).json({ error: 'Código incorrecto o expirado' });
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    const userObj = user.toObject ? user.toObject() : user;
    const userId = userObj.id || userObj._id?.toString();

    // Generate token (same as regular login)
    const token = jwt.sign(
      { userId: userId, username: userObj.username, role: userObj.role, tokenVersion: userObj.tokenVersion || 0 },
      JWT_SECRET,
      { expiresIn: '90d' }
    );

    // Set admin cookies if applicable (incluye publisher_admin que también
    // usa la UI del panel administrativo en /adminprivado2026, en vista limitada).
    const adminRoles = ['admin', 'depositor', 'withdrawer', 'publisher_admin', 'comunidad'];
    if (adminRoles.includes(userObj.role)) {
      const adminCookieToken = jwt.sign(
        { userId: userId, username: userObj.username, role: userObj.role, tokenVersion: userObj.tokenVersion ?? 0 },
        JWT_SECRET,
        { expiresIn: '8h' }
      );
      res.setHeader('Set-Cookie', buildAdminSessionCookieHeaders(adminCookieToken));
    }

    logger.info(`Login successful for ${userObj.username} via OTP`);

    res.json({
      message: 'Login exitoso',
      token,
      user: {
        id: userId,
        userId: userId,
        username: userObj.username,
        email: userObj.email,
        phone: userObj.phone,
        phoneVerified: userObj.phoneVerified || false,
        whatsapp: userObj.whatsapp || null,
        accountNumber: userObj.accountNumber,
        role: userObj.role,
        balance: userObj.balance,
        jugayganaLinked: !!userObj.jugayganaUserId,
        needsPasswordChange: false,
        mustChangePassword: userObj.mustChangePassword === true,
        referralCode: userObj.referralCode
      }
    });
  } catch (error) {
    logger.error(`[LoginOTP] Verify error: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Solicitar reset de contraseña por SMS (anti-enumeration: siempre responde igual)
app.post('/api/auth/request-password-reset', sensitiveLimiter, smsIpLimiter, async (req, res) => {
  const ANTI_ENUM_MESSAGE = 'Si este número está vinculado a una cuenta, recibirás un código SMS en los próximos segundos. Si no recibís ningún código, significa que este número no está asociado a ninguna cuenta.';

  try {
    const { phone } = req.body;

    if (phone && typeof phone === 'string') {
      const normalizedPhone = phone.trim();
      if (validateInternationalPhone(normalizedPhone)) {
        const user = await User.findOne({ phone: normalizedPhone, phoneVerified: true }).lean();
        if (user) {
          try {
            await generateAndSendOTP(normalizedPhone, 'reset');
          } catch (err) {
            logger.warn(`[request-password-reset] Error generando OTP: ${err.message}`);
          }
        }
      }
    }
  } catch (error) {
    logger.error(`Error en request-password-reset: ${error.message}`);
  }

  // SIEMPRE la misma respuesta (anti-enumeration)
  res.json({ success: true, message: ANTI_ENUM_MESSAGE });
});

// Verificar código OTP para reset de contraseña
app.post('/api/auth/verify-reset-otp', sensitiveLimiter, async (req, res) => {
  try {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({ error: 'Teléfono y código requeridos' });
    }

    const normalizedPhone = phone.trim();
    if (!validateInternationalPhone(normalizedPhone)) {
      return res.status(400).json({ error: 'Número de teléfono inválido' });
    }

    const otpResult = await verifyOTP(normalizedPhone, String(code).trim(), 'reset');

    if (!otpResult.valid) {
      return res.status(400).json({ error: otpResult.error || 'Código incorrecto o expirado' });
    }

    // Buscar usuario con ese teléfono verificado
    const user = await User.findOne({ phone: normalizedPhone, phoneVerified: true }).lean();

    if (!user) {
      return res.status(400).json({ error: 'Código incorrecto o expirado' });
    }

    // Generar JWT temporal de 5 minutos solo para reset. Lleva el tokenVersion
    // actual del usuario: al completar el reset se incrementa, dejando el
    // resetToken inservible para un segundo uso.
    const resetToken = jwt.sign(
      { userId: user.id, username: user.username, purpose: 'reset', tokenVersion: user.tokenVersion ?? 0 },
      JWT_SECRET,
      { expiresIn: '5m' }
    );

    res.json({
      success: true,
      verified: true,
      username: user.username,
      resetToken
    });
  } catch (error) {
    logger.error(`Error en verify-reset-otp: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Completar reset de contraseña usando el JWT temporal
app.post('/api/auth/complete-password-reset', sensitiveLimiter, async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;

    if (!resetToken || !newPassword) {
      return res.status(400).json({ error: 'Token y nueva contraseña requeridos' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    let decoded;
    try {
      decoded = jwt.verify(resetToken, JWT_SECRET, { algorithms: ['HS256'] });
    } catch (err) {
      return res.status(400).json({ error: 'Token de reset inválido o expirado' });
    }

    if (decoded.purpose !== 'reset') {
      return res.status(400).json({ error: 'Token de reset inválido' });
    }

    const user = await User.findOne({ id: decoded.userId });

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // El resetToken es de un solo uso: si su tokenVersion no coincide con el
    // del usuario, ya fue usado (o las sesiones se cerraron) → se rechaza.
    if ((user.tokenVersion || 0) !== (decoded.tokenVersion || 0)) {
      return res.status(400).json({ error: 'Token de reset ya utilizado o expirado' });
    }

    // Cambiar contraseña
    user.password = newPassword;
    user.passwordChangedAt = new Date();
    // Recovering the password via SMS counts as completing a password change,
    // so lift any pending `mustChangePassword` enforcement.
    user.mustChangePassword = false;
    // Invalida el resetToken (un solo uso) y cierra las sesiones anteriores.
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    await syncPasswordToJugaygana(user, newPassword, 'complete-password-reset');

    res.json({ success: true, message: 'Contraseña cambiada exitosamente' });
  } catch (error) {
    logger.error(`Error en complete-password-reset: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// ADMIN - Envío masivo de SMS (solo ADMIN GENERAL)
// ============================================

// Códigos de país válidos para LATAM (mismo listado que security.js)
const BULK_SMS_VALID_COUNTRY_CODES = [
  '+54', '+591', '+55', '+56', '+57', '+506', '+53', '+593',
  '+503', '+502', '+504', '+52', '+505', '+507', '+595', '+51', '+1', '+598', '+58'
];

// Patrones de números claramente falsos (todos iguales, secuencias simples)
const FAKE_NUMBER_PATTERNS = /^(\d)\1+$|^1234567890$|^0987654321$|^12345678$|^01234567$/;

// ============================================
// VERIFICACIÓN DE TELÉFONO POST-REGISTRO RÁPIDO
// --------------------------------------------
// Para usuarios que se registraron con register-quick (phoneVerificationPending: true).
// Funciona en 2 pasos:
//   1) send-otp con el teléfono → genera y envía OTP por SMS
//   2) confirm con phone + otp → marca al usuario como verificado y destraba retiros
// Una vez verificado phoneVerificationPending pasa a false definitivamente.
// ============================================
app.post('/api/auth/verify-phone/send-otp', authMiddleware, sensitiveLimiter, smsIpLimiter, async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ error: 'Número de teléfono requerido' });
    }
    const normalizedPhone = phone.trim();
    if (!validateInternationalPhone(normalizedPhone)) {
      return res.status(400).json({ error: 'Número de teléfono inválido. Usá formato internacional (ej: +5491155551234)' });
    }

    // Si el usuario está intentando verificar su PROPIO número ya verificado,
    // no tiene sentido reenviar SMS — sólo le pedimos uno nuevo.
    const selfUser = await User.findOne({ id: req.user.userId }).select('phone phoneVerified').lean();
    if (selfUser && selfUser.phoneVerified === true && selfUser.phone === normalizedPhone) {
      return res.status(400).json({
        error: 'Ya tenés este número vinculado a tu cuenta. Si querés cambiarlo, ingresá uno nuevo.',
        code: 'PHONE_ALREADY_OWN'
      });
    }

    // Si ese teléfono ya está vinculado a OTRA cuenta (verificado), bloqueamos ANTES de
    // mandar el SMS (por clave normalizada: detecta el mismo número en distinto formato).
    const existingPhone = await User.findOne({
      phoneKey: normalizePhoneKey(normalizedPhone),
      phoneVerified: true,
      id: { $ne: req.user.userId }
    }).lean();
    if (existingPhone) {
      return res.status(400).json({
        error: 'Este número ya está vinculado a una cuenta. Ingresá con esa cuenta principal, o si no la recordás usá "Recuperar contraseña". Si querés verificar otro número, ingresá uno distinto.',
        code: 'PHONE_TAKEN'
      });
    }

    const result = await generateAndSendOTP(normalizedPhone, 'verify-phone');
    if (!result.success) {
      return res.status(429).json({ error: result.error });
    }

    const maskedPhone = normalizedPhone.replace(/(\+\d{1,4})\d+(\d{4})$/, '$1****$2');
    res.json({ success: true, phone: maskedPhone, message: 'Código SMS enviado' });
  } catch (error) {
    logger.error(`verify-phone/send-otp error: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/auth/verify-phone/confirm', authMiddleware, sensitiveLimiter, async (req, res) => {
  try {
    const { phone, otpCode } = req.body || {};
    if (!phone || !otpCode) {
      return res.status(400).json({ error: 'Teléfono y código requeridos' });
    }
    const normalizedPhone = phone.trim();
    if (!validateInternationalPhone(normalizedPhone)) {
      return res.status(400).json({ error: 'Número de teléfono inválido' });
    }

    const otpResult = await verifyOTP(normalizedPhone, otpCode, 'verify-phone');
    if (!otpResult.valid) {
      return res.status(400).json({ error: otpResult.error || 'Código inválido o expirado' });
    }

    // Mismo número ya verificado en la propia cuenta: no hay nada que hacer.
    const selfUser = await User.findOne({ id: req.user.userId }).select('phone phoneVerified').lean();
    if (selfUser && selfUser.phoneVerified === true && selfUser.phone === normalizedPhone) {
      return res.status(400).json({
        error: 'Ya tenés este número vinculado a tu cuenta. Si querés cambiarlo, ingresá uno nuevo.',
        code: 'PHONE_ALREADY_OWN'
      });
    }

    // Volver a chequear unicidad por si alguien más verificó ese número entre el send y el
    // confirm (por clave normalizada: el mismo número en distinto formato = misma clave).
    const _vpPhoneKey = normalizePhoneKey(normalizedPhone);
    const existingPhone = await User.findOne({
      phoneKey: _vpPhoneKey,
      phoneVerified: true,
      id: { $ne: req.user.userId }
    }).lean();
    if (existingPhone) {
      return res.status(400).json({
        error: 'Este número ya está vinculado a una cuenta. Ingresá con esa cuenta principal, o si no la recordás usá "Recuperar contraseña". Si querés verificar otro número, ingresá uno distinto.',
        code: 'PHONE_TAKEN'
      });
    }

    const user = await User.findOne({ id: req.user.userId });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    user.phone = normalizedPhone;
    user.phoneKey = _vpPhoneKey;
    user.phoneVerified = true;
    user.phoneVerificationPending = false;
    user.smsConsent = true;
    await user.save();

    res.json({
      success: true,
      message: 'Teléfono verificado. Ya podés retirar.',
      user: {
        phone: normalizedPhone,
        phoneVerified: true,
        phoneVerificationPending: false
      }
    });
  } catch (error) {
    logger.error(`verify-phone/confirm error: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

/**
 * Valida un número de teléfono para envío masivo y devuelve la razón si es inválido.
 * @param {string} phone
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateBulkSmsPhone(phone) {
  if (!phone || typeof phone !== 'string') {
    return { valid: false, reason: 'Número ausente o inválido' };
  }
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8) {
    return { valid: false, reason: 'Menos de 8 dígitos' };
  }
  if (digits.length > 15) {
    return { valid: false, reason: 'Más de 15 dígitos' };
  }
  if (FAKE_NUMBER_PATTERNS.test(digits)) {
    return { valid: false, reason: 'Patrón falso o de prueba' };
  }
  const hasValidPrefix = BULK_SMS_VALID_COUNTRY_CODES.some(code => phone.startsWith(code));
  if (!hasValidPrefix) {
    return { valid: false, reason: 'Prefijo de país no reconocido' };
  }
  return { valid: true };
}

/**
 * Construye el query de Mongoose para los filtros de bulk SMS.
 * Solo se permiten claves específicas con valores primitivos para evitar inyección NoSQL.
 *
 * Por defecto incluye TODOS los usuarios con teléfono cargado (verificados o no).
 * Si `onlyVerified === true`, restringe a usuarios con `phoneVerified: true` y `smsConsent: true`
 * (modo estricto, equivalente al comportamiento histórico).
 */
function buildBulkSmsQuery(filters, onlyVerified = false) {
  const query = {
    phone: { $exists: true, $nin: [null, ''] }
  };
  if (filters && typeof filters === 'object') {
    const allowedFilters = ['smsConsent', 'isActive'];
    for (const key of allowedFilters) {
      if (Object.prototype.hasOwnProperty.call(filters, key)) {
        const val = filters[key];
        if (typeof val === 'boolean' || typeof val === 'string' || typeof val === 'number') {
          query[key] = val;
        }
      }
    }
  }
  // Aplicar overrides de modo estricto al final para que no puedan ser debilitados
  // por filtros del cliente (p.ej. filters.smsConsent = false).
  if (onlyVerified === true) {
    query.phoneVerified = true;
    query.smsConsent = true;
  }
  return query;
}

// Preview: devuelve la lista de destinatarios con validación de números SIN enviar SMS
app.post('/api/admin/bulk-sms/preview', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Acceso denegado. Solo el administrador general puede usar esta función.' });
    }

    const { filters, onlyVerified } = req.body;
    const query = buildBulkSmsQuery(filters, onlyVerified === true);
    const users = await User.find(query).select('phone username').lean();

    const recipients = users.map(u => {
      const validation = validateBulkSmsPhone(u.phone);
      return {
        username: u.username,
        phone: u.phone,
        valid: validation.valid,
        reason: validation.reason || null
      };
    });

    const valid = recipients.filter(r => r.valid).length;
    const invalid = recipients.length - valid;

    res.json({ total: recipients.length, valid, invalid, recipients });
  } catch (error) {
    logger.error(`Error en bulk-sms/preview: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/admin/bulk-sms', authMiddleware, bulkSmsIpLimiter, async (req, res) => {
  try {
    // Solo el administrador general puede enviar SMS masivos
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Acceso denegado. Solo el administrador general puede enviar SMS masivos.' });
    }

    const { message, filters, onlyVerified } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'El mensaje es requerido' });
    }

    const trimmedMessage = message.trim();

    if (trimmedMessage.length === 0) {
      return res.status(400).json({ error: 'El mensaje es requerido' });
    }

    if (trimmedMessage.length > 160) {
      return res.status(400).json({ error: 'El mensaje no puede superar los 160 caracteres' });
    }
    const query = buildBulkSmsQuery(filters, onlyVerified === true);
    const users = await User.find(query).select('_id phone username').lean();

    let sent = 0;
    let failed = 0;
    let discarded = 0;
    const results = [];

    logger.info(`[bulk-sms] Admin ${req.user.username} iniciando envío masivo a ${users.length} usuarios (onlyVerified=${onlyVerified === true})`);

    for (const user of users) {
      const validation = validateBulkSmsPhone(user.phone);
      if (!validation.valid) {
        discarded++;
        logger.info(`[bulk-sms] Skipped invalid phone: ${user._id} (${validation.reason})`);
        results.push({ username: user.username, phone: user.phone, status: 'discarded', reason: validation.reason });
        continue;
      }

      try {
        const result = await sendSMS(user.phone, trimmedMessage);
        if (result.success) {
          sent++;
          results.push({ username: user.username, phone: user.phone, status: 'sent' });
        } else {
          failed++;
          results.push({ username: user.username, phone: user.phone, status: 'failed', error: result.error || 'Error desconocido' });
          logger.warn(`[bulk-sms] Fallo al enviar a usuario ${user.username}: ${result.error}`);
        }
      } catch (err) {
        failed++;
        results.push({ username: user.username, phone: user.phone, status: 'failed', error: err.message });
        logger.warn(`[bulk-sms] Error al enviar a usuario ${user.username}: ${err.message}`);
      }

      // Esperar 50ms entre envíos para evitar saturar SNS
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    logger.info(`[bulk-sms] Envío masivo completado por ${req.user.username}: enviados=${sent}, fallidos=${failed}, descartados=${discarded}, total=${users.length}`);

    res.json({ sent, failed, discarded, total: users.length, results });
  } catch (error) {
    logger.error(`Error en bulk-sms: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// ADMIN - Verificar contraseña del panel SMS MASIVO
// ============================================

app.post('/api/admin/verify-sms-password', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Acceso denegado.' });
    }

    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ success: false, error: 'Contraseña requerida.' });
    }

    const SMS_MASIVO_PASSWORD = process.env.SMS_MASIVO_PASSWORD;
    if (!SMS_MASIVO_PASSWORD) {
      logger.error('⛔ SMS_MASIVO_PASSWORD no configurado en el entorno.');
      return res.status(500).json({ success: false, error: 'Configuración del servidor incompleta.' });
    }

    if (!safeCompare(password, SMS_MASIVO_PASSWORD)) {
      return res.status(401).json({ success: false });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error(`Error en verify-sms-password: ${error.message}`);
    res.status(500).json({ success: false, error: 'Error del servidor.' });
  }
});

// ============================================
// ADMIN - Resetear contraseña de usuario
// ============================================

app.post('/api/admin/users/:id/reset-password', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // Resetear contraseñas (incluida la de otros admins) es poder de admin general.
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el administrador principal puede resetear contraseñas' });
    }
    const { id } = req.params;
    const { newPassword } = req.body;
    
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    
    const user = await User.findOne({ id });
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    user.password = newPassword;
    user.passwordChangedAt = new Date();
    // After an admin resets a regular user's password, force them to change it on
    // next login. Admin accounts do not go through the mustChangePassword flow.
    if (!isAdminRole(user.role)) {
      user.mustChangePassword = true;
    }
    await user.save();
    
    logger.info(`Admin ${req.user.username} reset password for ${user.username}`);

    await syncPasswordToJugaygana(user, newPassword, `admin-reset-password by ${req.user.username}`);

    res.json({
      success: true,
      message: `Contraseña de ${user.username} reseteada exitosamente`
    });
  } catch (error) {
    console.error('Error reseteando contraseña:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// ADMIN - Link de autologin (alta por agente / migración)
// ============================================
//
// Caso de uso: un usuario que YA existe en JUGAYGANA pero nunca se registró acá.
// El agente le crea la cuenta desde el panel (que la vincula a JUGAYGANA) y le
// pasa este link por WhatsApp. El usuario lo abre y entra sin escribir nada;
// adentro le salta el cambio de contraseña obligatorio.
//
// Seguridad:
//  · UN SOLO USO y vence a las AUTOLOGIN_TTL_HOURS (72 h por defecto).
//  · En la base se guarda SOLO el SHA-256 del token; el claro vive en el link.
//    Si se filtra la base, los links no son reutilizables.
//  · Generarlo equivale a entrar a la cuenta ⇒ admin general únicamente, y
//    NUNCA sobre cuentas de staff.
//  · Queda auditado en `autologinCreatedBy` + log.
const AUTOLOGIN_TTL_HOURS = parseInt(process.env.AUTOLOGIN_TTL_HOURS || '72', 10);

// SHA-256 en vez de bcrypt a propósito: el token tiene 256 bits de entropía
// real (no es una contraseña humana), así que no hay nada que "fuerza bruta"
// pueda hacer y necesitamos que el canje sea una lectura indexada barata.
function _hashAutologinToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Base pública para armar el link. Se prioriza el host del REQUEST porque el
// mismo código corre en más de un dominio (vipcargas / autoreembolsos) y el
// panel siempre se abre desde el dominio correcto. PUBLIC_BASE_URL queda como
// override explícito. OJO: PUBLIC_BASE_URL se lee al arrancar (antes del
// bootstrap SSM) ⇒ va como env property de EB, no en SSM.
function _publicBaseUrlFromRequest(req) {
  const host = req.get('host');
  if (host) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    return `${proto}://${host}`.replace(/\/$/, '');
  }
  return PUBLIC_BASE_URL;
}

app.post('/api/admin/users/:id/autologin-link', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // Un link de autologin ES un acceso a la cuenta del cliente: poder de admin
    // general, igual que el reset de contraseña.
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el administrador principal puede generar links de acceso' });
    }

    const { id } = req.params;
    const user = await User.findOne({ id });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Jamás sobre cuentas de staff: sería una escalada de privilegios por link.
    if (isAdminRole(user.role)) {
      return res.status(400).json({ error: 'No se pueden generar links de acceso para cuentas de staff' });
    }

    if (user.isBlocked === true) {
      return res.status(400).json({ error: 'El usuario está bloqueado. Desbloquealo antes de generar el link.' });
    }
    if (user.isActive === false) {
      return res.status(400).json({ error: 'El usuario está desactivado' });
    }

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + AUTOLOGIN_TTL_HOURS * 60 * 60 * 1000);

    user.autologinTokenHash = _hashAutologinToken(rawToken);
    user.autologinExpiresAt = expiresAt;
    user.autologinUsedAt = null;          // link nuevo ⇒ se re-arma el de un solo uso
    user.autologinCreatedBy = req.user.username;
    // El objetivo del link es que el usuario cree su contraseña: si entra por
    // acá, no tiene una propia (o no la sabe).
    user.mustChangePassword = true;
    await user.save();

    const link = `${_publicBaseUrlFromRequest(req)}/?al=${rawToken}`;

    logger.info(`[autologin] ${req.user.username} generó link para ${user.username} (vence ${expiresAt.toISOString()})`);

    res.json({
      success: true,
      link,
      username: user.username,
      expiresAt,
      expiresInHours: AUTOLOGIN_TTL_HOURS
    });
  } catch (error) {
    logger.error(`Error generando link de autologin: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Traspaso de sesión a la PWA instalada (problema de iOS).
//
// En Android la app instalada comparte `localStorage` con el navegador, así que
// arranca ya logueada. En iOS NO: la web app de la pantalla de inicio corre en
// su PROPIO contenedor de almacenamiento, separado de Safari → abre sin token y
// muestra el login, aunque en Safari la sesión siga abierta.
//
// Solución: el usuario (ya autenticado en Safari) pide un token para SÍ MISMO;
// ese token se mete en el `start_url` del manifest, que es la única URL que se
// ejecuta DENTRO del contenedor de la app. Al abrirla por primera vez, el front
// lo canjea con /api/auth/autologin y la sesión queda armada ahí adentro.
//
// Diferencias con el link que genera el admin (mismos campos en User):
//   · TTL corto (PWA_SESSION_TTL_MINUTES, 30 min): se usa en el acto, al instalar.
//   · NO toca `mustChangePassword` — el usuario ya tiene su contraseña.
// ⚠️ Comparte los campos `autologin*`, así que pedir uno PISA un link de admin
// vivo para ese usuario. Es benigno (el admin lo regenera con un clic) y sólo
// puede pasar si el usuario ya está logueado, en cuyo caso no necesita el link.
const PWA_SESSION_TTL_MINUTES = parseInt(process.env.PWA_SESSION_TTL_MINUTES || '30', 10);

app.post('/api/auth/pwa-session-token', authMiddleware, authLimiter, async (req, res) => {
  try {
    const user = await User.findOne({ id: req.user.userId });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Solo clientes: el panel admin no se instala como PWA por esta vía.
    if (isAdminRole(user.role)) {
      return res.status(403).json({ error: 'No disponible para cuentas de staff' });
    }

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + PWA_SESSION_TTL_MINUTES * 60 * 1000);

    user.autologinTokenHash = _hashAutologinToken(rawToken);
    user.autologinExpiresAt = expiresAt;
    user.autologinUsedAt = null;
    user.autologinCreatedBy = `pwa-install:${user.username}`;
    await user.save();

    logger.info(`[pwa-session] token de instalación generado para ${user.username}`);
    res.json({ success: true, token: rawToken, expiresAt });
  } catch (error) {
    logger.error(`Error generando token de sesión PWA: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Canje del link. PÚBLICO (el usuario todavía no tiene sesión) y por POST a
// propósito: WhatsApp/Facebook visitan los links para armar la vista previa, y
// con un GET esos crawlers quemarían el token de un solo uso antes de que el
// usuario lo abriera. El front hace este POST desde el JS.
app.post('/api/auth/autologin', authLimiter, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string' || token.length < 20) {
      return res.status(400).json({ error: 'Link de acceso inválido' });
    }

    const hash = _hashAutologinToken(token.trim());
    const now = new Date();

    // Reserva ATÓMICA (mismo patrón que el resto de los flujos de un solo uso):
    // el `autologinUsedAt: null` dentro del filtro es el candado. Dos aperturas
    // simultáneas del mismo link ⇒ una sola gana el documento, la otra recibe
    // null y aborta. Sin esto, el "un solo uso" sería un TOCTOU.
    const user = await User.findOneAndUpdate(
      {
        autologinTokenHash: hash,
        autologinUsedAt: null,
        autologinExpiresAt: { $gt: now }
      },
      { $set: { autologinUsedAt: now } },
      { new: true }
    );

    if (!user) {
      // No distinguimos "no existe" de "vencido" o "ya usado": el usuario no
      // puede hacer nada distinto en ninguno de los casos y así no le damos
      // información a quien pruebe tokens al azar.
      return res.status(401).json({
        error: 'Este link de acceso ya fue usado o venció. Pedile uno nuevo al soporte.',
        code: 'AUTOLOGIN_INVALID'
      });
    }

    if (user.isBlocked === true) {
      return res.status(403).json({ error: 'Tu cuenta está bloqueada. Contactá a soporte.', code: 'USER_BLOCKED' });
    }
    if (user.isActive === false) {
      return res.status(401).json({ error: 'Cuenta desactivada' });
    }
    if (isAdminRole(user.role)) {
      // Defensa en profundidad: el generador ya lo impide.
      return res.status(403).json({ error: 'Acceso no permitido' });
    }

    user.lastLogin = now;
    await user.save();

    const jwtToken = jwt.sign(
      { userId: user.id, username: user.username, role: user.role, tokenVersion: user.tokenVersion ?? 0 },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    logger.info(`[autologin] ${user.username} entró con link generado por ${user.autologinCreatedBy || 'n/a'}`);

    res.json({
      token: jwtToken,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        balance: user.balance,
        mustChangePassword: user.mustChangePassword === true,
        phoneVerified: user.phoneVerified === true
      }
    });
  } catch (error) {
    logger.error(`Error en autologin: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// RUTAS DE CONFIGURACIÓN PÚBLICA
// ============================================

// Ruta GET para obtener CBU activo (para mensaje de bienvenida y panel usuario)
app.get('/api/config/cbu', authMiddleware, async (req, res) => {
  try {
    const cbuConfig = await getConfig('cbu');
    if (!cbuConfig) {
      return res.status(404).json({ error: 'CBU no configurado' });
    }
    
    res.json({
      number: cbuConfig.number,
      alias: cbuConfig.alias,
      bank: cbuConfig.bank,
      titular: cbuConfig.titular
    });
  } catch (error) {
    console.error('Error obteniendo CBU:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Ruta GET para obtener URL del Canal Informativo (panel usuario)
app.get('/api/config/canal-url', authMiddleware, async (req, res) => {
  try {
    const url = await getConfig('canalInformativoUrl', '');
    res.json({ url: url || '' });
  } catch (error) {
    console.error('Error obteniendo canal URL:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/cbu/request', authMiddleware, async (req, res) => {
  try {
    // Rate limiting por usuario: máximo 1 solicitud de CBU cada 10 segundos
    if (!checkCbuRateLimit(req.user.userId)) {
      return res.status(429).json({
        success: false,
        error: 'Solicitaste CBU muy recientemente. Espera unos segundos antes de volver a intentar.'
      });
    }

    const cbuConfig = await getConfig('cbu');
    if (!cbuConfig) {
      return res.status(404).json({ error: 'CBU no configurado' });
    }
    
    // 1. Mensaje de solicitud del usuario
    await Message.create({
      id: uuidv4(),
      senderId: req.user.userId,
      senderUsername: req.user.username,
      senderRole: 'user',
      receiverId: 'admin',
      receiverRole: 'admin',
      content: '💳 Solicito los datos para transferir (CBU)',
      type: 'text',
      timestamp: new Date(),
      read: false
    });
    
    // 2. Mensaje completo con CBU (editable desde COMANDOS /sys_cbu)
    const fullMessage = await renderSystemCommand(
      '/sys_cbu',
      '💳 *Datos para transferir:*\n\n🏦 Banco: {bank}\n👤 Titular: {titular}\n🔢 CBU: {cbu}\n📱 Alias: {alias}\n\n✅ Una vez realizada la transferencia, envianos el comprobante por aquí.',
      { bank: cbuConfig.bank, titular: cbuConfig.titular, cbu: cbuConfig.number, alias: cbuConfig.alias }
    );

    if (fullMessage) await Message.create({ // null = /sys_cbu vaciado → solo se manda el CBU
      id: uuidv4(),
      senderId: 'system',
      senderUsername: 'Sistema',
      senderRole: 'admin',
      receiverId: req.user.userId,
      receiverRole: 'user',
      content: fullMessage,
      type: 'text',
      timestamp: new Date(),
      read: false
    });

    // 3. CBU solo
    await Message.create({
      id: uuidv4(),
      senderId: 'system',
      senderUsername: 'Sistema',
      senderRole: 'admin',
      receiverId: req.user.userId,
      receiverRole: 'user',
      content: cbuConfig.number,
      type: 'text',
      timestamp: new Date(),
      read: false
    });
    
    // Meta CAPI — InitiateCheckout (el usuario pidió el CBU, va a depositar).
    try {
      const u = await User.findOne({ id: req.user.userId }).lean();
      metaCapi.track(
        'InitiateCheckout',
        { email: u && u.email, phone: u && u.phone, externalId: req.user.userId, fbc: u && u.metaFbc, fbp: u && u.metaFbp },
        { content_name: 'cbu_request' },
        { eventId: req.body && req.body.metaEventId, req }
      );
    } catch (e) { /* tracking nunca bloquea la respuesta */ }

    res.json({
      success: true,
      message: 'Solicitud enviada',
      cbu: {
        number: cbuConfig.number,
        alias: cbuConfig.alias,
        bank: cbuConfig.bank,
        titular: cbuConfig.titular
      }
    });
  } catch (error) {
    console.error('Error enviando solicitud CBU:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/messages/welcome
// Crea los mensajes de bienvenida del lado del ADMIN/sistema (no del usuario).
// Antes el cliente los mandaba vía /api/messages/send con su propio token, lo
// que los registraba con senderRole='user' → aparecían como si los hubiera
// escrito el propio usuario. Ahora se crean server-side como mensajes de
// sistema (senderRole:'admin') igual que el flujo de CBU/depósito.
//
// Throttle server-side: no reenvía si ya se mandó una bienvenida a este user
// en las últimas 24h (marca metadata.kind='welcome'). Robusto aunque el
// cliente pierda su flag de localStorage o entre desde varios dispositivos.
app.post('/api/messages/welcome', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username || 'Usuario';

    // Throttle: ¿ya hubo bienvenida en las últimas 24h?
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentWelcome = await Message.findOne({
      receiverId: userId,
      'metadata.kind': 'welcome',
      timestamp: { $gte: cutoff }
    }).lean();
    if (recentWelcome) {
      return res.json({ success: true, alreadySent: true });
    }

    // CBU activo (puede no estar configurado).
    let cbuNumber = 'No disponible';
    try {
      const cbuConfig = await getConfig('cbu');
      if (cbuConfig && cbuConfig.number) cbuNumber = cbuConfig.number;
    } catch (e) { /* sin CBU configurado */ }

    // Texto editable desde COMANDOS (/sys_welcome). Fallback al texto original.
    const welcomeContent = await renderSystemCommand(
      '/sys_welcome',
      `🎉 ¡Bienvenido a la Sala de Juegos, {username}!\n\n🎁 Beneficios exclusivos:\n• Reembolso SEMANAL y MENSUAL según tu RANGO\n• 🥉 Bronce 3% · 🥈 Plata 5% · 🥇 Oro 10% de lo perdido\n• Fueguito diario con recompensas\n• Atención 24/7\n\n💬 Escribe aquí para hablar con un agente.\n\nLink de pagina: https://www.jugaygana44.bet/\n\nCBU activo: {cbu}`,
      { username, cbu: cbuNumber }
    );

    // Helper para crear + emitir un mensaje de sistema (lado admin).
    const createSystemMessage = async (content, isWelcomeMarker) => {
      const msg = await Message.create({
        id: uuidv4(),
        senderId: 'system',
        senderUsername: 'Sistema',
        senderRole: 'admin',
        receiverId: userId,
        receiverRole: 'user',
        content,
        type: 'text',
        timestamp: new Date(),
        read: false,
        // Sólo el primer mensaje lleva el marcador de throttle.
        metadata: isWelcomeMarker ? { kind: 'welcome' } : null
      });
      const data = {
        id: msg.id,
        senderId: 'system',
        senderUsername: 'Sistema',
        senderRole: 'admin',
        receiverId: userId,
        receiverRole: 'user',
        content,
        timestamp: msg.timestamp,
        type: 'text'
      };
      io.to(`user_${userId}`).emit('new_message', data);
      io.to(`chat_${userId}`).emit('new_message', data);
      notifyAdmins('new_message', { message: data, userId, username });
    };

    if (welcomeContent) await createSystemMessage(welcomeContent, true); // null = /sys_welcome vaciado
    if (cbuNumber && cbuNumber !== 'No disponible') {
      await createSystemMessage(cbuNumber, false);
    }

    // Crear/actualizar el ChatStatus recién ahora — cuando el usuario ingresa y
    // recibe la bienvenida. Los usuarios creados (por publisher_admin o admin)
    // que nunca ingresaron NO tienen ChatStatus, así que no aparecen como chats
    // vacíos en el panel. lastMessageAt=now hace que el chat aparezca arriba.
    await ChatStatus.findOneAndUpdate(
      { userId },
      { userId, username, lastMessageAt: new Date() },
      { upsert: true }
    );

    res.json({ success: true, alreadySent: false });
  } catch (error) {
    console.error('Error enviando bienvenida:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// RUTAS DE USUARIOS (ADMIN)
// ============================================

// ELIMINADO (2026-07-08, perf #4): GET /api/users — devolvía TODA la colección de
// usuarios con todos sus campos. 0 callers (el panel usa /api/admin/users paginado
// y GET /api/users/:userId para el detalle). Si algo externo lo necesitara: git revert.

app.post('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { username, password, email, phone, role = 'user' } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });
    }

    if (!validateUsername(username)) {
      return res.status(400).json({ error: 'Usuario inválido. Usá 3-30 caracteres: letras, números, punto, guion o guion bajo.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    if (!phone || phone.trim().length < 8) {
      return res.status(400).json({ error: 'El número de teléfono es obligatorio (mínimo 8 dígitos)' });
    }

    const validRoles = ['user', 'admin', 'depositor', 'withdrawer', 'comunidad'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }

    // Solo el admin general puede crear cuentas con rol distinto de 'user'.
    // Sin esto, un agente depositor/withdrawer podía crear un admin y escalar.
    if (req.user.role !== 'admin' && role !== 'user') {
      return res.status(403).json({ error: 'Solo el administrador general puede crear otros administradores' });
    }
    
    // Buscar case-insensitive (camino rápido indexado + fallback)
    const existingUser = await findUserByUsernameCI(username);
    if (existingUser) {
      return res.status(400).json({ error: 'El usuario ya existe' });
    }
    
    const userId = uuidv4();
    
    const newUser = await User.create({
      id: userId,
      username,
      password: password,
      email,
      phone,
      role,
      accountNumber: generateAccountNumber(),
      balance: 0,
      createdAt: new Date(),
      lastLogin: null,
      isActive: true,
      jugayganaUserId: null,
      jugayganaUsername: null,
      jugayganaSyncStatus: role === 'user' ? 'pending' : 'not_applicable'
    });

    // NO creamos ChatStatus acá: se crea recién cuando el usuario ingresa
    // (welcome) o envía su primer mensaje, para no mostrar chats vacíos de
    // usuarios que nunca entraron.

    // Sincronizar con JUGAYGANA solo si es usuario normal
    if (role === 'user') {
      jugaygana.syncUserToPlatform({
        username: newUser.username,
        password: password
      }).then(async (result) => {
        if (result.success) {
          await User.updateOne(
            { id: userId },
            {
              jugayganaUserId: result.jugayganaUserId || result.user?.user_id,
              jugayganaUsername: result.jugayganaUsername || result.user?.user_name,
              jugayganaSyncStatus: result.alreadyExists ? 'linked' : 'synced'
            }
          );
        }
      });
    }
    
    res.status(201).json({
      message: 'Usuario creado exitosamente',
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        accountNumber: newUser.accountNumber,
        role: newUser.role,
        balance: newUser.balance
      }
    });
  } catch (error) {
    console.error('Error creando usuario:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.put('/api/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // Whitelist of fields any admin role can update
    const ALLOWED_FIELDS = ['email', 'phone', 'whatsapp', 'isActive', 'balance'];

    const updates = {};

    for (const field of ALLOWED_FIELDS) {
      if (req.body[field] !== undefined) {
        // Coerce to safe primitives to prevent NoSQL operator injection
        if (field === 'isActive') {
          updates[field] = Boolean(req.body[field]);
        } else if (field === 'balance') {
          const n = parseFloat(req.body[field]);
          if (isNaN(n)) return res.status(400).json({ error: 'balance debe ser un número' });
          updates[field] = n;
        } else {
          updates[field] = String(req.body[field]);
        }
      }
    }

    // Only strict admin can change the role
    if (req.body.role !== undefined) {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Solo el administrador principal puede cambiar roles' });
      }
      const validRoles = ['user', 'admin', 'depositor', 'withdrawer', 'comunidad'];
      if (!validRoles.includes(req.body.role)) {
        return res.status(400).json({ error: 'Rol inválido' });
      }
      updates.role = req.body.role;
    }

    // Handle password separately (hash it)
    if (req.body.password) {
      updates.password = await bcrypt.hash(String(req.body.password), 10);
      updates.passwordChangedAt = new Date();
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No se proporcionaron campos válidos para actualizar' });
    }
    
    const updateDoc = { $set: updates };
    // Si cambia el rol, invalidar las sesiones (subir tokenVersion) para que un usuario
    // degradado no conserve sus privilegios con el token viejo hasta que venza.
    if (updates.role !== undefined) {
      updateDoc.$inc = { tokenVersion: 1 };
    }
    const user = await User.findOneAndUpdate(
      { id },
      updateDoc,
      { new: true }
    ).select('-password');
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    res.json({
      message: 'Usuario actualizado',
      user
    });
  } catch (error) {
    console.error('Error actualizando usuario:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/users/:id/sync-jugaygana', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findOne({ id });
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    const result = await jugaygana.syncUserToPlatform({
      username: user.username,
      password: 'asd123'
    });
    
    if (result.success) {
      user.jugayganaUserId = result.jugayganaUserId || result.user?.user_id;
      user.jugayganaUsername = result.jugayganaUsername || result.user?.user_name;
      user.jugayganaSyncStatus = result.alreadyExists ? 'linked' : 'synced';
      await user.save();
      
      res.json({
        message: result.alreadyExists ? 'Usuario vinculado con JUGAYGANA' : 'Usuario sincronizado con JUGAYGANA',
        jugayganaUserId: user.jugayganaUserId,
        jugayganaUsername: user.jugayganaUsername
      });
    } else {
      res.status(400).json({ error: result.error || 'Error sincronizando con JUGAYGANA' });
    }
  } catch (error) {
    console.error('Error sincronizando:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Sincronización masiva
app.post('/api/admin/sync-all-jugaygana', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // Nota: Esta función necesitaría ser actualizada para usar MongoDB
    // Por ahora, devolvemos un mensaje informativo
    res.json({
      message: 'Sincronización masiva - Función en desarrollo para MongoDB',
      note: 'Esta función se está migrando a MongoDB'
    });
  } catch (error) {
    console.error('Error iniciando sincronización:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/admin/sync-status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const jugayganaUsers = await User.countDocuments({ jugayganaUserId: { $ne: null } });
    const pendingUsers = await User.countDocuments({ jugayganaUserId: null, role: 'user' });
    
    res.json({
      inProgress: false,
      startedAt: null,
      lastSync: null,
      totalSynced: jugayganaUsers,
      lastResult: null,
      localUsers: totalUsers,
      jugayganaUsers,
      pendingUsers
    });
  } catch (error) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.delete('/api/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    const userToDelete = await User.findOne({ id });
    if (!userToDelete) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    const adminRoles = ['admin', 'depositor', 'withdrawer', 'comunidad'];
    if (adminRoles.includes(userToDelete.role) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo los administradores pueden eliminar otros administradores' });
    }
    
    await User.deleteOne({ id });
    await ChatStatus.deleteOne({ userId: id });
    
    res.json({ message: 'Usuario eliminado exitosamente' });
  } catch (error) {
    console.error('Error eliminando usuario:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// SISTEMA DE CHATS ABIERTOS/CERRADOS
// ============================================

app.get('/api/admin/chat-status/all', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const chatStatuses = await ChatStatus.find().lean();
    const result = {};
    chatStatuses.forEach(cs => {
      result[cs.userId] = cs;
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ELIMINADOS (2026-07-08, Batch B de performance): GET /api/admin/chats/:status y
// GET /api/admin/all-chats. Código muerto (0 callers en panel/cliente/scripts,
// verificado por grep) y peligrosos: all-chats cargaba TODA la colección de
// mensajes + usuarios a memoria por request. El panel usa /api/admin/conversations
// (aggregation con limit). Si algo externo los necesitara: git revert.

app.post('/api/admin/chats/:userId/close', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // SLA: si se cierra con una espera en curso, registrarla como "sin responder".
    // Se resuelve ANTES de cerrar para que capture la cola real (cargas/pagos);
    // el cierre pone status:'closed' y pisaría esa info.
    await delayClockResolve(userId, { responded: false });

    await ChatStatus.findOneAndUpdate(
      { userId },
      {
        status: 'closed',
        closedAt: new Date(),
        closedBy: req.user.username,
        assignedTo: null,
        category: 'cargas'
      },
      { upsert: true }
    );

    res.json({ success: true, message: 'Chat cerrado' });
  } catch (error) {
    res.status(500).json({ error: 'Error cerrando chat' });
  }
});

app.post('/api/admin/chats/:userId/reopen', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    await ChatStatus.findOneAndUpdate(
      { userId },
      {
        status: 'open',
        closedAt: null,
        closedBy: null,
        assignedTo: req.user.username
      },
      { upsert: true }
    );
    
    res.json({ success: true, message: 'Chat reabierto' });
  } catch (error) {
    res.status(500).json({ error: 'Error reabriendo chat' });
  }
});

app.post('/api/admin/chats/:userId/assign', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { agent } = req.body;
    
    await ChatStatus.findOneAndUpdate(
      { userId },
      { assignedTo: agent, status: 'open' },
      { upsert: true }
    );
    
    res.json({ success: true, message: 'Chat asignado a ' + agent });
  } catch (error) {
    res.status(500).json({ error: 'Error asignando chat' });
  }
});

app.post('/api/admin/chats/:userId/category', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { category } = req.body;
    
    if (!category || !['cargas', 'pagos'].includes(category)) {
      return res.status(400).json({ error: 'Categoría inválida. Use "cargas" o "pagos"' });
    }
    
    await ChatStatus.findOneAndUpdate(
      { userId },
      { category },
      { upsert: true }
    );
    
    res.json({ success: true, message: `Chat movido a ${category.toUpperCase()}` });
  } catch (error) {
    console.error('Error cambiando categoría:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ELIMINADO (2026-07-08, Batch B): GET /api/admin/chats/category/:category —
// código muerto (0 callers) con el mismo patrón peligroso de cargar todos los
// mensajes de la categoría a memoria. Si algo externo lo necesitara: git revert.

// ============================================
// RUTAS DE MENSAJES
// ============================================

// OPTIMIZADO: Sin logs, con proyección mínima
app.get('/api/messages/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const before = req.query.before ? new Date(req.query.before) : null;

    const allowedRoles = ['admin', 'depositor', 'withdrawer', 'comunidad'];
    const isAdminRole = allowedRoles.includes(req.user.role);
    if (!isAdminRole && req.user.userId !== userId) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const matchStage = {
      $or: [
        { senderId: userId },
        { receiverId: userId }
      ]
    };
    if (!isAdminRole) {
      matchStage.adminOnly = { $ne: true };
    }
    if (before) {
      matchStage.timestamp = { $lt: before };
    }

    const messages = await Message.aggregate([
      { $match: matchStage },
      { $sort: { timestamp: -1 } },
      { $limit: limit },
      { $sort: { timestamp: 1 } },
      {
        $project: {
          _id: 0, id: 1, senderId: 1, senderUsername: 1, senderRole: 1,
          receiverId: 1, receiverRole: 1, content: 1, type: 1, read: 1,
          adminOnly: 1, timestamp: 1
        }
      }
    ]);

    const hasMore = messages.length === limit;
    const oldestTimestamp = messages.length > 0 ? messages[0].timestamp : null;

    res.json({ messages, hasMore, oldestTimestamp });
  } catch (error) {
    logger.error(`Error obteniendo mensajes: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/conversations', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // Agregación en Mongo: agrupa por el usuario de la conversación, toma el
    // último mensaje y cuenta los no leídos. Evita traer TODA la colección de
    // mensajes y usuarios a Node y el loop O(mensajes × usuarios) anterior.
    const rows = await Message.aggregate([
      { $sort: { timestamp: -1 } },
      { $addFields: {
        convUserId: {
          $cond: [
            { $eq: ['$senderRole', 'user'] },
            '$senderId',
            { $cond: [{ $eq: ['$receiverRole', 'user'] }, '$receiverId', null] }
          ]
        }
      }},
      { $match: { convUserId: { $ne: null } } },
      { $group: {
        _id: '$convUserId',
        lastMessage: { $first: '$$ROOT' },
        unreadCount: {
          $sum: { $cond: [
            { $and: [{ $eq: ['$receiverRole', 'admin'] }, { $ne: ['$read', true] }] },
            1, 0
          ] }
        }
      }},
      { $sort: { 'lastMessage.timestamp': -1 } }
    ]);

    const userIds = rows.map(r => r._id);
    const users = await User.find({ id: { $in: userIds } }, { id: 1, username: 1, accountNumber: 1 }).lean();
    const userMap = {};
    users.forEach(u => { userMap[u.id] = u; });

    const conversations = rows.map(r => {
      const u = userMap[r._id] || {};
      const lm = r.lastMessage || {};
      delete lm.convUserId;
      return {
        userId: r._id,
        username: u.username || 'Desconocido',
        accountNumber: u.accountNumber || '',
        lastMessage: lm,
        unreadCount: r.unreadCount || 0
      };
    });

    res.json(conversations);
  } catch (error) {
    console.error('Error obteniendo conversaciones:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/messages/read/:userId', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    await Message.updateMany(
      { senderId: userId, receiverRole: 'admin' },
      { read: true }
    );
    
    // Notificar a todos los admins que los mensajes de este usuario fueron leídos
    notifyAdmins('messages_read', { userId, by: req.user.userId });
    
    res.json({ message: 'Mensajes marcados como leídos' });
  } catch (error) {
    console.error('Error marcando mensajes como leídos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Guard anti "bienvenida-fantasma": versiones VIEJAS cacheadas de la PWA mandaban el
// mensaje de bienvenida como si fuera el propio cliente (senderRole:'user'), con texto
// hardcodeado y porcentajes viejos → aparecía "enviado por el cliente" con datos viejos.
// La bienvenida REAL la crea el server (/api/messages/welcome) como "Sistema". Por eso,
// un mensaje de USUARIO que es la bienvenida siempre es ese bug del cliente viejo → se
// descarta (no se guarda ni se emite). Marcadores muy específicos → no toca mensajes reales.
function _isStaleClientWelcome(content) {
  return typeof content === 'string' &&
    /¡?Bienvenido a la Sala de Juegos/i.test(content) &&
    /(Beneficios exclusivos|Reembolso\s+(DIARIO|SEMANAL|MENSUAL))/i.test(content);
}

app.post('/api/messages/send', authMiddleware, async (req, res) => {
  try {
    const { content, type = 'text', receiverId } = req.body;
    
    logger.debug(`[API_MESSAGES_SEND] user=${req.user.username} role=${req.user.role} receiverId=${receiverId} type=${type}`);
    
    if (!content) {
      logger.debug('[API_MESSAGES_SEND] ERROR: content required');
      return res.status(400).json({ error: 'Contenido requerido' });
    }

    // Bienvenida-fantasma de clientes viejos cacheados → descartar (nunca la manda el cliente).
    if (req.user.role === 'user' && _isStaleClientWelcome(content)) {
      logger.info(`[welcome-guard] descartada bienvenida-fantasma (HTTP) de ${req.user.username}`);
      return res.json({ success: true, ignored: true });
    }

    // SECURITY: Validate message type to prevent type confusion
    const allowedTypes = ['text', 'image', 'video'];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({ error: 'Tipo de mensaje no válido' });
    }

    // Tope de longitud para texto (evita guardar blobs gigantes; imagen/video tienen
    // su propio límite más abajo). Un mensaje de chat legítimo es muy corto.
    if (type === 'text' && typeof content === 'string' && content.length > 8000) {
      return res.status(400).json({ error: 'El mensaje es demasiado largo.' });
    }

    // SECURITY: For image/video, validate that content is a well-formed https:// URL or an allowed data: URL
    if (type === 'image' || type === 'video') {
      const MAX_BASE64_SIZE = 5 * 1024 * 1024; // 5MB
      const ALLOWED_DATA_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'];
      if (content.startsWith('data:')) {
        const mimeMatch = content.match(/^data:([\w\/+.-]+);base64,/);
        if (!mimeMatch || !ALLOWED_DATA_MIMES.includes(mimeMatch[1])) {
          return res.status(400).json({ error: 'Tipo de imagen o video no permitido' });
        }
        if (content.length > MAX_BASE64_SIZE) {
          return res.status(400).json({ error: 'La imagen o video es demasiado grande (máximo 5MB)' });
        }
      } else {
        let parsedUrl;
        try { parsedUrl = new URL(content); } catch (_) { parsedUrl = null; }
        if (!parsedUrl || parsedUrl.protocol !== 'https:') {
          return res.status(400).json({ error: 'Las imágenes y videos deben ser URLs seguras (https)' });
        }
      }
    }
    
    const adminRoles = ['admin', 'depositor', 'withdrawer', 'comunidad'];
    const isAdminRole = adminRoles.includes(req.user.role);
    
    // Issue #3: Bloquear comandos enviados por usuarios comunes (solo admins pueden procesar comandos)
    if (!isAdminRole && content.trim().startsWith('/')) {
      return res.status(403).json({ error: 'Los usuarios no pueden enviar comandos' });
    }
    
    logger.debug(`[API_MESSAGES_SEND] isAdminRole: ${isAdminRole}`);
    
    const messageData = {
      id: uuidv4(),
      senderId: req.user.userId,
      senderUsername: req.user.username,
      senderRole: req.user.role,
      receiverId: isAdminRole ? (receiverId || 'admin') : 'admin',
      receiverRole: isAdminRole ? 'user' : 'admin',
      content,
      type,
      timestamp: new Date(),
      read: false
    };
    
    logger.debug(`[API_MESSAGES_SEND] Creating message for receiver: ${messageData.receiverId}`);
    
    
    let message;
    try {
      message = await Message.create(messageData);
      logger.debug(`[API_MESSAGES_SEND] Message created: ${message.id}`);
      
      
    } catch (createError) {
      logger.error(`[API_MESSAGES_SEND] Error creating message: ${createError.message}`);
      if (createError.errors) {
        logger.error(`[API_MESSAGES_SEND] Validation errors: ${JSON.stringify(createError.errors)}`);
      }
      throw createError;
    }
    
    // Guardar usuario en base de datos externa
    if (req.user.role === 'user') {
      let user = await User.findOne({ id: req.user.userId });
      
      if (!user) {
        try {
          user = await User.findById(req.user.userId);
        } catch (e) {
          // _id inválido, ignorar
        }
      }
      
      if (user) {
        await addExternalUser({
          username: user.username,
          phone: user.phone,
          whatsapp: user.whatsapp
        });
      }
    }
    
    // Asegurar que el ChatStatus existe y está actualizado
    const targetUserId = req.user.role === 'admin' ? req.body.receiverId : req.user.userId;
    if (targetUserId) {
      const user = await User.findOne({ id: targetUserId });
      await ChatStatus.findOneAndUpdate(
        { userId: targetUserId },
        { 
          userId: targetUserId,
          username: user ? user.username : req.user.username,
          lastMessageAt: new Date()
        },
        { upsert: true }
      );
    }
    
    // Si es usuario enviando mensaje, reabrir chat solo si estaba cerrado (no si está en pagos)
    if (req.user.role === 'user') {
      await ChatStatus.findOneAndUpdate(
        { userId: req.user.userId, status: 'closed' },
        { status: 'open', assignedTo: null, closedAt: null, closedBy: null }
      );
    }

    // SLA: si el cliente escribió, arrancar el reloj de demora de respuesta
    // (los agentes resuelven el reloj en la rama de comando o en el emit de admin).
    if (!isAdminRole) {
      delayClockOnUserMessage(req.user.userId, content, type).catch(() => {}); // fire-and-forget
    }

    // Comprobantes: si el cliente envía una imagen, analizarla con IA en segundo
    // plano para detectar comprobantes reutilizados. Fire-and-forget: NO frena el chat.
    if (!isAdminRole && type === 'image') {
      analyzeComprobanteFromMessage({
        userId: req.user.userId, username: req.user.username, content, messageId: message.id
      }).catch(() => {});
    }

    // CORREGIDO: Procesar comandos si el mensaje empieza con /
    if (content.trim().startsWith('/')) {
      const commandName = content.trim().split(' ')[0];
      logger.debug(`[API_COMMAND] Command detected: ${commandName}`);
      
      try {
        const command = await Command.findOne({ name: commandName, isActive: true });
        const commandReceiverId = isAdminRole ? (receiverId || req.body.receiverId) : req.user.userId;
        
        if (command) {
          logger.debug(`[API_COMMAND] Command found: ${command.name}`);
          
          // Incrementar contador de uso
          await Command.updateOne(
            { name: commandName },
            { $inc: { usageCount: 1 }, updatedAt: new Date() }
          );
          
          // Crear mensaje de respuesta del sistema
          const responseMessage = await Message.create({
            id: uuidv4(),
            senderId: 'system',
            senderUsername: 'Sistema',
            senderRole: 'system',
            receiverId: commandReceiverId,
            receiverRole: 'user',
            content: command.response,
            type: 'system',
            timestamp: new Date(),
            read: false
          });
          
          // Emitir respuesta al usuario receptor
          io.to(`user_${commandReceiverId}`).emit('new_message', responseMessage);
          
          // Notificar a admins
          notifyAdmins('new_message', {
            message: responseMessage,
            userId: commandReceiverId,
            username: req.user.username
          });
          
          // Notificar sobre el uso del comando
          notifyAdmins('command_used', {
            userId: req.user.userId,
            username: req.user.username,
            command: commandName
          });
          
          logger.debug(`[API_COMMAND] Response sent for command: ${commandName}`);

          // SLA: el comando del agente cuenta como respuesta al cliente.
          if (isAdminRole) {
            delayClockResolve(commandReceiverId, { responded: true, agentId: req.user.userId, agentUsername: req.user.username, via: 'command', queueHint: roleQueueHint(req.user.role) }).catch(() => {});
          }

          // NO emitir el mensaje original del comando, solo la respuesta
          return res.json(responseMessage);
        } else {
          logger.debug(`[API_COMMAND] Command not found: ${commandName}`);
          
          const notFoundMessage = await Message.create({
            id: uuidv4(),
            senderId: 'system',
            senderUsername: 'Sistema',
            senderRole: 'system',
            receiverId: commandReceiverId,
            receiverRole: 'user',
            content: `❓ Comando "${commandName}" no encontrado. Escribe /ayuda para ver los comandos disponibles.`,
            type: 'system',
            timestamp: new Date(),
            read: false
          });
          
          io.to(`user_${commandReceiverId}`).emit('new_message', notFoundMessage);
          return res.json(notFoundMessage);
        }
      } catch (cmdError) {
        logger.error(`[API_COMMAND] Error processing command: ${cmdError.message}`);
      }
    }
    
    // Emitir evento de socket para notificar en tiempo real
    if (req.user.role === 'user') {
      // Notificar a todos los admins sobre el nuevo mensaje
      notifyAdmins('new_message', {
        message,
        userId: req.user.userId,
        username: req.user.username
      });
      // CORREGIDO: También emitir al usuario (para que vea su propio mensaje en tiempo real)
      io.to(`user_${req.user.userId}`).emit('new_message', message);
      io.to(`user_${req.user.userId}`).emit('message_sent', message);
      // Comunidad: si el chat está en esa sección, re-avisar al agente de Comunidad.
      maybeNotifyComunidadActivity(req.user.userId, req.user.username).catch(() => {});
    } else {
      // Admin enviando mensaje - notificar al usuario
      // SLA: respuesta de texto del agente — resolver el reloj de demora (fire-and-forget).
      delayClockResolve(req.body.receiverId, { responded: true, agentId: req.user.userId, agentUsername: req.user.username, via: 'message', queueHint: roleQueueHint(req.user.role) }).catch(() => {});
      const userSocket = connectedUsers.get(req.body.receiverId);
      const deliveredViaSocket = !!userSocket;
      if (userSocket) {
        userSocket.emit('new_message', message);
      }
      // También emitir a la sala del usuario
      io.to(`user_${req.body.receiverId}`).emit('new_message', message);
      // CORREGIDO: Emitir a la sala del chat (para admins que están viendo)
      io.to(`chat_${req.body.receiverId}`).emit('new_message', message);
      // Notificar a otros admins
      notifyAdmins('new_message', {
        message,
        userId: req.body.receiverId,
        username: req.user.username
      });

      // Push FCM para usuario offline: misma lógica que la rama socket de chat
      // (server.js socket.on('send_message')). Sin esto, los clientes que caen
      // a fallback REST nunca disparan push y los users offline pierden el msg.
      if (!deliveredViaSocket && req.body.receiverId) {
        User.findOne({ id: req.body.receiverId })
          .then(function(targetUser) {
            const hasTokens = targetUser && (targetUser.fcmToken || (targetUser.fcmTokens && targetUser.fcmTokens.length > 0));
            if (!hasTokens) return;
            const pushTitle = 'Nuevo mensaje';
            const pushBody = type === 'image' ? '📸 Imagen'
                          : type === 'video' ? '🎥 Video'
                          : (content || '').substring(0, 100);
            sendPushIfOffline(targetUser, pushTitle, pushBody, { tag: 'chat-message' }).catch(function(e) {
              logger.warn(`[FCM] sendPushIfOffline (REST chat) falló para ${targetUser.username}: ${e.message}`);
            });
          })
          .catch(function(dbErr) {
            logger.warn(`[FCM] Error buscando usuario para push (REST chat): ${dbErr.message}`);
          });
      }
    }
    
    res.json(message);
  } catch (error) {
    logger.error(`Error sending message: ${error.message}`);
    if (error.name === 'ValidationError') {
      return res.status(400).json({ error: 'Error de validación: ' + Object.values(error.errors).map(e => e.message).join(', ') });
    }
    res.status(500).json({ error: 'Error del servidor: ' + error.message });
  }
});

// ============================================
// REEMBOLSOS (DIARIO, SEMANAL, MENSUAL)
// ============================================

/**
 * Obtener total de créditos no-depósito (bonus, reembolsos previos, comisiones, fire rewards)
 * para un usuario en un período. Se restan del NETWIN antes de calcular reembolsos.
 */
async function getRefundNonDepositCredits(username, fromDate, toDate) {
  const result = await Transaction.aggregate([
    { $match: {
      username: username,
      type: { $in: ['bonus', 'refund', 'referral_commission', 'fire_reward'] },
      createdAt: { $gte: fromDate, $lte: toDate }
    }},
    { $group: { _id: null, total: { $sum: '$amount' } }}
  ]);
  return result[0]?.total || 0;
}

// ============================================
// RANGOS DE REEMBOLSO (bronce / plata / oro)
// ============================================
// El % de reembolso (semanal Y mensual) depende del RANGO del cliente, que se
// define por su pérdida real (NETWIN) del mes calendario: hasta el tope de
// bronce → % bronce; hasta el de plata → % plata; más que eso → oro.
// Umbrales y % editables desde el panel (solo admin general) vía
// Config['refundTiers']. El reembolso DIARIO fue eliminado (2026-07-28).
const REFUND_TIER_DEFAULTS = {
  bronce: { upTo: 30000, percent: 3 },
  plata: { upTo: 100000, percent: 5 },
  oro: { percent: 10 }
};
const REFUND_TIER_META = {
  bronce: { label: 'Bronce', emoji: '🥉' },
  plata: { label: 'Plata', emoji: '🥈' },
  oro: { label: 'Oro', emoji: '🥇' }
};
async function getRefundTiers() {
  // Copia PROFUNDA: si fuera shallow, un caller que mute tiers.bronce.percent
  // envenenaría REFUND_TIER_DEFAULTS para todo el proceso.
  const d = {
    bronce: { ...REFUND_TIER_DEFAULTS.bronce },
    plata: { ...REFUND_TIER_DEFAULTS.plata },
    oro: { ...REFUND_TIER_DEFAULTS.oro }
  };
  try {
    const cfg = await getConfig('refundTiers', null);
    if (!cfg) return d;
    const pct = (v, def) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= 100 ? n : def;
    };
    const upTo = (v, def) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : def;
    };
    const out = {
      bronce: { upTo: upTo(cfg.bronce && cfg.bronce.upTo, d.bronce.upTo), percent: pct(cfg.bronce && cfg.bronce.percent, d.bronce.percent) },
      plata: { upTo: upTo(cfg.plata && cfg.plata.upTo, d.plata.upTo), percent: pct(cfg.plata && cfg.plata.percent, d.plata.percent) },
      oro: { percent: pct(cfg.oro && cfg.oro.percent, d.oro.percent) }
    };
    // Coherencia: los umbrales tienen que ser crecientes; si no, defaults.
    if (out.bronce.upTo >= out.plata.upTo) return d;
    return out;
  } catch (_) {
    return d;
  }
}
// Devuelve el rango que corresponde a una pérdida mensual dada.
function computeRefundTier(monthNetLoss, tiers) {
  const loss = Math.max(0, Number(monthNetLoss) || 0);
  let key;
  if (loss <= tiers.bronce.upTo) key = 'bronce';
  else if (loss <= tiers.plata.upTo) key = 'plata';
  else key = 'oro';
  return { key, label: REFUND_TIER_META[key].label, emoji: REFUND_TIER_META[key].emoji, percent: tiers[key].percent };
}

app.get('/api/refunds/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;

    const userInfo = await jugaygana.getUserInfoByName(username);
    const currentBalance = userInfo ? userInfo.balance : 0;

    // Rangos de fechas (zona horaria Argentina)
    const lastWeekRange = jugaygana.getLastWeekRangeArgentinaEpoch();
    const lastMonthRange = jugaygana.getLastMonthRangeArgentinaEpoch();
    const currentMonthRange = jugaygana.getCurrentMonthToDateRangeArgentinaEpoch();

    const [weeklyStatus, monthlyStatus] = await Promise.all([
      refunds.canClaimWeeklyRefund(userId),
      refunds.canClaimMonthlyRefund(userId)
    ]);

    const weeklyFrom = new Date(lastWeekRange.fromEpoch * 1000);
    const weeklyTo = new Date(lastWeekRange.toEpoch * 1000);
    const monthlyFrom = new Date(lastMonthRange.fromEpoch * 1000);
    const monthlyTo = new Date(lastMonthRange.toEpoch * 1000);
    const curMonthFrom = new Date(currentMonthRange.fromEpoch * 1000);
    const curMonthTo = new Date(currentMonthRange.toEpoch * 1000);

    // NETWIN/GGR REAL por período (apostado − ganado), MISMA fuente que referidos.
    // El reembolso es sobre la PÉRDIDA REAL de juego, NO sobre cargas − retiros. Si la
    // plataforma no responde para un período, ese netLoss queda en 0 (no se preview de más).
    const jgId = await resolveJugayganaUserId(userId, username);
    const [wN, mN, curN] = await Promise.all([
      referralRevenueService.getUserNetwinForDateRange(username, jgId, weeklyFrom, weeklyTo, 'refund-weekly'),
      referralRevenueService.getUserNetwinForDateRange(username, jgId, monthlyFrom, monthlyTo, 'refund-monthly'),
      referralRevenueService.getUserNetwinForDateRange(username, jgId, curMonthFrom, curMonthTo, 'refund-tier')
    ]);
    const weeklyNetLoss = wN.success ? Math.max(0, Number(wN.totalGgr) || 0) : 0;
    const monthlyNetLoss = mN.success ? Math.max(0, Number(mN.totalGgr) || 0) : 0;
    const currentMonthNetLoss = curN.success ? Math.max(0, Number(curN.totalGgr) || 0) : 0;

    logger.info(`[REFUND] status — ${username} NETWIN weekly:${wN.totalGgr}→${weeklyNetLoss} monthly:${mN.totalGgr}→${monthlyNetLoss} mes-en-curso:${curN.totalGgr}→${currentMonthNetLoss}`);

    // RANGOS (bronce/plata/oro):
    // - currentTier: rango "en vivo" según la pérdida del mes EN CURSO (para mostrar).
    // - monthlyTier: rango del mes reembolsado (el % real del reclamo mensual).
    // - weeklyTier: rango del mes al que pertenece la semana reembolsada, decidido
    //   por su LUNES (inicio). Lunes en el mes en curso → currentTier; lunes en el
    //   mes anterior (incluye semanas que cruzan el cambio de mes) → ese mes
    //   completo == monthlyTier. Misma regla que aplica el claim semanal.
    const tiers = await getRefundTiers();
    const currentTier = computeRefundTier(currentMonthNetLoss, tiers);
    const monthlyTier = computeRefundTier(monthlyNetLoss, tiers);
    const _curMonthKey = currentMonthRange.fromDateStr.slice(0, 7);
    const weeklyTier = lastWeekRange.fromDateStr.slice(0, 7) === _curMonthKey ? currentTier : monthlyTier;

    const weeklyPotential = Math.round(weeklyNetLoss * (weeklyTier.percent / 100));
    const monthlyPotential = Math.round(monthlyNetLoss * (monthlyTier.percent / 100));

    // Info de "cuánto falta para el próximo rango" (para la card de la PWA).
    // El corte es INCLUSIVO (hasta upTo = ese rango), así que para subir hay que
    // SUPERAR el tope: missing = upTo - pérdida + 1 (nunca 0 estando en el rango).
    let nextTier = null;
    if (currentTier.key === 'bronce') {
      nextTier = { key: 'plata', label: REFUND_TIER_META.plata.label, emoji: REFUND_TIER_META.plata.emoji, percent: tiers.plata.percent, missing: Math.max(1, tiers.bronce.upTo - currentMonthNetLoss + 1) };
    } else if (currentTier.key === 'plata') {
      nextTier = { key: 'oro', label: REFUND_TIER_META.oro.label, emoji: REFUND_TIER_META.oro.emoji, percent: tiers.oro.percent, missing: Math.max(1, tiers.plata.upTo - currentMonthNetLoss + 1) };
    }

    res.json({
      user: {
        username,
        currentBalance,
        jugayganaLinked: !!userInfo
      },
      tier: {
        ...currentTier,
        percentage: currentTier.percent,
        monthNetLoss: currentMonthNetLoss,
        period: `${currentMonthRange.fromDateStr} a ${currentMonthRange.toDateStr}`,
        nextTier,
        tiers: {
          bronce: { ...REFUND_TIER_META.bronce, upTo: tiers.bronce.upTo, percent: tiers.bronce.percent },
          plata: { ...REFUND_TIER_META.plata, upTo: tiers.plata.upTo, percent: tiers.plata.percent },
          oro: { ...REFUND_TIER_META.oro, upTo: null, percent: tiers.oro.percent }
        }
      },
      // Stub inerte para PWAs viejas cacheadas (el reembolso diario fue eliminado
      // 2026-07-28; sin este objeto, un cliente con JS viejo rompería al renderizar).
      daily: {
        canClaim: false,
        discontinued: true,
        potentialAmount: 0,
        netAmount: 0,
        percentage: 0,
        period: null,
        nextClaim: null
      },
      weekly: {
        ...weeklyStatus,
        potentialAmount: weeklyPotential,
        netAmount: weeklyNetLoss,
        percentage: weeklyTier.percent,
        tier: weeklyTier.key,
        period: `${lastWeekRange.fromDateStr} a ${lastWeekRange.toDateStr}`
      },
      monthly: {
        ...monthlyStatus,
        potentialAmount: monthlyPotential,
        netAmount: monthlyNetLoss,
        percentage: monthlyTier.percent,
        tier: monthlyTier.key,
        period: `${lastMonthRange.fromDateStr} a ${lastMonthRange.toDateStr}`
      }
    });
  } catch (error) {
    console.error('Error obteniendo estado de reembolsos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// TOMBSTONE (2026-07-28): el reembolso DIARIO fue ELIMINADO — reemplazado por el
// sistema de rangos (bronce/plata/oro) que define el % de los reembolsos semanal
// y mensual. El endpoint queda como stub amigable porque PWAs viejas cacheadas
// por el service worker siguen llamándolo un tiempo (lección de #88).
// Rollback: git revert.
app.post('/api/refunds/claim/daily', authMiddleware, (req, res) => {
  res.json({
    success: false,
    canClaim: false,
    discontinued: true,
    message: 'El reembolso diario ya no está disponible: ahora tu reembolso SEMANAL y MENSUAL se calcula según tu rango (🥉 Bronce, 🥈 Plata, 🥇 Oro). Recargá la app para ver tu rango.'
  });
});

app.post('/api/refunds/claim/weekly', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    
    if (!await acquireRefundLock(userId, 'weekly')) {
      return res.json({
        success: false,
        message: '⏳ Ya estás procesando un reembolso. Por favor espera...',
        canClaim: true,
        processing: true
      });
    }
    
    try {
      const status = await refunds.canClaimWeeklyRefund(userId);
      
      if (!status.canClaim) {
        return res.json({
          success: false,
          message: `No puedes reclamar el reembolso semanal. Disponible: ${status.availableDays}`,
          canClaim: false,
          nextClaim: status.nextClaim,
          availableDays: status.availableDays
        });
      }
      
      // Obtener jugayganaUserId para consultar NETWIN (misma fuente que referidos).
      // Si falta, se intenta completar automáticamente (backfill al vuelo).
      const jugayganaUserId = await resolveJugayganaUserId(userId, username);
      
      if (!jugayganaUserId) {
        return res.json({
          success: false,
          message: 'Tu cuenta no está vinculada a la plataforma. Contacta al soporte.',
          canClaim: true
        });
      }
      
      const { fromEpoch, toEpoch, fromDateStr, toDateStr } = jugaygana.getLastWeekRangeArgentinaEpoch();
      const fromDate = new Date(fromEpoch * 1000);
      const toDate = new Date(toEpoch * 1000);

      // NETWIN/GGR REAL del período (apostado − ganado), misma fuente que referidos.
      const netRes = await referralRevenueService.getUserNetwinForDateRange(username, jugayganaUserId, fromDate, toDate, 'refund-weekly');
      if (!netRes.success) {
        logger.warn(`[REFUND] weekly — no se pudo leer NETWIN de ${username}: ${netRes.error || 's/detalle'}`);
        return res.json({ success: false, message: 'No pudimos calcular tu pérdida en este momento (la plataforma está demorada). Probá en unos minutos.', canClaim: true });
      }
      const netLoss = Math.max(0, Number(netRes.totalGgr) || 0);
      logger.info('[REFUND] weekly — usuario:', username, 'NETWIN(GGR):', netRes.totalGgr, 'netLoss:', netLoss);

      if (netLoss === 0) {
        logger.info('[REFUND] weekly — sin pérdida real para:', username);
        return res.json({
          success: false,
          message: 'No tenés pérdida en el período. El reembolso aplica solo sobre lo que perdiste jugando.',
          canClaim: true,
          netAmount: 0
        });
      }

      // % según RANGO (bronce/plata/oro): pérdida del mes al que pertenece la
      // semana reembolsada, decidido por el LUNES de esa semana (su inicio):
      //  - Lunes en el mes EN CURSO → mes en curso al día de hoy (jugar antes de
      //    reclamar solo puede SUBIR el rango).
      //  - Lunes en el mes ANTERIOR (incluye las semanas que cruzan el cambio de
      //    mes) → ese mes COMPLETO. Decidir por el domingo era un bug: en la
      //    primera semana del mes el rango se calculaba con 1-2 días del mes
      //    nuevo y descartaba toda la pérdida acumulada del mes anterior.
      // Misma regla que muestra el status.
      const tiers = await getRefundTiers();
      const _curMonthRange = jugaygana.getCurrentMonthToDateRangeArgentinaEpoch();
      let tierRange;
      if (fromDateStr.slice(0, 7) === _curMonthRange.fromDateStr.slice(0, 7)) {
        tierRange = _curMonthRange;
      } else {
        // Mes completo del lunes de la semana reembolsada (último día calculado
        // localmente: los meses no cambian por timezone al pedir el día 0).
        const [_wy, _wm] = fromDateStr.split('-').map(Number);
        const _lastDay = new Date(_wy, _wm, 0).getDate();
        tierRange = jugaygana.getMonthToDateRangeForDateArgentina(`${fromDateStr.slice(0, 7)}-${String(_lastDay).padStart(2, '0')}`);
      }
      const tierRes = await referralRevenueService.getUserNetwinForDateRange(
        username, jugayganaUserId,
        new Date(tierRange.fromEpoch * 1000), new Date(tierRange.toEpoch * 1000),
        'refund-tier'
      );
      if (!tierRes.success) {
        logger.warn(`[REFUND] weekly — no se pudo leer NETWIN mensual (rango) de ${username}: ${tierRes.error || 's/detalle'}`);
        return res.json({ success: false, message: 'No pudimos calcular tu rango en este momento (la plataforma está demorada). Probá en unos minutos.', canClaim: true });
      }
      const monthNetLoss = Math.max(0, Number(tierRes.totalGgr) || 0);
      const tier = computeRefundTier(monthNetLoss, tiers);
      const weeklyPct = tier.percent;
      const refundAmount = Math.round(netLoss * (weeklyPct / 100));

      logger.info('[REFUND] weekly — calculado para', username, 'netLoss:', netLoss, 'rango:', tier.key, `(pérdida mes ${monthNetLoss})`, 'pct:', weeklyPct, 'refund:', refundAmount);

      // Guard: si el monto redondea a $0 (pérdida ínfima o % en 0), NO reservar el
      // período — sin esto se creaba el RefundClaim (índice único) y el usuario
      // quemaba su semana por $0 sin poder reintentar.
      if (refundAmount <= 0) {
        return res.json({
          success: false,
          message: 'Tu pérdida del período es muy chica para generar reembolso esta vez.',
          canClaim: true,
          netAmount: netLoss
        });
      }

      // CANDADO REAL contra doble cobro (ver comentario en el reembolso diario):
      // reservar el reclamo (índice único) ANTES de acreditar.
      const _refundClaimId = uuidv4();
      const _refundPeriodKey = 'weekly:' + fromDateStr;
      try {
        await RefundClaim.create({
          id: _refundClaimId, userId, username, type: 'weekly',
          amount: refundAmount, netAmount: netLoss, percentage: weeklyPct, tier: tier.key,
          period: `${fromDateStr} a ${toDateStr}`, periodKey: _refundPeriodKey, claimedAt: new Date()
        });
      } catch (e) {
        if (e && e.code === 11000) {
          return res.json({ success: false, message: 'Ya reclamaste tu reembolso semanal esta semana.', canClaim: false });
        }
        throw e;
      }

      const depositResult = await jugaygana.creditUserBalance(username, refundAmount, jugayganaUserId);

      if (!depositResult.success) {
        // No se pudo acreditar → liberar la reserva para permitir reintentar.
        await RefundClaim.deleteOne({ id: _refundClaimId }).catch(() => {});
        return res.json({
          success: false,
          message: 'Error al acreditar el reembolso: ' + depositResult.error,
          canClaim: true
        });
      }

      // Persistir el transactionId real ahora que la acreditación salió OK.
      const _refundTxId = depositResult.data?.transfer_id || depositResult.data?.transferId;
      if (_refundTxId) await RefundClaim.updateOne({ id: _refundClaimId }, { $set: { transactionId: _refundTxId } }).catch(() => {});

      // Guardar transacción para el dashboard
      await Transaction.create({
        id: uuidv4(),
        type: 'refund',
        amount: refundAmount,
        username,
        description: `Reembolso semanal (${fromDateStr} a ${toDateStr})`,
        transactionId: _refundTxId,
        timestamp: new Date()
      });

      // Meta CAPI — RefundClaim semanal.
      try {
        const u = await User.findOne({ id: userId }).lean();
        metaCapi.track(
          'RefundClaim',
          { email: u && u.email, phone: u && u.phone, externalId: userId, fbc: u && u.metaFbc, fbp: u && u.metaFbp },
          { value: refundAmount, currency: 'ARS', content_name: 'refund_weekly', period: `${fromDateStr} a ${toDateStr}` },
          { eventId: req.body && req.body.metaEventId, req }
        );
      } catch (e) { /* tracking nunca bloquea */ }

      res.json({
        success: true,
        message: `¡Reembolso semanal de $${refundAmount} acreditado! (Rango ${tier.emoji} ${tier.label} — ${weeklyPct}%)`,
        amount: refundAmount,
        percentage: weeklyPct,
        tier: tier.key,
        netAmount: netLoss,
        nextClaim: status.nextClaim
      });
    } finally {
      setTimeout(() => releaseRefundLock(userId, 'weekly'), 3000);
    }
  } catch (error) {
    console.error('Error reclamando reembolso semanal:', error);
    res.json({ success: false, message: 'Error del servidor', canClaim: true });
  }
});

app.post('/api/refunds/claim/monthly', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    
    if (!await acquireRefundLock(userId, 'monthly')) {
      return res.json({
        success: false,
        message: '⏳ Ya estás procesando un reembolso. Por favor espera...',
        canClaim: true,
        processing: true
      });
    }
    
    try {
      const status = await refunds.canClaimMonthlyRefund(userId);
      
      if (!status.canClaim) {
        return res.json({
          success: false,
          message: `No puedes reclamar el reembolso mensual. Disponible: ${status.availableFrom}`,
          canClaim: false,
          nextClaim: status.nextClaim,
          availableFrom: status.availableFrom
        });
      }
      
      // Obtener jugayganaUserId para consultar NETWIN (misma fuente que referidos).
      // Si falta, se intenta completar automáticamente (backfill al vuelo).
      const jugayganaUserId = await resolveJugayganaUserId(userId, username);
      
      if (!jugayganaUserId) {
        return res.json({
          success: false,
          message: 'Tu cuenta no está vinculada a la plataforma. Contacta al soporte.',
          canClaim: true
        });
      }
      
      const { fromEpoch, toEpoch, fromDateStr, toDateStr } = jugaygana.getLastMonthRangeArgentinaEpoch();
      const fromDate = new Date(fromEpoch * 1000);
      const toDate = new Date(toEpoch * 1000);

      // NETWIN/GGR REAL del período (apostado − ganado), misma fuente que referidos.
      const netRes = await referralRevenueService.getUserNetwinForDateRange(username, jugayganaUserId, fromDate, toDate, 'refund-monthly');
      if (!netRes.success) {
        logger.warn(`[REFUND] monthly — no se pudo leer NETWIN de ${username}: ${netRes.error || 's/detalle'}`);
        return res.json({ success: false, message: 'No pudimos calcular tu pérdida en este momento (la plataforma está demorada). Probá en unos minutos.', canClaim: true });
      }
      const netLoss = Math.max(0, Number(netRes.totalGgr) || 0);
      logger.info('[REFUND] monthly — usuario:', username, 'NETWIN(GGR):', netRes.totalGgr, 'netLoss:', netLoss);

      if (netLoss === 0) {
        logger.info('[REFUND] monthly — sin pérdida real para:', username);
        return res.json({
          success: false,
          message: 'No tenés pérdida en el período. El reembolso aplica solo sobre lo que perdiste jugando.',
          canClaim: true,
          netAmount: 0
        });
      }

      // % según RANGO (bronce/plata/oro): para el reclamo MENSUAL, el rango se
      // define por la pérdida del propio mes reembolsado (perdiste $X ese mes →
      // ese X define bronce/plata/oro y el % se aplica sobre ese mismo X).
      const tiers = await getRefundTiers();
      const tier = computeRefundTier(netLoss, tiers);
      const monthlyPct = tier.percent;
      const refundAmount = Math.round(netLoss * (monthlyPct / 100));

      logger.info('[REFUND] monthly — calculado para', username, 'netLoss:', netLoss, 'rango:', tier.key, 'pct:', monthlyPct, 'refund:', refundAmount);

      // Guard: si el monto redondea a $0 (pérdida ínfima o % en 0), NO reservar el
      // período — sin esto se creaba el RefundClaim (índice único) y el usuario
      // quemaba su mes por $0 sin poder reintentar.
      if (refundAmount <= 0) {
        return res.json({
          success: false,
          message: 'Tu pérdida del período es muy chica para generar reembolso esta vez.',
          canClaim: true,
          netAmount: netLoss
        });
      }

      // CANDADO REAL contra doble cobro (ver comentario en el reembolso diario):
      // reservar el reclamo (índice único) ANTES de acreditar.
      const _refundClaimId = uuidv4();
      const _refundPeriodKey = 'monthly:' + fromDateStr.slice(0, 7);
      try {
        await RefundClaim.create({
          id: _refundClaimId, userId, username, type: 'monthly',
          amount: refundAmount, netAmount: netLoss, percentage: monthlyPct, tier: tier.key,
          period: `${fromDateStr} a ${toDateStr}`, periodKey: _refundPeriodKey, claimedAt: new Date()
        });
      } catch (e) {
        if (e && e.code === 11000) {
          return res.json({ success: false, message: 'Ya reclamaste tu reembolso mensual este mes.', canClaim: false });
        }
        throw e;
      }

      const depositResult = await jugaygana.creditUserBalance(username, refundAmount, jugayganaUserId);

      if (!depositResult.success) {
        // No se pudo acreditar → liberar la reserva para permitir reintentar.
        await RefundClaim.deleteOne({ id: _refundClaimId }).catch(() => {});
        return res.json({
          success: false,
          message: 'Error al acreditar el reembolso: ' + depositResult.error,
          canClaim: true
        });
      }

      // Persistir el transactionId real ahora que la acreditación salió OK.
      const _refundTxId = depositResult.data?.transfer_id || depositResult.data?.transferId;
      if (_refundTxId) await RefundClaim.updateOne({ id: _refundClaimId }, { $set: { transactionId: _refundTxId } }).catch(() => {});

      // Guardar transacción para el dashboard
      await Transaction.create({
        id: uuidv4(),
        type: 'refund',
        amount: refundAmount,
        username,
        description: `Reembolso mensual (${fromDateStr} a ${toDateStr})`,
        transactionId: _refundTxId,
        timestamp: new Date()
      });

      // Meta CAPI — RefundClaim mensual.
      try {
        const u = await User.findOne({ id: userId }).lean();
        metaCapi.track(
          'RefundClaim',
          { email: u && u.email, phone: u && u.phone, externalId: userId, fbc: u && u.metaFbc, fbp: u && u.metaFbp },
          { value: refundAmount, currency: 'ARS', content_name: 'refund_monthly', period: `${fromDateStr} a ${toDateStr}` },
          { eventId: req.body && req.body.metaEventId, req }
        );
      } catch (e) { /* tracking nunca bloquea */ }

      res.json({
        success: true,
        message: `¡Reembolso mensual de $${refundAmount} acreditado! (Rango ${tier.emoji} ${tier.label} — ${monthlyPct}%)`,
        amount: refundAmount,
        percentage: monthlyPct,
        tier: tier.key,
        netAmount: netLoss,
        nextClaim: status.nextClaim
      });
    } finally {
      setTimeout(() => releaseRefundLock(userId, 'monthly'), 3000);
    }
  } catch (error) {
    console.error('Error reclamando reembolso mensual:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/refunds/history', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const userRefunds = await RefundClaim.find({ userId }).sort({ claimedAt: -1 }).lean();
    
    res.json({ refunds: userRefunds });
  } catch (error) {
    console.error('Error obteniendo historial de reembolsos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/refunds/all', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const allRefunds = await RefundClaim.find().sort({ claimedAt: -1 }).lean();
    
    const summary = {
      dailyCount: 0,
      weeklyCount: 0,
      monthlyCount: 0,
      totalAmount: 0
    };
    
    allRefunds.forEach(r => {
      summary.totalAmount += r.amount || 0;
      if (r.type === 'daily') summary.dailyCount++;
      else if (r.type === 'weekly') summary.weeklyCount++;
      else if (r.type === 'monthly') summary.monthlyCount++;
    });
    
    res.json({
      refunds: allRefunds,
      summary
    });
  } catch (error) {
    console.error('Error obteniendo todos los reembolsos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// RANGOS DE REEMBOLSO — config (solo admin general)
// ============================================
// Permite ajustar umbrales y % de los rangos bronce/plata/oro desde el panel.
// Reemplaza a GET/POST /api/admin/refund-percents (eliminados 2026-07-28 junto
// con el reembolso diario; rollback: git revert).
// adminMiddleware deja entrar a depositor/withdrawer/comunidad, por eso se
// re-chequea role==='admin' explícito: SOLO el admin general puede ver/editar.
app.get('/api/admin/refund-tiers', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin general puede ver los rangos de reembolso.' });
    }
    const tiers = await getRefundTiers();
    res.json({ tiers, defaults: REFUND_TIER_DEFAULTS });
  } catch (error) {
    console.error('Error obteniendo rangos de reembolso:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/admin/refund-tiers', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin general puede modificar los rangos de reembolso.' });
    }
    const cur = await getRefundTiers();
    const b = req.body || {};
    // Cada valor ausente mantiene el actual; inválido → 400.
    const pickPct = (v, def) => {
      if (v === undefined || v === null || v === '') return def;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100) return NaN;
      return n;
    };
    const pickUpTo = (v, def) => {
      if (v === undefined || v === null || v === '') return def;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return NaN;
      return Math.round(n);
    };
    const next = {
      bronce: { upTo: pickUpTo(b.bronceUpTo, cur.bronce.upTo), percent: pickPct(b.broncePct, cur.bronce.percent) },
      plata: { upTo: pickUpTo(b.plataUpTo, cur.plata.upTo), percent: pickPct(b.plataPct, cur.plata.percent) },
      oro: { percent: pickPct(b.oroPct, cur.oro.percent) }
    };
    if ([next.bronce.upTo, next.bronce.percent, next.plata.upTo, next.plata.percent, next.oro.percent].some(Number.isNaN)) {
      return res.status(400).json({ error: 'Valores inválidos: los topes deben ser montos positivos y los porcentajes números entre 0 y 100.' });
    }
    if (next.bronce.upTo >= next.plata.upTo) {
      return res.status(400).json({ error: 'El tope de Bronce debe ser menor que el de Plata.' });
    }
    await setConfig('refundTiers', next);
    logger.info(`[refund-tiers] actualizado por ${req.user.username}: bronce hasta $${next.bronce.upTo} = ${next.bronce.percent}% · plata hasta $${next.plata.upTo} = ${next.plata.percent}% · oro = ${next.oro.percent}%`);
    res.json({ success: true, tiers: next });
  } catch (error) {
    console.error('Error guardando rangos de reembolso:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// MOVIMIENTOS DE SALDO
// ============================================

app.get('/api/balance', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    const result = await jugayganaMovements.getUserBalance(username);
    
    if (result.success) {
      res.json({
        balance: result.balance,
        username: result.username
      });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error obteniendo balance:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/balance/live', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    const result = await jugayganaMovements.getUserBalance(username);
    
    if (result.success) {
      await User.updateOne(
        { username },
        { balance: result.balance }
      );
      
      res.json({
        balance: result.balance,
        username: result.username,
        updatedAt: new Date().toISOString()
      });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error obteniendo balance en tiempo real:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/movements', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    const { startDate, endDate, page = 1 } = req.query;
    
    const result = await jugayganaMovements.getUserMovements(username, {
      startDate,
      endDate,
      page: parseInt(page),
      pageSize: 50
    });
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error obteniendo movimientos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/admin/deposit', authMiddleware, depositorMiddleware, async (req, res) => {
  try {
    const { userId, username, amount, bonus = 0, description } = req.body;
    
    // Buscar usuario por ID o username
    let user;
    if (userId) {
      user = await User.findOne({ id: userId });
    } else if (username) {
      user = await User.findOne({ username });
    }
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }

    const result = await jugaygana.depositToUser(user.username, parseFloat(amount), description, user.jugayganaUserId || null);

    if (result.success) {
      // SLA: atender al cliente con una carga cuenta como respuesta (resuelve el reloj).
      await delayClockResolve(user.id, { responded: true, agentId: req.user.userId, agentUsername: req.user.username, via: 'operation', queueHint: 'cargas' });
      // Si hay bonus, acreditarlo en JUGAYGANA como individual_bonus en operación separada.
      // Pausa de 700ms entre la carga principal y el bonus para evitar el rate-limit
      // interno de JUGAYGANA sobre operaciones consecutivas sobre el mismo user
      // (causa documentada del bug "carga sí, bonus no": dos DepositMoney en <100ms
      // disparaban HTML/Cloudflare en la segunda llamada).
      const bonusRequested = parseFloat(bonus) > 0;
      let bonusJgResult = null;
      let bonusActuallyApplied = false;

      if (bonusRequested) {
        await new Promise(r => setTimeout(r, 700));
        // Pasamos jugayganaUserId si lo tenemos guardado: bypasea el lookup en
        // ShowUsers (causa documentada de fallas por paginación / scoping de
        // sub-agentes). Si el usuario no tiene jugayganaUserId persistido
        // (legacy), creditUserBalance cae al lookup tradicional.
        bonusJgResult = await jugaygana.creditUserBalance(
          user.username,
          parseFloat(bonus),
          user.jugayganaUserId || null
        );
        bonusActuallyApplied = !!(bonusJgResult && bonusJgResult.success);
        if (!bonusActuallyApplied) {
          logger.error(
            `[deposit] BONUS FALLÓ user=${user.username} jgId=${user.jugayganaUserId || 'null'} ` +
            `amount=$${amount} bonus=$${bonus} agent=${req.user?.username || '?'} ` +
            `error=${bonusJgResult?.error || 'sin detalle'}`
          );
        }
      }

      await recordUserActivity(user.id, 'deposit', parseFloat(amount));

      // hgcash: si esta carga MANUAL corresponde a una transferencia hgcash pendiente
      // de ese usuario (mismo monto), marcarla como cargada → no se auto-carga después.
      // Fire-and-forget: no frena la respuesta de la carga.
      hgcashConsumeOnManualDeposit(user.id, user.username, parseFloat(amount)).catch(() => {});

      // ROI de las estrategias: si el depósito incluyó bono, marcamos el
      // PromoBonus vigente del usuario como usado y guardamos el monto de
      // la carga. Con eso los reportes calculan ingreso / costo / ROI.
      if (parseFloat(bonus) > 0) {
        try {
          await PromoBonus.findOneAndUpdate(
            { username: String(user.username).toLowerCase(), status: 'active', expiresAt: { $gt: new Date() } },
            { $set: { status: 'used', usedBy: req.user.username || null, usedAt: new Date(), cargaMonto: parseFloat(amount) } },
            { sort: { activatedAt: -1 } }
          );
        } catch (promoErr) {
          logger.warn(`[promo-bonus] no se pudo marcar usado en depósito: ${promoErr.message}`);
        }
      }

      // Fueguito: si el cliente tenía pendiente el premio "100% en próxima carga"
      // (hito día 15) y esta carga incluyó un bonus que SÍ se acreditó, el premio
      // se considera consumido. Limpiamos el flag de forma atómica (solo si estaba
      // en true) para que el cartel deje de aparecerle al cliente y no se pueda
      // volver a reclamar (antes el flag nunca se limpiaba = bono 100% infinito).
      if (bonusActuallyApplied) {
        try {
          const fireClear = await FireStreak.updateOne(
            { userId: user.id, pendingNextLoadBonus: true },
            { $set: { pendingNextLoadBonus: false } }
          );
          if (fireClear.modifiedCount > 0) {
            logger.info(`[fire] pendingNextLoadBonus consumido por carga con bonus user=${user.username} agent=${req.user?.username}`);
          }
        } catch (fireErr) {
          logger.warn(`[fire] no se pudo limpiar pendingNextLoadBonus en depósito: ${fireErr.message}`);
        }
      }

      // Obtener saldo actualizado del usuario. Reintenta para evitar el bug
      // histórico donde un fallo transitorio post-depósito hacía que el server
      // mandara "Tu nuevo saldo es $0" engañoso (el depósito SÍ se aplicó pero
      // getUserBalance falló y defaulteábamos a 0).
      const balanceResult = await jugayganaMovements.getUserBalanceWithRetry(user.username);
      let newBalance = null;
      if (balanceResult.success) {
        newBalance = balanceResult.balance;
      } else if (result.data?.user_balance_after !== undefined && result.data?.user_balance_after !== null) {
        // Fallback: usar el balance que JuegayGana devolvió en la propia
        // respuesta del DepositMoney (si vino). Más confiable que defaultear a 0.
        newBalance = result.data.user_balance_after;
        logger.warn(`[deposit] getUserBalanceWithRetry falló para ${user.username}, usando user_balance_after=${newBalance} del DepositMoney`);
      } else {
        logger.warn(`[deposit] No se pudo obtener saldo para ${user.username} tras depósito $${amount} (bonus $${bonus}). balanceResult.error=${balanceResult.error}. Mensaje al usuario sin saldo.`);
      }
      const balanceStr = newBalance !== null ? `$${newBalance}` : 'actualizándose 🔄';

      // Crear mensaje de sistema para el usuario
      const depositCmdName = parseFloat(bonus) > 0 ? '/sys_deposit_bonus' : '/sys_deposit';
      const depositCmd = await Command.findOne({ name: depositCmdName, isActive: true });
      // Si el comando existe pero fue vaciado desde el panel → no se envía la confirmación.
      const depositMsgDisabled = depositCmd && (!depositCmd.response || !String(depositCmd.response).trim());
      if (!depositMsgDisabled) {
      let messageContent;
      // El mensaje al usuario refleja el OUTCOME REAL, no lo que se pidió:
      //   - Si bonus solicitado + acreditado OK → menciona ambos
      //   - Si bonus solicitado + falló → mensaje sólo de carga (no engañamos
      //     al usuario diciendo que recibió un bonus que no entró)
      //   - Si no había bonus → mensaje de carga normal
      // El agente recibe un aviso aparte (más abajo) cuando el bonus falla
      // para que lo aplique manualmente.
      const includeBonusInMessage = bonusRequested && bonusActuallyApplied;
      if (depositCmd && depositCmd.response) {
        messageContent = depositCmd.response
          .replace(/\{amount\}/g, amount)
          .replace(/\{bonus\}/g, includeBonusInMessage ? bonus : 0)
          .replace(/\{balance\}/g, newBalance !== null ? newBalance : 'actualizándose');
      } else if (includeBonusInMessage) {
        messageContent = `🔒💰 Depósito de $${amount} (incluye $${bonus} de bonificación) acreditado con éxito. ✅ \n💸 Tu nuevo saldo es ${balanceStr} 💸\n\nPuedes verificarlo en: https://jugaygana.bet\n\n🔥 Recorda: tenes reembolso SEMANAL (lunes y martes) y MENSUAL (desde el dia 7) segun tu rango 🥉🥈🥇 🔥`;
      } else {
        messageContent = `🔒💰 Depósito de $${amount} acreditado con éxito. ✅ \n💸 Tu nuevo saldo es ${balanceStr} 💸\n\nPuedes verificarlo en: https://jugaygana.bet\n\n🔥 Recorda: tenes reembolso SEMANAL (lunes y martes) y MENSUAL (desde el dia 7) segun tu rango 🥉🥈🥇 🔥`;
      }
      
      const systemMessage = await Message.create({
        id: uuidv4(),
        senderId: 'admin',
        senderUsername: req.user.username,
        senderRole: 'admin',
        receiverId: user.id,
        receiverRole: 'user',
        content: messageContent,
        type: 'system',
        timestamp: new Date(),
        read: false
      });
      
      // CORREGIDO: Emitir a todos los que están viendo este chat (usuario y admins)
      const messageData = {
        id: systemMessage.id,
        senderId: 'admin',
        senderUsername: req.user.username,
        senderRole: 'admin',
        receiverId: user.id,
        receiverRole: 'user',
        content: messageContent,
        timestamp: new Date(),
        type: 'system'
      };
      
      // Emitir a la sala del usuario
      io.to(`user_${user.id}`).emit('new_message', messageData);
      
      // Emitir a la sala del chat (para admins que están viendo)
      io.to(`chat_${user.id}`).emit('new_message', messageData);
      
      // Notificar a todos los admins
      notifyAdmins('new_message', {
        message: messageData,
        userId: user.id,
        username: user.username
      });
      } // fin confirmación de depósito (omitida si el comando fue vaciado)

      // Si el bonus se solicitó pero falló en JUGAYGANA tras los 3 reintentos,
      // crear un mensaje admin-only en el chat avisando al agente que tiene
      // que reintentar el bonus manualmente. El cliente NO ve este mensaje.
      if (bonusRequested && !bonusActuallyApplied) {
        try {
          const alertContent = `⚠️ BONUS NO APLICADO en JUGAYGANA\n\n• Carga: $${amount} ✅ acreditada\n• Bonus pedido: $${bonus} ❌ NO acreditado\n• Motivo: ${bonusJgResult?.error || 'desconocido'}\n\nReintentá el bonus desde el botón "Bonus". El cliente NO fue informado del bonus.`;
          const alertMsg = await Message.create({
            id: uuidv4(),
            senderId: 'admin',
            senderUsername: req.user.username,
            senderRole: 'admin',
            receiverId: user.id,
            receiverRole: 'user',
            content: alertContent,
            type: 'system',
            adminOnly: true, // <- clave: sólo visible para admins en el chat
            timestamp: new Date(),
            read: false
          });
          const alertData = {
            id: alertMsg.id,
            senderId: 'admin',
            senderUsername: req.user.username,
            senderRole: 'admin',
            receiverId: user.id,
            receiverRole: 'user',
            content: alertContent,
            timestamp: new Date(),
            type: 'system',
            adminOnly: true
          };
          // Sólo emitimos a la sala del chat (admins lo ven) — NO a user_<id>
          // para que el cliente no reciba este aviso técnico.
          io.to(`chat_${user.id}`).emit('new_message', alertData);
          notifyAdmins('new_message', { message: alertData, userId: user.id, username: user.username });
        } catch (alertErr) {
          logger.warn(`[deposit bonus-failed alert] no se pudo crear mensaje: ${alertErr.message}`);
        }
      }

      // Segundo mensaje recordatorio (omitido si /sys_reminder fue vaciado)
      const reminderCmd = await Command.findOne({ name: '/sys_reminder', isActive: true });
      const reminderDisabled = reminderCmd && (!reminderCmd.response || !String(reminderCmd.response).trim());
      if (!reminderDisabled) {
      const reminderContent = (reminderCmd && reminderCmd.response)
        ? reminderCmd.response
            .replace(/\{amount\}/g, amount)
            .replace(/\{balance\}/g, newBalance)
        : `🎮 ¡Recuerda!\nPara cargar o cobrar, ingresa a 🌐 www.vipcargas.com.\n🔥 ¡Ya tienes el acceso guardado, así que te queda más fácil y rápido cada vez que entres!  \n🕹️ ¡No olvides guardarla y mantenerla a mano!\n\nwww.vipcargas.com`;
      const reminderMessage = await Message.create({
        id: uuidv4(),
        senderId: 'admin',
        senderUsername: req.user.username,
        senderRole: 'admin',
        receiverId: user.id,
        receiverRole: 'user',
        content: reminderContent,
        type: 'system',
        timestamp: new Date(),
        read: false
      });
      const reminderData = {
        id: reminderMessage.id,
        senderId: 'admin',
        senderUsername: req.user.username,
        senderRole: 'admin',
        receiverId: user.id,
        receiverRole: 'user',
        content: reminderContent,
        timestamp: new Date(),
        type: 'system'
      };
      io.to(`user_${user.id}`).emit('new_message', reminderData);
      io.to(`chat_${user.id}`).emit('new_message', reminderData);
      notifyAdmins('new_message', { message: reminderData, userId: user.id, username: user.username });
      } // fin recordatorio (omitido si el comando fue vaciado)

      // Cartel "instalá la app" — solo si el usuario TODAVÍA NO la tiene instalada.
      // Detección: tener un token FCM de contexto 'standalone' = PWA instalada.
      const hasAppInstalled = user.fcmTokenContext === 'standalone'
        || (Array.isArray(user.fcmTokens) && user.fcmTokens.some(t => t && t.context === 'standalone'));

      if (!hasAppInstalled) {
        const installCmd = await Command.findOne({ name: '/sys_install_app', isActive: true });
        const installDisabled = installCmd && (!installCmd.response || !String(installCmd.response).trim());
        if (!installDisabled) { // null = comando vaciado a propósito → no enviar
        const installContent = (installCmd && installCmd.response)
          ? installCmd.response.replace(/\{amount\}/g, amount).replace(/\{balance\}/g, newBalance !== null ? newBalance : 'actualizándose')
          : `🎁━━━━━━━━━━━━━━━🎁\n📲 INSTALÁ LA APP\n   Y GANÁ UN 100% 🎁\n🎁━━━━━━━━━━━━━━━🎁\n\n¿Todavía no instalaste la app? ¡Hacelo ahora y desbloqueá un BONO del 100% EXTRA en tu PRÓXIMA CARGA! 🤑\n\n✅ Te avisamos al toque de tus bonos y reembolsos\n✅ Entrás más rápido y no perdés tu cuenta\n\n📲 Tocá "📱 Instalar App" o, en el menú del navegador, elegí "Agregar a pantalla de inicio".\n\n🎁 Una vez instalada, abrí la app y tocá el botón "🎁 Reclamar mi 100%" que vas a ver arriba del chat. ¡Después avisale al cajero en tu próxima carga!`;

        const installMessage = await Message.create({
          id: uuidv4(),
          senderId: 'admin',
          senderUsername: req.user.username,
          senderRole: 'admin',
          receiverId: user.id,
          receiverRole: 'user',
          content: installContent,
          type: 'system',
          timestamp: new Date(),
          read: false
        });
        const installData = {
          id: installMessage.id,
          senderId: 'admin',
          senderUsername: req.user.username,
          senderRole: 'admin',
          receiverId: user.id,
          receiverRole: 'user',
          content: installContent,
          timestamp: new Date(),
          type: 'system'
        };
        io.to(`user_${user.id}`).emit('new_message', installData);
        io.to(`chat_${user.id}`).emit('new_message', installData);
        notifyAdmins('new_message', { message: installData, userId: user.id, username: user.username });
        } // fin cartel instalá la app (omitido si el comando fue vaciado)
      }

      // Oferta de recuperación 100% (no se envía si está etiquetado comunidad/no comunidad).
      await maybeSendRecoveryMessage(user);

      // Notificar al usuario específico si está conectado. Sólo si tenemos
      // balance real — si falló el lookup, omitimos para no escribir "null" en UI.
      const userSocket = connectedUsers.get(user.id);
      if (userSocket && newBalance !== null) {
        userSocket.emit('balance_updated', { balance: newBalance });
      }

      // Push FCM para usuarios offline. El título/body reflejan el outcome REAL
      // (si el bonus falló, no mencionamos bonus — mismo principio que en el
      // mensaje del chat, no engañamos al usuario sobre lo que recibió).
      {
        const depositPushTitle = (bonusRequested && bonusActuallyApplied)
          ? `💰 Depósito + bonus acreditado`
          : `💰 Depósito acreditado`;
        const depositPushBody = newBalance !== null
          ? `$${amount} acreditados en tu cuenta. Nuevo saldo: $${newBalance}.`
          : `$${amount} acreditados en tu cuenta.`;
        sendPushIfOffline(user, depositPushTitle, depositPushBody, { tag: 'deposit' }).catch((e) => {
          logger.warn(`[FCM] sendPushIfOffline (deposit) falló para ${user.username}: ${e.message}`);
        });
      }

      // Transaction de la carga principal. El campo bonus refleja lo que se
      // acreditó realmente, no lo que se pidió: si el bonus falló queda en 0.
      // Esto mantiene la consistencia con la Transaction tipo 'bonus' separada
      // (más abajo) que sólo se crea si el bonus efectivamente entró.
      await Transaction.create({
        id: uuidv4(),
        type: 'deposit',
        amount: parseFloat(amount),
        bonus: bonusActuallyApplied ? parseFloat(bonus) : 0,
        username: user.username,
        userId: user.id,
        description: description || 'Depósito realizado',
        adminId: req.user?.userId,
        adminUsername: req.user?.username,
        adminRole: req.user?.role || 'admin',
        transactionId: result.data?.transfer_id || result.data?.transferId,
        metadata: bonusRequested && !bonusActuallyApplied ? {
          // Trazabilidad: agente pidió bonus pero no entró. Sirve para reportes
          // de discrepancias y para que el admin sepa que hubo intento fallido.
          requestedBonus: parseFloat(bonus),
          bonusFailureReason: bonusJgResult?.error || 'desconocido'
        } : null,
        timestamp: new Date()
      });

      // Registrar bonificación como transacción separada solo si fue acreditada correctamente en JUGAYGANA
      if (parseFloat(bonus) > 0 && bonusJgResult?.success) {
        await Transaction.create({
          id: uuidv4(),
          type: 'bonus',
          amount: parseFloat(bonus),
          username: user.username,
          userId: user.id,
          description: `Bonificación incluida en depósito de $${amount}`,
          adminId: req.user?.userId,
          adminUsername: req.user?.username,
          adminRole: req.user?.role || 'admin',
          transactionId: bonusJgResult.data?.transfer_id,
          timestamp: new Date()
        });
      }

      // Meta CAPI — Purchase (la conversión más valiosa: depósito confirmado por admin).
      // Sólo server-side: este endpoint lo invocan admins, el navegador del jugador
      // que recibe el depósito no participa, así que no hay browser pixel para deduplicar.
      const depositAdminOrderId = result.data?.transfer_id || result.data?.transferId || null;
      metaCapi.track(
        'Purchase',
        { email: user.email, phone: user.phone, externalId: user.id, fbc: user.metaFbc, fbp: user.metaFbp },
        {
          value: parseFloat(amount),
          currency: 'ARS',
          content_name: 'deposit_admin',
          content_type: 'product',
          content_category: metaCapi.valueCategory(parseFloat(amount)),
          order_id: depositAdminOrderId
        },
        { req }
      );

      // Webhook a fb-ads: conversión Purchase para aprendizaje por anuncio.
      fbAdsWebhook.notify('Purchase', user, { value: parseFloat(amount), currency: 'ARS' });

      logger.info(
        `[deposit] OK admin=${req.user?.username} user=${user.username} amount=$${amount} ` +
        `bonusRequested=$${bonus || 0} bonusApplied=${bonusActuallyApplied} ` +
        `transferId=${result.data?.transfer_id || result.data?.transferId || 'n/a'} ` +
        `balanceLookup=${balanceResult.success ? 'ok' : 'failed'}`
      );

      res.json({
        success: true,
        message: bonusRequested && !bonusActuallyApplied
          ? 'Depósito acreditado, pero el bonus FALLÓ en JUGAYGANA. Reintentá el bonus manualmente.'
          : 'Depósito realizado correctamente',
        newBalance: newBalance,
        transactionId: result.data?.transfer_id || result.data?.transferId,
        // Banderas explícitas para que el panel admin sepa exactamente qué pasó.
        bonusRequested: bonusRequested,
        bonusApplied: bonusActuallyApplied,
        bonusError: bonusRequested && !bonusActuallyApplied ? bonusJgResult?.error : null
      });
    } else {
      logger.error(`[deposit] FAIL admin=${req.user?.username} user=${user.username} amount=$${amount} bonus=$${bonus || 0} error=${result.error || 'sin error'}`);
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error realizando depósito:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/admin/balance/:username', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { username } = req.params;
    const result = await jugayganaMovements.getUserBalance(username);
    
    if (result.success) {
      res.json({ balance: result.balance });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error obteniendo balance:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/admin/withdrawal', authMiddleware, withdrawerMiddleware, async (req, res) => {
  try {
    const { userId, username, amount, description } = req.body;
    
    // Buscar usuario por ID o username
    let user;
    if (userId) {
      user = await User.findOne({ id: userId });
    } else if (username) {
      user = await User.findOne({ username });
    }
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }

    // Si el usuario destino vino por flujo rápido y aún no verificó teléfono,
    // el admin tampoco puede procesar el retiro: el usuario tiene que verificar
    // primero (decisión de negocio: anti-fraude).
    if (user.phoneVerificationPending === true) {
      return res.status(403).json({
        error: `${user.username} debe verificar un teléfono antes de poder retirar.`,
        code: 'PHONE_VERIFICATION_REQUIRED'
      });
    }

    const result = await jugaygana.withdrawFromUser(user.username, amount, description);
    
    if (result.success) {
      await recordUserActivity(user.id, 'withdrawal', amount);
      // SLA: atender al cliente con un retiro cuenta como respuesta (resuelve el reloj).
      await delayClockResolve(user.id, { responded: true, agentId: req.user.userId, agentUsername: req.user.username, via: 'operation', queueHint: 'pagos' });

      // Obtener saldo actualizado del usuario. Reintenta para evitar "saldo $0"
      // engañoso cuando getUserBalance falla transitoriamente post-retiro.
      const balanceResult = await jugayganaMovements.getUserBalanceWithRetry(user.username);
      let newBalance = null;
      if (balanceResult.success) {
        newBalance = balanceResult.balance;
      } else if (result.data?.user_balance_after !== undefined && result.data?.user_balance_after !== null) {
        newBalance = result.data.user_balance_after;
        logger.warn(`[withdrawal] getUserBalanceWithRetry falló para ${user.username}, usando user_balance_after=${newBalance} del WithdrawMoney`);
      } else {
        logger.warn(`[withdrawal] No se pudo obtener saldo para ${user.username} tras retiro $${amount}. balanceResult.error=${balanceResult.error}. Mensaje al usuario sin saldo.`);
      }
      const balanceStr = newBalance !== null ? `$${newBalance}` : 'actualizándose 🔄';

      // Crear mensaje de sistema para el usuario (omitido si /sys_withdrawal fue vaciado)
      const withdrawalCmd = await Command.findOne({ name: '/sys_withdrawal', isActive: true });
      const withdrawalDisabled = withdrawalCmd && (!withdrawalCmd.response || !String(withdrawalCmd.response).trim());
      if (!withdrawalDisabled) {
      const messageContent = (withdrawalCmd && withdrawalCmd.response)
        ? withdrawalCmd.response
            .replace(/\{amount\}/g, amount)
            .replace(/\{balance\}/g, newBalance !== null ? newBalance : 'actualizándose')
        : `🔒💸 Retiro de $${amount} realizado correctamente. \n💸 Tu nuevo saldo es ${balanceStr} 💸\nSu pago se está procesando. Por favor, aguarde un momento.`;

      const systemMessage = await Message.create({
        id: uuidv4(),
        senderId: 'admin',
        senderUsername: req.user.username,
        senderRole: 'admin',
        receiverId: user.id,
        receiverRole: 'user',
        content: messageContent,
        type: 'system',
        timestamp: new Date(),
        read: false
      });

      // CORREGIDO: Emitir a todos los que están viendo este chat (usuario y admins)
      const messageData = {
        id: systemMessage.id,
        senderId: 'admin',
        senderUsername: req.user.username,
        senderRole: 'admin',
        receiverId: user.id,
        receiverRole: 'user',
        content: messageContent,
        timestamp: new Date(),
        type: 'system'
      };

      // Emitir a la sala del usuario
      io.to(`user_${user.id}`).emit('new_message', messageData);

      // Emitir a la sala del chat (para admins que están viendo)
      io.to(`chat_${user.id}`).emit('new_message', messageData);

      // Notificar a todos los admins
      notifyAdmins('new_message', {
        message: messageData,
        userId: user.id,
        username: user.username
      });
      } // fin mensaje de retiro (omitido si el comando fue vaciado)

      // Notificar al usuario específico si está conectado. Sólo si tenemos
      // balance real — si falló el lookup, omitimos para no escribir "null" en UI.
      const userSocket = connectedUsers.get(user.id);
      if (userSocket && newBalance !== null) {
        userSocket.emit('balance_updated', { balance: newBalance });
      }

      // Push FCM para usuarios offline.
      const withdrawalPushBody = newBalance !== null
        ? `$${amount} enviados. Nuevo saldo: $${newBalance}.`
        : `$${amount} enviados.`;
      sendPushIfOffline(user, '💸 Retiro procesado', withdrawalPushBody, { tag: 'withdrawal' }).catch((e) => {
        logger.warn(`[FCM] sendPushIfOffline (withdrawal) falló para ${user.username}: ${e.message}`);
      });
      
      await Transaction.create({
        id: uuidv4(),
        type: 'withdrawal',
        amount: parseFloat(amount),
        username: user.username,
        userId: user.id,
        description: description || 'Retiro realizado',
        adminId: req.user?.userId,
        adminUsername: req.user?.username,
        adminRole: req.user?.role || 'admin',
        transactionId: result.data?.transfer_id || result.data?.transferId,
        timestamp: new Date()
      });

      // Meta CAPI — WithdrawRequest (procesado por admin).
      metaCapi.track(
        'WithdrawRequest',
        { email: user.email, phone: user.phone, externalId: user.id, fbc: user.metaFbc, fbp: user.metaFbp },
        { value: parseFloat(amount), currency: 'ARS', content_name: 'withdraw_admin' },
        { req }
      );

      logger.info(`[withdrawal] OK admin=${req.user?.username} user=${user.username} amount=$${amount} transferId=${result.data?.transfer_id || result.data?.transferId || 'n/a'} balanceLookup=${balanceResult.success ? 'ok' : 'failed'}`);

      res.json({
        success: true,
        message: 'Retiro realizado correctamente',
        newBalance: newBalance,
        transactionId: result.data?.transfer_id || result.data?.transferId
      });
    } else {
      logger.error(`[withdrawal] FAIL admin=${req.user?.username} user=${user.username} amount=$${amount} error=${result.error || 'sin error'}`);
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error realizando retiro:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/admin/bonus', authMiddleware, depositorMiddleware, async (req, res) => {
  try {
    const { username: rawUsername, userId: rawUserId, amount } = req.body;

    // Resolver username + cargar el user completo para obtener jugayganaUserId.
    // Rechazar cualquier userId que no sea string primitivo (previene inyección NoSQL)
    let bonusUser = null;
    if (rawUsername && typeof rawUsername === 'string') {
      bonusUser = await User.findOne({ username: rawUsername.trim() });
    } else if (rawUserId) {
      if (typeof rawUserId !== 'string') {
        return res.status(400).json({ error: 'userId inválido' });
      }
      bonusUser = await User.findOne({ id: rawUserId.trim() });
    }
    if (!bonusUser) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    const resolvedUsername = bonusUser.username;

    if (!resolvedUsername || !amount) {
      return res.status(400).json({ error: 'Usuario y monto requeridos' });
    }

    const bonusAmount = parseFloat(amount);
    if (isNaN(bonusAmount) || bonusAmount <= 0) {
      return res.status(400).json({ error: 'Monto de bonificación inválido' });
    }

    // Pasamos jugayganaUserId guardado para saltearse el lookup en ShowUsers.
    // Bypasea el bug "user not found" por paginación / scoping de sub-agentes.
    const depositResult = await jugaygana.creditUserBalance(
      resolvedUsername,
      bonusAmount,
      bonusUser.jugayganaUserId || null
    );

    if (depositResult.success) {
      // SLA: atender al cliente con un bonus cuenta como respuesta (resuelve el reloj).
      await delayClockResolve(bonusUser.id, { responded: true, agentId: req.user.userId, agentUsername: req.user.username, via: 'operation', queueHint: 'cargas' });
      // bonusUser ya lo resolvimos arriba con findOne — no hace falta repetir
      // el query (mismo efecto, una llamada menos a la DB).

      logger.info(`[bonus] OK admin=${req.user?.username} user=${resolvedUsername} jgId=${bonusUser.jugayganaUserId || 'null'} amount=$${bonusAmount} transferId=${depositResult.data?.transfer_id || depositResult.data?.transferId || 'n/a'}`);

      await Transaction.create({
        id: uuidv4(),
        type: 'bonus',
        amount: bonusAmount,
        username: resolvedUsername,
        description: 'Bonificación otorgada',
        adminId: req.user?.userId,
        adminUsername: req.user?.username,
        adminRole: req.user?.role || 'admin',
        transactionId: depositResult.data?.transfer_id || depositResult.data?.transferId,
        timestamp: new Date()
      });

      // Obtener saldo actualizado para incluirlo en el mensaje (con retry)
      const balanceResult = await jugayganaMovements.getUserBalanceWithRetry(resolvedUsername);
      const newBalance = balanceResult.success ? balanceResult.balance : null;
      if (!balanceResult.success) {
        logger.warn(`[bonus] getUserBalanceWithRetry falló para ${resolvedUsername} tras bonus $${bonusAmount}. error=${balanceResult.error}`);
      }

      // Enviar mensaje automático al usuario con el monto acreditado y el saldo actual
      if (bonusUser) {
        try {
          const bonusCmd = await Command.findOne({ name: '/sys_bonus', isActive: true });
          const bonusDisabled = bonusCmd && (!bonusCmd.response || !String(bonusCmd.response).trim());
          let bonusMsg;
          if (bonusCmd && bonusCmd.response) {
            bonusMsg = bonusCmd.response
              .replace(/\$\{amount\}/g, bonusAmount)
              .replace(/\$\{balance\}/g, newBalance !== null ? newBalance : '—');
          } else {
            bonusMsg = `🎁 ¡Bonificación de $${bonusAmount} acreditada en tu cuenta! ✅\n💸 Tu saldo actual es $${newBalance !== null ? newBalance : '—'} 💸\n\nPuedes verificarlo en: https://www.jugaygana44.bet`;
          }
          if (!bonusDisabled) await Message.create({ // null = comando vaciado a propósito → no enviar
            id: uuidv4(),
            senderId: 'system',
            senderUsername: req.user?.username,
            senderRole: 'admin',
            receiverId: bonusUser.id,
            receiverRole: 'user',
            content: bonusMsg,
            type: 'system',
            timestamp: new Date(),
            read: false
          });
        } catch (msgErr) {
          console.error('No se pudo enviar mensaje de bonus al usuario:', msgErr);
        }

        // Push FCM para usuarios offline (bonus).
        const bonusBalance = newBalance !== null ? newBalance : '—';
        sendPushIfOffline(bonusUser, '🎁 Bonificación acreditada', `$${bonusAmount} de bonus en tu cuenta. Saldo: $${bonusBalance}.`, { tag: 'bonus' }).catch((e) => {
          logger.warn(`[FCM] sendPushIfOffline (bonus) falló para ${bonusUser.username}: ${e.message}`);
        });
      }

      res.json({
        success: true,
        message: `Bonificación de $${bonusAmount.toLocaleString()} realizada correctamente`,
        newBalance: newBalance !== null ? newBalance : depositResult.data?.user_balance_after,
        transactionId: depositResult.data?.transfer_id || depositResult.data?.transferId
      });
    } else {
      logger.error(`[bonus] FAIL admin=${req.user?.username} user=${resolvedUsername} amount=$${bonusAmount} error=${depositResult.error || 'sin error'}`);
      res.status(400).json({ error: depositResult.error || 'Error al aplicar bonificación' });
    }
  } catch (error) {
    console.error('Error realizando bonificación:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// SOCKET.IO - CHAT EN TIEMPO REAL
// ============================================

const connectedUsers = new Map();
const connectedAdmins = new Map();

io.on('connection', (socket) => {
  logger.debug(`New socket connection: ${socket.id}`);
  
  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });

      // Revalidar contra la DB (igual que authMiddleware): un usuario
      // desactivado, bloqueado o con la sesión revocada (tokenVersion) no
      // debe poder operar el socket aunque la firma del JWT siga siendo válida.
      let sockUser = await User.findOne({ id: decoded.userId });
      if (!sockUser) {
        try { sockUser = await User.findById(decoded.userId); } catch (e) { /* _id inválido */ }
      }
      if (!sockUser || sockUser.isActive === false || sockUser.isBlocked === true) {
        socket.emit('authenticated', { success: false, error: 'Sesión no válida' });
        return;
      }
      if ((decoded.tokenVersion ?? 0) !== (sockUser.tokenVersion ?? 0)) {
        socket.emit('authenticated', { success: false, error: 'Sesión expirada' });
        return;
      }

      socket.userId = decoded.userId;
      socket.username = decoded.username;
      socket.role = decoded.role;

      if (['admin', 'depositor', 'withdrawer', 'comunidad'].includes(decoded.role)) {
        connectedAdmins.set(decoded.userId, socket);
        socket.join('admins'); // Unir a sala de admins
        logger.info(`Admin connected: ${decoded.username} (${decoded.role}) socket=${socket.id}`);
        broadcastStats();
      } else {
        connectedUsers.set(decoded.userId, socket);
        socket.join(`user_${decoded.userId}`); // Unir a sala personal del usuario
        logger.info(`User connected: ${decoded.username} id=${decoded.userId} socket=${socket.id}`);
        notifyAdmins('user_connected', {
          userId: decoded.userId,
          username: decoded.username
        });
      }
      
      socket.emit('authenticated', { success: true, role: decoded.role });
    } catch (error) {
      logger.error(`Socket auth error: ${error.message}`);
      socket.emit('authenticated', { success: false, error: 'Token inválido' });
    }
  });
  
  // Unirse a sala de admins (admin, depositor, withdrawer)
  socket.on('join_admin_room', () => {
    if (['admin', 'depositor', 'withdrawer', 'comunidad'].includes(socket.role)) {
      socket.join('admins');
      logger.debug(`Admin ${socket.username} (${socket.role}) joined admin room`);
    }
  });
  
  // Unirse a sala personal del usuario
  socket.on('join_user_room', (data) => {
    // SECURITY: Only allow a user to join their OWN room (prevent room spoofing)
    if (socket.role === 'user' && data && data.userId && data.userId === socket.userId) {
      socket.join(`user_${data.userId}`);
      logger.debug(`User ${socket.username} joined personal room: user_${data.userId}`);
    } else if (socket.role === 'user' && data && data.userId && data.userId !== socket.userId) {
      logger.warn(`[SECURITY] User ${socket.username} (${socket.userId}) attempted to join room of user ${data.userId}`);
    }
  });
  
  // CORREGIDO: Unirse a sala de chat específica (para admins)
  socket.on('join_chat_room', (data) => {
    if (['admin', 'depositor', 'withdrawer', 'comunidad'].includes(socket.role) && data && data.userId) {
      socket.join(`chat_${data.userId}`);
      logger.debug(`Admin ${socket.username} joined chat room: chat_${data.userId}`);
    }
  });
  
  // CORREGIDO: Salir de sala de chat
  socket.on('leave_chat_room', (data) => {
    if (data && data.userId) {
      socket.leave(`chat_${data.userId}`);
      logger.debug(`${socket.username} left chat room: chat_${data.userId}`);
    }
  });
  
  socket.on('send_message', async (data) => {
    try {
      const { content, type = 'text', receiverId } = data;
      
      logger.debug(`[SEND_MESSAGE] user=${socket.userId} role=${socket.role} receiverId=${receiverId}`);
      
      if (!socket.userId) {
        logger.debug('[SEND_MESSAGE] ERROR: not authenticated');
        return socket.emit('error', { message: 'No autenticado' });
      }

      // Bienvenida-fantasma de clientes viejos cacheados → descartar (nunca la manda el cliente).
      if (socket.role === 'user' && _isStaleClientWelcome(content)) {
        logger.info(`[welcome-guard] descartada bienvenida-fantasma (socket) de ${socket.userId}`);
        return; // no guardar, no emitir
      }

      // SECURITY: Validate message type to prevent type confusion
      const allowedMsgTypes = ['text', 'image', 'video'];
      if (!allowedMsgTypes.includes(type)) {
        return socket.emit('error', { message: 'Tipo de mensaje no válido' });
      }

      // Tope de longitud para texto (evita blobs gigantes por socket).
      if (type === 'text' && typeof content === 'string' && content.length > 8000) {
        return socket.emit('error', { message: 'El mensaje es demasiado largo.' });
      }

      // SECURITY: For image/video, validate that content is a well-formed https:// URL or an allowed data: URL
      if ((type === 'image' || type === 'video') && content) {
        const MAX_BASE64_SIZE = 5 * 1024 * 1024; // 5MB
        const ALLOWED_DATA_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'];
        if (content.startsWith('data:')) {
          const mimeMatch = content.match(/^data:([\w\/+.-]+);base64,/);
          if (!mimeMatch || !ALLOWED_DATA_MIMES.includes(mimeMatch[1])) {
            return socket.emit('error', { message: 'Tipo de imagen o video no permitido' });
          }
          if (content.length > MAX_BASE64_SIZE) {
            return socket.emit('error', { message: 'La imagen o video es demasiado grande (máximo 5MB)' });
          }
        } else {
          let parsedMsgUrl;
          try { parsedMsgUrl = new URL(content); } catch (_) { parsedMsgUrl = null; }
          if (!parsedMsgUrl || parsedMsgUrl.protocol !== 'https:') {
            return socket.emit('error', { message: 'Las imágenes y videos deben ser URLs seguras (https)' });
          }
        }
      }
      
      // Determinar el receptor correcto
      const isAdminRole = ['admin', 'depositor', 'withdrawer', 'comunidad'].includes(socket.role);
      const targetReceiverId = isAdminRole ? receiverId : 'admin';
      const targetReceiverRole = isAdminRole ? 'user' : 'admin';
      
      logger.debug(`[SEND_MESSAGE] isAdminRole=${isAdminRole} targetReceiverId=${targetReceiverId}`);

      // Issue #3: Bloquear comandos enviados por usuarios comunes
      if (!isAdminRole && content && content.trim().startsWith('/')) {
        return socket.emit('error', { message: 'Los usuarios no pueden enviar comandos' });
      }
      
      // CORREGIDO: PROCESAR COMANDOS ANTES de guardar el mensaje
      // Si el mensaje empieza con /, es un comando - NO guardar el mensaje del comando
      if (content.trim().startsWith('/')) {
        const commandName = content.trim().split(' ')[0];
        logger.debug(`[COMMAND] Command detected: ${commandName}`);
        
        try {
          const command = await Command.findOne({ name: commandName, isActive: true });
          
          // Determinar el receptor del comando
          const commandReceiverId = isAdminRole ? receiverId : socket.userId;
          
          if (command) {
            logger.debug(`[COMMAND] Command found: ${command.name}`);
            
            // Incrementar contador de uso
            await Command.updateOne(
              { name: commandName },
              { $inc: { usageCount: 1 }, updatedAt: new Date() }
            );
            
            // Crear mensaje de respuesta del sistema (SOLO la respuesta, NO el comando)
            const responseMessage = await Message.create({
              id: uuidv4(),
              senderId: 'system',
              senderUsername: 'Sistema',
              senderRole: 'system',
              receiverId: commandReceiverId,
              receiverRole: 'user',
              content: command.response,
              type: 'system',
              timestamp: new Date(),
              read: false
            });
            
            // Enviar respuesta al usuario receptor
            io.to(`user_${commandReceiverId}`).emit('new_message', responseMessage);
            io.to(`chat_${commandReceiverId}`).emit('new_message', responseMessage);
            
            // Notificar a admins
            notifyAdmins('new_message', {
              message: responseMessage,
              userId: commandReceiverId,
              username: socket.username
            });
            
            // Notificar sobre el uso del comando
            notifyAdmins('command_used', {
              userId: socket.userId,
              username: socket.username,
              command: commandName
            });

            logger.debug(`[COMMAND] Response sent for command: ${commandName}`);

            // SLA: el comando del agente cuenta como respuesta al cliente.
            if (isAdminRole) {
              delayClockResolve(commandReceiverId, { responded: true, agentId: socket.userId, agentUsername: socket.username, via: 'command', queueHint: roleQueueHint(socket.role) }).catch(() => {});
            }

            // IMPORTANTE: NO guardar el mensaje del comando (/cbu), solo la respuesta
            // Salir aquí - el mensaje del comando NO se guarda ni se emite
            return;
          } else {
            logger.debug(`[COMMAND] Command not found: ${commandName}`);
            
            const notFoundMessage = await Message.create({
              id: uuidv4(),
              senderId: 'system',
              senderUsername: 'Sistema',
              senderRole: 'system',
              receiverId: commandReceiverId,
              receiverRole: 'user',
              content: `❓ Comando "${commandName}" no encontrado.`,
              type: 'system',
              timestamp: new Date(),
              read: false
            });
            
            io.to(`user_${commandReceiverId}`).emit('new_message', notFoundMessage);
            io.to(`chat_${commandReceiverId}`).emit('new_message', notFoundMessage);
            
            // NO guardar el mensaje del comando
            return;
          }
        } catch (cmdError) {
          logger.error(`[COMMAND] Error processing command: ${cmdError.message}`);
          return;
        }
      }
      
      // Si llegamos aquí, NO es un comando - guardar el mensaje normalmente
      const messageData = {
        id: uuidv4(),
        senderId: socket.userId,
        senderUsername: socket.username,
        senderRole: socket.role,
        receiverId: targetReceiverId,
        receiverRole: targetReceiverRole,
        content,
        type,
        timestamp: new Date(),
        read: false
      };
      
      // Crear el mensaje
      let message;
      try {
        message = await Message.create(messageData);
        logger.debug(`[SEND_MESSAGE] Message saved: ${message.id}`);
      } catch (createError) {
        logger.error(`[SEND_MESSAGE] Error saving message: ${createError.message}`);
        throw createError;
      }
      
      // Housekeeping del ChatStatus ANTES de emitir 'new_message'. Si se emite
      // primero, un admin que recibe el evento y recarga su lista de chats puede
      // leer un ChatStatus todavía sin actualizar (o aún inexistente, en el
      // primer mensaje de un usuario) y "perder" el chat: no le aparece hasta
      // que otro evento lo recarga. Hacerlo antes garantiza que cualquier
      // recarga, de cualquier admin, vea el chat con su estado real.
      const targetUserId = isAdminRole ? receiverId : socket.userId;
      if (targetUserId) {
        try {
          // El username del usuario emisor ya lo tenemos (socket.username);
          // sólo para mensajes de admin hay que resolver el del destinatario.
          let chatUsername = socket.username;
          if (isAdminRole) {
            const chatUser = await User.findOne({ id: targetUserId }).select('username').lean();
            if (chatUser) chatUsername = chatUser.username;
          }
          await ChatStatus.findOneAndUpdate(
            { userId: targetUserId },
            { userId: targetUserId, username: chatUsername, lastMessageAt: new Date() },
            { upsert: true, setDefaultsOnInsert: true }
          );
          // Solo los mensajes del usuario reabren el chat si estaba cerrado.
          if (!isAdminRole) {
            await ChatStatus.findOneAndUpdate(
              { userId: targetUserId, status: 'closed' },
              { status: 'open', closedAt: null, closedBy: null }
            );
          }
          // SLA: reloj de demora de respuesta. Si responde un agente, resolvemos
          // (y registramos si superó el umbral); si escribe el cliente, arrancamos.
          // Fire-and-forget: el tracking de demoras corre en segundo plano y NO
          // frena la entrega del mensaje (los helpers ya capturan sus errores).
          if (isAdminRole) {
            delayClockResolve(targetUserId, { responded: true, agentId: socket.userId, agentUsername: socket.username, via: 'message', queueHint: roleQueueHint(socket.role) }).catch(() => {});
          } else {
            delayClockOnUserMessage(targetUserId, content, type).catch(() => {});
          }
        } catch (csErr) {
          logger.error(`[SEND_MESSAGE] ChatStatus update failed: ${csErr.message}`);
        }
      }

      // Comprobantes: imagen de un cliente → análisis IA fire-and-forget para
      // detectar reutilización. NO frena la entrega del mensaje.
      if (!isAdminRole && type === 'image') {
        analyzeComprobanteFromMessage({
          userId: socket.userId, username: socket.username, content, messageId: message.id
        }).catch(() => {});
      }

      // Entregar el mensaje en tiempo real (ya con el ChatStatus actualizado,
      // para que cualquier admin que recargue su lista vea el chat).
      if (!isAdminRole) {
        // Usuario enviando mensaje - notificar a todos los admins
        logger.debug(`[SOCKET] User ${socket.username} sent message`);
        
        // Emitir a todos los admins conectados (envuelto para facilitar extracción)
        io.to('admins').emit('new_message', {
          message,
          userId: socket.userId,
          username: socket.username
        });
        
        // Emitir a la sala del chat específico (para admins que están viendo este chat)
        io.to(`chat_${socket.userId}`).emit('new_message', message);
        
        // Confirmar al usuario y entregar el mensaje via sala (evitar duplicado)
        socket.emit('message_sent', message);
        io.to(`user_${socket.userId}`).emit('new_message', message);

        // Comunidad: si el chat está en esa sección, re-avisar al agente de Comunidad.
        maybeNotifyComunidadActivity(socket.userId, socket.username).catch(() => {});
      } else {
        // Admin/depositor/withdrawer enviando mensaje - notificar al usuario específico
        logger.debug(`[SEND_MESSAGE] Looking up socket for user ${receiverId}`);

        // CORREGIDO: Múltiples canales de entrega para asegurar que llegue
        let delivered = false;

        // Canal 1: Socket directo, CON ack-timeout 3s. Si el cliente está vivo
        // confirma con ack({ ok: true }) (ver public/js/socket.js handler
        // 'new_message'). Si no responde en 3s consideramos el socket "fantasma"
        // (TCP conectado, pero el browser suspendió la pestaña o el SO mató el
        // proceso) y disparamos push FCM como respaldo.
        const userSocket = connectedUsers.get(receiverId);
        let ackReceived = false;
        if (userSocket) {
          delivered = true;
          try {
            userSocket.timeout(3000).emit('new_message', message, function (err /*, ack */) {
              if (err) {
                // Timeout o error de ack: el directo no contestó.
                logger.debug(`[SEND_MESSAGE] ack-timeout para user ${receiverId} (msg ${message.id}); fallback FCM`);
                _maybeSendPushFallback(receiverId, message);
              } else {
                ackReceived = true;
                logger.debug(`[SEND_MESSAGE] ack OK del user ${receiverId} (msg ${message.id})`);
              }
            });
          } catch (emitErr) {
            // Cliente Socket.IO sin soporte de ack: fallback inmediato a emit normal
            logger.warn(`[SEND_MESSAGE] timeout().emit no disponible (${emitErr.message}); usando emit plano`);
            try { userSocket.emit('new_message', message); } catch (_) {}
          }
        }

        // Canal 2: Sala del usuario (por si está conectado en otra pestaña/dispositivo)
        io.to(`user_${receiverId}`).emit('new_message', message);

        // Canal 3: Sala del chat (por si hay admins viendo)
        io.to(`chat_${receiverId}`).emit('new_message', message);

        // CORREGIDO: También notificar a otros admins que están viendo este chat
        notifyAdmins('new_message', {
          message,
          userId: receiverId,
          username: socket.username
        });

        // Confirmar al admin
        socket.emit('message_sent', message);

        logger.debug(`Message ${message.id} delivered: ${delivered ? 'YES (direct)' : 'NO (user offline, used rooms)'}`);

        // Push FCM para usuario offline: si no está conectado por socket, enviar push
        // de inmediato (no hay ack que esperar).
        if (!delivered) {
          _maybeSendPushFallback(receiverId, message);
        }
      }

      broadcastStats();
    } catch (error) {
      logger.error(`Error sending message via socket: ${error.message}`);
      if (error.name === 'ValidationError') {
        socket.emit('error', { message: 'Error de validación: ' + Object.values(error.errors).map(e => e.message).join(', ') });
      } else {
        socket.emit('error', { message: 'Error enviando mensaje: ' + error.message });
      }
    }
  });
  
  socket.on('typing', (data) => {
    if (!socket.userId) return; // SECURITY: Ignore events from unauthenticated sockets
    if (socket.role === 'user') {
      notifyAdmins('user_typing', {
        userId: socket.userId,
        username: socket.username,
        isTyping: data.isTyping
      });
    } else {
      const userSocket = connectedUsers.get(data.receiverId);
      if (userSocket) {
        userSocket.emit('admin_typing', {
          adminId: socket.userId,
          adminName: socket.username,
          isTyping: data.isTyping
        });
      }
    }
  });
  
  socket.on('stop_typing', (data) => {
    if (!socket.userId) return; // SECURITY: Ignore events from unauthenticated sockets
    if (socket.role === 'user') {
      notifyAdmins('user_stop_typing', {
        userId: socket.userId,
        username: socket.username
      });
    } else {
      const userSocket = connectedUsers.get(data.receiverId);
      if (userSocket) {
        userSocket.emit('admin_stop_typing', {
          adminId: socket.userId,
          adminName: socket.username
        });
      }
    }
  });
  
  socket.on('disconnect', () => {
    logger.debug(`Socket disconnected: ${socket.id}`);

    // Misma lista de roles que en authenticate: depositor/withdrawer/comunidad
    // también viven en connectedAdmins. Antes solo se limpiaba 'admin' → los
    // sockets muertos de los otros roles quedaban en el Map para siempre
    // (fuga de memoria + emits a sockets desconectados en broadcastStats).
    if (['admin', 'depositor', 'withdrawer', 'comunidad'].includes(socket.role)) {
      connectedAdmins.delete(socket.userId);
      broadcastStats();
    } else {
      connectedUsers.delete(socket.userId);
      notifyAdmins('user_disconnected', {
        userId: socket.userId,
        username: socket.username
      });
    }
  });
});

function notifyAdmins(event, data) {
  // Usar la sala de admins para notificaciones más eficientes
  io.to('admins').emit(event, data);
}

let _cachedStatsData = { totalUsers: 0, lastUpdate: 0 };

async function broadcastStats() {
  const now = Date.now();
  if (now - _cachedStatsData.lastUpdate > 60000) {
    try {
      _cachedStatsData.totalUsers = await User.countDocuments({ role: 'user' });
      _cachedStatsData.lastUpdate = now;
    } catch (err) {
      logger.error('Error actualizando stats cache:', err.message);
    }
  }
  const stats = {
    connectedUsers: connectedUsers.size,
    connectedAdmins: connectedAdmins.size,
    totalUsers: _cachedStatsData.totalUsers
  };
  connectedAdmins.forEach((socket) => {
    socket.emit('stats', stats);
  });
}

// Endpoint para enviar notificación (usado por admin)
app.post('/api/admin/send-notification', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId, title, body, icon, badge, tag, requireInteraction, data } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId requerido' });
    }

    // Localizar al usuario con sus tokens FCM (UUID 'id' o ObjectId '_id').
    let user = await User.findOne({ id: userId }).select('_id id username fcmToken fcmTokens');
    if (!user) {
      try {
        user = await User.findById(userId).select('_id id username fcmToken fcmTokens');
      } catch (_) {
        // userId con formato no válido para ObjectId — caer al 404
      }
    }
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const payloadTitle = title || 'Nueva notificación';
    const payloadBody  = body  || '';
    const payloadData = {
      ...(data || {}),
      icon: icon || '/icons/icon-192x192.png',
      badge: badge || '/icons/icon-72x72.png',
      tag: tag || 'default',
      requireInteraction: requireInteraction ? 'true' : 'false'
    };

    const isOnline = !!(connectedUsers && connectedUsers.has(user.id));

    // sendPushIfOffline emite 'admin_notification' por socket si el user está
    // online (que es el evento que el cliente escucha en index.html para mostrar
    // el banner in-app); si está offline envía push FCM real a todos sus tokens
    // y limpia automáticamente los inválidos.
    await sendPushIfOffline(user, payloadTitle, payloadBody, payloadData);

    console.log(`📱 Notificación enviada a ${user.username} (${isOnline ? 'socket' : 'FCM'}): ${payloadTitle}`);
    res.json({
      success: true,
      message: 'Notificación enviada',
      delivery: isOnline ? 'socket' : 'fcm'
    });
  } catch (error) {
    console.error('Error enviando notificación:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// RUTAS ESTÁTICAS
// ============================================
// NOTE: readFileSafe() is defined above, in the ADMIN PAGE SECURITY section.

// Dominio público canónico (el que ven los clientes). Se usa para generar
// los links de pauta en el admin y para cualquier referencia absoluta a la
// home. Default: vipcargas.com (configurable por env var).
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://vipcargas.com').replace(/\/$/, '');

// ── Cookie de campaña (pauta) ──────────────────────────────────────────────
// Cuando un visitante entra por una vanity URL de pauta (ej: /santinopauta) el
// server le setea esta cookie httpOnly. En cada carga posterior — la home, una
// recarga, o cualquier ruta SPA — el server lee la cookie y vuelve a inyectar
// el código de campaña en el HTML. Así la decisión "registro sin SMS" es
// determinística y server-side: NO depende de que la URL siga siendo
// /santinopauta (se limpia a / apenas carga) ni del localStorage del navegador,
// que las webviews de Meta/Instagram restringen de forma inconsistente — causa
// raíz de que a veces pidiera SMS y a veces no con la misma URL de anuncio.
const CAMPAIGN_COOKIE_NAME = 'vip_campaign';
const CAMPAIGN_COOKIE_MAX_AGE = 60 * 24 * 60 * 60; // 60 días (igual que la atribución del cliente)

function getCampaignCookie(req) {
  const cookieHeader = (req.headers && req.headers.cookie) || '';
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== CAMPAIGN_COOKIE_NAME) continue;
    let val = '';
    try { val = decodeURIComponent(part.slice(eq + 1).trim()); } catch (e) { return null; }
    return /^[A-Z0-9_-]{3,40}$/.test(val) ? val : null;
  }
  return null;
}

function buildCampaignCookieHeader(code) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${CAMPAIGN_COOKIE_NAME}=${encodeURIComponent(code)}; HttpOnly; SameSite=Lax; Max-Age=${CAMPAIGN_COOKIE_MAX_AGE}; Path=/${secure}`;
}

// Resuelve el código de campaña vigente para un request a partir de la cookie
// vip_campaign, validando que la campaña siga existiendo y activa.
// Devuelve el código (uppercase) o null. Nunca lanza.
async function resolveCampaignFromCookie(req) {
  const code = getCampaignCookie(req);
  if (!code) return null;
  try {
    const campaign = await Campaign.findOne({ code, isActive: true }).select('code').lean();
    return campaign ? campaign.code : null;
  } catch (err) {
    logger.warn(`[campaign-cookie] error validando cookie de campaña: ${err.message}`);
    return null;
  }
}

// Renderiza index.html reemplazando los placeholders del server (pixel id,
// base url pública, y opcionalmente un campaignCode capturado por vanity URL).
// El HTML con pixel/base-url ya reemplazados se precomputa UNA vez por proceso
// (242KB × 3 regex por page-view era trabajo síncrono repetido); por request
// solo se reemplaza el campaignCode, que es lo único variable.
let _indexHtmlBase = null;
function renderIndexHtml(extras = {}) {
  if (_indexHtmlBase === null) {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    const content = readFileCached(indexPath);
    if (!content) return null;
    const pixelId = (process.env.META_PIXEL_ID || '').trim();
    _indexHtmlBase = content
      .replace(/__META_PIXEL_ID_PLACEHOLDER__/g, pixelId)
      .replace(/__VIP_PUBLIC_BASE_URL_PLACEHOLDER__/g, PUBLIC_BASE_URL);
  }
  return _indexHtmlBase.replace(/__VIP_CAMPAIGN_CODE_PLACEHOLDER__/g, extras.campaignCode || '');
}

app.get('/', async (req, res) => {
  // Si el visitante ya pasó por una vanity URL de pauta, reinyectar el código
  // de campaña desde la cookie para que el flujo de registro sin SMS sea
  // determinístico aunque la URL ya sea / (limpiada) o esto sea una recarga.
  const campaignCode = await resolveCampaignFromCookie(req);
  const rendered = renderIndexHtml({ campaignCode: campaignCode || '' });
  if (!rendered) return res.status(500).send('Error loading page');
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if (campaignCode) res.setHeader('Set-Cookie', buildCampaignCookieHeader(campaignCode));
  res.send(rendered);
});

// NOTE: /adminprivado2026 routes are now registered early, BEFORE the
// express.static middleware, so they can enforce ADMIN_HOST and cookie
// checks before the file system is touched.  The old (unguarded) copies
// that lived here have been removed.

// ============================================
// INICIALIZAR DATOS DE PRUEBA
// ============================================

async function initializeData() {
  // Conectar a MongoDB
  const dbConnected = await connectDB();
  if (!dbConnected) {
    console.error('❌ No se pudo conectar a MongoDB');
    return;
  }

  // One-shot migration: clear stale mustChangePassword flag from admin accounts.
  // This fixes admins that were marked before the role-isolation fix (PR #286)
  // and would otherwise be permanently blocked by authMiddleware.
  try {
    const result = await User.updateMany(
      { role: { $in: ADMIN_ROLES }, mustChangePassword: true },
      { $set: { mustChangePassword: false } }
    );
    if (result.modifiedCount > 0) {
      logger.info(`[startup-migration] Cleared mustChangePassword flag from ${result.modifiedCount} admin accounts`);
    }
  } catch (e) {
    logger.error(`[startup-migration] Failed to clear admin mustChangePassword: ${e.message}`);
  }

  // One-shot migration (guardada con flag en Config para que corra UNA sola vez):
  // limpia el backlog de mustChangePassword que dejó la vieja lógica del default
  // "asd123". Removimos ese forzado, pero los usuarios que YA estaban marcados
  // (y posiblemente con sesión activa) seguirían bloqueados por authMiddleware
  // hasta re-loguear. Esto los destraba a todos de una.
  //
  // CLAVE: corre sólo una vez. Si corriera en cada arranque, borraría también
  // los resets MANUALES de admin (POST /reset-password) que setean el flag a
  // propósito — esos se siguen respetando porque el flag de migración impide
  // que esta limpieza vuelva a ejecutarse.
  try {
    const flag = await Config.findOne({ key: 'migration_clear_asd123_mustchange_done' }).lean();
    if (!flag || flag.value !== true) {
      const result = await User.updateMany(
        { mustChangePassword: true },
        { $set: { mustChangePassword: false } }
      );
      logger.info(`[startup-migration] mustChangePassword (default asd123): limpiadas ${result.modifiedCount} cuentas (one-shot)`);
      await Config.findOneAndUpdate(
        { key: 'migration_clear_asd123_mustchange_done' },
        { key: 'migration_clear_asd123_mustchange_done', value: true },
        { upsert: true }
      );
    }
  } catch (e) {
    logger.error(`[startup-migration] Falló limpieza one-shot de mustChangePassword: ${e.message}`);
  }

  // One-shot migration (guardada con flag): borra los ChatStatus vacíos que se
  // crearon junto con el usuario antes de este cambio. Condición DOBLE para ser
  // seguros:
  //   1) El usuario nunca ingresó (lastLogin null), Y
  //   2) No tiene NINGÚN mensaje asociado.
  // Las dos juntas evitan borrar conversaciones legítimas cuyos mensajes hayan
  // expirado por el TTL de 3 días (esos usuarios sí tienen lastLogin). Si un
  // usuario purgado ingresa más tarde, /api/messages/welcome recrea su ChatStatus.
  try {
    const flag = await Config.findOne({ key: 'migration_purge_empty_chatstatus_done' }).lean();
    if (!flag || flag.value !== true) {
      const neverLoggedIn = await User.find({ lastLogin: null }).select('id').lean();
      const candidateIds = neverLoggedIn.map(u => u.id).filter(Boolean);
      let deleted = 0;
      if (candidateIds.length > 0) {
        // De los candidatos, excluir a los que tengan al menos un mensaje.
        const sendersWithMsg = await Message.distinct('senderId', { senderId: { $in: candidateIds } });
        const receiversWithMsg = await Message.distinct('receiverId', { receiverId: { $in: candidateIds } });
        const hasMessages = new Set([...sendersWithMsg, ...receiversWithMsg]);
        const toDelete = candidateIds.filter(id => !hasMessages.has(id));
        if (toDelete.length > 0) {
          const result = await ChatStatus.deleteMany({ userId: { $in: toDelete } });
          deleted = result.deletedCount || 0;
        }
      }
      logger.info(`[startup-migration] ChatStatus vacíos borrados (sin ingresar + sin mensajes): ${deleted} (one-shot)`);
      await Config.findOneAndUpdate(
        { key: 'migration_purge_empty_chatstatus_done' },
        { key: 'migration_purge_empty_chatstatus_done', value: true },
        { upsert: true }
      );
    }
  } catch (e) {
    logger.error(`[startup-migration] Falló purga one-shot de ChatStatus vacíos: ${e.message}`);
  }

  // One-shot migration (guardada con flag): VENCE todos los PromoBonus activos
  // viejos. A pedido del owner (2026-06-21) se sacaron los bonos automáticos que
  // venían dando los motores de encuesta / estrategia por voto (50%/100%, vigencia
  // larga). Como TODOS los PromoBonus son automáticos (los bonos manuales del
  // agente van directo a JUGAYGANA, no por acá), limpiamos la pizarra: a partir de
  // ahora el único motor de bonos es Inactividad, ya capeado a 30% / 2h. Corre UNA
  // sola vez; los bonos NUEVOS (creados después) no se tocan.
  try {
    const flag = await Config.findOne({ key: 'migration_clear_old_promobonus_done' }).lean();
    if (!flag || flag.value !== true) {
      let cleared = 0;
      try {
        const PromoBonusModel = require('./src/models/PromoBonus');
        const r = await PromoBonusModel.updateMany(
          { status: 'active' },
          { $set: { status: 'expired' } }
        );
        cleared = (r && (r.modifiedCount != null ? r.modifiedCount : r.nModified)) || 0;
      } catch (e) {
        logger.error(`[startup-migration] No se pudieron vencer los PromoBonus viejos: ${e.message}`);
      }
      logger.info(`[startup-migration] PromoBonus viejos vencidos (one-shot): ${cleared}`);
      await Config.findOneAndUpdate(
        { key: 'migration_clear_old_promobonus_done' },
        { key: 'migration_clear_old_promobonus_done', value: true },
        { upsert: true }
      );
    }
  } catch (e) {
    logger.error(`[startup-migration] clear_old_promobonus: ${e.message}`);
  }

  // One-shot: limpiar el premio "100% en próxima carga" del Fueguito que quedó pendiente
  // (decisión owner 2026-06-24: el hito día 15 baja de 100% a 30%). Saca el flag a todos
  // los que lo tenían pendiente para que no se les aplique el 100% viejo. Corre UNA vez.
  try {
    const flag = await Config.findOne({ key: 'migration_clear_fire_nextload_done' }).lean();
    if (!flag || flag.value !== true) {
      let cleared = 0;
      try {
        const FireStreakModel = require('./src/models/FireStreak');
        const r = await FireStreakModel.updateMany(
          { pendingNextLoadBonus: true },
          { $set: { pendingNextLoadBonus: false } }
        );
        cleared = (r && (r.modifiedCount != null ? r.modifiedCount : r.nModified)) || 0;
      } catch (e) {
        logger.error(`[startup-migration] No se pudo limpiar pendingNextLoadBonus: ${e.message}`);
      }
      logger.info(`[startup-migration] Fueguito 100% próxima carga pendiente limpiados (one-shot): ${cleared}`);
      await Config.findOneAndUpdate(
        { key: 'migration_clear_fire_nextload_done' },
        { key: 'migration_clear_fire_nextload_done', value: true },
        { upsert: true }
      );
    }
  } catch (e) {
    logger.error(`[startup-migration] Falló limpieza one-shot de PromoBonus viejos: ${e.message}`);
  }

  // One-shot: matar los bonos-fantasma del 50/100% (decisión owner 2026-07-08: tope 30%
  // en todo lo automático). Vence los PromoBonus activos con percent > 30 y desactiva
  // las notificaciones programadas de tipo bono_50/bono_100 (plantillas eliminadas).
  // El flag se setea SOLO si todo salió bien; si algo falla, reintenta al próximo arranque.
  try {
    const flag = await Config.findOne({ key: 'migration_kill_bonus_50_100_done' }).lean();
    if (!flag || flag.value !== true) {
      const PromoBonusModel = require('./src/models/PromoBonus');
      const rBonus = await PromoBonusModel.updateMany(
        { status: 'active', percent: { $gt: 30 } },
        { $set: { status: 'expired' } }
      );
      let schedsOff = 0;
      try {
        const ScheduledNotifModel = require('./src/models/ScheduledNotif');
        const rSched = await ScheduledNotifModel.updateMany(
          { type: { $in: ['bono_50', 'bono_100'] }, enabled: true },
          { $set: { enabled: false, lastResult: 'Desactivada por migración: tipo eliminado (tope 30%)' } }
        );
        schedsOff = (rSched && (rSched.modifiedCount != null ? rSched.modifiedCount : rSched.nModified)) || 0;
      } catch (e2) {
        throw new Error('ScheduledNotif bono_50/100: ' + e2.message);
      }
      const bonusOff = (rBonus && (rBonus.modifiedCount != null ? rBonus.modifiedCount : rBonus.nModified)) || 0;
      logger.info(`[startup-migration] kill_bonus_50_100: PromoBonus >30% vencidos: ${bonusOff}; schedules bono_50/100 desactivados: ${schedsOff}`);
      await Config.findOneAndUpdate(
        { key: 'migration_kill_bonus_50_100_done' },
        { key: 'migration_kill_bonus_50_100_done', value: true },
        { upsert: true }
      );
    }
  } catch (e) {
    logger.error(`[startup-migration] kill_bonus_50_100 (reintenta al próximo arranque): ${e.message}`);
  }

  // One-shot (flag PROPIO, separado del anterior): clampear a 30 el % de bono de las
  // NotificationRule viejas en DB (el modelo permitía hasta 1000). Flag separado porque
  // la DB es compartida: si otra versión del server ya marcó kill_bonus_50_100 sin
  // incluir este clamp, igual tiene que correr acá.
  try {
    const flag = await Config.findOne({ key: 'migration_clamp_notifrule_percent_done' }).lean();
    if (!flag || flag.value !== true) {
      const NotificationRuleModel = require('./src/models/NotificationRule');
      const r = await NotificationRuleModel.updateMany(
        { 'chargeBonus.percent': { $gt: 30 } },
        { $set: { 'chargeBonus.percent': 30 } }
      );
      const clamped = (r && (r.modifiedCount != null ? r.modifiedCount : r.nModified)) || 0;
      logger.info(`[startup-migration] clamp_notifrule_percent: reglas clampeadas a 30%: ${clamped}`);
      await Config.findOneAndUpdate(
        { key: 'migration_clamp_notifrule_percent_done' },
        { key: 'migration_clamp_notifrule_percent_done', value: true },
        { upsert: true }
      );
    }
  } catch (e) {
    logger.error(`[startup-migration] clamp_notifrule_percent (reintenta al próximo arranque): ${e.message}`);
  }

  // One-shot (2026-07-28): rangos de reembolso + cupón install 100%. Actualiza los
  // comandos /sys_* que mencionaban el reembolso diario o el bono de $5.000:
  //  - Reemplazos por SUBSTRING (respetan ediciones del owner alrededor): la línea
  //    de reembolsos del /sys_welcome y la frase "Mañana podes revisar..." de
  //    /sys_deposit y /sys_deposit_bonus.
  //  - /sys_install_app: solo si sigue EXACTO al default viejo (si el owner lo
  //    editó, se respeta y hay que actualizarlo a mano desde COMANDOS).
  //  - Borra /sys_install_bonus (obsoleto: lo reemplaza /sys_install_bonus_100).
  // El flag se setea solo si todo salió bien; si falla, reintenta al próximo arranque.
  try {
    const flag = await Config.findOne({ key: 'migration_refund_tiers_install100_done' }).lean();
    if (!flag || flag.value !== true) {
      const OLD_WELCOME_LINE = '• Reembolso DIARIO del 20%\n• Reembolso SEMANAL del 10%\n• Reembolso MENSUAL del 5%';
      const NEW_WELCOME_LINE = '• Reembolso SEMANAL y MENSUAL según tu RANGO\n• 🥉 Bronce 3% · 🥈 Plata 5% · 🥇 Oro 10% de lo perdido';
      const OLD_DEPOSIT_LINE = '🔥 Mañana podes revisar si tenes reembolso para reclamar de forma automatica 🔥';
      const NEW_DEPOSIT_LINE = '🔥 Recorda: tenes reembolso SEMANAL (lunes y martes) y MENSUAL (desde el dia 7) segun tu rango 🥉🥈🥇 🔥';
      const OLD_INSTALL_APP_DEFAULT = '🎁━━━━━━━━━━━━━━━🎁\n📲 INSTALÁ LA APP\n   Y GANÁ $5.000 🎁\n🎁━━━━━━━━━━━━━━━🎁\n\n¿Todavía no instalaste la app? ¡Hacelo ahora y reclamá tu BONO DE $5.000! 🤑\n\n✅ Te avisamos al toque de tus bonos y reembolsos\n✅ Entrás más rápido y no perdés tu cuenta\n\n📲 Tocá "📱 Instalar App" o, en el menú del navegador, elegí "Agregar a pantalla de inicio".\n\n🎁 Una vez instalada, abrí la app y tocá el botón "🎁 Reclamar $5.000" que vas a ver arriba del chat. ¡El bono se acredita al instante!';
      const NEW_INSTALL_APP_DEFAULT = '🎁━━━━━━━━━━━━━━━🎁\n📲 INSTALÁ LA APP\n   Y GANÁ UN 100% 🎁\n🎁━━━━━━━━━━━━━━━🎁\n\n¿Todavía no instalaste la app? ¡Hacelo ahora y desbloqueá un BONO del 100% EXTRA en tu PRÓXIMA CARGA! 🤑\n\n✅ Te avisamos al toque de tus bonos y reembolsos\n✅ Entrás más rápido y no perdés tu cuenta\n\n📲 Tocá "📱 Instalar App" o, en el menú del navegador, elegí "Agregar a pantalla de inicio".\n\n🎁 Una vez instalada, abrí la app y tocá el botón "🎁 Reclamar mi 100%" que vas a ver arriba del chat. ¡Después avisale al cajero en tu próxima carga!';

      let updated = 0;
      const cmds = await Command.find({ name: { $in: ['/sys_welcome', '/sys_deposit', '/sys_deposit_bonus', '/sys_install_app'] } });
      for (const cmd of cmds) {
        const orig = String(cmd.response || '');
        let next = orig;
        if (cmd.name === '/sys_welcome' && next.includes(OLD_WELCOME_LINE)) {
          next = next.split(OLD_WELCOME_LINE).join(NEW_WELCOME_LINE);
        }
        if ((cmd.name === '/sys_deposit' || cmd.name === '/sys_deposit_bonus') && next.includes(OLD_DEPOSIT_LINE)) {
          next = next.split(OLD_DEPOSIT_LINE).join(NEW_DEPOSIT_LINE);
        }
        if (cmd.name === '/sys_install_app' && next === OLD_INSTALL_APP_DEFAULT) {
          next = NEW_INSTALL_APP_DEFAULT;
        }
        if (next !== orig) {
          await Command.updateOne({ _id: cmd._id }, { $set: { response: next } });
          updated++;
        }
      }
      const del = await Command.deleteOne({ name: '/sys_install_bonus' });

      // Desactivar las reglas push del reembolso DIARIO que ya estén en la DB
      // (B1/B2, sembradas antes de eliminar el diario). Hoy son inertes
      // (DailyPlayerStats no está portado), pero si algún día se porta ese
      // subsistema no deben revivir promocionando un reembolso que no existe.
      let rulesOff = 0;
      try {
        const NotificationRuleModel = require('./src/models/NotificationRule');
        const rRules = await NotificationRuleModel.updateMany(
          { audienceType: 'refund-pending-daily', enabled: true },
          { $set: { enabled: false } }
        );
        rulesOff = (rRules && (rRules.modifiedCount != null ? rRules.modifiedCount : rRules.nModified)) || 0;
      } catch (e2) {
        throw new Error('NotificationRule refund-pending-daily: ' + e2.message);
      }

      logger.info(`[startup-migration] refund_tiers_install100: comandos actualizados: ${updated}; /sys_install_bonus borrado: ${del.deletedCount || 0}; reglas push diarias desactivadas: ${rulesOff}`);
      await Config.findOneAndUpdate(
        { key: 'migration_refund_tiers_install100_done' },
        { key: 'migration_refund_tiers_install100_done', value: true },
        { upsert: true }
      );
    }
  } catch (e) {
    logger.error(`[startup-migration] refund_tiers_install100 (reintenta al próximo arranque): ${e.message}`);
  }

  // Backfill de usernameLower (camino rápido del login case-insensitive). Corre en
  // CADA arranque (idempotente; cuando no hay nada que rellenar es un no-op barato)
  // porque también repara usuarios creados por instancias con código viejo durante
  // un rolling deploy. Recién si terminó OK se habilita el modo rápido puro
  // (_usernameLowerReady); si falla, esta instancia sigue con el fallback por regex
  // (comportamiento histórico) — el login NUNCA se puede romper por esto.
  try {
    const UserModel = require('./src/models/User');
    const r = await UserModel.updateMany(
      { usernameLower: null },
      [{ $set: { usernameLower: { $toLower: '$username' } } }]
    );
    const filled = (r && (r.modifiedCount != null ? r.modifiedCount : r.nModified)) || 0;
    if (filled > 0) logger.info(`[startup] usernameLower backfill: ${filled} usuarios rellenados`);
    _usernameLowerReady = true;
  } catch (e) {
    logger.error(`[startup] usernameLower backfill falló (el login sigue con el fallback por regex): ${e.message}`);
  }

  // One-shot: backfill de phoneKey (clave normalizada) en los usuarios con teléfono YA
  // verificado, para que el chequeo de unicidad por phoneKey funcione contra los existentes.
  try {
    const flag = await Config.findOne({ key: 'migration_backfill_phonekey_done' }).lean();
    if (!flag || flag.value !== true) {
      let done = 0;
      try {
        const UserModel = require('./src/models/User');
        const users = await UserModel.find({
          phoneVerified: true, phone: { $nin: [null, ''] },
          $or: [{ phoneKey: null }, { phoneKey: { $exists: false } }]
        }).select('id phone').lean();
        const ops = [];
        for (const u of users) {
          const key = normalizePhoneKey(u.phone);
          if (key) ops.push({ updateOne: { filter: { id: u.id }, update: { $set: { phoneKey: key } } } });
        }
        if (ops.length) {
          const r = await UserModel.bulkWrite(ops, { ordered: false });
          done = (r && (r.modifiedCount != null ? r.modifiedCount : ops.length)) || ops.length;
        }
      } catch (e) {
        logger.error(`[startup-migration] backfill phoneKey: ${e.message}`);
      }
      logger.info(`[startup-migration] phoneKey backfill (one-shot): ${done}`);
      await Config.findOneAndUpdate(
        { key: 'migration_backfill_phonekey_done' },
        { key: 'migration_backfill_phonekey_done', value: true },
        { upsert: true }
      );
    }
  } catch (e) {
    logger.error(`[startup-migration] backfill phoneKey wrapper: ${e.message}`);
  }

  // One-shot V2: RE-calcular phoneKey de TODOS los verificados con la lógica nueva
  // (la v1 usaba "últimos 10" y no normalizaba el 0 de Paraguay ni el 9 de Argentina).
  try {
    const flag = await Config.findOne({ key: 'migration_backfill_phonekey_v2_done' }).lean();
    if (!flag || flag.value !== true) {
      let done = 0;
      try {
        const UserModel = require('./src/models/User');
        const users = await UserModel.find({ phoneVerified: true, phone: { $nin: [null, ''] } }).select('id phone phoneKey').lean();
        const ops = [];
        for (const u of users) {
          const key = normalizePhoneKey(u.phone);
          if (key && key !== u.phoneKey) ops.push({ updateOne: { filter: { id: u.id }, update: { $set: { phoneKey: key } } } });
        }
        if (ops.length) {
          const r = await UserModel.bulkWrite(ops, { ordered: false });
          done = (r && (r.modifiedCount != null ? r.modifiedCount : ops.length)) || ops.length;
        }
      } catch (e) {
        logger.error(`[startup-migration] backfill phoneKey v2: ${e.message}`);
      }
      logger.info(`[startup-migration] phoneKey backfill V2 (one-shot): ${done}`);
      await Config.findOneAndUpdate(
        { key: 'migration_backfill_phonekey_v2_done' },
        { key: 'migration_backfill_phonekey_v2_done', value: true },
        { upsert: true }
      );
    }
  } catch (e) {
    logger.error(`[startup-migration] backfill phoneKey v2 wrapper: ${e.message}`);
  }

  if (process.env.PROXY_URL) {
    console.log('🔍 Verificando IP pública...');
    await jugaygana.logProxyIP();
  }
  
  console.log('🔑 Probando conexión con JUGAYGANA...');
  const sessionOk = await jugaygana.ensureSession();
  if (sessionOk) {
    console.log('✅ Conexión con JUGAYGANA establecida');
  } else {
    console.log('⚠️ No se pudo conectar con JUGAYGANA');
  }
  
  // Verificar/crear admin principal
  // Usar variables de entorno para credenciales del admin.
  // ADMIN_USERNAME y ADMIN_PASSWORD deben configurarse en producción.
  const adminUsername = process.env.ADMIN_USERNAME;
  if (!adminUsername) {
    logger.warn('⚠️ ADMIN_USERNAME no configurado. El admin inicial no será creado/verificado automáticamente.');
  }
  const adminInitialPassword = process.env.ADMIN_PASSWORD;

  if (!adminInitialPassword) {
    logger.error('⛔ SEGURIDAD: ADMIN_PASSWORD no configurado en variables de entorno. El admin inicial NO será creado/actualizado automáticamente en producción. Configúralo antes de desplegar.');
  }

  if (adminUsername) {
  let adminExists = await User.findOne({ username: adminUsername });
  if (!adminExists) {
    if (!adminInitialPassword) {
      logger.warn('⚠️ No se creó el admin inicial porque ADMIN_PASSWORD no está configurado. Crealo manualmente vía API o configura la variable de entorno.');
    } else {
      const adminPassword = await bcrypt.hash(adminInitialPassword, 12);
      await User.create({
        id: uuidv4(),
        username: adminUsername,
        password: adminPassword,
        email: 'admin@saladejuegos.com',
        phone: null,
        role: 'admin',
        accountNumber: 'ADMIN001',
        balance: 0,
        createdAt: new Date(),
        lastLogin: null,
        isActive: true,
        jugayganaUserId: null,
        jugayganaUsername: null,
        jugayganaSyncStatus: 'not_applicable'
      });
      console.log(`✅ Admin creado: ${adminUsername}`);
    }
  } else {
    // Admin ya existe: solo asegurar que sigue activo y con el rol correcto.
    // NO se sobrescribe la contraseña para preservar cambios realizados en producción.
    let changed = false;
    if (adminExists.role !== 'admin') { adminExists.role = 'admin'; changed = true; }
    if (!adminExists.isActive) { adminExists.isActive = true; changed = true; }
    if (changed) await adminExists.save();
    console.log(`✅ Admin verificado: ${adminUsername}`);
  }
  } // end if (adminUsername)
  
  // Verificar/crear configuración CBU por defecto
  const cbuConfig = await getConfig('cbu');
  if (!cbuConfig) {
    await setConfig('cbu', {
      number: '0000000000000000000000',
      alias: 'mi.alias.cbu',
      bank: 'Banco Ejemplo',
      titular: 'Sala de Juegos'
    });
    console.log('✅ Configuración CBU por defecto creada');
  }

  // Verificar/crear comandos de sistema (mensajes automáticos editables desde COMANDOS)
  const systemCmds = [
    {
      name: '/sys_deposit',
      description: 'Mensaje automático al realizar un depósito sin bonus. Variables disponibles: ${amount}, ${balance}',
      type: 'message',
      response: '🔒💰 Depósito de ${amount} acreditado con éxito. ✅ \n💸 Tu nuevo saldo es ${balance} 💸\n\nPuedes verificarlo en: https://jugaygana.bet\n\n🔥 Recorda: tenes reembolso SEMANAL (lunes y martes) y MENSUAL (desde el dia 7) segun tu rango 🥉🥈🥇 🔥'
    },
    {
      name: '/sys_deposit_bonus',
      description: 'Mensaje automático al realizar un depósito con bonus. Variables disponibles: ${amount}, ${bonus}, ${balance}',
      type: 'message',
      response: '🔒💰 Depósito de ${amount} (incluye ${bonus} de bonificación) acreditado con éxito. ✅ \n💸 Tu nuevo saldo es ${balance} 💸\n\nPuedes verificarlo en: https://jugaygana.bet\n\n🔥 Recorda: tenes reembolso SEMANAL (lunes y martes) y MENSUAL (desde el dia 7) segun tu rango 🥉🥈🥇 🔥'
    },
    {
      name: '/sys_bonus',
      description: 'Mensaje automático al aplicar una bonificación. Variables disponibles: ${amount}, ${balance}',
      type: 'message',
      response: '🎁 ¡Bonificación de ${amount} acreditada en tu cuenta! ✅\n💸 Tu saldo actual es ${balance} 💸\n\nPuedes verificarlo en: https://www.jugaygana44.bet'
    },
    {
      name: '/sys_withdrawal',
      description: 'Mensaje automático al realizar un retiro. Variables disponibles: ${amount}, ${balance}',
      type: 'message',
      response: '🔒💸 Retiro de ${amount} realizado correctamente. \n💸 Tu nuevo saldo es ${balance} 💸\nSu pago se está procesando. Por favor, aguarde un momento.'
    },
    {
      name: '/sys_reminder',
      description: 'Mensaje recordatorio enviado después de cada depósito (sin variables de monto por defecto).',
      type: 'message',
      response: '🎮 ¡Recuerda!\nPara cargar o cobrar, ingresa a 🌐 www.vipcargas.com.\n🔥 ¡Ya tienes el acceso guardado, así que te queda más fácil y rápido cada vez que entres!  \n🕹️ ¡No olvides guardarla y mantenerla a mano!\n\nwww.vipcargas.com'
    },
    {
      name: '/sys_install_app',
      description: 'Mensaje "instalá la app" que se envía tras un depósito si el usuario no tiene la app instalada. Variables: ${amount}, ${balance}',
      type: 'message',
      response: '🎁━━━━━━━━━━━━━━━🎁\n📲 INSTALÁ LA APP\n   Y GANÁ UN 100% 🎁\n🎁━━━━━━━━━━━━━━━🎁\n\n¿Todavía no instalaste la app? ¡Hacelo ahora y desbloqueá un BONO del 100% EXTRA en tu PRÓXIMA CARGA! 🤑\n\n✅ Te avisamos al toque de tus bonos y reembolsos\n✅ Entrás más rápido y no perdés tu cuenta\n\n📲 Tocá "📱 Instalar App" o, en el menú del navegador, elegí "Agregar a pantalla de inicio".\n\n🎁 Una vez instalada, abrí la app y tocá el botón "🎁 Reclamar mi 100%" que vas a ver arriba del chat. ¡Después avisale al cajero en tu próxima carga!'
    },
    {
      name: '/sys_welcome',
      description: 'Mensaje de bienvenida que se envía cuando el usuario ingresa por primera vez (cada 24h). Variables: {username}, {cbu}',
      type: 'message',
      response: '🎉 ¡Bienvenido a la Sala de Juegos, {username}!\n\n🎁 Beneficios exclusivos:\n• Reembolso SEMANAL y MENSUAL según tu RANGO\n• 🥉 Bronce 3% · 🥈 Plata 5% · 🥇 Oro 10% de lo perdido\n• Fueguito diario con recompensas\n• Atención 24/7\n\n💬 Escribe aquí para hablar con un agente.\n\nLink de pagina: https://www.jugaygana44.bet/\n\nCBU activo: {cbu}'
    },
    {
      name: '/sys_cbu',
      description: 'Mensaje con los datos de transferencia (CBU) que se envía al solicitar el CBU. Variables: {bank}, {titular}, {cbu}, {alias}',
      type: 'message',
      response: '💳 *Datos para transferir:*\n\n🏦 Banco: {bank}\n👤 Titular: {titular}\n🔢 CBU: {cbu}\n📱 Alias: {alias}\n\n✅ Una vez realizada la transferencia, envianos el comprobante por aquí.'
    },
    {
      name: '/sys_withdrawal_request',
      description: 'Confirmación automática cuando el usuario pide un retiro autogestionado. Variables: ${amount}',
      type: 'message',
      response: '⏳ Recibimos tu solicitud de retiro de ${amount}.\nUn agente la está procesando y te confirma la transferencia en breve. ¡Gracias!'
    },
    {
      name: '/sys_install_bonus_100',
      description: 'Mensaje de felicitación cuando el usuario desbloquea el cupón 100% próxima carga por instalar la app. Variables: {username}',
      type: 'message',
      response: '🎁 ¡Felicitaciones {username}! Por instalar la app desbloqueaste un BONO del 100% EXTRA en tu PRÓXIMA CARGA. 🚀 Avisale al cajero cuando cargues para que te lo aplique. 🥳'
    },
    {
      name: '/sys_payout_paid',
      description: 'Mensaje automático "pago enviado" cuando un retiro se paga (pago automático por hgcash o "Pagar con otro banco"). Variables: ${amount}. Si lo dejás vacío, no se envía.',
      type: 'message',
      response: '💸✅ ¡Tu retiro de ${amount} fue enviado a tu cuenta! Puede tardar unos minutos en acreditarse.'
    },
    {
      name: '/sys_community',
      description: 'Mensaje automático al cliente cuando un agente deriva su chat a la sección Comunidad. Sin variables. Si lo dejás vacío, no se envía.',
      type: 'message',
      response: '🤝 Te derivamos a nuestro equipo de Comunidad. En breve te atendemos por aquí. ¡Gracias!'
    },
    {
      name: '/sys_recover_100',
      description: 'Oferta de "100% de recuperación" que se envía tras cada carga (manual o automática). NO se envía a clientes con la etiqueta "comunidad" o "no comunidad". Sin variables. Si lo dejás vacío, no se envía.',
      type: 'message',
      response: '🎁 ¿Querés reclamar el 100% de tu carga?\n\nSi jugaste y perdiste lo que cargaste, ¡podés recuperarlo! 💪\n\nPara reclamarlo: sumate a nuestra Comunidad y tené la app instalada. ✅\n\n¡Te esperamos! 🚀'
    },
    {
      name: '/sys_withdrawal_insufficient',
      description: 'Mensaje automático al cliente cuando, al confirmar el pago, NO alcanza el saldo para descontar el retiro (se jugó las fichas en el mientras). El chat se cierra. Variables: ${amount} (lo que pidió), ${balance} (saldo actual). Si lo dejás vacío, no se envía.',
      type: 'message',
      response: '⚠️ No pudimos completar tu retiro de ${amount} porque tu saldo cambió y ya no alcanza. Tu saldo actual es ${balance}. 💡 Si querés retirar, solicitá un nuevo retiro con el monto correcto disponible. ¡Gracias!'
    }
  ];
  for (const cmd of systemCmds) {
    await Command.findOneAndUpdate(
      { name: cmd.name },
      {
        $set: { isSystem: true },
        $setOnInsert: {
          name: cmd.name,
          description: cmd.description,
          type: cmd.type,
          response: cmd.response,
          isActive: true,
          usageCount: 0
        }
      },
      { upsert: true }
    );
  }
  console.log('✅ Comandos de sistema verificados');

  console.log('✅ Datos inicializados correctamente');
}

// ============================================
// ENDPOINTS DE MOVIMIENTOS (DEPÓSITOS/RETIROS)
// ============================================

app.post('/api/movements/deposit', authMiddleware, depositorMiddleware, async (req, res) => {
  try {
    const amount = Number(req.body && req.body.amount);
    const username = req.user.username;

    if (!Number.isFinite(amount) || amount < 100) {
      return res.status(400).json({ error: 'Monto mínimo $100' });
    }
    
    const result = await jugaygana.depositToUser(
      username,
      amount,
      `Depósito desde Sala de Juegos - ${new Date().toLocaleString('es-AR')}`
    );

    if (result.success) {
      await recordUserActivity(req.user.userId, 'deposit', amount);

      // Meta CAPI — Purchase (depósito self-service desde la app del usuario).
      try {
        const u = await User.findOne({ id: req.user.userId }).lean();
        const selfServiceOrderId = result.data?.transfer_id || result.data?.transferId || null;
        metaCapi.track(
          'Purchase',
          { email: u && u.email, phone: u && u.phone, externalId: req.user.userId, fbc: u && u.metaFbc, fbp: u && u.metaFbp },
          {
            value: parseFloat(amount),
            currency: 'ARS',
            content_name: 'deposit_self_service',
            content_type: 'product',
            content_category: metaCapi.valueCategory(parseFloat(amount)),
            order_id: selfServiceOrderId
          },
          { eventId: req.body && req.body.metaEventId, req }
        );
        // Webhook a fb-ads: conversión Purchase para aprendizaje por anuncio.
        fbAdsWebhook.notify('Purchase', u, { value: parseFloat(amount), currency: 'ARS' });
      } catch (e) { /* tracking nunca bloquea */ }

      res.json({
        success: true,
        message: `Depósito de $${amount} realizado correctamente`,
        newBalance: result.data?.user_balance_after,
        transactionId: result.data?.transfer_id || result.data?.transferId
      });
    } else {
      res.status(400).json({ error: result.error || 'Error al realizar depósito' });
    }
  } catch (error) {
    console.error('Error en depósito:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/movements/withdraw', authMiddleware, async (req, res) => {
  let withdrawLockAcquired = false;
  try {
    const username = req.user.username;

    // Castear el monto: sin esto, un valor no numérico llegaba crudo a la
    // API de retiro. Se exige número finito y mínimo $100.
    const amountNum = Number(req.body && req.body.amount);
    if (!amountNum || !isFinite(amountNum) || amountNum < 4999) {
      return res.status(400).json({ error: 'El monto mínimo de retiro es $4.999' });
    }

    // Si el usuario se registró por flujo rápido (sin OTP), exigir verificación
    // de teléfono antes de permitir el primer retiro. El frontend debe abrir el
    // modal de verify-phone cuando recibe este code.
    const userForCheck = await User.findOne({ id: req.user.userId }).lean();
    if (userForCheck && userForCheck.phoneVerificationPending === true) {
      return res.status(403).json({
        error: 'Para retirar primero tenés que verificar un número de teléfono.',
        code: 'PHONE_VERIFICATION_REQUIRED'
      });
    }

    // Lock anti-doble-retiro: serializa los retiros concurrentes del mismo
    // usuario. Se libera en el finally del handler.
    if (!await acquireRefundLock(req.user.userId, 'withdraw')) {
      return res.status(429).json({ error: 'Ya tenés un retiro en proceso. Esperá unos segundos.' });
    }
    withdrawLockAcquired = true;

    const result = await jugaygana.withdrawFromUser(
      username,
      amountNum,
      `Retiro desde Sala de Juegos - ${new Date().toLocaleString('es-AR')}`
    );

    if (result.success) {
      await recordUserActivity(req.user.userId, 'withdrawal', amountNum);

      // Meta CAPI — WithdrawRequest (custom). Señal de usuario activo / ganador.
      try {
        const u = await User.findOne({ id: req.user.userId }).lean();
        metaCapi.track(
          'WithdrawRequest',
          { email: u && u.email, phone: u && u.phone, externalId: req.user.userId, fbc: u && u.metaFbc, fbp: u && u.metaFbp },
          { value: amountNum, currency: 'ARS', content_name: 'withdraw_self_service' },
          { eventId: req.body && req.body.metaEventId, req }
        );
      } catch (e) { /* tracking nunca bloquea */ }

      res.json({
        success: true,
        message: `Retiro de $${amountNum} realizado correctamente`,
        newBalance: result.data?.user_balance_after,
        transactionId: result.data?.transfer_id || result.data?.transferId
      });
    } else {
      res.status(400).json({ error: result.error || 'Error al realizar retiro' });
    }
  } catch (error) {
    console.error('Error en retiro:', error);
    res.status(500).json({ error: 'Error del servidor' });
  } finally {
    if (withdrawLockAcquired) releaseRefundLock(req.user.userId, 'withdraw');
  }
});

app.get('/api/movements/balance', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    const result = await jugayganaMovements.getUserBalance(username);

    if (result.success) {
      res.json({ balance: result.balance });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// RETIRO AUTOGESTIONADO POR EL USUARIO
// ============================================

// Devuelve los datos bancarios guardados del usuario (para autocompletar el
// modal de retiro) junto con el estado de verificación de su teléfono.
app.get('/api/withdrawal/account', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ id: req.user.userId }).lean();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const acc = user.withdrawalAccount || {};
    res.json({
      account: {
        titular: acc.titular || '',
        cbu: acc.cbu || '',
        alias: acc.alias || '',
        savedAt: acc.savedAt || null
      },
      phoneVerified: user.phoneVerified === true,
      phone: user.phone || user.whatsapp || null
    });
  } catch (error) {
    logger.error(`Error en withdrawal/account: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Solicitud de retiro autogestionada. Requiere teléfono verificado por SMS.
// Verifica el saldo real en JugaYGana, ejecuta el retiro, guarda los datos
// bancarios (opcional) y manda un mensaje automático al chat para que el agente
// procese la transferencia bancaria.
app.post('/api/withdrawal/request', authMiddleware, async (req, res) => {
  let withdrawLockAcquired = false;
  try {
    const { titular, cbu, alias, amount, saveData } = req.body || {};
    const username = req.user.username;

    const amountNum = Number(amount);
    if (!amountNum || amountNum < 4999) {
      return res.status(400).json({ error: 'El monto mínimo de retiro es $4.999' });
    }

    const titularT = (typeof titular === 'string' ? titular : '').trim();
    const cbuT = (typeof cbu === 'string' ? cbu : '').trim();
    const aliasT = (typeof alias === 'string' ? alias : '').trim();
    if (!titularT || !cbuT || !aliasT) {
      return res.status(400).json({ error: 'Completá titular, CVU/CBU y alias' });
    }

    const user = await User.findOne({ id: req.user.userId });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Para retirar, la cuenta debe tener el teléfono verificado por SMS.
    // El registro es sin SMS, pero el retiro siempre exige verificación.
    if (user.phoneVerified !== true) {
      return res.status(400).json({
        error: 'Para retirar tu premio necesitás verificar tu teléfono por SMS.',
        code: 'PHONE_VERIFICATION_REQUIRED'
      });
    }

    // Lock anti-doble-retiro: serializa los retiros concurrentes del mismo
    // usuario para que dos requests no pasen ambos el chequeo de saldo y
    // ejecuten un retiro doble. Se libera en el finally del handler.
    if (!await acquireRefundLock(req.user.userId, 'withdraw')) {
      return res.status(429).json({ error: 'Ya tenés un retiro en proceso. Esperá unos segundos.' });
    }
    withdrawLockAcquired = true;

    // Chequear saldo real en JugaYGana (sólo validación de UX al solicitar: el cliente
    // no puede pedir más de lo que tiene EN ESTE MOMENTO). El DESCUENTO REAL de las
    // fichas ocurre recién cuando el AGENTE confirma el pago (/api/admin/payouts/:id/pay),
    // NO acá. Así, si el cliente se juega las fichas en el mientras, al confirmar el
    // descuento falla y no se paga — y al rechazar no hay que devolver nada.
    // CON retry (2 intentos): JUGAYGANA es flaky y a veces el lookup de saldo tarda/falla;
    // el reintento entra la mayoría de las veces. Cada intento ya falla rápido (timeout 12s).
    const balanceResult = await jugayganaMovements.getUserBalanceWithRetry(username, { maxAttempts: 2, baseDelayMs: 400 });
    if (!balanceResult.success) {
      return res.status(503).json({
        error: 'La plataforma está demorada en este momento. Esperá unos segundos y volvé a intentar el retiro.',
        code: 'PLATFORM_SLOW'
      });
    }
    const available = Number(balanceResult.balance) || 0;
    if (available < amountNum) {
      return res.status(400).json({
        error: available <= 0
          ? 'No tenés saldo disponible para retirar.'
          : `Saldo insuficiente. Tu saldo disponible es $${available.toLocaleString('es-AR')}.`,
        code: 'INSUFFICIENT_BALANCE',
        balance: available
      });
    }

    // Dedup anti-doble-solicitud: si ya hay un retiro pendiente del MISMO monto creado
    // hace pocos minutos, NO creamos otro (evita duplicados si el cliente reintenta por
    // un error de red/timeout). Devolvemos éxito idempotente.
    const recentDup = await PendingPayout.findOne({
      userId: user.id, amount: amountNum, status: 'pending_review',
      createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) }
    }).lean();
    if (recentDup) {
      return res.json({
        success: true, duplicate: true,
        message: `Ya recibimos tu solicitud de retiro de $${amountNum.toLocaleString('es-AR')}. Un agente la está procesando.`
      });
    }

    // Crear el "pago pendiente" SIN descontar fichas (deductAtPay:true). El agente lo
    // verifica y, al CONFIRMAR el pago, recién ahí se descuentan las fichas (con
    // verificación anti-fantasma) y, si el descuento sale OK, se paga automático por
    // hgcash. El saldo del cliente NO baja todavía.
    try {
      await PendingPayout.create({
        id: uuidv4(), userId: user.id, username: user.username,
        amount: amountNum, titular: titularT, cbu: cbuT, alias: aliasT,
        status: 'pending_review',
        deductAtPay: true,         // ← flujo nuevo: descontar al confirmar, no al solicitar
        balanceBefore: available,  // saldo al solicitar (referencia para el agente)
        createdAt: new Date()
      });
    } catch (ppErr) {
      logger.warn(`[withdrawal/request] no se pudo crear PendingPayout para ${user.username}: ${ppErr.message}`);
    }

    // Guardar datos bancarios para la próxima vez (si el usuario lo pidió).
    if (saveData) {
      user.withdrawalAccount = { titular: titularT, cbu: cbuT, alias: aliasT, savedAt: new Date() };
      await user.save();
    }

    const amountFmt = '$' + amountNum.toLocaleString('es-AR');

    // 1. Mensaje del usuario hacia el agente con los datos del retiro.
    const withdrawMsg = await Message.create({
      id: uuidv4(),
      senderId: req.user.userId,
      senderUsername: req.user.username,
      senderRole: 'user',
      receiverId: 'admin',
      receiverRole: 'admin',
      content:
        `💸 *SOLICITUD DE RETIRO*\n\n` +
        `👤 Titular: ${titularT}\n` +
        `🔢 CVU/CBU: ${cbuT}\n` +
        `📱 Alias: ${aliasT}\n` +
        `💵 Monto: ${amountFmt}`,
      type: 'text',
      timestamp: new Date(),
      read: false
    });

    // 2. Confirmación automática del sistema hacia el usuario (editable /sys_withdrawal_request).
    // El template usa "${amount}" y reemplazamos {amount} por el monto ya
    // formateado con separador de miles, SIN el signo $ (el $ va en el template).
    const withdrawConfirmContent = await renderSystemCommand(
      '/sys_withdrawal_request',
      '⏳ Recibimos tu solicitud de retiro de ${amount}.\nUn agente la está procesando y te confirma la transferencia en breve. ¡Gracias!',
      { amount: amountNum.toLocaleString('es-AR') }
    );
    // null = /sys_withdrawal_request vaciado a propósito → no se manda la confirmación.
    const withdrawConfirmMsg = withdrawConfirmContent ? await Message.create({
      id: uuidv4(),
      senderId: 'system',
      senderUsername: 'Sistema',
      senderRole: 'admin',
      receiverId: req.user.userId,
      receiverRole: 'user',
      content: withdrawConfirmContent,
      type: 'text',
      timestamp: new Date(),
      read: false
    }) : null;

    // 3. Mover el chat a "Pagos" automáticamente: el retiro lo gestiona el área
    //    de pagos. Antes el ChatStatus no se tocaba, así que si el chat estaba
    //    cerrado (o sin abrir) la solicitud de retiro podía pasar desapercibida.
    try {
      await ChatStatus.findOneAndUpdate(
        { userId: req.user.userId },
        {
          userId: req.user.userId,
          username: req.user.username,
          status: 'payments',
          category: 'payments',
          assignedTo: null,
          closedAt: null,
          closedBy: null,
          lastMessageAt: new Date()
        },
        { upsert: true, setDefaultsOnInsert: true }
      );
      // Avisar a los paneles admin para que muevan el chat a Pagos en vivo.
      notifyAdmins('chat_moved', { userId: req.user.userId, to: 'payments', by: 'sistema' });
      // Entregar los mensajes en tiempo real (al panel admin y al usuario).
      io.to('admins').emit('new_message', { message: withdrawMsg, userId: req.user.userId, username: req.user.username });
      io.to(`chat_${req.user.userId}`).emit('new_message', withdrawMsg);
      io.to(`user_${req.user.userId}`).emit('new_message', withdrawMsg);
      if (withdrawConfirmMsg) {
        io.to('admins').emit('new_message', { message: withdrawConfirmMsg, userId: req.user.userId, username: req.user.username });
        io.to(`chat_${req.user.userId}`).emit('new_message', withdrawConfirmMsg);
        io.to(`user_${req.user.userId}`).emit('new_message', withdrawConfirmMsg);
      }
    } catch (chatErr) {
      logger.error(`[withdrawal/request] No se pudo mover el chat a pagos: ${chatErr.message}`);
    }

    // Meta CAPI — WithdrawRequest (señal de usuario activo / ganador).
    try {
      metaCapi.track(
        'WithdrawRequest',
        { email: user.email, phone: user.phone, externalId: req.user.userId, fbc: user.metaFbc, fbp: user.metaFbp },
        { value: amountNum, currency: 'ARS', content_name: 'withdraw_self_service' },
        { eventId: req.body && req.body.metaEventId, req }
      );
    } catch (e) { /* tracking nunca bloquea la respuesta */ }

    // FIX (regresión #68): antes esta respuesta referenciaba `result.data` (el viejo
    // withdrawFromUser que se eliminó al pasar a descontar-al-confirmar). Como `result`
    // ya no existe, tiraba ReferenceError → 500 "Error del servidor" DESPUÉS de haber
    // creado el PendingPayout y mandado el mensaje → el cliente reintentaba y duplicaba.
    res.json({
      success: true,
      message: `Retiro de ${amountFmt} solicitado correctamente`
    });
  } catch (error) {
    logger.error(`Error en withdrawal/request: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  } finally {
    if (withdrawLockAcquired) releaseRefundLock(req.user.userId, 'withdraw');
  }
});

// ============================================
// BONO POR INSTALAR LA APP (one-time)
// ============================================
// Desde 2026-07-28 el bono por instalar YA NO acredita $5.000: desbloquea un
// CUPÓN de 100% EXTRA en la PRÓXIMA CARGA (installBonus100Pending). El cupón lo
// aplica el AGENTE a mano en la carga (botón +100% del modal de depósito) y lo
// marca como usado desde el banner del chat (endpoint install-bonus-100/apply).
// INSTALL_BONUS_AMOUNT queda solo para los reportes de los reclamos LEGACY.
const INSTALL_BONUS_AMOUNT = 5000;

// Estado del bono: si ya lo reclamó y si tiene el cupón 100% pendiente de usar.
app.get('/api/install-bonus/status', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ id: req.user.userId }).lean();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({
      claimed: user.installBonusClaimed === true,
      pending: user.installBonus100Pending === true,
      bonusType: 'next_load_100',
      // Campo legacy: PWAs viejas cacheadas lo leen para armar su copy de $5.000.
      amount: INSTALL_BONUS_AMOUNT
    });
  } catch (error) {
    logger.error(`Error en install-bonus/status: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Reclamo del bono. Solo desde la app instalada (standalone) y una vez por cuenta.
app.post('/api/install-bonus/claim', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ id: req.user.userId });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Validación server-side de "app instalada": exige un token FCM en
    // contexto standalone. El flag req.body.standalone era falsificable
    // (un curl con {"standalone":true} cobraba el bono sin instalar nada).
    if (!_rouletteHasAppInstalled(user)) {
      return res.status(400).json({
        error: 'El bono se reclama desde la app instalada con notificaciones activadas.',
        code: 'NOT_STANDALONE'
      });
    }

    if (user.installBonusClaimed === true) {
      return res.status(400).json({
        error: 'Ya reclamaste el bono por instalar la app.',
        code: 'ALREADY_CLAIMED'
      });
    }

    // Teléfono verificado por SMS: requisito anti-multi-cuenta. Sin esto, un
    // mismo número podía abrir varias cuentas y cobrar el bono en cada una.
    if (user.phoneVerified !== true) {
      return res.status(400).json({
        error: 'Para reclamar el bono necesitás tener tu teléfono verificado por SMS. Verificalo y volvé a tocar "Reclamar".',
        code: 'PHONE_VERIFICATION_REQUIRED'
      });
    }

    // Anti-multicuenta por dispositivo: si alguno de los tokens FCM de este
    // usuario ya está registrado en OTRO usuario que YA reclamó el bono, este
    // bono no se acredita. Bloquea el patrón "mismo celular → cuenta nueva →
    // cobrar bono otra vez" en los casos donde Firebase reutiliza el token.
    const userTokens = [];
    if (user.fcmToken) userTokens.push(user.fcmToken);
    if (Array.isArray(user.fcmTokens)) {
      for (const t of user.fcmTokens) {
        if (t && t.token && !userTokens.includes(t.token)) userTokens.push(t.token);
      }
    }
    if (userTokens.length > 0) {
      const deviceConflict = await User.findOne({
        id: { $ne: req.user.userId },
        installBonusClaimed: true,
        $or: [
          { fcmToken: { $in: userTokens } },
          { 'fcmTokens.token': { $in: userTokens } }
        ]
      }).select('username id installBonusClaimedAt').lean();
      if (deviceConflict) {
        logger.warn(`[install-bonus] DEVICE_ALREADY_CLAIMED bloqueado: user=${user.username} conflictWith=${deviceConflict.username} claimedAt=${deviceConflict.installBonusClaimedAt}`);
        return res.status(400).json({
          error: 'Este dispositivo ya recibió el bono de instalación en otra cuenta.',
          code: 'DEVICE_ALREADY_CLAIMED'
        });
      }
    }

    // Reserva atómica del bono: setea el flag SOLO si todavía no fue
    // reclamado. Si otro request concurrente ganó la carrera, éste recibe
    // null y aborta. En la MISMA operación atómica queda otorgado el cupón
    // 100% próxima carga (no hay plata que acreditar acá, así que no hace
    // falta rollback: la reserva ES el otorgamiento).
    const reserved = await User.findOneAndUpdate(
      { id: req.user.userId, installBonusClaimed: { $ne: true } },
      { $set: {
        installBonusClaimed: true,
        installBonusClaimedAt: new Date(),
        installBonus100Pending: true,
        installBonus100GrantedAt: new Date()
      } }
    );
    if (!reserved) {
      return res.status(400).json({
        error: 'Ya reclamaste el bono por instalar la app.',
        code: 'ALREADY_CLAIMED'
      });
    }

    // Mensaje de confirmación en el chat (editable desde COMANDOS
    // /sys_install_bonus_100 — comando NUEVO: el viejo /sys_install_bonus
    // hablaba de los $5.000 acreditados y quedó obsoleto).
    const installBonusContent = await renderSystemCommand(
      '/sys_install_bonus_100',
      '🎁 ¡Felicitaciones {username}! Por instalar la app desbloqueaste un BONO del 100% EXTRA en tu PRÓXIMA CARGA. 🚀 Avisale al cajero cuando cargues para que te lo aplique. 🥳',
      { username: user.username }
    );
    if (installBonusContent) await Message.create({ // null = comando vaciado → no enviar
      id: uuidv4(),
      senderId: 'system',
      senderUsername: 'Sistema',
      senderRole: 'admin',
      receiverId: user.id,
      receiverRole: 'user',
      content: installBonusContent,
      type: 'system',
      timestamp: new Date(),
      read: false
    });

    res.json({
      success: true,
      message: '¡Desbloqueaste un 100% EXTRA en tu próxima carga! 🎁',
      bonusType: 'next_load_100',
      pending: true
    });
  } catch (error) {
    logger.error(`Error en install-bonus/claim: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Marca el cupón 100% próxima carga como USADO (lo toca el agente desde el
// banner del chat cuando aplicó el +100% en la carga). Mismo molde que
// fire-next-load-bonus/apply: update atómico con guard del flag — dos clicks
// concurrentes no lo "usan" dos veces.
app.post('/api/admin/users/:userId/install-bonus-100/apply', authMiddleware, depositorMiddleware, async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const result = await User.updateOne(
      { id: userId, installBonus100Pending: true },
      { $set: {
        installBonus100Pending: false,
        installBonus100UsedAt: new Date(),
        installBonus100UsedBy: req.user.username || null
      } }
    );
    if (!result.matchedCount) {
      return res.status(400).json({ error: 'Este usuario no tiene el bono 100% de instalación pendiente.' });
    }
    logger.info(`[install-bonus-100] marcado como usado por ${req.user.username} para user=${userId}`);
    res.json({ success: true });
  } catch (error) {
    logger.error(`Error en install-bonus-100/apply: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// PLAN DE NOTIFICACIONES (encuesta inicial)
// ============================================
// Guarda el plan de notificaciones elegido por el usuario en la encuesta.
app.post('/api/notification-plan', authMiddleware, async (req, res) => {
  try {
    const VALID_PLANS = ['suave', 'normal', 'activo', 'solo_reembolsos'];
    const plan = req.body && req.body.plan;
    if (!VALID_PLANS.includes(plan)) {
      return res.status(400).json({ error: 'Plan de notificaciones inválido' });
    }
    const user = await User.findOne({ id: req.user.userId });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    user.notificationPlan = plan;
    await user.save();

    // Historial de votos: guarda cada voto con su fecha para poder
    // analizar después qué fue eligiendo la gente.
    try {
      await EncuestaVote.create({
        username: String(user.username || '').toLowerCase(),
        plan: plan,
        votedAt: new Date()
      });
    } catch (voteErr) {
      logger.warn(`[encuesta] no se pudo registrar el voto: ${voteErr.message}`);
    }

    // Inscribir en la estrategia de bonos por encuesta. solo_reembolsos no
    // entra. La inscripción guarda CUÁNDO votó — el reloj de la estrategia.
    if (plan !== 'solo_reembolsos') {
      try {
        await StrategyEnrollment.updateOne(
          { username: String(user.username || '').toLowerCase() },
          {
            $set: { plan, userId: user.id },
            $setOnInsert: { id: uuidv4(), enrolledAt: new Date(), step: 0 }
          },
          { upsert: true }
        );
      } catch (enrErr) {
        logger.warn(`[bonus-strategy] inscripción falló para ${user.username}: ${enrErr.message}`);
      }
    }

    logger.info(`Usuario ${user.username} eligió plan de notificaciones: ${plan}`);
    res.json({ success: true, notificationPlan: plan });
  } catch (error) {
    logger.error(`Error en notification-plan: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// SISTEMA DE FUEGUITO (RACHA DIARIA)
// ============================================

// Helper: obtener total de depósitos del usuario en los últimos N días
const getDepositsInPeriod = async (username, daysBack) => {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  try {
    const result = await Transaction.aggregate([
      { $match: { username, type: 'deposit', createdAt: { $gte: since } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    return result[0]?.total || 0;
  } catch (err) {
    logger.error(`Error calculando depósitos de ${username}: ${err.message}`);
    return 0;
  }
};

// Mínimo de depósitos mensuales para acceder al Fueguito diario
// Hitos/milestones del Fueguito (DEFAULTS). Editables desde el panel → Config['fireMilestones'].
// requireDeposits > 0 marca que la RECOMPENSA (no el reclamo diario) requiere actividad del mes.
const FIRE_MILESTONES_DEFAULT = [
  { day: 10, reward: 10000,  type: 'cash', requireDeposits: 20000,  depositDays: 30, desc: 'Recompensa Fueguito 10 días' },
  { day: 20, reward: 50000,  type: 'cash', requireDeposits: 100000, depositDays: 30, desc: 'Recompensa Fueguito 20 días' },
  { day: 30, reward: 200000, type: 'cash', requireDeposits: 300000, depositDays: 45, desc: 'Recompensa Fueguito 30 días' }
];

// Lee los premios del fueguito desde Config (editables en el panel); si no hay config
// válida, usa los defaults. Normaliza/clampea y ordena por día. Todos los premios son
// EFECTIVO (type:'cash'). Devuelve [] nunca: siempre al menos los defaults.
async function getFireMilestones() {
  try {
    const cfg = await getConfig('fireMilestones', null);
    if (Array.isArray(cfg) && cfg.length) {
      const seen = new Set();
      const out = cfg.map(m => ({
        day: Math.max(1, Math.min(365, parseInt(m.day, 10) || 0)),
        reward: Math.max(0, Math.round(Number(m.reward) || 0)),
        type: 'cash',
        requireDeposits: Math.max(0, Math.round(Number(m.requireDeposits) || 0)),
        depositDays: Math.max(1, Math.min(365, parseInt(m.depositDays, 10) || 30)),
        desc: String(m.desc || '').slice(0, 80) || ('Recompensa Fueguito ' + (parseInt(m.day, 10) || '') + ' días')
      }))
      .filter(m => m.day > 0 && m.reward > 0)
      .sort((a, b) => a.day - b.day)
      .filter(m => { if (seen.has(m.day)) return false; seen.add(m.day); return true; });
      if (out.length) return out;
    }
  } catch (_) {}
  return FIRE_MILESTONES_DEFAULT;
}

app.get('/api/fire/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    let fireStreak = await FireStreak.findOne({ userId }).lean();
    
    if (!fireStreak) {
      fireStreak = { streak: 0, lastClaim: null, totalClaimed: 0 };
    }
    
    const todayArgentina = getArgentinaDateString();
    const lastClaim = fireStreak.lastClaim ? getArgentinaDateString(new Date(fireStreak.lastClaim)) : null;
    
    const canClaim = lastClaim !== todayArgentina;
    
    const yesterdayArgentina = getArgentinaYesterday();
    
    if (lastClaim !== yesterdayArgentina && lastClaim !== todayArgentina && fireStreak.streak > 0) {
      await FireStreak.updateOne(
        { userId },
        { streak: 0, lastReset: new Date() },
        { upsert: true }
      );
      fireStreak.streak = 0;
    }

    const currentStreak = fireStreak.streak || 0;

    // Auto-expirar recompensa pendiente si no fue reclamada el mismo día (req 1)
    let pendingCashReward = fireStreak.pendingCashReward || 0;
    let pendingCashRewardDay = fireStreak.pendingCashRewardDay || 0;
    let pendingCashRewardDesc = fireStreak.pendingCashRewardDesc || '';
    if (pendingCashReward > 0) {
      const rewardDate = fireStreak.pendingCashRewardDate || '';
      if (rewardDate !== todayArgentina) {
        // La recompensa expiró — limpiarla silenciosamente
        await FireStreak.updateOne(
          { userId },
          { pendingCashReward: 0, pendingCashRewardDay: 0, pendingCashRewardDesc: '', pendingCashRewardDate: '' }
        );
        pendingCashReward = 0;
        pendingCashRewardDay = 0;
        pendingCashRewardDesc = '';
      }
    }

    // Construir lista de milestones con estado para la UI (premios editables desde el panel)
    const FIRE_MILESTONES = await getFireMilestones();
    const milestones = FIRE_MILESTONES.map(m => {
      let status;
      if (currentStreak >= m.day) {
        status = 'completed';
      } else if (currentStreak === m.day - 1) {
        status = 'next';
      } else {
        status = 'locked';
      }
      return {
        day: m.day,
        type: m.type,
        reward: m.type === 'cash' ? m.reward : null,
        hasDepositRequirement: m.requireDeposits > 0,
        status
      };
    });
    
    res.json({
      streak: currentStreak,
      lastClaim: fireStreak.lastClaim,
      totalClaimed: fireStreak.totalClaimed || 0,
      canClaim,
      pendingNextLoadBonus: fireStreak.pendingNextLoadBonus || false,
      pendingCashReward,
      pendingCashRewardDay,
      pendingCashRewardDesc,
      milestones,
      nextReward: (FIRE_MILESTONES.find(m => m.day > currentStreak) || {}).reward || 0
    });
  } catch (error) {
    console.error('Error obteniendo estado del fueguito:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/fire/claim', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    
    let fireStreak = await FireStreak.findOne({ userId });
    
    if (!fireStreak) {
      fireStreak = new FireStreak({ userId, username, streak: 0, totalClaimed: 0 });
    }
    
    const todayArgentina = getArgentinaDateString();
    const lastClaim = fireStreak.lastClaim ? getArgentinaDateString(new Date(fireStreak.lastClaim)) : null;
    
    if (lastClaim === todayArgentina) {
      return res.status(400).json({ error: 'Ya reclamaste tu fueguito hoy' });
    }

    // Req 5: El reclamo diario del Fueguito no requiere actividad del mes.
    // Solo las recompensas de hitos verifican requisitos (en /api/fire/claim-reward).
    
    const yesterdayArgentina = getArgentinaYesterday();
    
    if (lastClaim !== yesterdayArgentina && fireStreak.streak > 0) {
      fireStreak.streak = 0;
      fireStreak.lastReset = new Date();
    }
    
    fireStreak.streak += 1;
    fireStreak.lastClaim = new Date();
    
    let reward = 0;
    let rewardType = 'none';
    let message = `¡Día ${fireStreak.streak} de racha! Seguí así 🔥`;

    // Determinar si se alcanza un hito (premios editables desde el panel)
    const FIRE_MILESTONES = await getFireMilestones();
    const milestone = FIRE_MILESTONES.find(m => m.day === fireStreak.streak);
    if (milestone) {
      if (milestone.type === 'next_load_bonus') {
        // Día 15: 30% en próxima carga (se marca como pendiente para operador)
        rewardType = 'next_load_bonus';
        fireStreak.pendingNextLoadBonus = true;
        message = '🎉 ¡15 días de racha! Tenés 30% en tu próxima carga. Un operador te lo aplicará cuando quieras reclamar.';
      } else if (milestone.type === 'cash') {
        // Req 6: Siempre setear la recompensa como pendiente, sin verificar depósitos aquí.
        // La verificación de actividad ocurre al reclamar la recompensa (/api/fire/claim-reward).
        // Solo setear si no hay ya una recompensa pendiente vigente del mismo día para no sobreescribir.
        const existingDate = fireStreak.pendingCashRewardDate || '';
        if (!fireStreak.pendingCashReward || existingDate !== todayArgentina) {
          rewardType = 'cash_pending';
          reward = milestone.reward;
          fireStreak.pendingCashReward = milestone.reward;
          fireStreak.pendingCashRewardDay = fireStreak.streak;
          fireStreak.pendingCashRewardDesc = milestone.desc;
          // Req 1: Guardar la fecha Argentina en que se desbloqueó para auto-expirar al día siguiente
          fireStreak.pendingCashRewardDate = todayArgentina;
          message = `🔥 ¡${fireStreak.streak} días de racha! Tenés una recompensa de $${milestone.reward.toLocaleString()} para reclamar en el recuadro de Fueguito.`;
        } else {
          // Ya hay una recompensa pendiente del mismo día: no sobreescribir
          rewardType = 'cash_pending';
          reward = fireStreak.pendingCashReward;
          message = `🔥 ¡${fireStreak.streak} días de racha! Tenés una recompensa de $${fireStreak.pendingCashReward.toLocaleString()} para reclamar en el recuadro de Fueguito.`;
        }
      }
    }
    
    fireStreak.history = fireStreak.history || [];
    fireStreak.history.push({
      date: new Date(),
      reward: rewardType === 'cash_pending' ? reward : 0,
      streakDay: fireStreak.streak
    });
    
    await fireStreak.save();
    
    res.json({
      success: true,
      streak: fireStreak.streak,
      reward: rewardType === 'cash_pending' ? reward : 0,
      rewardType,
      message,
      totalClaimed: fireStreak.totalClaimed,
      pendingNextLoadBonus: fireStreak.pendingNextLoadBonus || false,
      pendingCashReward: fireStreak.pendingCashReward || 0,
      pendingCashRewardDay: fireStreak.pendingCashRewardDay || 0
    });
  } catch (error) {
    console.error('Error reclamando fueguito:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Reclamar recompensa pendiente de Fueguito (efectivo)
app.post('/api/fire/claim-reward', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;

    const fireStreak = await FireStreak.findOne({ userId });
    if (!fireStreak || !fireStreak.pendingCashReward || fireStreak.pendingCashReward <= 0) {
      return res.status(400).json({ error: 'No hay recompensa pendiente para reclamar.' });
    }

    // Req 1: Verificar que la recompensa no expiró (solo reclamable el mismo día)
    const todayArg = getArgentinaDateString();
    const rewardDateStr = fireStreak.pendingCashRewardDate || '';
    if (rewardDateStr && rewardDateStr !== todayArg) {
      // Limpiar recompensa expirada
      fireStreak.pendingCashReward = 0;
      fireStreak.pendingCashRewardDay = 0;
      fireStreak.pendingCashRewardDesc = '';
      fireStreak.pendingCashRewardDate = '';
      await fireStreak.save();
      return res.status(400).json({ error: 'La recompensa expiró. Solo podés reclamarla el mismo día que llegaste al hito.' });
    }

    // Req 6: Verificar requisitos de actividad para este hito específico (premios editables)
    const rewardDay = fireStreak.pendingCashRewardDay || 0;
    const FIRE_MILESTONES = await getFireMilestones();
    const milestone = FIRE_MILESTONES.find(m => m.day === rewardDay);
    if (milestone && milestone.requireDeposits > 0) {
      const daysBack = milestone.depositDays || 30;
      const deposits = await getDepositsInPeriod(username, daysBack);
      if (deposits < milestone.requireDeposits) {
        return res.status(400).json({
          error: `No cumplís los requisitos para esta recompensa. Se requiere actividad de cargas del mes (mínimo $${milestone.requireDeposits.toLocaleString('es-AR')}).`,
          requirementNotMet: true
        });
      }
    }

    // RESERVA ATÓMICA anti doble/N-cobro (TOCTOU): consumimos el premio pendiente
    // ANTES de acreditar. `findOneAndUpdate` con guard `pendingCashReward > 0` es
    // atómico: si N requests concurrentes del mismo cliente entran a la vez, SÓLO UNO
    // "gana" el documento con el monto (los demás reciben null → abortan). Antes se
    // acreditaba con makeBonus y RECIÉN DESPUÉS se ponía el flag en 0, así que N
    // requests leían el mismo pendingCashReward>0 y cobraban el premio N veces.
    const reserved = await FireStreak.findOneAndUpdate(
      { userId, pendingCashReward: { $gt: 0 } },
      { $set: { pendingCashReward: 0, pendingCashRewardDay: 0, pendingCashRewardDesc: '', pendingCashRewardDate: '' } },
      { new: false } // devuelve el doc PREVIO → de ahí sale el monto a acreditar
    );
    if (!reserved || !reserved.pendingCashReward || reserved.pendingCashReward <= 0) {
      // Otro request concurrente ya lo tomó (o se limpió en el ínterin).
      return res.status(400).json({ error: 'No hay recompensa pendiente para reclamar.' });
    }

    const rewardAmount = reserved.pendingCashReward;
    const rewardDesc = reserved.pendingCashRewardDesc || `Recompensa Fueguito día ${reserved.pendingCashRewardDay}`;

    const serializeErrorPart = (value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) {
        return JSON.stringify({ name: value.name, message: value.message, stack: value.stack });
      }
      try { return JSON.stringify(value); } catch { return String(value); }
    };

    const bonusResult = await jugayganaMovements.makeBonus(username, rewardAmount, rewardDesc + ' - Sala de Juegos');

    if (!bonusResult.success) {
      // La acreditación falló → DEVOLVER el premio a pendiente para que el cliente
      // pueda reintentar. Guard `pendingCashReward: 0` para no pisar un premio nuevo
      // que se hubiera generado en el ínterin.
      try {
        await FireStreak.updateOne(
          { userId, pendingCashReward: 0 },
          { $set: {
            pendingCashReward: rewardAmount,
            pendingCashRewardDay: reserved.pendingCashRewardDay,
            pendingCashRewardDesc: reserved.pendingCashRewardDesc,
            pendingCashRewardDate: reserved.pendingCashRewardDate
          } }
        );
      } catch (restoreErr) {
        logger.error(`[FIRE_REWARD] no se pudo restaurar el premio tras fallo de crédito userId=${userId}: ${restoreErr.message}`);
      }
      const creditError = typeof bonusResult.error === 'string'
        ? bonusResult.error
        : (bonusResult.error?.message || bonusResult.error?.error || bonusResult.error?.details || JSON.stringify(bonusResult.error) || 'Error al acreditar recompensa');
      logger.error(
        `[FIRE_REWARD] claim-reward failed userId=${userId} username=${username} ` +
        `bonusResult=${serializeErrorPart(bonusResult)} bonusError=${serializeErrorPart(bonusResult?.error)}`
      );
      return res.status(400).json({ error: 'Error al acreditar recompensa: ' + creditError });
    }

    // Acreditado OK: sumar al total (atómico; el flag pendiente ya quedó en 0 por la reserva).
    await FireStreak.updateOne({ userId }, { $inc: { totalClaimed: rewardAmount } }).catch(() => {});

    try {
      await Transaction.create({
        id: uuidv4(),
        type: 'fire_reward',
        userId,
        username,
        amount: rewardAmount,
        description: `Fueguito - ${rewardDesc}`,
        timestamp: new Date()
      });
    } catch (txErr) {
      logger.error(`[FIRE_REWARD] Error al guardar transacción userId=${userId} username=${username}: ${txErr.message}`);
    }

    logger.info(`[FIRE_REWARD] claim-reward OK userId=${userId} username=${username} amount=${rewardAmount}`);

    res.json({
      success: true,
      reward: rewardAmount,
      message: `🎉 ¡$${rewardAmount.toLocaleString()} acreditados en tu cuenta!`
    });
  } catch (error) {
    console.error('Error reclamando recompensa Fueguito:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// CAMPAÑAS PUBLICITARIAS — CRUD y stats (admin)
// ============================================

// Helper: calcula todas las métricas de una campaña a partir de su código.
async function computeCampaignStats(code) {
  const normalizedCode = String(code).toUpperCase().trim();
  const [clicks, users] = await Promise.all([
    CampaignClick.countDocuments({ campaignCode: normalizedCode }),
    User.find({ acquisitionCampaign: normalizedCode }).select('id username createdAt').lean()
  ]);
  const usernames = users.map(u => u.username);

  if (usernames.length === 0) {
    return {
      clicks,
      registrations: 0,
      ftd: 0,
      totalRevenue: 0,
      totalWithdrawals: 0,
      netRevenue: 0,
      crClickToRegister: clicks > 0 ? 0 : null,
      crRegisterToFtd: null
    };
  }

  // Revenue del publicista = cargas REALES del usuario. Excluimos cualquier
  // transacción marcada como bono/regalo aunque por error venga como type='deposit'
  // (futuras integraciones / scripts). Hoy install-bonus se registra como type='bonus'
  // y queda fuera por el filtro principal — esta exclusión es defensiva.
  const GIFT_SOURCES = ['install_bonus', 'welcome_gift'];
  const [depositsByUser, withdrawalsAgg] = await Promise.all([
    Transaction.aggregate([
      { $match: {
          type: 'deposit',
          username: { $in: usernames },
          $or: [
            { 'metadata.source': { $exists: false } },
            { 'metadata.source': { $nin: GIFT_SOURCES } }
          ]
      }},
      { $group: { _id: '$username', total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]),
    Transaction.aggregate([
      { $match: { type: 'withdrawal', username: { $in: usernames } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ])
  ]);

  const ftd = depositsByUser.length;
  const totalRevenue = depositsByUser.reduce((s, x) => s + (x.total || 0), 0);
  const totalWithdrawals = withdrawalsAgg[0]?.total || 0;
  const netRevenue = totalRevenue - totalWithdrawals;

  return {
    clicks,
    registrations: users.length,
    ftd,
    totalRevenue,
    totalWithdrawals,
    netRevenue,
    crClickToRegister: clicks > 0 ? users.length / clicks : null,
    crRegisterToFtd: users.length > 0 ? ftd / users.length : null
  };
}

function calcCommission(campaign, stats) {
  if (!campaign || campaign.commissionType === 'none') return 0;
  if (campaign.commissionType === 'cpa') {
    return (campaign.commissionValue || 0) * stats.ftd;
  }
  if (campaign.commissionType === 'revshare') {
    const pct = (campaign.commissionValue || 0) / 100;
    return Math.max(0, stats.netRevenue * pct);
  }
  return 0;
}

// ── PREMIOS DEL FUEGUITO (editables desde el panel, solo admin general) ──────
// GET: devuelve los premios actuales + los defaults. POST: guarda el array nuevo
// (Config['fireMilestones']). Todos los premios son en EFECTIVO.
app.get('/api/admin/fire-milestones', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin general' });
    const milestones = await getFireMilestones();
    res.json({ success: true, milestones, defaults: FIRE_MILESTONES_DEFAULT });
  } catch (e) {
    logger.warn(`[fire-milestones] GET falló: ${e.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/admin/fire-milestones', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin general' });
    const arr = Array.isArray(req.body && req.body.milestones) ? req.body.milestones : null;
    if (!arr) return res.status(400).json({ error: 'Falta el array de premios.' });
    const seen = new Set();
    const norm = arr.map(m => ({
      day: Math.max(1, Math.min(365, parseInt(m.day, 10) || 0)),
      reward: Math.max(0, Math.round(Number(m.reward) || 0)),
      type: 'cash',
      requireDeposits: Math.max(0, Math.round(Number(m.requireDeposits) || 0)),
      depositDays: Math.max(1, Math.min(365, parseInt(m.depositDays, 10) || 30)),
      desc: String(m.desc || '').slice(0, 80)
    }))
    .filter(m => m.day > 0 && m.reward > 0)
    .sort((a, b) => a.day - b.day)
    .filter(m => { if (seen.has(m.day)) return false; seen.add(m.day); return true; })
    .map(m => ({ ...m, desc: m.desc || ('Recompensa Fueguito ' + m.day + ' días') }));
    if (!norm.length) return res.status(400).json({ error: 'Cargá al menos un premio válido (día y monto mayores a 0).' });
    if (norm.length > 30) return res.status(400).json({ error: 'Máximo 30 premios.' });
    await setConfig('fireMilestones', norm);
    logger.info(`[fire-milestones] actualizados por ${req.user.username}: ${norm.length} premios`);
    res.json({ success: true, milestones: norm });
  } catch (e) {
    logger.warn(`[fire-milestones] POST falló: ${e.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Listar todas las campañas con stats resumidas (clicks + registrations).
// Importante: jugayganaPassword está marcado select:false en el schema, por lo
// que NUNCA viaja en esta respuesta. Sólo exponemos hasJugayganaCreds:bool para
// que el panel sepa si la campaña ya tiene creds configuradas.
app.get('/api/admin/campaigns', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const campaigns = await Campaign.find().sort({ createdAt: -1 }).lean();
    // Stats resumidas: clicks y registros (las pesadas se piden por campaña al abrir detalle).
    const codes = campaigns.map(c => c.code);
    const [clicksAgg, regsAgg] = await Promise.all([
      CampaignClick.aggregate([
        { $match: { campaignCode: { $in: codes } } },
        { $group: { _id: '$campaignCode', count: { $sum: 1 } } }
      ]),
      User.aggregate([
        { $match: { acquisitionCampaign: { $in: codes } } },
        { $group: { _id: '$acquisitionCampaign', count: { $sum: 1 } } }
      ])
    ]);
    const clicksByCode = Object.fromEntries(clicksAgg.map(x => [x._id, x.count]));
    const regsByCode = Object.fromEntries(regsAgg.map(x => [x._id, x.count]));
    const enriched = campaigns.map(c => ({
      ...c,
      clicks: clicksByCode[c.code] || 0,
      registrations: regsByCode[c.code] || 0,
      // Bandera derivada: el front la usa para mostrar el badge "Cuenta propia configurada".
      // No exponemos el password ni siquiera derivado — sólo si hay username.
      hasJugayganaCreds: !!c.jugayganaUsername
    }));
    res.json({ campaigns: enriched });
  } catch (err) {
    logger.error(`[admin/campaigns GET] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Normaliza el array de influencers de una campaña que viene en el body del admin.
// Acepta strings ('Juan') u objetos ({ name, isActive }). Devuelve
// [{ name, isActive }] con nombres trim/recortados y deduplicados case-insensitive
// (gana la primera aparición). Devuelve null si el campo viene ausente (= no tocar).
// Lanza Error con mensaje de usuario si el formato es inválido.
function normalizeInfluencers(raw) {
  if (raw == null) return null; // ausente → no modificar la lista existente
  if (!Array.isArray(raw)) throw new Error('influencers debe ser una lista');
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const name = String(typeof item === 'string' ? item : (item && item.name) || '').trim().slice(0, 80);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const isActive = (item && typeof item === 'object' && typeof item.isActive === 'boolean')
      ? item.isActive : true;
    out.push({ name, isActive });
  }
  if (out.length > 100) throw new Error('Demasiados influencers (máximo 100)');
  return out;
}

// Crear nueva campaña. Soporta opcionalmente creds JUGAYGANA del publicista
// (jugayganaUsername + jugayganaPassword en plano → se cifra antes de guardar).
app.post('/api/admin/campaigns', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { code, publisher, name, commissionType, commissionValue, notes,
            jugayganaUsername, jugayganaPassword } = req.body || {};
    if (!code || !publisher || !name) {
      return res.status(400).json({ error: 'code, publisher y name son requeridos' });
    }
    const normalizedCode = String(code).toUpperCase().trim();
    if (!/^[A-Z0-9_-]{3,40}$/.test(normalizedCode)) {
      return res.status(400).json({ error: 'code inválido (3-40 caracteres, A-Z 0-9 _ -)' });
    }
    const validTypes = ['cpa', 'revshare', 'none'];
    const ct = validTypes.includes(commissionType) ? commissionType : 'none';
    const cv = Number.isFinite(parseFloat(commissionValue)) ? parseFloat(commissionValue) : 0;

    // Validación de pareja JUGAYGANA: ambos campos van juntos o ninguno.
    let jgUsername = null;
    let jgPassword = null;
    const wantsCreds = (typeof jugayganaUsername === 'string' && jugayganaUsername.trim()) ||
                       (typeof jugayganaPassword === 'string' && jugayganaPassword);
    if (wantsCreds) {
      if (!jugayganaUsername || !jugayganaPassword) {
        return res.status(400).json({ error: 'Para configurar la cuenta del publicista necesitás username Y password' });
      }
      jgUsername = String(jugayganaUsername).trim();
      jgPassword = String(jugayganaPassword);
    }

    let influencers = [];
    try { influencers = normalizeInfluencers(req.body.influencers) || []; }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const existing = await Campaign.findOne({ code: normalizedCode }).lean();
    if (existing) {
      return res.status(409).json({ error: 'Ya existe una campaña con ese código' });
    }

    const created = await Campaign.create({
      id: uuidv4(),
      code: normalizedCode,
      publisher: String(publisher).trim().slice(0, 100),
      name: String(name).trim().slice(0, 200),
      commissionType: ct,
      commissionValue: cv,
      notes: notes ? String(notes).slice(0, 2000) : '',
      createdBy: req.user.username,
      isActive: true,
      jugayganaUsername: jgUsername,
      jugayganaPassword: jgPassword,
      influencers
    });

    // Nunca devolver el password en la respuesta. select:false en el schema lo
    // protege en queries normales, pero toObject() del doc en memoria sí lo
    // trae — limpiamos explícito.
    const out = created.toObject();
    delete out.jugayganaPassword;
    out.hasJugayganaCreds = !!jgUsername;
    res.status(201).json({ campaign: out });
  } catch (err) {
    logger.error(`[admin/campaigns POST] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Editar campaña existente. `code` es inmutable, los demás campos sí se pueden modificar.
// Para las creds JUGAYGANA: jugayganaUsername se actualiza siempre que venga en el body
// (string vacío o null = limpiar); jugayganaPassword sólo se actualiza si viene un valor
// no vacío (vacío/ausente = mantener la actual). Para borrar las creds enteras, mandar
// jugayganaUsername:null y jugayganaPassword:null explícitamente.
app.put('/api/admin/campaigns/:code', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const normalizedCode = String(req.params.code).toUpperCase().trim();
    const { publisher, name, commissionType, commissionValue, isActive, notes,
            jugayganaUsername, jugayganaPassword, clearJugayganaCreds } = req.body || {};
    const update = {};
    if (typeof publisher === 'string') update.publisher = publisher.trim().slice(0, 100);
    if (typeof name === 'string') update.name = name.trim().slice(0, 200);
    if (['cpa', 'revshare', 'none'].includes(commissionType)) update.commissionType = commissionType;
    if (Number.isFinite(parseFloat(commissionValue))) update.commissionValue = parseFloat(commissionValue);
    if (typeof isActive === 'boolean') update.isActive = isActive;
    if (typeof notes === 'string') update.notes = notes.slice(0, 2000);

    // === Influencers ===
    // Si viene el campo (aunque sea []) reemplazamos la lista entera. Ausente = no tocar.
    if ('influencers' in (req.body || {})) {
      try {
        const inf = normalizeInfluencers(req.body.influencers);
        if (inf !== null) update.influencers = inf;
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    // === Creds JUGAYGANA ===
    if (clearJugayganaCreds === true) {
      update.jugayganaUsername = null;
      update.jugayganaPassword = null;
    } else {
      if (typeof jugayganaUsername === 'string') {
        update.jugayganaUsername = jugayganaUsername.trim() || null;
        // Si vacían el username explícitamente y NO mandan password, limpiamos también el password
        // para mantener el invariante "ambos llenos o ambos vacíos".
        if (!update.jugayganaUsername) update.jugayganaPassword = null;
      }
      if (typeof jugayganaPassword === 'string' && jugayganaPassword.length > 0) {
        update.jugayganaPassword = jugayganaPassword;
      }
    }

    // === Renombrado de influencers (migra los usuarios atribuidos) ===
    // La analítica por influencer se calcula EN VIVO desde User.acquisitionInfluencer.
    // Si se renombra un influencer hay que mover los usuarios del nombre viejo al
    // nuevo, sino quedan colgados del nombre anterior y las stats se parten.
    let renamedUsers = 0;
    const renames = Array.isArray(req.body && req.body.renames) ? req.body.renames : [];
    for (const rn of renames) {
      const from = String((rn && rn.from) || '').trim();
      const to = String((rn && rn.to) || '').trim().slice(0, 80);
      if (!from || !to || from.toLowerCase() === to.toLowerCase()) continue;
      const r = await User.updateMany(
        { acquisitionCampaign: normalizedCode, acquisitionInfluencer: new RegExp('^' + escapeRegex(from) + '$', 'i') },
        { $set: { acquisitionInfluencer: to } }
      );
      renamedUsers += (r.modifiedCount != null ? r.modifiedCount : (r.nModified || 0));
    }

    const updated = await Campaign.findOneAndUpdate(
      { code: normalizedCode },
      { $set: update },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ error: 'Campaña no encontrada' });

    // Invalidar sesión en el pool por si cambiaron las creds — el próximo
    // create-user va a re-loguear con lo nuevo.
    if ('jugayganaUsername' in update || 'jugayganaPassword' in update) {
      jugayganaPublisherSessions.invalidateSession(normalizedCode);
    }

    delete updated.jugayganaPassword;
    updated.hasJugayganaCreds = !!updated.jugayganaUsername;
    res.json({ campaign: updated, renamedUsers });
  } catch (err) {
    logger.error(`[admin/campaigns PUT] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/admin/campaigns/:code/test-jugaygana-creds
// Intenta loguearse en JUGAYGANA con las creds actualmente guardadas para esta
// campaña. Útil para que el admin verifique desde el panel que las creds están
// bien antes de que un publisher_admin intente crear un usuario.
app.post('/api/admin/campaigns/:code/test-jugaygana-creds', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const normalizedCode = String(req.params.code).toUpperCase().trim();
    const c = await Campaign.findOne({ code: normalizedCode })
      .select('+jugayganaPassword jugayganaUsername').lean();
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    if (!c.jugayganaUsername || !c.jugayganaPassword) {
      return res.status(400).json({ error: 'Esta campaña no tiene creds JUGAYGANA configuradas' });
    }
    const result = await jugayganaPublisherSessions.testCreds(c.jugayganaUsername, c.jugayganaPassword);
    if (result.ok) {
      return res.json({ ok: true, parentId: result.parentId });
    }
    return res.status(400).json({ ok: false, error: result.error || 'Login falló' });
  } catch (err) {
    logger.error(`[admin/campaigns test-creds] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// "Eliminar" = soft delete: marca isActive=false. No borramos para preservar atribuciones.
app.delete('/api/admin/campaigns/:code', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const normalizedCode = String(req.params.code).toUpperCase().trim();
    const updated = await Campaign.findOneAndUpdate(
      { code: normalizedCode },
      { $set: { isActive: false } },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'Campaña no encontrada' });
    res.json({ ok: true, campaign: updated });
  } catch (err) {
    logger.error(`[admin/campaigns DELETE] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Borrado DEFINITIVO de una campaña (no es soft delete): elimina el documento de
// la DB y sus historias de influencer. Los usuarios ya captados se conservan, pero
// quedan sin referencia al publicista (acquisitionCampaign apunta a algo borrado).
// Solo admin general. Pensado para limpiar campañas de prueba o cargadas por error.
app.delete('/api/admin/campaigns/:code/permanent', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin general puede borrar campañas definitivamente' });
    }
    const normalizedCode = String(req.params.code).toUpperCase().trim();
    const campaign = await Campaign.findOne({ code: normalizedCode }).lean();
    if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada' });

    // Cuántos usuarios quedan atribuidos (info para el log / respuesta).
    const attributedUsers = await User.countDocuments({ acquisitionCampaign: normalizedCode });

    await Campaign.deleteOne({ code: normalizedCode });
    // Limpiar historias de influencer asociadas (referencian campaignCode).
    let storiesDeleted = 0;
    try {
      const r = await InfluencerStory.deleteMany({ campaignCode: normalizedCode });
      storiesDeleted = r.deletedCount || 0;
    } catch (_) { /* colección puede no existir, ignorar */ }

    // Invalidar cualquier sesión cacheada del pool para esta campaña.
    try { jugayganaPublisherSessions.invalidateSession(normalizedCode); } catch (_) {}

    logger.info(`[admin/campaigns PERMANENT DELETE] ${normalizedCode} por ${req.user.username} (usuarios atribuidos: ${attributedUsers}, historias: ${storiesDeleted})`);
    res.json({ ok: true, deleted: normalizedCode, attributedUsers, storiesDeleted });
  } catch (err) {
    logger.error(`[admin/campaigns PERMANENT DELETE] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Stats detalladas de una campaña + comisión calculada.
app.get('/api/admin/campaigns/:code/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const normalizedCode = String(req.params.code).toUpperCase().trim();
    const campaign = await Campaign.findOne({ code: normalizedCode }).lean();
    if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada' });

    const stats = await computeCampaignStats(normalizedCode);
    const commission = calcCommission(campaign, stats);
    res.json({ campaign, stats, commission });
  } catch (err) {
    logger.error(`[admin/campaigns/:code/stats] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Lista los últimos N usuarios atribuidos a una campaña (para debugging / control).
app.get('/api/admin/campaigns/:code/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const normalizedCode = String(req.params.code).toUpperCase().trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const users = await User.find({ acquisitionCampaign: normalizedCode })
      .select('id username email phone phoneVerified phoneVerificationPending balance createdAt acquiredAt')
      .sort({ acquiredAt: -1 })
      .limit(limit)
      .lean();
    res.json({ users });
  } catch (err) {
    logger.error(`[admin/campaigns/:code/users] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// PUBLISHER_ADMIN — endpoints dedicados
// ============================================
// Estos endpoints son los ÚNICOS (junto con auth/users/me/admin/me) que un
// publisher_admin puede tocar. El lockdown lo aplica authMiddleware en base a
// PUBLISHER_ADMIN_ALLOWED_PATHS — acá sólo agregamos el chequeo de rol con
// publisherAdminMiddleware para defensa en profundidad.

// POST /api/admin/publisher-admin/create-user
// El publisher_admin crea un usuario para SU publicista. El código de campaña
// no se elige en el body: se toma automáticamente del campo publisherCampaignCode
// de la cuenta logueada.
app.post('/api/admin/publisher-admin/create-user', authMiddleware, publisherAdminMiddleware, async (req, res) => {
  try {
    const { username, password, email, phone } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });
    }
    if (!validateUsername(username)) {
      return res.status(400).json({ error: 'Usuario inválido. Usá 3-30 caracteres: letras, números, punto, guion o guion bajo.' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'La contraseña debe tener entre 6 y 100 caracteres' });
    }

    // Cargar la cuenta del publisher_admin desde la DB para obtener su campaña asociada.
    const employee = await User.findOne({ id: req.user.userId }).lean();
    if (!employee || employee.role !== 'publisher_admin') {
      return res.status(403).json({ error: 'Cuenta no válida' });
    }
    if (!employee.publisherCampaignCode) {
      return res.status(400).json({
        error: 'Tu cuenta no tiene un publicista asignado. Contactá al administrador general.'
      });
    }

    // Validar que la campaña sigue existiendo y activa (un admin podría haberla
    // desactivado después de crear este publisher_admin).
    const campaign = await Campaign.findOne({ code: employee.publisherCampaignCode }).lean();
    if (!campaign) {
      return res.status(400).json({ error: 'La campaña asociada a tu cuenta ya no existe. Contactá al administrador general.' });
    }
    if (campaign.isActive === false) {
      return res.status(400).json({ error: 'Tu publicista está desactivado. Contactá al administrador general.' });
    }

    // Sub-atribución por influencer. Si la campaña tiene influencers ACTIVOS, el
    // publisher_admin DEBE elegir uno (la elección viene en body.influencer y se
    // matchea case-insensitive contra la lista, guardando el nombre canónico). Si
    // la campaña no tiene influencers cargados, se ignora (flujo igual al de antes).
    const activeInfluencers = (campaign.influencers || []).filter(i => i.isActive).map(i => i.name);
    let chosenInfluencer = null;
    if (activeInfluencers.length > 0) {
      const raw = typeof req.body.influencer === 'string' ? req.body.influencer.trim() : '';
      const match = activeInfluencers.find(n => n.toLowerCase() === raw.toLowerCase());
      if (!match) {
        return res.status(400).json({ error: 'Elegí un influencer válido de la lista.' });
      }
      chosenInfluencer = match;
    }

    // Username único, case-insensitive (mismo criterio que el resto del sistema).
    const existingUser = await findUserByUsernameCI(username);
    if (existingUser) {
      return res.status(400).json({ error: 'El usuario ya existe' });
    }

    const newUserId = uuidv4();
    const newUser = await User.create({
      id: newUserId,
      username,
      password,
      email: email || null,
      phone: phone || null,
      role: 'user',
      accountNumber: generateAccountNumber(),
      balance: 0,
      createdAt: new Date(),
      lastLogin: null,
      isActive: true,
      jugayganaUserId: null,
      jugayganaUsername: null,
      jugayganaSyncStatus: 'pending',
      // Atribución automática al publicista del empleado logueado.
      acquisitionCampaign: campaign.code,
      acquisitionSource: 'manual',
      acquiredAt: new Date(),
      createdByEmployeeId: employee.id,
      createdByEmployeeUsername: employee.username,
      acquisitionInfluencer: chosenInfluencer
    });

    // NO creamos ChatStatus acá. Si lo hiciéramos, el usuario aparecería como
    // un "chat vacío" en el panel aunque nunca haya ingresado. El ChatStatus se
    // crea recién cuando el usuario ingresa (endpoint /api/messages/welcome) o
    // cuando envía su primer mensaje (upsert en /api/messages/send).

    // Sincronizar con JUGAYGANA en background. Si la campaña tiene credenciales
    // propias (sub-agente del publicista), el CREATEUSER se rutea por la sesión
    // de ese sub-agente para que el usuario quede colgado del publicista correcto
    // en la jerarquía de JUGAYGANA (y la comisión la cobre quien debe).
    // Si la campaña no tiene creds configuradas, fallback al cliente master
    // (comportamiento legacy / idéntico al de POST /api/users).
    (async () => {
      try {
        const hasPubCreds = !!(campaign.jugayganaUsername);
        if (hasPubCreds) {
          const result = await jugayganaPublisherSessions.createUserAsPublisher(campaign.code, {
            username: newUser.username,
            password: password
          });
          if (result.success) {
            await User.updateOne(
              { id: newUserId },
              {
                jugayganaUserId: result.jugayganaUserId || result.user?.user_id,
                jugayganaUsername: result.jugayganaUsername || result.user?.user_name,
                jugayganaSyncStatus: 'synced'
              }
            );
            logger.info(`[publisher_admin create-user] ${username} creado bajo sub-agente de ${campaign.code}`);
          } else if (result.code === 'NO_CREDS') {
            // El check inicial dijo que había creds pero al loadCreds dentro del pool
            // no las encontró — race condition con un PUT de campaña justo en ese
            // momento. Fallback al master.
            logger.warn(`[publisher_admin create-user] ${campaign.code} sin creds tras race — fallback master`);
            const fallback = await jugaygana.syncUserToPlatform({
              username: newUser.username, password
            });
            if (fallback.success) {
              await User.updateOne({ id: newUserId }, {
                jugayganaUserId: fallback.jugayganaUserId || fallback.user?.user_id,
                jugayganaUsername: fallback.jugayganaUsername || fallback.user?.user_name,
                jugayganaSyncStatus: fallback.alreadyExists ? 'linked' : 'synced'
              });
            }
          } else {
            // Falló el CREATEUSER con la sesión del publicista. NO hacemos fallback
            // a la master automáticamente: si la creación falla con las creds del
            // publicista, queremos que el admin se entere y arregle las creds —
            // sino el user terminaría bajo la master con atribución mal asignada.
            await User.updateOne({ id: newUserId }, {
              jugayganaSyncStatus: 'error',
              jugayganaSyncError: `[${result.code}] ${result.error}`.slice(0, 500)
            });
            logger.warn(`[publisher_admin create-user] CREATEUSER por publicista falló ${campaign.code}/${username}: ${result.error}`);
          }
        } else {
          // Campaña sin creds propias — comportamiento legacy: usar cuenta master.
          const fallback = await jugaygana.syncUserToPlatform({
            username: newUser.username, password
          });
          if (fallback.success) {
            await User.updateOne({ id: newUserId }, {
              jugayganaUserId: fallback.jugayganaUserId || fallback.user?.user_id,
              jugayganaUsername: fallback.jugayganaUsername || fallback.user?.user_name,
              jugayganaSyncStatus: fallback.alreadyExists ? 'linked' : 'synced'
            });
          } else {
            logger.warn(`[publisher_admin create-user] JUGAYGANA sync (master) falló para ${username}: ${fallback.error}`);
          }
        }
      } catch (err) {
        logger.warn(`[publisher_admin create-user] JUGAYGANA sync excepción para ${username}: ${err.message}`);
      }
    })();

    logger.info(
      `[publisher_admin] ${employee.username} (campaign=${campaign.code}, creds=${!!campaign.jugayganaUsername}` +
      `${chosenInfluencer ? `, influencer=${chosenInfluencer}` : ''}) creó usuario ${username}`
    );

    res.status(201).json({
      message: 'Usuario creado exitosamente',
      user: {
        id: newUser.id,
        username: newUser.username,
        accountNumber: newUser.accountNumber,
        acquisitionCampaign: newUser.acquisitionCampaign,
        acquisitionInfluencer: newUser.acquisitionInfluencer,
        createdAt: newUser.createdAt
      }
    });
  } catch (err) {
    logger.error(`[publisher_admin create-user] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/publisher-admin/influencers
// Devuelve los influencers ACTIVOS de la campaña de este publisher_admin, para
// poblar el desplegable del form de crear usuario. Si la campaña no tiene
// influencers cargados devuelve lista vacía (el front oculta el selector).
app.get('/api/admin/publisher-admin/influencers', authMiddleware, publisherAdminMiddleware, async (req, res) => {
  try {
    const employee = await User.findOne({ id: req.user.userId }).lean();
    if (!employee || !employee.publisherCampaignCode) {
      return res.json({ influencers: [] });
    }
    const campaign = await Campaign.findOne({ code: employee.publisherCampaignCode })
      .select('influencers').lean();
    const influencers = (campaign?.influencers || [])
      .filter(i => i.isActive)
      .map(i => i.name);
    res.json({ influencers });
  } catch (err) {
    logger.error(`[publisher_admin influencers] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/publisher-admin/my-stats
// Devuelve métricas SOLO de los usuarios que este publisher_admin creó.
// No expone otros publicistas ni otros agentes; cada cuenta ve sus propios números.
app.get('/api/admin/publisher-admin/my-stats', authMiddleware, publisherAdminMiddleware, async (req, res) => {
  try {
    const employee = await User.findOne({ id: req.user.userId }).lean();
    if (!employee || employee.role !== 'publisher_admin') {
      return res.status(403).json({ error: 'Cuenta no válida' });
    }
    if (!employee.publisherCampaignCode) {
      return res.json({
        publisher: null,
        totals: { users: 0, deposits: 0, withdrawals: 0, netRevenue: 0 },
        recentUsers: []
      });
    }

    const campaign = await Campaign.findOne({ code: employee.publisherCampaignCode }).lean();

    // Sólo contamos usuarios creados POR esta cuenta (acquisitionSource='manual'
    // y createdByEmployeeId == el ID del empleado logueado). Esto evita mezclar
    // los orgánicos del link de pauta si la campaña también está activa allí.
    const baseQuery = {
      acquisitionCampaign: employee.publisherCampaignCode,
      acquisitionSource: 'manual',
      createdByEmployeeId: employee.id
    };

    const users = await User.find(baseQuery).select('id username').lean();
    const usernames = users.map(u => u.username);

    let totalDeposits = 0;
    let totalWithdrawals = 0;
    if (usernames.length > 0) {
      const GIFT_SOURCES = ['install_bonus', 'welcome_gift'];
      const [depAgg, witAgg] = await Promise.all([
        Transaction.aggregate([
          { $match: {
              type: 'deposit',
              username: { $in: usernames },
              $or: [
                { 'metadata.source': { $exists: false } },
                { 'metadata.source': { $nin: GIFT_SOURCES } }
              ]
          }},
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Transaction.aggregate([
          { $match: { type: 'withdrawal', username: { $in: usernames } } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ])
      ]);
      totalDeposits = depAgg[0]?.total || 0;
      totalWithdrawals = witAgg[0]?.total || 0;
    }

    // Últimos 20 usuarios creados (sólo username y fecha para mostrar en el panel).
    const recentUsers = await User.find(baseQuery)
      .select('username createdAt')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    res.json({
      publisher: campaign ? { code: campaign.code, name: campaign.name, publisher: campaign.publisher } : null,
      totals: {
        users: users.length,
        deposits: totalDeposits,
        withdrawals: totalWithdrawals,
        netRevenue: totalDeposits - totalWithdrawals
      },
      recentUsers
    });
  } catch (err) {
    logger.error(`[publisher_admin my-stats] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/publisher-admin/users?page=&search=
// Lista paginada (10 por página) de los usuarios creados por este publisher_admin.
// Orden: más recientes primero. Soporta búsqueda por substring de username.
// Sólo devuelve users con acquisitionSource='manual' Y createdByEmployeeId=mi.id
// (la misma combinación que cuenta para sus stats — evita ver clientes orgánicos
// del mismo publicista que NO creó él).
app.get('/api/admin/publisher-admin/users', authMiddleware, publisherAdminMiddleware, async (req, res) => {
  try {
    const employee = await User.findOne({ id: req.user.userId }).lean();
    if (!employee || !employee.publisherCampaignCode) {
      return res.json({ users: [], total: 0, page: 1, totalPages: 0, perPage: 10 });
    }
    const PER_PAGE = 10;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const search = String(req.query.search || '').trim().slice(0, 60);

    const influencerFilter = String(req.query.influencer || '').trim().slice(0, 80);

    const baseQuery = {
      acquisitionCampaign: employee.publisherCampaignCode,
      acquisitionSource: 'manual',
      createdByEmployeeId: employee.id
    };
    if (search) {
      // case-insensitive substring, escapado para no romper el regex.
      baseQuery.username = { $regex: escapeRegex(search), $options: 'i' };
    }
    if (influencerFilter) {
      baseQuery.acquisitionInfluencer = influencerFilter;
    }

    const total = await User.countDocuments(baseQuery);
    const totalPages = total === 0 ? 0 : Math.ceil(total / PER_PAGE);
    const users = await User.find(baseQuery)
      .select('id username createdAt phone email acquisitionInfluencer')
      .sort({ createdAt: -1 })
      .skip((page - 1) * PER_PAGE)
      .limit(PER_PAGE)
      .lean();

    res.json({ users, total, page, totalPages, perPage: PER_PAGE });
  } catch (err) {
    logger.error(`[publisher_admin users] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/admin/publisher-admin/users/:userId/change-password
// El publisher_admin puede cambiar la contraseña de los usuarios que ÉL creó.
// Doble check de seguridad: target.createdByEmployeeId === employee.id Y
// target.role === 'user'. Sincroniza a JUGAYGANA en background (best-effort).
app.post('/api/admin/publisher-admin/users/:userId/change-password', authMiddleware, publisherAdminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { newPassword } = req.body || {};
    if (!newPassword || typeof newPassword !== 'string' || !validatePassword(newPassword)) {
      return res.status(400).json({ error: 'La contraseña debe tener entre 6 y 100 caracteres' });
    }
    const employee = await User.findOne({ id: req.user.userId }).lean();
    if (!employee || !employee.publisherCampaignCode) {
      return res.status(403).json({ error: 'Cuenta no válida' });
    }
    const target = await User.findOne({ id: userId });
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

    // SEGURIDAD: sólo usuarios que vos creaste.
    if (target.createdByEmployeeId !== employee.id) {
      return res.status(403).json({ error: 'Sólo podés cambiar la contraseña de usuarios que vos creaste' });
    }
    if (target.role !== 'user') {
      return res.status(403).json({ error: 'No se puede cambiar la contraseña de cuentas que no son de usuario final' });
    }

    target.password = newPassword; // pre-save hook hashea
    target.passwordChangedAt = new Date();
    target.tokenVersion = (target.tokenVersion || 0) + 1; // invalida sesiones existentes del cliente
    target.mustChangePassword = false; // por si tenía el flag de antes
    await target.save();

    // Sincronizar a JUGAYGANA en background — el helper tiene 3 reintentos y
    // crea un aviso admin-only en el chat si falla del todo.
    syncPasswordToJugaygana(target, newPassword, `publisher_admin ${employee.username}`).catch(err => {
      logger.warn(`[publisher_admin change-password] sync JUGAYGANA falló ${target.username}: ${err.message}`);
    });

    logger.info(`[publisher_admin] ${employee.username} cambió contraseña de ${target.username}`);
    res.json({ success: true, message: 'Contraseña cambiada exitosamente' });
  } catch (err) {
    logger.error(`[publisher_admin change-password] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// PUBLISHER_ADMINS — CRUD para el admin general
// ============================================
// Sólo role==='admin' (admin general) puede crear/gestionar cuentas publisher_admin.
// Los agentes depositor/withdrawer no pueden — esto se asegura con el chequeo
// explícito req.user.role !== 'admin' (no basta adminMiddleware que también
// admite depositor/withdrawer).

// POST /api/admin/publisher-admins — crear una cuenta publisher_admin asociada
// a una Campaign existente y activa.
app.post('/api/admin/publisher-admins', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Sólo el administrador general puede crear publisher_admins' });
    }
    const { username, password, campaignCode, email, phone } = req.body || {};
    if (!username || !password || !campaignCode) {
      return res.status(400).json({ error: 'username, password y campaignCode son requeridos' });
    }
    if (!validateUsername(username)) {
      return res.status(400).json({ error: 'Usuario inválido. Usá 3-30 caracteres: letras, números, punto, guion o guion bajo.' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'La contraseña debe tener entre 6 y 100 caracteres' });
    }

    const normalizedCode = String(campaignCode).toUpperCase().trim();
    const campaign = await Campaign.findOne({ code: normalizedCode }).lean();
    if (!campaign) {
      return res.status(400).json({ error: 'No existe una campaña con ese código' });
    }
    if (campaign.isActive === false) {
      return res.status(400).json({ error: 'La campaña está desactivada — reactivala antes de asignar una cuenta' });
    }

    const existing = await findUserByUsernameCI(username);
    if (existing) {
      return res.status(400).json({ error: 'Ya existe un usuario con ese username' });
    }

    const newId = uuidv4();
    const newPa = await User.create({
      id: newId,
      username,
      password,
      email: email || null,
      phone: phone || null,
      role: 'publisher_admin',
      publisherCampaignCode: normalizedCode,
      accountNumber: generateAccountNumber(),
      balance: 0,
      createdAt: new Date(),
      lastLogin: null,
      isActive: true,
      jugayganaSyncStatus: 'not_applicable'
    });

    logger.info(
      `[admin] ${req.user.username} creó publisher_admin ${username} para campaña ${normalizedCode}`
    );

    res.status(201).json({
      message: 'Publisher_admin creado',
      publisherAdmin: {
        id: newPa.id,
        username: newPa.username,
        publisherCampaignCode: newPa.publisherCampaignCode,
        campaign: { code: campaign.code, publisher: campaign.publisher, name: campaign.name },
        isActive: newPa.isActive,
        createdAt: newPa.createdAt
      }
    });
  } catch (err) {
    logger.error(`[admin/publisher-admins POST] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/publisher-admins — listar todas las cuentas publisher_admin
// con info de la campaña asociada y stats básicas (cuántos usuarios crearon).
app.get('/api/admin/publisher-admins', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const list = await User.find({ role: 'publisher_admin' })
      .select('id username publisherCampaignCode isActive createdAt lastLogin email phone')
      .sort({ createdAt: -1 })
      .lean();

    if (list.length === 0) return res.json({ publisherAdmins: [] });

    // Resolver datos de la campaña asociada a cada uno.
    const codes = Array.from(new Set(list.map(p => p.publisherCampaignCode).filter(Boolean)));
    const campaigns = await Campaign.find({ code: { $in: codes } })
      .select('code publisher name isActive')
      .lean();
    const campaignByCode = Object.fromEntries(campaigns.map(c => [c.code, c]));

    // Contar usuarios creados por cada uno (sólo los manuales atribuidos a este empleado).
    const ids = list.map(p => p.id);
    const userCountAgg = await User.aggregate([
      { $match: {
          createdByEmployeeId: { $in: ids },
          acquisitionSource: 'manual'
      }},
      { $group: { _id: '$createdByEmployeeId', count: { $sum: 1 } } }
    ]);
    const userCountByEmployeeId = Object.fromEntries(userCountAgg.map(x => [x._id, x.count]));

    const enriched = list.map(p => ({
      id: p.id,
      username: p.username,
      email: p.email,
      phone: p.phone,
      isActive: p.isActive,
      createdAt: p.createdAt,
      lastLogin: p.lastLogin,
      publisherCampaignCode: p.publisherCampaignCode,
      campaign: campaignByCode[p.publisherCampaignCode] || null,
      usersCreatedCount: userCountByEmployeeId[p.id] || 0
    }));

    res.json({ publisherAdmins: enriched });
  } catch (err) {
    logger.error(`[admin/publisher-admins GET] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// PUT /api/admin/publisher-admins/:id — modificar una cuenta publisher_admin.
// Permite: cambiar la campaña asociada, activar/desactivar, resetear contraseña.
// NO permite cambiar el role (un publisher_admin no se "promueve" a admin acá).
app.put('/api/admin/publisher-admins/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Sólo el administrador general puede modificar publisher_admins' });
    }
    const { id } = req.params;
    const { campaignCode, isActive, password, email, phone } = req.body || {};

    const target = await User.findOne({ id, role: 'publisher_admin' });
    if (!target) return res.status(404).json({ error: 'Publisher_admin no encontrado' });

    if (campaignCode !== undefined) {
      const normalizedCode = String(campaignCode).toUpperCase().trim();
      const campaign = await Campaign.findOne({ code: normalizedCode }).lean();
      if (!campaign) return res.status(400).json({ error: 'No existe una campaña con ese código' });
      if (campaign.isActive === false) {
        return res.status(400).json({ error: 'La campaña está desactivada' });
      }
      target.publisherCampaignCode = normalizedCode;
    }
    if (typeof isActive === 'boolean') target.isActive = isActive;
    if (typeof email === 'string') target.email = email.trim() || null;
    if (typeof phone === 'string') target.phone = phone.trim() || null;
    if (password) {
      if (!validatePassword(password)) {
        return res.status(400).json({ error: 'La contraseña debe tener entre 6 y 100 caracteres' });
      }
      target.password = password; // pre-save hook hashea
      target.passwordChangedAt = new Date();
      target.tokenVersion = (target.tokenVersion || 0) + 1; // invalida sesiones existentes
    }

    await target.save();

    logger.info(`[admin] ${req.user.username} modificó publisher_admin ${target.username}`);
    res.json({
      message: 'Publisher_admin actualizado',
      publisherAdmin: {
        id: target.id,
        username: target.username,
        publisherCampaignCode: target.publisherCampaignCode,
        isActive: target.isActive
      }
    });
  } catch (err) {
    logger.error(`[admin/publisher-admins PUT] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// DASHBOARD PUBLICISTAS — sólo admin general
// ============================================
// Agrega métricas por publicista (publisher), no por código de campaña: si un
// publicista tiene varias Campaigns, suma todas.

// GET /api/admin/publishers/dashboard?from=&to=
// Devuelve una fila por publicista con totales (users, deposits, withdrawals, netRevenue).
// Las fechas opcionales filtran por User.createdAt y Transaction.timestamp.
app.get('/api/admin/publishers/dashboard', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateFilter = {};
    if (from) {
      const d = new Date(from);
      if (!isNaN(d.getTime())) dateFilter.$gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (!isNaN(d.getTime())) dateFilter.$lte = d;
    }
    const hasDateFilter = !!dateFilter.$gte || !!dateFilter.$lte;

    // Todas las campañas activas o inactivas — necesitamos saber a qué publisher
    // pertenece cada code para agrupar.
    const campaigns = await Campaign.find().select('code publisher name isActive').lean();
    const publisherByCode = Object.fromEntries(campaigns.map(c => [c.code, c.publisher]));

    // Usuarios atribuidos a alguna campaña en el rango (si hay filtro).
    const userQuery = { acquisitionCampaign: { $ne: null } };
    if (hasDateFilter) userQuery.createdAt = dateFilter;
    const users = await User.find(userQuery)
      .select('username acquisitionCampaign acquisitionSource createdAt')
      .lean();

    // Acumulador por publisher.
    const byPublisher = new Map();
    function ensure(pub) {
      if (!byPublisher.has(pub)) {
        byPublisher.set(pub, {
          publisher: pub,
          campaignCodes: new Set(),
          users: 0,
          usersManual: 0,
          usersOrganic: 0,
          deposits: 0,
          withdrawals: 0
        });
      }
      return byPublisher.get(pub);
    }

    const usernamesByPublisher = new Map();
    for (const u of users) {
      const pub = publisherByCode[u.acquisitionCampaign] || 'Sin publicista';
      const row = ensure(pub);
      row.users += 1;
      if (u.acquisitionSource === 'manual') row.usersManual += 1;
      else row.usersOrganic += 1;
      row.campaignCodes.add(u.acquisitionCampaign);
      if (!usernamesByPublisher.has(pub)) usernamesByPublisher.set(pub, []);
      usernamesByPublisher.get(pub).push(u.username);
    }

    // Para cada publisher, sumar deposits y withdrawals de sus usernames.
    const GIFT_SOURCES = ['install_bonus', 'welcome_gift'];
    const txDateFilter = {};
    if (hasDateFilter) txDateFilter.timestamp = dateFilter;

    for (const [pub, usernames] of usernamesByPublisher) {
      if (usernames.length === 0) continue;
      const [depAgg, witAgg] = await Promise.all([
        Transaction.aggregate([
          { $match: {
              ...txDateFilter,
              type: 'deposit',
              username: { $in: usernames },
              $or: [
                { 'metadata.source': { $exists: false } },
                { 'metadata.source': { $nin: GIFT_SOURCES } }
              ]
          }},
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Transaction.aggregate([
          { $match: { ...txDateFilter, type: 'withdrawal', username: { $in: usernames } } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ])
      ]);
      const row = ensure(pub);
      row.deposits = depAgg[0]?.total || 0;
      row.withdrawals = witAgg[0]?.total || 0;
    }

    const rows = Array.from(byPublisher.values()).map(r => ({
      publisher: r.publisher,
      campaignCodes: Array.from(r.campaignCodes),
      users: r.users,
      usersManual: r.usersManual,
      usersOrganic: r.usersOrganic,
      deposits: r.deposits,
      withdrawals: r.withdrawals,
      netRevenue: r.deposits - r.withdrawals
    })).sort((a, b) => b.deposits - a.deposits);

    res.json({
      from: from || null,
      to: to || null,
      publishers: rows
    });
  } catch (err) {
    logger.error(`[admin/publishers/dashboard] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/publishers/:publisher/users?from=&to=
// Drill-down: lista los usuarios atribuidos a un publicista específico, con
// detalle de cargas/retiros individuales.
app.get('/api/admin/publishers/:publisher/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const publisher = String(req.params.publisher).trim();
    if (!publisher) return res.status(400).json({ error: 'publisher requerido' });

    const { from, to } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);

    const campaigns = await Campaign.find({ publisher }).select('code').lean();
    const codes = campaigns.map(c => c.code);
    if (codes.length === 0) return res.json({ publisher, users: [] });

    const userQuery = { acquisitionCampaign: { $in: codes } };
    if (from || to) {
      userQuery.createdAt = {};
      if (from) {
        const d = new Date(from);
        if (!isNaN(d.getTime())) userQuery.createdAt.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (!isNaN(d.getTime())) userQuery.createdAt.$lte = d;
      }
    }

    const users = await User.find(userQuery)
      .select('id username phone acquisitionCampaign acquisitionSource createdByEmployeeUsername createdAt acquiredAt balance')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    // Sumar deposits/withdrawals por usuario.
    const usernames = users.map(u => u.username);
    let depByUser = {};
    let witByUser = {};
    if (usernames.length > 0) {
      const GIFT_SOURCES = ['install_bonus', 'welcome_gift'];
      const [depAgg, witAgg] = await Promise.all([
        Transaction.aggregate([
          { $match: {
              type: 'deposit',
              username: { $in: usernames },
              $or: [
                { 'metadata.source': { $exists: false } },
                { 'metadata.source': { $nin: GIFT_SOURCES } }
              ]
          }},
          { $group: { _id: '$username', total: { $sum: '$amount' } } }
        ]),
        Transaction.aggregate([
          { $match: { type: 'withdrawal', username: { $in: usernames } } },
          { $group: { _id: '$username', total: { $sum: '$amount' } } }
        ])
      ]);
      depByUser = Object.fromEntries(depAgg.map(x => [x._id, x.total]));
      witByUser = Object.fromEntries(witAgg.map(x => [x._id, x.total]));
    }

    const enriched = users.map(u => ({
      ...u,
      deposits: depByUser[u.username] || 0,
      withdrawals: witByUser[u.username] || 0
    }));

    res.json({ publisher, users: enriched });
  } catch (err) {
    logger.error(`[admin/publishers/:publisher/users] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// ANALÍTICA DE CLIENTES POR PUBLICISTA
// ============================================

// GET /api/admin/publishers/ranking
// Ranking de todos los publicistas por score de efectividad (mejor → peor).
// IMPORTANTE: declarado ANTES de las rutas /:publisher/* — "ranking" es un
// único segmento, así que no colisiona, pero lo dejamos arriba por claridad.
app.get('/api/admin/publishers/ranking', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const ranking = await publisherAnalytics.getRanking();
    res.json({ ranking });
  } catch (err) {
    logger.error(`[admin/publishers/ranking] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/publishers/:publisher/daily?from=&to=
// Breakdown diario: primera carga (FTD) para ROAS, total de cargas, y recargas
// del mismo día de clientes nuevos. Fechas en hora Argentina (YYYY-MM-DD).
app.get('/api/admin/publishers/:publisher/daily', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const publisher = String(req.params.publisher).trim();
    if (!publisher) return res.status(400).json({ error: 'publisher requerido' });
    const from = req.query.from && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null;
    const to = req.query.to && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : null;
    const result = await publisherAnalytics.getDailyBreakdown(publisher, from, to);
    if (!result) return res.status(404).json({ error: 'Publicista sin clientes o inexistente' });
    res.json(result);
  } catch (err) {
    logger.error(`[admin/publishers/:publisher/daily] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/publishers/:publisher/analysis
// Análisis detallado de un publicista: métricas + segmentos (activos / en riesgo
// / perdidos / nunca cargaron) + clientes valiosos (ticket alto, fieles).
app.get('/api/admin/publishers/:publisher/analysis', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const publisher = String(req.params.publisher).trim();
    if (!publisher) return res.status(400).json({ error: 'publisher requerido' });
    const analysis = await publisherAnalytics.getPublisherAnalysis(publisher);
    if (!analysis) return res.status(404).json({ error: 'Publicista sin clientes o inexistente' });
    res.json(analysis);
  } catch (err) {
    logger.error(`[admin/publishers/:publisher/analysis] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/publishers/:publisher/influencers
// Desglose de las métricas del publicista por influencer (sub-atribución que
// pone el publisher_admin al crear usuarios). Mismas métricas que el análisis
// general pero agrupadas por User.acquisitionInfluencer.
app.get('/api/admin/publishers/:publisher/influencers', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const publisher = String(req.params.publisher).trim();
    if (!publisher) return res.status(400).json({ error: 'publisher requerido' });
    const result = await publisherAnalytics.getInfluencerBreakdown(publisher);
    if (!result) return res.status(404).json({ error: 'Publicista inexistente' });
    res.json(result);
  } catch (err) {
    logger.error(`[admin/publishers/:publisher/influencers] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// HISTORIAS DE INFLUENCER (seguimiento de costo / ROAS por publicación)
// ============================================
// Una "historia" = un placement del influencer (precio por historia, arranca
// ~20hs). La atribución de registros a cada historia es por ventana horaria y se
// calcula a demanda en getInfluencerStoryAnalysis. Sólo admin general.

// GET /api/admin/influencer-stories?campaign=CODE&influencer=NAME
// Lista las historias del influencer + métricas por historia (registros, clientes,
// cargas, neto, CPA, ROAS) y totales. Devuelve también el bucket "antes de la 1ra".
app.get('/api/admin/influencer-stories', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const campaign = String(req.query.campaign || '').trim();
    const influencer = String(req.query.influencer || '').trim();
    if (!campaign || !influencer) {
      return res.status(400).json({ error: 'campaign e influencer son requeridos' });
    }
    const data = await publisherAnalytics.getInfluencerStoryAnalysis(campaign, influencer);
    if (!data) return res.status(404).json({ error: 'Campaña/influencer inexistente' });
    res.json(data);
  } catch (err) {
    logger.error(`[influencer-stories GET] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/influencer-stories/ranking?campaign=CODE
// Ranking de influencers de la campaña, de mejor a peor, por score combinado
// (ROAS + retención de fieles + ticket promedio + costo por click). El front
// puede reordenar por cualquier columna; este es el orden por defecto (score).
app.get('/api/admin/influencer-stories/ranking', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const campaign = String(req.query.campaign || '').trim();
    if (!campaign) return res.status(400).json({ error: 'campaign es requerido' });
    const data = await publisherAnalytics.getInfluencerStoriesRanking(campaign);
    if (!data) return res.status(404).json({ error: 'Campaña inexistente' });
    res.json(data);
  } catch (err) {
    logger.error(`[influencer-stories ranking] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/admin/influencer-stories
// body: { campaign, influencer, postedAt (ISO), cost, label? }
app.post('/api/admin/influencer-stories', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { campaign, influencer, postedAt, cost, label } = req.body || {};
    const code = String(campaign || '').toUpperCase().trim();
    const name = String(influencer || '').trim();
    if (!code || !name) return res.status(400).json({ error: 'campaign e influencer son requeridos' });

    const when = postedAt ? new Date(postedAt) : null;
    if (!when || isNaN(when.getTime())) return res.status(400).json({ error: 'Fecha/hora de la historia inválida' });

    const c = Number(cost);
    if (!Number.isFinite(c) || c < 0) return res.status(400).json({ error: 'Costo inválido' });

    const camp = await Campaign.findOne({ code }).select('code').lean();
    if (!camp) return res.status(404).json({ error: 'La campaña no existe' });

    const story = await InfluencerStory.create({
      id: uuidv4(),
      campaignCode: code,
      influencer: name,
      postedAt: when,
      cost: c,
      label: label ? String(label).slice(0, 200) : '',
      createdBy: req.user.username
    });
    res.status(201).json({ story });
  } catch (err) {
    logger.error(`[influencer-stories POST] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// PUT /api/admin/influencer-stories/:id  → body: { postedAt?, cost?, label? }
app.put('/api/admin/influencer-stories/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { postedAt, cost, label } = req.body || {};
    const update = {};
    if (postedAt !== undefined) {
      const when = new Date(postedAt);
      if (isNaN(when.getTime())) return res.status(400).json({ error: 'Fecha/hora inválida' });
      update.postedAt = when;
    }
    if (cost !== undefined) {
      const c = Number(cost);
      if (!Number.isFinite(c) || c < 0) return res.status(400).json({ error: 'Costo inválido' });
      update.cost = c;
    }
    if (typeof label === 'string') update.label = label.slice(0, 200);

    const story = await InfluencerStory.findOneAndUpdate(
      { id: req.params.id }, { $set: update }, { new: true }
    ).lean();
    if (!story) return res.status(404).json({ error: 'Historia no encontrada' });
    res.json({ story });
  } catch (err) {
    logger.error(`[influencer-stories PUT] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// DELETE /api/admin/influencer-stories/:id
app.delete('/api/admin/influencer-stories/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const r = await InfluencerStory.deleteOne({ id: req.params.id });
    if (r.deletedCount === 0) return res.status(404).json({ error: 'Historia no encontrada' });
    res.json({ success: true });
  } catch (err) {
    logger.error(`[influencer-stories DELETE] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/influencer-users?campaign=CODE&influencer=NAME&page=
// Lista paginada de los usuarios atribuidos a ese influencer con sus stats de
// cargas/retiros, para revisar y corregir asignaciones equivocadas.
app.get('/api/admin/influencer-users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const campaign = String(req.query.campaign || '').trim();
    const influencer = String(req.query.influencer || '').trim();
    if (!campaign || !influencer) {
      return res.status(400).json({ error: 'campaign e influencer son requeridos' });
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const data = await publisherAnalytics.getInfluencerUsers(campaign, influencer, page, 20);
    if (!data) return res.status(404).json({ error: 'Campaña/influencer inexistente' });
    res.json(data);
  } catch (err) {
    logger.error(`[influencer-users GET] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/admin/users/:userId/change-influencer  → body: { influencer }
// Reasigna el influencer de un usuario (corrige errores del agente). El nuevo
// influencer debe existir en la campaña del usuario; vacío = quitar influencer.
// Como toda la analítica por influencer/historia se calcula EN VIVO desde
// User.acquisitionInfluencer, con cambiar este campo las cargas/retiros/conteos
// se recalculan solos bajo el influencer correcto. Sólo admin general.
app.post('/api/admin/users/:userId/change-influencer', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Sólo el administrador general puede reasignar influencers' });
    }
    const { influencer } = req.body || {};
    const user = await User.findOne({ id: req.params.userId });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!user.acquisitionCampaign) {
      return res.status(400).json({ error: 'El usuario no está atribuido a ningún publicista' });
    }

    const campaign = await Campaign.findOne({ code: user.acquisitionCampaign }).select('influencers').lean();
    if (!campaign) return res.status(400).json({ error: 'La campaña del usuario ya no existe' });

    const raw = typeof influencer === 'string' ? influencer.trim() : '';
    let newInfluencer = null; // vacío = quitar influencer
    if (raw) {
      const match = (campaign.influencers || []).find(i => i.name.toLowerCase() === raw.toLowerCase());
      if (!match) {
        return res.status(400).json({ error: 'Ese influencer no existe en la campaña del usuario' });
      }
      newInfluencer = match.name; // nombre canónico
    }

    const previous = user.acquisitionInfluencer || null;
    user.acquisitionInfluencer = newInfluencer;
    await user.save();

    logger.info(`[change-influencer] ${req.user.username} reasignó ${user.username}: "${previous || '—'}" → "${newInfluencer || '—'}"`);
    res.json({ success: true, username: user.username, from: previous, to: newInfluencer });
  } catch (err) {
    logger.error(`[change-influencer] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/admin/publishers/:publisher/recover
// Manda un push de recuperación a un segmento de un publicista. Recalcula los
// usernames del segmento server-side (no confía en una lista del cliente).
// Sólo el admin general (no depositor/withdrawer) puede disparar push masivo.
app.post('/api/admin/publishers/:publisher/recover', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Sólo el administrador general puede enviar push de recuperación' });
    }
    const publisher = String(req.params.publisher).trim();
    const { segment, title, body } = req.body || {};
    if (!publisher) return res.status(400).json({ error: 'publisher requerido' });
    if (!segment || !['active', 'atRisk', 'lost', 'never'].includes(segment)) {
      return res.status(400).json({ error: 'segment inválido (active|atRisk|lost|never)' });
    }
    if (!title || !body) {
      return res.status(400).json({ error: 'title y body son requeridos' });
    }

    const usernames = await publisherAnalytics.getSegmentUsernames(publisher, segment);
    if (usernames.length === 0) {
      return res.json({ success: true, sent: 0, message: 'No hay clientes en ese segmento para notificar.' });
    }

    const result = await sendNotificationToUsernames(
      User,
      usernames,
      String(title).slice(0, 120),
      String(body).slice(0, 500),
      { kind: 'publisher_recovery', publisher, segment }
    );

    logger.info(`[publishers/recover] admin=${req.user.username} publisher=${publisher} segment=${segment} target=${usernames.length} ok=${result && result.success}`);

    res.json({
      success: true,
      segment,
      targeted: usernames.length,
      delivered: (result && (result.successCount ?? result.sent ?? null)),
      detail: result || null
    });
  } catch (err) {
    logger.error(`[publishers/recover] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// CONFIGURACIÓN DEL SISTEMA (CBU, COMANDOS)
// ============================================

app.get('/api/admin/config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const cbuConfig = await getConfig('cbu');
    const welcomeMessage = await getConfig('welcomeMessage');
    const depositMessage = await getConfig('depositMessage');
    const canalInformativoUrl = await getConfig('canalInformativoUrl', '');
    
    res.json({
      cbu: cbuConfig || {},
      welcomeMessage: welcomeMessage || '🎉 ¡Bienvenido a la Sala de Juegos!',
      depositMessage: depositMessage || '💰 ¡Fichas cargadas!',
      canalInformativoUrl: canalInformativoUrl || ''
    });
  } catch (error) {
    console.error('Error obteniendo configuración:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/admin/canal-url', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { url } = req.body;
    const safeUrl = (url || '').trim();
    if (safeUrl) {
      try {
        const parsed = new URL(safeUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return res.status(400).json({ error: 'URL inválida. Debe comenzar con http:// o https://' });
        }
      } catch {
        return res.status(400).json({ error: 'URL inválida. Verificá que sea una URL completa y válida.' });
      }
    }
    await setConfig('canalInformativoUrl', safeUrl);
    res.json({ success: true, message: 'URL del Canal Informativo actualizada correctamente' });
  } catch (error) {
    console.error('Error guardando canal URL:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.put('/api/admin/config/cbu', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // El CBU define a dónde va la plata de los depósitos → solo el admin general.
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el administrador principal puede modificar el CBU' });
    }
    const currentCbu = await getConfig('cbu') || {};
    const newCbu = { ...currentCbu, ...req.body };
    
    await setConfig('cbu', newCbu);
    
    res.json({ success: true, message: 'CBU actualizado', cbu: newCbu });
  } catch (error) {
    console.error('Error actualizando CBU:', error);
    res.status(500).json({ error: 'Error actualizando CBU' });
  }
});

// ============================================
// BASE DE DATOS - SOLO ADMIN PRINCIPAL
// ============================================

// ELIMINADO (2026-07-08, perf #4): GET /api/admin/database — devolvía TODA la
// colección de usuarios. 0 callers (la sección Base de Datos del panel usa
// POST /api/admin/database/users). Si algo externo lo necesitara: git revert.

// ============================================
// TRANSACCIONES
// ============================================

app.get('/api/admin/transactions', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { from, to, type, username } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

    // baseQuery = fecha + username (SIN tipo). El resumen de tarjetas se calcula
    // sobre baseQuery para mostrar SIEMPRE el desglose por tipo de todo el rango,
    // independientemente del filtro de tipo que esté activo en la tabla.
    const baseQuery = {};

    // Manejo de fechas — las fechas recibidas (YYYY-MM-DD) se interpretan en
    // horario argentino (ART = UTC-3, sin DST).
    // 00:00 ART = 03:00 UTC del mismo día.
    // 23:59:59 ART = 02:59:59 UTC del día siguiente.
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (from || to) {
      baseQuery.timestamp = {};
      if (from) {
        if (!DATE_RE.test(from)) return res.status(400).json({ error: 'Formato de fecha inválido para "from" (esperado YYYY-MM-DD)' });
        // Inicio del día en Argentina: 00:00 ART = 03:00 UTC
        const fromDate = new Date(from + 'T03:00:00.000Z');
        baseQuery.timestamp.$gte = fromDate;
      }
      if (to) {
        if (!DATE_RE.test(to)) return res.status(400).json({ error: 'Formato de fecha inválido para "to" (esperado YYYY-MM-DD)' });
        // Fin del día en Argentina: 23:59:59.999 ART = inicio del día siguiente 03:00 UTC - 1ms
        const toDate = new Date(to + 'T03:00:00.000Z');
        toDate.setTime(toDate.getTime() + 24 * 60 * 60 * 1000 - 1);
        baseQuery.timestamp.$lte = toDate;
      }
    }

    // Filtrar por username si se especifica
    if (username && username.trim()) {
      // Limitar longitud y escapar caracteres especiales de regex para evitar ReDoS / injection
      const rawUsername = username.trim().substring(0, 100);
      const safeUsername = rawUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      baseQuery.username = { $regex: safeUsername, $options: 'i' };
    }

    // listQuery = baseQuery + tipo (filtra SOLO la tabla, no el resumen).
    const listQuery = { ...baseQuery };
    if (type && type !== 'all') {
      // Castear a String: sin esto un objeto ({"$ne":"x"}) se colaba como
      // operador NoSQL en el query.
      listQuery.type = String(type);
    }

    // Resumen por tipo vía aggregation sobre baseQuery (rápido, no trae documentos).
    const sumAgg = await Transaction.aggregate([
      { $match: baseQuery },
      { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);
    let deposits = 0, withdrawals = 0, bonuses = 0, refunds = 0, fireRewards = 0, referrals = 0, totalAll = 0;
    for (const g of sumAgg) {
      totalAll += g.count;
      switch (g._id) {
        case 'deposit': deposits = g.total; break;
        case 'withdrawal': withdrawals = g.total; break;
        case 'bonus': bonuses = g.total; break;
        case 'refund': refunds = g.total; break;
        case 'fire_reward': fireRewards = g.total; break;
        case 'referral_commission': referrals = g.total; break;
      }
    }

    // Saldo neto = depósitos - retiros (bonos y reembolsos no afectan)
    const summary = {
      deposits,
      withdrawals,
      bonuses,
      refunds,
      fireRewards,
      referrals,
      netBalance: deposits - withdrawals,
      totalTransactions: totalAll
    };

    // Página de la tabla (filtrada por tipo). Sólo trae `limit` documentos.
    const listTotal = await Transaction.countDocuments(listQuery);
    const totalPages = listTotal === 0 ? 0 : Math.ceil(listTotal / limit);
    const transactions = await Transaction.find(listQuery)
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      transactions,
      summary,
      page,
      totalPages,
      listTotal,
      perPage: limit,
      dateRange: { from, to }
    });
  } catch (error) {
    console.error('Error obteniendo transacciones:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// ESTADÍSTICAS
// ============================================

let _cachedAdminStats = { data: null, lastUpdate: 0 };
const _STATS_CACHE_TTL = 60000; // 60 seconds

app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const now = Date.now();
    if (_cachedAdminStats.data && now - _cachedAdminStats.lastUpdate < _STATS_CACHE_TTL) {
      return res.json(_cachedAdminStats.data);
    }
    const totalUsers = await User.countDocuments();
    const onlineUsers = await User.countDocuments({ lastLogin: { $gte: new Date(Date.now() - 5 * 60 * 1000) } });
    const totalMessages = await Message.countDocuments();
    const totalTransactions = await Transaction.countDocuments();
    
    // Transacciones de hoy
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTransactions = await Transaction.find({ timestamp: { $gte: today } }).lean();
    
    let todayDeposits = 0;
    let todayWithdrawals = 0;
    todayTransactions.forEach(t => {
      if (t.type === 'deposit') todayDeposits += t.amount;
      if (t.type === 'withdrawal') todayWithdrawals += t.amount;
    });
    
    const result = { totalUsers, onlineUsers, totalMessages, totalTransactions, todayDeposits, todayWithdrawals };
    _cachedAdminStats.data = result;
    _cachedAdminStats.lastUpdate = now;
    res.json(result);
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    if (_cachedAdminStats.data) {
      return res.json({ ..._cachedAdminStats.data, cached: true });
    }
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// DATOS - Métricas de adquisición, actividad y recurrencia
// ============================================

app.get('/api/admin/datos', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // Argentina es UTC-3 todo el año
    const ART_OFFSET_MS = 3 * 60 * 60 * 1000;

    let startUTC, endUTC, periodLabel, isSingleDay = true;

    if (req.query.dateFrom && req.query.dateTo) {
      // Rango de fechas YYYY-MM-DD en ART
      const [fy, fm, fd] = req.query.dateFrom.split('-').map(Number);
      const [ty, tm, td] = req.query.dateTo.split('-').map(Number);
      if (!fy || !fm || !fd || !ty || !tm || !td) {
        return res.status(400).json({ error: 'Formato de fecha inválido. Use YYYY-MM-DD.' });
      }
      startUTC = new Date(Date.UTC(fy, fm - 1, fd, 3, 0, 0, 0));
      endUTC   = new Date(Date.UTC(ty, tm - 1, td, 3, 0, 0, 0) + 24 * 60 * 60 * 1000 - 1);
      periodLabel = `${req.query.dateFrom} → ${req.query.dateTo}`;
      isSingleDay = false;
    } else if (req.query.date) {
      // Fecha exacta YYYY-MM-DD en ART
      const [year, month, day] = req.query.date.split('-').map(Number);
      if (!year || !month || !day) {
        return res.status(400).json({ error: 'Formato de fecha inválido. Use YYYY-MM-DD.' });
      }
      startUTC = new Date(Date.UTC(year, month - 1, day, 3, 0, 0, 0)); // ART 00:00 = UTC 03:00
      endUTC   = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000 - 1);
      periodLabel = req.query.date;
    } else {
      const period = req.query.period || 'today';
      const nowUTC = Date.now();
      const todayART = new Date(nowUTC - ART_OFFSET_MS);
      todayART.setUTCHours(0, 0, 0, 0);
      const todayStartUTC = new Date(todayART.getTime() + ART_OFFSET_MS);

      if (period === 'yesterday') {
        startUTC    = new Date(todayStartUTC.getTime() - 24 * 60 * 60 * 1000);
        endUTC      = new Date(todayStartUTC.getTime() - 1);
        periodLabel = 'Ayer';
      } else if (period === 'last7') {
        startUTC    = new Date(todayStartUTC.getTime() - 6 * 24 * 60 * 60 * 1000);
        endUTC      = new Date(todayStartUTC.getTime() + 24 * 60 * 60 * 1000 - 1);
        periodLabel = 'Últimos 7 días';
        isSingleDay = false;
      } else if (period === 'last30') {
        startUTC    = new Date(todayStartUTC.getTime() - 29 * 24 * 60 * 60 * 1000);
        endUTC      = new Date(todayStartUTC.getTime() + 24 * 60 * 60 * 1000 - 1);
        periodLabel = 'Últimos 30 días';
        isSingleDay = false;
      } else {
        // today (default)
        startUTC    = todayStartUTC;
        endUTC      = new Date(todayStartUTC.getTime() + 24 * 60 * 60 * 1000 - 1);
        periodLabel = 'Hoy';
      }
    }

    // Consultas paralelas
    const [registeredCount, depositStats, neverDepositedResult] = await Promise.all([

      // Bloque A: usuarios role:'user' creados en el período
      User.countDocuments({ createdAt: { $gte: startUTC, $lte: endUTC }, role: 'user' }),

      // Bloques B + C + D: análisis completo de depósitos
      Transaction.aggregate([
        // 1. Depósitos del período (excluye devoluciones de retiros rechazados: no son carga real)
        { $match: { type: 'deposit', 'metadata.source': { $ne: 'payout_refund' }, timestamp: { $gte: startUTC, $lte: endUTC } } },

        // 2. Agrupar por usuario: operaciones y monto en el período
        { $group: {
          _id: '$username',
          periodDepositCount:  { $sum: 1 },
          periodDepositAmount: { $sum: '$amount' }
        }},

        // 3. Buscar si el usuario tuvo depósitos ANTERIORES al período
        { $lookup: {
          from: 'transactions',
          let: { uname: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [
              { $eq: ['$type', 'deposit'] },
              { $eq: ['$username', '$$uname'] },
              { $lt: ['$timestamp', startUTC] }
            ]}}}
          ],
          as: 'priorDeposits'
        }},

        // 4. Clasificar: ¿primera vez o recurrente? ¿depositó 2+ veces en el período?
        { $addFields: {
          isFirstTime: { $eq: [{ $size: '$priorDeposits' }, 0] },
          hasMultiple: { $gte: ['$periodDepositCount', 2] }
        }},

        // 5. Totales
        { $group: {
          _id:                  null,
          totalDeposits:        { $sum: '$periodDepositCount' },
          totalAmount:          { $sum: '$periodDepositAmount' },
          uniqueDepositors:     { $sum: 1 },
          firstTimeDeposits:    { $sum: { $cond: ['$isFirstTime', '$periodDepositCount', 0] } },
          firstTimeAmount:      { $sum: { $cond: ['$isFirstTime', '$periodDepositAmount', 0] } },
          firstTimeUsers:       { $sum: { $cond: ['$isFirstTime', 1, 0] } },
          returningDeposits:    { $sum: { $cond: ['$isFirstTime', 0, '$periodDepositCount'] } },
          returningAmount:      { $sum: { $cond: ['$isFirstTime', 0, '$periodDepositAmount'] } },
          returningUsers:       { $sum: { $cond: ['$isFirstTime', 0, 1] } },
          multipleDepositUsers: { $sum: { $cond: ['$hasMultiple', 1, 0] } }
        }}
      ]),

      // Bloque A: usuarios registrados en el período que NUNCA han depositado
      User.aggregate([
        { $match: { createdAt: { $gte: startUTC, $lte: endUTC }, role: 'user' } },
        { $lookup: {
          from: 'transactions',
          let: { uname: '$username' },
          pipeline: [
            { $match: { $expr: { $and: [
              { $eq: ['$type', 'deposit'] },
              { $eq: ['$username', '$$uname'] }
            ]}}}
          ],
          as: 'allDeposits'
        }},
        { $match: { allDeposits: { $size: 0 } } },
        { $count: 'total' }
      ])
    ]);

    const ds = depositStats[0] || {
      totalDeposits: 0, totalAmount: 0, uniqueDepositors: 0,
      firstTimeDeposits: 0, firstTimeAmount: 0, firstTimeUsers: 0,
      returningDeposits: 0, returningAmount: 0, returningUsers: 0,
      multipleDepositUsers: 0
    };
    const neverDeposited = neverDepositedResult[0] ? neverDepositedResult[0].total : 0;

    // Métricas derivadas (null si sin datos suficientes)
    const conversionRate     = registeredCount > 0       ? Math.round((ds.firstTimeUsers  / registeredCount)      * 1000) / 10 : null;
    const depositFrequency   = ds.uniqueDepositors > 0   ? Math.round((ds.totalDeposits   / ds.uniqueDepositors)  * 100)  / 100 : null;
    const avgTicket          = ds.totalDeposits > 0      ? Math.round( ds.totalAmount      / ds.totalDeposits)              : null;
    const avgPerDepositor    = ds.uniqueDepositors > 0   ? Math.round( ds.totalAmount      / ds.uniqueDepositors)           : null;
    const returningPct       = ds.uniqueDepositors > 0   ? Math.round((ds.returningUsers   / ds.uniqueDepositors)  * 1000) / 10 : null;
    const repeatRate         = ds.uniqueDepositors > 0   ? Math.round((ds.multipleDepositUsers / ds.uniqueDepositors) * 1000) / 10 : null;

    // Req 10: Retención de usuarios — usuarios únicos que depositaron en los últimos N días
    const nowUTC2 = new Date();
    const retentionDays = [3, 7, 15, 30];
    const retentionCounts = await Promise.all(retentionDays.map(days => {
      const since = new Date(nowUTC2.getTime() - days * 24 * 60 * 60 * 1000);
      return Transaction.distinct('username', { type: 'deposit', timestamp: { $gte: since } })
        .then(users => users.length)
        .catch(() => null);
    }));

    const retention = {
      users3d:  retentionCounts[0],
      users7d:  retentionCounts[1],
      users15d: retentionCounts[2],
      users30d: retentionCounts[3]
    };

    res.json({
      status: 'success',
      data: {
        period: { label: periodLabel, startUTC, endUTC, isSingleDay },

        // Bloque A — Adquisición
        acquisition: {
          registeredUsers:          registeredCount,
          firstDepositUsers:        ds.firstTimeUsers,
          conversionRate,
          registeredNeverDeposited: neverDeposited
        },

        // Bloque B — Actividad de depósitos
        depositActivity: {
          totalDeposits:          ds.totalDeposits,
          uniqueDepositors:       ds.uniqueDepositors,
          firstTimeDeposits:      ds.firstTimeDeposits,
          firstTimeDepositUsers:  ds.firstTimeUsers,
          returningDeposits:      ds.returningDeposits,
          returningDepositUsers:  ds.returningUsers,
          depositFrequency
        },

        // Bloque C — Calidad económica
        economicQuality: {
          totalAmount:      ds.totalAmount,
          avgTicket,
          avgPerDepositor,
          firstTimeAmount:  ds.firstTimeAmount,
          returningAmount:  ds.returningAmount
        },

        // Bloque D — Recurrencia
        recurrence: {
          activeReturningUsers: ds.returningUsers,
          returningPct,
          multipleDepositUsers: ds.multipleDepositUsers,
          repeatRate
        },

        // Bloque E — Retención (usuarios únicos activos en últimos N días, siempre en tiempo real)
        retention
      }
    });
  } catch (error) {
    console.error('Error obteniendo datos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// CENTRAL — vistas de datos del admin
// ============================================
const ART_TZ = 'America/Argentina/Buenos_Aires';

// Ingresos diarios: total depositado por día (hora ARG), últimos N días.
app.get('/api/admin/central/ingresos', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 180);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await Transaction.aggregate([
      // Excluye las devoluciones de retiros rechazados (no son ingreso real).
      { $match: { type: 'deposit', 'metadata.source': { $ne: 'payout_refund' }, timestamp: { $gte: since } } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: ART_TZ } },
        count: { $sum: 1 },
        amount: { $sum: '$amount' },
        users: { $addToSet: '$username' }
      }},
      { $project: { _id: 0, date: '$_id', count: 1, amount: 1, uniqueUsers: { $size: '$users' } } },
      { $sort: { date: -1 } }
    ]);

    const totals = rows.reduce(function (a, r) {
      return { count: a.count + r.count, amount: a.amount + (r.amount || 0) };
    }, { count: 0, amount: 0 });
    totals.days = rows.length;
    totals.avgPerDay = rows.length ? Math.round(totals.amount / rows.length) : 0;

    res.json({ days: days, rows: rows, totals: totals });
  } catch (error) {
    console.error('Error en central/ingresos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Usuarios con app: lista de usuarios con token FCM, mostrando el token
// completo para verificar quién tiene la app y las notificaciones activas.
app.get('/api/admin/central/app-users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await User.find({
      role: 'user',
      $or: [
        { fcmToken: { $exists: true, $ne: null } },
        { 'fcmTokens.0': { $exists: true } }
      ]
    }, {
      username: 1, id: 1, phone: 1, fcmToken: 1, fcmTokens: 1, fcmTokenContext: 1,
      fcmTokenUpdatedAt: 1, notifPermission: 1, notificationPlan: 1,
      installBonusClaimed: 1, lastLogin: 1, createdAt: 1
    }).lean();

    const list = users.map(function (u) {
      const tokens = [];
      if (Array.isArray(u.fcmTokens)) {
        u.fcmTokens.forEach(function (t) {
          if (t && t.token) {
            tokens.push({
              token: t.token,
              context: t.context || null,
              notifPermission: t.notifPermission || null,
              updatedAt: t.updatedAt || null
            });
          }
        });
      }
      if (u.fcmToken && !tokens.some(function (t) { return t.token === u.fcmToken; })) {
        tokens.push({
          token: u.fcmToken,
          context: u.fcmTokenContext || null,
          notifPermission: u.notifPermission || null,
          updatedAt: u.fcmTokenUpdatedAt || null
        });
      }
      const standalone = tokens.some(function (t) { return t.context === 'standalone'; });
      const lastUpdate = tokens.reduce(function (acc, t) {
        const d = t.updatedAt ? new Date(t.updatedAt).getTime() : 0;
        return d > acc ? d : acc;
      }, 0);
      return {
        username: u.username,
        id: u.id,
        phone: u.phone || null,
        tokenCount: tokens.length,
        tokens: tokens,
        standalone: standalone,
        notifPermission: u.notifPermission || null,
        notificationPlan: u.notificationPlan || null,
        installBonusClaimed: u.installBonusClaimed === true,
        lastLogin: u.lastLogin || null,
        createdAt: u.createdAt || null,
        lastTokenUpdate: lastUpdate ? new Date(lastUpdate) : null
      };
    });

    list.sort(function (a, b) {
      const da = a.lastTokenUpdate ? new Date(a.lastTokenUpdate).getTime() : 0;
      const db = b.lastTokenUpdate ? new Date(b.lastTokenUpdate).getTime() : 0;
      return db - da;
    });

    const summary = {
      total: list.length,
      standalone: list.filter(function (u) { return u.standalone; }).length,
      granted: list.filter(function (u) { return u.notifPermission === 'granted'; }).length,
      conBono: list.filter(function (u) { return u.installBonusClaimed; }).length
    };

    res.json({ users: list, summary: summary });
  } catch (error) {
    console.error('Error en central/app-users:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Bono por instalar la app: usuarios que lo reclamaron, con su estado actual de
// app/notificaciones para detectar quién lo desinstaló. Distingue reclamos LEGACY
// ($5.000 acreditados hasta 2026-07-28) de los nuevos (cupón 100% próxima carga)
// e informa el estado del cupón (pendiente / usado y por quién).
app.get('/api/admin/central/welcome-bonus', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await User.find({ installBonusClaimed: true }, {
      username: 1, id: 1, installBonusClaimedAt: 1, fcmToken: 1, fcmTokens: 1,
      fcmTokenContext: 1, notifPermission: 1, notificationPlan: 1, lastLogin: 1,
      installBonus100Pending: 1, installBonus100GrantedAt: 1,
      installBonus100UsedAt: 1, installBonus100UsedBy: 1
    }).sort({ installBonusClaimedAt: -1 }).lean();

    const list = users.map(function (u) {
      const standalone = u.fcmTokenContext === 'standalone' ||
        (Array.isArray(u.fcmTokens) && u.fcmTokens.some(function (t) { return t && t.context === 'standalone'; }));
      const hasToken = !!u.fcmToken || (Array.isArray(u.fcmTokens) && u.fcmTokens.length > 0);
      const isCoupon = !!u.installBonus100GrantedAt;
      return {
        username: u.username,
        id: u.id,
        claimedAt: u.installBonusClaimedAt || null,
        appInstalled: standalone,
        hasToken: hasToken,
        notifPermission: u.notifPermission || null,
        notificationPlan: u.notificationPlan || null,
        lastLogin: u.lastLogin || null,
        // 'legacy' = cobró los $5.000 viejos; 'cupon' = desbloqueó el 100% próxima carga.
        bonusKind: isCoupon ? 'cupon' : 'legacy',
        coupon100Pending: u.installBonus100Pending === true,
        coupon100UsedAt: u.installBonus100UsedAt || null,
        coupon100UsedBy: u.installBonus100UsedBy || null
      };
    });

    const legacyCount = list.filter(function (u) { return u.bonusKind === 'legacy'; }).length;
    res.json({
      amount: INSTALL_BONUS_AMOUNT,
      count: list.length,
      // Solo los reclamos legacy movieron plata ($5.000 c/u).
      totalPaid: legacyCount * INSTALL_BONUS_AMOUNT,
      legacyCount: legacyCount,
      couponCount: list.length - legacyCount,
      couponPending: list.filter(function (u) { return u.coupon100Pending; }).length,
      couponUsed: list.filter(function (u) { return u.bonusKind === 'cupon' && !u.coupon100Pending; }).length,
      stillInstalled: list.filter(function (u) { return u.appInstalled; }).length,
      users: list
    });
  } catch (error) {
    console.error('Error en central/welcome-bonus:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Chequeo de MULTICUENTA EN EL MOMENTO (lo usa el panel al abrir un chat): para el
// usuario dado, cuenta cuántas OTRAS cuentas comparten su dispositivo (token FCM), su
// teléfono y su IP de registro. Devuelve los motivos (cantidad + nombres) y un flag
// `suspicious` para la alerta roja. Dispositivo/teléfono disparan con 1+; la IP (señal
// débil: mismo wifi/datos) solo dispara con 2+ otras cuentas (3+ en total).
app.get('/api/admin/users/:userId/fraud-check', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ id: String(req.params.userId) })
      .select('id username phone phoneKey registrationIp fcmToken fcmTokens role').lean();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const tokens = [];
    if (user.fcmToken) tokens.push(user.fcmToken);
    if (Array.isArray(user.fcmTokens)) {
      for (const t of user.fcmTokens) { if (t && t.token) tokens.push(t.token); }
    }
    const uniqueTokens = Array.from(new Set(tokens.filter(Boolean)));

    const SAMPLE = 8;
    const pick = (arr) => arr.slice(0, SAMPLE).map(o => ({ id: o.id, username: o.username, isBlocked: !!o.isBlocked }));
    const reasons = [];

    // Dispositivo (token FCM compartido) — señal fuerte (mismo celular físico).
    if (uniqueTokens.length) {
      const others = await User.find({
        role: 'user', id: { $ne: user.id },
        $or: [{ fcmToken: { $in: uniqueTokens } }, { 'fcmTokens.token': { $in: uniqueTokens } }]
      }).select('id username isBlocked').limit(50).lean();
      if (others.length) reasons.push({ type: 'device', label: 'el mismo dispositivo', strong: true, count: others.length, accounts: pick(others) });
    }

    // Teléfono compartido (por clave normalizada si existe, si no por el teléfono) — señal fuerte.
    if (user.phoneKey || user.phone) {
      const orq = [];
      if (user.phoneKey) orq.push({ phoneKey: user.phoneKey });
      if (user.phone) orq.push({ phone: user.phone });
      const others = await User.find({
        role: 'user', id: { $ne: user.id }, $or: orq
      }).select('id username isBlocked').limit(50).lean();
      if (others.length) reasons.push({ type: 'phone', label: 'el mismo teléfono', strong: true, count: others.length, accounts: pick(others) });
    }

    // IP de registro compartida — señal débil (mismo wifi/datos del celu).
    if (user.registrationIp) {
      const others = await User.find({
        role: 'user', id: { $ne: user.id }, registrationIp: user.registrationIp
      }).select('id username isBlocked').limit(50).lean();
      if (others.length) reasons.push({ type: 'ip', label: 'la misma IP de registro', strong: false, count: others.length, accounts: pick(others) });
    }

    const strongHit = reasons.some(r => r.strong && r.count >= 1);
    const manyIp = reasons.some(r => r.type === 'ip' && r.count >= 2);
    res.json({ suspicious: strongHit || manyIp, reasons });
  } catch (error) {
    console.error('Error en fraud-check:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Cuentas sospechosas: agrupa usuarios por phone / registrationIp / fcmToken
// para detectar posibles multicuentas creadas para abusar del bono de instalación.
// Solo reporta grupos con 2+ cuentas; el admin revisa y decide si bloquear.
// NOTA: registrationIp/UserAgent solo se capturan desde el deploy del fix
// anti-multicuenta — usuarios viejos saldrán con ese campo en null.
app.get('/api/admin/suspicious-accounts', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const minBonusOnly = req.query.bonusOnly === '1' || req.query.bonusOnly === 'true';
    const matchBase = { role: 'user' };
    if (minBonusOnly) matchBase.installBonusClaimed = true;

    // 1) Agrupados por phone (ignorando null/vacío).
    const byPhoneRaw = await User.aggregate([
      { $match: { ...matchBase, phone: { $ne: null, $exists: true } } },
      { $group: {
        _id: '$phone',
        count: { $sum: 1 },
        users: { $push: {
          username: '$username',
          id: '$id',
          installBonusClaimed: '$installBonusClaimed',
          installBonusClaimedAt: '$installBonusClaimedAt',
          createdAt: '$createdAt',
          isBlocked: '$isBlocked'
        } }
      } },
      { $match: { count: { $gte: 2 } } },
      { $sort: { count: -1 } },
      { $limit: 200 }
    ]);
    const byPhone = byPhoneRaw.map(g => ({
      phone: g._id,
      count: g.count,
      bonusClaimedCount: g.users.filter(u => u.installBonusClaimed === true).length,
      users: g.users
    }));

    // 2) Agrupados por registrationIp (ignorando null).
    const byIpRaw = await User.aggregate([
      { $match: { ...matchBase, registrationIp: { $ne: null, $exists: true } } },
      { $group: {
        _id: '$registrationIp',
        count: { $sum: 1 },
        users: { $push: {
          username: '$username',
          id: '$id',
          phone: '$phone',
          installBonusClaimed: '$installBonusClaimed',
          installBonusClaimedAt: '$installBonusClaimedAt',
          createdAt: '$createdAt',
          isBlocked: '$isBlocked'
        } }
      } },
      { $match: { count: { $gte: 2 } } },
      { $sort: { count: -1 } },
      { $limit: 200 }
    ]);
    const byIp = byIpRaw.map(g => ({
      registrationIp: g._id,
      count: g.count,
      bonusClaimedCount: g.users.filter(u => u.installBonusClaimed === true).length,
      users: g.users
    }));

    // 3) Agrupados por fcmToken — combina el campo singular legacy y el array.
    // Hace dos unwinds (uno virtual del singular vía $cond) y agrupa por token.
    const byTokenRaw = await User.aggregate([
      { $match: matchBase },
      { $project: {
        id: 1, username: 1, phone: 1,
        installBonusClaimed: 1, installBonusClaimedAt: 1, createdAt: 1, isBlocked: 1,
        allTokens: {
          $setUnion: [
            { $cond: [{ $and: [{ $ne: ['$fcmToken', null] }, { $ne: ['$fcmToken', ''] }] }, ['$fcmToken'], []] },
            { $ifNull: [{ $map: { input: '$fcmTokens', as: 't', in: '$$t.token' } }, []] }
          ]
        }
      } },
      { $unwind: '$allTokens' },
      { $match: { allTokens: { $nin: [null, ''] } } },
      { $group: {
        _id: '$allTokens',
        count: { $sum: 1 },
        users: { $push: {
          username: '$username',
          id: '$id',
          phone: '$phone',
          installBonusClaimed: '$installBonusClaimed',
          installBonusClaimedAt: '$installBonusClaimedAt',
          createdAt: '$createdAt',
          isBlocked: '$isBlocked'
        } }
      } },
      { $match: { count: { $gte: 2 } } },
      { $sort: { count: -1 } },
      { $limit: 200 }
    ]);
    const byFcmToken = byTokenRaw.map(g => ({
      fcmToken: g._id ? (String(g._id).slice(0, 12) + '…' + String(g._id).slice(-8)) : null,
      fcmTokenFull: g._id,
      count: g.count,
      bonusClaimedCount: g.users.filter(u => u.installBonusClaimed === true).length,
      users: g.users
    }));

    const summary = {
      groupsByPhone: byPhone.length,
      groupsByIp: byIp.length,
      groupsByFcmToken: byFcmToken.length,
      totalUsersAffected: new Set([
        ...byPhone.flatMap(g => g.users.map(u => u.id)),
        ...byIp.flatMap(g => g.users.map(u => u.id)),
        ...byFcmToken.flatMap(g => g.users.map(u => u.id))
      ]).size
    };

    res.json({
      filter: { bonusOnly: minBonusOnly },
      summary,
      byPhone,
      byIp,
      byFcmToken
    });
  } catch (error) {
    console.error('Error en suspicious-accounts:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Reembolsos: cuánta plata reclama la gente en reembolsos diarios, semanales
// y mensuales — totales por tipo y por ventana (24h / 7d / 30d / histórico).
app.get('/api/admin/reembolsos', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const now = Date.now();
    const d1  = new Date(now - 24 * 60 * 60 * 1000);
    const d7  = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const d30 = new Date(now - 30 * 24 * 60 * 60 * 1000);

    // Buckets por tipo y ventana, calculados en Mongo — no se trae toda la
    // colección de reembolsos a Node.
    const [agg, recent] = await Promise.all([
      RefundClaim.aggregate([
        { $group: {
          _id: '$type',
          allCount:  { $sum: 1 },
          allAmount: { $sum: '$amount' },
          d30Count:  { $sum: { $cond: [{ $gte: ['$claimedAt', d30] }, 1, 0] } },
          d30Amount: { $sum: { $cond: [{ $gte: ['$claimedAt', d30] }, '$amount', 0] } },
          d7Count:   { $sum: { $cond: [{ $gte: ['$claimedAt', d7] }, 1, 0] } },
          d7Amount:  { $sum: { $cond: [{ $gte: ['$claimedAt', d7] }, '$amount', 0] } },
          d1Count:   { $sum: { $cond: [{ $gte: ['$claimedAt', d1] }, 1, 0] } },
          d1Amount:  { $sum: { $cond: [{ $gte: ['$claimedAt', d1] }, '$amount', 0] } }
        }}
      ]),
      RefundClaim.find({}, {
        username: 1, type: 1, amount: 1, netAmount: 1, percentage: 1, claimedAt: 1
      }).sort({ claimedAt: -1 }).limit(120).lean()
    ]);

    const blank = function () { return { count: 0, amount: 0 }; };
    const types = {
      daily:   { d1: blank(), d7: blank(), d30: blank(), all: blank() },
      weekly:  { d1: blank(), d7: blank(), d30: blank(), all: blank() },
      monthly: { d1: blank(), d7: blank(), d30: blank(), all: blank() }
    };
    let total = 0;
    agg.forEach(function (g) {
      const t = types[g._id];
      if (!t) return;
      t.d1  = { count: g.d1Count  || 0, amount: g.d1Amount  || 0 };
      t.d7  = { count: g.d7Count  || 0, amount: g.d7Amount  || 0 };
      t.d30 = { count: g.d30Count || 0, amount: g.d30Amount || 0 };
      t.all = { count: g.allCount || 0, amount: g.allAmount || 0 };
      total += g.allCount || 0;
    });

    res.json({
      types: types,
      total: total,
      recent: recent
    });
  } catch (error) {
    console.error('Error en admin/reembolsos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// NUEVO PANEL DE ADMIN - ENDPOINTS ADICIONALES
// ============================================

// Cambiar contraseña de usuario (admin) - CON PERMISOS POR ROL
app.post('/api/admin/change-password', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    const adminRole = req.user.role;
    
    if (!userId || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Datos inválidos. La contraseña debe tener al menos 6 caracteres.' });
    }
    
    const user = await User.findOne({ id: userId });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    // PERMISOS POR ROL:
    // - Admin general: puede cambiar contraseña de TODOS incluyendo admins
    // - Admin depositor: puede cambiar contraseña de usuarios pero NO de admins
    // - Admin withdrawer: NO puede cambiar contraseñas
    
    if (adminRole === 'withdrawer') {
      return res.status(403).json({ error: 'No tienes permiso para cambiar contraseñas' });
    }
    
    if (adminRole === 'depositor' && user.role !== 'user') {
      return res.status(403).json({ error: 'Solo puedes cambiar contraseñas de usuarios, no de administradores' });
    }
    
    user.password = newPassword;
    user.passwordChangedAt = new Date();
    await user.save();
    
    // Solo enviar mensaje y sincronizar con JUGAYGANA si el objetivo es un usuario regular (no admin)
    if (user.role === 'user') {
      // Enviar mensaje al usuario
      await Message.create({
        id: uuidv4(),
        senderId: req.user.userId,
        senderUsername: req.user.username,
        senderRole: 'admin',
        receiverId: userId,
        receiverRole: 'user',
        content: `🔑 Tu contraseña ha sido cambiada por un administrador.\n\nTu nueva contraseña es: ${newPassword}\n\nPor seguridad, te recomendamos cambiarla después de iniciar sesión.`,
        type: 'text',
        timestamp: new Date(),
        read: false
      });
      
      // Notificar por socket
      const userSocket = connectedUsers.get(userId);
      if (userSocket) {
        userSocket.emit('new_message', {
          senderId: req.user.userId,
          senderUsername: req.user.username,
          content: 'Tu contraseña ha sido cambiada por un administrador.',
          timestamp: new Date()
        });
      }

      await syncPasswordToJugaygana(user, newPassword, `admin-change-password by ${req.user.username}`);
    } else {
      // Para admins: solo cambiar localmente, NO sincronizar con JUGAYGANA
      console.log(`✅ [Admin] Contraseña de admin cambiada localmente para: ${user.username}`);
    }
    
    res.json({ success: true, message: 'Contraseña cambiada correctamente' });
  } catch (error) {
    console.error('Error cambiando contraseña:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Cambiar contraseña propia del admin logueado (sin tocar JUGAYGANA)
app.post('/api/admin/change-own-password', authMiddleware, async (req, res) => {
  // Cualquier rol staff (admin / depositor / withdrawer / publisher_admin) puede
  // cambiar SU propia contraseña con este endpoint. No se usa adminMiddleware
  // porque ése rechaza publisher_admin — y publisher_admin también necesita
  // cambiar su contraseña desde el panel.
  const STAFF_ROLES = ['admin', 'depositor', 'withdrawer', 'publisher_admin'];
  if (!STAFF_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Acceso denegado.' });
  }
  try {
    const { currentPassword, newPassword } = req.body;
    const adminUserId = req.user.userId;

    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Datos inválidos. La contraseña debe tener al menos 6 caracteres.' });
    }

    const admin = await User.findOne({ id: adminUserId });
    if (!admin) {
      return res.status(404).json({ error: 'Admin no encontrado' });
    }

    // Verificar contraseña actual
    const isMatch = await bcrypt.compare(currentPassword, admin.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'La contraseña actual es incorrecta' });
    }

    admin.password = newPassword;
    admin.passwordChangedAt = new Date();
    admin.mustChangePassword = false;
    await admin.save();

    logger.info(`Admin ${admin.username} cambió su propia contraseña`);
    res.json({ success: true, message: 'Contraseña cambiada correctamente' });
  } catch (error) {
    console.error('Error cambiando contraseña de admin:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// BLOQUEO / DESBLOQUEO DE USUARIOS
// ============================================

app.post('/api/admin/users/:id/block', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    // Pueden bloquear: admin general y depositor (los que están en el chat).
    // Withdrawer no, para no darle a una sola persona poder de cortar accesos.
    if (!['admin', 'depositor'].includes(req.user.role)) {
      return res.status(403).json({ error: 'No tenés permiso para bloquear usuarios.' });
    }

    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
      return res.status(400).json({ error: 'El motivo es obligatorio (mínimo 5 caracteres).' });
    }

    const user = await User.findOne({ id });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    if (isAdminRole(user.role)) {
      return res.status(403).json({ error: 'No se pueden bloquear cuentas administrativas.' });
    }

    user.isBlocked = true;
    user.blockReason = reason.trim().slice(0, MAX_BLOCK_REASON_LENGTH);
    user.blockedAt = new Date();
    user.blockedBy = req.user.username;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    logger.info(`Admin ${req.user.username} bloqueó a ${user.username}: ${user.blockReason}`);
    res.json({ success: true, message: `Usuario ${user.username} bloqueado.` });
  } catch (e) {
    logger.error(`Error en block: ${e.message}`);
    res.status(500).json({ error: 'Error del servidor.' });
  }
});

app.post('/api/admin/users/:id/unblock', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    if (!['admin', 'depositor'].includes(req.user.role)) {
      return res.status(403).json({ error: 'No tenés permiso para desbloquear usuarios.' });
    }
    const user = await User.findOne({ id });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    user.isBlocked = false;
    user.blockReason = null;
    user.blockedAt = null;
    user.blockedBy = null;
    await user.save();

    logger.info(`Admin ${req.user.username} desbloqueó a ${user.username}`);
    res.json({ success: true, message: `Usuario ${user.username} desbloqueado.` });
  } catch (e) {
    logger.error(`Error en unblock: ${e.message}`);
    res.status(500).json({ error: 'Error del servidor.' });
  }
});

// Marca/desmarca el teléfono de un usuario como verificado. Permite habilitar
// retiros sin pasar por el SMS (cuentas de prueba, soporte manual). Body:
// { verified: boolean } — por defecto true.
app.post('/api/admin/users/:id/verify-phone', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const verified = req.body.verified !== false; // default: true

    const user = await User.findOne({ id });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    user.phoneVerified = verified;
    if (verified) {
      user.phoneVerificationPending = false;
      user.smsConsent = true;
    }
    await user.save();

    logger.info(`Admin ${req.user.username} ${verified ? 'verificó' : 'desverificó'} el teléfono de ${user.username}`);
    res.json({
      success: true,
      message: `Teléfono de ${user.username} ${verified ? 'verificado' : 'marcado como NO verificado'}.`,
      phoneVerified: user.phoneVerified
    });
  } catch (e) {
    logger.error(`Error en verify-phone admin: ${e.message}`);
    res.status(500).json({ error: 'Error del servidor.' });
  }
});

// Activa/desactiva el inicio de sesión sin clave ni SMS para un cliente.
// Con esto activado, el cliente entra solo escribiendo su usuario.
app.post('/api/admin/users/:id/login-without-password', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const enabled = req.body && req.body.enabled === true;

    const user = await User.findOne({ id });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    if (isAdminRole(user.role)) {
      return res.status(403).json({ error: 'No aplicable a cuentas administrativas.' });
    }

    user.loginWithoutPassword = enabled;
    await user.save();

    logger.info(`Admin ${req.user.username} ${enabled ? 'activó' : 'desactivó'} el inicio sin clave para ${user.username}`);
    res.json({
      success: true,
      message: `Inicio sin clave ${enabled ? 'ACTIVADO' : 'desactivado'} para ${user.username}.`,
      loginWithoutPassword: enabled
    });
  } catch (e) {
    logger.error(`Error en login-without-password: ${e.message}`);
    res.status(500).json({ error: 'Error del servidor.' });
  }
});

// Enviar chat a cargas (antes "pagos")
app.post('/api/admin/send-to-payments', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'Usuario no especificado' });
    }
    
    // Todos los admins (admin, depositor, withdrawer) pueden enviar a cargas
    
    // Actualizar estado del chat a CARGAS (antes "payments")
    await ChatStatus.findOneAndUpdate(
      { userId },
      { 
        status: 'payments',
        category: 'payments',
        assignedTo: null,
        updatedAt: new Date()
      },
      { upsert: true }
    );
    
    // Enviar mensaje al usuario
    await Message.create({
      id: uuidv4(),
      senderId: req.user.userId,
      senderUsername: req.user.username,
      senderRole: 'admin',
      receiverId: userId,
      receiverRole: 'user',
      content: '💳 Tu chat ha sido transferido al departamento de PAGOS. Un agente especializado te atenderá pronto.\n\nPor favor para agilizar el tiempo envie monto a retirar y cvu por favor!',
      type: 'text',
      timestamp: new Date(),
      read: false
    });
    
    // Notificar a admins
    notifyAdmins('chat_moved', { userId, to: 'payments', by: req.user.username });
    
    res.json({ success: true, message: 'Chat enviado a cargas' });
  } catch (error) {
    console.error('Error enviando a cargas:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Enviar chat de vuelta a Abiertos (desde Pagos o Cerrados)
app.post('/api/admin/send-to-open', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'Usuario no especificado' });
    }

    // Withdrawer no puede enviar a abiertos
    if (req.user.role === 'withdrawer') {
      return res.status(403).json({ error: 'No tienes permisos para esta acción' });
    }

    // Al mover a Abiertos: resetear categoría a 'cargas' (pool general)
    // y liberar asignación para que cualquier agente pueda tomar el chat
    await ChatStatus.findOneAndUpdate(
      { userId },
      {
        status: 'open',
        category: 'cargas',
        assignedTo: null,
        closedAt: null,
        closedBy: null,
        updatedAt: new Date()
      },
      { upsert: true }
    );

    notifyAdmins('chat_moved', { userId, to: 'open', by: req.user.username });

    res.json({ success: true, message: 'Chat enviado a abiertos' });
  } catch (error) {
    console.error('Error enviando a abiertos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Derivar un chat a la sección COMUNIDAD (desde Abiertos). La atiende el rol 'comunidad'.
// Regla: si el cliente YA tiene la etiqueta 'comunidad', no se puede derivar de nuevo.
app.post('/api/admin/send-to-community', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Usuario no especificado' });

    // Withdrawer no deriva a comunidad (solo maneja pagos).
    if (req.user.role === 'withdrawer') {
      return res.status(403).json({ error: 'No tenés permisos para esta acción' });
    }

    // Bloqueo: si el cliente ya está etiquetado 'comunidad', no se re-deriva.
    const u = await User.findOne({ id: userId }).select('tags username').lean();
    if (u && Array.isArray(u.tags) && u.tags.includes('comunidad')) {
      return res.status(400).json({ error: 'El cliente ya tiene la etiqueta Comunidad: no se puede derivar de nuevo.' });
    }

    await ChatStatus.findOneAndUpdate(
      { userId },
      { status: 'comunidad', category: 'cargas', assignedTo: null, updatedAt: new Date() },
      { upsert: true }
    );

    // Mensaje editable al cliente (/sys_community). Si se vacía el comando, no se envía.
    const content = await renderSystemCommand(
      '/sys_community',
      '🤝 Te derivamos a nuestro equipo de Comunidad. En breve te atendemos por aquí. ¡Gracias!',
      {}
    );
    if (content) {
      await Message.create({
        id: uuidv4(), senderId: req.user.userId, senderUsername: req.user.username, senderRole: 'admin',
        receiverId: userId, receiverRole: 'user', content, type: 'text', timestamp: new Date(), read: false
      });
    }

    notifyAdmins('chat_moved', { userId, to: 'comunidad', by: req.user.username });
    res.json({ success: true, message: 'Chat derivado a Comunidad' });
  } catch (error) {
    console.error('Error derivando a comunidad:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Cerrar chat - SOLO INTERNO (no notifica al cliente)
app.post('/api/admin/close-chat', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId, notifyClient = false, isPaymentsTab = false } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'Usuario no especificado' });
    }
    
    // SLA: registrar la espera en curso como "sin responder" ANTES de cerrar
    // (el cierre pone status:'closed' y perdería la cola cargas/pagos real).
    await delayClockResolve(userId, { responded: false });

    // Actualizar estado del chat
    await ChatStatus.findOneAndUpdate(
      { userId },
      {
        status: 'closed',
        assignedTo: null,
        closedAt: new Date(),
        closedBy: req.user.userId,
        updatedAt: new Date()
      },
      { upsert: true }
    );
    
    // Fix #3: Crear mensaje de sistema interno (solo visible para admins, persiste en historial)
    await Message.create({
      id: uuidv4(),
      senderId: req.user.userId,
      senderUsername: req.user.username,
      senderRole: req.user.role || 'admin',
      receiverId: userId,
      receiverRole: 'user',
      content: `Chat cerrado por: ${req.user.username}. Puedes seguir respondiendo si el usuario escribe. El chat se reabrirá automáticamente si el cliente envía un mensaje.`,
      type: 'system',
      adminOnly: true,
      read: true,
      timestamp: new Date()
    });
    
    // Notificar a admins (siempre, es interno)
    notifyAdmins('chat_closed', { userId, by: req.user.username, adminId: req.user.userId, isPaymentsTab });

    res.json({ success: true, message: 'Chat cerrado correctamente', closedBy: req.user.username });
  } catch (error) {
    console.error('Error cerrando chat:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// CONTROL DE DEMORAS DE RESPUESTA EN CHATS (reporte SLA) — solo admin general
// ============================================
app.get('/api/admin/chat-delays', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin general puede ver las demoras' });
    }

    const thrCargas = await getChatDelayThreshold('cargas');
    const thrPagos = await getChatDelayThreshold('pagos');

    // Filtros del historial
    const { from, to, agent, status, category, page = 1, limit = 50 } = req.query;
    const minDelay = parseInt(req.query.minDelay, 10); // en segundos

    const q = {};
    if (status === 'responded' || status === 'unanswered') q.status = status;
    if (category === 'cargas' || category === 'pagos') q.category = category;
    if (agent) q.respondedByUsername = agent;
    if (Number.isFinite(minDelay) && minDelay > 0) q.delaySeconds = { $gte: minDelay };
    if (from || to) {
      q.userMessageAt = {};
      if (from) q.userMessageAt.$gte = new Date(from);
      if (to) q.userMessageAt.$lt = new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000); // 'to' inclusivo (todo el día)
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    // Historial paginado de demoras
    const [delays, total, summaryAgg] = await Promise.all([
      ChatDelay.find(q)
        .sort({ userMessageAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      ChatDelay.countDocuments(q),
      ChatDelay.aggregate([
        { $match: q },
        { $group: {
          _id: null,
          count: { $sum: 1 },
          avgDelay: { $avg: '$delaySeconds' },
          worstDelay: { $max: '$delaySeconds' },
          unanswered: { $sum: { $cond: [{ $eq: ['$status', 'unanswered'] }, 1, 0] } }
        } }
      ])
    ]);

    // "Esperando ahora": clientes con el reloj corriendo, en chats abiertos o de
    // pagos. Cada uno se compara contra el umbral de SU cola (cargas vs pagos).
    const now = Date.now();
    const waitingDocs = await ChatStatus.find({
      status: { $in: ['open', 'payments'] },
      pendingSince: { $ne: null }
    })
      .select('userId username pendingSince pendingPreview pendingType assignedTo category status')
      .sort({ pendingSince: 1 })
      .limit(300)
      .lean();

    let waiting = waitingDocs.map(d => {
      const queue = deriveChatQueue(d);
      return {
        userId: d.userId,
        username: d.username,
        preview: d.pendingPreview || '',
        type: d.pendingType || 'text',
        category: queue,
        waitingSeconds: Math.round((now - new Date(d.pendingSince).getTime()) / 1000),
        since: d.pendingSince,
        assignedTo: d.assignedTo || null
      };
    }).filter(w => w.waitingSeconds >= (w.category === 'pagos' ? thrPagos : thrCargas));

    // Aplicar el filtro de cola también a "esperando ahora" si se pidió uno.
    if (category === 'cargas' || category === 'pagos') {
      waiting = waiting.filter(w => w.category === category);
    }

    const s = summaryAgg[0] || { count: 0, avgDelay: 0, worstDelay: 0, unanswered: 0 };

    res.json({
      thresholdSeconds: thrCargas,
      thresholdPagosSeconds: thrPagos,
      waiting,
      delays,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
      summary: {
        count: s.count || 0,
        avgDelaySeconds: Math.round(s.avgDelay || 0),
        worstDelaySeconds: s.worstDelay || 0,
        unansweredCount: s.unanswered || 0,
        waitingNowCount: waiting.length
      }
    });
  } catch (error) {
    console.error('Error obteniendo demoras de chat:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Configurar el umbral de demora (en minutos desde el front; se guarda en segundos)
app.post('/api/admin/chat-delays/config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin general puede configurar el umbral' });
    }
    const out = {};
    const validRange = (n) => Number.isFinite(n) && n >= 10 && n <= 86400;

    if (req.body.thresholdSeconds != null) {
      const n = parseInt(req.body.thresholdSeconds, 10);
      if (!validRange(n)) return res.status(400).json({ error: 'Umbral de cargas inválido (10s a 24h)' });
      await setConfig('chatDelayThresholdSeconds', String(n));
      out.thresholdSeconds = n;
    }
    if (req.body.thresholdPagosSeconds != null) {
      const n = parseInt(req.body.thresholdPagosSeconds, 10);
      if (!validRange(n)) return res.status(400).json({ error: 'Umbral de pagos inválido (10s a 24h)' });
      await setConfig('chatDelayThresholdPagosSeconds', String(n));
      out.thresholdPagosSeconds = n;
    }
    if (Object.keys(out).length === 0) {
      return res.status(400).json({ error: 'No se envió ningún umbral' });
    }
    res.json({ success: true, ...out });
  } catch (error) {
    console.error('Error guardando umbral de demoras:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Obtener conversaciones para el nuevo panel
// OPTIMIZADO: Una sola query con agregación
app.get('/api/admin/conversations', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    let { status = 'open' } = req.query;
    
    const userRole = req.user.role;
    
    // Depositor: ve abiertos/cerrados; NO pagos NI comunidad.
    if (userRole === 'depositor' && (status === 'payments' || status === 'comunidad')) {
      return res.status(403).json({ error: 'Acceso denegado.' });
    }
    // Comunidad: ve abiertos/cerrados/comunidad; NO pagos.
    if (userRole === 'comunidad' && status === 'payments') {
      return res.status(403).json({ error: 'Acceso denegado. Comunidad no puede ver pagos.' });
    }

    if (userRole === 'withdrawer' && status !== 'payments') {
      return res.status(403).json({ error: 'Acceso denegado. Los withdrawers solo pueden ver chats de pagos.' });
    }
    
    // AGREGACIÓN OPTIMIZADA: Todo en una sola query
    const pipeline = [
      { $match: { status } },
      { $sort: { lastMessageAt: -1 } },
      { $limit: 100 },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: 'id',
          as: 'user'
        }
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: false } },
      {
        // Cruce con campañas: trae el publicista del que vino el usuario
        // (User.acquisitionCampaign === Campaign.code) para distinguir en la
        // lista de chats qué clientes llegaron por una pauta.
        $lookup: {
          from: 'campaigns',
          localField: 'user.acquisitionCampaign',
          foreignField: 'code',
          as: 'campaign'
        }
      },
      {
        $lookup: {
          from: 'messages',
          let: { uid: '$userId' },
          pipeline: [
            { $match: { $expr: { $and: [
              { $eq: ['$receiverId', 'admin'] },
              { $eq: ['$senderId', '$$uid'] },
              { $eq: ['$read', false] }
            ]}}},
            { $count: 'count' }
          ],
          as: 'unread'
        }
      },
      {
        $lookup: {
          from: 'messages',
          let: { uid: '$userId' },
          pipeline: [
            { $match: { $expr: { $or: [
              { $eq: ['$senderId', '$$uid'] },
              { $eq: ['$receiverId', '$$uid'] }
            ]}}},
            { $sort: { timestamp: -1 } },
            { $limit: 1 },
            { $project: { content: 1, timestamp: 1 } }
          ],
          as: 'lastMsg'
        }
      },
      {
        $project: {
          userId: 1,
          username: '$user.username',
          balance: { $ifNull: ['$user.balance', 0] },
          online: { $gt: [{ $ifNull: ['$user.lastLogin', new Date(0)] }, { $subtract: [new Date(), 300000] }] },
          unread: { $ifNull: [{ $arrayElemAt: ['$unread.count', 0] }, 0] },
          lastMessage: { $arrayElemAt: ['$lastMsg.content', 0] },
          lastMessageAt: { $ifNull: ['$lastMessageAt', '$updatedAt', new Date()] },
          status: 1,
          acquisitionCampaign: { $ifNull: ['$user.acquisitionCampaign', null] },
          publisher: { $ifNull: [{ $arrayElemAt: ['$campaign.publisher', 0] }, null] },
          tags: { $ifNull: ['$user.tags', []] }
        }
      }
    ];
    
    const conversations = await ChatStatus.aggregate(pipeline);
    
    res.json({ conversations });
  } catch (error) {
    console.error('Error obteniendo conversaciones:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Obtener información de usuario específico
app.get('/api/users/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Only admins or the user themselves can fetch a user profile
    const adminRoles = ['admin', 'depositor', 'withdrawer', 'comunidad'];
    if (!adminRoles.includes(req.user.role) && req.user.userId !== userId) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    
    const user = await User.findOne({ id: userId }).select('-password').lean();
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    // Si el usuario llegó por un link de pauta, resolver el nombre del
    // publicista para que el panel lo muestre al lado del nombre en el chat.
    if (user.acquisitionCampaign) {
      try {
        const campaign = await Campaign.findOne({ code: user.acquisitionCampaign })
          .select('publisher name').lean();
        if (campaign) {
          user.acquisitionPublisher = campaign.publisher || null;
          user.acquisitionCampaignName = campaign.name || null;
        }
      } catch (e) { /* no bloquear la respuesta del perfil por esto */ }
    }

    // Fueguito: exponer al panel admin si el cliente tiene pendiente el premio
    // "100% en próxima carga" (hito día 15) para que el operador lo vea y pueda
    // marcarlo como aplicado. Solo para roles de staff (no se filtra al cliente).
    if (adminRoles.includes(req.user.role)) {
      try {
        const fs = await FireStreak.findOne({ userId }).select('pendingNextLoadBonus streak').lean();
        user.fireNextLoadBonus = !!(fs && fs.pendingNextLoadBonus);
        user.fireStreak = fs ? (fs.streak || 0) : 0;
      } catch (e) { /* no bloquear el perfil por esto */ }
    }

    res.json({ user });
  } catch (error) {
    console.error('Error obteniendo usuario:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Fueguito: marcar el premio "100% en próxima carga" (hito día 15) como aplicado.
// Lo usan los operadores cuando ya le dieron el 100% al cliente manualmente, para
// que el cartel deje de aparecer y no se pueda reclamar de nuevo. Esto cierra el
// bug donde el flag pendingNextLoadBonus nunca se limpiaba (bono 100% infinito).
app.post('/api/admin/users/:userId/fire-next-load-bonus/apply', authMiddleware, depositorMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    // Limpieza atómica: solo modifica si realmente estaba pendiente (evita
    // dobles marcas concurrentes de dos operadores sobre el mismo cliente).
    const result = await FireStreak.updateOne(
      { userId, pendingNextLoadBonus: true },
      { $set: { pendingNextLoadBonus: false } }
    );
    if (!result.matchedCount) {
      return res.status(400).json({ error: 'El cliente no tiene un bono de próxima carga pendiente.' });
    }
    logger.info(`[fire] pendingNextLoadBonus marcado como aplicado manualmente user=${userId} agent=${req.user?.username}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error aplicando fueguito next-load bonus:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// GESTIÓN DE CBU
// ============================================

// Obtener CBU actual
app.get('/api/admin/cbu', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const cbuConfig = await getConfig('cbu');
    res.json(cbuConfig || { bank: '', titular: '', number: '', alias: '' });
  } catch (error) {
    console.error('Error obteniendo CBU:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Actualizar CBU
app.post('/api/admin/cbu', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { bank, titular, number, alias } = req.body;
    
    if (!number || number.length < 10) {
      return res.status(400).json({ error: 'CBU inválido' });
    }
    
    await setConfig('cbu', { bank, titular, number, alias });
    res.json({ success: true, message: 'CBU actualizado correctamente' });
  } catch (error) {
    console.error('Error actualizando CBU:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// BANCO AUTOMÁTICO (hgcash) — config y movimientos (solo admin general)
// ============================================
app.get('/api/admin/hgcash/config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin general' });
    const cfg = await getHgcashConfig();
    res.json({
      config: cfg,
      // No exponemos el secreto; sólo si está cargado (para que el panel avise).
      secretConfigured: !!process.env.HGCASH_WEBHOOK_SECRET,
      aiEnabled: comprobanteAi.isEnabled(),
      webhookUrl: '/api/hgcash/webhook'
    });
  } catch (error) {
    console.error('Error obteniendo config hgcash:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/admin/hgcash/config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin general' });
    const cur = await getHgcashConfig();
    const b = req.body || {};
    const mode = (b.mode === 'auto') ? 'auto' : 'shadow';
    const windowMinutes = Math.min(1440, Math.max(1, parseInt(b.windowMinutes, 10) || cur.windowMinutes || 60));
    const next = {
      enabled: typeof b.enabled === 'boolean' ? b.enabled : cur.enabled,
      cbu: b.cbu !== undefined ? String(b.cbu).trim() : cur.cbu,
      accountId: b.accountId !== undefined ? String(b.accountId).trim() : cur.accountId,
      accountName: b.accountName !== undefined ? String(b.accountName).trim() : (cur.accountName || ''),
      mode,
      windowMinutes,
      raceWindowMinutes: Math.min(120, Math.max(1, parseInt(b.raceWindowMinutes, 10) || cur.raceWindowMinutes || 10)),
      currency: b.currency ? String(b.currency).toUpperCase().slice(0, 3) : (cur.currency || 'ARS'),
      acceptStatuses: Array.isArray(b.acceptStatuses) && b.acceptStatuses.length
        ? b.acceptStatuses.map(s => String(s).toLowerCase().trim()).filter(Boolean)
        : (cur.acceptStatuses || ['done'])
    };
    await setConfig('hgcash', next);
    logger.info(`[hgcash] config actualizada por ${req.user.username}: enabled=${next.enabled} mode=${next.mode} cbu=${next.cbu ? '***' + String(next.cbu).slice(-4) : 'vacío'}`);
    res.json({ success: true, config: next });
  } catch (error) {
    console.error('Error guardando config hgcash:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Movimientos recientes del banco (para auditar matches y reconciliar).
app.get('/api/admin/hgcash/movements', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin general' });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const q = {};
    if (req.query.status) q.matchStatus = String(req.query.status);
    const total = await BankMovement.countDocuments(q);
    const movements = await BankMovement.find(q)
      .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();

    // Enriquecer los movimientos SALIENTES (pagos) con el usuario al que se pagó:
    // el cash-out usa externalID = PendingPayout.id y guarda el hgTransactionId en el payout.
    try {
      const out = movements.filter(m => m.direction === 'Outbound');
      const outIds = out.map(m => m.externalId).filter(Boolean);
      const outHgIds = out.map(m => m.movementId).filter(Boolean);
      if (outIds.length || outHgIds.length) {
        const or = [];
        if (outIds.length) or.push({ id: { $in: outIds } });
        if (outHgIds.length) or.push({ hgTransactionId: { $in: outHgIds } });
        const payouts = await PendingPayout.find({ $or: or })
          .select('id hgTransactionId username resolvedCbu titular').lean();
        const byId = new Map(payouts.map(p => [p.id, p]));
        const byHg = new Map(payouts.filter(p => p.hgTransactionId).map(p => [p.hgTransactionId, p]));
        for (const m of movements) {
          if (m.direction !== 'Outbound') continue;
          const p = (m.externalId && byId.get(m.externalId)) || (m.movementId && byHg.get(m.movementId));
          if (p) {
            m.payoutUsername = p.username || null;
            if (!m.toCBU && p.resolvedCbu) m.toCBU = p.resolvedCbu;
            if (!m.toName && p.titular) m.toName = p.titular;
          }
        }
      }
    } catch (e) { logger.warn(`[hgcash] enriquecer movimientos salientes: ${e.message}`); }

    res.json({ movements, total, page, totalPages: total === 0 ? 0 : Math.ceil(total / limit) });
  } catch (error) {
    console.error('Error obteniendo movimientos hgcash:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Saldo EN VIVO de la(s) cuenta(s) hgcash (GET /accounts). Para que el agente vea la
// plata real sin entrar a hg.cash. Solo admin general. Cache de 15s para no martillar
// la API de hgcash con el refresco en vivo del panel.
let _hgcashBalanceCache = { at: 0, accounts: null };
app.get('/api/admin/hgcash/balance', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin general' });
    if (!hgcashPay.isEnabled()) return res.json({ enabled: false, accounts: [] });
    const now = Date.now();
    if (_hgcashBalanceCache.accounts && (now - _hgcashBalanceCache.at) < 15000) {
      return res.json({ enabled: true, accounts: _hgcashBalanceCache.accounts, cached: true });
    }
    const acc = await hgcashPay.getAccounts();
    if (!acc.ok) return res.status(502).json({ error: 'No se pudo consultar el saldo: ' + (acc.error || 's/detalle') });
    const accounts = (Array.isArray(acc.data) ? acc.data : []).map(a => ({
      id: a.id, name: a.name || null, currency: a.currency || null,
      balance: a.balance, netBalance: a.netBalance, pendingFees: a.pendingFees, status: a.status || null
    }));
    _hgcashBalanceCache = { at: now, accounts };
    res.json({ enabled: true, accounts });
  } catch (error) {
    logger.warn(`[hgcash] balance endpoint falló: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// PAGOS AUTOMÁTICOS (retiros) — el agente verifica y confirma, se paga por hgcash
// ============================================

// Resuelve el accountId de la cuenta hgcash a debitar.
// Fuente de verdad: la API `GET /accounts` (las cuentas a las que el TOKEN ACTUAL
// tiene acceso). Así, si cambiás de cuenta hgcash (token nuevo), el accountId se
// actualiza solo y no salta el 403 "No tienes acceso a esta cuenta" por usar uno viejo.
// `force:true` ignora el cache y vuelve a preguntar a la API (para reintentar tras un 403).
// Fallbacks si la API no responde: el accountId cacheado en config, o el último movimiento.
async function resolveHgcashAccountId({ force = false } = {}) {
  try {
    const cfg = await getHgcashConfig();
    // 1) API = qué cuenta puede operar este token (fuente de verdad).
    try {
      const acc = await hgcashPay.getAccounts();
      if (acc.ok && Array.isArray(acc.data) && acc.data.length) {
        const wantCur = String(cfg.currency || 'ARS').toUpperCase();
        const isOper = a => /operativa|operative|active/i.test(String(a.status || ''));
        const curOk = a => String(a.currency || '').toUpperCase() === wantCur;
        const pick = acc.data.find(a => curOk(a) && isOper(a))
                  || acc.data.find(a => curOk(a))
                  || acc.data.find(a => isOper(a))
                  || acc.data[0];
        if (pick && pick.id) {
          // Cachear si cambió (o si veníamos de un accountId viejo).
          if (String(cfg.accountId || '') !== String(pick.id)) {
            await setConfig('hgcash', Object.assign({}, cfg, { accountId: String(pick.id) }));
            logger.info(`[hgcash] accountId resuelto vía API: ${pick.id} (${pick.currency || '?'}/${pick.status || '?'})`);
          }
          return String(pick.id);
        }
      }
    } catch (_) {}
    // 2) Fallback: lo cacheado (salvo que estemos forzando un refresh tras 403).
    if (!force && cfg.accountId) return cfg.accountId;
    // 3) Fallback: último movimiento conocido.
    const mov = await BankMovement.findOne({ accountId: { $ne: null } }).sort({ createdAt: -1 }).select('accountId').lean();
    return mov ? mov.accountId : null;
  } catch (_) { return null; }
}

// Listar pagos pendientes (para la sección Pagos / banner del chat). Opcional ?userId= o ?status=.
app.get('/api/admin/payouts', authMiddleware, withdrawerMiddleware, async (req, res) => {
  try {
    const q = {};
    if (req.query.userId) q.userId = String(req.query.userId);
    q.status = req.query.status ? String(req.query.status) : { $in: ['pending_review', 'paying', 'failed'] };
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const total = await PendingPayout.countDocuments(q);
    const payouts = await PendingPayout.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
    res.json({ payouts, total, page, totalPages: total === 0 ? 0 : Math.ceil(total / limit), payEnabled: hgcashPay.isEnabled() });
  } catch (error) {
    console.error('Error listando payouts:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Avisa al cliente (mensaje editable) que no se pudo retirar porque su saldo cambió, y
// CIERRA el chat. Se usa cuando, al confirmar el pago, el descuento falla por saldo
// insuficiente (el cliente se jugó las fichas). Si el cliente vuelve a escribir, el chat
// se reabre solo en "Abiertos".
async function _notifyInsufficientAndCloseChat(payout, available, agentUser) {
  try {
    const content = await renderSystemCommand(
      '/sys_withdrawal_insufficient',
      '⚠️ No pudimos completar tu retiro de ${amount} porque tu saldo cambió y ya no alcanza. Tu saldo actual es ${balance}. 💡 Si querés retirar, solicitá un nuevo retiro con el monto correcto disponible. ¡Gracias!',
      { amount: Number(payout.amount).toLocaleString('es-AR'), balance: Number(available || 0).toLocaleString('es-AR') }
    );
    if (content) {
      const msg = await Message.create({
        id: uuidv4(), senderId: 'admin', senderUsername: 'Sistema', senderRole: 'admin',
        receiverId: payout.userId, receiverRole: 'user', content, type: 'system', timestamp: new Date(), read: false
      });
      const data = { id: msg.id, senderId: 'admin', senderUsername: 'Sistema', senderRole: 'admin', receiverId: payout.userId, receiverRole: 'user', content, timestamp: new Date(), type: 'system' };
      io.to(`user_${payout.userId}`).emit('new_message', data);
      io.to(`chat_${payout.userId}`).emit('new_message', data);
      notifyAdmins('new_message', { message: data, userId: payout.userId, username: payout.username });
    }
    // Cerrar el chat (se reabre solo en "Abiertos" si el cliente escribe).
    try { await delayClockResolve(payout.userId, { responded: false }); } catch (_) {}
    await ChatStatus.findOneAndUpdate(
      { userId: payout.userId },
      { status: 'closed', assignedTo: null, closedAt: new Date(), closedBy: (agentUser && agentUser.userId) || 'system', updatedAt: new Date() },
      { upsert: true }
    );
    notifyAdmins('chat_closed', { userId: payout.userId, by: (agentUser && agentUser.username) || 'sistema', adminId: (agentUser && agentUser.userId) || 'system', isPaymentsTab: true });
  } catch (e) {
    logger.warn(`[payout-deduct] aviso insuficiente/cierre falló: ${e.message}`);
  }
}

// Descuenta las fichas al CONFIRMAR el pago (flujo deductAtPay). Devuelve:
//   { ok:true }                     -> descontado y CONFIRMADO; sigue el pago.
//   { ok:false, insufficient:true } -> saldo insuficiente: ya avisó al cliente + cerró chat + canceló el payout.
//   { ok:false, error }             -> no se pudo descontar/confirmar: ya marcó 'failed' + nota al agente.
async function _deductChipsAtConfirm(payout, agentUser) {
  const amt = Number(payout.amount);
  const user = await User.findOne({ id: payout.userId });
  const jgId = (user && user.jugayganaUserId) || null;

  // 1) Saldo actual del cliente.
  const balRes = await jugayganaMovements.getUserBalance(payout.username);
  const avail = (balRes && balRes.success) ? (Number(balRes.balance) || 0) : null;
  if (avail === null) {
    await PendingPayout.updateOne({ id: payout.id }, { $set: { status: 'failed', error: 'No se pudo leer el saldo para descontar' } });
    await _emitAdminOnlyChatNote(payout.userId, payout.username, `⚠️ No se pudo leer el saldo del cliente para descontar $${amt.toLocaleString('es-AR')}. Reintentá en unos minutos.`);
    return { ok: false, error: 'No se pudo verificar el saldo del cliente. Reintentá.' };
  }
  // 2) ¿Tiene saldo? Si se jugó las fichas → avisar al cliente, cerrar chat, cancelar.
  if (avail < amt) {
    await PendingPayout.updateOne({ id: payout.id }, { $set: { status: 'cancelled', error: `Saldo insuficiente al confirmar (disponible $${avail})`, balanceBefore: avail, debitConfirmed: false } });
    await _notifyInsufficientAndCloseChat(payout, avail, agentUser);
    await _emitAdminOnlyChatNote(payout.userId, payout.username, `❌ Retiro de $${amt.toLocaleString('es-AR')} NO pagado: saldo insuficiente al confirmar (disponible $${avail.toLocaleString('es-AR')}). Se avisó al cliente y se cerró el chat para que solicite de nuevo.`);
    return { ok: false, insufficient: true, balance: avail };
  }
  // 3) Descontar en JUGAYGANA.
  const w = await jugaygana.withdrawFromUser(payout.username, amt, `Retiro confirmado - ${payout.username}`);
  if (!w || !w.success) {
    await PendingPayout.updateOne({ id: payout.id }, { $set: { status: 'failed', error: 'No se pudo descontar: ' + ((w && w.error) || '') } });
    await _emitAdminOnlyChatNote(payout.userId, payout.username, `⚠️ No se pudo descontar las fichas ($${amt.toLocaleString('es-AR')}) en JUGAYGANA: ${(w && w.error) || 's/detalle'}. Reintentá.`);
    return { ok: false, error: 'No se pudo descontar las fichas: ' + ((w && w.error) || '') };
  }
  // 4) Verificar el descuento (anti-fantasma): el saldo tiene que haber bajado.
  let after = null, deducted = false;
  try {
    const a = await jugayganaMovements.getUserBalanceWithRetry(payout.username);
    if (a && a.success) { after = Number(a.balance) || 0; deducted = (avail - after) >= (amt - 1); }
  } catch (_) {}
  if (!deducted) {
    await PendingPayout.updateOne({ id: payout.id }, { $set: { status: 'failed', balanceBefore: avail, balanceAfter: after, debitConfirmed: false, error: 'Descuento no confirmado' } });
    await _emitAdminOnlyChatNote(payout.userId, payout.username, `⚠️ El descuento de $${amt.toLocaleString('es-AR')} NO se pudo confirmar (saldo antes $${avail.toLocaleString('es-AR')} → después ${after == null ? '¿?' : '$' + Number(after).toLocaleString('es-AR')}). Verificá en JUGAYGANA antes de pagar manual. NO devuelvas a ciegas.`);
    return { ok: false, error: 'No se pudo confirmar el descuento. Revisá el saldo en JUGAYGANA.' };
  }
  // 5) Descuento confirmado → registrar Transaction + marcar el payout.
  await PendingPayout.updateOne({ id: payout.id }, { $set: { balanceBefore: avail, balanceAfter: after, debitConfirmed: true, withdrawalTxId: w.data?.transfer_id || w.data?.transferId || null } });
  try { await recordUserActivity(payout.userId, 'withdrawal', amt); } catch (_) {}
  try {
    await Transaction.create({
      id: uuidv4(), type: 'withdrawal', amount: amt,
      username: payout.username, userId: payout.userId,
      description: `Retiro confirmado a ${payout.titular || ''} (${payout.alias || payout.cbu || ''})`,
      adminId: agentUser && agentUser.userId, adminUsername: agentUser && agentUser.username, adminRole: agentUser && agentUser.role,
      transactionId: w.data?.transfer_id || w.data?.transferId,
      metadata: { source: 'self_service', confirmedAtPay: true, payoutId: payout.id },
      timestamp: new Date()
    });
  } catch (_) {}
  try { const uSock = connectedUsers.get(payout.userId); if (uSock && after != null) uSock.emit('balance_updated', { balance: after }); } catch (_) {}
  return { ok: true, balanceAfter: after };
}

// El agente CONFIRMA el pago → se ejecuta el cash-out automático en hgcash.
app.post('/api/admin/payouts/:id/pay', authMiddleware, withdrawerMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    if (!hgcashPay.isEnabled()) {
      return res.status(400).json({ error: 'Pago automático no configurado (falta HGCASH_API_TOKEN). Pagá manual.' });
    }
    const payout = await PendingPayout.findOne({ id });
    if (!payout) return res.status(404).json({ error: 'Pago no encontrado' });
    if (!['pending_review', 'failed'].includes(payout.status)) {
      return res.status(400).json({ error: `El pago ya está en estado "${payout.status}".` });
    }

    let accountId = await resolveHgcashAccountId();
    if (!accountId) return res.status(400).json({ error: 'No se pudo determinar la cuenta hgcash a debitar (accountId).' });

    // Resolver el CBU/CVU de 22 dígitos. Si vino un alias, lo buscamos.
    let resolvedCbu = String(payout.cbu || '').replace(/\D/g, '');
    let lookupName = null;
    if (resolvedCbu.length !== 22) {
      const lk = await hgcashPay.lookupAlias(payout.alias || payout.cbu);
      if (lk.ok && lk.data && lk.data.cvu) {
        resolvedCbu = String(lk.data.cvu).replace(/\D/g, '');
        lookupName = lk.data.nombre || null;
      }
    }
    if (resolvedCbu.length !== 22) {
      return res.status(400).json({ error: 'No se pudo resolver el CBU/CVU destino (revisá el alias/CBU del cliente).' });
    }

    // Reclamo atómico: solo procede el que pase pending_review/failed → paying.
    const claimed = await PendingPayout.findOneAndUpdate(
      { id, status: { $in: ['pending_review', 'failed'] } },
      { $set: { status: 'paying', resolvedCbu, lookupName, paidBy: req.user.username, error: null } },
      { new: true }
    );
    if (!claimed) return res.status(409).json({ error: 'El pago ya está siendo procesado.' });

    // FLUJO NUEVO (deductAtPay): descontar las fichas AHORA, al confirmar. Si el cliente
    // se jugó las fichas (saldo insuficiente) o no se puede confirmar el descuento → NO
    // se paga. Solo si el descuento se confirma sigue el cash-out. (Pagos viejos ya tenían
    // las fichas descontadas al solicitar → no entran acá.)
    if (claimed.deductAtPay === true) {
      const ded = await _deductChipsAtConfirm(claimed, req.user);
      if (!ded.ok) {
        if (ded.insufficient) {
          return res.json({ success: false, insufficient: true, message: 'Saldo insuficiente: no se descontó ni se pagó. Se avisó al cliente y se cerró el chat.' });
        }
        return res.status(400).json({ error: ded.error || 'No se pudieron descontar las fichas.' });
      }
    }

    const webhookUrl = `${req.protocol}://${req.get('host')}/api/hgcash/webhook`;
    const buildCashOut = (acct) => hgcashPay.createCashOut({
      accountId: acct,
      amount: payout.amount,
      toCBU: resolvedCbu,
      toName: payout.titular || lookupName || undefined,
      concept: `Retiro Sala de Juegos - ${payout.username}`,
      externalID: payout.id, // idempotencia (mismo externalID = no duplica)
      webhookUrl
    });
    let result = await buildCashOut(accountId);

    // Auto-recuperación: si hgcash rechaza por NO tener acceso a esa cuenta (403),
    // el accountId estaba viejo (cambio de cuenta/token). Forzamos re-resolver desde
    // la API y reintentamos UNA vez con la cuenta correcta. El externalID es el mismo,
    // así que aunque el primer intento hubiera entrado, no se paga dos veces.
    if (!result.ok && result.httpStatus === 403) {
      const fresh = await resolveHgcashAccountId({ force: true });
      if (fresh && String(fresh) !== String(accountId)) {
        logger.warn(`[hgcash-pay] 403 con accountId=${accountId}; reintentando con accountId=${fresh}`);
        accountId = fresh;
        result = await buildCashOut(accountId);
      }
    }

    if (!result.ok) {
      // 409 Duplicate External ID = ya se había mandado este pago → no es error real.
      if (result.httpStatus === 409 && /duplicate/i.test(String(result.error))) {
        await PendingPayout.updateOne({ id }, { $set: { status: 'paying' } });
        return res.json({ success: true, message: 'El pago ya estaba en curso (idempotencia).', status: 'paying' });
      }
      await PendingPayout.updateOne({ id }, { $set: { status: 'failed', error: String(result.error).slice(0, 300) } });
      // Flujo nuevo: las fichas YA se descontaron arriba. NO se devuelven; el agente
      // paga manual ("otro banco") o reintenta. Nota interna para que quede clarísimo.
      if (claimed.deductAtPay === true) {
        await _emitAdminOnlyChatNote(claimed.userId, claimed.username,
          `💸 ⚠️ El PAGO en hgcash FALLÓ (${result.error}) — pero las fichas YA fueron descontadas correctamente: se le descontó $${Number(claimed.amount).toLocaleString('es-AR')} al cliente. NO devuelvas fichas. Pagá manual ("🏦 Pagar con otro banco") o reintentá el pago.`);
      }
      return res.status(400).json({ error: 'No se pudo iniciar el pago en hgcash: ' + result.error });
    }

    const hgId = result.data && result.data.id;
    const hgStatus = (result.data && result.data.status) || 'PENDING';
    const isDone = String(hgStatus).toUpperCase() === 'DONE';
    await PendingPayout.updateOne({ id }, {
      $set: {
        hgTransactionId: hgId || null,
        hgStatus,
        paidVia: 'hgcash',
        status: isDone ? 'paid' : 'paying',
        paidAt: isDone ? new Date() : null
      }
    });

    // Si hgcash confirmó el pago en el acto (DONE), avisamos al cliente ya mismo
    // (el aviso por webhook DONE es idempotente, no duplica). Si quedó 'paying',
    // el aviso lo dispara el webhook al confirmarse.
    if (isDone) { await notifyPayoutPaid(claimed); maybeSendPayoutReceipt(claimed).catch(() => {}); }
    // Si quedó 'paying', re-chequear el estado a los ~7s (por si el webhook no llega):
    // confirma el pago casi al instante sin esperar el poller de 45s.
    else { setTimeout(function () { _pollPayingPayouts(); }, 7000); }

    logger.info(`[hgcash-pay] cash-out iniciado payout=${id} user=${payout.username} $${payout.amount} hgId=${hgId} status=${hgStatus} por ${req.user.username}`);
    res.json({ success: true, status: isDone ? 'paid' : 'paying', hgTransactionId: hgId, hgStatus });
  } catch (error) {
    console.error('Error pagando payout:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// El agente RECHAZA el pago: NO se paga y se le DEVUELVEN las fichas al cliente
// (re-crédito en JUGAYGANA, ya que el self-retiro se las había descontado).
app.post('/api/admin/payouts/:id/cancel', authMiddleware, withdrawerMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    // Reclamo atómico: sólo procede uno (evita doble devolución si dos agentes tocan a la vez).
    const payout = await PendingPayout.findOneAndUpdate(
      { id, status: { $in: ['pending_review', 'failed'] } },
      { $set: { status: 'cancelled', paidBy: req.user.username, error: 'Rechazado por el agente — fichas devueltas' } },
      { new: true }
    );
    if (!payout) return res.status(400).json({ error: 'No se pudo rechazar (ya está pagado o en proceso).' });

    // FLUJO NUEVO (deductAtPay): las fichas NO se descuentan al solicitar.
    //  - Si todavía NO se confirmó el pago (debitConfirmed !== true) → NO se descontó nada
    //    → no hay que devolver: se cancela y listo (acá muere el bug de devoluciones).
    //  - Si el descuento YA se había confirmado (debitConfirmed === true; ej. el pago en
    //    hgcash falló DESPUÉS de descontar) → se devuelve el monto COMPLETO como fichas
    //    (devolución simple, sin split bonus/comunes).
    if (payout.deductAtPay === true) {
      const W = Number(payout.amount);
      if (payout.debitConfirmed === true) {
        const user = await User.findOne({ id: payout.userId });
        const jgId = (user && user.jugayganaUserId) || null;
        let ok = false, data = null;
        try { const r = await jugaygana.depositToUser(payout.username, W, 'Devolución de retiro rechazado', jgId); if (r && r.success) { ok = true; data = r.data; } } catch (e) { logger.error(`[payout-cancel] devolución (deductAtPay) falló payout=${id}: ${e.message}`); }
        if (ok) {
          await PendingPayout.updateOne({ id }, { $set: { chipsReturned: true } });
          try {
            await Transaction.create({ id: uuidv4(), type: 'deposit', amount: W, username: payout.username, userId: payout.userId, description: 'Devolución de retiro rechazado', adminId: req.user.userId, adminUsername: req.user.username, adminRole: req.user.role, transactionId: data?.transfer_id || data?.transferId, metadata: { source: 'payout_refund', refundKind: 'chips', payoutId: payout.id }, timestamp: new Date() });
          } catch (_) {}
          try { const balRes = await jugayganaMovements.getUserBalanceWithRetry(payout.username); const uSock = connectedUsers.get(payout.userId); if (uSock && balRes.success) uSock.emit('balance_updated', { balance: balRes.balance }); } catch (_) {}
          await _emitAdminOnlyChatNote(payout.userId, payout.username, `↩️ Retiro RECHAZADO: se devolvió $${W.toLocaleString('es-AR')} en fichas (el pago había fallado tras descontar).`);
          return res.json({ success: true, chipsReturned: true });
        }
        await _emitAdminOnlyChatNote(payout.userId, payout.username, `⚠️ Retiro rechazado: NO se pudo devolver $${W.toLocaleString('es-AR')} en fichas. Completalo a mano.`);
        return res.json({ success: true, chipsReturned: false });
      }
      // No se había descontado nada → nada que devolver.
      await _emitAdminOnlyChatNote(payout.userId, payout.username, `↩️ Retiro de $${W.toLocaleString('es-AR')} RECHAZADO. No se descontaron fichas (descuento al confirmar), así que no hay nada que devolver.`);
      return res.json({ success: true, chipsReturned: false, noDeduction: true });
    }

    // ANTI RETIRO FANTASMA: si al solicitar NO se confirmó que el descuento en
    // JUGAYGANA ocurrió de verdad (debitConfirmed===false), NO devolvemos fichas a
    // ciegas: devolverlas acuñaría saldo que el cliente nunca tuvo descontado (fue lo
    // que pasó con el retiro de 565k → 200k/92k). Se cancela el pago y se deja nota
    // para que el agente verifique en JUGAYGANA y, si corresponde, devuelva a mano.
    // Pagos viejos (debitConfirmed null/undefined) siguen con el comportamiento previo.
    if (payout.debitConfirmed === false) {
      const Wf = Number(payout.amount);
      await PendingPayout.updateOne({ id }, { $set: { chipsReturned: false } });
      await _emitAdminOnlyChatNote(payout.userId, payout.username,
        `⚠️ Retiro de $${Wf.toLocaleString('es-AR')} RECHAZADO SIN devolución automática: el descuento original NO está confirmado ` +
        `(posible retiro sin saldo real). Revisá el historial en JUGAYGANA; si al cliente SÍ se le había descontado, devolvé a mano.`);
      logger.warn(`[payout-cancel] descuento no confirmado payout=${id} user=${payout.username} $${Wf} → NO se devolvieron fichas (revisión manual)`);
      return res.json({ success: true, chipsReturned: false, skippedRefund: true });
    }

    // Devolver el saldo en JUGAYGANA. Si la ÚLTIMA carga del cliente incluyó bonus,
    // se devuelve esa porción como BONUS (capeada al monto del retiro) y el resto como
    // fichas comunes. Cada parte es una llamada independiente con sus propios reintentos;
    // si una falla queda nota interna al agente (no se reintenta a ciegas → no duplica).
    const user = await User.findOne({ id: payout.userId });
    const jgId = (user && user.jugayganaUserId) || null;
    const W = Number(payout.amount);

    // Cuánto del retiro era BONUS: miramos el último crédito del cliente, que puede ser
    // una CARGA con bonus (type:'deposit' con campo bonus) o un BONUS suelto (type:'bonus',
    // ej. botón Bonus / fueguito / promo). Ignoramos devoluciones previas (payout_refund).
    let bonusPart = 0;
    try {
      // Buscamos por userId O username: las cargas guardan ambos, pero los bonus
      // sueltos (/api/admin/bonus) guardan solo username (sin userId).
      const lastCredit = await Transaction.findOne({
        $or: [{ userId: payout.userId }, { username: payout.username }],
        type: { $in: ['deposit', 'bonus'] },
        'metadata.source': { $ne: 'payout_refund' }
      }).sort({ timestamp: -1 }).select('type amount bonus').lean();
      let lastBonus = 0;
      if (lastCredit) {
        lastBonus = (lastCredit.type === 'bonus')
          ? (Number(lastCredit.amount) || 0)   // bonus suelto: todo el monto es bonus
          : (Number(lastCredit.bonus) || 0);   // carga con bonus: solo el campo bonus
      }
      bonusPart = Math.min(lastBonus, W); // capeado al monto del retiro
    } catch (_) { bonusPart = 0; }
    const chipsPart = W - bonusPart;

    // Registra una Transaction de devolución (excluida de reportes de ingreso por source).
    const mkRefundTx = async (amt, kind, data) => {
      try {
        await Transaction.create({
          id: uuidv4(), type: 'deposit', amount: Number(amt),
          username: payout.username, userId: payout.userId,
          description: `Devolución de retiro rechazado (${kind === 'bonus' ? 'bonus' : 'fichas'})`,
          adminId: req.user.userId, adminUsername: req.user.username, adminRole: req.user.role,
          transactionId: data?.transfer_id || data?.transferId,
          metadata: { source: 'payout_refund', refundKind: kind, payoutId: payout.id },
          timestamp: new Date()
        });
      } catch (_) {}
    };

    let chipsOk = chipsPart <= 0; // sin parte de fichas → ya "ok"
    let bonusOk = bonusPart <= 0; // sin parte de bonus  → ya "ok"
    try {
      if (chipsPart > 0) {
        const r = await jugaygana.depositToUser(payout.username, chipsPart, 'Devolución de retiro rechazado (fichas)', jgId);
        if (r && r.success) { chipsOk = true; await mkRefundTx(chipsPart, 'chips', r.data); }
      }
      if (bonusPart > 0) {
        const r = await jugaygana.creditUserBalance(payout.username, bonusPart, jgId);
        if (r && r.success) { bonusOk = true; await mkRefundTx(bonusPart, 'bonus', r.data); }
      }
    } catch (e) {
      logger.error(`[payout-cancel] devolución falló payout=${id}: ${e.message}`);
    }

    const refunded = chipsOk && bonusOk;
    if (refunded) {
      await PendingPayout.updateOne({ id }, { $set: { chipsReturned: true } });
      try {
        const balRes = await jugayganaMovements.getUserBalanceWithRetry(payout.username);
        const uSock = connectedUsers.get(payout.userId);
        if (uSock && balRes.success) uSock.emit('balance_updated', { balance: balRes.balance });
      } catch (_) {}
      const detalle = bonusPart > 0
        ? `$${bonusPart.toLocaleString('es-AR')} como BONUS + $${chipsPart.toLocaleString('es-AR')} en fichas`
        : `$${chipsPart.toLocaleString('es-AR')} en fichas`;
      await _emitAdminOnlyChatNote(payout.userId, payout.username,
        `↩️ Retiro RECHAZADO: se devolvió $${W.toLocaleString('es-AR')} (${detalle}).`);
    } else {
      // Devolución parcial/fallida → avisar al agente exactamente qué falta hacer a mano.
      const faltan = [];
      if (!chipsOk && chipsPart > 0) faltan.push(`$${chipsPart.toLocaleString('es-AR')} en fichas`);
      if (!bonusOk && bonusPart > 0) faltan.push(`$${bonusPart.toLocaleString('es-AR')} como bonus`);
      await _emitAdminOnlyChatNote(payout.userId, payout.username,
        `⚠️ Retiro rechazado: NO se pudo devolver ${faltan.join(' + ')} (de $${W.toLocaleString('es-AR')}). Completalo a mano.`);
    }
    res.json({ success: true, chipsReturned: refunded });
  } catch (error) {
    console.error('Error rechazando payout:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// El agente paga el retiro DESDE OTRO BANCO (manual, fuera de hgcash): se marca como
// pagado SIN devolver fichas y SIN llamar a hgcash. Manda el aviso de "pago enviado".
app.post('/api/admin/payouts/:id/pay-other-bank', authMiddleware, withdrawerMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const payout = await PendingPayout.findOne({ id });
    if (!payout) return res.status(404).json({ error: 'Pago no encontrado' });
    if (!['pending_review', 'failed'].includes(payout.status)) {
      return res.status(400).json({ error: `El pago ya está en estado "${payout.status}".` });
    }

    // Flujo nuevo: si las fichas todavía NO se descontaron, descontarlas ahora (igual que /pay).
    // Si el cliente se jugó las fichas → no se paga (avisa + cierra chat).
    if (payout.deductAtPay === true && payout.debitConfirmed !== true) {
      const claimed = await PendingPayout.findOneAndUpdate(
        { id, status: { $in: ['pending_review', 'failed'] } },
        { $set: { status: 'paying', paidBy: req.user.username, error: null } }, { new: true }
      );
      if (!claimed) return res.status(409).json({ error: 'El pago ya está siendo procesado.' });
      const ded = await _deductChipsAtConfirm(claimed, req.user);
      if (!ded.ok) {
        if (ded.insufficient) return res.json({ success: false, insufficient: true, message: 'Saldo insuficiente: no se descontó ni se pagó. Se avisó al cliente y se cerró el chat.' });
        return res.status(400).json({ error: ded.error || 'No se pudieron descontar las fichas.' });
      }
    }

    // Marcar pagado por OTRO BANCO (atómico). Incluye 'paying' por si recién descontamos arriba.
    const paid = await PendingPayout.findOneAndUpdate(
      { id, status: { $in: ['pending_review', 'failed', 'paying'] } },
      { $set: { status: 'paid', paidVia: 'other_bank', paidBy: req.user.username, paidAt: new Date(), error: null } },
      { new: true }
    );
    if (!paid) return res.status(400).json({ error: 'No se pudo marcar como pagado (ya está pagado o en proceso).' });
    await _emitAdminOnlyChatNote(paid.userId, paid.username,
      `🏦 Retiro de $${Number(paid.amount).toLocaleString('es-AR')} pagado por OTRO BANCO por ${req.user.username}.`);
    await notifyPayoutPaid(paid); // aviso editable /sys_payout_paid (no envía si está vacío)
    res.json({ success: true });
  } catch (error) {
    console.error('Error pagando payout por otro banco:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// DESCARTAR un pago pendiente viejo que YA se resolvió en su momento: lo saca de la
// cola SIN devolver fichas y SIN avisar al cliente. Solo admin general (limpieza).
app.post('/api/admin/payouts/:id/dismiss', authMiddleware, withdrawerMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin general puede descartar pagos.' });
    }
    const { id } = req.params;
    const r = await PendingPayout.findOneAndUpdate(
      { id, status: { $in: ['pending_review', 'failed'] } },
      { $set: { status: 'cancelled', paidVia: 'dismissed', paidBy: req.user.username, chipsReturned: false, error: 'Descartado (pago viejo ya resuelto): sin devolución ni aviso' } },
      { new: true }
    );
    if (!r) return res.status(400).json({ error: 'No se pudo descartar (ya está pagado o en proceso).' });
    res.json({ success: true });
  } catch (error) {
    console.error('Error descartando payout:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Destrabar un pago: consulta el estado REAL en hgcash y actualiza el payout. Sirve
// cuando quedó en 'paying' porque se perdió el webhook (DONE→paid+aviso+recibo;
// ERROR/CANCELLED→failed). Reusa el handler del webhook para mapear el estado.
app.post('/api/admin/payouts/:id/sync', authMiddleware, withdrawerMiddleware, async (req, res) => {
  try {
    if (!hgcashPay.isEnabled()) return res.status(400).json({ error: 'Pago automático no configurado.' });
    const payout = await PendingPayout.findOne({ id: req.params.id }).lean();
    if (!payout) return res.status(404).json({ error: 'Pago no encontrado.' });
    if (!payout.hgTransactionId) return res.status(400).json({ error: 'Este pago no tiene transacción hgcash para consultar.' });
    const st = await hgcashPay.getTransactionStatus(payout.hgTransactionId);
    if (!st.ok || !st.status) return res.status(502).json({ error: 'No se pudo consultar el estado en hgcash: ' + (st.error || 's/estado') });
    // Reusa el mapeo del webhook (DONE→paid + aviso + comprobante; ERROR/CANCELLED→failed).
    await handlePayoutStatusWebhook({ externalID: payout.id, id: payout.hgTransactionId, status: st.status });
    const fresh = await PendingPayout.findOne({ id: payout.id }).select('status hgStatus').lean();
    res.json({ success: true, status: fresh ? fresh.status : payout.status, hgStatus: st.status });
  } catch (error) {
    logger.warn(`[hgcash-pay] sync payout falló: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// LIMPIEZA de pagos VIEJOS (botón del panel, solo admin general). Saca de la cola
// TODOS los pagos viejos en estados accionables (pending_review/paying/failed más
// viejos que `hours`, default 2h) para que dejen de aparecer en los chats. Si tienen
// transacción hgcash, consulta el estado real: los que ya se pagaron (DONE) quedan
// 'paid' (SILENCIOSO, no re-avisa ni re-paga); TODOS los demás se DESCARTAN
// ('cancelled'/dismissed). NUNCA mueve plata ni devuelve fichas.
app.post('/api/admin/payouts/cleanup-old', authMiddleware, withdrawerMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin general' });
    const hours = Math.max(0, Math.min(720, parseInt(req.body && req.body.hours, 10)));
    const hoursEff = isNaN(hours) ? 2 : hours; // 0 = limpiar TODOS sin importar la antigüedad
    const cutoff = new Date(Date.now() - hoursEff * 60 * 60 * 1000);
    const olds = await PendingPayout.find({ status: { $in: ['pending_review', 'paying', 'failed'] }, createdAt: { $lt: cutoff } })
      .sort({ createdAt: 1 }).limit(1000).lean();
    const enabled = hgcashPay.isEnabled();
    let paid = 0, cancelled = 0;
    for (const p of olds) {
      let set = { status: 'cancelled', paidVia: 'dismissed', chipsReturned: false, error: 'Limpieza de pago viejo (panel)' };
      // Si tiene transacción hgcash y ya está DONE, lo dejamos como 'paid' (más fiel) en vez de descartado.
      if (enabled && p.hgTransactionId) {
        try {
          const st = await hgcashPay.getTransactionStatus(p.hgTransactionId);
          const S = (st.ok && st.status) ? String(st.status).toUpperCase() : null;
          if (S === 'DONE') { set = { status: 'paid', hgStatus: 'DONE', paidAt: p.paidAt || new Date(), receiptSentAt: p.receiptSentAt || new Date() }; }
        } catch (_) {}
      }
      const r = await PendingPayout.updateOne({ id: p.id, status: { $in: ['pending_review', 'paying', 'failed'] } }, { $set: set });
      if (r && (r.modifiedCount || r.nModified)) { if (set.status === 'paid') paid++; else cancelled++; }
    }
    logger.info(`[hgcash-pay] cleanup-old por ${req.user.username}: total=${olds.length} paid=${paid} cancelled=${cancelled} (hours=${hoursEff})`);
    res.json({ success: true, total: olds.length, paid, cancelled, pendingLeft: 0 });
  } catch (error) {
    logger.warn(`[hgcash-pay] cleanup-old falló: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// GESTIÓN DE USUARIOS (ADMIN)
// ============================================

// Obtener todos los usuarios
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const userRole = req.user.role;

    // Construir query según rol
    let query = {};
    if (userRole !== 'admin') {
      // Depositor y withdrawer solo ven usuarios (no admins)
      query.role = 'user';
    }
    // Admin general ve TODOS (usuarios y admins)

    // Búsqueda server-side (substring case-insensitive) sobre los campos
    // que antes se filtraban en el cliente: username, email, phone, id, accountNumber.
    const search = String(req.query.search || '').trim().slice(0, 80);
    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = { $regex: safe, $options: 'i' };
      query.$or = [
        { username: rx },
        { email: rx },
        { phone: rx },
        { id: rx },
        { accountNumber: rx }
      ];
    }

    // Filtro por etiqueta (normalizada). Permite ver "todos los etiquetados como X".
    const tagFilter = normalizeTag(req.query.tag);
    if (tagFilter) {
      query.tags = tagFilter;
    }

    // Paginación. Default 20 por página (antes traía TODO de una → trababa el panel).
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const total = await User.countDocuments(query);
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    // Proyección verificada campo por campo contra renderUsers + notifUsageCell +
    // los onclick de la tabla (admin.js). El detalle completo lo trae aparte
    // GET /api/users/:userId (viewUser/loadUserInfo). Antes viajaba el doc entero
    // (fcmTokens, tagHistory, withdrawalAccount, acquisitionUtm, adminNotes…).
    // ⚠️ Si se agrega una columna nueva a la tabla del panel: sumar el campo acá.
    const USERS_LIST_FIELDS = 'id username tags accountNumber email phone role balance isActive isBlocked blockReason lastLogin createdAt notificationPlan notifMonthlyCounts phoneVerified loginWithoutPassword';
    const users = await User.find(query)
      .select(USERS_LIST_FIELDS)
      .sort({ role: 1, username: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({ users, total, page, totalPages, perPage: limit });
  } catch (error) {
    console.error('Error obteniendo usuarios:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// ETIQUETAS Y NOTAS DE USUARIOS (ADMIN)
// ============================================

// Normaliza una etiqueta: trim + minúsculas + espacios colapsados, máx 40 chars.
// Devuelve '' si no es válida. Sirve para que el guardado y el filtro coincidan
// siempre (sin importar mayúsculas/espacios que tipee el operador).
function normalizeTag(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw).trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
}

// Lista de etiquetas en uso (para el filtro y el autocompletado del panel).
app.get('/api/admin/tags', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const tags = await User.distinct('tags');
    const clean = (tags || [])
      .filter(t => t && typeof t === 'string')
      .sort((a, b) => a.localeCompare(b, 'es'));
    res.json({ tags: clean });
  } catch (error) {
    console.error('Error obteniendo etiquetas:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Agregar o quitar una etiqueta de un usuario (atómico, con auditoría liviana).
app.post('/api/admin/users/:userId/tags', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const action = String(req.body.action || 'add').toLowerCase();
    const tag = normalizeTag(req.body.tag);
    if (!tag) return res.status(400).json({ error: 'Etiqueta inválida' });
    if (!['add', 'remove'].includes(action)) return res.status(400).json({ error: 'Acción inválida' });

    const exists = await User.exists({ id: userId });
    if (!exists) return res.status(404).json({ error: 'Usuario no encontrado' });

    const historyEntry = { tag, action, byUsername: req.user.username, at: new Date() };
    const update = action === 'add'
      ? { $addToSet: { tags: tag }, $push: { tagHistory: historyEntry } }
      : { $pull: { tags: tag }, $push: { tagHistory: historyEntry } };
    await User.updateOne({ id: userId }, update);

    const updated = await User.findOne({ id: userId }).select('tags').lean();
    res.json({ success: true, tags: (updated && updated.tags) || [] });
  } catch (error) {
    console.error('Error actualizando etiquetas:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Guardar la nota interna libre de un usuario (sólo la ve el staff).
app.post('/api/admin/users/:userId/notes', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const notes = String(req.body.notes || '').slice(0, 2000);
    const r = await User.updateOne({ id: userId }, { $set: { adminNotes: notes } });
    if (!r.matchedCount) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ success: true });
  } catch (error) {
    console.error('Error guardando nota de usuario:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Crear usuario o admin
app.post('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { username, password, email, phone, role = 'user' } = req.body;
    const adminRole = req.user.role;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    
    // Validar rol
    const validRoles = ['user', 'admin', 'depositor', 'withdrawer', 'comunidad'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }
    
    // Restricciones de rol para crear usuarios
    if (adminRole !== 'admin' && role !== 'user') {
      return res.status(403).json({ error: 'Solo el administrador general puede crear otros administradores' });
    }
    
    // Verificar si el usuario ya existe
    const existingUser = await findUserByUsernameCI(username);
    if (existingUser) {
      return res.status(400).json({ error: 'El usuario ya existe' });
    }
    
    const userId = uuidv4();
    
    const newUser = await User.create({
      id: userId,
      username,
      password: password,
      email: email || null,
      phone: phone || null,
      role,
      accountNumber: generateAccountNumber(),
      balance: 0,
      createdAt: new Date(),
      lastLogin: null,
      isActive: true,
      jugayganaUserId: null,
      jugayganaUsername: null,
      jugayganaSyncStatus: role === 'user' ? 'pending' : 'not_applicable'
    });
    
    // NO creamos ChatStatus acá (ver nota en publisher-admin/create-user):
    // se crea recién cuando el usuario ingresa o envía su primer mensaje, para
    // no llenar el panel de chats vacíos de usuarios que nunca entraron.

    res.status(201).json({
      success: true,
      message: role === 'user' ? 'Usuario creado correctamente' : 'Administrador creado correctamente',
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        role: newUser.role
      }
    });
  } catch (error) {
    console.error('Error creando usuario:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// GESTIÓN DE COMANDOS
// ============================================

// Obtener todos los comandos
app.get('/api/admin/commands', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const commands = await Command.find().lean();
    res.json({ commands });
  } catch (error) {
    console.error('Error obteniendo comandos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Crear comando
app.post('/api/admin/commands', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { name, description, response } = req.body;
    
    if (!name || !name.startsWith('/')) {
      return res.status(400).json({ error: 'El comando debe empezar con /' });
    }
    
    await Command.findOneAndUpdate(
      { name },
      { 
        name,
        description: description || '',
        response: response || '',
        isActive: true,
        updatedAt: new Date()
      },
      { upsert: true, new: true }
    );
    
    res.json({ success: true, message: 'Comando guardado correctamente' });
  } catch (error) {
    console.error('Error guardando comando:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Eliminar comando
app.delete('/api/admin/commands/:name', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const cmd = await Command.findOne({ name: req.params.name });
    if (cmd && cmd.isSystem) {
      return res.status(403).json({ error: 'No se puede eliminar un comando del sistema' });
    }
    await Command.deleteOne({ name: req.params.name });
    res.json({ success: true, message: 'Comando eliminado correctamente' });
  } catch (error) {
    console.error('Error eliminando comando:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// BASE DE DATOS - PROTEGIDA CON CONTRASEÑA
// ============================================

// Helper: escape a CSV field to prevent CSV injection attacks.
// Returns the complete quoted field including surrounding double quotes.
// Dangerous leading characters (=, +, -, @, tab, CR) are prefixed with a
// single quote so that spreadsheet applications treat them as literal text.
function escapeCsvField(value) {
  if (value === null || value === undefined) return '""';
  const str = String(value);
  if (/^[=+\-@\t\r]/.test(str)) {
    return '"\'' + str.replace(/"/g, '""') + '"';
  }
  return '"' + str.replace(/"/g, '""') + '"';
}

// ELIMINADOS (2026-07-09): POST /api/admin/database/verify y POST /api/admin/database/users
// (+ dbPasswordMiddleware y el chequeo fatal de DB_PASSWORD). La sección "Base de Datos"
// del panel era inalcanzable (sin nav-item ni <section> desde #79) → 0 callers reales.
// El endpoint users dumpeaba TODA la base sin paginar. El listado vivo es
// GET /api/admin/users (paginado). Ya antes se habían eliminado GET /api/admin/database
// y POST /api/admin/database/export/csv (2026-07-08, perf #4). Si algo externo los
// necesitara: git revert. La env DB_PASSWORD queda sin uso (se puede sacar de SSM).

// ============================================
// EXPORTAR USUARIOS A CSV
// ============================================

app.get('/api/admin/users/export/csv', authMiddleware, async (req, res) => {
  // Solo el admin general puede exportar usuarios
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acceso denegado. Solo el admin general puede exportar usuarios.' });
  }
  try {
    const users = await User.find().select('username phone email balance lastLogin').lean();
    
    // Crear CSV
    let csv = 'Usuario,Teléfono,Email,Balance,Último Login\n';
    users.forEach(user => {
      csv += `${escapeCsvField(user.username)},${escapeCsvField(user.phone || '')},${escapeCsvField(user.email || '')},${escapeCsvField(user.balance || 0)},${escapeCsvField(user.lastLogin || 'Nunca')}\n`;
    });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=usuarios.csv');
    res.send(csv);
  } catch (error) {
    console.error('Error exportando usuarios:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// RUTAS DE REFERIDOS
// ============================================

const referralRoutes = require('./src/routes/referralRoutes');
app.use('/api/referrals', referralRoutes);

// ============================================================================
// RULETA DIARIA — 1 giro/día por user con PWA + notifs. Auto-credit JUGAYGANA.
// ============================================================================
const DailyRouletteSpin = require('./src/models/DailyRouletteSpin');

// Tabla de premios — pirámide (decisión dueño 2026-05-12).
// Suma de weights = 100. Valor esperado por giro: ~$950.
// Más alto el premio → más baja la probabilidad. Transparente para el user
// (la PWA muestra las % al lado de cada premio).
const ROULETTE_PRIZES = [
  { value: 10000, weight: 2,  emoji: '💰', label: '$10.000' },
  { value: 2000,  weight: 4,  emoji: '💎', label: '$2.000' },
  { value: 1000,  weight: 6,  emoji: '🥇', label: '$1.000' },
  { value: 500,   weight: 8,  emoji: '🥈', label: '$500' },
  { value: 0,     weight: 80, emoji: '😔', label: 'SIN PREMIO' }
];

// dateKey YYYY-MM-DD en hora Argentina (ART, UTC-3).
function _rouletteDateKeyART(now) {
  const d = now || new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return formatter.format(d); // "YYYY-MM-DD"
}

function _rouletteWeightedPick() {
  const total = ROULETTE_PRIZES.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of ROULETTE_PRIZES) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return ROULETTE_PRIZES[ROULETTE_PRIZES.length - 1];
}

// La ruleta diaria es exclusiva para usuarios con la PWA instalada: detecta
// si el user tiene al menos un token FCM obtenido en contexto 'standalone'
// (app agregada a la pantalla de inicio). Un token de navegador NO habilita
// la ruleta, así sigue siendo un incentivo concreto para instalar la app.
function _rouletteHasAppInstalled(u) {
  if (!u) return false;
  if (u.fcmTokenContext === 'standalone') return true;
  if (Array.isArray(u.fcmTokens)) {
    return u.fcmTokens.some(t => t && t.context === 'standalone');
  }
  return false;
}

// "Cliente activo" para la ruleta (owner 2026-06-24): MÁS DE 10 cargas REALES
// (deposits, sin contar regalos/devoluciones) en los últimos 30 días. Devuelve
// { active, count }. Ante error de lectura NO bloquea (no castiga por un fallo de DB).
const ROULETTE_MIN_CARGAS_30D = 10; // "más de" esto → activo (11+)
async function _rouletteIsActiveClient(userId, username) {
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const count = await Transaction.countDocuments({
      $or: [{ userId: userId }, { username: username }],
      type: 'deposit',
      'metadata.source': { $nin: ['install_bonus', 'welcome_gift', 'payout_refund'] },
      timestamp: { $gte: since }
    });
    return { active: count > ROULETTE_MIN_CARGAS_30D, count };
  } catch (e) {
    logger.warn(`[roulette] chequeo cliente activo falló: ${e.message}`);
    return { active: true, count: null }; // fail-open: no bloquear por un error de DB
  }
}

// GET /api/roulette/status — estado del giro de HOY del user actual.
app.get('/api/roulette/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    const dateKey = _rouletteDateKeyART();
    // Gate: PWA instalada (token FCM standalone) Y cliente ACTIVO (>10 cargas/30d).
    const u = await User.findOne({ id: userId }, { fcmTokenContext: 1, fcmTokens: 1 }).lean();
    const appOk = _rouletteHasAppInstalled(u);
    const act = await _rouletteIsActiveClient(userId, username);
    const eligible = appOk && act.active;
    const spin = await DailyRouletteSpin.findOne({ userId, dateKey }).lean();
    res.json({
      success: true,
      eligible,
      needsAppNotifs: !appOk,
      needsActive: appOk && !act.active, // app OK pero no llega a las cargas mínimas
      minCargas: ROULETTE_MIN_CARGAS_30D,
      dateKey,
      prizes: ROULETTE_PRIZES,
      alreadySpun: !!spin,
      spin: spin ? {
        prizeARS: spin.prizeARS,
        prizeLabel: spin.prizeLabel,
        status: spin.status,
        spunAt: spin.spunAt,
        creditedAt: spin.creditedAt,
        creditTxId: spin.creditTxId
      } : null
    });
  } catch (err) {
    logger.error(`/api/roulette/status: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/roulette/budget — leer config del budget diario.
app.get('/api/admin/roulette/budget', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const cfg = (await getConfig('rouletteBudget')) || {};
    // Resumen del gasto de HOY para que el owner vea en vivo.
    const dateKey = _rouletteDateKeyART();
    const agg = await DailyRouletteSpin.aggregate([
      { $match: { dateKey, status: { $in: ['credited', 'won'] }, prizeARS: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$prizeARS' }, count: { $sum: 1 } } }
    ]);
    const spentToday = (agg && agg[0] && agg[0].total) || 0;
    const winnersToday = (agg && agg[0] && agg[0].count) || 0;
    res.json({
      success: true,
      enabled: cfg.enabled !== false,
      dailyBudgetARS: Number(cfg.dailyBudgetARS) || 0,
      spentToday,
      winnersToday,
      dateKey
    });
  } catch (err) {
    logger.error(`/api/admin/roulette/budget: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// PUT /api/admin/roulette/budget — actualizar config del budget diario.
app.put('/api/admin/roulette/budget', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { enabled, dailyBudgetARS } = req.body || {};
    const budget = Math.max(0, Math.round(Number(dailyBudgetARS) || 0));
    const value = {
      enabled: enabled !== false,
      dailyBudgetARS: budget,
      updatedAt: new Date()
    };
    await setConfig('rouletteBudget', value);
    res.json({ success: true, value });
  } catch (err) {
    logger.error(`PUT /api/admin/roulette/budget: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/admin/roulette/reset-daily — borra los giros de HOY para que
// todos los que ya giraron puedan volver a girar. Lo usa el owner cuando
// quiere reabrir la ruleta en el día. Los premios ya acreditados quedan
// (la plata ya está en JUGAYGANA); solo se borran los registros de hoy.
app.post('/api/admin/roulette/reset-daily', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const dateKey = _rouletteDateKeyART();
    const r = await DailyRouletteSpin.deleteMany({ dateKey });
    const deleted = (r && r.deletedCount) || 0;
    logger.warn(`[roulette] RESET diario por ${(req.user && req.user.username) || '?'} — dateKey=${dateKey} giros borrados=${deleted}`);

    // Aviso opcional por push a todos: "ruleta actualizada, volvé a girar".
    let notified = null;
    if (req.body && req.body.notify) {
      try {
        const bc = await sendNotificationToAllUsers(
          User,
          '🎰 Ruleta diaria actualizada',
          'Podés volver a probar tu suerte. ¡Girá de nuevo!',
          { source: 'roulette' },
          {}
        );
        notified = (bc && bc.successCount) || 0;
        logger.info(`[roulette] RESET notif enviada → success=${notified}`);
      } catch (notifErr) {
        logger.warn(`[roulette] RESET notif falló: ${notifErr.message}`);
      }
    }

    res.json({ success: true, deleted, dateKey, notified });
  } catch (err) {
    logger.error(`POST /api/admin/roulette/reset-daily: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/roulette/recent-winners — últimos N ganadores de HOY (dateKey ART).
// Lista pública (requiere auth para evitar scraping pero no expone identidades).
// Usado en el home para social-proof debajo del card de Ruleta Diaria. Tapa
// 80% inicial del username. Default 50, máximo 100.
app.get('/api/roulette/recent-winners', authMiddleware, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));
    const dateKey = _rouletteDateKeyART();
    const winners = await DailyRouletteSpin.find({
      dateKey,
      prizeARS: { $gt: 0 }
    })
      .sort({ spunAt: -1 })
      .limit(limit)
      .select('username prizeARS spunAt')
      .lean();
    // Tapa ~70% del username. Visible: últimas 2 letras del nombre + todos
    // los números finales. Ej: "lalodj777" → "****dj777", "atojoaquin" → "********in",
    // "tribetcb45" → "******cb45".
    const _mask = (u) => {
      const s = String(u || '').trim();
      if (!s) return '—';
      // Separamos el sufijo numérico del resto.
      const m = s.match(/^(.*?)(\d+)$/);
      const letters = m ? m[1] : s;
      const numbers = m ? m[2] : '';
      // De la parte de letras, mostramos las últimas 2 (o todas si tiene <=2).
      const visibleLetters = letters.length <= 2 ? letters : letters.slice(-2);
      const maskedCount = Math.max(0, letters.length - visibleLetters.length);
      return '*'.repeat(maskedCount) + visibleLetters + numbers;
    };
    const me = String((req.user && req.user.username) || '').toLowerCase();
    const items = winners.map(w => {
      const isMe = String(w.username || '').toLowerCase() === me;
      const ageMs = Date.now() - new Date(w.spunAt).getTime();
      const minutesAgo = Math.max(0, Math.floor(ageMs / 60000));
      return {
        username: isMe ? w.username : _mask(w.username),
        prizeARS: w.prizeARS,
        spunAt: w.spunAt,
        minutesAgo,
        isMe
      };
    });
    return res.json({
      dateKey,
      count: items.length,
      winners: items
    });
  } catch (err) {
    logger.error(`/api/roulette/recent-winners: ${err.message}`);
    return res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================================
// GET /api/claims-feed — feed PÚBLICO (sin auth) de "lo que reclama la
// gente": premios de ruleta diaria, reembolsos y regalos. Alimenta el ticker
// en vivo de la pantalla de login. Los nombres van tapados ~80%. Prioriza
// reclamos REALES y, si hay pocos, completa con ejemplos para que el feed
// siempre se vea activo.
// ============================================================
function _claimsMaskName(u) {
  const s = String(u || '').trim();
  if (!s) return '***';
  const visible = Math.max(1, Math.round(s.length * 0.2));
  return s.slice(0, visible) + '*'.repeat(Math.max(2, s.length - visible));
}

const _CLAIMS_EXAMPLE_NAMES = ['lucas', 'martin', 'jose', 'daniela', 'rodri', 'meli',
  'nacho', 'flor', 'santi', 'agus', 'brian', 'romi', 'leo', 'caro', 'dario', 'vale',
  'seba', 'noe', 'gonza', 'pao', 'juli', 'fede', 'mica', 'tomi'];

// Genera reclamos de ejemplo para completar el feed cuando hay pocos reales.
// Sin 'daily' (reembolso diario eliminado 2026-07-28) ni 'bono' (el bono de
// instalación pasó a ser cupón 100% próxima carga, sin monto fijo mostrable).
function _generateExampleClaims(n) {
  const kinds = ['ruleta', 'reembolso'];
  const refundTypes = ['weekly', 'monthly'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const base = _CLAIMS_EXAMPLE_NAMES[Math.floor(Math.random() * _CLAIMS_EXAMPLE_NAMES.length)];
    const name = _claimsMaskName(base + (Math.floor(Math.random() * 89) + 10));
    let amount, refundType = null;
    if (kind === 'ruleta') {
      amount = (Math.floor(Math.random() * 28) + 2) * 100;
    } else {
      amount = (Math.floor(Math.random() * 60) + 5) * 100;
      refundType = refundTypes[Math.floor(Math.random() * refundTypes.length)];
    }
    out.push({
      kind: kind,
      name: name,
      amount: amount,
      refundType: refundType,
      ts: new Date(Date.now() - Math.floor(Math.random() * 3 * 3600 * 1000))
    });
  }
  return out;
}

app.get('/api/claims-feed', async (req, res) => {
  try {
    const out = [];
    const [spins, refunds, bonusUsers] = await Promise.all([
      DailyRouletteSpin.find({ prizeARS: { $gt: 0 } })
        .sort({ spunAt: -1 }).limit(35).select('username prizeARS spunAt').lean(),
      RefundClaim.find({ amount: { $gt: 0 } })
        .sort({ claimedAt: -1 }).limit(35).select('username type amount claimedAt').lean(),
      // Solo reclamos LEGACY del regalo de $5.000 (el ticker viejo muestra un
      // monto fijo). Los cupones 100% nuevos (installBonus100GrantedAt) no tienen
      // monto mostrable y se excluyen.
      User.find({ installBonusClaimed: true, installBonusClaimedAt: { $ne: null }, installBonus100GrantedAt: null })
        .sort({ installBonusClaimedAt: -1 }).limit(20).select('username installBonusClaimedAt').lean()
    ]);
    spins.forEach(function (s) {
      out.push({ kind: 'ruleta', name: _claimsMaskName(s.username), amount: s.prizeARS, refundType: null, ts: s.spunAt });
    });
    refunds.forEach(function (r) {
      out.push({ kind: 'reembolso', name: _claimsMaskName(r.username), amount: r.amount, refundType: r.type, ts: r.claimedAt });
    });
    bonusUsers.forEach(function (u) {
      out.push({ kind: 'bono', name: _claimsMaskName(u.username), amount: 5000, refundType: null, ts: u.installBonusClaimedAt });
    });
    out.sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); });

    // Prioriza reclamos reales; si hay pocos, completa con ejemplos.
    let items = out.slice(0, 45);
    const MIN_ITEMS = 18;
    if (items.length < MIN_ITEMS) {
      items = items.concat(_generateExampleClaims(MIN_ITEMS - items.length));
      items.sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); });
    }
    res.json({ items: items });
  } catch (err) {
    logger.error(`/api/claims-feed: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/admin/roulette/test-spin — simula un giro para un username
// específico sin afectar su spin real del día. Pick weighted con la misma
// tabla ROULETTE_PRIZES. Devuelve qué le habría salido. NO escribe nada
// en DailyRouletteSpin ni acredita plata. Para que el owner pueda probar
// el flow y el visual sin gastar dinero real.
app.post('/api/admin/roulette/test-spin', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const username = String((req.body && req.body.username) || '').trim();
    if (!username) {
      return res.status(400).json({ error: 'Falta username' });
    }
    // Verificar que el user exista (para que el owner sepa si tipeó mal).
    const u = await findUserByUsernameCI(username, { select: '_id username', lean: true });
    if (!u) {
      return res.status(404).json({ error: `Usuario "${username}" no encontrado` });
    }
    const pick = _rouletteWeightedPick();
    res.json({
      success: true,
      simulation: true,
      username: u.username,
      prize: {
        prizeARS: Number(pick.value) || 0,
        prizeLabel: pick.label,
        emoji: pick.emoji,
        weight: pick.weight
      },
      prizes: ROULETTE_PRIZES,
      note: 'Esto es solo simulación — no se escribió nada ni se acreditó plata.'
    });
  } catch (err) {
    logger.error(`/api/admin/roulette/test-spin: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/roulette/spin — el user gira la ruleta del día.
app.post('/api/roulette/spin', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    const dateKey = _rouletteDateKeyART();

    // Gate: PWA instalada (token FCM en contexto standalone).
    const u = await User.findOne({ id: userId }, { fcmTokenContext: 1, fcmTokens: 1 }).lean();
    if (!_rouletteHasAppInstalled(u)) {
      return res.status(403).json({
        error: 'Solo podés girar si tenés la app instalada con notificaciones aceptadas.',
        needsAppNotifs: true
      });
    }
    // Gate: solo clientes ACTIVOS (más de 10 cargas en los últimos 30 días).
    const act = await _rouletteIsActiveClient(userId, username);
    if (!act.active) {
      return res.status(403).json({
        error: `La ruleta es solo para clientes activos. Necesitás más de ${ROULETTE_MIN_CARGAS_30D} cargas en los últimos 30 días.`,
        needsActive: true,
        minCargas: ROULETTE_MIN_CARGAS_30D
      });
    }

    // Pre-check: ya giró hoy? (el unique index igual cubre el race)
    const already = await DailyRouletteSpin.findOne({ userId, dateKey }).lean();
    if (already) {
      return res.status(409).json({
        error: 'Ya giraste la ruleta hoy. Volvé mañana.',
        alreadySpun: true,
        spin: {
          prizeARS: already.prizeARS,
          prizeLabel: already.prizeLabel,
          status: already.status,
          spunAt: already.spunAt
        }
      });
    }

    // Pick + insert (status='won' o 'no_prize') con unique index protegiendo race.
    let pick = _rouletteWeightedPick();
    let prizeARS = Number(pick.value) || 0;

    // PACING DE BUDGET DIARIO: si la admin config tiene un budget, evitamos
    // gastar más de lo que toca a esta hora. Distribuimos el budget bien
    // repartido a lo largo del día (24h ART). Si dar este premio ahora
    // pasaría el target acumulado para la hora actual, forzamos SIN PREMIO.
    // Esto evita que se vacíe el budget en las primeras horas del día.
    try {
      const cfg = await getConfig('rouletteBudget').catch(() => null);
      const budgetARS = Math.max(0, Number(cfg && cfg.dailyBudgetARS) || 0);
      const budgetEnabled = !!(cfg && cfg.enabled !== false && budgetARS > 0);
      if (budgetEnabled && prizeARS > 0) {
        const agg = await DailyRouletteSpin.aggregate([
          { $match: { dateKey, status: { $in: ['credited', 'won'] }, prizeARS: { $gt: 0 } } },
          { $group: { _id: null, total: { $sum: '$prizeARS' } } }
        ]);
        const spentToday = (agg && agg[0] && agg[0].total) || 0;
        // Hora actual ART (0-23) + fracción → progreso del día.
        const nowART = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Argentina/Buenos_Aires',
          hour: '2-digit', minute: '2-digit', hour12: false
        }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
        const h = parseInt(nowART.hour, 10) || 0;
        const m = parseInt(nowART.minute, 10) || 0;
        const dayProgress = Math.min(1, ((h * 60 + m) + 1) / (24 * 60));
        const targetSpent = budgetARS * dayProgress;
        if ((spentToday + prizeARS) > targetSpent) {
          logger.info(`[ROULETTE] BUDGET PACING — forzando SIN PREMIO para ${username} (gastado $${spentToday}+$${prizeARS} > target $${Math.round(targetSpent)} a las ${h}:${m})`);
          // Elegir el "SIN PREMIO" del pool — siempre es el value:0
          const noPrize = ROULETTE_PRIZES.find(p => Number(p.value) === 0);
          if (noPrize) {
            pick = noPrize;
            prizeARS = 0;
          }
        }
      }
    } catch (e) {
      logger.warn(`[ROULETTE] budget-pacing falló (silencioso): ${e.message}`);
    }

    const initialStatus = prizeARS > 0 ? 'won' : 'no_prize';
    let spinDoc;
    try {
      spinDoc = await DailyRouletteSpin.create({
        id: uuidv4(),
        userId,
        username: String(username || '').toLowerCase(),
        dateKey,
        spunAt: new Date(),
        prizeARS,
        prizeLabel: pick.label,
        ipAddress: (req.ip || '').slice(0, 60),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
        status: initialStatus,
        creditAttempts: 0
      });
    } catch (e) {
      // El unique index disparó (otro tab del mismo user llegó primero).
      if (String(e.message || '').includes('duplicate key')) {
        const existing = await DailyRouletteSpin.findOne({ userId, dateKey }).lean();
        return res.status(409).json({
          error: 'Ya giraste la ruleta hoy.',
          alreadySpun: true,
          spin: existing ? {
            prizeARS: existing.prizeARS, prizeLabel: existing.prizeLabel,
            status: existing.status, spunAt: existing.spunAt
          } : null
        });
      }
      throw e;
    }

    // Si no hay premio, devolvemos el resultado y terminamos.
    if (prizeARS === 0) {
      logger.info(`[ROULETTE] ${username} → SIN PREMIO (${dateKey})`);
      return res.json({
        success: true,
        prize: { prizeARS: 0, prizeLabel: pick.label, emoji: pick.emoji, status: 'no_prize' }
      });
    }

    // Hay premio → auto-credit jugaygana.
    let credit;
    try {
      credit = await jugaygana.creditUserBalance(username, prizeARS);
    } catch (e) {
      credit = { success: false, error: e.message };
    }
    if (!credit || !credit.success) {
      // Marcamos credit_failed para retry manual desde panel admin.
      await DailyRouletteSpin.updateOne(
        { id: spinDoc.id },
        {
          $set: {
            status: 'credit_failed',
            creditError: String((credit && credit.error) || 'unknown').slice(0, 300)
          },
          $inc: { creditAttempts: 1 }
        }
      ).catch(() => {});
      logger.error(`[ROULETTE] credit FAIL ${username} $${prizeARS}: ${(credit && credit.error) || 'unknown'}`);
      return res.status(503).json({
        success: false,
        prize: { prizeARS, prizeLabel: pick.label, emoji: pick.emoji, status: 'credit_failed' },
        error: 'Ganaste pero hubo un problema al acreditar. Avisanos por WhatsApp y lo resolvemos.'
      });
    }

    const txId = credit.transactionId || credit.transferId || null;
    await DailyRouletteSpin.updateOne(
      { id: spinDoc.id },
      {
        $set: { status: 'credited', creditTxId: txId, creditedAt: new Date() },
        $inc: { creditAttempts: 1 }
      }
    ).catch(() => {});
    logger.info(`[ROULETTE] ${username} → $${prizeARS} acreditado tx=${txId}`);
    return res.json({
      success: true,
      prize: {
        prizeARS, prizeLabel: pick.label, emoji: pick.emoji,
        status: 'credited', transactionId: txId
      }
    });
  } catch (err) {
    logger.error(`/api/roulette/spin: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/roulette/stats — agregados para el dashboard admin.
app.get('/api/admin/roulette/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 14));
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);

    const [byDay, byPrize, totals] = await Promise.all([
      DailyRouletteSpin.aggregate([
        { $match: { spunAt: { $gte: cutoff } } },
        { $group: {
          _id: '$dateKey',
          spins: { $sum: 1 },
          winners: { $sum: { $cond: [{ $gt: ['$prizeARS', 0] }, 1, 0] } },
          totalGiven: { $sum: { $cond: [{ $eq: ['$status', 'credited'] }, '$prizeARS', 0] } },
          totalPending: { $sum: { $cond: [{ $eq: ['$status', 'credit_failed'] }, '$prizeARS', 0] } }
        }},
        { $sort: { _id: -1 } }
      ]),
      DailyRouletteSpin.aggregate([
        { $match: { spunAt: { $gte: cutoff } } },
        { $group: { _id: '$prizeARS', count: { $sum: 1 } } },
        { $sort: { _id: -1 } }
      ]),
      DailyRouletteSpin.aggregate([
        { $match: { spunAt: { $gte: cutoff } } },
        { $group: {
          _id: null,
          spinsTotal: { $sum: 1 },
          winnersTotal: { $sum: { $cond: [{ $gt: ['$prizeARS', 0] }, 1, 0] } },
          givenTotal: { $sum: { $cond: [{ $eq: ['$status', 'credited'] }, '$prizeARS', 0] } },
          pendingTotal: { $sum: { $cond: [{ $eq: ['$status', 'credit_failed'] }, '$prizeARS', 0] } }
        }}
      ])
    ]);

    res.json({
      success: true,
      days,
      since: cutoff.toISOString(),
      prizes: ROULETTE_PRIZES,
      byDay,
      byPrize,
      totals: totals[0] || { spinsTotal: 0, winnersTotal: 0, givenTotal: 0, pendingTotal: 0 }
    });
  } catch (err) {
    logger.error(`/api/admin/roulette/stats: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/roulette/history — listado paginado de spins.
app.get('/api/admin/roulette/history', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.max(10, Math.min(200, Number(req.query.pageSize) || 50));
    const filter = {};
    if (req.query.status) filter.status = String(req.query.status);
    if (req.query.minPrize) filter.prizeARS = { $gte: Number(req.query.minPrize) };
    if (req.query.username) filter.username = String(req.query.username).toLowerCase();

    const [items, total] = await Promise.all([
      DailyRouletteSpin.find(filter)
        .sort({ spunAt: -1 })
        .skip((page - 1) * pageSize).limit(pageSize)
        .lean(),
      DailyRouletteSpin.countDocuments(filter)
    ]);
    res.json({ success: true, total, page, pageSize, items });
  } catch (err) {
    logger.error(`/api/admin/roulette/history: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/admin/roulette/:id/retry-credit — reintentar acreditar un
// spin que quedó en credit_failed.
app.post('/api/admin/roulette/:id/retry-credit', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const spin = await DailyRouletteSpin.findOne({ id: req.params.id });
    if (!spin) return res.status(404).json({ error: 'Spin no encontrado' });
    if (spin.status === 'credited') return res.json({ success: true, alreadyCredited: true });
    if (spin.prizeARS <= 0) return res.status(400).json({ error: 'Este spin no tiene premio.' });

    let credit;
    try {
      credit = await jugaygana.creditUserBalance(spin.username, spin.prizeARS);
    } catch (e) {
      credit = { success: false, error: e.message };
    }
    if (!credit || !credit.success) {
      await DailyRouletteSpin.updateOne(
        { id: spin.id },
        { $set: { creditError: String((credit && credit.error) || 'unknown').slice(0, 300) }, $inc: { creditAttempts: 1 } }
      );
      return res.status(503).json({ error: (credit && credit.error) || 'Error acreditando' });
    }
    const txId = credit.transactionId || credit.transferId || null;
    await DailyRouletteSpin.updateOne(
      { id: spin.id },
      { $set: { status: 'credited', creditTxId: txId, creditedAt: new Date() }, $inc: { creditAttempts: 1 } }
    );
    res.json({ success: true, transactionId: txId });
  } catch (err) {
    logger.error(`/api/admin/roulette/:id/retry-credit: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});


// ============================================================
// MOTOR DE REGLAS DE NOTIFICACION AUTOMATICAS
// ============================================================
// Portado de pruebafabio. Un cron evalua cada 5 min las NotificationRule
// activas: si a la regla le toca disparar (trigger cron) resuelve su
// audiencia y manda push, o crea una NotificationRuleSuggestion para que
// el admin apruebe. Las audiencias que dependen de PlayerStats /
// DailyPlayerStats (subsistema NO portado a esta base) devuelven [] —
// esas reglas se siembran desactivadas.
const notificationRulesService = require('./src/services/notificationRulesService');
const NotificationRule = require('./src/models/NotificationRule');
const NotificationRuleSuggestion = require('./src/models/NotificationRuleSuggestion');
const NotificationHistory = require('./src/models/NotificationHistory');
const PromoBonus = require('./src/models/PromoBonus');
const _notifRulesModels = {
  User,
  RefundClaim,
  NotificationRule,
  NotificationRuleSuggestion,
  NotificationHistory,
  PromoBonus
};
const _notifRulesSendFn = sendNotificationToAllUsers;

// Seed al boot (idempotente — solo crea las reglas que no existen).
setTimeout(async () => {
  try {
    await notificationRulesService.seedDefaultRulesIfMissing(NotificationRule);
    logger.info('[notif-rules] seed inicial completado');
  } catch (err) {
    logger.error('[notif-rules] seed error: ' + err.message);
  }
}, 60 * 1000);

// Evaluar todas las reglas cada 5 min.
async function _runNotifRulesEvaluator() {
  try {
    const result = await notificationRulesService.evaluateAllRules({
      models: _notifRulesModels,
      sendPushFn: _notifRulesSendFn,
      logger
    });
    if (result.firedCount > 0 || result.suggestedCount > 0) {
      logger.info('[notif-rules] eval done: fired=' + result.firedCount + ' suggested=' + result.suggestedCount);
    }
  } catch (err) {
    logger.error('[notif-rules] evaluator error: ' + err.message);
  }
}
setTimeout(function () { _runNotifRulesEvaluator(); }, 3 * 60 * 1000);
setInterval(function () { _runNotifRulesEvaluator(); }, 5 * 60 * 1000);


// ============================================================
// MOTOR DE LA ESTRATEGIA "ENCUESTA" (Fase 2)
// ----------------------------------------------------------------
// Un cron corre cada 5 min: arma el calendario semanal por grupo y, si
// a un slot le toca su día/hora (ART), dispara el push (y crea los
// PromoBonus en los slots de bono). DUERME salvo que la config
// encuestaPlanConfig tenga isActive=true — así es seguro deployarlo
// sin que mande nada hasta que el admin lo active.
// ============================================================
const encuestaService = require('./src/services/encuestaService');
const EncuestaFire = require('./src/models/EncuestaFire');
const EncuestaVote = require('./src/models/EncuestaVote');

async function _runEncuestaTick() {
  try {
    const cfg = mergeEncuestaConfig(await getConfig('encuestaPlanConfig'));
    const r = await encuestaService.tick({
      cfg: cfg,
      models: { User: User, EncuestaFire: EncuestaFire, PromoBonus: PromoBonus },
      sendPushFn: sendNotificationToAllUsers,
      logger: logger,
      now: new Date()
    });
    if (r && r.fired > 0) logger.info('[encuesta] tick: disparados=' + r.fired);
  } catch (err) {
    logger.error('[encuesta] tick error: ' + err.message);
  }
}
setTimeout(function () { _runEncuestaTick(); }, 4 * 60 * 1000);
setInterval(function () { _runEncuestaTick(); }, 5 * 60 * 1000);


// ============================================================
// MOTOR DE RECUPERACIÓN DE INACTIVOS
// ----------------------------------------------------------------
// Escalera por días sin entrar (7d / 14d / 30d, configurable). Un cron
// cada 6 h le manda a cada inactivo el push del paso que le toca y crea
// el PromoBonus. DUERME salvo que inactividadConfig.isActive=true.
// ============================================================
const inactividadService = require('./src/services/inactividadService');
const InactividadFire = require('./src/models/InactividadFire');

// APAGADO (owner 2026-06-24): se sacaron TODOS los bonos automáticos. El motor de
// inactividad (bono % + regalo ticket alto a inactivos) NO dispara. Para reactivar, false.
const INACTIVIDAD_DISABLED = true;
async function _runInactividadTick() {
  if (INACTIVIDAD_DISABLED) return;
  try {
    const cfg = mergeInactividadConfig(await getConfig('inactividadConfig'));
    const r = await inactividadService.tick({
      cfg: cfg,
      // Transaction es necesario: el motor ahora segmenta por ÚLTIMA CARGA real
      // (no por último ingreso), para darle bono solo a la gente que no carga hace ≥7d.
      models: { User: User, InactividadFire: InactividadFire, PromoBonus: PromoBonus, Transaction: Transaction },
      sendPushFn: sendNotificationToAllUsers,
      logger: logger,
      now: new Date()
    });
    if (r && r.fired > 0) logger.info('[inactividad] tick: disparados=' + r.fired);
  } catch (err) {
    logger.error('[inactividad] tick error: ' + err.message);
  }
}
setTimeout(function () { _runInactividadTick(); }, 5 * 60 * 1000);
setInterval(function () { _runInactividadTick(); }, 6 * 60 * 60 * 1000);

// POLLER: confirma AUTOMÁTICAMENTE los pagos en proceso (status 'paying'). El webhook
// de hgcash puede no llegar (p.ej. Cloudflare bloqueando /api/hgcash/webhook) → sin esto
// el pago queda "en proceso" y hay que sincronizar a mano. Consulta el estado real en
// hgcash y, si está DONE, marca pagado + avisa al cliente + manda el comprobante (TODO
// idempotente vía handlePayoutStatusWebhook: status==='paid' corta, receiptSentAt no
// duplica). Solo pagos RECIENTES (últimas 2h) para NO resucitar ni spamear pagos viejos.
async function _pollPayingPayouts() {
  try {
    if (!hgcashPay.isEnabled()) return;
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const paying = await PendingPayout.find({ status: 'paying', createdAt: { $gte: since } })
      .sort({ createdAt: -1 }).limit(25).lean();
    for (const p of paying) {
      if (!p.hgTransactionId) continue;
      try {
        const st = await hgcashPay.getTransactionStatus(p.hgTransactionId);
        if (st.ok && st.status) {
          await handlePayoutStatusWebhook({ externalID: p.id, id: p.hgTransactionId, status: st.status });
        }
      } catch (_) {}
    }
  } catch (err) {
    logger.warn('[hgcash-pay] poll paying payouts error: ' + err.message);
  }
}
setTimeout(function () { _pollPayingPayouts(); }, 90 * 1000);
setInterval(function () { _pollPayingPayouts(); }, 45 * 1000);


// ============================================================
// ENDPOINTS ADMIN — Recuperación de inactivos
// ----------------------------------------------------------------
// Sección dedicada en el panel para estudiar la población que tiene
// la app instalada y armar estrategias escalonadas de re-engagement
// (48h, 72h, 7d, etc) sin tocar la sección de Automatizaciones.
// El motor de fondo es el mismo (NotificationRule + Suggestions),
// pero acá lo presentamos con panorama de actividad, audiencia en vivo
// y edición inline antes de aprobar.
// ============================================================

// Panorama: distribución de usuarios con app instalada por última vez
// que entraron. Se usa para entender la audiencia ANTES de lanzar.
app.get('/api/admin/recovery/panorama', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // Filtro base: users reales (no admin), activos, no bloqueados, con app
    // instalada (al menos un fcmToken con context='standalone' O el flag
    // legacy fcmTokenContext='standalone').
    const baseFilter = {
      role: 'user',
      isActive: { $ne: false },
      isBlocked: { $ne: true },
      $or: [
        { fcmTokenContext: 'standalone' },
        { 'fcmTokens.context': 'standalone' }
      ]
    };

    const now = Date.now();
    const H = 3600 * 1000;
    const buckets = [
      { key: 'active24h',     label: 'Activos hoy (< 24h)',         minH: 0,    maxH: 24,    color: '#25d366' },
      { key: 'inactive24_48', label: '24-48h sin entrar',           minH: 24,   maxH: 48,    color: '#ffd700' },
      { key: 'inactive48_72', label: '48-72h sin entrar',           minH: 48,   maxH: 72,    color: '#ff9f3f' },
      { key: 'inactive72_168', label: '72h-7 días sin entrar',      minH: 72,   maxH: 168,   color: '#ff5050' },
      { key: 'inactive7d_30d', label: '7-30 días sin entrar',       minH: 168,  maxH: 720,   color: '#a855f7' },
      { key: 'inactive30dPlus', label: '+30 días (perdidos)',       minH: 720,  maxH: null,  color: '#555' }
    ];

    // Total con app instalada (denominador).
    const totalInstalled = await User.countDocuments(baseFilter);

    // Para cada bucket, contar.
    const out = [];
    for (const b of buckets) {
      const range = {};
      if (b.maxH != null) range.$gte = new Date(now - b.maxH * H);
      range.$lte = new Date(now - b.minH * H);
      const filter = Object.assign({}, baseFilter, { lastLogin: range });
      const count = await User.countDocuments(filter);
      out.push({ key: b.key, label: b.label, color: b.color, minH: b.minH, maxH: b.maxH, count });
    }

    // Sin lastLogin (instalaron y nunca abrieron). Edge case.
    const neverLoggedIn = await User.countDocuments(Object.assign({}, baseFilter, { $or: [
      ...baseFilter.$or
    ], lastLogin: { $in: [null] } }));

    // Top 10 más recientes que dejaron de entrar (entre 24-168h sin login).
    const recentlyDropped = await User.find(
      Object.assign({}, baseFilter, { lastLogin: { $gte: new Date(now - 168 * H), $lte: new Date(now - 24 * H) } }),
      { username: 1, lastLogin: 1, _id: 0 }
    ).sort({ lastLogin: -1 }).limit(10).lean();

    res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      totalInstalled,
      buckets: out,
      neverLoggedIn,
      recentlyDropped
    });
  } catch (err) {
    logger.error(`recovery/panorama: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Listar estrategias de recuperación (NotificationRule con category='recovery')
// + audiencia en vivo que matchearía AHORA si dispararan.
app.get('/api/admin/recovery/strategies', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const rules = await NotificationRule.find({ category: 'recovery' }).sort({ code: 1 }).lean();

    // Para cada regla, resolver audiencia ahora (sin enviar nada).
    const enriched = [];
    for (const rule of rules) {
      let audienceCount = 0;
      let audienceSample = [];
      try {
        const aud = await notificationRulesService._resolveAudience(rule, _notifRulesModels);
        audienceCount = aud.length;
        audienceSample = aud.slice(0, 10);
      } catch (e) {
        // Si la regla tiene audienceType no resoluble, devolvemos 0 sin romper.
        audienceCount = 0;
        audienceSample = [];
      }
      enriched.push({
        id: rule.id,
        code: rule.code,
        name: rule.name,
        description: rule.description || null,
        enabled: rule.enabled,
        triggerType: rule.triggerType,
        cronSchedule: rule.cronSchedule || null,
        audienceType: rule.audienceType,
        audienceConfig: rule.audienceConfig || {},
        title: rule.title,
        body: rule.body,
        requiresAdminApproval: !!rule.requiresAdminApproval,
        cooldownMinutes: rule.cooldownMinutes,
        lastFiredAt: rule.lastFiredAt || null,
        totalFiresLifetime: rule.totalFiresLifetime || 0,
        audienceCount,
        audienceSample
      });
    }

    res.json({ success: true, strategies: enriched });
  } catch (err) {
    logger.error(`recovery/strategies: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Crear una nueva estrategia de recuperación. Front pasa minHoursAgo,
// maxHoursAgo, hour ART, title, body. Backend completa el resto con
// defaults seguros (requiresAdminApproval=true, audienceType=installed-but-inactive).
app.post('/api/admin/recovery/strategies', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin principal puede crear estrategias.' });
    }
    const { name, minHoursAgo, maxHoursAgo, hour, title, body, cooldownMinutes } = req.body || {};

    const minH = Number(minHoursAgo);
    const maxH = Number(maxHoursAgo);
    const cronH = Number(hour);
    if (!Number.isFinite(minH) || !Number.isFinite(maxH) || minH < 0 || maxH <= minH) {
      return res.status(400).json({ error: 'minHoursAgo y maxHoursAgo inválidos (maxHoursAgo > minHoursAgo > 0)' });
    }
    if (!Number.isFinite(cronH) || cronH < 0 || cronH > 23) {
      return res.status(400).json({ error: 'hour inválido (0-23)' });
    }
    if (typeof title !== 'string' || !title.trim() || title.length > 200) {
      return res.status(400).json({ error: 'title requerido (max 200)' });
    }
    if (typeof body !== 'string' || !body.trim() || body.length > 1000) {
      return res.status(400).json({ error: 'body requerido (max 1000)' });
    }

    // Code único: D-INST-<minH>H. Si ya existe, anteponer timestamp.
    let code = 'D-INST-' + minH + 'H';
    const existing = await NotificationRule.findOne({ code }).lean();
    if (existing) code = code + '-' + Date.now();

    const rule = await NotificationRule.create({
      id: require('uuid').v4(),
      code,
      name: (name && String(name).trim()) || ('Inactivos ' + minH + 'h'),
      description: 'Estrategia de re-engagement para usuarios con app instalada y sin login en ' + minH + '-' + maxH + 'h.',
      category: 'recovery',
      enabled: true,
      triggerType: 'cron',
      cronSchedule: { hour: cronH, minute: 0 },
      audienceType: 'installed-but-inactive',
      audienceConfig: { minHoursAgo: minH, maxHoursAgo: maxH },
      title: title.trim(),
      body: body.trim(),
      bonus: { type: 'none' },
      requiresAdminApproval: true,
      cooldownMinutes: Number.isFinite(Number(cooldownMinutes)) ? Math.max(60, Number(cooldownMinutes)) : Math.max(minH * 60, 24 * 60),
      createdBy: req.user.username || null
    });

    res.json({ success: true, rule: rule.toObject() });
  } catch (err) {
    logger.error(`recovery/strategies POST: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ENDPOINTS ADMIN para Automatizaciones
// ============================================================

// Listar reglas con filtros.
app.get('/api/admin/notification-rules', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { category, enabled } = req.query;
    const filter = {};
    if (category) filter.category = category;
    if (enabled === 'true') filter.enabled = true;
    if (enabled === 'false') filter.enabled = false;
    const rules = await NotificationRule.find(filter)
      .sort({ category: 1, code: 1 })
      .lean();
    res.json({ success: true, rules });
  } catch (err) {
    logger.error(`/api/admin/notification-rules: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Toggle enabled / editar copy.
app.patch('/api/admin/notification-rules/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['enabled', 'title', 'body', 'cooldownMinutes', 'requiresAdminApproval', 'cronSchedule', 'bonus', 'chargeBonus'];
    const update = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }
    update.updatedBy = req.user.username || null;
    const rule = await NotificationRule.findOneAndUpdate(
      { id },
      { $set: update },
      { new: true }
    );
    if (!rule) return res.status(404).json({ error: 'Regla no encontrada' });
    res.json({ success: true, rule });
  } catch (err) {
    logger.error(`PATCH notification-rules: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Test manual: dispara una regla AHORA (resuelve audiencia + manda push o
// crea suggestion según corresponda).
app.post('/api/admin/notification-rules/:id/test-fire', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin principal puede testear reglas.' });
    }
    const { id } = req.params;
    const rule = await NotificationRule.findOne({ id }).lean();
    if (!rule) return res.status(404).json({ error: 'Regla no encontrada' });
    const audience = await notificationRulesService._resolveAudience(rule, _notifRulesModels);
    res.json({
      success: true,
      ruleCode: rule.code,
      audienceCount: audience.length,
      audienceSample: audience.slice(0, 20),
      note: 'Dry run: solo se resolvió la audiencia. No se envió nada.'
    });
  } catch (err) {
    logger.error(`test-fire: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Listar suggestions pendientes de aprobación (para el badge + tab).
app.get('/api/admin/notification-rules/suggestions', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const filter = status === 'all' ? {} : { status };
    const suggestions = await NotificationRuleSuggestion.find(filter)
      .sort({ suggestedAt: -1 })
      .limit(200)
      .lean();
    const pendingCount = await NotificationRuleSuggestion.countDocuments({ status: 'pending' });
    res.json({ success: true, suggestions, pendingCount });
  } catch (err) {
    logger.error(`GET suggestions: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Editar título/cuerpo de una suggestion PENDING antes de aprobarla.
// Solo se puede editar si status='pending'. La audiencia (audienceUsernames)
// no se toca: ya quedó fijada al momento de crear la suggestion.
app.put('/api/admin/notification-rules/suggestions/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin principal puede editar sugerencias.' });
    }
    const { id } = req.params;
    const { title, body } = req.body || {};

    if (typeof title !== 'string' || typeof body !== 'string') {
      return res.status(400).json({ error: 'title y body son requeridos (string)' });
    }
    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();
    if (!trimmedTitle || !trimmedBody) {
      return res.status(400).json({ error: 'title y body no pueden estar vacíos' });
    }
    if (trimmedTitle.length > 200 || trimmedBody.length > 1000) {
      return res.status(400).json({ error: 'title (max 200) o body (max 1000) muy largos' });
    }

    const sug = await NotificationRuleSuggestion.findOne({ id }).lean();
    if (!sug) return res.status(404).json({ error: 'Sugerencia no encontrada' });
    if (sug.status !== 'pending') {
      return res.status(400).json({ error: `Sugerencia en estado ${sug.status}, no se puede editar` });
    }

    await NotificationRuleSuggestion.updateOne(
      { id },
      { $set: { title: trimmedTitle, body: trimmedBody } }
    );

    res.json({ success: true, title: trimmedTitle, body: trimmedBody });
  } catch (err) {
    logger.error(`PUT suggestion: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Aprobar una suggestion: dispara el push real + crea giveaway si tiene bonus.
app.post('/api/admin/notification-rules/suggestions/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin principal puede aprobar sugerencias.' });
    }
    const { id } = req.params;
    const sug = await NotificationRuleSuggestion.findOne({ id }).lean();
    if (!sug) return res.status(404).json({ error: 'Sugerencia no encontrada' });
    if (sug.status !== 'pending') return res.status(400).json({ error: `Sugerencia en estado ${sug.status}, no se puede aprobar` });

    // 1) Si tiene giveaway, crearlo primero (cancela cualquier giveaway activo).
    // CRÍTICO: el regalo se crea con audienceWhitelist = sug.audienceUsernames
    // para que SOLO esos usuarios puedan reclamarlo. Sin whitelist, el regalo
    // sería visible a TODOS los users que pollen /api/money-giveaway/active y
    // los primeros en llegar cobrarían (incluso si NO eran del segmento target).
    // Regalos automaticos no portados en esta fase: las reglas sembradas
    // no tienen bonus de plata -> giveawayId queda siempre en null.
    let giveawayId = null;

    // 2) Mandar push.
    const filter = { username: { $in: sug.audienceUsernames } };
    const data = {
      source: 'rule-suggestion',
      ruleCode: sug.ruleCode,
      tag: 'auto-rule-' + sug.ruleCode
    };
    if (giveawayId) {
      data.giveawayAmount = String(sug.bonus.amount);
      data.giveawayDurationMinutes = String(sug.bonus.durationMinutes);
    }
    let sendResult = { successCount: 0, failureCount: 0, error: null };
    try {
      sendResult = await _notifRulesSendFn(User, sug.title, sug.body, data, filter);
    } catch (sendErr) {
      sendResult.error = sendErr.message;
    }


    // 3) NotificationHistory.
    const historyId = uuidv4();
    try {
      await NotificationHistory.create({
        id: historyId,
        sentAt: new Date(),
        audienceType: 'list',
        audienceCount: sug.audienceCount,
        title: sug.title,
        body: sug.body,
        type: giveawayId ? 'money_giveaway' : 'plain',
        successCount: sendResult.successCount || 0,
        failureCount: sendResult.failureCount || 0,
        sentBy: req.user.username || null,
        meta: {
          ruleId: sug.ruleId,
          ruleCode: sug.ruleCode,
          source: 'rule-suggestion',
          suggestionId: sug.id
        }
      });
    } catch (_) {}

    // 3.5) Bono de carga: si la regla origen lleva chargeBonus, activar la
    // bonificación vigente para cada usuario de la audiencia.
    try {
      const srcRule = await NotificationRule.findOne({ id: sug.ruleId }).lean();
      if (srcRule && srcRule.chargeBonus && Number(srcRule.chargeBonus.percent) > 0) {
        const n = await notificationRulesService.activateChargeBonuses(srcRule, sug.audienceUsernames, _notifRulesModels, logger);
        logger.info(`[suggestion/approve] ${sug.ruleCode} activó ${n} bono(s) de ${srcRule.chargeBonus.percent}%`);
      }
    } catch (cbErr) {
      logger.warn(`[suggestion/approve] activar chargeBonus falló: ${cbErr.message}`);
    }

    // 4) Marcar suggestion como aprobada.
    await NotificationRuleSuggestion.updateOne(
      { id: sug.id },
      {
        $set: {
          status: 'approved',
          resolvedAt: new Date(),
          resolvedBy: req.user.username || null,
          notificationHistoryId: historyId,
          giveawayId,
          pushDelivered: sendResult.successCount || 0,
          pushFailed: sendResult.failureCount || 0
        }
      }
    );

    res.json({
      success: true,
      pushDelivered: sendResult.successCount || 0,
      pushFailed: sendResult.failureCount || 0,
      giveawayId,
      sendError: sendResult.error || null
    });
  } catch (err) {
    logger.error(`approve suggestion: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Descartar una suggestion.
app.post('/api/admin/notification-rules/suggestions/:id/reject', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin principal puede rechazar sugerencias.' });
    }
    const { id } = req.params;
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 200) : null;
    const r = await NotificationRuleSuggestion.findOneAndUpdate(
      { id, status: 'pending' },
      {
        $set: {
          status: 'rejected',
          resolvedAt: new Date(),
          resolvedBy: req.user.username || null,
          rejectionReason: reason
        }
      },
      { new: true }
    );
    if (!r) return res.status(404).json({ error: 'Sugerencia no encontrada o ya resuelta' });
    res.json({ success: true });
  } catch (err) {
    logger.error(`reject suggestion: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================================================
// RESEÑAS / OPINIONES — 1 por user, con moderación admin antes de publicar.
// ============================================================================
const Review = require('./src/models/Review');

function _reviewMaskUsername(u) {
  const s = String(u || '');
  if (!s) return '***';
  const visibleChars = Math.max(1, Math.min(6, Math.ceil(s.length * 0.20)));
  const hiddenChars = s.length - visibleChars;
  return '*'.repeat(hiddenChars) + s.slice(hiddenChars);
}
function _reviewBucketOf(stars) {
  const n = Number(stars) || 0;
  if (n >= 4) return 'bueno';
  if (n === 3) return 'regular';
  return 'malo';
}

// POST /api/reviews — el user crea su reseña (1 sola vez, no editable).
app.post('/api/reviews', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    const stars = Math.round(Number((req.body && req.body.stars) || 0));
    const comment = String((req.body && req.body.comment) || '').trim().slice(0, 100);
    const contactPhone = String((req.body && req.body.contactPhone) || '')
      .trim().replace(/[^\d+\-\s()]/g, '').slice(0, 25);
    if (!isFinite(stars) || stars < 1 || stars > 5) {
      return res.status(400).json({ error: 'Estrellas inválidas (1-5)' });
    }
    const existing = await Review.findOne({ userId }).lean();
    if (existing) {
      return res.status(409).json({ error: 'Ya enviaste tu opinión. Solo se permite una por usuario.', alreadyReviewed: true });
    }
    const now = new Date();
    try {
      await Review.create({
        id: uuidv4(), userId, username, stars, comment, contactPhone,
        approved: false, createdAt: now, updatedAt: now
      });
    } catch (e) {
      if (e && e.code === 11000) {
        return res.status(409).json({ error: 'Ya enviaste tu opinión.', alreadyReviewed: true });
      }
      throw e;
    }
    res.json({ success: true, review: { stars, comment, updatedAt: now } });
  } catch (err) {
    logger.error(`POST /api/reviews: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/reviews/mine — la reseña propia del user (si existe).
app.get('/api/reviews/mine', authMiddleware, async (req, res) => {
  try {
    const r = await Review.findOne({ userId: req.user.userId }).lean();
    if (!r) return res.json({ review: null });
    res.json({ review: { stars: r.stars, comment: r.comment || '', approved: !!r.approved, updatedAt: r.updatedAt } });
  } catch (err) {
    logger.error(`GET /api/reviews/mine: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/reviews/public — feed PÚBLICO (sin auth) para la pantalla de
// registro. Solo reseñas aprobadas. Usernames enmascarados. Devuelve
// promedio + cantidad para el cartel de prueba social.
app.get('/api/reviews/public', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20));
    const [aggRes, items] = await Promise.all([
      Review.aggregate([
        { $match: { approved: true } },
        { $group: { _id: null, total: { $sum: 1 }, sumStars: { $sum: '$stars' } } }
      ]),
      Review.find({ approved: true }, { stars: 1, comment: 1, username: 1, updatedAt: 1, _id: 0 })
        .sort({ approvedAt: -1, updatedAt: -1 })
        .limit(limit)
        .lean()
    ]);
    const stats = aggRes[0] || { total: 0, sumStars: 0 };
    const total = stats.total || 0;
    const avgStars = total > 0 ? (stats.sumStars / total) : 0;
    res.json({
      total, avgStars,
      items: items.map(r => ({
        stars: r.stars,
        comment: r.comment || '',
        maskedUsername: _reviewMaskUsername(r.username),
        updatedAt: r.updatedAt
      }))
    });
  } catch (err) {
    logger.error(`GET /api/reviews/public: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/reviews — lista para moderación (username completo).
app.get('/api/admin/reviews', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const status = String(req.query.status || 'all').toLowerCase();
    const filter = {};
    if (status === 'pending') filter.approved = false;
    else if (status === 'approved') filter.approved = true;
    const items = await Review.find(filter).sort({ createdAt: -1 }).limit(500).lean();
    const pendingCount = await Review.countDocuments({ approved: false });
    res.json({
      pendingCount,
      items: items.map(r => ({
        id: r.id, username: r.username, stars: r.stars,
        comment: r.comment || '', contactPhone: r.contactPhone || '',
        bucket: _reviewBucketOf(r.stars), approved: !!r.approved,
        createdAt: r.createdAt
      }))
    });
  } catch (err) {
    logger.error(`GET /api/admin/reviews: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/admin/reviews/:id/approve — aprobar o desaprobar una reseña.
app.post('/api/admin/reviews/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const approved = !(req.body && req.body.approved === false);
    const r = await Review.findOneAndUpdate(
      { id },
      { $set: {
        approved,
        approvedBy: approved ? (req.user.username || null) : null,
        approvedAt: approved ? new Date() : null
      } },
      { new: true }
    );
    if (!r) return res.status(404).json({ error: 'Reseña no encontrada' });
    res.json({ success: true, approved });
  } catch (err) {
    logger.error(`POST /api/admin/reviews/:id/approve: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// DELETE /api/admin/reviews/:id — borra una reseña.
app.delete('/api/admin/reviews/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id requerido' });
    const removed = await Review.findOneAndDelete({ id }).lean();
    if (!removed) return res.status(404).json({ error: 'Reseña no encontrada' });
    logger.info(`[REVIEW-DELETE] ${removed.username} (${removed.stars}) borrada por ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`DELETE /api/admin/reviews/:id: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});


// ============================================================================
// BONO DE CARGA (PromoBonus) — bonificación vigente activada por notificación.
// ============================================================================

// Devuelve el bono de carga vigente de un usuario (o null). Vigente =
// status 'active' y no vencido. De paso vence los que pasaron su ventana.
async function _getActivePromoBonus(username) {
  const u = String(username || '').toLowerCase();
  if (!u) return null;
  const now = new Date();
  await PromoBonus.updateMany(
    { username: u, status: 'active', expiresAt: { $lte: now } },
    { $set: { status: 'expired' } }
  ).catch(() => {});
  // Sólo bonos de carga (percent > 0) para el banner "% en la carga". Los regalos
  // de monto fijo (percent 0, ej. regalo ticket alto) se entregan por push / soporte
  // y se trackean aparte — no se muestran en este banner para no mostrar "0%".
  const b = await PromoBonus.findOne({ username: u, status: 'active', percent: { $gt: 0 }, expiresAt: { $gt: now } })
    .sort({ activatedAt: -1 })
    .lean();
  if (!b) return null;
  // Tope de LECTURA (decisión owner 2026-07-08): los bonos automáticos están
  // capeados a 30%. Aunque quede un PromoBonus viejo en la DB con 50/100%,
  // ni el usuario ni el agente vuelven a ver más de 30%.
  if (Number(b.percent) > 30) b.percent = 30;
  return b;
}

// GET /api/promo-bonus/mine — el usuario ve su bonificación vigente.
app.get('/api/promo-bonus/mine', authMiddleware, async (req, res) => {
  try {
    const b = await _getActivePromoBonus(req.user.username);
    if (!b) return res.json({ bonus: null });
    res.json({
      bonus: { percent: b.percent, activatedAt: b.activatedAt, expiresAt: b.expiresAt }
    });
  } catch (err) {
    logger.error(`/api/promo-bonus/mine: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/promo-bonus?username=X — el agente ve el bono vigente del
// cliente con el que está hablando en el chat.
app.get('/api/admin/promo-bonus', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const username = String(req.query.username || '').trim();
    if (!username) return res.status(400).json({ error: 'Falta username' });
    const b = await _getActivePromoBonus(username);
    if (!b) return res.json({ bonus: null });
    res.json({
      bonus: {
        id: b.id,
        percent: b.percent,
        activatedAt: b.activatedAt,
        expiresAt: b.expiresAt,
        sourceRuleCode: b.sourceRuleCode,
        sourceRuleName: b.sourceRuleName
      }
    });
  } catch (err) {
    logger.error(`/api/admin/promo-bonus: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/admin/promo-bonus/:id/use — el agente marca el bono como usado
// (se aplicó en una carga). Vale por 1 sola carga: queda consumido.
app.post('/api/admin/promo-bonus/:id/use', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const b = await PromoBonus.findOneAndUpdate(
      { id, status: 'active' },
      { $set: { status: 'used', usedBy: req.user.username || null, usedAt: new Date() } },
      { new: true }
    );
    if (!b) return res.status(404).json({ error: 'Bono no encontrado o ya consumido' });
    logger.info(`[promo-bonus] ${b.username} bono ${b.percent}% marcado usado por ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`/api/admin/promo-bonus/:id/use: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});


// ============================================================================
// ESTRATEGIA DE BONOS POR ENCUESTA — secuencia escalonada 50% -> 100%.
// ============================================================================
// Cada usuario que vota la encuesta queda inscripto (StrategyEnrollment). Un
// cron manda el paso 1 (bono 50%) y el paso 2 (bono 100%) segun el retraso
// del plan que voto, contado desde la inscripcion. Cada push activa un
// PromoBonus (reutiliza activateChargeBonuses): cartel del usuario + banner
// del agente. La estrategia corre solo si isActive.
const BonusStrategyConfig = require('./src/models/BonusStrategyConfig');
const StrategyEnrollment = require('./src/models/StrategyEnrollment');

async function _getBonusStrategyConfig() {
  let cfg = await BonusStrategyConfig.findOne({ key: 'default' });
  if (!cfg) cfg = await BonusStrategyConfig.create({ key: 'default' });
  return cfg;
}

// Envia el push del paso + activa el PromoBonus + marca el paso en las
// inscripciones recibidas.
async function _strategySendStep(cfg, step, enrollments) {
  const stepCfg = step === 1 ? cfg.step1 : cfg.step2;
  const usernames = enrollments.map(e => e.username).filter(Boolean);
  if (usernames.length === 0) return;
  const data = { source: 'bonus-strategy', tag: 'bonus-strategy-step' + step };
  try {
    await sendNotificationToAllUsers(User, stepCfg.title, stepCfg.body, data, { username: { $in: usernames } });
  } catch (e) {
    logger.warn(`[bonus-strategy] push paso ${step} fallo: ${e.message}`);
  }
  // Bono vigente: reutiliza la logica de activateChargeBonuses con una regla
  // sintetica que lleva el % y la duracion del paso.
  const synthRule = {
    id: 'bonus-strategy-step' + step,
    code: 'ESTRATEGIA-' + stepCfg.percent + '%',
    name: 'Estrategia de bonos — paso ' + step,
    chargeBonus: { percent: stepCfg.percent, durationMinutes: stepCfg.durationMinutes }
  };
  try {
    await notificationRulesService.activateChargeBonuses(synthRule, usernames, _notifRulesModels, logger);
  } catch (e) {
    logger.warn(`[bonus-strategy] activar bonos paso ${step} fallo: ${e.message}`);
  }
  const ids = enrollments.map(e => e.id);
  const upd = step === 1
    ? { $set: { step: 1, step1At: new Date() } }
    : { $set: { step: 2, step2At: new Date() } };
  await StrategyEnrollment.updateMany({ id: { $in: ids } }, upd);
  logger.info(`[bonus-strategy] paso ${step}: enviado a ${usernames.length} usuario(s)`);
}

// REACTIVADA (owner 2026-06-22): la "estrategia de bonos por voto" (escalonada
// 15%→30%) vuelve a estar disponible, pero con TOPE de 30% y vigencia ≤2h. El tope
// lo refuerzan la validación del POST de config y activateChargeBonuses. Sólo corre
// si el owner la activa (isActive). Para apagarla del todo, poné el flag en true.
// APAGADA (owner 2026-06-24): se sacaron TODOS los bonos automáticos. Para reactivarla, false.
const BONUS_STRATEGY_DISABLED = true;
async function _runBonusStrategy() {
  if (BONUS_STRATEGY_DISABLED) return;
  try {
    const cfg = await BonusStrategyConfig.findOne({ key: 'default' }).lean();
    if (!cfg || !cfg.isActive) return;
    const now = Date.now();
    for (const plan of ['suave', 'normal', 'activo']) {
      const pd = (cfg.planDelays && cfg.planDelays[plan]) || { step1Hours: 24, step2Hours: 96 };
      // Paso 1: inscripciones en step 0 que cumplieron el retraso del paso 1.
      const cut1 = new Date(now - (Number(pd.step1Hours) || 0) * 3600 * 1000);
      const due1 = await StrategyEnrollment.find({ plan, step: 0, enrolledAt: { $lte: cut1 } }).limit(2000).lean();
      if (due1.length > 0) await _strategySendStep(cfg, 1, due1);
      // Paso 2: inscripciones en step 1 que cumplieron el retraso del paso 2.
      const cut2 = new Date(now - (Number(pd.step2Hours) || 0) * 3600 * 1000);
      const due2 = await StrategyEnrollment.find({ plan, step: 1, enrolledAt: { $lte: cut2 } }).limit(2000).lean();
      if (due2.length > 0) await _strategySendStep(cfg, 2, due2);
    }
  } catch (err) {
    logger.error(`[bonus-strategy] cron error: ${err.message}`);
  }
}
setTimeout(() => { _runBonusStrategy(); }, 4 * 60 * 1000);
setInterval(() => { _runBonusStrategy(); }, 10 * 60 * 1000);

// GET — config actual + contadores por paso.
app.get('/api/admin/bonus-strategy', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const cfg = await _getBonusStrategyConfig();
    const agg = await StrategyEnrollment.aggregate([
      { $group: { _id: '$step', count: { $sum: 1 } } }
    ]);
    const byStep = { 0: 0, 1: 0, 2: 0 };
    for (const g of agg) byStep[g._id] = g.count;
    const cfgObj = cfg.toObject();
    // Clamp de display: si quedó un singleton viejo (50%/100%), lo mostramos
    // capeado a 30% / 120min para que el panel refleje el tope real que se aplica.
    for (const s of ['step1', 'step2']) {
      if (cfgObj[s]) {
        cfgObj[s].percent = Math.min(30, Number(cfgObj[s].percent) || 0);
        cfgObj[s].durationMinutes = Math.min(120, Number(cfgObj[s].durationMinutes) || 120);
      }
    }
    res.json({
      success: true,
      config: cfgObj,
      stats: {
        inscriptos: byStep[0] + byStep[1] + byStep[2],
        sinPasos: byStep[0],
        recibieron50: byStep[1],
        completaron: byStep[2]
      }
    });
  } catch (err) {
    logger.error(`GET /api/admin/bonus-strategy: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST — guardar config (pasos + retrasos por plan).
app.post('/api/admin/bonus-strategy', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const cfg = await _getBonusStrategyConfig();
    const _step = (src, dst) => {
      if (!src) return;
      // Tope de negocio: bono ≤30% y vigencia ≤120min (2h).
      if (src.percent != null) dst.percent = Math.max(1, Math.min(30, Number(src.percent) || 0));
      if (src.durationMinutes != null) dst.durationMinutes = Math.max(5, Math.min(120, Number(src.durationMinutes) || 120));
      if (typeof src.title === 'string') dst.title = src.title.slice(0, 120);
      if (typeof src.body === 'string') dst.body = src.body.slice(0, 300);
    };
    _step(b.step1, cfg.step1);
    _step(b.step2, cfg.step2);
    if (b.planDelays) {
      for (const plan of ['suave', 'normal', 'activo']) {
        const pd = b.planDelays[plan];
        if (!pd) continue;
        if (pd.step1Hours != null) cfg.planDelays[plan].step1Hours = Math.max(0, Number(pd.step1Hours) || 0);
        if (pd.step2Hours != null) cfg.planDelays[plan].step2Hours = Math.max(0, Number(pd.step2Hours) || 0);
      }
    }
    cfg.updatedAt = new Date();
    cfg.updatedBy = (req.user && req.user.username) || null;
    cfg.markModified('step1'); cfg.markModified('step2'); cfg.markModified('planDelays');
    await cfg.save();
    res.json({ success: true, config: cfg.toObject() });
  } catch (err) {
    logger.error(`POST /api/admin/bonus-strategy: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST — lanzar o pausar la estrategia. Al lanzar, inscribe a los que ya
// votaron la encuesta y todavia no tienen inscripcion (backfill).
app.post('/api/admin/bonus-strategy/activate', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const active = !(req.body && req.body.active === false);
    const cfg = await _getBonusStrategyConfig();
    cfg.isActive = active;
    if (active) {
      cfg.activatedAt = new Date();
      cfg.activatedBy = (req.user && req.user.username) || null;
    }
    await cfg.save();

    let backfilled = 0;
    if (active) {
      const voters = await User.find(
        { notificationPlan: { $in: ['suave', 'normal', 'activo'] } },
        { id: 1, username: 1, notificationPlan: 1, _id: 0 }
      ).lean();
      const existing = new Set(
        (await StrategyEnrollment.find({}, { username: 1, _id: 0 }).lean()).map(e => e.username)
      );
      const toInsert = [];
      for (const v of voters) {
        const uname = String(v.username || '').toLowerCase();
        if (!uname || existing.has(uname)) continue;
        toInsert.push({
          id: uuidv4(), userId: v.id, username: uname,
          plan: v.notificationPlan, enrolledAt: new Date(), step: 0
        });
      }
      if (toInsert.length > 0) {
        await StrategyEnrollment.insertMany(toInsert, { ordered: false }).catch(() => {});
        backfilled = toInsert.length;
      }
    }
    logger.info(`[bonus-strategy] ${active ? 'LANZADA' : 'PAUSADA'} por ${(req.user && req.user.username) || '?'} (backfill ${backfilled})`);
    res.json({ success: true, isActive: active, backfilled });
  } catch (err) {
    logger.error(`POST /api/admin/bonus-strategy/activate: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});


// ============================================================
// COMUNIDAD — config del link de la comunidad / canal de Telegram.
// ============================================================
app.get('/api/config/community', authMiddleware, async (req, res) => {
  try {
    const c = (await getConfig('communityConfig')) || {};
    // Fallback al esquema viejo {name,url} -> canal oficial.
    res.json({
      channelUrl: c.channelUrl || c.url || '',
      supportUrl: c.supportUrl || ''
    });
  } catch (err) {
    logger.error(`/api/config/community: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/admin/community', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    function _normUrl(v) {
      let u = String(v || '').trim().slice(0, 300);
      if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
      return u;
    }
    const channelUrl = _normUrl(req.body && req.body.channelUrl);
    const supportUrl = _normUrl(req.body && req.body.supportUrl);
    await setConfig('communityConfig', { channelUrl, supportUrl });
    logger.info(`[community] config guardada por ${(req.user && req.user.username) || '?'}`);
    res.json({ success: true, channelUrl, supportUrl });
  } catch (err) {
    logger.error(`POST /api/admin/community: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================================
// SOPORTE VIP — handle de Telegram configurable. El GET es público
// porque lo usa el botón "Soporte VIP" de la pantalla de login.
// ============================================================
// Mensaje fijo con el que abre el chat de WhatsApp de soporte.
const SOPORTE_WA_MENSAJE = 'Vengo de VIPCARGAS necesito ayuda';

app.get('/api/config/soporte-vip', async (req, res) => {
  try {
    const c = (await getConfig('soporteVipTelegram')) || {};
    // Soporta el formato viejo {handle,url} (solo Telegram) y el nuevo
    // {telegram,whatsapp}, así no se pierde la config previa tras el deploy.
    const telegram = c.telegram || { handle: c.handle || '', url: c.url || '' };
    const whatsapp = c.whatsapp || { number: '', url: '' };
    res.json({
      telegram: telegram,
      whatsapp: whatsapp,
      // Campos legacy (Telegram) por compatibilidad.
      handle: telegram.handle || '',
      url: telegram.url || ''
    });
  } catch (err) {
    logger.error(`/api/config/soporte-vip: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/admin/soporte-vip', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // Telegram: acepta @usuario, usuario o link t.me/usuario y lo normaliza.
    let tg = String((req.body && req.body.telegramHandle) || '').trim();
    tg = tg.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '').replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
    const telegram = {
      handle: tg ? '@' + tg : '',
      url: tg ? 'https://t.me/' + tg : ''
    };

    // WhatsApp: solo dígitos (código de país incluido). El link abre el chat
    // con el mensaje fijo de soporte ya escrito.
    const wa = String((req.body && req.body.whatsappNumber) || '').replace(/\D/g, '').slice(0, 20);
    const whatsapp = {
      number: wa,
      url: wa ? 'https://wa.me/' + wa + '?text=' + encodeURIComponent(SOPORTE_WA_MENSAJE) : ''
    };

    await setConfig('soporteVipTelegram', {
      telegram: telegram,
      whatsapp: whatsapp,
      // Campos legacy para no romper lectores viejos.
      handle: telegram.handle,
      url: telegram.url
    });
    logger.info(`[soporte-vip] config guardada por ${(req.user && req.user.username) || '?'}`);
    res.json({ success: true, telegram: telegram, whatsapp: whatsapp });
  } catch (err) {
    logger.error(`POST /api/admin/soporte-vip: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================================
// ENCUESTA — config de los grupos de la estrategia de notificaciones.
// Fase 1: modelo de config (vía config store genérico) + endpoints.
// El motor que arma el calendario y dispara los pushes es Fase 2.
// ============================================================
const ENCUESTA_PLAN_DEFAULTS = {
  isActive: false,
  cohorts: {
    suave:           { bonosPorSemana: 1, incentivosPorSemana: 2 },
    normal:          { bonosPorSemana: 2, incentivosPorSemana: 3 },
    activo:          { bonosPorSemana: 3, incentivosPorSemana: 5 },
    solo_reembolsos: { bonosPorSemana: 0, incentivosPorSemana: 0 }
  },
  bonoPercents: [15, 30], // decisión owner 2026-07-08: NUNCA más 50/100 automático (tope 30%)
  bonoVigenciaHoras: 48,
  quietStartHora: 22,
  quietEndHora: 10,
  minGapHoras: 18
};

function _encNum(v, def, min, max) {
  let n = Number(v);
  if (!Number.isFinite(n)) return def;
  if (typeof min === 'number') n = Math.max(min, n);
  if (typeof max === 'number') n = Math.min(max, n);
  return Math.round(n);
}

// Normaliza la config guardada contra los defaults: nunca devuelve basura.
function mergeEncuestaConfig(saved) {
  const s = saved || {};
  const cohorts = {};
  ['suave', 'normal', 'activo', 'solo_reembolsos'].forEach(function (k) {
    const sc = (s.cohorts && s.cohorts[k]) || {};
    const dc = ENCUESTA_PLAN_DEFAULTS.cohorts[k];
    cohorts[k] = {
      bonosPorSemana: _encNum(sc.bonosPorSemana, dc.bonosPorSemana, 0, 14),
      incentivosPorSemana: _encNum(sc.incentivosPorSemana, dc.incentivosPorSemana, 0, 21)
    };
  });
  let percents = ENCUESTA_PLAN_DEFAULTS.bonoPercents;
  if (Array.isArray(s.bonoPercents) && s.bonoPercents.length) {
    percents = s.bonoPercents.map(function (p) { return _encNum(p, 15, 1, 30); });
  }
  return {
    isActive: s.isActive === true,
    cohorts: cohorts,
    bonoPercents: percents,
    bonoVigenciaHoras: _encNum(s.bonoVigenciaHoras, ENCUESTA_PLAN_DEFAULTS.bonoVigenciaHoras, 1, 720),
    quietStartHora: _encNum(s.quietStartHora, ENCUESTA_PLAN_DEFAULTS.quietStartHora, 0, 23),
    quietEndHora: _encNum(s.quietEndHora, ENCUESTA_PLAN_DEFAULTS.quietEndHora, 0, 23),
    minGapHoras: _encNum(s.minGapHoras, ENCUESTA_PLAN_DEFAULTS.minGapHoras, 1, 72)
  };
}

app.get('/api/admin/encuesta/config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const saved = await getConfig('encuestaPlanConfig');
    res.json({ success: true, config: mergeEncuestaConfig(saved) });
  } catch (err) {
    logger.error(`GET /api/admin/encuesta/config: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.put('/api/admin/encuesta/config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const clean = mergeEncuestaConfig(req.body || {});
    await setConfig('encuestaPlanConfig', clean);
    logger.info(`[encuesta] config guardada por ${(req.user && req.user.username) || '?'}`);
    res.json({ success: true, config: clean });
  } catch (err) {
    logger.error(`PUT /api/admin/encuesta/config: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Distribución de votos de la encuesta — cuánta gente hay en cada grupo.
app.get('/api/admin/encuesta/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const rows = await User.aggregate([
      { $group: { _id: '$notificationPlan', count: { $sum: 1 } } }
    ]);
    const stats = { suave: 0, normal: 0, activo: 0, solo_reembolsos: 0, sinVotar: 0 };
    let total = 0;
    rows.forEach(function (r) {
      const c = Number(r.count) || 0;
      total += c;
      if (r._id && Object.prototype.hasOwnProperty.call(stats, r._id)) stats[r._id] = c;
      else stats.sinVotar += c;
    });

    // Historial de votos: últimos votos + análisis por día (14 días).
    const TZ = 'America/Argentina/Buenos_Aires';
    const since = new Date(Date.now() - 14 * 86400000);
    const ultimosVotos = await EncuestaVote.find({}).sort({ votedAt: -1 }).limit(25).lean();
    const porDiaRaw = await EncuestaVote.aggregate([
      { $match: { votedAt: { $gte: since } } },
      { $group: {
          _id: { dia: { $dateToString: { date: '$votedAt', format: '%Y-%m-%d', timezone: TZ } }, plan: '$plan' },
          count: { $sum: 1 }
      } }
    ]);
    const byDay = {};
    porDiaRaw.forEach(function (r) {
      const d = r._id.dia;
      if (!byDay[d]) byDay[d] = { fecha: d, suave: 0, normal: 0, activo: 0, solo_reembolsos: 0, total: 0 };
      if (byDay[d][r._id.plan] !== undefined) byDay[d][r._id.plan] += r.count;
      byDay[d].total += r.count;
    });
    const votosPorDia = [];
    for (let i = 0; i < 14; i++) {
      const dt = new Date(Date.now() - i * 86400000 - 3 * 3600 * 1000);
      const key = dt.toISOString().slice(0, 10);
      votosPorDia.push(byDay[key] || { fecha: key, suave: 0, normal: 0, activo: 0, solo_reembolsos: 0, total: 0 });
    }

    res.json({ success: true, total: total, stats: stats, ultimosVotos: ultimosVotos, votosPorDia: votosPorDia });
  } catch (err) {
    logger.error(`GET /api/admin/encuesta/stats: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Calendario semanal calculado por grupo — para ver/verificar qué push
// va a salir cada día. Lo usa la pantalla de admin (Fase 3).
app.get('/api/admin/encuesta/calendar', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const cfg = mergeEncuestaConfig(await getConfig('encuestaPlanConfig'));
    res.json({ success: true, isActive: cfg.isActive, calendar: encuestaService.weeklyCalendar(cfg) });
  } catch (err) {
    logger.error(`GET /api/admin/encuesta/calendar: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Reportes diarios de la estrategia (Fase 4): pushes enviados, bonos
// creados y bonos usados — por día y por grupo, últimos 14 días.
app.get('/api/admin/encuesta/reportes', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const DIAS = 14;
    const TZ = 'America/Argentina/Buenos_Aires';
    const COH = ['suave', 'normal', 'activo'];
    const since = new Date(Date.now() - DIAS * 86400000);

    function zeroCell() { return { pushes: 0, bonosCreados: 0, bonosUsados: 0, ingreso: 0, costo: 0 }; }
    function zeroGrupos() {
      return { suave: zeroCell(), normal: zeroCell(), activo: zeroCell() };
    }

    // Pushes y bonos creados: del registro de disparos.
    const fires = await EncuestaFire.aggregate([
      { $match: { firedAt: { $gte: since } } },
      { $group: {
          _id: { dia: { $dateToString: { date: '$firedAt', format: '%Y-%m-%d', timezone: TZ } }, cohort: '$cohort' },
          pushes: { $sum: 1 },
          bonosCreados: { $sum: '$bonosCreados' }
      } }
    ]);
    // Bonos usados + ROI: PromoBonus de la encuesta marcados como usados.
    // ingreso = monto de la carga; costo = regalo fijo o % sobre la carga.
    const usados = await PromoBonus.aggregate([
      { $match: { sourceRuleCode: 'encuesta', status: 'used', usedAt: { $gte: since } } },
      { $group: {
          _id: { dia: { $dateToString: { date: '$usedAt', format: '%Y-%m-%d', timezone: TZ } }, rule: '$sourceRuleName' },
          count: { $sum: 1 },
          ingreso: { $sum: { $ifNull: ['$cargaMonto', 0] } },
          costo: { $sum: { $cond: [
            { $gt: [ { $ifNull: ['$montoFijoARS', 0] }, 0 ] },
            { $ifNull: ['$montoFijoARS', 0] },
            { $multiply: [ { $ifNull: ['$cargaMonto', 0] }, { $divide: [ { $ifNull: ['$percent', 0] }, 100 ] } ] }
          ] } }
      } }
    ]);

    const byDay = {};
    function ensureDay(d) {
      if (!byDay[d]) byDay[d] = { fecha: d, pushes: 0, bonosCreados: 0, bonosUsados: 0, ingreso: 0, costo: 0, porGrupo: zeroGrupos() };
      return byDay[d];
    }
    fires.forEach(function (f) {
      const c = f._id.cohort;
      if (COH.indexOf(c) < 0) return;
      const d = ensureDay(f._id.dia);
      d.pushes += f.pushes;
      d.bonosCreados += (f.bonosCreados || 0);
      d.porGrupo[c].pushes += f.pushes;
      d.porGrupo[c].bonosCreados += (f.bonosCreados || 0);
    });
    usados.forEach(function (u) {
      const m = /grupo\s+(\w+)/i.exec(u._id.rule || '');
      const c = m ? m[1].toLowerCase() : null;
      const d = ensureDay(u._id.dia);
      d.bonosUsados += u.count;
      d.ingreso += (u.ingreso || 0);
      d.costo += (u.costo || 0);
      if (c && d.porGrupo[c]) {
        d.porGrupo[c].bonosUsados += u.count;
        d.porGrupo[c].ingreso += (u.ingreso || 0);
        d.porGrupo[c].costo += (u.costo || 0);
      }
    });

    const reportes = [];
    for (let i = 0; i < DIAS; i++) {
      const dt = new Date(Date.now() - i * 86400000 - 3 * 3600 * 1000);
      const key = dt.toISOString().slice(0, 10);
      reportes.push(byDay[key] || { fecha: key, pushes: 0, bonosCreados: 0, bonosUsados: 0, ingreso: 0, costo: 0, porGrupo: zeroGrupos() });
    }

    const totales = { pushes: 0, bonosCreados: 0, bonosUsados: 0, ingreso: 0, costo: 0, porGrupo: zeroGrupos() };
    reportes.forEach(function (d) {
      totales.pushes += d.pushes;
      totales.bonosCreados += d.bonosCreados;
      totales.bonosUsados += d.bonosUsados;
      totales.ingreso += d.ingreso;
      totales.costo += d.costo;
      COH.forEach(function (c) {
        totales.porGrupo[c].pushes += d.porGrupo[c].pushes;
        totales.porGrupo[c].bonosCreados += d.porGrupo[c].bonosCreados;
        totales.porGrupo[c].bonosUsados += d.porGrupo[c].bonosUsados;
        totales.porGrupo[c].ingreso += d.porGrupo[c].ingreso;
        totales.porGrupo[c].costo += d.porGrupo[c].costo;
      });
    });

    res.json({ success: true, dias: DIAS, totales: totales, reportes: reportes });
  } catch (err) {
    logger.error(`GET /api/admin/encuesta/reportes: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================================
// RECUPERACIÓN DE INACTIVOS — config de la escalera 7/14/30 días.
// ============================================================
// Recuperación de inactivos = único motor de bonos automáticos. Reglas de negocio
// (owner 2026-06-21): solo a quien NO carga hace ≥7d, bono ≤30%, vence en ≤2h.
// Los topes se fuerzan acá (merge) Y en inactividadService (defensa en profundidad).
const REFUND_INACT_MAX_PCT = 30;       // tope de % de bono
const REFUND_INACT_MAX_VIG_HORAS = 2;  // tope de vigencia (horas)
const REGALO_TA_MAX_ARS = 3000;        // tope del regalo de reactivación ticket alto
const INACTIVIDAD_DEFAULTS = {
  isActive: false,
  bonoVigenciaHoras: 2,
  pasos: [
    { dias: 7,  tipo: 'bono', percent: 30, montoARS: 0 },
    { dias: 14, tipo: 'bono', percent: 30, montoARS: 0 }
  ],
  // Regalo de reactivación para clientes de TICKET ALTO (≥$30.000 de ticket
  // promedio) que dejaron de cargar. "Muy de vez en cuando": 1 vez por mes máx.
  // Monto fijo ≤$3.000, se reclama con soporte (no es bono %). Apagado por defecto.
  regaloTicketAlto: {
    enabled: false,
    dias: 14,
    montoARS: 3000,
    minTicketARS: 30000,
    vigenciaHoras: 48
  }
};

function mergeInactividadConfig(saved) {
  const s = saved || {};
  let pasos = (Array.isArray(s.pasos) && s.pasos.length) ? s.pasos : INACTIVIDAD_DEFAULTS.pasos;
  pasos = pasos.map(function (p) {
    p = p || {};
    return {
      dias: _encNum(p.dias, 7, 1, 365),
      tipo: (p.tipo === 'regalo') ? 'regalo' : 'bono',
      // % de bono capeado a 30 (el owner no puede subirlo de ahí).
      percent: _encNum(p.percent, 30, 0, REFUND_INACT_MAX_PCT),
      montoARS: _encNum(p.montoARS, 0, 0, 10000000)
    };
  }).sort(function (a, b) { return a.dias - b.dias; });
  const rtaIn = s.regaloTicketAlto || {};
  const d = INACTIVIDAD_DEFAULTS.regaloTicketAlto;
  const regaloTicketAlto = {
    enabled: rtaIn.enabled === true,
    dias: _encNum(rtaIn.dias, d.dias, 1, 365),
    // Regalo capeado a $3.000 (tope duro).
    montoARS: _encNum(rtaIn.montoARS, d.montoARS, 1, REGALO_TA_MAX_ARS),
    minTicketARS: _encNum(rtaIn.minTicketARS, d.minTicketARS, 0, 100000000),
    vigenciaHoras: _encNum(rtaIn.vigenciaHoras, d.vigenciaHoras, 1, 168)
  };
  return {
    isActive: s.isActive === true,
    // Vigencia capeada a 2h (después el botón de reclamo desaparece solo).
    bonoVigenciaHoras: _encNum(s.bonoVigenciaHoras, 2, 1, REFUND_INACT_MAX_VIG_HORAS),
    pasos: pasos,
    regaloTicketAlto: regaloTicketAlto
  };
}

app.get('/api/admin/inactividad/config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    res.json({ success: true, config: mergeInactividadConfig(await getConfig('inactividadConfig')) });
  } catch (err) {
    logger.error(`GET /api/admin/inactividad/config: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.put('/api/admin/inactividad/config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const clean = mergeInactividadConfig(req.body || {});
    await setConfig('inactividadConfig', clean);
    logger.info(`[inactividad] config guardada por ${(req.user && req.user.username) || '?'}`);
    res.json({ success: true, config: clean });
  } catch (err) {
    logger.error(`PUT /api/admin/inactividad/config: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Resumen: cuántos inactivos hay por tramo + últimos disparos.
app.get('/api/admin/inactividad/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const cfg = mergeInactividadConfig(await getConfig('inactividadConfig'));
    const now = Date.now();
    const tramos = [];
    // Inactivos = sin CARGA real (excluye regalos/devoluciones) hace ≥ p.dias.
    // Coherente con el motor (que ahora segmenta por última carga, no por ingreso).
    const GIFT_SOURCES = ['install_bonus', 'welcome_gift', 'payout_refund'];
    for (const p of cfg.pasos) {
      const desde = new Date(now - p.dias * 86400000);
      const agg = await Transaction.aggregate([
        { $match: { type: 'deposit', $or: [
          { 'metadata.source': { $exists: false } },
          { 'metadata.source': { $nin: GIFT_SOURCES } }
        ] } },
        { $group: { _id: '$username', last: { $max: '$timestamp' } } },
        { $match: { last: { $lte: desde } } },
        { $count: 'n' }
      ]);
      const count = (agg[0] && agg[0].n) || 0;
      tramos.push({ dias: p.dias, tipo: p.tipo, percent: p.percent, montoARS: p.montoARS, inactivos: count });
    }
    const ultimos = await InactividadFire.find({}).sort({ firedAt: -1 }).limit(20).lean();
    res.json({ success: true, tramos: tramos, ultimos: ultimos });
  } catch (err) {
    logger.error(`GET /api/admin/inactividad/stats: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================================
// SEGUIMIENTO DE ESTRATEGIAS DE REACTIVACIÓN — solo admin general
// ----------------------------------------------------------------
// Tablero unificado: como TODOS los bonos automáticos quedan registrados como
// PromoBonus (con sourceRuleCode), agregamos por estrategia y por día para ver
// qué se dispara, cuánto cada día, cuántos reciben y cuántos reclaman.
//   creados   = PromoBonus generados (cuántos reciben)
//   reclamados= PromoBonus marcados 'used' (cuántos reclaman el bono %)
//   ingreso   = suma de la carga asociada a los bonos reclamados (cargaMonto)
// Nota: los regalos de ticket alto se reclaman con soporte (no se marcan 'used'
//   automáticamente), así que para esa estrategia mirá "creados/enviados".
// ============================================================
const _REACT_STRATEGY_LABELS = {
  'inactividad': 'Inactividad (bono %)',
  'regalo_ticket_alto': 'Regalo ticket alto',
  'encuesta': 'Encuesta'
};
app.get('/api/admin/reactivacion/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo el admin general puede ver el seguimiento de estrategias.' });
    }
    const days = Math.min(180, Math.max(1, parseInt(req.query.days, 10) || 14));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [byStrategy, byDay] = await Promise.all([
      PromoBonus.aggregate([
        { $match: { activatedAt: { $gte: since } } },
        { $group: {
          _id: '$sourceRuleCode',
          name: { $first: '$sourceRuleName' },
          creados: { $sum: 1 },
          reclamados: { $sum: { $cond: [{ $eq: ['$status', 'used'] }, 1, 0] } },
          activos: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          expirados: { $sum: { $cond: [{ $eq: ['$status', 'expired'] }, 1, 0] } },
          ingreso: { $sum: { $cond: [{ $eq: ['$status', 'used'] }, { $ifNull: ['$cargaMonto', 0] }, 0] } }
        } },
        { $sort: { creados: -1 } }
      ]),
      PromoBonus.aggregate([
        { $match: { activatedAt: { $gte: since } } },
        { $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$activatedAt', timezone: ART_TZ } },
          creados: { $sum: 1 },
          reclamados: { $sum: { $cond: [{ $eq: ['$status', 'used'] }, 1, 0] } }
        } },
        { $sort: { _id: -1 } }
      ])
    ]);

    const strategies = byStrategy.map(function (s) {
      const code = s._id || '(sin código)';
      return {
        code: code,
        label: _REACT_STRATEGY_LABELS[code] || s.name || code,
        creados: s.creados || 0,
        reclamados: s.reclamados || 0,
        activos: s.activos || 0,
        expirados: s.expirados || 0,
        tasaReclamo: s.creados > 0 ? Math.round((s.reclamados / s.creados) * 1000) / 10 : 0,
        ingreso: Math.round(s.ingreso || 0)
      };
    });
    const totals = strategies.reduce(function (t, s) {
      t.creados += s.creados; t.reclamados += s.reclamados; t.ingreso += s.ingreso;
      return t;
    }, { creados: 0, reclamados: 0, ingreso: 0 });
    totals.tasaReclamo = totals.creados > 0 ? Math.round((totals.reclamados / totals.creados) * 1000) / 10 : 0;

    res.json({
      days: days,
      strategies: strategies,
      byDay: byDay.map(function (d) { return { date: d._id, creados: d.creados, reclamados: d.reclamados }; }),
      totals: totals
    });
  } catch (err) {
    logger.error(`GET /api/admin/reactivacion/stats: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});


// ============================================
// SPA FALLBACK: sirve index.html para rutas
// frontend desconocidas (ej: /register?ref=CODE)
// Esto permite que los links de referido funcionen
// aunque la ruta no esté definida explícitamente.
// ============================================

app.get('*', async (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint no encontrado' });
  }
  // Don't serve SPA HTML for static asset paths – they should 404 cleanly so that
  // browsers don't receive HTML with Content-Type: text/html when they expect CSS/JS
  // (which triggers X-Content-Type-Options: nosniff blocking).
  if (STATIC_ASSET_EXT_RE.test(req.path)) {
    return res.status(404).send('Not found');
  }
  // Reinyectar el código de campaña desde la cookie de pauta (igual que la home)
  // para que el flujo sin SMS sea determinístico en cualquier ruta SPA.
  const campaignCode = await resolveCampaignFromCookie(req);
  const rendered = renderIndexHtml({ campaignCode: campaignCode || '' });
  if (rendered) {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    if (campaignCode) res.setHeader('Set-Cookie', buildCampaignCookieHeader(campaignCode));
    res.send(rendered);
  } else {
    res.status(500).send('Error loading page');
  }
});

// ============================================
// MANEJADOR DE ERRORES CENTRALIZADO
// ============================================

const errorHandler = require('./src/middlewares/errorHandler');
app.use(errorHandler);

// ============================================
// INICIAR SERVIDOR
// ============================================

if (process.env.VERCEL) {
  initializeData().then(() => {
    logger.info('Data initialized for Vercel');
    // Worker periódico que reprocesa la cola de webhooks a fb-ads.
    fbAdsWebhook.startWorker();
  });
  
  module.exports = app;
} else {
  (async () => {
    try {
      await loadSecretsFromSSM();
    } catch (err) {
      console.error('[BOOT] No se pudo cargar la configuración desde SSM. Abortando.');
      process.exit(1);
    }

    // Validar JWT_SECRET ahora que SSM ya cargó las vars
    JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
      console.error('⛔ FATAL: JWT_SECRET no configurado. El servidor no puede arrancar.');
      process.exit(1);
    }
    // Secret corto: solo se advierte, NO se aborta. Abortar dejaría la
    // producción caída si el JWT_SECRET configurado es corto. Se recomienda
    // usar 32+ caracteres (cambiarlo invalida las sesiones vigentes).
    if (JWT_SECRET.length < 32) {
      console.warn('⚠️  ADVERTENCIA: JWT_SECRET es corto (' + JWT_SECRET.length + ' caracteres). Se recomienda 32+ para mayor seguridad.');
    }

    await initializeData();
    await setupRedisAdapter();
    // Worker periódico que reprocesa la cola de webhooks a fb-ads.
    fbAdsWebhook.startWorker();
    server.listen(PORT, () => {
      logger.info(`Server started on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
    });

    // Apagado ORDENADO: al recibir SIGTERM/SIGINT (deploy/reinicio de EB), dejamos de
    // aceptar conexiones nuevas y terminamos los pedidos EN CURSO antes de salir. Sin
    // esto, EB mataba el proceso de golpe y los pedidos en vuelo se cortaban → el cliente
    // veía "Error de conexión". Red de seguridad: salida forzada a los 25s.
    let _shuttingDown = false;
    const gracefulShutdown = (signal) => {
      if (_shuttingDown) return;
      _shuttingDown = true;
      logger.info(`[shutdown] ${signal} recibido — cerrando ordenadamente (drenando pedidos en curso)...`);
      try { io.close(); } catch (_) {}
      server.close(() => {
        logger.info('[shutdown] HTTP cerrado, saliendo limpio.');
        process.exit(0);
      });
      setTimeout(() => { logger.warn('[shutdown] timeout de drenado, salida forzada.'); process.exit(0); }, 25000).unref();
    };
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  })();
}