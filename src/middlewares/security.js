
/**
 * Middlewares de seguridad
 * Rate limiting, headers de seguridad, validación de inputs
 */
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const hpp = require('hpp');
const cors = require('cors');
const helmet = require('helmet');
const logger = require('../utils/logger');

/**
 * Rate limiting general para todas las rutas
 * 100 requests por IP cada 15 minutos
 */
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,
  message: {
    status: 'fail',
    errorCode: 'RATE_LIMIT',
    message: 'Demasiadas solicitudes desde esta IP. Por favor, intenta más tarde.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn(`Rate limit excedido para IP: ${req.ip}`, {
      ip: req.ip,
      url: req.originalUrl,
      method: req.method
    });
    res.status(options.statusCode).json(options.message);
  }
});

/**
 * Rate limiting estricto para autenticación
 * 5 intentos por IP cada 15 minutos
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5,
  skipSuccessfulRequests: true, // No contar requests exitosos
  message: {
    status: 'fail',
    errorCode: 'AUTH_RATE_LIMIT',
    message: 'Demasiados intentos de autenticación. Por favor, espera 15 minutos.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn(`Auth rate limit excedido para IP: ${req.ip}`, {
      ip: req.ip,
      username: req.body?.username
    });
    res.status(options.statusCode).json(options.message);
  }
});

/**
 * Rate limiting para API de chat
 * Más permisivo para chat en tiempo real
 */
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 60, // 60 mensajes por minuto
  message: {
    status: 'fail',
    errorCode: 'CHAT_RATE_LIMIT',
    message: 'Estás enviando mensajes muy rápido. Por favor, espera un momento.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Configuración de CORS
 */
const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
      : (process.env.NODE_ENV === 'production' ? [] : ['http://localhost:3000', 'http://localhost:5173']);

    // Requests sin cabecera Origin (same-origin, curl, mobile) siempre se permiten.
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    logger.warn(`CORS bloqueado para origen: ${origin}`);
    return callback(new Error('No autorizado por CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin'
  ],
  exposedHeaders: ['X-Total-Count', 'X-RateLimit-Remaining']
};

/**
 * Configuración de Helmet para headers de seguridad
 */
const helmetConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.gstatic.com', 'https://www.google.com', 'https://apis.google.com'],
      scriptSrcElem: ["'self'", "'unsafe-inline'", 'https://www.gstatic.com', 'https://www.google.com', 'https://apis.google.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'", 'https://*.googleapis.com', 'https://*.firebaseio.com', 'https://*.google.com', 'https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com', 'https://fcm.googleapis.com', 'https://firebaseinstallations.googleapis.com'],
      mediaSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'self'", 'https://*.firebaseapp.com', 'https://*.google.com'],
      workerSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'"],
      upgradeInsecureRequests: []
    }
  },
  crossOriginEmbedderPolicy: false, // Deshabilitado para compatibilidad
  hsts: {
    maxAge: 31536000, // 1 año
    includeSubDomains: true,
    preload: true
  }
});

/**
 * Sanitización de inputs
 */
const sanitizeInput = (req, res, next) => {
  // Sanitizar body
  if (req.body) {
    Object.keys(req.body).forEach(key => {
      if (typeof req.body[key] === 'string') {
        // Remover caracteres peligrosos
        req.body[key] = req.body[key]
          .replace(/[<>]/g, '')
          .trim()
          .substring(0, 5000); // Límite de 5000 caracteres
      }
    });
  }
  
  // Sanitizar query params
  if (req.query) {
    Object.keys(req.query).forEach(key => {
      if (typeof req.query[key] === 'string') {
        req.query[key] = req.query[key]
          .replace(/[<>]/g, '')
          .trim()
          .substring(0, 1000);
      }
    });
  }
  
  next();
};

/**
 * Validación de username
 */
const validateUsername = (username) => {
  if (!username || typeof username !== 'string') return false;
  const sanitized = username.trim();
  return /^[a-zA-Z0-9_.-]{3,30}$/.test(sanitized);
};

/**
 * Validación de password
 */
const validatePassword = (password) => {
  if (!password || typeof password !== 'string') return false;
  return password.length >= 6 && password.length <= 100;
};

/**
 * Códigos de país válidos para LATAM
 */
const VALID_COUNTRY_CODES = [
  '+54', '+591', '+55', '+56', '+57', '+506', '+53', '+593',
  '+503', '+502', '+504', '+52', '+505', '+507', '+595', '+51', '+1', '+598', '+58'
];

/**
 * Normaliza un número de teléfono con código de país.
 * Quita espacios, guiones, paréntesis. Retorna número normalizado o null si es inválido.
 * @param {string} countryCode - Ej: '+54'
 * @param {string} number - Ej: '9 11 1234-5678'
 * @returns {string|null} - Ej: '+5491112345678' o null
 */
const normalizePhone = (countryCode, number) => {
  if (!countryCode || !number) return null;
  const cleanNumber = String(number).replace(/[\s\-().]/g, '');
  const fullPhone = String(countryCode).trim() + cleanNumber;
  // Debe empezar con + y tener entre 10 y 15 dígitos totales
  if (!/^\+\d{8,14}$/.test(fullPhone)) return null;
  return fullPhone;
};

/**
 * Valida que un teléfono ya normalizado tenga formato internacional válido para LATAM.
 * @param {string} phone - Ej: '+5491155551234'
 * @returns {boolean}
 */
const validateInternationalPhone = (phone) => {
  if (!phone || typeof phone !== 'string') return false;
  if (!/^\+\d{8,14}$/.test(phone)) return false;
  // Verificar que empiece con un código de país LATAM conocido
  return VALID_COUNTRY_CODES.some(code => phone.startsWith(code));
};

/**
 * Clave NORMALIZADA de un teléfono para chequear unicidad de forma robusta. Saca el
 * código de país, el "0" inicial (trunk PY/AR) y el "9" de móvil AR, así el MISMO
 * número en distinto formato (+54.., +549.., 011.., +595.., +5950.. con 0 de Paraguay)
 * cae en la MISMA clave. Devuelve null si no hay dígitos suficientes.
 * @param {string} phone
 * @returns {string|null}
 */
const normalizePhoneKey = (phone) => {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d || d.length < 8) return null;
  // 1) Quitar el código de país LATAM (3 dígitos primero para no romper 595 vs 5).
  const COUNTRY_CODES = ['595', '591', '598', '593', '502', '503', '504', '505', '506', '507', '509', '51', '52', '54', '55', '56', '57', '58'];
  for (const cc of COUNTRY_CODES) {
    if (d.startsWith(cc) && (d.length - cc.length) >= 8) { d = d.slice(cc.length); break; }
  }
  // 2) Quitar "0" inicial (trunk local de PY/AR).
  d = d.replace(/^0+/, '');
  // 3) Quitar el "9" de móvil de Argentina (queda 9 + 10 díg = 11).
  if (d.length === 11 && d.startsWith('9')) d = d.slice(1);
  // 4) Núcleo: últimos 10 dígitos (o menos).
  return d.slice(-10);
};

/**
 * Middleware de validación de campos de registro
 */
const validateRegister = (req, res, next) => {
  const { username, password, phone } = req.body;
  const errors = [];

  if (!username) {
    errors.push('El usuario es requerido');
  } else if (!validateUsername(username)) {
    errors.push('El usuario debe tener entre 3 y 30 caracteres alfanuméricos');
  }

  if (!password) {
    errors.push('La contraseña es requerida');
  } else if (!validatePassword(password)) {
    errors.push('La contraseña debe tener al menos 6 caracteres');
  }

  if (!phone) {
    errors.push('El número de teléfono es requerido');
  } else if (phone.trim().length < 8) {
    errors.push('El número de teléfono debe tener al menos 8 dígitos');
  }

  if (errors.length > 0) {
    return res.status(400).json({
      status: 'fail',
      errorCode: 'VALIDATION_ERROR',
      message: 'Error de validación',
      errors
    });
  }

  next();
};

/**
 * Middleware de validación de login
 */
const validateLogin = (req, res, next) => {
  const { username, phone, password } = req.body;
  const errors = [];

  if (!username && !phone) {
    errors.push('El usuario o teléfono es requerido');
  }

  if (!password) {
    errors.push('La contraseña es requerida');
  }

  if (errors.length > 0) {
    return res.status(400).json({
      status: 'fail',
      errorCode: 'VALIDATION_ERROR',
      message: 'Error de validación',
      errors
    });
  }

  next();
};

module.exports = {
  generalLimiter,
  authLimiter,
  chatLimiter,
  corsMiddleware: cors(corsOptions),
  helmet: helmetConfig,
  mongoSanitize: mongoSanitize(),
  xss: xss(),
  hpp: hpp(),
  sanitizeInput,
  validateRegister,
  validateLogin,
  validateUsername,
  validatePassword,
  normalizePhone,
  validateInternationalPhone,
  normalizePhoneKey,
  VALID_COUNTRY_CODES
};