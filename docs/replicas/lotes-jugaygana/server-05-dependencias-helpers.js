// ============================================================================
// 5) HELPERS que el bloque asume existentes. Copiar SOLO los que falten en el repo destino
// Extraído de AUTOREEMBOLSOSjygactivo/server.js (commit 714dd04, 2026-10-03). Pegar tal cual
// salvo lo indicado en README.md.
// ============================================================================

// Si el destino ya tiene un equivalente (otro nombre), adaptar las llamadas del bloque 03, no duplicar.

// --- sendPushIfOffline(user, title, body, data) → { delivery: 'socket'|'push'|'none'|'error' } ---
async function sendPushIfOffline(user, title, body, data = {}) {
  // Recopilar todos los tokens activos del usuario (array multi-token + fallback al campo individual)
  const allTokens = new Set();
  if (user.fcmTokens && user.fcmTokens.length > 0) {
    for (const entry of user.fcmTokens) {
      if (entry.token) allTokens.add(entry.token);
    }
  }
  if (user.fcmToken) allTokens.add(user.fcmToken);

  if (allTokens.size === 0) return { delivery: 'none', sent: 0, failed: 0 };

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
    return { delivery: 'socket', sent: 0, failed: 0 };
  }

  let _sent = 0, _failed = 0; // #149: los lotes registran la entrega real
  for (const token of allTokens) {
    try {
      const result = await _sendPushToUser(token, title, body, data);
      if (result.success) {
        _sent++;
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
        _failed++;
        logger.warn(`[FCM] Error enviando push a ${user.username}: ${result.error}`);
      }
    } catch (err) {
      _failed++;
      logger.warn(`[FCM] Excepción enviando push a ${user.username}: ${err.message}`);
    }
  }
  return { delivery: _sent > 0 ? 'push' : (_failed > 0 ? 'error' : 'none'), sent: _sent, failed: _failed };
}

// --- renderSystemCommand(name, fallback, vars): mensajes automáticos editables desde COMANDOS ---
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

// --- resolveSysContent (helper de renderSystemCommand) ---
function resolveSysContent(cmd, fallback) {
  if (cmd) {
    if (!cmd.response || !String(cmd.response).trim()) return null;
    return cmd.response;
  }
  return fallback;
}

// --- _alertMoneyAmbiguous: alerta 🛑 cuando JUGAYGANA no confirma una operación de plata (#151) ---
async function _alertMoneyAmbiguous(ctx, userId, username, amount, err) {
  const msg = `🛑 VERIFICAR EN JUGAYGANA — ${ctx}: $${Number(amount).toLocaleString('es-AR')} a ${username}. JUGAYGANA no confirmó la operación y no se pudo verificar por saldo (${jugaygana.errToString(err || 'sin detalle')}). NO se reintentó automáticamente: puede haber entrado o no. Revisá el historial del usuario en JUGAYGANA antes de repetir la operación.`;
  logger.error(`[money-ambiguous] ${ctx} user=${username} amount=${amount}: ${jugaygana.errToString(err || '')}`);
  try { if (userId) await _emitAdminOnlyChatNote(userId, username, msg); } catch (_) {}
  try {
    if (telegramAlert.isEnabled()) {
      const e = telegramAlert.esc;
      await telegramAlert.send(`🛑 <b>${e(_projectLabel())}</b> — VERIFICAR PLATA en JUGAYGANA\n${e(ctx)}: $${Number(amount).toLocaleString('es-AR')} a @${e(username)}\nJUGAYGANA no confirmó y no se pudo verificar por saldo. No se reintentó. Revisar el historial del usuario antes de repetir.`);
    }
  } catch (_) {}
}

// --- _emitAdminOnlyChatNote: nota INTERNA (solo agentes) en el chat del cliente ---
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

// --- _rouletteHasAppInstalled: 'tiene la app instalada' por token FCM standalone ---
function _rouletteHasAppInstalled(u) {
  if (!u) return false;
  if (u.fcmTokenContext === 'standalone') return true;
  if (Array.isArray(u.fcmTokens)) {
    return u.fcmTokens.some(t => t && t.context === 'standalone');
  }
  return false;
}
