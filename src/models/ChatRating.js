/**
 * Modelo de Calificación de atención (WORKLOG #132)
 *
 * Al cerrar un chat se le manda al cliente un mensaje "¿Cómo te atendieron
 * hoy? 👍 👎" (Message con metadata.kind='rating_request'). Su respuesta se
 * guarda acá, PERMANENTE. Si es 👎, el cliente puede explicar por qué y eso
 * lo lee un superior (panel → Auditoría + alerta Telegram).
 *
 * Una calificación por mensaje de pedido (messageId único).
 */
const mongoose = require('mongoose');

const chatRatingSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  username: { type: String, trim: true, index: true },
  messageId: { type: String, required: true, unique: true }, // el Message rating_request
  rating: { type: String, enum: ['up', 'down'], required: true, index: true },
  comment: { type: String, default: '', maxlength: 1000 },
  // #141: si fue 👎 SIN motivo, la IA lee la última charla y explica qué pudo pasar
  // (o dice explícitamente que no encuentra motivo). Puntaje de esa auditoría.
  aiContext: { type: String, default: '' },
  aiScore: { type: Number, default: null },
  // Contexto del cierre (quién cerró y quiénes atendieron en las últimas horas)
  closedBy: { type: String, default: null },
  agents: { type: [String], default: [], index: true },
  // Seguimiento
  alerted: { type: Boolean, default: false },
  reviewed: { type: Boolean, default: false, index: true },
  reviewedBy: { type: String, default: null },
  reviewedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

chatRatingSchema.index({ rating: 1, createdAt: -1 });

module.exports = mongoose.models['ChatRating'] || mongoose.model('ChatRating', chatRatingSchema);
