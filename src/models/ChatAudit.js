/**
 * Modelo de Auditoría de Chat (WORKLOG #132)
 *
 * Registro PERMANENTE (los Message se borran a los 3 días; esto no) de cada
 * revisión de una conversación:
 *  - source 'ai'    → la IA leyó la conversación completa (o el tramo desde la
 *                     auditoría anterior) y devolvió puntaje 1-10 + banderas + resumen.
 *  - source 'rules' → una regla sin IA detectó algo en vivo (insulto/queja del
 *                     cliente, mensaje repetido, chat sin respuesta, cerrado sin
 *                     responder). Sin puntaje.
 *
 * `agents` = usernames de los agentes que atendieron en el tramo (para el ranking).
 * `alerted` = se mandó a Telegram. `reviewed` = un superior lo marcó como visto.
 */
const mongoose = require('mongoose');

const AUDIT_FLAGS = [
  'queja',              // el cliente se queja del servicio
  'mal_trato',          // el agente fue descortés / agresivo / burlón
  'sin_solucion',       // el problema quedó sin resolver ni salida clara
  'cliente_enojado',    // el cliente termina frustrado/enojado
  'promesa_incumplida', // el agente prometió algo que no pasó en el chat
  'error_plata',        // discrepancia de montos / carga o pago mal hecho
  'respuesta_pobre',    // respuestas de una palabra, sin leer el problema
  'demora',             // esperas largas visibles en la conversación
  'posible_fraude',     // el cliente intenta algo raro (comprobante ajeno, etc.)
  'insulto_cliente',    // regla: el cliente insultó
  'mensaje_repetido',   // regla: el cliente repitió el mismo mensaje 3+ veces
  'sin_respuesta',      // regla: el cliente escribió y nadie respondió
  'cerrado_sin_responder' // regla: se cerró el chat con una espera en curso
];

const chatAuditSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  username: { type: String, trim: true, index: true },

  source: { type: String, enum: ['ai', 'rules'], required: true, index: true },
  reason: { type: String, default: null }, // 'close' | 'idle' | 'keyword' | 'repeat' | ...

  // Tramo auditado
  periodStart: { type: Date, default: null },
  periodEnd: { type: Date, default: null, index: true },
  messageCount: { type: Number, default: 0 },
  userMessageCount: { type: Number, default: 0 },
  agentMessageCount: { type: Number, default: 0 },
  agents: { type: [String], default: [], index: true },

  // Resultado
  score: { type: Number, default: null, index: true }, // 1..10 (solo IA)
  flags: { type: [String], default: [], index: true },
  summary: { type: String, default: '' },
  quote: { type: String, default: '' },        // la frase más problemática (cliente o agente)
  resolved: { type: Boolean, default: null },  // ¿el problema quedó resuelto?
  customerAngry: { type: Boolean, default: null },
  responsibleAgent: { type: String, default: null },
  model: { type: String, default: null },

  // Seguimiento
  alerted: { type: Boolean, default: false, index: true },
  reviewed: { type: Boolean, default: false, index: true },
  reviewedBy: { type: String, default: null },
  reviewedAt: { type: Date, default: null },
  reviewNote: { type: String, default: '' },
  falsePositive: { type: Boolean, default: false, index: true }, // el supervisor dijo "esto estaba bien" (#136) → fuera del ranking

  createdAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

chatAuditSchema.index({ createdAt: -1, score: 1 });
chatAuditSchema.index({ reviewed: 1, createdAt: -1 });
chatAuditSchema.statics.FLAGS = AUDIT_FLAGS;

module.exports = mongoose.models['ChatAudit'] || mongoose.model('ChatAudit', chatAuditSchema);
