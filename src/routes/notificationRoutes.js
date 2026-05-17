// ============================================
// RUTAS DE NOTIFICACIONES PUSH
// ============================================

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
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
    decoded = jwt.verify(token, jwtSecret);
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
router.post('/register-token', async (req, res) => {
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
    const decoded = jwt.verify(token, jwtSecret);
    
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
    
    console.log('[FCM] Usuario encontrado:', user.username);

    const normalizedCtx = fcmTokenContext || 'browser';
    const normalizedPerm = notifPermission || null;

    // Garantizar que el token se trate siempre como string para evitar inyección NoSQL
    const tokenStr = String(fcmToken);

    // CRITICAL: si este token estaba registrado bajo OTRO usuario (porque
    // el dueño del device cambió de cuenta sin hacer logout), sacarlo de
    // ahí para que no le sigan llegando push notifications del usuario
    // anterior. Cubre el caso "instalé con atojuan, ahora entro como
    // royaltomas y me llegan notifs de ato".
    try {
      const stripFromOthers = await User.updateMany(
        { id: { $ne: user.id }, 'fcmTokens.token': tokenStr },
        { $pull: { fcmTokens: { token: tokenStr } } }
      );
      if (stripFromOthers.modifiedCount > 0) {
        console.log(`[FCM] Token reasignado: removido de ${stripFromOthers.modifiedCount} usuario(s) anteriores`);
      }
      // También limpiar los campos legacy (single fcmToken) en otros users
      await User.updateMany(
        { id: { $ne: user.id }, fcmToken: tokenStr },
        { $unset: { fcmToken: 1, fcmTokenContext: 1, fcmTokenUpdatedAt: 1 } }
      );
    } catch (e) {
      console.warn('[FCM] No se pudo limpiar el token en otros usuarios:', e.message);
    }

    // Detectar plataforma del user-agent para que el panel admin pueda
    // mostrar si el cliente esta en Android, iPhone o Desktop. Heuristica
    // simple basada en sustrings; cubre la gran mayoria de casos. iPad
    // moderno reporta MacIntel + 'Mobile' a veces — incluimos el caso.
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    let platform = null;
    if (ua.includes('android')) platform = 'android';
    else if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) platform = 'ios';
    else if (ua.includes('macintosh') && ua.includes('mobile')) platform = 'ios'; // iPad moderno
    else if (ua.includes('windows') || ua.includes('macintosh') || ua.includes('linux')) platform = 'desktop';

    // Actualizar el array fcmTokens: upsert por token string.
    // Si el token ya existe, actualizamos contexto/fecha/permiso.
    // Si es nuevo, lo añadimos SIN borrar los tokens anteriores.
    // Esto permite que Chrome y la PWA coexistan con sus propios tokens.
    const tokenEntry = {
      token: tokenStr,
      context: normalizedCtx,
      updatedAt: new Date(),
      notifPermission: normalizedPerm || null,
      platform: platform
    };
    if (!user.fcmTokens) user.fcmTokens = [];
    const existingIdx = user.fcmTokens.findIndex(t => t.token === tokenStr);
    if (existingIdx >= 0) {
      user.fcmTokens[existingIdx] = tokenEntry;
    } else {
      user.fcmTokens.push(tokenEntry);
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

    // Marca de "primera instalación PWA con notifs": se setea una sola vez
    // cuando el user pasa a tener BOTH context='standalone' AND
    // notifPermission='granted'. Permite detectar "clientes recuperados"
    // (users que estaban en la lista de "sin app" y ahora aparecen).
    if (normalizedCtx === 'standalone' && normalizedPerm === 'granted' && !user.appFirstInstalledAt) {
      user.appFirstInstalledAt = new Date();
      console.log('[FCM] 🎉 Cliente RECUPERADO (primera instalación PWA + notifs):', user.username);
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
    const { title, body, data, filter, prefix, historyMeta } = req.body;

    if (!title || !body) {
      return res.status(400).json({
        error: 'Título y cuerpo son requeridos'
      });
    }

    // Combinar el filtro Mongoose raw con el filtro por prefijo de usuario.
    // El prefijo se escapea para evitar regex injection.
    const finalFilter = Object.assign({}, filter || {});
    if (prefix && typeof prefix === 'string' && prefix.trim()) {
      const safe = prefix.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      finalFilter.username = { $regex: '^' + safe, $options: 'i' };
    }

    console.log('[FCM] Iniciando envío masivo...', prefix ? `(prefijo: ${prefix})` : '(todos)');

    const result = await sendNotificationToAllUsers(
      User,
      title,
      body,
      data || {},
      finalFilter
    );

    // Registrar en el historial de notificaciones (best-effort, no bloquea
    // la respuesta si falla). historyMeta lo manda el caller del admin con
    // info adicional (tipo de notif, datos de promo o giveaway).
    let historyId = null;
    try {
      const NotificationHistory = require('../models/NotificationHistory');
      const { v4: uuidv4 } = require('uuid');
      const meta = historyMeta || {};
      const entry = await NotificationHistory.create({
        id: uuidv4(),
        sentAt: new Date(),
        scheduledFor: meta.scheduledFor ? new Date(meta.scheduledFor) : null,
        audienceType: prefix ? 'prefix' : 'all',
        audiencePrefix: prefix || null,
        title,
        body,
        type: meta.type || 'plain',
        promoMessage: meta.promoMessage || null,
        promoCode: meta.promoCode || null,
        promoExpiresAt: meta.promoExpiresAt ? new Date(meta.promoExpiresAt) : null,
        giveawayAmount: meta.giveawayAmount || null,
        giveawayDurationMins: meta.giveawayDurationMins || null,
        giveawayExpiresAt: meta.giveawayExpiresAt ? new Date(meta.giveawayExpiresAt) : null,
        totalUsers: result.totalUsers || 0,
        successCount: result.successCount || 0,
        failureCount: result.failureCount || 0,
        cleanedTokens: result.cleanedTokens || 0,
        sentBy: meta.sentBy || null
      });
      historyId = entry.id;
    } catch (histErr) {
      console.warn('[FCM] No se pudo guardar en NotificationHistory:', histErr.message);
    }

    if (result.success) {
      res.json({
        success: true,
        message: 'Notificaciones enviadas',
        prefix: prefix || null,
        totalUsers: result.totalUsers,
        successCount: result.successCount,
        failureCount: result.failureCount,
        cleanedTokens: result.cleanedTokens || 0,
        failedTokens: result.failedTokens,
        historyId
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
      fcmToken: { $exists: true, $ne: null } 
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

    // Verificar env vars (sin exponer sus valores)
    const envVars = {
      FIREBASE_PROJECT_ID:   !!process.env.FIREBASE_PROJECT_ID,
      FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
      FIREBASE_PRIVATE_KEY:  !!process.env.FIREBASE_PRIVATE_KEY,
    };
    const allEnvVarsPresent = Object.values(envVars).every(Boolean);
    
    // Contar usuarios con token
    const usersWithToken = await User.countDocuments({ 
      fcmToken: { $exists: true, $ne: null } 
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

    let query = {};
    if (filter === 'with_token') {
      query = { fcmToken: { $exists: true, $ne: null } };
    } else if (filter === 'without_token') {
      query = { $or: [{ fcmToken: { $exists: false } }, { fcmToken: null }] };
    }

    const total = await User.countDocuments(query);
    const users = await User.find(query)
      .select('username fcmToken fcmTokenUpdatedAt lastLogin createdAt')
      .sort({ fcmTokenUpdatedAt: -1, lastLogin: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const totalUsers = await User.countDocuments();
    const usersWithToken = await User.countDocuments({ fcmToken: { $exists: true, $ne: null } });

    const result = {
      success: true,
      stats: {
        totalUsers,
        usersWithToken,
        usersWithoutToken: totalUsers - usersWithToken,
        coverage: totalUsers > 0 ? Math.round((usersWithToken / totalUsers) * 100) : 0
      },
      users: users.map(u => ({
        username: u.username,
        hasToken: !!(u.fcmToken),
        tokenUpdatedAt: u.fcmTokenUpdatedAt,
        lastLogin: u.lastLogin,
        tokenPreview: u.fcmToken ? u.fcmToken.substring(0, 20) + '...' : null
      })),
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

    // Build base query based on segment
    let query;
    if (usernames && usernames.length > 0) {
      query = { username: { $in: usernames }, fcmToken: { $exists: true, $ne: null } };
    } else if (segment === 'with_balance') {
      query = { fcmToken: { $exists: true, $ne: null }, balance: { $gt: 0 } };
    } else if (segment === 'active') {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      query = { fcmToken: { $exists: true, $ne: null }, lastLogin: { $gte: cutoff } };
    } else if (segment === 'inactive') {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      query = { fcmToken: { $exists: true, $ne: null }, $or: [{ lastLogin: { $lt: cutoff } }, { lastLogin: { $exists: false } }] };
    } else if (segment === 'inactive_7d') {
      // Inactivos en los últimos 7 días (sin login en 7 días)
      const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      query = { fcmToken: { $exists: true, $ne: null }, $or: [{ lastLogin: { $lt: cutoff7d } }, { lastLogin: { $exists: false } }] };
    } else {
      // all: todos con token FCM
      query = { fcmToken: { $exists: true, $ne: null } };
    }

    const allUsers = await User.find(query).select('username fcmToken').sort({ _id: 1 }).lean();

    if (allUsers.length === 0) {
      return res.json({
        success: true,
        message: 'No hay usuarios con token FCM para enviar',
        totalUsers: 0, successCount: 0, failureCount: 0, cleanedTokens: 0,
        batches: 0, batchResults: [], nextOffset: 0, remaining: 0
      });
    }

    // Apply offset: send only the next chunk of chunkSize from offset
    const totalSegmentUsers = allUsers.length;
    const usersToSend = allUsers.slice(offset, offset + chunkSize);

    console.log(`[FCM Batch] Segmento=${segment} total=${totalSegmentUsers} offset=${offset} enviando=${usersToSend.length}`);

    let totalSuccess = 0;
    let totalFailure = 0;
    let totalCleaned = 0;
    const allFailedTokens = [];
    const sentUsernames = [];

    // Generar batchId para tracking de confirmaciones de entrega real.
    const batchId = _newBatchId();
    _registerBatch(batchId);

    for (const user of usersToSend) {
      sentUsernames.push(user.username);
      let result;
      try {
        // Inyectar batchId + userId en el data payload para que el SW del
        // cliente pueda confirmar entrega vía /confirm-delivery.
        const userData = Object.assign({}, data || {}, {
          batchId: batchId,
          userId: String(user._id || user.id || user.username)
        });
        result = await sendNotificationToUser(user.fcmToken, title, body, userData);
      } catch (userErr) {
        console.error(`[FCM Batch] ❌ Error inesperado para ${user.username}:`, userErr.message);
        result = {
          success: false,
          error: userErr.message || 'Error inesperado',
          code: userErr.code || '',
          invalidToken: false
        };
      }
      if (result.success) {
        totalSuccess++;
        _markBatchSent(batchId, user._id || user.id || user.username);
      } else {
        totalFailure++;
        const errorMsg = result.error || '';
        const errorCode = result.code || '';
        const isInvalid = result.invalidToken === true;

        allFailedTokens.push({ username: user.username, error: errorMsg, code: errorCode, cleaned: isInvalid });

        if (isInvalid) {
          await User.updateOne(
            { username: user.username },
            { $set: { fcmToken: null, fcmTokenUpdatedAt: null } }
          );
          totalCleaned++;
          console.log(`[FCM Batch] 🧹 Token inválido borrado: ${user.username}`);
          if (_io) {
            _io.to('admins').emit('user_app_status', {
              username: user.username,
              appInstalled: false
            });
          }
        }
      }
    }

    console.log(`[FCM Batch] ✅ Total: ${totalSuccess} exitosas, ${totalFailure} fallidas, ${totalCleaned} tokens limpiados`);

    // BUGFIX: el offset siguiente debe descontar los tokens recién limpiados.
    // Razón: la query usa { fcmToken: { $ne: null } } y se vuelve a ejecutar en
    // el próximo lote. Como acabamos de poner fcmToken=null a 'totalCleaned'
    // usuarios, el array de la próxima query tendrá 'totalCleaned' usuarios
    // menos. Si avanzáramos offset+=chunkSize, saltearíamos silenciosamente a
    // 'totalCleaned' usuarios efectivos. Ej: lote 1 con offset=0, chunk=100 y
    // 14 limpiados → nextOffset debe ser 86, no 100, para que el lote 2 cubra
    // a los users que originalmente estaban en posiciones 100..199 del array.
    const nextOffset = offset + usersToSend.length - totalCleaned;
    const remaining = Math.max(0, totalSegmentUsers - totalCleaned - nextOffset);

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
    const batch = _pendingBatches.get(String(batchId));
    if (batch) {
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
