/**
 * telegramAlertService.js (WORKLOG #132)
 *
 * Manda alertas a un grupo/canal de Telegram vía Bot API (sendMessage).
 * Pensado para el supervisor de atención: recibe en UN solo grupo las
 * alertas de TODOS los proyectos (cada proyecto se identifica por su dominio).
 *
 * Config (prioridad panel > env):
 *   - panel → 🔐 Config privada → "Alertas Telegram": botToken + chatId
 *     (Config['auditconfig'].telegram, inyectado con applyConfig()).
 *   - env fallback: TELEGRAM_ALERT_BOT_TOKEN + TELEGRAM_ALERT_CHAT_ID.
 *
 * Cómo obtener los datos: crear un bot con @BotFather (te da el token),
 * agregarlo al grupo, escribir algo en el grupo y abrir
 * https://api.telegram.org/bot<TOKEN>/getUpdates → "chat":{"id":-100…}.
 *
 * Fire-and-forget: nunca tira; loguea y sigue. Sin token/chatId → no hace nada.
 */
const axios = require('axios');
const logger = require('../utils/logger');

let _cfg = {};
function applyConfig(cfg) { _cfg = (cfg && typeof cfg === 'object') ? cfg : {}; }

function _token() { return (_cfg.botToken && String(_cfg.botToken).trim()) || process.env.TELEGRAM_ALERT_BOT_TOKEN || null; }
function _chatId() { return (_cfg.chatId && String(_cfg.chatId).trim()) || process.env.TELEGRAM_ALERT_CHAT_ID || null; }

function isEnabled() { return !!(_token() && _chatId()); }

function getEffectiveConfig() {
  const t = _token();
  return {
    enabled: isEnabled(),
    tokenSource: _cfg.botToken ? 'panel' : (process.env.TELEGRAM_ALERT_BOT_TOKEN ? 'env' : 'ninguna'),
    tokenHint: t ? '••••' + String(t).slice(-4) : null,
    chatId: _chatId() || null
  };
}

// Escapa lo mínimo para HTML de Telegram (parse_mode HTML).
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Envía un mensaje (HTML). Devuelve { ok, error }.
 * @param {string} html  texto ya escapado con esc() donde corresponda
 */
async function send(html) {
  const token = _token(), chatId = _chatId();
  if (!token || !chatId) return { ok: false, error: 'telegram no configurado' };
  try {
    const r = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: String(html).slice(0, 4000),
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, { timeout: 15000 });
    if (r.data && r.data.ok) return { ok: true };
    return { ok: false, error: (r.data && r.data.description) || 'respuesta no ok' };
  } catch (e) {
    const detail = e.response ? `HTTP ${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message;
    logger.warn(`[telegram] sendMessage falló: ${detail}`);
    return { ok: false, error: detail };
  }
}

/** Mensaje de prueba desde el panel. */
async function sendTest(projectLabel) {
  return send(`✅ <b>${esc(projectLabel || 'proyecto')}</b> — alertas de auditoría conectadas correctamente.`);
}

module.exports = { applyConfig, isEnabled, getEffectiveConfig, send, sendTest, esc };
