// ============================================
// RUTAS DE NOTIFICACIONES PUSH
// ============================================

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const {
  sendNotificationToUser,
  sendNotificationToMultiple,
  sendNotificationToAllUsers,
  sendNotificationToUsernames,
  sendNotificationToTopic,
  subscribeToTopic,
  unsubscribeFromTopic
} = require('../services/notificationService');

// Importar modelo de usuario
const { User } = require('../../config/database');
const NotifTemplate = require('../models/NotifTemplate');
const ScheduledNotif = require('../models/ScheduledNotif');

// Rate limit para el registro de token FCM: evita que un cliente con un token
// válido inunde el endpoint. 20 req/min por IP es holgado para el flujo normal
// (registro al login + refresh periódico).
const registerTokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Esperá un momento.' }
});

// Lazy getter for JWT_SECRET — must be read at runtime (not module load) because
// in AWS Elastic Beanstalk, SSM Parameter Store secrets load AFTER all modules
// are required by server.js. Reading process.env.JWT_SECRET at module load
// captures `undefined` and breaks jwt.verify with "secretOrPublicKey must be provided".
function _getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error('[NOTIF-ADMIN] JWT_SECRET not available in process.env at runtime');
  }
  return secret;
}

// In-memory cache for FCM stats endpoints
const _fcmStatsCache = { data: null, updatedAt: 0 };
const _fcmUsersStatusCache = { data: null, updatedAt: 0 };
const FCM_CACHE_TTL = 60000; // 60 seconds

// ============================================
// SISTEMA DE CONFIRMACIÓN DE ENTREGA REAL
// ============================================
// FCM Admin SDK reporta "success" cuando acepta el mensaje, NO cuando llega
// al dispositivo. Si la push subscription murió (app desinstalada, datos
// borrados, navegador deshabilitó push) FCM puede aceptar igualmente y el
// admin ve un falso "enviado". Este sistema corrige eso:
//   1) Cada envío incluye un batchId + userId en data payload.
//   2) El SW del cliente recibe el push y POSTea /confirm-delivery.
//   3) El admin polling /batch-status/:batchId ve los confirmados reales.
// Los batches se guardan en memoria con TTL de 10 min.
const _pendingBatches = new Map();
const BATCH_TTL_MS = 10 * 60 * 1000;
setInterval(function () {
  const now = Date.now();
  for (const [id, batch] of _pendingBatches) {
    if (now - batch.sentAt > BATCH_TTL_MS) {
      _pendingBatches.delete(id);
    }
  }
}, 60 * 1000).unref?.();

function _newBatchId() {
  // UUID v4 simple sin dependencia adicional (uuid ya está en deps pero evito overhead).
  return 'b_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
}

function _registerBatch(batchId) {
  _pendingBatches.set(batchId, {
    sentAt: Date.now(),
    sentUsers: new Set(),
    confirmedUsers: new Set()
  });
}

function _markBatchSent(batchId, userId) {
  const b = _pendingBatches.get(batchId);
  if (b && userId) b.sentUsers.add(String(userId));
}

// Helper: parse the admin_api_session httpOnly cookie value (mirrors server.js).
function _getAdminApiSessionCookie(req) {
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

// ============================================
// MIDDLEWARE DE AUTENTICACIÓN (Admin)
// ============================================
async function requireAdmin(req, res, next) {
  // Accept token from Authorization header first; fall back to admin_api_session
  // httpOnly cookie — mirrors the behaviour of authMiddleware in server.js so
  // that both header-based and cookie-based admin requests work correctly.
  let token = req.headers.authorization?.split(' ')?.[1];
  if (!token) {
    token = _getAdminApiSessionCookie(req) || null;
  }

  console.log('[NOTIF-ADMIN] requireAdmin — token source:', req.headers.authorization ? 'Authorization header' : 'cookie');

  if (!token) {
    console.log('[NOTIF-ADMIN] requireAdmin — no token provided, returning 401');
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  const jwtSecret = _getJwtSecret();
  if (!jwtSecret) {
    console.error('[NOTIF-ADMIN] requireAdmin — JWT_SECRET undefined at runtime');
    return res.status(500).json({ error: 'Error de configuración del servidor' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
  } catch (error) {
    console.log('[NOTIF-ADMIN] requireAdmin — jwt.verify failed:', error.message);
    return res.status(401).json({ error: 'Token inválido' });
  }

  const adminRoles = ['admin', 'depositor', 'withdrawer'];
  if (!adminRoles.includes(decoded.role)) {
    console.log('[NOTIF-ADMIN] requireAdmin — role not allowed:', decoded.role);
    return res.status(403).json({ error: 'No tienes permisos de administrador' });
  }

  // Verify the user is still active in DB — mirrors authMiddleware fallback to _id.
  try {
    let user = await User.findOne({ id: decoded.userId });
    if (!user) {
      // Fallback: some legacy admin accounts may only have _id (no UUID id field).
      try {
        user = await User.findById(decoded.userId);
      } catch (e) {
        // Invalid ObjectId format — ignore and let the !user check below handle it.
      }
    }
    if (!user || !user.isActive) {
      console.log('[NOTIF-ADMIN] requireAdmin — user not found or inactive for userId:', decoded.userId);
      return res.status(401).json({ error: 'Usuario desactivado o no encontrado' });
    }
    console.log('[NOTIF-ADMIN] requireAdmin — authenticated:', decoded.username, '(role:', decoded.role + ')');
  } catch (dbError) {
    console.error('[NOTIF-ADMIN] requireAdmin — DB error:', dbError.message);
    return res.status(500).json({ error: 'Error verificando usuario' });
  }

  req.user = decoded;
  next();
}

// ============================================
// GUARDAR TOKEN FCM (Desde el frontend) - REQUIERE AUTENTICACIÓN
// ============================================
router.post('/register-token', registerTokenLimiter, async (req, res) => {
  try {
    const { fcmToken, fcmTokenContext, notifPermission } = req.body;
    const authHeader = req.headers.authorization;
    
    console.log('[FCM] Recibida petición de registro de token');
    
    if (!fcmToken) {
      console.log('[FCM] Error: FCM Token no proporcionado');
      return res.status(400).json({ error: 'FCM Token requerido' });
    }

    // Verificar token de autenticación
    if (!authHeader) {
      console.log('[FCM] Error: Auth header no proporcionado');
      return res.status(401).json({ error: 'Token de autenticación requerido' });
    }

    const token = authHeader.replace('Bearer ', '');
    const jwtSecret = _getJwtSecret();
    if (!jwtSecret) {
      console.error('[FCM] JWT_SECRET undefined at runtime');
      return res.status(500).json({ error: 'Error de configuración del servidor' });
    }
    const decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    
    console.log('[FCM] JWT decodificado:', { userId: decoded.userId, username: decoded.username });
    
    // Buscar usuario por UUID (campo 'id') o por ObjectId (_id)
    let user = await User.findOne({ id: decoded.userId });
    
    if (!user) {
      console.log('[FCM] Usuario no encontrado por UUID, intentando por _id...');
      user = await User.findById(decoded.userId);
    }
    
    if (!user) {
      console.log('[FCM] Error: Usuario no encontrado en la base de datos');
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Revalidar estado: un usuario desactivado o bloqueado no debe poder
    // seguir registrando tokens push aunque conserve un JWT vigente.
    if (!user.isActive || user.isBlocked === true) {
      return res.status(403).json({ error: 'Cuenta inactiva o bloqueada' });
    }

    console.log('[FCM] Usuario encontrado:', user.username);

    const normalizedCtx = fcmTokenContext || 'browser';
    const normalizedPerm = notifPermission || null;

    // Garantizar que el token se trate siempre como string para evitar inyección NoSQL
    const tokenStr = String(fcmToken);

    // Actualizar el array fcmTokens: upsert por token string.
    // Si el token ya existe, actualizamos contexto/fecha/permiso.
    // Si es nuevo, lo añadimos SIN borrar los tokens anteriores.
    // Esto permite que Chrome y la PWA coexistan con sus propios tokens.
    const tokenEntry = {
      token: tokenStr,
      context: normalizedCtx,
      updatedAt: new Date(),
      notifPermission: normalizedPerm || null
    };
    if (!user.fcmTokens) user.fcmTokens = [];
    const existingIdx = user.fcmTokens.findIndex(t => t.token === tokenStr);
    if (existingIdx >= 0) {
      user.fcmTokens[existingIdx] = tokenEntry;
    } else {
      user.fcmTokens.push(tokenEntry);
    }
    // Tope defensivo: conservar como mucho los 10 tokens más recientes para
    // que el array no pueda crecer sin límite.
    if (user.fcmTokens.length > 10) {
      user.fcmTokens.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      user.fcmTokens = user.fcmTokens.slice(0, 10);
    }
    user.markModified('fcmTokens');

    // También mantener los campos individuales con el último token registrado
    // para compatibilidad con el panel admin y lógica heredada.
    user.fcmToken = tokenStr;
    user.fcmTokenContext = normalizedCtx;
    user.fcmTokenUpdatedAt = new Date();
    if (normalizedPerm) {
      user.notifPermission = normalizedPerm;
    }
    await user.save();
    
    console.log('[FCM] ✅ Token registrado exitosamente para usuario:', user.username, '(contexto:', normalizedCtx, ', permiso:', normalizedPerm + ')');
    
    // Notificar a admins en tiempo real sobre el nuevo estado
    if (_io) {
      _io.to('admins').emit('user_app_status', {
        userId: user.id,
        username: user.username,
        appInstalled: true,
        fcmTokenContext: normalizedCtx,
        notifPermission: normalizedPerm || user.notifPermission || 'unknown'
      });
    }
    
    res.json({ 
      success: true, 
      message: 'Token registrado correctamente',
      userId: user.id,
      username: user.username
    });
  } catch (error) {
    console.error('[FCM] ❌ Error al registrar token:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// MIDDLEWARE — autentica a cualquier usuario por JWT (sin exigir rol admin)
// ============================================
async function requireUser(req, res, next) {
  const token = req.headers.authorization && req.headers.authorization.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token no proporcionado' });
  const jwtSecret = _getJwtSecret();
  if (!jwtSecret) return res.status(500).json({ error: 'Error de configuración del servidor' });
  let decoded;
  try {
    decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido' });
  }
  try {
    let user = await User.findOne({ id: decoded.userId });
    if (!user) { try { user = await User.findById(decoded.userId); } catch (_) { /* ObjectId inválido */ } }
    if (!user || !user.isActive || user.isBlocked === true) {
      return res.status(401).json({ error: 'Usuario no disponible' });
    }
    req.authUser = user;
    next();
  } catch (e) {
    return res.status(500).json({ error: 'Error verificando usuario' });
  }
}

// ============================================
// TEST DE ENTREGA REAL — el cliente lo dispara al entrar
// ============================================
// Envía un push de prueba al token del dispositivo actual del usuario. El
// cliente luego le pregunta "¿la recibiste?" (Sí/No). Si el token está
// muerto FCM lo rechaza y se limpia acá mismo.
router.post('/self-test', registerTokenLimiter, requireUser, async (req, res) => {
  try {
    const fcmToken = req.body && req.body.fcmToken;
    if (!fcmToken) return res.status(400).json({ error: 'fcmToken requerido' });
    const tokenStr = String(fcmToken);
    const user = req.authUser;

    // El token debe pertenecer al usuario (campo individual o array).
    const owns = user.fcmToken === tokenStr ||
      (Array.isArray(user.fcmTokens) && user.fcmTokens.some(t => t && t.token === tokenStr));
    if (!owns) return res.status(403).json({ error: 'Ese token no pertenece a tu cuenta' });

    const result = await sendNotificationToUser(
      tokenStr,
      '🔔 Notificación de prueba',
      'Si ves este mensaje, tus notificaciones funcionan. Volvé a la app y tocá "Sí".',
      { kind: 'self_test', tag: 'self-test' }
    );

    if (result && result.success) {
      return res.json({ ok: true });
    }
    // Token muerto: FCM lo rechazó. Lo limpiamos de la cuenta.
    if (result && result.invalidToken) {
      await User.updateOne({ id: user.id }, { $pull: { fcmTokens: { token: tokenStr } } }).catch(() => {});
      await User.updateOne({ id: user.id, fcmToken: tokenStr }, { $set: { fcmToken: null, fcmTokenUpdatedAt: null } }).catch(() => {});
      return res.json({ ok: false, invalidToken: true });
    }
    return res.json({ ok: false, error: (result && result.error) || 'No se pudo enviar la notificación' });
  } catch (error) {
    console.error('[FCM] self-test error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Borra un token FCM del usuario (cuando el test de notificación da "No" y
// hay que regenerarlo). El cliente además hace messaging.deleteToken() local.
router.post('/unregister-token', registerTokenLimiter, requireUser, async (req, res) => {
  try {
    const fcmToken = req.body && req.body.fcmToken;
    if (!fcmToken) return res.status(400).json({ error: 'fcmToken requerido' });
    const tokenStr = String(fcmToken);
    const user = req.authUser;
    await User.updateOne({ id: user.id }, { $pull: { fcmTokens: { token: tokenStr } } });
    await User.updateOne({ id: user.id, fcmToken: tokenStr }, { $set: { fcmToken: null, fcmTokenUpdatedAt: null } });
    res.json({ ok: true });
  } catch (error) {
    console.error('[FCM] unregister-token error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENVIAR NOTIFICACIÓN A UN USUARIO
// ============================================
router.post('/send', requireAdmin, async (req, res) => {
  try {
    const { fcmToken, title, body, data } = req.body;
    
    if (!fcmToken || !title || !body) {
      return res.status(400).json({ 
        error: 'FCM Token, título y cuerpo son requeridos' 
      });
    }

    const result = await sendNotificationToUser(fcmToken, title, body, data || {});
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: 'Notificación enviada',
        messageId: result.messageId 
      });
    } else {
      // Si el token está permanentemente inválido, borrarlo de la BD
      if (result.invalidToken) {
        try {
          const invalidTokenStr = String(fcmToken);
          await User.updateOne(
            { fcmToken: invalidTokenStr },
            { $set: { fcmToken: null, fcmTokenUpdatedAt: null } }
          );
          await User.updateMany(
            { 'fcmTokens.token': invalidTokenStr },
            { $pull: { fcmTokens: { token: invalidTokenStr } } }
          );
          console.log('[FCM] 🗑️ Token inválido eliminado automáticamente de la BD');
        } catch (cleanErr) {
          console.error('[FCM] Error al borrar token inválido:', cleanErr.message);
        }
      }
      res.status(500).json({ 
        success: false, 
        error: result.error,
        tokenCleaned: result.invalidToken === true
      });
    }
  } catch (error) {
    console.error('[FCM] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENVIAR NOTIFICACIÓN A MÚLTIPLES USUARIOS
// ============================================
router.post('/send-multiple', requireAdmin, async (req, res) => {
  try {
    const { fcmTokens, title, body, data } = req.body;
    
    if (!fcmTokens || !Array.isArray(fcmTokens) || fcmTokens.length === 0) {
      return res.status(400).json({ 
        error: 'Array de FCM Tokens requerido' 
      });
    }

    if (!title || !body) {
      return res.status(400).json({ 
        error: 'Título y cuerpo son requeridos' 
      });
    }

    const result = await sendNotificationToMultiple(fcmTokens, title, body, data || {});
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: 'Notificaciones enviadas',
        successCount: result.successCount,
        failureCount: result.failureCount
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error 
      });
    }
  } catch (error) {
    console.error('[FCM] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENVIAR NOTIFICACIÓN A TÓPICO
// ============================================
router.post('/send-topic', requireAdmin, async (req, res) => {
  try {
    const { topic, title, body, data } = req.body;
    
    if (!topic || !title || !body) {
      return res.status(400).json({ 
        error: 'Tópico, título y cuerpo son requeridos' 
      });
    }

    const result = await sendNotificationToTopic(topic, title, body, data || {});
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: 'Notificación enviada al tópico',
        messageId: result.messageId 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error 
      });
    }
  } catch (error) {
    console.error('[FCM] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// SUSCRIBIR USUARIO A TÓPICO
// ============================================
router.post('/subscribe-topic', requireAdmin, async (req, res) => {
  try {
    const { fcmToken, topic } = req.body;
    
    if (!fcmToken || !topic) {
      return res.status(400).json({ 
        error: 'FCM Token y tópico son requeridos' 
      });
    }

    const result = await subscribeToTopic(fcmToken, topic);
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: `Suscrito al tópico ${topic}` 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error 
      });
    }
  } catch (error) {
    console.error('[FCM] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DESUSCRIBIR USUARIO DE TÓPICO
// ============================================
router.post('/unsubscribe-topic', requireAdmin, async (req, res) => {
  try {
    const { fcmToken, topic } = req.body;
    
    if (!fcmToken || !topic) {
      return res.status(400).json({ 
        error: 'FCM Token y tópico son requeridos' 
      });
    }

    const result = await unsubscribeFromTopic(fcmToken, topic);
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: `Desuscrito del tópico ${topic}` 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error 
      });
    }
  } catch (error) {
    console.error('[FCM] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// TEST - ENVIAR NOTIFICACIÓN DE PRUEBA
// ============================================
router.post('/test', requireAdmin, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    
    if (!fcmToken) {
      return res.status(400).json({ 
        error: 'FCM Token requerido' 
      });
    }

    const result = await sendNotificationToUser(
      fcmToken,
      '🧪 Test de Notificación',
      '¡Si ves esto, las notificaciones funcionan correctamente!',
      { type: 'test', timestamp: Date.now().toString() }
    );
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: 'Notificación de prueba enviada',
        messageId: result.messageId 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error 
      });
    }
  } catch (error) {
    console.error('[FCM] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENVIAR NOTIFICACIÓN MASIVA A TODOS LOS USUARIOS
// ============================================
router.post('/send-all', requireAdmin, async (req, res) => {
  try {
    const { title, body, data, filter } = req.body;
    
    if (!title || !body) {
      return res.status(400).json({ 
        error: 'Título y cuerpo son requeridos' 
      });
    }

    console.log('[FCM] Iniciando envío masivo...');
    
    const result = await sendNotificationToAllUsers(
      User, 
      title, 
      body, 
      data || {}, 
      filter || {}
    );
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: 'Notificaciones enviadas',
        totalUsers: result.totalUsers,
        successCount: result.successCount,
        failureCount: result.failureCount,
        cleanedTokens: result.cleanedTokens || 0,
        failedTokens: result.failedTokens
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error 
      });
    }
  } catch (error) {
    console.error('[FCM] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENVIAR NOTIFICACIÓN A USUARIOS ESPECÍFICOS POR USERNAME
// ============================================
router.post('/send-to-usernames', requireAdmin, async (req, res) => {
  try {
    const { usernames, title, body, data } = req.body;
    
    if (!usernames || !Array.isArray(usernames) || usernames.length === 0) {
      return res.status(400).json({ 
        error: 'Array de usernames requerido' 
      });
    }

    if (!title || !body) {
      return res.status(400).json({ 
        error: 'Título y cuerpo son requeridos' 
      });
    }

    const result = await sendNotificationToUsernames(
      User,
      usernames,
      title,
      body,
      data || {}
    );
    
    if (result.success) {
      res.json({ 
        success: true, 
        message: 'Notificaciones enviadas',
        targetUsers: result.targetUsers,
        successCount: result.successCount,
        failureCount: result.failureCount
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error 
      });
    }
  } catch (error) {
    console.error('[FCM] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ESTRATEGIA DE NOTIFICACIONES (plantillas editables)
// ============================================
const NOTIF_TEMPLATE_DEFAULTS = {
  bono_50:    { label: 'Bono 50%',             title: '🎁 ¡Bono del 50%!',        body: 'Cargá ahora y te damos un 50% extra. ¡Solo por {horas} horas!',        durationHours: 24, hasDuration: true },
  bono_100:   { label: 'Bono 100%',            title: '🔥 ¡Bono del 100%!',       body: 'Duplicá tu carga: 100% de bono. ¡Aprovechá, vence en {horas} horas!',   durationHours: 12, hasDuration: true },
  invitacion: { label: 'Invitación a jugar',   title: '🎰 ¡Te estamos esperando!', body: 'Entrá ahora y probá tu suerte. ¡Hoy puede ser tu día!',                 durationHours: 0,  hasDuration: false },
  regalo:     { label: 'Regalo',               title: '🎉 ¡Tenés un regalo!',      body: 'Te dejamos un regalo en tu cuenta. Ingresá para reclamarlo.',           durationHours: 0,  hasDuration: false },
  reembolso:  { label: 'Reembolso disponible', title: '💸 Reembolso disponible',   body: 'Tenés un reembolso para reclamar. ¡No lo dejes pasar!',                 durationHours: 0,  hasDuration: false }
};
const NOTIF_TEMPLATE_TYPES = Object.keys(NOTIF_TEMPLATE_DEFAULTS);
const NOTIF_LAUNCH_PLANS = ['suave', 'normal', 'activo', 'solo_reembolsos', 'todos'];

// Categoría de tope de cada tipo. El reembolso no tiene tope mensual.
const NOTIF_TYPE_CATEGORY = {
  bono_50: 'bonos',
  bono_100: 'bonos',
  invitacion: 'invitaciones',
  regalo: 'regalos',
  reembolso: null
};

// Topes mensuales por plan (coinciden con la encuesta que ve el usuario).
const NOTIF_PLAN_LIMITS = {
  suave:           { bonos: 2, invitaciones: 5,  regalos: 2 },
  normal:          { bonos: 4, invitaciones: 5,  regalos: 2 },
  activo:          { bonos: 6, invitaciones: 10, regalos: 3 },
  solo_reembolsos: { bonos: 0, invitaciones: 0,  regalos: 0 }
};

// Período mensual actual ('YYYY-MM') para los contadores de tope.
function _currentNotifPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Construye el {title, body} final de una plantilla, reemplazando {horas}.
function _buildNotifContent(tplDoc, type) {
  const def = NOTIF_TEMPLATE_DEFAULTS[type];
  const title = (tplDoc && tplDoc.title) || def.title;
  let body = (tplDoc && tplDoc.body) || def.body;
  const hours = (tplDoc && tplDoc.durationHours != null) ? tplDoc.durationHours : def.durationHours;
  body = String(body).replace(/\{horas\}/g, String(hours));
  return { title, body };
}

// Listar las plantillas (mezcla lo guardado con los valores por defecto).
router.get('/templates', requireAdmin, async (req, res) => {
  try {
    const saved = await NotifTemplate.find({}).lean();
    const byType = {};
    saved.forEach(t => { byType[t.type] = t; });
    const templates = NOTIF_TEMPLATE_TYPES.map(type => {
      const def = NOTIF_TEMPLATE_DEFAULTS[type];
      const s = byType[type];
      const category = NOTIF_TYPE_CATEGORY[type];
      return {
        type,
        label: def.label,
        hasDuration: def.hasDuration,
        title: s ? s.title : def.title,
        body: s ? s.body : def.body,
        durationHours: (s && s.durationHours != null) ? s.durationHours : def.durationHours,
        category,
        limits: category ? {
          suave: NOTIF_PLAN_LIMITS.suave[category],
          normal: NOTIF_PLAN_LIMITS.normal[category],
          activo: NOTIF_PLAN_LIMITS.activo[category]
        } : null
      };
    });
    res.json({ success: true, templates });
  } catch (error) {
    console.error('[NOTIF-STRATEGY] templates error:', error);
    res.status(500).json({ error: 'Error obteniendo las plantillas' });
  }
});

// Guardar / actualizar una plantilla.
router.put('/templates/:type', requireAdmin, async (req, res) => {
  try {
    const { type } = req.params;
    if (!NOTIF_TEMPLATE_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Tipo de plantilla inválido' });
    }
    const { title, body, durationHours } = req.body || {};
    if (!title || !body) {
      return res.status(400).json({ error: 'Título y texto son obligatorios' });
    }
    const update = {
      title: String(title).slice(0, 100),
      body: String(body).slice(0, 500),
      updatedAt: new Date(),
      updatedBy: req.user && req.user.username
    };
    if (NOTIF_TEMPLATE_DEFAULTS[type].hasDuration) {
      const h = parseInt(durationHours, 10);
      update.durationHours = (isNaN(h) || h < 0) ? NOTIF_TEMPLATE_DEFAULTS[type].durationHours : h;
    }
    await NotifTemplate.findOneAndUpdate({ type }, { $set: update }, { upsert: true, new: true });
    res.json({ success: true, message: 'Plantilla guardada' });
  } catch (error) {
    console.error('[NOTIF-STRATEGY] save template error:', error);
    res.status(500).json({ error: 'Error guardando la plantilla' });
  }
});

// Probar: enviar la notificación de una plantilla al usuario de prueba.
router.post('/strategy/test', requireAdmin, async (req, res) => {
  try {
    const { type, username } = req.body || {};
    if (!NOTIF_TEMPLATE_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Tipo de plantilla inválido' });
    }
    if (!username || typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: 'Indicá el usuario de prueba' });
    }
    const tpl = await NotifTemplate.findOne({ type }).lean();
    const { title, body } = _buildNotifContent(tpl, type);
    const result = await sendNotificationToUsernames(
      User, [username.trim()], title, body, { kind: 'strategy', type }
    );
    if (result.success) {
      res.json({
        success: true,
        message: (result.successCount > 0)
          ? `Notificación de prueba enviada a ${username.trim()}`
          : `No se pudo entregar a ${username.trim()} (sin app/token activo)`,
        successCount: result.successCount || 0,
        failureCount: result.failureCount || 0
      });
    } else {
      res.status(400).json({ error: result.error || 'No se pudo enviar la prueba' });
    }
  } catch (error) {
    console.error('[NOTIF-STRATEGY] test error:', error);
    res.status(500).json({ error: 'Error enviando la prueba' });
  }
});

// Ejecuta el lanzamiento de una plantilla a un plan, respetando el tope mensual
// (los reembolsos no tienen tope). Reutilizado por la ruta y por el worker de
// notificaciones programadas. Devuelve un objeto con el resultado.
async function _runStrategyLaunch(type, plan) {
  const tpl = await NotifTemplate.findOne({ type }).lean();
  const { title, body } = _buildNotifContent(tpl, type);
  const data = { kind: 'strategy', type };
  const category = NOTIF_TYPE_CATEGORY[type];

  // Reembolso: sin tope mensual. Se envía a todo el plan elegido.
  if (!category) {
    const filter = (plan === 'todos') ? {} : { notificationPlan: plan };
    const result = await sendNotificationToAllUsers(User, title, body, data, filter);
    if (!result.success) return { success: false, error: result.error || 'No se pudo lanzar' };
    return {
      success: true,
      totalUsers: result.totalUsers || 0,
      successCount: result.successCount || 0,
      failureCount: result.failureCount || 0,
      skippedCap: 0,
      skippedOther: 0
    };
  }

  // Categoría con tope: filtrar a los usuarios que no llegaron a su límite.
  const userQuery = { role: 'user' };
  if (plan !== 'todos') userQuery.notificationPlan = plan;
  const candidates = await User.find(userQuery)
    .select('username notificationPlan notifMonthlyCounts fcmToken fcmTokens')
    .lean();

  const period = _currentNotifPeriod();
  const eligible = [];
  let skippedCap = 0;
  let skippedOther = 0;
  for (const u of candidates) {
    const limits = NOTIF_PLAN_LIMITS[u.notificationPlan];
    if (!limits) { skippedOther++; continue; } // sin plan asignado
    const hasToken = !!(u.fcmToken || (Array.isArray(u.fcmTokens) && u.fcmTokens.length > 0));
    if (!hasToken) { skippedOther++; continue; } // sin app instalada
    const cap = limits[category];
    let count = 0;
    if (u.notifMonthlyCounts && u.notifMonthlyCounts.period === period) {
      count = u.notifMonthlyCounts[category] || 0;
    }
    if (count >= cap) { skippedCap++; continue; } // llegó al tope del mes
    eligible.push(u.username);
  }

  if (eligible.length === 0) {
    return { success: true, empty: true, totalUsers: 0, successCount: 0, failureCount: 0, skippedCap, skippedOther };
  }

  const result = await sendNotificationToUsernames(User, eligible, title, body, data);

  // Sumar 1 al contador mensual de los usuarios a los que se les lanzó.
  await User.updateMany(
    { username: { $in: eligible }, 'notifMonthlyCounts.period': { $ne: period } },
    { $set: { notifMonthlyCounts: { period, bonos: 0, invitaciones: 0, regalos: 0 } } }
  );
  await User.updateMany(
    { username: { $in: eligible } },
    { $inc: { ['notifMonthlyCounts.' + category]: 1 } }
  );

  if (!result.success) return { success: false, error: result.error || 'No se pudo lanzar' };
  return {
    success: true,
    totalUsers: eligible.length,
    successCount: result.successCount || 0,
    failureCount: result.failureCount || 0,
    skippedCap,
    skippedOther
  };
}

// Lanzar: enviar la notificación de una plantilla a los usuarios de un plan.
router.post('/strategy/launch', requireAdmin, async (req, res) => {
  try {
    const { type, plan } = req.body || {};
    if (!NOTIF_TEMPLATE_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Tipo de plantilla inválido' });
    }
    if (!NOTIF_LAUNCH_PLANS.includes(plan)) {
      return res.status(400).json({ error: 'Plan inválido' });
    }
    const r = await _runStrategyLaunch(type, plan);
    if (!r.success) {
      return res.status(400).json({ error: r.error || 'No se pudo lanzar la notificación' });
    }
    res.json({
      success: true,
      message: r.empty
        ? 'Ningún usuario quedó habilitado (llegaron al tope del mes, sin plan o sin app).'
        : `Notificación lanzada al plan: ${plan}`,
      totalUsers: r.totalUsers,
      successCount: r.successCount,
      failureCount: r.failureCount,
      skippedCap: r.skippedCap,
      skippedOther: r.skippedOther
    });
  } catch (error) {
    console.error('[NOTIF-STRATEGY] launch error:', error);
    res.status(500).json({ error: 'Error lanzando la notificación' });
  }
});

// ============================================
// NOTIFICACIONES PROGRAMADAS
// ============================================

// Devuelve la hora Argentina actual como { hhmm, ymd, dow }.
function _argParts(dateObj) {
  const tz = 'America/Argentina/Buenos_Aires';
  const d = dateObj || new Date();
  const hhmm = d.toLocaleTimeString('es-AR', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
  const ymd = d.toLocaleDateString('en-CA', { timeZone: tz });
  const dowName = d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' });
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hhmm, ymd, dow: dowMap[dowName] };
}

// Listar las notificaciones programadas.
router.get('/strategy/schedules', requireAdmin, async (req, res) => {
  try {
    const schedules = await ScheduledNotif.find({}).sort({ createdAt: -1 }).lean();
    res.json({ success: true, schedules });
  } catch (error) {
    console.error('[NOTIF-SCHED] list error:', error);
    res.status(500).json({ error: 'Error obteniendo las programaciones' });
  }
});

// Crear una notificación programada.
router.post('/strategy/schedules', requireAdmin, async (req, res) => {
  try {
    const { type, plan, mode, runAt, time, dayOfWeek } = req.body || {};
    if (!NOTIF_TEMPLATE_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Tipo de plantilla inválido' });
    }
    if (!NOTIF_LAUNCH_PLANS.includes(plan)) {
      return res.status(400).json({ error: 'Plan inválido' });
    }
    if (!['once', 'daily', 'weekly'].includes(mode)) {
      return res.status(400).json({ error: 'Modo inválido' });
    }

    const doc = { type, plan, mode, enabled: true, createdBy: req.user && req.user.username };

    if (mode === 'once') {
      // runAt llega como 'YYYY-MM-DDTHH:MM' (hora Argentina). Argentina es UTC-3.
      if (!runAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(runAt)) {
        return res.status(400).json({ error: 'Indicá la fecha y hora' });
      }
      const when = new Date(runAt.slice(0, 16) + ':00-03:00');
      if (isNaN(when.getTime())) {
        return res.status(400).json({ error: 'Fecha y hora inválidas' });
      }
      doc.runAt = when;
    } else {
      if (!time || !/^\d{2}:\d{2}$/.test(time)) {
        return res.status(400).json({ error: 'Indicá la hora (HH:MM)' });
      }
      doc.time = time;
      if (mode === 'weekly') {
        const dow = parseInt(dayOfWeek, 10);
        if (isNaN(dow) || dow < 0 || dow > 6) {
          return res.status(400).json({ error: 'Indicá el día de la semana' });
        }
        doc.dayOfWeek = dow;
      }
    }

    const created = await ScheduledNotif.create(doc);
    res.json({ success: true, schedule: created });
  } catch (error) {
    console.error('[NOTIF-SCHED] create error:', error);
    res.status(500).json({ error: 'Error creando la programación' });
  }
});

// Activar / desactivar una programación.
router.patch('/strategy/schedules/:id', requireAdmin, async (req, res) => {
  try {
    const enabled = req.body && req.body.enabled === true;
    const updated = await ScheduledNotif.findByIdAndUpdate(
      req.params.id, { $set: { enabled } }, { new: true }
    );
    if (!updated) return res.status(404).json({ error: 'Programación no encontrada' });
    res.json({ success: true, schedule: updated });
  } catch (error) {
    console.error('[NOTIF-SCHED] patch error:', error);
    res.status(500).json({ error: 'Error actualizando la programación' });
  }
});

// Eliminar una programación.
router.delete('/strategy/schedules/:id', requireAdmin, async (req, res) => {
  try {
    const deleted = await ScheduledNotif.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Programación no encontrada' });
    res.json({ success: true });
  } catch (error) {
    console.error('[NOTIF-SCHED] delete error:', error);
    res.status(500).json({ error: 'Error eliminando la programación' });
  }
});

// Worker: cada minuto revisa las programaciones y dispara las que corresponden.
async function _runDueSchedules() {
  try {
    const { hhmm, ymd, dow } = _argParts();
    const now = new Date();
    const schedules = await ScheduledNotif.find({ enabled: true }).lean();
    for (const s of schedules) {
      let shouldRun = false;
      if (s.mode === 'once') {
        if (s.runAt && new Date(s.runAt) <= now && !s.lastRunAt) shouldRun = true;
      } else if (s.mode === 'daily' || s.mode === 'weekly') {
        const dayMatches = (s.mode === 'daily') || (s.dayOfWeek === dow);
        if (s.time === hhmm && dayMatches) {
          const lastYmd = s.lastRunAt ? _argParts(new Date(s.lastRunAt)).ymd : null;
          if (lastYmd !== ymd) shouldRun = true;
        }
      }
      if (!shouldRun) continue;

      try {
        const r = await _runStrategyLaunch(s.type, s.plan);
        const resultStr = r.success
          ? `OK — enviadas:${r.successCount || 0} omitidas-tope:${r.skippedCap || 0}`
          : `Error: ${r.error}`;
        const update = { lastRunAt: new Date(), lastResult: resultStr };
        if (s.mode === 'once') update.enabled = false;
        await ScheduledNotif.updateOne({ _id: s._id }, { $set: update });
        console.log(`[NOTIF-SCHED] Ejecutada ${s._id} (${s.type}/${s.plan}): ${resultStr}`);
      } catch (err) {
        console.error(`[NOTIF-SCHED] Error ejecutando ${s._id}:`, err.message);
        await ScheduledNotif.updateOne(
          { _id: s._id },
          { $set: { lastRunAt: new Date(), lastResult: 'Error: ' + err.message } }
        );
      }
    }
  } catch (e) {
    console.error('[NOTIF-SCHED] worker error:', e.message);
  }
}
setInterval(_runDueSchedules, 60 * 1000).unref?.();

// ============================================
// OBTENER ESTADÍSTICAS DE TOKENS FCM
// ============================================
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const now = Date.now();
    if (_fcmStatsCache.data && (now - _fcmStatsCache.updatedAt) < FCM_CACHE_TTL) {
      return res.json(_fcmStatsCache.data);
    }

    console.log('[FCM] Solicitando estadísticas...');
    
    const totalUsers = await User.countDocuments();
    const usersWithToken = await User.countDocuments({
      $or: [
        { fcmToken: { $exists: true, $ne: null } },
        { 'fcmTokens.0': { $exists: true } }
      ]
    });
    const usersWithoutToken = totalUsers - usersWithToken;

    console.log(`[FCM] Estadísticas: ${totalUsers} total, ${usersWithToken} con token, ${usersWithoutToken} sin token`);

    // Obtener últimos 10 usuarios con token
    const recentUsers = await User.find({ 
      fcmToken: { $exists: true, $ne: null } 
    })
    .select('username fcmToken fcmTokenUpdatedAt')
    .sort({ fcmTokenUpdatedAt: -1 })
    .limit(10)
    .lean();

    const result = {
      success: true,
      stats: {
        totalUsers,
        usersWithToken,
        usersWithoutToken,
        percentage: totalUsers > 0 ? Math.round((usersWithToken / totalUsers) * 100) : 0
      },
      recentUsers: recentUsers.map(u => ({
        username: u.username,
        tokenPreview: u.fcmToken ? u.fcmToken.substring(0, 20) + '...' : null,
        updatedAt: u.fcmTokenUpdatedAt
      }))
    };
    _fcmStatsCache.data = result;
    _fcmStatsCache.updatedAt = now;
    res.json(result);
  } catch (error) {
    console.error('[FCM] Error:', error);
    if (_fcmStatsCache.data) {
      return res.json({ ..._fcmStatsCache.data, cached: true });
    }
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DIAGNÓSTICO - VERIFICAR ESTADO DEL SISTEMA
// ============================================
router.get('/diagnostic', requireAdmin, async (req, res) => {
  try {
    const admin = require('firebase-admin');
    
    // Verificar si Firebase Admin está inicializado
    const firebaseInitialized = admin.apps.length > 0;

    // El servidor acepta 2 formas de credencial: el JSON del service account
    // (base64 o crudo) — método primario — o las 3 variables legacy. Con
    // cualquiera de las dos alcanza; no marcar error si está la moderna.
    const hasServiceAccountJson = !!(process.env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    const hasLegacyVars = !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
    const envVars = {
      FIREBASE_SERVICE_ACCOUNT_JSON: hasServiceAccountJson,
      FIREBASE_PROJECT_ID:   !!process.env.FIREBASE_PROJECT_ID,
      FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
      FIREBASE_PRIVATE_KEY:  !!process.env.FIREBASE_PRIVATE_KEY,
    };
    const allEnvVarsPresent = hasServiceAccountJson || hasLegacyVars;
    
    // Contar usuarios con token
    const usersWithToken = await User.countDocuments({
      $or: [
        { fcmToken: { $exists: true, $ne: null } },
        { 'fcmTokens.0': { $exists: true } }
      ]
    });
    
    res.json({
      success: true,
      diagnostic: {
        firebaseInitialized,
        envVarsPresent: envVars,
        allEnvVarsPresent,
        usersWithToken,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('[FCM] Error en diagnóstico:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============================================
// VERIFICAR Y LIMPIAR TOKENS INVÁLIDOS
// ============================================
router.post('/verify-tokens', requireAdmin, async (req, res) => {
  try {
    const { sendTest } = req.body;
    
    console.log('[FCM] Iniciando verificación de tokens...');
    
    // Obtener todos los usuarios con al menos un token (array o campo individual)
    const users = await User.find({
      $or: [
        { fcmToken: { $exists: true, $ne: null } },
        { 'fcmTokens.0': { $exists: true } }
      ]
    }).select('username fcmToken fcmTokens').lean();
    
    // Construir lista plana { token, username } para verificar
    const tokenList = [];
    for (const user of users) {
      const seen = new Set();
      if (user.fcmTokens && user.fcmTokens.length > 0) {
        for (const entry of user.fcmTokens) {
          if (entry.token && !seen.has(entry.token)) {
            seen.add(entry.token);
            tokenList.push({ token: entry.token, username: user.username, userId: user.id });
          }
        }
      }
      // Incluir campo individual solo si no está ya en el array
      if (user.fcmToken && !seen.has(user.fcmToken)) {
        tokenList.push({ token: user.fcmToken, username: user.username, userId: user.id });
      }
    }
    
    console.log(`[FCM] Verificando ${tokenList.length} tokens (${users.length} usuarios)...`);
    
    const results = {
      total: tokenList.length,
      valid: 0,
      invalid: 0,
      errors: [],
      cleaned: 0
    };
    
    for (const entry of tokenList) {
      try {
        // Intentar enviar una notificación de prueba silenciosa
        const testResult = await sendNotificationToUser(
          entry.token,
          'Test',
          'Verificación de token',
          { type: 'token_verify', silent: 'true' }
        );
        
        if (testResult.success) {
          results.valid++;
          console.log(`[FCM] ✅ Token válido: ${entry.username}`);
        } else {
          results.invalid++;
          results.errors.push({ username: entry.username, error: testResult.error });
          console.log(`[FCM] ❌ Token inválido: ${entry.username} - ${testResult.error}`);
          
          // Limpiar solo ese token específico, no todos los del usuario
          if (testResult.invalidToken) {
            await User.updateOne(
              { username: entry.username, fcmToken: entry.token },
              { $set: { fcmToken: null, fcmTokenUpdatedAt: null } }
            );
            await User.updateOne(
              { username: entry.username },
              { $pull: { fcmTokens: { token: entry.token } } }
            );
            results.cleaned++;
            console.log(`[FCM] 🧹 Token borrado automáticamente: ${entry.username} (${entry.token.substring(0, 20)}...)`);
            // Notificar a admins solo si el usuario no tiene más tokens
            const remaining = await User.findOne({
              username: entry.username,
              $or: [
                { fcmToken: { $exists: true, $ne: null } },
                { 'fcmTokens.0': { $exists: true } }
              ]
            }).select('id fcmToken fcmTokens').lean();
            if (!remaining && _io) {
              _io.to('admins').emit('user_app_status', {
                userId: entry.userId,
                username: entry.username,
                appInstalled: false
              });
            }
          }
        }
      } catch (e) {
        results.invalid++;
        results.errors.push({ username: entry.username, error: e.message });
      }
    }
    
    console.log(`[FCM] Verificación completada: ${results.valid} válidos, ${results.invalid} inválidos, ${results.cleaned} limpiados`);
    
    res.json({
      success: true,
      results
    });
  } catch (error) {
    console.error('[FCM] Error en verificación:', error);
    res.status(500).json({ error: error.message });
  }
});

// Referencia a io para emitir eventos de socket
let _io = null;
router.setIo = (ioInstance) => { _io = ioInstance; };

// ============================================
// LISTAR USUARIOS CON ESTADO DE TOKEN (Para panel de notificaciones)
// ============================================
router.get('/users-status', requireAdmin, async (req, res) => {
  try {
    const now = Date.now();
    // Cache only default (no-filter, page 1) requests to avoid stale paginated data
    const isDefaultRequest = (!req.query.filter || req.query.filter === 'all') &&
      (!req.query.page || req.query.page === '1') &&
      (!req.query.limit || req.query.limit === '50');
    if (isDefaultRequest && _fcmUsersStatusCache.data && (now - _fcmUsersStatusCache.updatedAt) < FCM_CACHE_TTL) {
      return res.json(_fcmUsersStatusCache.data);
    }

    const { page = 1, limit = 50, filter = 'all' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // "Tiene token" = token en el campo legacy fcmToken O en el array fcmTokens[].
    const HAS_TOKEN = { $or: [
      { fcmToken: { $exists: true, $ne: null } },
      { 'fcmTokens.0': { $exists: true } }
    ] };
    const NO_TOKEN = { fcmToken: { $in: [null, undefined] }, 'fcmTokens.0': { $exists: false } };

    let query = {};
    if (filter === 'with_token') {
      query = HAS_TOKEN;
    } else if (filter === 'without_token') {
      query = NO_TOKEN;
    }

    const total = await User.countDocuments(query);
    const users = await User.find(query)
      .select('username fcmToken fcmTokens fcmTokenUpdatedAt lastLogin createdAt')
      .sort({ fcmTokenUpdatedAt: -1, lastLogin: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const totalUsers = await User.countDocuments();
    const usersWithToken = await User.countDocuments(HAS_TOKEN);

    const result = {
      success: true,
      stats: {
        totalUsers,
        usersWithToken,
        usersWithoutToken: totalUsers - usersWithToken,
        coverage: totalUsers > 0 ? Math.round((usersWithToken / totalUsers) * 100) : 0
      },
      users: users.map(u => {
        const arrTok = (Array.isArray(u.fcmTokens) && u.fcmTokens[0] && u.fcmTokens[0].token) || null;
        const tok = u.fcmToken || arrTok;
        return {
          username: u.username,
          hasToken: !!tok,
          tokenUpdatedAt: u.fcmTokenUpdatedAt,
          lastLogin: u.lastLogin,
          tokenPreview: tok ? tok.substring(0, 20) + '...' : null
        };
      }),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    };
    if (isDefaultRequest) {
      _fcmUsersStatusCache.data = result;
      _fcmUsersStatusCache.updatedAt = now;
    }
    res.json(result);
  } catch (error) {
    console.error('[FCM] Error en users-status:', error);
    if (_fcmUsersStatusCache.data) {
      return res.json({ ..._fcmUsersStatusCache.data, cached: true });
    }
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ENVIAR NOTIFICACIÓN POR LOTES CONFIGURABLES
// Permite enviar a segmentos, con seguimiento de offset para "siguiente lote"
// Limpia automáticamente tokens inválidos detectados en el envío
// ============================================
router.post('/send-batch', requireAdmin, async (req, res) => {
  try {
    const { title, body, data, batchSize = 100, usernames, segment = 'all', batchOffset = 0 } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Título y cuerpo son requeridos' });
    }

    const validBatchSizes = [50, 100, 200];
    const chunkSize = validBatchSizes.includes(parseInt(batchSize)) ? parseInt(batchSize) : 100;
    const offset = Math.max(0, parseInt(batchOffset) || 0);

    // "Tiene token" = token en el campo legacy fcmToken O en el array fcmTokens[].
    // Es indispensable incluir el array: un usuario que registró push desde el
    // navegador (no la PWA) puede tener su token sólo en fcmTokens[].
    const HAS_TOKEN = { $or: [
      { fcmToken: { $exists: true, $ne: null } },
      { 'fcmTokens.0': { $exists: true } }
    ] };

    // Build base query based on segment. Se usa $and para combinar el filtro del
    // segmento con HAS_TOKEN sin pisar otros operadores $or del segmento.
    let query;
    if (usernames && usernames.length > 0) {
      // Match case-insensitive: si el admin tipea el usuario con otra
      // capitalización (ej. "VipGabi074" vs "vipgabi074") igual debe
      // encontrarlo, en vez de devolver 0 envíos silenciosamente.
      const unameRegexes = usernames
        .filter(u => typeof u === 'string' && u.trim())
        .map(u => new RegExp('^' + u.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'));
      query = { $and: [ { username: { $in: unameRegexes } }, HAS_TOKEN ] };
    } else if (segment === 'with_balance') {
      query = { $and: [ { balance: { $gt: 0 } }, HAS_TOKEN ] };
    } else if (segment === 'active') {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      query = { $and: [ { lastLogin: { $gte: cutoff } }, HAS_TOKEN ] };
    } else if (segment === 'inactive') {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      query = { $and: [ { $or: [{ lastLogin: { $lt: cutoff } }, { lastLogin: { $exists: false } }] }, HAS_TOKEN ] };
    } else if (segment === 'inactive_7d') {
      // Inactivos en los últimos 7 días (sin login en 7 días)
      const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      query = { $and: [ { $or: [{ lastLogin: { $lt: cutoff7d } }, { lastLogin: { $exists: false } }] }, HAS_TOKEN ] };
    } else {
      // all: todos con token FCM
      query = HAS_TOKEN;
    }

    const allUsers = await User.find(query).select('username fcmToken fcmTokens id').sort({ _id: 1 }).lean();

    if (allUsers.length === 0) {
      // IMPORTANTE: incluir totalSegmentUsers (y el resto de campos que el
      // panel lee). Sin esto el front mostraba "Total del segmento: undefined".
      return res.json({
        success: true,
        message: 'No hay usuarios con token FCM para enviar',
        totalUsers: 0, totalSegmentUsers: 0, successCount: 0, failureCount: 0, cleanedTokens: 0,
        batches: 0, batchResults: [], nextOffset: 0, remaining: 0,
        sentUsernames: [], failedTokens: [], batchId: null
      });
    }

    // Apply offset: send only the next chunk of chunkSize from offset
    const totalSegmentUsers = allUsers.length;
    const usersToSend = allUsers.slice(offset, offset + chunkSize);

    console.log(`[FCM Batch] Segmento=${segment} total=${totalSegmentUsers} offset=${offset} enviando=${usersToSend.length}`);

    let totalSuccess = 0;       // usuarios con al menos un envío exitoso
    let totalFailure = 0;       // usuarios sin ningún envío exitoso
    let totalCleaned = 0;       // tokens inválidos borrados
    let usersFullyCleaned = 0;  // usuarios que quedaron SIN ningún token tras limpiar
    let tokenSuccess = 0;       // tokens entregados (detalle)
    let tokenFailure = 0;       // tokens fallidos (detalle)
    const allFailedTokens = [];
    const sentUsernames = [];

    // Generar batchId para tracking de confirmaciones de entrega real.
    const batchId = _newBatchId();
    _registerBatch(batchId);

    for (const user of usersToSend) {
      sentUsernames.push(user.username);

      // Recolectar TODOS los tokens únicos del usuario: array fcmTokens[]
      // (navegador + PWA) más el campo legacy fcmToken. Sin esto se perdería
      // a los clientes cuyo token vive sólo en el array.
      const seenTok = new Set();
      const userTokens = [];
      if (Array.isArray(user.fcmTokens)) {
        for (const e of user.fcmTokens) {
          if (e && e.token && !seenTok.has(e.token)) {
            seenTok.add(e.token);
            userTokens.push(e.token);
          }
        }
      }
      if (user.fcmToken && !seenTok.has(user.fcmToken)) {
        seenTok.add(user.fcmToken);
        userTokens.push(user.fcmToken);
      }
      if (userTokens.length === 0) continue;

      // Inyectar batchId + userId en el data payload para que el SW del
      // cliente pueda confirmar entrega vía /confirm-delivery.
      const userData = Object.assign({}, data || {}, {
        batchId: batchId,
        userId: String(user._id || user.id || user.username)
      });

      let anySuccess = false;
      const invalidForUser = [];
      for (const tk of userTokens) {
        let result;
        try {
          result = await sendNotificationToUser(tk, title, body, userData);
        } catch (userErr) {
          console.error(`[FCM Batch] ❌ Error inesperado para ${user.username}:`, userErr.message);
          result = { success: false, error: userErr.message || 'Error inesperado', code: userErr.code || '', invalidToken: false };
        }
        if (result.success) {
          anySuccess = true;
          tokenSuccess++;
        } else {
          tokenFailure++;
          const isInvalid = result.invalidToken === true;
          if (isInvalid) invalidForUser.push(tk);
          allFailedTokens.push({
            username: user.username,
            error: result.error || '',
            code: result.code || '',
            cleaned: isInvalid
          });
        }
      }

      if (anySuccess) {
        totalSuccess++;
        _markBatchSent(batchId, user._id || user.id || user.username);
      } else {
        totalFailure++;
      }

      // Limpiar los tokens inválidos del usuario: del array y del campo legacy.
      if (invalidForUser.length > 0) {
        try {
          await User.updateOne(
            { username: user.username },
            { $pull: { fcmTokens: { token: { $in: invalidForUser } } } }
          );
          if (user.fcmToken && invalidForUser.includes(user.fcmToken)) {
            await User.updateOne(
              { username: user.username, fcmToken: user.fcmToken },
              { $set: { fcmToken: null, fcmTokenUpdatedAt: null } }
            );
          }
          totalCleaned += invalidForUser.length;
          console.log(`[FCM Batch] 🧹 ${invalidForUser.length} token(s) inválido(s) borrado(s): ${user.username}`);
          // El usuario quedó sin app si TODOS sus tokens resultaron inválidos.
          if (invalidForUser.length === userTokens.length) {
            usersFullyCleaned++;
            if (_io) {
              _io.to('admins').emit('user_app_status', {
                username: user.username,
                appInstalled: false
              });
            }
          }
        } catch (cleanErr) {
          console.error(`[FCM Batch] Error limpiando tokens de ${user.username}:`, cleanErr.message);
        }
      }
    }

    console.log(`[FCM Batch] ✅ Usuarios: ${totalSuccess} OK, ${totalFailure} fallidos | Tokens: ${tokenSuccess} OK, ${tokenFailure} fallidos, ${totalCleaned} limpiados`);

    // BUGFIX: el offset siguiente debe descontar los usuarios que quedaron sin
    // ningún token. Razón: la query del próximo lote usa HAS_TOKEN y se vuelve
    // a ejecutar; los 'usersFullyCleaned' usuarios ya no aparecerán, corriendo
    // el array. Si avanzáramos offset+=chunkSize saltearíamos silenciosamente a
    // esos usuarios. (Limpiar UN token de un usuario que conserva otros NO lo
    // saca de la query, así que sólo cuenta usersFullyCleaned, no totalCleaned.)
    const nextOffset = offset + usersToSend.length - usersFullyCleaned;
    const remaining = Math.max(0, totalSegmentUsers - usersFullyCleaned - nextOffset);

    res.json({
      success: true,
      totalUsers: usersToSend.length,
      totalSegmentUsers,
      successCount: totalSuccess,
      failureCount: totalFailure,
      cleanedTokens: totalCleaned,
      batches: 1,
      batchSize: chunkSize,
      batchOffset: offset,
      nextOffset,
      remaining,
      sentUsernames: sentUsernames.slice(0, 50),
      batchResults: [{ batch: 1, total: usersToSend.length, success: totalSuccess, failure: totalFailure }],
      failedTokens: allFailedTokens.slice(0, 20),
      // batchId permite al admin polling /batch-status/:batchId para ver
      // confirmaciones de entrega reales (no sólo aceptación por FCM).
      batchId: batchId
    });
  } catch (error) {
    console.error('[FCM Batch] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CONFIRMACIÓN DE ENTREGA (llamado desde el SW del cliente)
// ============================================
// El SW invoca este endpoint cuando recibe efectivamente la notificación
// push. Sin auth: el SW no tiene cookie ni JWT. La protección viene de:
//   1) batchId opaco (no enumerable razonablemente).
//   2) TTL corto (10 min) tras el cual el batch se descarta.
//   3) Sólo registra confirmaciones, no expone datos.
router.post('/confirm-delivery', express.json({ limit: '1kb' }), (req, res) => {
  try {
    const { batchId, userId } = req.body || {};
    if (!batchId || !userId) {
      return res.status(400).json({ error: 'batchId y userId requeridos' });
    }
    // Solo se cuenta la confirmación si el userId estaba realmente en el
    // envío de ese batch. Evita que se inflen las métricas de entrega
    // posteando userIds arbitrarios contra un batchId.
    const batch = _pendingBatches.get(String(batchId));
    if (batch && batch.sentUsers.has(String(userId))) {
      batch.confirmedUsers.add(String(userId));
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[NOTIF] confirm-delivery error:', e.message);
    res.status(500).json({ error: 'internal' });
  }
});

// ============================================
// ESTADO DE UN BATCH (polled por el admin panel)
// ============================================
router.get('/batch-status/:batchId', requireAdmin, (req, res) => {
  const batchId = String(req.params.batchId || '');
  const batch = _pendingBatches.get(batchId);
  if (!batch) {
    return res.status(404).json({ error: 'Batch no encontrado o expirado' });
  }
  res.json({
    batchId,
    sentAt: batch.sentAt,
    ageMs: Date.now() - batch.sentAt,
    sent: batch.sentUsers.size,
    confirmed: batch.confirmedUsers.size,
    pending: Math.max(0, batch.sentUsers.size - batch.confirmedUsers.size),
    confirmedUserIds: Array.from(batch.confirmedUsers)
  });
});

module.exports = router;
