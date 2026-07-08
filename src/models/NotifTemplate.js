/**
 * Modelo de Plantillas de Notificación
 * Guarda el contenido editable de cada tipo de notificación push de la
 * estrategia (invitación a jugar, regalo, reembolso).
 * bono_50/bono_100 ELIMINADOS (owner 2026-07-08: tope 30% automático).
 */
const mongoose = require('mongoose');

const notifTemplateSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['invitacion', 'regalo', 'reembolso'],
    required: true,
    unique: true,
    index: true
  },
  title: { type: String, default: '', trim: true },
  body: { type: String, default: '', trim: true },
  // Duración del "tiempo limitado" en horas. Solo aplica a los bonos.
  // El texto puede usar el placeholder {horas} y se reemplaza al enviar.
  durationHours: { type: Number, default: 24, min: 0 },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.models['NotifTemplate'] || mongoose.model('NotifTemplate', notifTemplateSchema);
