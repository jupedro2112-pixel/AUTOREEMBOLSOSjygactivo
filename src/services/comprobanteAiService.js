/**
 * comprobanteAiService.js
 *
 * Lee una imagen de comprobante con Claude (vision) y devuelve los datos
 * estructurados: si es un comprobante, monto, N° de operación, CBU/alias origen,
 * banco y fecha. Lo usa el flujo de chat para detectar comprobantes reutilizados
 * y la auto-carga hgcash (matcheo contra el movimiento bancario).
 *
 * - Modelo por defecto: claude-opus-5 (desde 2026-08-27, WORKLOG #126; antes
 *   claude-haiku-4-5, que confundía CBU/CUIT con N° de operación y leía mal
 *   montos). Configurable con la env COMPROBANTE_AI_MODEL (ej. claude-sonnet-5
 *   si se quiere abaratar).
 * - Usa axios directo contra la API de Anthropic (mismo patrón que los clientes
 *   de JUGAYGANA) para no sumar dependencias nuevas.
 * - Salida ESTRUCTURADA (output_config.format = json_schema): la API garantiza
 *   un JSON válido con exactamente las claves pedidas — se acabó el "respuesta
 *   sin JSON parseable". parseJsonLoose queda como red de seguridad.
 * - Refusal fallback (beta server-side-fallback): si el modelo declinara la
 *   imagen, la API la reintenta sola en otro modelo. Si la org no tuviera la
 *   beta (HTTP 400), se reintenta UNA vez sin ella.
 * - Si NO está la ANTHROPIC_API_KEY (en process.env, cargada desde SSM en el
 *   bootstrap), isEnabled() devuelve false y el flujo de chat no hace nada
 *   (queda "dormido" sin romper).
 *
 * La key se lee en cada llamada (lazy), NO al require, porque los secrets se
 * cargan desde AWS SSM DESPUÉS del require (igual que JWT_SECRET).
 */
const axios = require('axios');
const logger = require('../utils/logger');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const DEFAULT_MODEL = 'claude-opus-5';
const EFFORTS = ['low', 'medium', 'high'];

// Config en runtime desde el panel (sección "Config privada", WORKLOG #128).
// server.js la carga de Config['aiconfig'] al arrancar, cada 60 s y al guardar,
// y la inyecta con applyConfig(). Prioridad: panel > env/SSM > default.
let _cfg = {};
function applyConfig(cfg) {
  _cfg = (cfg && typeof cfg === 'object') ? cfg : {};
}

function getApiKey() {
  return (_cfg.apiKey && String(_cfg.apiKey).trim()) || process.env.ANTHROPIC_API_KEY || null;
}

function getModel() {
  return (_cfg.model && String(_cfg.model).trim()) || process.env.COMPROBANTE_AI_MODEL || DEFAULT_MODEL;
}

function getEffort() {
  return EFFORTS.includes(_cfg.effort) ? _cfg.effort : 'medium';
}

/** true si hay API key configurada y el panel no la apagó (la detección está activa). */
function isEnabled() {
  if (_cfg.enabled === false) return false;
  return !!getApiKey();
}

/** Resumen para el panel (sin exponer la key completa). */
function getEffectiveConfig() {
  const key = getApiKey();
  return {
    enabled: isEnabled(),
    model: getModel(),
    effort: getEffort(),
    apiKeySource: _cfg.apiKey ? 'panel' : (process.env.ANTHROPIC_API_KEY ? 'env' : 'ninguna'),
    apiKeyHint: key ? '••••' + String(key).slice(-4) : null,
    modelSource: _cfg.model ? 'panel' : (process.env.COMPROBANTE_AI_MODEL ? 'env' : 'default'),
    defaultModel: DEFAULT_MODEL,
    extraRules: _cfg.extraRules || ''
  };
}

// Construye el bloque de imagen para la API a partir del content del mensaje,
// que puede ser un data: URL (base64 inline) o un https:// URL (S3).
function buildImageBlock(content) {
  if (typeof content !== 'string' || !content) return null;
  if (content.startsWith('data:')) {
    const m = content.match(/^data:([\w\/+.-]+);base64,(.*)$/s);
    if (!m) return null;
    const mediaType = m[1];
    const data = m[2];
    // Sólo imágenes (no videos) — la API de visión no procesa video.
    if (!/^image\//.test(mediaType)) return null;
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  }
  if (/^https:\/\//i.test(content)) {
    return { type: 'image', source: { type: 'url', url: content } };
  }
  return null;
}

// Rol + reglas de lectura. Va en `system` (estable → cacheable por prefijo).
const SYSTEM = [
  'Sos un verificador experto de comprobantes de pago/transferencia de Argentina (bancos,',
  'Mercado Pago, Ualá, Brubank, Naranja X, Personal Pay, Cuenta DNI, Lemon, Prex, etc.).',
  'Tu lectura se usa para detectar comprobantes reutilizados y para acreditar cargas',
  'automáticas, así que cada campo tiene que salir EXACTAMENTE como está impreso o null.',
  'Nunca inventes ni completes un dato que no se lea con claridad: null es mejor que un',
  'valor dudoso.',
  '',
  'CÓMO DISTINGUIR LOS NÚMEROS (esto es lo más importante):',
  '- CBU/CVU: SIEMPRE 22 dígitos seguidos (a veces separados en 2 bloques). NUNCA es el',
  '  número de operación.',
  '- CUIT/CUIL: 11 dígitos, formato XX-XXXXXXXX-X (ej. 30-71876498-6). Identifica a una',
  '  persona/empresa y se repite en muchas transferencias. NUNCA es el número de operación.',
  '- Alias: palabras separadas por puntos (ej. "campeon.13.mp"). NUNCA es el número de operación.',
  '- Número de cuenta / N° de tarjeta / N° de cliente: identifican una cuenta, NO una operación.',
  '- NÚMERO DE OPERACIÓN: identifica ESA transferencia puntual. Aparece con etiquetas como',
  '  "Número de operación", "N° de operación", "Nro. de comprobante", "N° de transacción",',
  '  "ID de transacción", "Referencia", "Código de operación", "N° de control", "Código de',
  '  transferencia", "Identificador". Suele tener entre 6 y 20 caracteres, puede mezclar letras',
  '  y números. Si el único número "de referencia" que ves es un CBU, CUIT o alias, o no hay',
  '  etiqueta clara, devolvé null (NO reemplaces con otro número).',
  '',
  'ORIGEN vs DESTINO: el ORIGEN es quien ENVÍA/PAGA ("De:", "Cuenta origen", "Desde",',
  '"Pagador", "Ordenante"); el DESTINO es quien RECIBE ("Para:", "Destinatario",',
  '"Beneficiario", "A:", "Cuenta destino"). No los intercambies. En comprobantes de',
  'Mercado Pago/Ualá el que envía suele figurar arriba y el destinatario abajo.',
  '',
  'MONTO: el importe transferido como número (12500.50), sin símbolo, sin puntos de miles;',
  'la coma decimal argentina pasa a punto. Si hay varios importes (comisión, total), usá',
  'el importe transferido al destinatario.',
  '',
  'FECHA y HORA: tal cual están impresas, en campos separados ("fecha": "27/08/2026",',
  '"hora": "14:32:10"). Si la hora no aparece, hora = null.',
  '',
  'NO son comprobantes: capturas de errores, fotos de personas, memes, pantallas de juego,',
  'saldos de cuenta, listados de movimientos sin una transferencia puntual, fotos borrosas',
  'donde no se distingue una transferencia. En esos casos es_comprobante = false.'
].join('\n');

const USER_TEXT = [
  'Analizá esta imagen y completá el JSON con los datos del comprobante.',
  'Campos:',
  '- es_comprobante: true si es un comprobante de pago/transferencia puntual.',
  '- confianza: 0..1 de que la lectura general es correcta.',
  '- numero_operacion: el número de operación según las reglas (o null).',
  '- numero_operacion_etiqueta: el texto EXACTO de la etiqueta que acompaña a ese número en',
  '  la imagen (ej. "Número de operación", "Referencia", "ID de transacción"); null si no hay.',
  '- monto: número, o null.',
  '- titular_origen: nombre de quien ENVÍA el dinero, o null.',
  '- cbu_origen: CBU/CVU o alias de la cuenta ORIGEN, o null.',
  '- titular_destino: nombre de quien RECIBE el dinero, o null.',
  '- cbu_destino: CBU/CVU o alias de la cuenta DESTINO, o null.',
  '- banco: banco o billetera desde la que se hizo el envío, o null.',
  '- fecha: fecha impresa, o null.',
  '- hora: hora impresa, o null.'
].join('\n');

const nullable = (t) => ({ anyOf: [{ type: t }, { type: 'null' }] });
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    es_comprobante: { type: 'boolean' },
    confianza: { type: 'number' },
    numero_operacion: nullable('string'),
    numero_operacion_etiqueta: nullable('string'),
    monto: nullable('number'),
    titular_origen: nullable('string'),
    cbu_origen: nullable('string'),
    titular_destino: nullable('string'),
    cbu_destino: nullable('string'),
    banco: nullable('string'),
    fecha: nullable('string'),
    hora: nullable('string')
  },
  required: ['es_comprobante', 'confianza', 'numero_operacion', 'numero_operacion_etiqueta',
    'monto', 'titular_origen', 'cbu_origen', 'titular_destino', 'cbu_destino', 'banco', 'fecha', 'hora'],
  additionalProperties: false
};

// Extrae el primer objeto JSON de un texto (tolera fences ```json ... ``` o texto suelto).
// Con salida estructurada casi nunca hace falta; queda como red de seguridad.
function parseJsonLoose(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(t); } catch (_) { /* seguir */ }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (_) { /* nada */ }
  }
  return null;
}

function _str(v) { return (v === null || v === undefined || v === '') ? null : String(v).trim() || null; }

// Monto: acepta number o string con formato argentino ("12.500,50") por si el modelo
// devolviera texto en un fallback.
function _parseAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) && v > 0 ? v : null;
  const n = Number(String(v).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? n : null;
}

async function _post(body, { withFallback }) {
  const headers = {
    'x-api-key': getApiKey(),
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json'
  };
  const b = Object.assign({}, body);
  if (withFallback) {
    headers['anthropic-beta'] = FALLBACK_BETA;
    b.fallbacks = 'default';
  }
  return axios.post(ANTHROPIC_URL, b, { headers, timeout: 90000 });
}

/**
 * Analiza el content de un mensaje de imagen.
 * @returns {Promise<object>} { ok, isComprobante, confidence, operationNumber,
 *   operationLabel, amount, originHolder, originCbu, destHolder, destCbu, bank,
 *   paymentDate, paymentTime, rawText, model } o { ok:false, error } si no se pudo analizar.
 */
async function analyzeComprobante(content) {
  const apiKey = getApiKey();
  if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY no configurada' };

  const imageBlock = buildImageBlock(content);
  if (!imageBlock) return { ok: false, error: 'Contenido no es una imagen analizable' };

  const model = getModel();
  const body = {
    model,
    // Con thinking adaptativo (default en Opus 5) los tokens de razonamiento
    // cuentan contra max_tokens → dejar aire; la salida útil son ~150 tokens.
    max_tokens: 4096,
    output_config: {
      effort: getEffort(),
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA }
    },
    // Bloque 1 estable (cacheable); bloque 2 = reglas extra editables desde el
    // panel (van DESPUÉS del breakpoint de cache para no invalidarlo).
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }]
      .concat(_cfg.extraRules && String(_cfg.extraRules).trim()
        ? [{ type: 'text', text: 'REGLAS ADICIONALES DEL OPERADOR (prioritarias):\n' + String(_cfg.extraRules).trim().slice(0, 4000) }]
        : []),
    messages: [{
      role: 'user',
      content: [imageBlock, { type: 'text', text: USER_TEXT }]
    }]
  };

  try {
    let resp;
    try {
      resp = await _post(body, { withFallback: true });
    } catch (err) {
      // 400 = la org no tiene la beta de fallback (o el modelo no la acepta):
      // reintentar sin ella. Cualquier otro error sube al catch de afuera.
      if (err.response && err.response.status === 400) {
        logger.warn(`[comprobante-ai] 400 con fallback beta (${JSON.stringify(err.response.data).slice(0, 160)}) — reintento sin fallback`);
        resp = await _post(body, { withFallback: false });
      } else {
        throw err;
      }
    }

    const data = resp.data || {};
    if (data.stop_reason === 'refusal') {
      const why = data.stop_details && data.stop_details.explanation;
      return { ok: false, error: `La IA declinó analizar la imagen${why ? ': ' + String(why).slice(0, 120) : ''}` };
    }
    if (data.stop_reason === 'max_tokens') {
      logger.warn('[comprobante-ai] respuesta cortada por max_tokens');
    }

    // La respuesta trae content: [{type:'text', text:'...'}] (+ bloques thinking vacíos).
    const blocks = Array.isArray(data.content) ? data.content : [];
    const textBlock = blocks.find(b => b && b.type === 'text');
    const raw = textBlock ? textBlock.text : '';
    const parsed = parseJsonLoose(raw);
    if (!parsed) {
      logger.warn(`[comprobante-ai] respuesta sin JSON parseable: ${String(raw).slice(0, 200)}`);
      return { ok: false, error: 'Respuesta de IA sin JSON válido', rawText: raw };
    }

    return {
      ok: true,
      isComprobante: !!parsed.es_comprobante,
      confidence: typeof parsed.confianza === 'number' ? parsed.confianza : 0,
      operationNumber: _str(parsed.numero_operacion),
      operationLabel: _str(parsed.numero_operacion_etiqueta),
      amount: _parseAmount(parsed.monto),
      originHolder: _str(parsed.titular_origen),
      originCbu: _str(parsed.cbu_origen),
      destHolder: _str(parsed.titular_destino),
      destCbu: _str(parsed.cbu_destino),
      bank: _str(parsed.banco),
      paymentDate: _str(parsed.fecha),
      paymentTime: _str(parsed.hora),
      rawText: raw,
      model: data.model || model
    };
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data).slice(0, 200)}`
      : err.message;
    logger.error(`[comprobante-ai] error analizando comprobante: ${detail}`);
    return { ok: false, error: detail };
  }
}

module.exports = { isEnabled, analyzeComprobante, getModel, getEffort, applyConfig, getEffectiveConfig, DEFAULT_MODEL, EFFORTS };
