/**
 * Modelo de Plantillas de Notificación
 * Guarda el contenido editable de cada tipo de notificación push de la
 * estrategia (bono 50%, bono 100%, invitación a jugar, regalo, reembolso).
 */
const mongoose = require('mongoose');

const notifTemplateSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['bono_50', 'bono_100', 'invitacion', 'regalo', 'reembolso'],
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
