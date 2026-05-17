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
const { generateReferralCode } = require('./src/utils/referralCode');
const { setRedisClient, getRedisClient } = require('./src/utils/redisClient');
const { generateAndSendOTP, verifyOTP } = require('./src/services/otpService');
const { sendSMS } = require('./src/services/smsService');
const { validateInternationalPhone } = require('./src/middlewares/security');

// ============================================
// SEGURIDAD - RATE LIMITING
// NOTE: Uses in-memory store per instance. In multi-instance deployments each
// instance counts independently. For consistent distributed rate limiting,
// configure a Redis store (e.g. rate-limit-redis) via REDIS_URL.
// ============================================
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta más tarde.' }
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de autenticación. Intenta más tarde.' }
});

// Rate limiter for sensitive unauthenticated endpoints (phone lookup, password reset)
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Intenta más tarde.' }
});

// ============================================
// IP-BASED SMS RATE LIMITING (in-memory Map)
// ============================================

// Tracks SMS requests per IP: { ip -> [timestamp, ...] }
const smsIpStore = new Map();
// Tracks bulk SMS requests per IP: { ip -> [timestamp, ...] }
const bulkSmsIpStore = new Map();

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
}, 30 * 60 * 1000).unref();

/**
 * Creates an IP-based rate limiting middleware using an in-memory Map.
 * @param {Map} store - The Map used to track IP -> timestamps
 * @param {number} windowMs - Time window in milliseconds
 * @param {number} max - Maximum number of requests per window
 * @param {string} message - Error message to return when limit is exceeded
 */
function createIpSmsLimiter(store, windowMs, max, message) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress;
    if (!ip) {
      return res.status(429).json({ error: message });
    }
    const now = Date.now();
    const windowStart = now - windowMs;

    // Get existing timestamps for this IP, filter out expired ones
    const timestamps = (store.get(ip) || []).filter(ts => ts > windowStart);

    if (timestamps.length >= max) {
      return res.status(429).json({ error: message });
    }

    // Record this request
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
  'Demasiadas solicitudes de SMS. Por favor, intenta nuevamente más tarde.'
);

// 1 bulk SMS request per IP per hour
const bulkSmsIpLimiter = createIpSmsLimiter(
  bulkSmsIpStore,
  60 * 60 * 1000,
  1,
  'Demasiadas solicitudes de SMS masivo. Por favor, intenta nuevamente en una hora.'
);

// ============================================
// SEGURIDAD - HEADERS DE SEGURIDAD
// ============================================
function securityHeaders(req, res, next) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
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
  res.setHeader('Content-Security-Policy', [
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
    "media-src 'self' data: blob:"
  ].join('; '));
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
const refunds = require('./models/refunds');
const referralRevenueService = require('./src/services/referralRevenueService');
const { resolveJugayganaUserId } = require('./src/services/jugayganaUserLinkService');
const metaCapi = require('./src/services/metaCapiService');

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
  // Force WebSocket transport for lower latency and better behavior behind ALB/NLB.
  // Clients in public/js/socket.js already request ['websocket'] so this is consistent.
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
app.use(express.json({ limit: '10mb' }));
app.use(mongoSanitize());
app.use(xss());

// Fields exposed to the authenticated user about their own profile.
// Keep this list minimal – internal fields (jugaygana IDs, FCM tokens, etc.)
// are excluded intentionally to reduce accidental data exposure.
const USER_PUBLIC_FIELDS = 'id username email phone phoneVerified phoneVerificationPending whatsapp accountNumber role balance isActive referralCode referredByUserId referralStatus createdAt lastLogin mustChangePassword acquisitionCampaign notificationPlan';

// Admin roles are internal VIPCARGAS accounts that have NO counterpart in
// JUGAYGANA. They must never be routed through any JUGAYGANA sync, default-
// password detection, or mustChangePassword flow.
const ADMIN_ROLES = ['admin', 'depositor', 'withdrawer'];
const isAdminRole = (role) => ADMIN_ROLES.includes(role);

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
    const decoded = jwt.verify(cookieVal, JWT_SECRET);
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
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

// Admin panel HTML (serves the login form + app shell; cookie NOT required
// here so first-time visitors can authenticate via the login form).
app.get(['/adminprivado2026', '/adminprivado2026/'], adminHostCheck, (req, res) => {
  const adminPath = path.join(__dirname, 'public', 'adminprivado2026', 'index.html');
  const content = readFileSafe(adminPath);
  if (!content) return res.status(500).send('Error loading admin page');
  // Inyectar la URL pública canónica (vipcargas.com) para que el admin
  // genere los links de pauta con el dominio correcto y no con el de AWS.
  // El PUBLIC_BASE_URL viene de env var; ver constante más abajo en este archivo.
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || 'https://vipcargas.com').replace(/\/$/, '');
  const rendered = content.replace(/__VIP_PUBLIC_BASE_URL_PLACEHOLDER__/g, publicBaseUrl);
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
  const content = readFileSafe(cssPath);
  if (!content) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/css');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(content);
});

// Admin JS asset — host check only (same rationale as admin.css above).
app.get('/adminprivado2026/admin.js', adminHostCheck, (req, res) => {
  const jsPath = path.join(__dirname, 'public', 'adminprivado2026', 'admin.js');
  const content = readFileSafe(jsPath);
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

// Vanity URL para links de pauta: https://vipcargas.com/MI_CODIGO sirve la home
// con la atribución a esa campaña ya activa (sin necesidad de ?p=). Si el path
// no parece un código de campaña válido, llamamos next() para que express.static
// lo intente servir como recurso estático y caigamos al 404 si no existe.
app.get('/:code', async (req, res, next) => {
  const candidate = req.params.code || '';
  // Sólo procesar si parece un código de campaña: 3-40 chars, letras/números/_/-
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(candidate)) return next();
  // Excluir extensiones de archivo (favicons, etc.) y nombres conocidos del SW
  if (/\.(html|css|js|png|jpg|jpeg|ico|svg|json|webp|woff2?|map|txt|xml)$/i.test(candidate)) return next();
  if (['robots', 'sitemap', 'favicon', 'manifest'].includes(candidate.toLowerCase())) return next();

  try {
    const normalizedCode = candidate.toUpperCase();
    const campaign = await Campaign.findOne({ code: normalizedCode, isActive: true }).lean();
    if (!campaign) return next();

    const rendered = renderIndexHtml({ campaignCode: normalizedCode });
    if (!rendered) return res.status(500).send('Error loading page');
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(rendered);
  } catch (err) {
    logger.warn(`[vanity /:code] error: ${err.message}`);
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

const { sendNotificationToUser: _sendPushToUser, pruneInvalidFcmTokens, sendNotificationToAllUsers } = require('./src/services/notificationService');

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
  User.findOne({ id: receiverId })
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
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Buscar usuario por 'id' primero, luego por '_id' como fallback
    let user = await User.findOne({ id: decoded.userId });
    
    if (!user) {
      // Intentar buscar por _id (para usuarios migrados)
      try {
        user = await User.findById(decoded.userId);
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
    
    if (user.tokenVersion && decoded.tokenVersion !== user.tokenVersion) {
      return res.status(401).json({ error: 'Sesión expirada. Por favor, vuelve a iniciar sesión.' });
    }
    
    req.user = decoded;

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
          await user.save();
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
  if (req.user.role !== 'admin' && req.user.role !== 'depositor' && req.user.role !== 'withdrawer') {
    return res.status(403).json({ error: 'Acceso denegado. Solo administradores.' });
  }
  next();
};

const depositorMiddleware = (req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'depositor') {
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
    
    // Buscar case-insensitive
    const localExists = await User.findOne({ 
      username: { $regex: new RegExp('^' + escapeRegex(username) + '$', 'i') } 
    });
    
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
    
    // 1. Mensaje completo con todos los datos
    const fullMessage = `💳 *Datos para transferir:*\n\n🏦 Banco: ${cbuConfig.bank}\n👤 Titular: ${cbuConfig.titular}\n🔢 CBU: ${cbuConfig.number}\n📱 Alias: ${cbuConfig.alias}\n\n✅ Una vez realizada la transferencia, envianos el comprobante por aquí.`;
    
    await Message.create({
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
    
    // Notificar al usuario por socket si está conectado
    const userSocket = connectedUsers.get(userId);
    if (userSocket) {
      userSocket.emit('new_message', {
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
        const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
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
    const key = `chat-images/${req.user.userId}/${Date.now()}-${filename}`;
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
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { username, password, email, phone, referralCode, otpCode, campaignCode, utm } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    
    if (!phone || phone.trim().length < 8) {
      return res.status(400).json({ error: 'El número de teléfono es obligatorio (mínimo 8 dígitos)' });
    }

    const normalizedPhone = phone.trim();

    // Validar y verificar OTP antes de crear la cuenta
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

    // Check if phone is already registered and verified (second line of defense)
    const existingPhoneUser = await User.findOne({ phone: normalizedPhone, phoneVerified: true }).lean();
    if (existingPhoneUser) {
      return res.status(400).json({ error: 'Este número de teléfono ya está registrado' });
    }
    
    // Buscar case-insensitive
    const existingUser = await User.findOne({ 
      username: { $regex: new RegExp('^' + escapeRegex(username) + '$', 'i') } 
    });
    
    if (existingUser) {
      return res.status(400).json({ error: 'El usuario ya existe' });
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
        return res.status(400).json({ error: 'No se pudo crear el usuario en JUGAYGANA: ' + (jgResult.error || 'Error desconocido') });
      }
      
      logger.info(`User created/linked in JUGAYGANA: ${username}`);
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

    const newUser = await User.create({
      id: userId,
      username,
      password: password,
      email: email || null,
      phone: normalizedPhone,
      phoneVerified: true,
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
      acquiredAt: attributedCampaign ? new Date() : null
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
      { userId: newUser.id, username: newUser.username, role: newUser.role },
      JWT_SECRET,
      { expiresIn: '90d' }
    );

    // Meta CAPI — CompleteRegistration (conversión clave del funnel).
    metaCapi.track(
      'CompleteRegistration',
      { email: newUser.email, phone: newUser.phone, externalId: newUser.id },
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

    res.status(201).json({
      message: 'Usuario creado exitosamente',
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        phone: newUser.phone,
        accountNumber: newUser.accountNumber,
        role: newUser.role,
        balance: newUser.balance,
        jugayganaLinked: true,
        needsPasswordChange: false,
        referralCode: newUser.referralCode,
        referredBy: isValidReferral ? referrer.username : null
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
app.post('/api/auth/register-quick', authLimiter, async (req, res) => {
  try {
    const { username, password, email, campaignCode, visitorId, utm, metaEventId } = req.body || {};

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

    const existingUser = await User.findOne({
      username: { $regex: new RegExp('^' + escapeRegex(username) + '$', 'i') }
    }).lean();
    if (existingUser) {
      return res.status(400).json({ error: 'El usuario ya existe' });
    }

    // Crear en JUGAYGANA primero (igual que el flujo normal).
    let jgResult = null;
    try {
      jgResult = await jugaygana.syncUserToPlatform({ username, password });
      if (!jgResult.success && !jgResult.alreadyExists) {
        return res.status(400).json({ error: 'No se pudo crear el usuario en JUGAYGANA: ' + (jgResult.error || 'Error desconocido') });
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

    const newUser = await User.create({
      id: userId,
      username,
      password,
      email: email || null,
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
      acquiredAt: new Date()
    });

    await ChatStatus.create({
      userId,
      username,
      status: 'open',
      category: 'cargas',
      lastMessageAt: new Date()
    });

    const token = jwt.sign(
      { userId: newUser.id, username: newUser.username, role: newUser.role },
      JWT_SECRET,
      { expiresIn: '90d' }
    );

    // Meta CAPI — CompleteRegistration con campaign_code en custom_data.
    metaCapi.track(
      'CompleteRegistration',
      { email: newUser.email, externalId: newUser.id },
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
        acquisitionCampaign: normalizedCode
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
    const { username, phone, password, temporaryCode } = req.body;

    if ((!username && !phone) || (!password && !temporaryCode)) {
      return res.status(400).json({ error: 'Usuario o teléfono, y contraseña (o código temporal) requeridos' });
    }
    
    logger.debug(`Login attempt for: ${username || phone}`);
    
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
      // Username-based login
      try {
        user = await User.findOne({ 
          username: { $regex: new RegExp('^' + escapeRegex(username) + '$', 'i') } 
        });
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
      
      const jgUser = await jugaygana.getUserInfoByName(username);
      
      if (jgUser) {
        logger.debug(`User found in JUGAYGANA, creating locally...`);
        
        const userId = uuidv4();
        
        user = await User.create({
          id: userId,
          username: jgUser.username,
          password: 'asd123',
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
          tokenVersion: 0,
          // Auto-imported JUGAYGANA users start with the default password
          // "asd123"; force them to change it before they can use the app.
          mustChangePassword: true
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
    
    // Verificar si el usuario necesita cambiar la contraseña.
    // Admin roles (admin/depositor/withdrawer) are internal VIPCARGAS accounts and
    // must NEVER enter the mustChangePassword flow — even if their password is
    // "asd123". Only role=user is subject to this check.
    const isDefaultPassword = password === 'asd123';
    const needsPasswordChange = isAdminRole(userObj.role)
      ? false
      : ((!userObj.passwordChangedAt && userObj.source === 'jugaygana') || isDefaultPassword);
    
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

      // Fallback SOLO para usuarios auto-importados desde JUGAYGANA que aún no cambiaron
      // su contraseña real (la inicial real es "asd123"). Para evitar backdoor:
      //  - Sólo aplica si source === 'jugaygana' Y nunca cambió contraseña.
      //  - Sólo aplica para role=user (admins nunca tienen contraparte en JUGAYGANA).
      //  - Valida que el hash almacenado realmente corresponda a "asd123";
      //    si la DB guarda otro hash, NO se acepta "asd123" como atajo.
      if (!isValidPassword && password === 'asd123' && !userObj.passwordChangedAt && userObj.source === 'jugaygana' && !isAdminRole(userObj.role)) {
        try {
          isValidPassword = await bcrypt.compare('asd123', userObj.password);
        } catch (bcryptError) {
          logger.error(`Error verifying JUGAYGANA default password: ${bcryptError.message}`);
        }
      }
    }
    
    if (!isValidPassword) {
      logger.debug(`Wrong password for ${loginIdentifier}`);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    
    logger.info(`Login successful for ${loginIdentifier}`);
    
    // Actualizar lastLogin usando el modelo de Mongoose
    user.lastLogin = new Date();
    // Persist mustChangePassword only for non-admin roles. Admins are internal
    // VIPCARGAS accounts and are never blocked by the JUGAYGANA default-password
    // flow — even if their password happens to be "asd123".
    if (needsPasswordChange && !isAdminRole(user.role) && user.mustChangePassword !== true) {
      user.mustChangePassword = true;
    }
    // Self-heal: admins must NEVER carry mustChangePassword. If a stale flag
    // from before the role-isolation fix is still in DB, clear it on next login.
    if (isAdminRole(user.role) && user.mustChangePassword === true) {
      user.mustChangePassword = false;
      logger.info(`[login] Cleared stale mustChangePassword for admin ${user.username}`);
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
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
    if (adminRoles.includes(userObj.role)) {
      // Set two httpOnly cookies: one for page access, one for API calls.
      // Neither can be read by client-side scripts (XSS-safe).
      const adminCookieToken = jwt.sign(
        { userId: userId, username: userObj.username, role: userObj.role },
        JWT_SECRET,
        { expiresIn: '8h' }
      );
      res.setHeader('Set-Cookie', buildAdminSessionCookieHeaders(adminCookieToken));
    }

    // Meta CAPI — Login (custom event) sólo para usuarios finales, no admins.
    if (!isAdminRole(userObj.role)) {
      metaCapi.track(
        'Login',
        { email: userObj.email, phone: userObj.phone, externalId: userId },
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
        notificationPlan: userObj.notificationPlan || null,
        whatsapp: userObj.whatsapp || null,
        accountNumber: userObj.accountNumber,
        role: userObj.role,
        balance: userObj.balance,
        jugayganaLinked: !!userObj.jugayganaUserId,
        needsPasswordChange: needsPasswordChange,
        mustChangePassword: isAdminRole(userObj.role)
          ? false
          : (needsPasswordChange || userObj.mustChangePassword === true)
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
        const decoded = jwt.verify(authToken, JWT_SECRET);
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
        mustChangePassword: user.mustChangePassword === true
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
    const decoded = jwt.verify(cookieToken, JWT_SECRET);
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
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
        needsPasswordChange: !user.passwordChangedAt
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
    
    res.json(user);
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
      // Verificar que el teléfono no esté ya registrado y verificado por otro usuario.
      const otherUser = await User.findOne({
        phone: requestedPhone,
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
      user.phoneVerified = true;
      user.smsConsent = true;
      // Mantener `whatsapp` sincronizado para compatibilidad con vistas que lo siguen leyendo.
      user.whatsapp = requestedPhone;
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

    // Si otro usuario distinto ya tiene este teléfono verificado, rechazar.
    const otherUser = await User.findOne({
      phone: normalizedPhone,
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
    const pendingCode = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');

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
      const existing = await User.findOne({
        username: { $regex: new RegExp('^' + escapeRegex(String(username).trim()) + '$', 'i') }
      }).lean();
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

    // Set admin cookies if applicable
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
    if (adminRoles.includes(userObj.role)) {
      const adminCookieToken = jwt.sign(
        { userId: userId, username: userObj.username, role: userObj.role },
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

    // Generar JWT temporal de 5 minutos solo para reset
    const resetToken = jwt.sign(
      { userId: user.id, username: user.username, purpose: 'reset' },
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
      decoded = jwt.verify(resetToken, JWT_SECRET);
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

    // Cambiar contraseña
    user.password = newPassword;
    user.passwordChangedAt = new Date();
    // Recovering the password via SMS counts as completing a password change,
    // so lift any pending `mustChangePassword` enforcement.
    user.mustChangePassword = false;
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

    // Si ese teléfono ya está verificado por otro usuario, rechazar.
    const existingPhone = await User.findOne({
      phone: normalizedPhone,
      phoneVerified: true,
      id: { $ne: req.user.userId }
    }).lean();
    if (existingPhone) {
      return res.status(400).json({ error: 'Este número ya está vinculado a otra cuenta' });
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

    // Volver a chequear unicidad por si alguien más verificó ese número entre el send y el confirm.
    const existingPhone = await User.findOne({
      phone: normalizedPhone,
      phoneVerified: true,
      id: { $ne: req.user.userId }
    }).lean();
    if (existingPhone) {
      return res.status(400).json({ error: 'Este número ya está vinculado a otra cuenta' });
    }

    const user = await User.findOne({ id: req.user.userId });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    user.phone = normalizedPhone;
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
    
    // 2. Mensaje completo con CBU
    const fullMessage = `💳 *Datos para transferir:*\n\n🏦 Banco: ${cbuConfig.bank}\n👤 Titular: ${cbuConfig.titular}\n🔢 CBU: ${cbuConfig.number}\n📱 Alias: ${cbuConfig.alias}\n\n✅ Una vez realizada la transferencia, envianos el comprobante por aquí.`;
    
    await Message.create({
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
        { email: u && u.email, phone: u && u.phone, externalId: req.user.userId },
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

// ============================================
// RUTAS DE USUARIOS (ADMIN)
// ============================================

app.get('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await User.find().select('-password').lean();
    res.json(users);
  } catch (error) {
    console.error('Error obteniendo usuarios:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { username, password, email, phone, role = 'user', balance = 0 } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña son requeridos' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    
    if (!phone || phone.trim().length < 8) {
      return res.status(400).json({ error: 'El número de teléfono es obligatorio (mínimo 8 dígitos)' });
    }
    
    const validRoles = ['user', 'admin', 'depositor', 'withdrawer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }
    
    // Buscar case-insensitive
    const existingUser = await User.findOne({ 
      username: { $regex: new RegExp('^' + escapeRegex(username) + '$', 'i') } 
    });
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
      balance,
      createdAt: new Date(),
      lastLogin: null,
      isActive: true,
      jugayganaUserId: null,
      jugayganaUsername: null,
      jugayganaSyncStatus: role === 'user' ? 'pending' : 'not_applicable'
    });
    
    // Crear chat status
    await ChatStatus.create({
      userId: userId,
      username: username,
      status: 'open',
      category: 'cargas'
    });
    
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
      const validRoles = ['user', 'admin', 'depositor', 'withdrawer'];
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
    
    const user = await User.findOneAndUpdate(
      { id },
      { $set: updates },
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
    
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
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

app.get('/api/admin/chats/:status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { status } = req.params;
    
    const chatStatuses = await ChatStatus.find({ 
      status,
      category: { $ne: 'pagos' }
    }).lean();
    
    const userIds = chatStatuses.map(cs => cs.userId);
    
    const messages = await Message.find({
      $or: [
        { senderId: { $in: userIds } },
        { receiverId: { $in: userIds } }
      ]
    }).sort({ timestamp: 1 }).lean();
    
    const users = await User.find({ id: { $in: userIds } }).lean();
    
    const userMessages = {};
    messages.forEach(msg => {
      if (msg.senderRole === 'user') {
        if (!userMessages[msg.senderId]) userMessages[msg.senderId] = [];
        userMessages[msg.senderId].push(msg);
      }
      if (msg.receiverRole === 'user' && msg.senderRole !== 'user') {
        if (!userMessages[msg.receiverId]) userMessages[msg.receiverId] = [];
        userMessages[msg.receiverId].push(msg);
      }
    });
    
    const filteredChats = [];
    
    for (const chatStatus of chatStatuses) {
      const user = users.find(u => u.id === chatStatus.userId);
      if (!user) continue;
      
      const msgs = userMessages[chatStatus.userId] || [];
      if (msgs.length === 0) continue;
      
      const lastMsg = msgs[msgs.length - 1];
      const unreadCount = msgs.filter(m => m.receiverRole === 'admin' && !m.read).length;
      
      filteredChats.push({
        userId: chatStatus.userId,
        username: user.username,
        lastMessage: lastMsg,
        unreadCount,
        assignedTo: chatStatus.assignedTo,
        closedAt: chatStatus.closedAt,
        closedBy: chatStatus.closedBy
      });
    }
    
    filteredChats.sort((a, b) => new Date(b.lastMessage.timestamp) - new Date(a.lastMessage.timestamp));
    
    res.json(filteredChats);
  } catch (error) {
    console.error('Error obteniendo chats:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/api/admin/all-chats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const messages = await Message.find().lean();
    const users = await User.find().lean();
    const chatStatuses = await ChatStatus.find().lean();
    
    const userMessages = {};
    messages.forEach(msg => {
      if (msg.senderRole === 'user') {
        if (!userMessages[msg.senderId]) userMessages[msg.senderId] = [];
        userMessages[msg.senderId].push(msg);
      }
      if (msg.receiverRole === 'user') {
        if (!userMessages[msg.receiverId]) userMessages[msg.receiverId] = [];
        userMessages[msg.receiverId].push(msg);
      }
    });
    
    const allChats = Object.keys(userMessages).map(userId => {
      const user = users.find(u => u.id === userId);
      const statusInfo = chatStatuses.find(cs => cs.userId === userId) || { status: 'open', assignedTo: null };
      const msgs = userMessages[userId].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      
      return {
        userId,
        username: user?.username || 'Desconocido',
        status: statusInfo.status,
        messageCount: msgs.length,
        lastMessage: msgs[msgs.length - 1]
      };
    });
    
    res.json(allChats);
  } catch (error) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/admin/chats/:userId/close', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    
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

app.get('/api/admin/chats/category/:category', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { category } = req.params;
    
    const chatStatuses = await ChatStatus.find({ category }).lean();
    const userIds = chatStatuses.map(cs => cs.userId);
    
    const messages = await Message.find({
      $or: [
        { senderId: { $in: userIds } },
        { receiverId: { $in: userIds } }
      ]
    }).sort({ timestamp: 1 }).lean();
    
    const users = await User.find({ id: { $in: userIds } }).lean();
    
    const userMessages = {};
    messages.forEach(msg => {
      if (msg.senderRole === 'user') {
        if (!userMessages[msg.senderId]) userMessages[msg.senderId] = [];
        userMessages[msg.senderId].push(msg);
      }
      if (msg.receiverRole === 'user' && msg.senderRole !== 'user') {
        if (!userMessages[msg.receiverId]) userMessages[msg.receiverId] = [];
        userMessages[msg.receiverId].push(msg);
      }
    });
    
    const filteredChats = [];
    
    for (const chatStatus of chatStatuses) {
      const user = users.find(u => u.id === chatStatus.userId);
      if (!user) continue;
      
      const msgs = userMessages[chatStatus.userId] || [];
      if (msgs.length === 0) continue;
      
      const lastMsg = msgs[msgs.length - 1];
      const unreadCount = msgs.filter(m => m.receiverRole === 'admin' && !m.read).length;
      
      filteredChats.push({
        userId: chatStatus.userId,
        username: user.username,
        lastMessage: lastMsg,
        unreadCount,
        assignedTo: chatStatus.assignedTo,
        status: chatStatus.status
      });
    }
    
    filteredChats.sort((a, b) => new Date(b.lastMessage.timestamp) - new Date(a.lastMessage.timestamp));
    res.json(filteredChats);
  } catch (error) {
    console.error('Error obteniendo chats por categoría:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// RUTAS DE MENSAJES
// ============================================

// OPTIMIZADO: Sin logs, con proyección mínima
app.get('/api/messages/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const before = req.query.before ? new Date(req.query.before) : null;

    const allowedRoles = ['admin', 'depositor', 'withdrawer'];
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
    const messages = await Message.find().sort({ timestamp: -1 }).lean();
    const users = await User.find().lean();
    
    const conversations = {};
    
    messages.forEach(msg => {
      let userId = null;
      
      if (msg.senderRole === 'user') {
        userId = msg.senderId;
      } else if (msg.receiverRole === 'user') {
        userId = msg.receiverId;
      }
      
      if (!userId) return;
      
      if (!conversations[userId]) {
        const user = users.find(u => u.id === userId);
        conversations[userId] = {
          userId,
          username: user?.username || 'Desconocido',
          accountNumber: user?.accountNumber || '',
          lastMessage: msg,
          unreadCount: (msg.receiverRole === 'admin' && !msg.read) ? 1 : 0
        };
      } else {
        if (msg.receiverRole === 'admin' && !msg.read) {
          conversations[userId].unreadCount++;
        }
      }
    });
    
    res.json(Object.values(conversations));
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

app.post('/api/messages/send', authMiddleware, async (req, res) => {
  try {
    const { content, type = 'text', receiverId } = req.body;
    
    logger.debug(`[API_MESSAGES_SEND] user=${req.user.username} role=${req.user.role} receiverId=${receiverId} type=${type}`);
    
    if (!content) {
      logger.debug('[API_MESSAGES_SEND] ERROR: content required');
      return res.status(400).json({ error: 'Contenido requerido' });
    }

    // SECURITY: Validate message type to prevent type confusion
    const allowedTypes = ['text', 'image', 'video'];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({ error: 'Tipo de mensaje no válido' });
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
    
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
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
    } else {
      // Admin enviando mensaje - notificar al usuario
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

app.get('/api/refunds/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    
    const userInfo = await jugaygana.getUserInfoByName(username);
    const currentBalance = userInfo ? userInfo.balance : 0;
    
    // Rangos de fechas (zona horaria Argentina)
    const yesterdayRange = jugaygana.getYesterdayRangeArgentinaEpoch();
    const lastWeekRange = jugaygana.getLastWeekRangeArgentinaEpoch();
    const lastMonthRange = jugaygana.getLastMonthRangeArgentinaEpoch();
    
    const [dailyStatus, weeklyStatus, monthlyStatus] = await Promise.all([
      refunds.canClaimDailyRefund(userId),
      refunds.canClaimWeeklyRefund(userId),
      refunds.canClaimMonthlyRefund(userId)
    ]);
    
    // Rangos de fechas para calcular depósitos y retiros reales
    const dailyFrom = new Date(yesterdayRange.fromEpoch * 1000);
    const dailyTo = new Date(yesterdayRange.toEpoch * 1000);
    const weeklyFrom = new Date(lastWeekRange.fromEpoch * 1000);
    const weeklyTo = new Date(lastWeekRange.toEpoch * 1000);
    const monthlyFrom = new Date(lastMonthRange.fromEpoch * 1000);
    const monthlyTo = new Date(lastMonthRange.toEpoch * 1000);

    // Calcular depósitos y retiros reales del período (no GGR de juegos)
    const [dailyDepositsAgg, dailyWithdrawalsAgg, weeklyDepositsAgg, weeklyWithdrawalsAgg, monthlyDepositsAgg, monthlyWithdrawalsAgg] = await Promise.all([
      Transaction.aggregate([{ $match: { username, type: 'deposit', createdAt: { $gte: dailyFrom, $lte: dailyTo } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Transaction.aggregate([{ $match: { username, type: 'withdrawal', createdAt: { $gte: dailyFrom, $lte: dailyTo } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Transaction.aggregate([{ $match: { username, type: 'deposit', createdAt: { $gte: weeklyFrom, $lte: weeklyTo } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Transaction.aggregate([{ $match: { username, type: 'withdrawal', createdAt: { $gte: weeklyFrom, $lte: weeklyTo } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Transaction.aggregate([{ $match: { username, type: 'deposit', createdAt: { $gte: monthlyFrom, $lte: monthlyTo } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Transaction.aggregate([{ $match: { username, type: 'withdrawal', createdAt: { $gte: monthlyFrom, $lte: monthlyTo } } }, { $group: { _id: null, total: { $sum: '$amount' } } }])
    ]);

    const dailyDeposits = dailyDepositsAgg[0]?.total || 0;
    const dailyWithdrawals = dailyWithdrawalsAgg[0]?.total || 0;
    const weeklyDeposits = weeklyDepositsAgg[0]?.total || 0;
    const weeklyWithdrawals = weeklyWithdrawalsAgg[0]?.total || 0;
    const monthlyDeposits = monthlyDepositsAgg[0]?.total || 0;
    const monthlyWithdrawals = monthlyWithdrawalsAgg[0]?.total || 0;

    const dailyNetLoss = Math.max(0, dailyDeposits - dailyWithdrawals);
    const weeklyNetLoss = Math.max(0, weeklyDeposits - weeklyWithdrawals);
    const monthlyNetLoss = Math.max(0, monthlyDeposits - monthlyWithdrawals);

    logger.info(`[REFUND] status — usuario: ${username} daily depositos:${dailyDeposits} retiros:${dailyWithdrawals} netLoss:${dailyNetLoss}`);
    logger.info(`[REFUND] status — usuario: ${username} weekly depositos:${weeklyDeposits} retiros:${weeklyWithdrawals} netLoss:${weeklyNetLoss}`);
    logger.info(`[REFUND] status — usuario: ${username} monthly depositos:${monthlyDeposits} retiros:${monthlyWithdrawals} netLoss:${monthlyNetLoss}`);

    const dailyPotential = Math.round(dailyNetLoss * 0.20);
    const weeklyPotential = Math.round(weeklyNetLoss * 0.10);
    const monthlyPotential = Math.round(monthlyNetLoss * 0.05);
    
    res.json({
      user: {
        username,
        currentBalance,
        jugayganaLinked: !!userInfo
      },
      daily: {
        ...dailyStatus,
        potentialAmount: dailyPotential,
        netAmount: dailyNetLoss,
        percentage: 20,
        period: yesterdayRange.dateStr
      },
      weekly: {
        ...weeklyStatus,
        potentialAmount: weeklyPotential,
        netAmount: weeklyNetLoss,
        percentage: 10,
        period: `${lastWeekRange.fromDateStr} a ${lastWeekRange.toDateStr}`
      },
      monthly: {
        ...monthlyStatus,
        potentialAmount: monthlyPotential,
        netAmount: monthlyNetLoss,
        percentage: 5,
        period: `${lastMonthRange.fromDateStr} a ${lastMonthRange.toDateStr}`
      }
    });
  } catch (error) {
    console.error('Error obteniendo estado de reembolsos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/refunds/claim/daily', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    
    if (!await acquireRefundLock(userId, 'daily')) {
      return res.json({
        success: false,
        message: '⏳ Ya estás procesando un reembolso. Por favor espera...',
        canClaim: true,
        processing: true
      });
    }
    
    try {
      const status = await refunds.canClaimDailyRefund(userId);
      
      if (!status.canClaim) {
        return res.json({
          success: false,
          message: 'Ya reclamaste tu reembolso diario. Vuelve mañana!',
          canClaim: false,
          nextClaim: status.nextClaim
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
      
      const { fromEpoch, toEpoch, dateStr } = jugaygana.getYesterdayRangeArgentinaEpoch();
      const fromDate = new Date(fromEpoch * 1000);
      const toDate = new Date(toEpoch * 1000);

      // Obtener depósitos REALES del período
      const periodDeposits = await Transaction.aggregate([
        { $match: { username, type: 'deposit', createdAt: { $gte: fromDate, $lte: toDate } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      const totalDeposits = periodDeposits[0]?.total || 0;

      // Obtener retiros REALES del período
      const periodWithdrawals = await Transaction.aggregate([
        { $match: { username, type: 'withdrawal', createdAt: { $gte: fromDate, $lte: toDate } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      const totalWithdrawals = periodWithdrawals[0]?.total || 0;

      logger.info('[REFUND] daily — usuario:', username, 'depositos:', totalDeposits, 'retiros:', totalWithdrawals);

      // Calcular pérdida real (lo que depositó y NO retiró)
      const netLoss = Math.max(0, totalDeposits - totalWithdrawals);

      if (netLoss === 0) {
        logger.info('[REFUND] daily — sin pérdida neta para:', username);
        return res.json({
          success: false,
          message: 'No tenés pérdida neta en el período. El reembolso aplica solo sobre depósitos no recuperados vía retiros.',
          canClaim: true,
          netAmount: 0
        });
      }

      // Calcular monto del reembolso (20% para daily)
      const refundAmount = Math.round(netLoss * 0.20);

      logger.info('[REFUND] daily — calculado para', username, 'netLoss:', netLoss, 'refund:', refundAmount);
      
      const depositResult = await jugaygana.creditUserBalance(username, refundAmount);
      
      if (!depositResult.success) {
        return res.json({
          success: false,
          message: 'Error al acreditar el reembolso: ' + depositResult.error,
          canClaim: true
        });
      }
      
      // Guardar reclamo en MongoDB
      await RefundClaim.create({
        id: uuidv4(),
        userId,
        username,
        type: 'daily',
        amount: refundAmount,
        netAmount: netLoss,
        percentage: 20,
        period: dateStr,
        transactionId: depositResult.data?.transfer_id || depositResult.data?.transferId,
        claimedAt: new Date()
      });
      
      // Guardar transacción para el dashboard
      await Transaction.create({
        id: uuidv4(),
        type: 'refund',
        amount: refundAmount,
        username,
        description: `Reembolso diario (${dateStr})`,
        transactionId: depositResult.data?.transfer_id || depositResult.data?.transferId,
        timestamp: new Date()
      });

      // Meta CAPI — RefundClaim (señal de fricción / usuario que pierde plata).
      try {
        const u = await User.findOne({ id: userId }).lean();
        metaCapi.track(
          'RefundClaim',
          { email: u && u.email, phone: u && u.phone, externalId: userId },
          { value: refundAmount, currency: 'ARS', content_name: 'refund_daily', period: dateStr },
          { eventId: req.body && req.body.metaEventId, req }
        );
      } catch (e) { /* tracking nunca bloquea */ }

      res.json({
        success: true,
        message: `¡Reembolso diario de $${refundAmount} acreditado!`,
        amount: refundAmount,
        percentage: 20,
        netAmount: netLoss,
        nextClaim: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      });
    } finally {
      setTimeout(() => releaseRefundLock(userId, 'daily'), 3000);
    }
  } catch (error) {
    console.error('Error reclamando reembolso diario:', error);
    res.json({ success: false, message: 'Error del servidor', canClaim: true });
  }
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

      // Obtener depósitos REALES del período
      const periodDeposits = await Transaction.aggregate([
        { $match: { username, type: 'deposit', createdAt: { $gte: fromDate, $lte: toDate } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      const totalDeposits = periodDeposits[0]?.total || 0;

      // Obtener retiros REALES del período
      const periodWithdrawals = await Transaction.aggregate([
        { $match: { username, type: 'withdrawal', createdAt: { $gte: fromDate, $lte: toDate } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      const totalWithdrawals = periodWithdrawals[0]?.total || 0;

      logger.info('[REFUND] weekly — usuario:', username, 'depositos:', totalDeposits, 'retiros:', totalWithdrawals);

      // Calcular pérdida real (lo que depositó y NO retiró)
      const netLoss = Math.max(0, totalDeposits - totalWithdrawals);

      if (netLoss === 0) {
        logger.info('[REFUND] weekly — sin pérdida neta para:', username);
        return res.json({
          success: false,
          message: 'No tenés pérdida neta en el período. El reembolso aplica solo sobre depósitos no recuperados vía retiros.',
          canClaim: true,
          netAmount: 0
        });
      }

      // Calcular monto del reembolso (10% para weekly)
      const refundAmount = Math.round(netLoss * 0.10);

      logger.info('[REFUND] weekly — calculado para', username, 'netLoss:', netLoss, 'refund:', refundAmount);
      
      const depositResult = await jugaygana.creditUserBalance(username, refundAmount);
      
      if (!depositResult.success) {
        return res.json({
          success: false,
          message: 'Error al acreditar el reembolso: ' + depositResult.error,
          canClaim: true
        });
      }
      
      // Guardar reclamo en MongoDB
      await RefundClaim.create({
        id: uuidv4(),
        userId,
        username,
        type: 'weekly',
        amount: refundAmount,
        netAmount: netLoss,
        percentage: 10,
        period: `${fromDateStr} a ${toDateStr}`,
        transactionId: depositResult.data?.transfer_id || depositResult.data?.transferId,
        claimedAt: new Date()
      });
      
      // Guardar transacción para el dashboard
      await Transaction.create({
        id: uuidv4(),
        type: 'refund',
        amount: refundAmount,
        username,
        description: `Reembolso semanal (${fromDateStr} a ${toDateStr})`,
        transactionId: depositResult.data?.transfer_id || depositResult.data?.transferId,
        timestamp: new Date()
      });

      // Meta CAPI — RefundClaim semanal.
      try {
        const u = await User.findOne({ id: userId }).lean();
        metaCapi.track(
          'RefundClaim',
          { email: u && u.email, phone: u && u.phone, externalId: userId },
          { value: refundAmount, currency: 'ARS', content_name: 'refund_weekly', period: `${fromDateStr} a ${toDateStr}` },
          { eventId: req.body && req.body.metaEventId, req }
        );
      } catch (e) { /* tracking nunca bloquea */ }

      res.json({
        success: true,
        message: `¡Reembolso semanal de $${refundAmount} acreditado!`,
        amount: refundAmount,
        percentage: 10,
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

      // Obtener depósitos REALES del período
      const periodDeposits = await Transaction.aggregate([
        { $match: { username, type: 'deposit', createdAt: { $gte: fromDate, $lte: toDate } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      const totalDeposits = periodDeposits[0]?.total || 0;

      // Obtener retiros REALES del período
      const periodWithdrawals = await Transaction.aggregate([
        { $match: { username, type: 'withdrawal', createdAt: { $gte: fromDate, $lte: toDate } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      const totalWithdrawals = periodWithdrawals[0]?.total || 0;

      logger.info('[REFUND] monthly — usuario:', username, 'depositos:', totalDeposits, 'retiros:', totalWithdrawals);

      // Calcular pérdida real (lo que depositó y NO retiró)
      const netLoss = Math.max(0, totalDeposits - totalWithdrawals);

      if (netLoss === 0) {
        logger.info('[REFUND] monthly — sin pérdida neta para:', username);
        return res.json({
          success: false,
          message: 'No tenés pérdida neta en el período. El reembolso aplica solo sobre depósitos no recuperados vía retiros.',
          canClaim: true,
          netAmount: 0
        });
      }

      // Calcular monto del reembolso (5% para monthly)
      const refundAmount = Math.round(netLoss * 0.05);

      logger.info('[REFUND] monthly — calculado para', username, 'netLoss:', netLoss, 'refund:', refundAmount);
      
      const depositResult = await jugaygana.creditUserBalance(username, refundAmount);
      
      if (!depositResult.success) {
        return res.json({
          success: false,
          message: 'Error al acreditar el reembolso: ' + depositResult.error,
          canClaim: true
        });
      }
      
      // Guardar reclamo en MongoDB
      await RefundClaim.create({
        id: uuidv4(),
        userId,
        username,
        type: 'monthly',
        amount: refundAmount,
        netAmount: netLoss,
        percentage: 5,
        period: `${fromDateStr} a ${toDateStr}`,
        transactionId: depositResult.data?.transfer_id || depositResult.data?.transferId,
        claimedAt: new Date()
      });
      
      // Guardar transacción para el dashboard
      await Transaction.create({
        id: uuidv4(),
        type: 'refund',
        amount: refundAmount,
        username,
        description: `Reembolso mensual (${fromDateStr} a ${toDateStr})`,
        transactionId: depositResult.data?.transfer_id || depositResult.data?.transferId,
        timestamp: new Date()
      });

      // Meta CAPI — RefundClaim mensual.
      try {
        const u = await User.findOne({ id: userId }).lean();
        metaCapi.track(
          'RefundClaim',
          { email: u && u.email, phone: u && u.phone, externalId: userId },
          { value: refundAmount, currency: 'ARS', content_name: 'refund_monthly', period: `${fromDateStr} a ${toDateStr}` },
          { eventId: req.body && req.body.metaEventId, req }
        );
      } catch (e) { /* tracking nunca bloquea */ }

      res.json({
        success: true,
        message: `¡Reembolso mensual de $${refundAmount} acreditado!`,
        amount: refundAmount,
        percentage: 5,
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
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }
    
    const result = await jugaygana.depositToUser(user.username, parseFloat(amount), description);
    
    if (result.success) {
      // Si hay bonus, acreditarlo en JUGAYGANA como individual_bonus en operación separada
      let bonusJgResult = null;
      if (parseFloat(bonus) > 0) {
        bonusJgResult = await jugaygana.creditUserBalance(user.username, parseFloat(bonus));
        if (!bonusJgResult.success) {
          console.error('Error al acreditar bonus en JUGAYGANA:', bonusJgResult.error);
        }
      }

      await recordUserActivity(user.id, 'deposit', parseFloat(amount));

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

      // Obtener saldo actualizado del usuario
      const balanceResult = await jugayganaMovements.getUserBalance(user.username);
      const newBalance = balanceResult.success ? balanceResult.balance : (result.data?.user_balance_after || 0);
      
      // Crear mensaje de sistema para el usuario
      const depositCmdName = parseFloat(bonus) > 0 ? '/sys_deposit_bonus' : '/sys_deposit';
      const depositCmd = await Command.findOne({ name: depositCmdName, isActive: true });
      let messageContent;
      if (depositCmd && depositCmd.response) {
        messageContent = depositCmd.response
          .replace(/\{amount\}/g, amount)
          .replace(/\{bonus\}/g, bonus)
          .replace(/\{balance\}/g, newBalance);
      } else if (bonus > 0) {
        messageContent = `🔒💰 Depósito de $${amount} (incluye $${bonus} de bonificación) acreditado con éxito. ✅ \n💸 Tu nuevo saldo es $${newBalance} 💸\n\nPuedes verificarlo en: https://jugaygana.bet\n\n🔥 Mañana podes revisar si tenes reembolso para reclamar de forma automatica 🔥`;
      } else {
        messageContent = `🔒💰 Depósito de $${amount} acreditado con éxito. ✅ \n💸 Tu nuevo saldo es $${newBalance} 💸\n\nPuedes verificarlo en: https://jugaygana.bet\n\n🔥 Mañana podes revisar si tenes reembolso para reclamar de forma automatica 🔥`;
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

      // Segundo mensaje recordatorio
      const reminderCmd = await Command.findOne({ name: '/sys_reminder', isActive: true });
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

      // Cartel "instalá la app" — solo si el usuario TODAVÍA NO la tiene instalada.
      // Detección: tener un token FCM de contexto 'standalone' = PWA instalada.
      const hasAppInstalled = user.fcmTokenContext === 'standalone'
        || (Array.isArray(user.fcmTokens) && user.fcmTokens.some(t => t && t.context === 'standalone'));

      if (!hasAppInstalled) {
        const installCmd = await Command.findOne({ name: '/sys_install_app', isActive: true });
        const installContent = (installCmd && installCmd.response)
          ? installCmd.response.replace(/\{amount\}/g, amount).replace(/\{balance\}/g, newBalance)
          : `🎁━━━━━━━━━━━━━━━🎁\n📲 INSTALÁ LA APP\n   Y GANÁ $5.000 🎁\n🎁━━━━━━━━━━━━━━━🎁\n\n¿Todavía no instalaste la app? ¡Hacelo ahora y reclamá tu BONO DE $5.000! 🤑\n\n✅ Te avisamos al toque de tus bonos y reembolsos\n✅ Entrás más rápido y no perdés tu cuenta\n\n📲 Tocá "📱 Instalar App" o, en el menú del navegador, elegí "Agregar a pantalla de inicio".\n\n🎁 Una vez instalada, abrí la app y tocá el botón "🎁 Reclamar $5.000" que vas a ver arriba del chat. ¡El bono se acredita al instante!`;

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
      }

      // Notificar al usuario específico si está conectado
      const userSocket = connectedUsers.get(user.id);
      if (userSocket) {
        userSocket.emit('balance_updated', { balance: newBalance });
      }

      // Push FCM para usuarios offline: enviar si tiene token registrado.
      // El mensaje ya se entregó por Socket.IO a usuarios online; FCM cubre offline/background.
      {
        const depositBonus = parseFloat(bonus) || 0;
        const depositPushTitle = depositBonus > 0
          ? `💰 Depósito + bonus acreditado`
          : `💰 Depósito acreditado`;
        const depositPushBody = `$${amount} acreditados en tu cuenta. Nuevo saldo: $${newBalance}.`;
        sendPushIfOffline(user, depositPushTitle, depositPushBody, { tag: 'deposit' }).catch((e) => {
          logger.warn(`[FCM] sendPushIfOffline (deposit) falló para ${user.username}: ${e.message}`);
        });
      }
      
      await Transaction.create({
        id: uuidv4(),
        type: 'deposit',
        amount: parseFloat(amount),
        bonus: parseFloat(bonus),
        username: user.username,
        userId: user.id,
        description: description || 'Depósito realizado',
        adminId: req.user?.userId,
        adminUsername: req.user?.username,
        adminRole: req.user?.role || 'admin',
        transactionId: result.data?.transfer_id || result.data?.transferId,
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
      metaCapi.track(
        'Purchase',
        { email: user.email, phone: user.phone, externalId: user.id },
        {
          value: parseFloat(amount),
          currency: 'ARS',
          content_name: 'deposit_admin',
          content_type: 'product'
        },
        { req }
      );

      res.json({
        success: true,
        message: 'Depósito realizado correctamente',
        newBalance: newBalance,
        transactionId: result.data?.transfer_id || result.data?.transferId
      });
    } else {
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

    if (!amount || amount <= 0) {
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
      
      // Obtener saldo actualizado del usuario
      const balanceResult = await jugayganaMovements.getUserBalance(user.username);
      const newBalance = balanceResult.success ? balanceResult.balance : (result.data?.user_balance_after || 0);
      
      // Crear mensaje de sistema para el usuario
      const withdrawalCmd = await Command.findOne({ name: '/sys_withdrawal', isActive: true });
      const messageContent = (withdrawalCmd && withdrawalCmd.response)
        ? withdrawalCmd.response
            .replace(/\{amount\}/g, amount)
            .replace(/\{balance\}/g, newBalance)
        : `🔒💸 Retiro de $${amount} realizado correctamente. \n💸 Tu nuevo saldo es $${newBalance} 💸\nSu pago se está procesando. Por favor, aguarde un momento.`;
      
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
      
      // Notificar al usuario específico si está conectado
      const userSocket = connectedUsers.get(user.id);
      if (userSocket) {
        userSocket.emit('balance_updated', { balance: newBalance });
      }

      // Push FCM para usuarios offline.
      sendPushIfOffline(user, '💸 Retiro procesado', `$${amount} enviados. Nuevo saldo: $${newBalance}.`, { tag: 'withdrawal' }).catch((e) => {
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
        { email: user.email, phone: user.phone, externalId: user.id },
        { value: parseFloat(amount), currency: 'ARS', content_name: 'withdraw_admin' },
        { req }
      );

      res.json({
        success: true,
        message: 'Retiro realizado correctamente',
        newBalance: newBalance,
        transactionId: result.data?.transfer_id || result.data?.transferId
      });
    } else {
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

    // Resolver username: puede venir como username directo o como userId
    // Rechazar cualquier userId que no sea string primitivo (previene inyección NoSQL)
    let resolvedUsername = rawUsername && typeof rawUsername === 'string' ? rawUsername.trim() : null;
    if (!resolvedUsername && rawUserId) {
      if (typeof rawUserId !== 'string') {
        return res.status(400).json({ error: 'userId inválido' });
      }
      const safeUserId = rawUserId.trim();
      const user = await User.findOne({ id: safeUserId });
      if (!user) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }
      resolvedUsername = user.username;
    }

    if (!resolvedUsername || !amount) {
      return res.status(400).json({ error: 'Usuario y monto requeridos' });
    }
    
    const bonusAmount = parseFloat(amount);
    if (isNaN(bonusAmount) || bonusAmount <= 0) {
      return res.status(400).json({ error: 'Monto de bonificación inválido' });
    }
    
    const depositResult = await jugaygana.creditUserBalance(resolvedUsername, bonusAmount);
    
    if (depositResult.success) {
      // Buscar usuario para obtener su id (necesario para el mensaje)
      const bonusUser = await User.findOne({ username: resolvedUsername });

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

      // Obtener saldo actualizado para incluirlo en el mensaje
      const balanceResult = await jugayganaMovements.getUserBalance(resolvedUsername);
      const newBalance = balanceResult.success ? balanceResult.balance : null;

      // Enviar mensaje automático al usuario con el monto acreditado y el saldo actual
      if (bonusUser) {
        try {
          const bonusCmd = await Command.findOne({ name: '/sys_bonus', isActive: true });
          let bonusMsg;
          if (bonusCmd && bonusCmd.response) {
            bonusMsg = bonusCmd.response
              .replace(/\$\{amount\}/g, bonusAmount)
              .replace(/\$\{balance\}/g, newBalance !== null ? newBalance : '—');
          } else {
            bonusMsg = `🎁 ¡Bonificación de $${bonusAmount} acreditada en tu cuenta! ✅\n💸 Tu saldo actual es $${newBalance !== null ? newBalance : '—'} 💸\n\nPuedes verificarlo en: https://www.jugaygana44.bet`;
          }
          await Message.create({
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
  
  socket.on('authenticate', (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.userId = decoded.userId;
      socket.username = decoded.username;
      socket.role = decoded.role;
      
      if (['admin', 'depositor', 'withdrawer'].includes(decoded.role)) {
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
    if (['admin', 'depositor', 'withdrawer'].includes(socket.role)) {
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
    if (['admin', 'depositor', 'withdrawer'].includes(socket.role) && data && data.userId) {
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

      // SECURITY: Validate message type to prevent type confusion
      const allowedMsgTypes = ['text', 'image', 'video'];
      if (!allowedMsgTypes.includes(type)) {
        return socket.emit('error', { message: 'Tipo de mensaje no válido' });
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
      const isAdminRole = ['admin', 'depositor', 'withdrawer'].includes(socket.role);
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
      
      // Asegurar que el ChatStatus existe
      const targetUserId = isAdminRole ? receiverId : socket.userId;
      if (targetUserId) {
        const user = await User.findOne({ id: targetUserId });
        
        const updateData = {
          userId: targetUserId,
          username: user ? user.username : socket.username,
          lastMessageAt: new Date()
        };
        
        await ChatStatus.findOneAndUpdate(
          { userId: targetUserId },
          updateData,
          { upsert: true }
        );
        
        // Solo los mensajes del usuario reabren el chat si estaba cerrado (no si está en pagos)
        if (!isAdminRole) {
          await ChatStatus.findOneAndUpdate(
            { userId: targetUserId, status: 'closed' },
            { status: 'open', closedAt: null, closedBy: null }
          );
        }
      }
      
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
    
    if (socket.role === 'admin') {
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

// Renderiza index.html reemplazando los placeholders del server (pixel id,
// base url pública, y opcionalmente un campaignCode capturado por vanity URL).
function renderIndexHtml(extras = {}) {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  const content = readFileSafe(indexPath);
  if (!content) return null;
  const pixelId = (process.env.META_PIXEL_ID || '').trim();
  return content
    .replace(/__META_PIXEL_ID_PLACEHOLDER__/g, pixelId)
    .replace(/__VIP_PUBLIC_BASE_URL_PLACEHOLDER__/g, PUBLIC_BASE_URL)
    .replace(/__VIP_CAMPAIGN_CODE_PLACEHOLDER__/g, extras.campaignCode || '');
}

app.get('/', (req, res) => {
  const rendered = renderIndexHtml();
  if (!rendered) return res.status(500).send('Error loading page');
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
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
      response: '🔒💰 Depósito de ${amount} acreditado con éxito. ✅ \n💸 Tu nuevo saldo es ${balance} 💸\n\nPuedes verificarlo en: https://jugaygana.bet\n\n🔥 Mañana podes revisar si tenes reembolso para reclamar de forma automatica 🔥'
    },
    {
      name: '/sys_deposit_bonus',
      description: 'Mensaje automático al realizar un depósito con bonus. Variables disponibles: ${amount}, ${bonus}, ${balance}',
      type: 'message',
      response: '🔒💰 Depósito de ${amount} (incluye ${bonus} de bonificación) acreditado con éxito. ✅ \n💸 Tu nuevo saldo es ${balance} 💸\n\nPuedes verificarlo en: https://jugaygana.bet\n\n🔥 Mañana podes revisar si tenes reembolso para reclamar de forma automatica 🔥'
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

app.post('/api/movements/deposit', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;
    const username = req.user.username;
    
    if (!amount || amount < 100) {
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
        metaCapi.track(
          'Purchase',
          { email: u && u.email, phone: u && u.phone, externalId: req.user.userId },
          {
            value: parseFloat(amount),
            currency: 'ARS',
            content_name: 'deposit_self_service',
            content_type: 'product'
          },
          { eventId: req.body && req.body.metaEventId, req }
        );
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
  try {
    const { amount } = req.body;
    const username = req.user.username;

    if (!amount || amount < 100) {
      return res.status(400).json({ error: 'Monto mínimo $100' });
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

    const result = await jugaygana.withdrawFromUser(
      username,
      amount,
      `Retiro desde Sala de Juegos - ${new Date().toLocaleString('es-AR')}`
    );

    if (result.success) {
      await recordUserActivity(req.user.userId, 'withdrawal', amount);

      // Meta CAPI — WithdrawRequest (custom). Señal de usuario activo / ganador.
      try {
        const u = await User.findOne({ id: req.user.userId }).lean();
        metaCapi.track(
          'WithdrawRequest',
          { email: u && u.email, phone: u && u.phone, externalId: req.user.userId },
          { value: parseFloat(amount), currency: 'ARS', content_name: 'withdraw_self_service' },
          { eventId: req.body && req.body.metaEventId, req }
        );
      } catch (e) { /* tracking nunca bloquea */ }

      res.json({
        success: true,
        message: `Retiro de $${amount} realizado correctamente`,
        newBalance: result.data?.user_balance_after,
        transactionId: result.data?.transfer_id || result.data?.transferId
      });
    } else {
      res.status(400).json({ error: result.error || 'Error al realizar retiro' });
    }
  } catch (error) {
    console.error('Error en retiro:', error);
    res.status(500).json({ error: 'Error del servidor' });
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
  try {
    const { titular, cbu, alias, amount, saveData } = req.body || {};
    const username = req.user.username;

    const amountNum = Number(amount);
    if (!amountNum || amountNum < 100) {
      return res.status(400).json({ error: 'El monto mínimo de retiro es $100' });
    }

    const titularT = (typeof titular === 'string' ? titular : '').trim();
    const cbuT = (typeof cbu === 'string' ? cbu : '').trim();
    const aliasT = (typeof alias === 'string' ? alias : '').trim();
    if (!titularT || !cbuT || !aliasT) {
      return res.status(400).json({ error: 'Completá titular, CVU/CBU y alias' });
    }

    const user = await User.findOne({ id: req.user.userId });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    // El retiro ya no exige verificación por SMS: la verificación se va a
    // pedir en el registro de inicio.

    // Chequear saldo real en JugaYGana ANTES de intentar el retiro.
    const balanceResult = await jugayganaMovements.getUserBalance(username);
    if (!balanceResult.success) {
      return res.status(400).json({ error: 'No se pudo verificar tu saldo. Intentá de nuevo en unos minutos.' });
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

    // Ejecutar el retiro real en JugaYGana.
    const result = await jugaygana.withdrawFromUser(
      username,
      amountNum,
      `Retiro Sala de Juegos - ${new Date().toLocaleString('es-AR')}`
    );

    if (!result.success) {
      return res.status(400).json({ error: result.error || 'No se pudo procesar el retiro' });
    }

    await recordUserActivity(req.user.userId, 'withdrawal', amountNum);

    // Guardar datos bancarios para la próxima vez (si el usuario lo pidió).
    if (saveData) {
      user.withdrawalAccount = { titular: titularT, cbu: cbuT, alias: aliasT, savedAt: new Date() };
      await user.save();
    }

    const amountFmt = '$' + amountNum.toLocaleString('es-AR');

    // 1. Mensaje del usuario hacia el agente con los datos del retiro.
    await Message.create({
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

    // 2. Confirmación automática del sistema hacia el usuario.
    await Message.create({
      id: uuidv4(),
      senderId: 'system',
      senderUsername: 'Sistema',
      senderRole: 'admin',
      receiverId: req.user.userId,
      receiverRole: 'user',
      content:
        `⏳ Recibimos tu solicitud de retiro de ${amountFmt}.\n` +
        `Un agente la está procesando y te confirma la transferencia en breve. ¡Gracias!`,
      type: 'text',
      timestamp: new Date(),
      read: false
    });

    // Meta CAPI — WithdrawRequest (señal de usuario activo / ganador).
    try {
      metaCapi.track(
        'WithdrawRequest',
        { email: user.email, phone: user.phone, externalId: req.user.userId },
        { value: amountNum, currency: 'ARS', content_name: 'withdraw_self_service' },
        { eventId: req.body && req.body.metaEventId, req }
      );
    } catch (e) { /* tracking nunca bloquea la respuesta */ }

    res.json({
      success: true,
      message: `Retiro de ${amountFmt} solicitado correctamente`,
      newBalance: result.data?.user_balance_after,
      transactionId: result.data?.transfer_id || result.data?.transferId
    });
  } catch (error) {
    logger.error(`Error en withdrawal/request: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// BONO POR INSTALAR LA APP (one-time)
// ============================================
const INSTALL_BONUS_AMOUNT = 5000;

// Estado del bono: si ya lo reclamó (para mostrar/ocultar el cartel del chat).
app.get('/api/install-bonus/status', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ id: req.user.userId }).lean();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({
      claimed: user.installBonusClaimed === true,
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
    const standalone = req.body && req.body.standalone === true;
    if (!standalone) {
      return res.status(400).json({
        error: 'El bono se reclama desde la app instalada.',
        code: 'NOT_STANDALONE'
      });
    }

    const user = await User.findOne({ id: req.user.userId });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (user.installBonusClaimed === true) {
      return res.status(400).json({
        error: 'Ya reclamaste el bono por instalar la app.',
        code: 'ALREADY_CLAIMED'
      });
    }

    // Acreditar el bono en JUGAYGANA.
    const creditResult = await jugaygana.creditUserBalance(user.username, INSTALL_BONUS_AMOUNT);
    if (!creditResult || !creditResult.success) {
      logger.error(`install-bonus: fallo al acreditar a ${user.username}: ${creditResult && creditResult.error}`);
      return res.status(400).json({ error: 'No se pudo acreditar el bono. Intentá de nuevo en unos minutos.' });
    }

    user.installBonusClaimed = true;
    user.installBonusClaimedAt = new Date();
    await user.save();

    const amountFmt = '$' + INSTALL_BONUS_AMOUNT.toLocaleString('es-AR');

    // Mensaje de confirmación en el chat.
    await Message.create({
      id: uuidv4(),
      senderId: 'system',
      senderUsername: 'Sistema',
      senderRole: 'admin',
      receiverId: user.id,
      receiverRole: 'user',
      content: `🎁 ¡Felicitaciones ${user.username}! Te acreditamos tu BONO DE ${amountFmt} por instalar la app. ¡Gracias por sumarte! 🥳`,
      type: 'system',
      timestamp: new Date(),
      read: false
    });

    const balanceResult = await jugayganaMovements.getUserBalance(user.username);
    const newBalance = balanceResult.success ? balanceResult.balance : null;

    res.json({
      success: true,
      message: `Bono de ${amountFmt} acreditado`,
      amount: INSTALL_BONUS_AMOUNT,
      newBalance
    });
  } catch (error) {
    logger.error(`Error en install-bonus/claim: ${error.message}`);
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
// Hitos/milestones del Fueguito
// requireDeposits > 0 marca que la RECOMPENSA (no el reclamo diario) requiere actividad del mes
const FIRE_MILESTONES = [
  { day: 10, reward: 10000,  type: 'cash',           requireDeposits: 20000,  depositDays: 30, desc: 'Recompensa Fueguito 10 días' },
  { day: 15, reward: 0,      type: 'next_load_bonus', requireDeposits: 20000,  depositDays: 30, desc: '100% en próxima carga' },
  { day: 20, reward: 50000,  type: 'cash',           requireDeposits: 100000, depositDays: 30, desc: 'Recompensa Fueguito 20 días' },
  { day: 30, reward: 200000, type: 'cash',           requireDeposits: 300000, depositDays: 45, desc: 'Recompensa Fueguito 30 días' }
];

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

    // Construir lista de milestones con estado para la UI
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
      nextReward: currentStreak >= 9 ? 10000 : 0
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

    // Determinar si se alcanza un hito
    const milestone = FIRE_MILESTONES.find(m => m.day === fireStreak.streak);
    if (milestone) {
      if (milestone.type === 'next_load_bonus') {
        // Día 15: 100% en próxima carga (se marca como pendiente para operador)
        rewardType = 'next_load_bonus';
        fireStreak.pendingNextLoadBonus = true;
        message = '🎉 ¡15 días de racha! Tenés 100% en tu próxima carga. Un operador te lo aplicará cuando quieras reclamar.';
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

    // Req 6: Verificar requisitos de actividad para este hito específico
    const rewardDay = fireStreak.pendingCashRewardDay || 0;
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

    const rewardAmount = fireStreak.pendingCashReward;
    const rewardDesc = fireStreak.pendingCashRewardDesc || `Recompensa Fueguito día ${fireStreak.pendingCashRewardDay}`;

    const serializeErrorPart = (value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) {
        return JSON.stringify({ name: value.name, message: value.message, stack: value.stack });
      }
      try { return JSON.stringify(value); } catch { return String(value); }
    };

    const bonusResult = await jugayganaMovements.makeBonus(username, rewardAmount, rewardDesc + ' - Sala de Juegos');
    
    if (!bonusResult.success) {
      const creditError = typeof bonusResult.error === 'string'
        ? bonusResult.error
        : (bonusResult.error?.message || bonusResult.error?.error || bonusResult.error?.details || JSON.stringify(bonusResult.error) || 'Error al acreditar recompensa');
      logger.error(
        `[FIRE_REWARD] claim-reward failed userId=${userId} username=${username} ` +
        `bonusResult=${serializeErrorPart(bonusResult)} bonusError=${serializeErrorPart(bonusResult?.error)}`
      );
      return res.status(400).json({ error: 'Error al acreditar recompensa: ' + creditError });
    }

    // Limpiar pending reward y sumar al total
    fireStreak.totalClaimed = (fireStreak.totalClaimed || 0) + rewardAmount;
    fireStreak.pendingCashReward = 0;
    fireStreak.pendingCashRewardDay = 0;
    fireStreak.pendingCashRewardDesc = '';
    fireStreak.pendingCashRewardDate = '';
    await fireStreak.save();

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

  const [depositsByUser, withdrawalsAgg] = await Promise.all([
    Transaction.aggregate([
      { $match: { type: 'deposit', username: { $in: usernames } } },
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

// Listar todas las campañas con stats resumidas (clicks + registrations).
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
      registrations: regsByCode[c.code] || 0
    }));
    res.json({ campaigns: enriched });
  } catch (err) {
    logger.error(`[admin/campaigns GET] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Crear nueva campaña.
app.post('/api/admin/campaigns', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { code, publisher, name, commissionType, commissionValue, notes } = req.body || {};
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
      isActive: true
    });

    res.status(201).json({ campaign: created.toObject() });
  } catch (err) {
    logger.error(`[admin/campaigns POST] ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Editar campaña existente. `code` es inmutable, los demás campos sí se pueden modificar.
app.put('/api/admin/campaigns/:code', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const normalizedCode = String(req.params.code).toUpperCase().trim();
    const { publisher, name, commissionType, commissionValue, isActive, notes } = req.body || {};
    const update = {};
    if (typeof publisher === 'string') update.publisher = publisher.trim().slice(0, 100);
    if (typeof name === 'string') update.name = name.trim().slice(0, 200);
    if (['cpa', 'revshare', 'none'].includes(commissionType)) update.commissionType = commissionType;
    if (Number.isFinite(parseFloat(commissionValue))) update.commissionValue = parseFloat(commissionValue);
    if (typeof isActive === 'boolean') update.isActive = isActive;
    if (typeof notes === 'string') update.notes = notes.slice(0, 2000);

    const updated = await Campaign.findOneAndUpdate(
      { code: normalizedCode },
      { $set: update },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ error: 'Campaña no encontrada' });
    res.json({ campaign: updated });
  } catch (err) {
    logger.error(`[admin/campaigns PUT] ${err.message}`);
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

app.get('/api/admin/database', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Acceso denegado. Solo el administrador principal puede acceder.' });
    }
    
    const users = await User.find().select('-password').lean();
    const totalMessages = await Message.countDocuments();
    
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
    const totalAdmins = users.filter(u => adminRoles.includes(u.role)).length;
    
    res.json({
      users,
      totalUsers: users.length,
      totalAdmins,
      totalMessages
    });
  } catch (error) {
    console.error('Error obteniendo base de datos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ============================================
// TRANSACCIONES
// ============================================

app.get('/api/admin/transactions', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { from, to, type, username } = req.query;
    
    let query = {};
    
    // Manejo de fechas — las fechas recibidas (YYYY-MM-DD) se interpretan en
    // horario argentino (ART = UTC-3, sin DST).
    // 00:00 ART = 03:00 UTC del mismo día.
    // 23:59:59 ART = 02:59:59 UTC del día siguiente.
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (from || to) {
      query.timestamp = {};
      if (from) {
        if (!DATE_RE.test(from)) return res.status(400).json({ error: 'Formato de fecha inválido para "from" (esperado YYYY-MM-DD)' });
        // Inicio del día en Argentina: 00:00 ART = 03:00 UTC
        const fromDate = new Date(from + 'T03:00:00.000Z');
        query.timestamp.$gte = fromDate;
      }
      if (to) {
        if (!DATE_RE.test(to)) return res.status(400).json({ error: 'Formato de fecha inválido para "to" (esperado YYYY-MM-DD)' });
        // Fin del día en Argentina: 23:59:59.999 ART = inicio del día siguiente 03:00 UTC - 1ms
        const toDate = new Date(to + 'T03:00:00.000Z');
        toDate.setTime(toDate.getTime() + 24 * 60 * 60 * 1000 - 1);
        query.timestamp.$lte = toDate;
      }
    }
    
    if (type && type !== 'all') {
      query.type = type;
    }

    // Req 8: Filtrar por username si se especifica
    if (username && username.trim()) {
      // Limitar longitud y escapar caracteres especiales de regex para evitar ReDoS / injection
      const rawUsername = username.trim().substring(0, 100);
      const safeUsername = rawUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.username = { $regex: safeUsername, $options: 'i' };
    }
    
    // Obtener todas las transacciones sin límite para el cierre
    const transactions = await Transaction.find(query)
      .sort({ timestamp: -1 })
      .lean();
    
    // Calcular totales (req 7: incluir fire_reward en bonificaciones)
    let deposits = 0;
    let withdrawals = 0;
    let bonuses = 0;
    let refunds = 0;
    let fireRewards = 0;
    
    transactions.forEach(t => {
      const amount = t.amount || 0;
      switch(t.type) {
        case 'deposit':
          deposits += amount;
          break;
        case 'withdrawal':
          withdrawals += amount;
          break;
        case 'bonus':
          bonuses += amount;
          break;
        case 'refund':
          refunds += amount;
          break;
        case 'fire_reward':
          fireRewards += amount;
          break;
      }
    });
    
    // Saldo neto = depósitos - retiros (bonos y reembolsos no afectan)
    const netBalance = deposits - withdrawals;
    
    // Resumen completo
    const summary = {
      deposits,
      withdrawals,
      bonuses,
      refunds,
      fireRewards,
      netBalance,
      totalTransactions: transactions.length
    };
    
    res.json({
      transactions,
      summary,
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
        // 1. Depósitos del período
        { $match: { type: 'deposit', timestamp: { $gte: startUTC, $lte: endUTC } } },

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
app.post('/api/admin/change-own-password', authMiddleware, adminMiddleware, async (req, res) => {
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

// Cerrar chat - SOLO INTERNO (no notifica al cliente)
app.post('/api/admin/close-chat', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId, notifyClient = false, isPaymentsTab = false } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'Usuario no especificado' });
    }
    
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

// Obtener conversaciones para el nuevo panel
// OPTIMIZADO: Una sola query con agregación
app.get('/api/admin/conversations', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    let { status = 'open' } = req.query;
    
    const userRole = req.user.role;
    
    if (userRole === 'depositor' && status === 'payments') {
      return res.status(403).json({ error: 'Acceso denegado. Los depositores no pueden ver chats de pagos.' });
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
          status: 1
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
    const adminRoles = ['admin', 'depositor', 'withdrawer'];
    if (!adminRoles.includes(req.user.role) && req.user.userId !== userId) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    
    const user = await User.findOne({ id: userId }).select('-password').lean();
    
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    
    res.json({ user });
  } catch (error) {
    console.error('Error obteniendo usuario:', error);
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
    
    const users = await User.find(query).select('-password').sort({ role: 1, username: 1 }).lean();
    res.json({ users });
  } catch (error) {
    console.error('Error obteniendo usuarios:', error);
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
    const validRoles = ['user', 'admin', 'depositor', 'withdrawer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }
    
    // Restricciones de rol para crear usuarios
    if (adminRole !== 'admin' && role !== 'user') {
      return res.status(403).json({ error: 'Solo el administrador general puede crear otros administradores' });
    }
    
    // Verificar si el usuario ya existe
    const existingUser = await User.findOne({ username: { $regex: new RegExp('^' + escapeRegex(username) + '$', 'i') } });
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
    
    // Si es usuario normal, crear chat status
    if (role === 'user') {
      await ChatStatus.create({
        userId: userId,
        username: username,
        status: 'open',
        category: 'cargas'
      });
    }
    
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

const DB_PASSWORD = process.env.DB_PASSWORD;
if (!DB_PASSWORD) {
  if (process.env.NODE_ENV === 'production') {
    console.error('⛔ FATAL: DB_PASSWORD no configurado en producción.');
    process.exit(1);
  }
  logger.error('⛔ SEGURIDAD: DB_PASSWORD no configurado. Las rutas de base de datos no funcionarán sin esta variable.');
}

// Middleware para verificar contraseña de base de datos
function dbPasswordMiddleware(req, res, next) {
  if (!DB_PASSWORD) {
    return res.status(503).json({ error: 'Servicio de base de datos temporalmente no disponible.' });
  }
  // Accept dbPassword from body only — never from query string to avoid it
  // appearing in server logs, referrer headers and browser history.
  const { dbPassword } = req.body || {};
  
  if (!safeCompare(dbPassword, DB_PASSWORD)) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  
  next();
}

// Verificar acceso a base de datos
app.post('/api/admin/database/verify', authMiddleware, adminMiddleware, dbPasswordMiddleware, (req, res) => {
  res.json({ success: true, message: 'Acceso concedido' });
});

// Obtener todos los usuarios y admins para base de datos
// CORREGIDO: Usar la misma lógica que /api/admin/users para consistencia
app.post('/api/admin/database/users', authMiddleware, adminMiddleware, dbPasswordMiddleware, async (req, res) => {
  try {
    const userRole = req.user.role;
    
    // Construir query según rol (igual que en /api/admin/users)
    let query = {};
    if (userRole !== 'admin') {
      // Depositor y withdrawer solo ven usuarios (no admins)
      query.role = 'user';
    }
    // Admin general ve TODOS (usuarios y admins)
    
    const users = await User.find(query).select('-password').sort({ role: 1, username: 1 }).lean();
    res.json({ users, total: users.length });
  } catch (error) {
    console.error('Error obteniendo usuarios de base de datos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Exportar base de datos a CSV
app.post('/api/admin/database/export/csv', authMiddleware, adminMiddleware, dbPasswordMiddleware, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 }).lean();
    
    // Crear CSV con todos los campos
    let csv = 'ID,Usuario,Email,Teléfono,Rol,Balance,AccountNumber,Estado,Último Login,Creado,JugayganaUserId,JugayganaUsername,JugayganaSyncStatus\n';
    
    users.forEach(user => {
      csv += `${escapeCsvField(user.id)},${escapeCsvField(user.username)},${escapeCsvField(user.email || '')},${escapeCsvField(user.phone || '')},${escapeCsvField(user.role)},${escapeCsvField(user.balance || 0)},${escapeCsvField(user.accountNumber || '')},${escapeCsvField(user.isActive ? 'Activo' : 'Inactivo')},${escapeCsvField(user.lastLogin || 'Nunca')},${escapeCsvField(user.createdAt || '')},${escapeCsvField(user.jugayganaUserId || '')},${escapeCsvField(user.jugayganaUsername || '')},${escapeCsvField(user.jugayganaSyncStatus || '')}\n`;
    });
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=base_de_datos_completa.csv');
    res.send('\uFEFF' + csv); // BOM para Excel
  } catch (error) {
    console.error('Error exportando base de datos:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

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

function _rouletteUserFcmTokens(u) {
  if (!u) return [];
  const tokens = [];
  if (u.fcmToken) tokens.push(u.fcmToken);
  if (Array.isArray(u.fcmTokens)) {
    for (const tk of u.fcmTokens) {
      const t = tk && tk.token ? tk.token : tk;
      if (t && !tokens.includes(t)) tokens.push(t);
    }
  }
  return tokens;
}

// GET /api/roulette/status — estado del giro de HOY del user actual.
app.get('/api/roulette/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    const dateKey = _rouletteDateKeyART();
    // FCM token gate: solo users con PWA instalada + notifs activadas.
    const u = await User.findOne({ id: userId }, { fcmToken: 1, fcmTokens: 1 }).lean();
    const tokens = _rouletteUserFcmTokens(u);
    const eligible = tokens.length > 0;
    const spin = await DailyRouletteSpin.findOne({ userId, dateKey }).lean();
    res.json({
      success: true,
      eligible,
      needsAppNotifs: !eligible,
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
    const u = await User.findOne({ username: { $regex: '^' + username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', $options: 'i' } }, { _id: 1, username: 1 }).lean();
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

    // Gate: solo PWA + notifs activadas.
    const u = await User.findOne({ id: userId }, { fcmToken: 1, fcmTokens: 1 }).lean();
    const tokens = _rouletteUserFcmTokens(u);
    if (tokens.length === 0) {
      return res.status(403).json({
        error: 'Solo podés girar si tenés la app instalada con notificaciones aceptadas.',
        needsAppNotifs: true
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

async function _runInactividadTick() {
  try {
    const cfg = mergeInactividadConfig(await getConfig('inactividadConfig'));
    const r = await inactividadService.tick({
      cfg: cfg,
      models: { User: User, InactividadFire: InactividadFire, PromoBonus: PromoBonus },
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
  const b = await PromoBonus.findOne({ username: u, status: 'active', expiresAt: { $gt: now } })
    .sort({ activatedAt: -1 })
    .lean();
  return b || null;
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

async function _runBonusStrategy() {
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
    res.json({
      success: true,
      config: cfg.toObject(),
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
      if (src.percent != null) dst.percent = Math.max(1, Math.min(1000, Number(src.percent) || 0));
      if (src.durationMinutes != null) dst.durationMinutes = Math.max(5, Number(src.durationMinutes) || 120);
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
  bonoPercents: [50, 100],
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
    percents = s.bonoPercents.map(function (p) { return _encNum(p, 50, 1, 500); });
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
    res.json({ success: true, total: total, stats: stats });
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
const INACTIVIDAD_DEFAULTS = {
  isActive: false,
  bonoVigenciaHoras: 72,
  pasos: [
    { dias: 7,  tipo: 'bono',   percent: 50,  montoARS: 0 },
    { dias: 14, tipo: 'bono',   percent: 100, montoARS: 0 },
    { dias: 30, tipo: 'regalo', percent: 0,   montoARS: 5000 }
  ]
};

function mergeInactividadConfig(saved) {
  const s = saved || {};
  let pasos = (Array.isArray(s.pasos) && s.pasos.length) ? s.pasos : INACTIVIDAD_DEFAULTS.pasos;
  pasos = pasos.map(function (p) {
    p = p || {};
    return {
      dias: _encNum(p.dias, 7, 1, 365),
      tipo: (p.tipo === 'regalo') ? 'regalo' : 'bono',
      percent: _encNum(p.percent, 50, 0, 500),
      montoARS: _encNum(p.montoARS, 0, 0, 10000000)
    };
  }).sort(function (a, b) { return a.dias - b.dias; });
  return {
    isActive: s.isActive === true,
    bonoVigenciaHoras: _encNum(s.bonoVigenciaHoras, 72, 1, 720),
    pasos: pasos
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
    for (const p of cfg.pasos) {
      const desde = new Date(now - p.dias * 86400000);
      const count = await User.countDocuments({
        lastLogin: { $lte: desde, $ne: null },
        notificationPlan: { $ne: 'solo_reembolsos' }
      });
      tramos.push({ dias: p.dias, tipo: p.tipo, percent: p.percent, montoARS: p.montoARS, inactivos: count });
    }
    const ultimos = await InactividadFire.find({}).sort({ firedAt: -1 }).limit(20).lean();
    res.json({ success: true, tramos: tramos, ultimos: ultimos });
  } catch (err) {
    logger.error(`GET /api/admin/inactividad/stats: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});


// ============================================
// SPA FALLBACK: sirve index.html para rutas
// frontend desconocidas (ej: /register?ref=CODE)
// Esto permite que los links de referido funcionen
// aunque la ruta no esté definida explícitamente.
// ============================================

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint no encontrado' });
  }
  // Don't serve SPA HTML for static asset paths – they should 404 cleanly so that
  // browsers don't receive HTML with Content-Type: text/html when they expect CSS/JS
  // (which triggers X-Content-Type-Options: nosniff blocking).
  if (STATIC_ASSET_EXT_RE.test(req.path)) {
    return res.status(404).send('Not found');
  }
  const indexPath = path.join(__dirname, 'public', 'index.html');
  const content = readFileSafe(indexPath);
  if (content) {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(content);
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

    await initializeData();
    await setupRedisAdapter();
    server.listen(PORT, () => {
      logger.info(`Server started on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
    });
  })();
}