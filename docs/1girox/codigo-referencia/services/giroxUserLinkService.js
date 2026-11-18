/**
 * giroxUserLinkService.js — Vinculación automática de `User.giroxUserId`.
 *
 * Resuelve el ID numérico del jugador en 1girox cuando falta (usuarios viejos /
 * migrados) y lo persiste en la base local (backfill al vuelo).
 *
 * PARA QUÉ SIRVE ESTE ID: históricamente era IMPRESCINDIBLE, porque el netwin
 * —de donde salen los REEMBOLSOS y las COMISIONES DE REFERIDOS— sólo se podía
 * sacar del panel de administración, y el panel lo pide por `player_id` numérico.
 * Sin ese ID, a ese usuario no se le podía calcular el reembolso.
 *
 * Hoy el netwin también va por username (`giroxService.getPlayerStats`), así que el
 * ID dejó de ser un requisito para pagarle a alguien. Se sigue resolviendo y
 * guardando porque es el identificador estable del jugador en la plataforma (el
 * username se puede leer distinto, el ID no) y porque varios flujos lo muestran y
 * lo usan para cruzar datos con el panel a mano.
 *
 * -----------------------------------------------------------------------------
 * CAMBIO 2026-07-31 — Partner API v1.9: el ID lo devuelve la propia API
 * -----------------------------------------------------------------------------
 * Antes el ID se sacaba del PANEL de administración (`findPlayerIdByUsername`,
 * scraping de /users/fetch con un Bearer de sesión). Ahora `GET /players/{username}`
 * trae el `id` numérico, así que acá se usa `giroxService.getUserInfoByName()`:
 * misma API key que el resto del sistema, sin sesión que renovar y sin depender de
 * que el panel no cambie su HTML/JSON.
 *
 * Dos verificaciones que ANTES eran imprescindibles y hoy ya no hacen falta:
 *  1. Revalidar que el nombre devuelto sea EXACTAMENTE el buscado. El panel
 *     buscaba con LIKE ("prueba1" traía prueba1, prueba100, prueba12…) y agarrar
 *     el ID equivocado significaba pagarle el reembolso a OTRA persona. La Partner
 *     API resuelve por username exacto en la URL: no hay ambigüedad posible.
 *  2. Todo lo relativo al login del panel (Bearer, expiración, HTML de bloqueo).
 *
 * Reglas de seguridad que SÍ se mantienen:
 * - Sólo completa si el campo está vacío/null.
 * - Nunca sobrescribe un ID válido existente (update condicional → sin races).
 * - Si no se consigue un ID válido, devuelve null SIN escribir nada.
 */

const { User } = require('../models');
const giroxService = require('./giroxService');
const logger = require('../utils/logger');

/**
 * Obtener el giroxUserId de un usuario, completándolo automáticamente si todavía
 * no está cargado.
 *
 * @param {string} userId   - ID interno del usuario en la base local
 * @param {string} username - Username del usuario (el mismo en VIPCARGAS y 1girox)
 * @returns {Promise<number|null>} giroxUserId resuelto, o null si no se pudo determinar
 */
async function resolveGiroxUserId(userId, username) {
  // 1. Leer el campo actual de la base
  let userDoc = null;
  try {
    userDoc = await User.findOne({ id: userId }).select('giroxUserId').lean();
  } catch (err) {
    logger.error(`[GiroxUserLink] Error leyendo el usuario local | user=${username} (id=${userId}): ${err.message}`);
    return null;
  }

  const existing = userDoc?.giroxUserId ?? null;
  if (existing) {
    return existing;
  }

  // 2. Campo vacío: backfill al vuelo consultando el jugador en la Partner API.
  logger.info(
    `[GiroxUserLink] giroxUserId faltante para user=${username} (id=${userId}). Intentando backfill al vuelo…`
  );

  let info = null;
  try {
    info = await giroxService.getUserInfoByName(username);
  } catch (err) {
    logger.error(
      `[GiroxUserLink] Error consultando el jugador en 1girox | user=${username}: ${err.message}`
    );
    return null;
  }

  // ⚠️ `getUserInfoByName` devuelve null tanto si el jugador NO EXISTE como si la
  // consulta falló (timeout, 429 tras sus reintentos internos, key rechazada). Para
  // este servicio da igual: en los dos casos no hay ID confiable y no se escribe nada.
  // La próxima vez que se necesite, se vuelve a intentar.
  if (!info) {
    logger.warn(
      `[GiroxUserLink] La Partner API no devolvió el jugador | user=${username} ` +
      '(no existe, o la consulta falló). No se puede completar giroxUserId.'
    );
    return null;
  }

  const resolvedId = Number(info.id);
  if (!Number.isFinite(resolvedId) || resolvedId <= 0) {
    // La API respondió pero sin `id` numérico: puede pasar si la instalación
    // todavía está en una versión anterior a la v1.9. No inventamos nada.
    logger.warn(
      `[GiroxUserLink] La Partner API devolvió el jugador SIN id numérico (${info.id}) | user=${username}`
    );
    return null;
  }

  // 3. Persistir SÓLO si el campo sigue vacío (evita pisar un ID que otra request
  //    concurrente ya haya resuelto).
  try {
    const updateResult = await User.updateOne(
      { id: userId, $or: [{ giroxUserId: null }, { giroxUserId: { $exists: false } }] },
      {
        $set: {
          giroxUserId: resolvedId,
          giroxSyncStatus: 'linked'
        }
      }
    );

    if (updateResult.modifiedCount > 0) {
      logger.info(
        `[GiroxUserLink] giroxUserId completado automáticamente | user=${username} giroxUserId=${resolvedId}`
      );
    } else {
      logger.info(
        `[GiroxUserLink] giroxUserId ya estaba cargado (sin cambios) | user=${username}`
      );
    }
  } catch (saveErr) {
    logger.error(
      `[GiroxUserLink] Error al persistir giroxUserId | user=${username}: ${saveErr.message}`
    );
    // Devolvemos el ID resuelto igual para no bloquear el flujo en curso.
  }

  return resolvedId;
}

module.exports = { resolveGiroxUserId };
