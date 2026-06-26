
/**
 * Middleware de autenticación JWT mejorado
 * Soporta access tokens y refresh tokens
 */
const jwt = require('jsonwebtoken');
const { AppError, ErrorCodes, ErrorMessages } = require('../utils/AppError');
const logger = require('../utils/logger');
const { User } = require('../models');

// Lazy getters for SSM-loaded secrets — must be read at runtime because
// in AWS Elastic Beanstalk, secrets are loaded by loadSecretsFromSSM() AFTER
// all modules are required by server.js. Reading at module load captures
// `undefined` and breaks jwt.sign / jwt.verify.
function _getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    logger.error('[AUTH] JWT_SECRET not available in process.env at runtime');
  }
  return secret;
}
function _getJwtRefreshSecret() {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) {
    logger.error('[AUTH] JWT_REFRESH_SECRET not available in process.env at runtime');
  }
  return secret;
}

// Tiempos de expiración
const ACCESS_TOKEN_EXPIRY = process.env.ACCESS_TOKEN_EXPIRY || '15m';
const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || '7d';

// Lista negra de tokens revocados (en producción usar Redis)
const tokenBlacklist = new Set();

/**
 * Generar access token
 */
const generateAccessToken = (payload) => {
  return jwt.sign(payload, _getJwtSecret(), { expiresIn: ACCESS_TOKEN_EXPIRY });
};

/**
 * Generar refresh token
 */
const generateRefreshToken = (payload) => {
  return jwt.sign(payload, _getJwtRefreshSecret(), { expiresIn: REFRESH_TOKEN_EXPIRY });
};

/**
 * Generar par de tokens (access + refresh)
 */
const generateTokenPair = (user) => {
  const accessPayload = {
    userId: user.id || user._id?.toString(),
    username: user.username,
    role: user.role,
    type: 'access'
  };

  const refreshPayload = {
    userId: user.id || user._id?.toString(),
    username: user.username,
    type: 'refresh'
  };

  return {
    accessToken: generateAccessToken(accessPayload),
    refreshToken: generateRefreshToken(refreshPayload),
    expiresIn: 900 // 15 minutos en segundos
  };
};

/**
 * Verificar access token
 */
const verifyAccessToken = (token) => {
  try {
    if (tokenBlacklist.has(token)) {
      throw new Error('Token revocado');
    }
    return jwt.verify(token, _getJwtSecret(), { algorithms: ['HS256'] });
  } catch (error) {
    throw error;
  }
};

/**
 * Verificar refresh token
 */
const verifyRefreshToken = (token) => {
  try {
    return jwt.verify(token, _getJwtRefreshSecret(), { algorithms: ['HS256'] });
  } catch (error) {
    throw error;
  }
};

/**
 * Revocar token (logout)
 */
const revokeToken = (token) => {
  tokenBlacklist.add(token);
  logger.info('Token revocado', { tokenPreview: token.substring(0, 20) + '...' });
};

/**
 * Middleware de autenticación
 * Verifica el token JWT en el header Authorization
 */
const authenticate = async (req, res, next) => {
  try {
    // Obtener token del header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new AppError(
        'No se proporcionó token de autenticación',
        401,
        ErrorCodes.AUTH_UNAUTHORIZED
      ));
    }

    const token = authHeader.split(' ')[1];

    // Verificar token
    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return next(new AppError(
          ErrorMessages[ErrorCodes.AUTH_TOKEN_EXPIRED],
          401,
          ErrorCodes.AUTH_TOKEN_EXPIRED
        ));
      }
      return next(new AppError(
        ErrorMessages[ErrorCodes.AUTH_TOKEN_INVALID],
        401,
        ErrorCodes.AUTH_TOKEN_INVALID
      ));
    }

    // Verificar que sea un access token (backward compat: legacy tokens may not have 'type')
    if (decoded.type && decoded.type !== 'access') {
      return next(new AppError(
        'Tipo de token inválido',
        401,
        ErrorCodes.AUTH_TOKEN_INVALID
      ));
    }

    // Check tokenVersion for session revocation
    if (decoded.tokenVersion !== undefined) {
      try {
        const user = await User.findOne({ id: decoded.userId }).select('tokenVersion isActive').lean();
        if (user && user.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
          return next(new AppError(
            'Sesión invalidada. Iniciá sesión nuevamente.',
            401,
            ErrorCodes.AUTH_UNAUTHORIZED
          ));
        }
      } catch (dbErr) {
        logger.error('Error verificando tokenVersion:', dbErr.message);
        // Allow request if DB check fails (best-effort)
      }
    }

    // Adjuntar usuario al request
    req.user = decoded;
    req.token = token;

    next();
  } catch (error) {
    logger.error('Error en autenticación:', error);
    next(new AppError(
      ErrorMessages[ErrorCodes.AUTH_UNAUTHORIZED],
      401,
      ErrorCodes.AUTH_UNAUTHORIZED
    ));
  }
};

/**
 * Middleware de autorización por roles
 * @param {...string} roles - Roles permitidos
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError(
        'No autenticado',
        401,
        ErrorCodes.AUTH_UNAUTHORIZED
      ));
    }

    if (!roles.includes(req.user.role)) {
      logger.warn(`Acceso denegado para usuario ${req.user.username} con rol ${req.user.role}`, {
        userId: req.user.userId,
        requiredRoles: roles,
        actualRole: req.user.role
      });

      return next(new AppError(
        'No tienes permiso para realizar esta acción',
        403,
        ErrorCodes.AUTH_FORBIDDEN
      ));
    }

    next();
  };
};

/**
 * Middleware específico para agentes de depósito
 */
const depositorOnly = (req, res, next) => {
  if (!req.user) {
    return next(new AppError('No autenticado', 401, ErrorCodes.AUTH_UNAUTHORIZED));
  }

  const allowedRoles = ['admin', 'depositor'];
  if (!allowedRoles.includes(req.user.role)) {
    return next(new AppError(
      'Solo agentes de carga pueden realizar esta acción',
      403,
      ErrorCodes.AUTH_FORBIDDEN
    ));
  }

  next();
};

/**
 * Middleware específico para agentes de retiro
 */
const withdrawerOnly = (req, res, next) => {
  if (!req.user) {
    return next(new AppError('No autenticado', 401, ErrorCodes.AUTH_UNAUTHORIZED));
  }

  const allowedRoles = ['admin', 'withdrawer'];
  if (!allowedRoles.includes(req.user.role)) {
    return next(new AppError(
      'Solo agentes de retiro pueden realizar esta acción',
      403,
      ErrorCodes.AUTH_FORBIDDEN
    ));
  }

  next();
};

/**
 * Middleware para verificar si el usuario es admin o el propietario del recurso
 */
const ownerOrAdmin = (req, res, next) => {
  if (!req.user) {
    return next(new AppError('No autenticado', 401, ErrorCodes.AUTH_UNAUTHORIZED));
  }

  const resourceUserId = req.params.userId || req.body.userId;
  
  if (req.user.role === 'admin' || req.user.userId === resourceUserId) {
    return next();
  }

  return next(new AppError(
    'No tienes permiso para acceder a este recurso',
    403,
    ErrorCodes.AUTH_FORBIDDEN
  ));
};

/**
 * Endpoint para refrescar tokens
 */
const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;

    if (!token) {
      return next(new AppError(
        'Refresh token requerido',
        400,
        ErrorCodes.AUTH_TOKEN_INVALID
      ));
    }

    let decoded;
    try {
      decoded = verifyRefreshToken(token);
    } catch (error) {
      return next(new AppError(
        'Refresh token inválido o expirado',
        401,
        ErrorCodes.AUTH_TOKEN_INVALID
      ));
    }

    // Verificar que sea un refresh token
    if (decoded.type !== 'refresh') {
      return next(new AppError(
        'Tipo de token inválido',
        401,
        ErrorCodes.AUTH_TOKEN_INVALID
      ));
    }

    // Verificar que el usuario aún existe y está activo en la base de datos
    let user;
    try {
      user = await User.findOne({ id: decoded.userId }).select('id username role isActive').lean();
    } catch (dbErr) {
      logger.error('Error verificando usuario en refresh token:', dbErr.message);
      return next(new AppError('Error interno al verificar sesión', 500, ErrorCodes.AUTH_UNAUTHORIZED));
    }

    if (!user || !user.isActive) {
      return next(new AppError('Usuario no encontrado o desactivado', 401, ErrorCodes.AUTH_UNAUTHORIZED));
    }

    const tokens = generateTokenPair({
      id: user.id,
      username: user.username,
      role: user.role
    });

    res.json({
      status: 'success',
      data: tokens
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  authenticate,
  authorize,
  depositorOnly,
  withdrawerOnly,
  ownerOrAdmin,
  generateTokenPair,
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  revokeToken,
  refreshToken
};