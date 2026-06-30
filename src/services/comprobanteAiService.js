/**
 * comprobanteAiService.js
 *
 * Lee una imagen de comprobante con Claude (vision) y devuelve los datos
 * estructurados: si es un comprobante, monto, N° de operación, CBU/alias origen,
 * banco y fecha. Lo usa el flujo de chat para detectar comprobantes reutilizados.
 *
 * - Modelo por defecto: claude-haiku-4-5 (barato y suficiente para OCR de
 *   comprobantes). Configurable con la env COMPROBANTE_AI_MODEL.
 * - Usa axios directo contra la API de Anthropic (mismo patrón que los clientes
 *   de JUGAYGANA) para no sumar dependencias nuevas.
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

function getApiKey() {
  return process.env.ANTHROPIC_API_KEY || null;
}

function getModel() {
  return process.env.COMPROBANTE_AI_MODEL || 'claude-haiku-4-5';
}

/** true si hay API key configurada (la detección está activa). */
function isEnabled() {
  return !!getApiKey();
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

const PROMPT = [
  'Sos un verificador de comprobantes de pago/transferencia bancaria de Argentina.',
  'Mirá la imagen y decidí si es un COMPROBANTE de pago o transferencia (de un banco,',
  'billetera virtual como Mercado Pago/Ualá/Brubank, o app bancaria). Las capturas de',
  'error de la página, fotos de personas, memes, fotos de pantallas de juego, etc. NO son',
  'comprobantes.',
  '',
  'Si ES un comprobante, extraé estos datos (lo que puedas leer; si algo no está, poné null):',
  '- numero_operacion: el número de operación / comprobante / referencia de la transacción',
  '  (string). MUY IMPORTANTE: NO uses el CBU, CVU, alias, número de cuenta NI el CUIT/CUIL',
  '  (formato XX-XXXXXXXX-X, ej: 30-71876498-6) como número de operación — el CUIT identifica a',
  '  una persona/empresa y se REPITE entre transferencias distintas. Si el comprobante NO muestra',
  '  un número de operación/referencia claro y distinto del CUIT/CBU, poné null.',
  '- monto: el importe transferido, sólo el número sin símbolos ni puntos de miles (number).',
  '- titular_origen: nombre del que envió el dinero (string).',
  '- cbu_origen: CBU/CVU o alias de la cuenta de ORIGEN (string).',
  '- titular_destino: nombre del que RECIBE el dinero (string).',
  '- cbu_destino: CBU/CVU o alias de la cuenta de DESTINO (a quién se le transfirió) (string).',
  '- banco: banco o billetera (string).',
  '- fecha: fecha y hora que figura en el comprobante, tal cual (string).',
  '',
  'Respondé ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown, con',
  'exactamente estas claves:',
  '{"es_comprobante": true|false, "confianza": 0..1, "numero_operacion": string|null,',
  ' "monto": number|null, "titular_origen": string|null, "cbu_origen": string|null,',
  ' "titular_destino": string|null, "cbu_destino": string|null,',
  ' "banco": string|null, "fecha": string|null}'
].join('\n');

// Extrae el primer objeto JSON de un texto (tolera fences ```json ... ``` o texto suelto).
function parseJsonLoose(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim();
  // Quitar fences de markdown si vinieran
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(t); } catch (_) { /* seguir */ }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (_) { /* nada */ }
  }
  return null;
}

/**
 * Analiza el content de un mensaje de imagen.
 * @returns {Promise<object>} { ok, isComprobante, confidence, operationNumber,
 *   amount, originHolder, originCbu, bank, paymentDate, rawText, model } o
 *   { ok:false, error } si no se pudo analizar.
 */
async function analyzeComprobante(content) {
  const apiKey = getApiKey();
  if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY no configurada' };

  const imageBlock = buildImageBlock(content);
  if (!imageBlock) return { ok: false, error: 'Contenido no es una imagen analizable' };

  const model = getModel();
  const body = {
    model,
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: [imageBlock, { type: 'text', text: PROMPT }]
    }]
  };

  try {
    const resp = await axios.post(ANTHROPIC_URL, body, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json'
      },
      timeout: 30000
    });

    // La respuesta trae content: [{type:'text', text:'...'}]
    const blocks = resp.data && resp.data.content;
    const textBlock = Array.isArray(blocks) ? blocks.find(b => b && b.type === 'text') : null;
    const raw = textBlock ? textBlock.text : '';
    const parsed = parseJsonLoose(raw);
    if (!parsed) {
      logger.warn(`[comprobante-ai] respuesta sin JSON parseable: ${String(raw).slice(0, 200)}`);
      return { ok: false, error: 'Respuesta de IA sin JSON válido', rawText: raw };
    }

    const amountNum = (parsed.monto === null || parsed.monto === undefined)
      ? null
      : (Number(String(parsed.monto).replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')) || null);

    return {
      ok: true,
      isComprobante: !!parsed.es_comprobante,
      confidence: typeof parsed.confianza === 'number' ? parsed.confianza : 0,
      operationNumber: parsed.numero_operacion ? String(parsed.numero_operacion).trim() : null,
      amount: amountNum,
      originHolder: parsed.titular_origen ? String(parsed.titular_origen).trim() : null,
      originCbu: parsed.cbu_origen ? String(parsed.cbu_origen).trim() : null,
      destHolder: parsed.titular_destino ? String(parsed.titular_destino).trim() : null,
      destCbu: parsed.cbu_destino ? String(parsed.cbu_destino).trim() : null,
      bank: parsed.banco ? String(parsed.banco).trim() : null,
      paymentDate: parsed.fecha ? String(parsed.fecha).trim() : null,
      rawText: raw,
      model
    };
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data).slice(0, 200)}`
      : err.message;
    logger.error(`[comprobante-ai] error analizando comprobante: ${detail}`);
    return { ok: false, error: detail };
  }
}

module.exports = { isEnabled, analyzeComprobante, getModel };
