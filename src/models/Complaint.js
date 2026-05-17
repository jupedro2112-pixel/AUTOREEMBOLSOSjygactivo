/**
 * Complaint — Libro de quejas público.
 *
 * Cualquier user logueado puede enviar una queja desde la app (botón
 * arriba a la izquierda del header). El admin la ve en NUEVO TOP →
 * Libro de quejas. Incluye foto opcional (subida via S3 presigned URL,
 * el endpoint guarda solo la imageUrl resultante).
 *
 * Status flow:
 *   pending  → recién enviada, no leída
 *   reviewed → admin la leyó / la está atendiendo
 *   resolved → cerrada
 */
const mongoose = require('mongoose');

// Sub-doc de mensaje en el hilo conversacional. Cada queja arranca con la
// descripción inicial del user (no se duplica acá — vive en `description`)
// y a partir de ahí van apilándose mensajes admin↔user. Cuando el admin
// marca status='resolved' el hilo se cierra (el front ya no permite
// agregar más mensajes).
const complaintMessageSchema = new mongoose.Schema({
  // 'admin' o 'user' — quién escribió el mensaje.
  from: { type: String, enum: ['admin', 'user'], required: true },
  // Username de quien escribió (admin handle o username del dueño).
  authorName: { type: String, default: '', maxlength: 60 },
  // Texto del mensaje. Max 2000 chars.
  text: { type: String, required: true, maxlength: 2000, trim: true },
  // Cuándo se mandó el push al destinatario (queda null si no se notificó).
  notifiedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const complaintSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  userId: { type: String, required: true, index: true },
  username: { type: String, required: true, index: true, trim: true },

  // Cuándo pasó el incidente (lo elige el user, puede ser distinto a createdAt).
  incidentDate: { type: String, required: true, maxlength: 10 }, // YYYY-MM-DD
  incidentTime: { type: String, default: '', maxlength: 5 },     // HH:MM, opcional

  // Detalle de la queja.
  subject: { type: String, default: '', maxlength: 100, trim: true },
  description: { type: String, required: true, maxlength: 2000, trim: true },

  // Foto opcional. Acepta:
  //   - URL pública de S3 (si está configurado /api/upload/presigned-url)
  //   - data URL base64 inline (si S3 no está, el front comprime la foto
  //     con canvas a max 800px / quality 0.7 → suele quedar bajo 300KB)
  // 1.5MB es suficiente para fotos comprimidas y deja margen bajo el cap
  // de 16MB de MongoDB por doc.
  imageUrl: { type: String, default: '', maxlength: 1500000 },

  // Moderación.
  status: { type: String, enum: ['pending', 'reviewed', 'resolved'], default: 'pending', index: true },
  adminNotes: { type: String, default: '', maxlength: 2000 },
  readBy: { type: [String], default: [] },              // usernames de admins que la vieron
  readAt: { type: Date, default: null },                // primera lectura
  resolvedBy: { type: String, default: null },
  resolvedAt: { type: Date, default: null },

  // Respuesta del admin para el usuario (visible en "Mis quejas" en la PWA).
  // adminNotes es interno (solo admins); adminResponse es la respuesta
  // pública que ve el dueño de la queja.
  adminResponse: { type: String, default: '', maxlength: 2000 },
  respondedBy: { type: String, default: null },
  respondedAt: { type: Date, default: null },

  // Cuándo se le mandó el push al user avisándole que hay respuesta.
  // Sirve para evitar mandar dos pushes si el admin edita la respuesta.
  // Si el admin tilda "responder sin notificar", este campo queda null.
  userNotifiedAt: { type: Date, default: null },

  // Hilo conversacional: mensajes admin↔user. La descripción inicial del
  // user vive en `description` (no se duplica acá). El admin marca
  // status='resolved' cuando da el caso por cerrado — recién ahí el front
  // bloquea agregar más mensajes.
  messages: { type: [complaintMessageSchema], default: [] }
}, {
  collection: 'complaints',
  timestamps: true,
  versionKey: false
});

// Indices compuestos para queries comunes del admin.
complaintSchema.index({ status: 1, createdAt: -1 });
complaintSchema.index({ username: 1, createdAt: -1 });

module.exports = mongoose.models['Complaint'] ||
  mongoose.model('Complaint', complaintSchema);
