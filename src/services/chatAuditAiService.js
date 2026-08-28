/**
 * chatAuditAiService.js (WORKLOG #132) — Capa 2 de la auditoría de atención.
 *
 * Le da a Claude la transcripción de una conversación (cliente ↔ agentes) y
 * recibe una evaluación ESTRUCTURADA: puntaje 1-10, banderas, resumen, cita
 * problemática, agente responsable, ¿resuelto?, ¿cliente enojado?
 *
 * - Modelo default: claude-sonnet-5 (buena lectura, ~US$0,003-0,006 por chat).
 *   Configurable desde el panel (🔐 Config privada → Auditoría) o env
 *   AUDIT_AI_MODEL. La API key es la misma de comprobantes (ANTHROPIC_API_KEY
 *   o la del panel — se pasa desde server.js vía applyConfig({apiKey})).
 * - Salida estructurada (output_config.format json_schema) → JSON garantizado.
 * - Mismo patrón axios/refusal-fallback que comprobanteAiService.
 */
const axios = require('axios');
const logger = require('../utils/logger');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
const EFFORTS = ['low', 'medium', 'high'];

const AI_FLAGS = ['queja', 'mal_trato', 'sin_solucion', 'cliente_enojado', 'promesa_incumplida', 'error_plata', 'respuesta_pobre', 'demora', 'posible_fraude'];

let _cfg = {};
function applyConfig(cfg) { _cfg = (cfg && typeof cfg === 'object') ? cfg : {}; }
function getApiKey() { return (_cfg.apiKey && String(_cfg.apiKey).trim()) || process.env.ANTHROPIC_API_KEY || null; }
function getModel() { return (_cfg.model && String(_cfg.model).trim()) || process.env.AUDIT_AI_MODEL || DEFAULT_MODEL; }
function getEffort() { return EFFORTS.includes(_cfg.effort) ? _cfg.effort : 'low'; }
function isEnabled() { return _cfg.enabled !== false && !!getApiKey(); }

const SYSTEM = [
  'Sos el supervisor de calidad de atención al cliente de una sala de juegos online argentina.',
  'Los clientes escriben por chat para cargar fichas (mandan comprobantes de transferencia),',
  'pedir retiros, reclamar reembolsos/bonos o consultar. Los agentes (empleados) responden.',
  'Tu trabajo: leer la conversación completa y evaluar CÓMO ATENDIÓ EL AGENTE, con criterio',
  'de un dueño exigente que quiere clientes bien tratados y problemas resueltos.',
  '',
  'Evaluá, en este orden de importancia:',
  '1. TRATO: respeto, cordialidad, sin burlas ni agresividad ni respuestas secas a un reclamo.',
  '2. COMPRENSIÓN: ¿leyó lo que el cliente pidió o respondió otra cosa / en automático?',
  '3. SOLUCIÓN: ¿resolvió o dio una salida clara y honesta ("te cargo en 5 min", "no se puede',
  '   porque X")? Dejar al cliente sin respuesta o con vueltas es grave.',
  '4. PLATA: montos, cargas y pagos coherentes; promesas cumplidas dentro del chat.',
  '5. TIEMPOS: usá las marcas de hora. Esperas largas del cliente sin respuesta son "demora".',
  '',
  'Reglas de puntaje (1-10):',
  '- 9-10: trato excelente, entendió, resolvió rápido.',
  '- 7-8: correcto, sin problemas serios.',
  '- 5-6: flojo (respuestas pobres, demoras, faltó cerrar el tema) pero sin maltrato.',
  '- 3-4: mal: maltrato leve, no resolvió, o dejó al cliente enojado.',
  '- 1-2: muy grave: insultos/burlas del agente, cliente maltratado, error de plata sin corregir.',
  'Si NO hubo ningún mensaje de agente en el tramo, puntaje 2 y bandera sin_solucion + demora.',
  'Si la conversación es trivial y correcta (saludo, carga hecha, gracias), puntaje 8-10 sin banderas.',
  '',
  'Los mensajes [SISTEMA] son automáticos (confirmaciones de carga, bienvenida): no son del',
  'agente, pero cuentan como respuesta al cliente cuando resuelven lo que pidió.',
  'Los mensajes [CLIENTE-AUTOMÁTICO] los genera la app cuando el cliente toca un botón',
  '(reclamo de reembolso, pedido de CBU): el sistema ya los procesó solo y NO requieren',
  'respuesta de ningún agente. NUNCA los cuentes como "sin respuesta" ni como demora.',
  '',
  'REGLAS DEL NEGOCIO (cómo funciona esta sala; si el agente las aplica y las explica, está BIEN):',
  '- RETIROS CON BONO: si el cliente recibió un bono (bono de carga, fueguito, promo, 20%,',
  '  100%, etc.), para poder retirar tiene que cumplir una condición de juego (rollover:',
  '  "duplicar"/"triplicar" la carga o el bono, llegar a cierto saldo). Que el agente le',
  '  diga que NO puede retirar todavía y le explique la condición es la atención CORRECTA:',
  '  NO es sin_solucion, NO es error_plata, NO es promesa_incumplida. Solo marcá problema',
  '  si el agente NO explicó la condición, la explicó mal/contradictoriamente, o trató mal',
  '  al cliente. Que el cliente no esté contento con la regla no es culpa del agente.',
  '- Los RETIROS y las CARGAS los ejecutan sistemas fuera del chat (banco automático,',
  '  confirmación del agente en otro panel). Que en la conversación NO aparezca la',
  '  confirmación de pago o de carga NO significa que no se hizo: NO lo marques como',
  '  sin_solucion ni como demora por sí solo. Solo es problema si el cliente vuelve a',
  '  reclamar que no le llegó y nadie le responde.',
  '- El mensaje "Recibimos tu solicitud de retiro… un agente la está procesando" es la',
  '  respuesta correcta a un pedido de retiro; el pago puede tardar y se hace por fuera.',
  '- Los mensajes de sistema que confirman cargas/bonos/reembolsos SON la solución.',
  '- LÍMITE DE 30 MINUTOS PARA VALIDAR COMPROBANTES (política antifraude del dueño): un',
  '  comprobante de transferencia solo se valida si el cliente lo manda dentro de los 30',
  '  minutos de hecha la transferencia. Pasado ese tiempo NO se carga, aunque la plata haya',
  '  entrado: es imposible verificar que ese mismo pago no fue reclamado y acreditado antes',
  '  por otra persona (método de estafa: A cobra al instante y B reclama el mismo pago 45',
  '  min después). La respuesta correcta del agente es del estilo "No podremos validar ya',
  '  que excedió el tiempo límite de validación; contacte con su banco y solicite la',
  '  reversión". Aplicar esa regla y repetirla las veces que haga falta es atención CORRECTA:',
  '  NO es error_plata, NO es sin_solucion, NO es "no investigó", aunque el cliente se enoje',
  '  o acuse de estafa. Solo marcá problema si el agente fue grosero, si dio información',
  '  contradictoria, o si en la conversación se ve claramente que el comprobante SÍ fue',
  '  enviado dentro de los 30 minutos y aun así se lo rechazaron.',
  '',
  'CUÁNDO ALGO NO ES "SIN SOLUCIÓN" NI "RESPUESTA POBRE" (criterios del dueño):',
  '- LA PELOTA DEL LADO DEL CLIENTE: si el ÚLTIMO mensaje relevante es del AGENTE (pidió una',
  '  captura, preguntó qué pasó, dio una indicación, ofreció ayuda) y el cliente NO volvió a',
  '  escribir, se asume que el cliente resolvió o se fue: es normal y NO es culpa del agente.',
  '  Lo que importa es la INTENCIÓN de ayudar de nuestro lado. Solo es sin_solucion si el',
  '  último mensaje pendiente es del CLIENTE (pregunta o reclamo claro) y nadie le respondió,',
  '  o si el agente ignoró/rechazó el problema sin dar salida.',
  '- MENSAJES SIN CONTEXTO: si el cliente escribe algo ambiguo o sin contexto ("Disculpe?",',
  '  "Hola", "?", "che"), un "Hola, ¿en qué te puedo ayudar?" / "¿pasó algo?" es la respuesta',
  '  CORRECTA en CONTENIDO (no hay otra posible): no es respuesta_pobre ni falta de seguimiento.',
  '- LA DEMORA SE JUZGA APARTE, SIEMPRE: que la respuesta haya sido correcta NO borra una',
  '  espera. Si el cliente esperó demasiado (mirá las horas), marcá "demora" y bajá el puntaje',
  '  igual, sin importar qué se respondió después. La demora no se justifica con nada.',
  '- "No puedo entrar" / "sigo sin poder entrar": si el agente reseteó la clave o pidió una',
  '  captura y el cliente no contestó más, se asume que pudo entrar (si no, vuelve a',
  '  escribir). No marques sin_solucion por eso.',
  '- La falta de un "cierre" formal del chat ("¿algo más?", "listo") NO es un problema.',
  'Los insultos del CLIENTE no bajan el puntaje del agente por sí solos; lo que importa es cómo',
  'reaccionó el agente. Marcá posible_fraude si el cliente intenta engañar (comprobante ajeno,',
  'reclamo falso), sin bajar el puntaje del agente por eso.',
  '',
  'Respondé en español rioplatense, breve y concreto. El resumen (máx. 2 oraciones) tiene que',
  'servirle a un supervisor apurado para decidir si abre el chat o no.'
].join('\n');

const nullable = (t) => ({ anyOf: [{ type: t }, { type: 'null' }] });
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    puntaje: { type: 'integer' },
    banderas: { type: 'array', items: { type: 'string', enum: AI_FLAGS } },
    resumen: { type: 'string' },
    cita_problema: nullable('string'),
    agente_responsable: nullable('string'),
    resuelto: { type: 'boolean' },
    cliente_enojado: { type: 'boolean' }
  },
  required: ['puntaje', 'banderas', 'resumen', 'cita_problema', 'agente_responsable', 'resuelto', 'cliente_enojado'],
  additionalProperties: false
};

function parseJsonLoose(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(t); } catch (_) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) {} }
  return null;
}

async function _post(body, withFallback) {
  const headers = { 'x-api-key': getApiKey(), 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' };
  const b = Object.assign({}, body);
  if (withFallback) { headers['anthropic-beta'] = FALLBACK_BETA; b.fallbacks = 'default'; }
  return axios.post(ANTHROPIC_URL, b, { headers, timeout: 120000 });
}

/**
 * Formatea la transcripción. `messages` ordenados por fecha, sin adminOnly.
 * Cada línea: [HH:MM] ROL(nombre): texto. Imágenes → [imagen].
 */
function formatTranscript(messages, username) {
  const fmt = (d) => new Date(d).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
  const day = (d) => new Date(d).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
  const lines = [];
  let lastDay = '';
  for (const m of messages) {
    const dd = day(m.timestamp);
    if (dd !== lastDay) { lines.push(`--- ${dd} ---`); lastDay = dd; }
    let who;
    if (m.type === 'system' || m.senderUsername === 'Sistema') who = '[SISTEMA]';
    else if (m.senderRole === 'user' && m._auto) who = '[CLIENTE-AUTOMÁTICO]';
    else if (m.senderRole === 'user') who = `CLIENTE(${username})`;
    else who = `AGENTE(${m.senderUsername || m.senderRole})`;
    let text = m.type === 'image' ? '[imagen/comprobante]' : m.type === 'video' ? '[video]' : String(m.content || '');
    if (text.length > 600) text = text.slice(0, 600) + '…';
    lines.push(`[${fmt(m.timestamp)}] ${who}: ${text.replace(/\s+/g, ' ')}`);
  }
  return lines.join('\n');
}

/**
 * Audita una transcripción. Devuelve { ok, score, flags, summary, quote,
 * responsibleAgent, resolved, customerAngry, model } o { ok:false, error }.
 */
async function auditTranscript({ transcript, username, agents, hint }) {
  if (!getApiKey()) return { ok: false, error: 'ANTHROPIC_API_KEY no configurada' };
  const model = getModel();
  const userText = [
    `Cliente: ${username}. Agentes que participaron: ${agents && agents.length ? agents.join(', ') : 'ninguno'}.`,
    hint ? `CONTEXTO ESPECIAL: ${hint}` : '',
    'Conversación (hora argentina):',
    '<<<',
    transcript.slice(0, 60000),
    '>>>',
    'Evaluá la atención del/los agente(s) y completá el JSON.'
  ].filter(Boolean).join('\n');
  const body = {
    model,
    max_tokens: 2048,
    output_config: { effort: getEffort(), format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    // Bloque 1 estable (cacheable). Bloque 2 = reglas del negocio que el owner escribe
    // en el panel (🔐 Config privada → Auditoría → "Reglas del negocio"): van DESPUÉS
    // del breakpoint de cache y con prioridad explícita sobre lo anterior.
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }]
      .concat(_cfg.systemFacts && String(_cfg.systemFacts).trim()
        ? [{ type: 'text', text: 'ASÍ FUNCIONA ESTA SALA HOY (datos reales de la configuración; son hechos, no opiniones):\n' + String(_cfg.systemFacts).trim().slice(0, 6000) }]
        : [])
      .concat(_cfg.learnedDoc && String(_cfg.learnedDoc).trim()
        ? [{ type: 'text', text: 'CONTEXTO DEL NEGOCIO aprendido de chats bien evaluados (describe cómo ES la operación —flujos, preguntas típicas, respuestas habituales que funcionan, tiempos normales—; usalo para entender la conversación, NO como reglas de juicio):\n' + String(_cfg.learnedDoc).trim().slice(0, 8000) }]
        : [])
      .concat(_cfg.extraRules && String(_cfg.extraRules).trim()
        ? [{ type: 'text', text: 'REGLAS ADICIONALES DEL DUEÑO (tienen PRIORIDAD sobre todo lo anterior; aplicalas al pie de la letra):\n' + String(_cfg.extraRules).trim().slice(0, 8000) }]
        : []),
    messages: [{ role: 'user', content: userText }]
  };
  try {
    let resp;
    try { resp = await _post(body, true); }
    catch (err) {
      if (err.response && err.response.status === 400) {
        logger.warn(`[audit-ai] 400 con fallback beta (${JSON.stringify(err.response.data).slice(0, 160)}) — reintento sin fallback`);
        resp = await _post(body, false);
      } else throw err;
    }
    const data = resp.data || {};
    if (data.stop_reason === 'refusal') return { ok: false, error: 'La IA declinó evaluar la conversación' };
    const blocks = Array.isArray(data.content) ? data.content : [];
    const tb = blocks.find(b => b && b.type === 'text');
    const parsed = parseJsonLoose(tb ? tb.text : '');
    if (!parsed) return { ok: false, error: 'Respuesta de IA sin JSON válido' };
    let score = parseInt(parsed.puntaje, 10);
    if (!(score >= 1 && score <= 10)) score = 5;
    const flags = Array.isArray(parsed.banderas) ? parsed.banderas.filter(f => AI_FLAGS.includes(f)) : [];
    if (parsed.cliente_enojado && !flags.includes('cliente_enojado')) flags.push('cliente_enojado');
    if (parsed.resuelto === false && !flags.includes('sin_solucion') && score <= 6) flags.push('sin_solucion');
    return {
      ok: true, score, flags,
      summary: String(parsed.resumen || '').slice(0, 600),
      quote: parsed.cita_problema ? String(parsed.cita_problema).slice(0, 300) : '',
      responsibleAgent: parsed.agente_responsable ? String(parsed.agente_responsable).slice(0, 60) : null,
      resolved: !!parsed.resuelto,
      customerAngry: !!parsed.cliente_enojado,
      model: data.model || model,
      usage: data.usage || null
    };
  } catch (err) {
    const detail = err.response ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data).slice(0, 200)}` : err.message;
    logger.error(`[audit-ai] error: ${detail}`);
    return { ok: false, error: detail };
  }
}

// ── Destilador de reglas (#145): convierte "reporte de la IA + corrección del dueño"
// en UNA regla general y la integra en la base existente sin duplicar ni degradarla.
const DISTILL_SYSTEM = [
  'Sos el EDITOR de la base de reglas con la que un supervisor de calidad (otra IA) evalúa',
  'chats de atención al cliente de una sala de juegos argentina. El dueño te trae: (a) un',
  'reporte que esa IA emitió sobre un chat, y (b) su corrección en lenguaje coloquial de por',
  'qué el reporte está mal o qué criterio faltaba. Tu trabajo: convertir eso en UNA regla',
  'GENERAL, clara y corta, y decidir cómo integrarla en la base actual.',
  '',
  'Cómo tiene que ser la regla:',
  '- General: describe la SITUACIÓN y el criterio ("Cuando X, lo correcto es Y / NO es Z").',
  '  NUNCA nombres de clientes ni de agentes, ni puntajes, ni fechas, ni "en este caso".',
  '- Una sola idea por regla, 1-3 oraciones, en español rioplatense, tono de instrucción.',
  '- Concreta: qué banderas NO corresponden y qué SÍ sería un problema en esa situación.',
  '- Si la corrección del dueño trae una regla de negocio (tiempos, condiciones, políticas),',
  '  incluí el dato exacto (ej. "30 minutos", "duplicar la carga").',
  '',
  'Cómo integrarla:',
  '- Si la base actual NO tiene nada equivalente → accion "agregar".',
  '- Si hay una regla que trata la MISMA situación → accion "reemplazar" con una versión',
  '  mejorada que combine ambas (indicá el índice 1-based de la regla a reemplazar).',
  '- Si la base ya cubre exactamente esto → accion "sin_cambio" y explicá por qué.',
  '- No toques reglas que no tengan que ver. No inventes reglas que el dueño no pidió.',
  '',
  '',
  'TIPO: "regla" si es un criterio de cómo JUZGAR la atención o una política del negocio',
  '(qué está bien/mal, condiciones, límites). "contexto" si el dueño solo está explicando',
  'cómo ES la operación (un flujo, qué significa algo, qué es normal) sin decir cómo juzgar:',
  'en ese caso "regla" lleva la descripción en 1-2 oraciones y "accion" = "agregar".',
  '',
  'Devolvé también una explicación de 1 oración para el dueño de qué entendiste.'
].join('\n');

const DISTILL_SCHEMA = {
  type: 'object',
  properties: {
    accion: { type: 'string', enum: ['agregar', 'reemplazar', 'sin_cambio'] },
    tipo: { type: 'string', enum: ['regla', 'contexto'] },
    regla: nullable('string'),
    indice_a_reemplazar: nullable('integer'),
    explicacion: { type: 'string' }
  },
  required: ['accion', 'tipo', 'regla', 'indice_a_reemplazar', 'explicacion'],
  additionalProperties: false
};

/** Base de reglas → lista (una por línea que empiece con "- "). */
function parseRules(text) {
  return String(text || '').split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => l.replace(/^[-•*]\s*/, '').replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean);
}
function joinRules(list) { return list.map(r => '- ' + r).join('\n'); }

/**
 * @returns {Promise<{ok, accion, regla, indice, explicacion, nuevasReglas:string[], model} | {ok:false,error}>}
 */
async function distillRule({ report, correction, currentRules }) {
  if (!getApiKey()) return { ok: false, error: 'ANTHROPIC_API_KEY no configurada' };
  const rules = parseRules(currentRules);
  const userText = [
    'BASE DE REGLAS ACTUAL:',
    rules.length ? rules.map((r, i) => `${i + 1}. ${r}`).join('\n') : '(vacía)',
    '',
    'REPORTE QUE EMITIÓ LA IA SUPERVISORA:',
    '<<<', String(report || '').slice(0, 4000), '>>>',
    '',
    'CORRECCIÓN DEL DUEÑO:',
    '<<<', String(correction || '').slice(0, 4000), '>>>',
    '',
    'Generá la regla y la acción, y completá el JSON.'
  ].join('\n');
  const body = {
    model: getModel(),
    max_tokens: 2048,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: DISTILL_SCHEMA } },
    system: [{ type: 'text', text: DISTILL_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userText }]
  };
  try {
    let resp;
    try { resp = await _post(body, true); }
    catch (err) { if (err.response && err.response.status === 400) resp = await _post(body, false); else throw err; }
    const data = resp.data || {};
    if (data.stop_reason === 'refusal') return { ok: false, error: 'La IA declinó procesar la corrección' };
    const tb = (Array.isArray(data.content) ? data.content : []).find(b => b && b.type === 'text');
    const parsed = parseJsonLoose(tb ? tb.text : '');
    if (!parsed) return { ok: false, error: 'Respuesta de IA sin JSON válido' };
    const accion = ['agregar', 'reemplazar', 'sin_cambio'].includes(parsed.accion) ? parsed.accion : 'agregar';
    const regla = parsed.regla ? String(parsed.regla).trim().replace(/\s+/g, ' ') : null;
    let indice = Number.isInteger(parsed.indice_a_reemplazar) ? parsed.indice_a_reemplazar : null;
    const next = rules.slice();
    if (accion === 'agregar' && regla) next.push(regla);
    else if (accion === 'reemplazar' && regla) {
      if (indice && indice >= 1 && indice <= next.length) next[indice - 1] = regla;
      else { next.push(regla); indice = null; }
    }
    return { ok: true, accion, tipo: parsed.tipo === 'contexto' ? 'contexto' : 'regla', regla, indice, explicacion: String(parsed.explicacion || '').slice(0, 500), nuevasReglas: next, model: data.model || getModel() };
  } catch (err) {
    const detail = err.response ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data).slice(0, 200)}` : err.message;
    logger.error(`[audit-ai] distillRule: ${detail}`);
    return { ok: false, error: detail };
  }
}

// ── Aprendizaje diario (#146): lee chats BIEN evaluados y propone contexto descriptivo
// o hace preguntas. Nunca escribe reglas de juicio por su cuenta.
const LEARN_SYSTEM = [
  'Sos el analista que arma la "base de conocimiento" de una sala de juegos online argentina',
  'para que otra IA (supervisora de calidad) entienda el negocio al leer chats. Te doy: los',
  'HECHOS del sistema, el CONTEXTO ya aprendido, las REGLAS del dueño y una muestra de chats',
  'que fueron BIEN evaluados (puntaje alto). Tu trabajo es DESCRIBIR cómo es la operación, no',
  'juzgarla: flujos típicos (qué pasa después de cada paso), preguntas frecuentes de los',
  'clientes y cómo las resuelven bien los agentes, tiempos normales, vocabulario, qué resuelve',
  'el sistema solo y qué necesita agente.',
  '',
  'Reglas estrictas:',
  '- Proponé SOLO cosas NUEVAS que no estén ya en el contexto aprendido ni en los hechos.',
  '- Cada propuesta: 1-2 oraciones, general (sin nombres de clientes/agentes, sin montos de',
  '  un caso puntual), descriptiva ("Cuando el cliente manda un comprobante, el sistema lo',
  '  verifica y acredita solo; el agente solo interviene si…").',
  '- NUNCA propongas criterios de juicio ni políticas (qué está bien/mal, condiciones para',
  '  retirar, límites, antifraude): eso lo define el dueño. Si ves algo que PARECE una regla',
  '  o una práctica que no sabés si es correcta o normal (ej. "piden DNI para retiros',
  '  grandes", "cobran comisión en X"), hacé una PREGUNTA corta al dueño en "dudas" en vez',
  '  de asumir. Preguntar antes que aprender mal.',
  '- Máximo 6 propuestas y 4 dudas por análisis. Si no hay nada nuevo, hay_novedades=false',
  '  y listas vacías: es una respuesta válida y esperable cuando la base ya está completa.',
  '- Español rioplatense, concreto.'
].join('\n');
const LEARN_SCHEMA = {
  type: 'object',
  properties: {
    hay_novedades: { type: 'boolean' },
    resumen: { type: 'string' },
    propuestas: { type: 'array', items: { type: 'object', properties: { texto: { type: 'string' }, motivo: { type: 'string' } }, required: ['texto', 'motivo'], additionalProperties: false } },
    dudas: { type: 'array', items: { type: 'object', properties: { pregunta: { type: 'string' }, contexto: { type: 'string' } }, required: ['pregunta', 'contexto'], additionalProperties: false } }
  },
  required: ['hay_novedades', 'resumen', 'propuestas', 'dudas'],
  additionalProperties: false
};
async function learnFromChats({ samples, learnedDoc, rules, systemFacts }) {
  if (!getApiKey()) return { ok: false, error: 'ANTHROPIC_API_KEY no configurada' };
  const userText = [
    'HECHOS DEL SISTEMA:', String(systemFacts || '(sin datos)').slice(0, 6000), '',
    'CONTEXTO YA APRENDIDO:', String(learnedDoc || '(vacío)').slice(0, 8000), '',
    'REGLAS DEL DUEÑO (no las repitas ni las cuestiones; son para tu referencia):', String(rules || '(ninguna)').slice(0, 6000), '',
    `MUESTRA DE ${samples.length} CHATS BIEN EVALUADOS:`,
    ...samples.map((sm, i) => `--- CHAT ${i + 1} (puntaje ${sm.score}/10, cliente ${sm.username}) ---\n${String(sm.transcript || '').slice(0, 5000)}`),
    '', 'Analizá y completá el JSON.'
  ].join('\n');
  const body = {
    model: getModel(),
    max_tokens: 4096,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: LEARN_SCHEMA } },
    system: [{ type: 'text', text: LEARN_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userText.slice(0, 150000) }]
  };
  try {
    let resp;
    try { resp = await _post(body, true); }
    catch (err) { if (err.response && err.response.status === 400) resp = await _post(body, false); else throw err; }
    const data = resp.data || {};
    if (data.stop_reason === 'refusal') return { ok: false, error: 'La IA declinó el análisis' };
    const tb = (Array.isArray(data.content) ? data.content : []).find(b => b && b.type === 'text');
    const parsed = parseJsonLoose(tb ? tb.text : '');
    if (!parsed) return { ok: false, error: 'Respuesta de IA sin JSON válido' };
    const clean = (t) => String(t || '').trim().replace(/\s+/g, ' ').slice(0, 600);
    return {
      ok: true,
      hasNews: !!parsed.hay_novedades,
      summary: clean(parsed.resumen),
      proposals: (Array.isArray(parsed.propuestas) ? parsed.propuestas : []).slice(0, 6).map(p => ({ text: clean(p.texto), why: clean(p.motivo) })).filter(p => p.text),
      questions: (Array.isArray(parsed.dudas) ? parsed.dudas : []).slice(0, 4).map(q => ({ question: clean(q.pregunta), context: clean(q.contexto) })).filter(q => q.question),
      model: data.model || getModel(), usage: data.usage || null
    };
  } catch (err) {
    const detail = err.response ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data).slice(0, 200)}` : err.message;
    logger.error(`[audit-ai] learnFromChats: ${detail}`);
    return { ok: false, error: detail };
  }
}

module.exports = { applyConfig, isEnabled, getModel, getEffort, auditTranscript, formatTranscript, distillRule, learnFromChats, parseRules, joinRules, DEFAULT_MODEL, EFFORTS, AI_FLAGS };
