/**
 * Pool de copies de engagement-only
 *
 * Templates de notificaciones SIN regalo asociado, que se rotan entre los
 * users del 70% engagement de cada lanzamiento de Automatización. La idea
 * es que el mismo user no vea siempre la misma frase ("te extrañamos")
 * y la base no se canse del mismo copy.
 *
 * El admin puede:
 *   - Editar el texto de cualquier copy.
 *   - Habilitar/deshabilitar.
 *   - Ajustar el peso (un copy con weight=2 sale el doble que uno con weight=1).
 *   - Limitar a un segmento (ej: copy "te extrañamos" solo a dormidos).
 *
 * usageCount se incrementa atomicamente con $inc cuando se asigna en un
 * launch, sirve para anti-fatiga (el algoritmo evita repetir el mismo
 * copy a un user que ya lo recibio reciente).
 */
const mongoose = require('mongoose');

const engagementCopySchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  title: { type: String, required: true, trim: true, maxlength: 200 },
  body: { type: String, required: true, trim: true, maxlength: 500 },

  // Si esta vacio o null, sirve para cualquier segmento.
  // Si tiene valores, solo se usa para esos segmentos.
  // Posibles: 'big_loser_hot', 'medium_loser', 'small_loser',
  //          'dormant_hot', 'dormant_cold', 'active'
  segments: { type: [String], default: [] },

  enabled: { type: Boolean, default: true, index: true },
  weight: { type: Number, default: 1, min: 0.1, max: 10 },
  usageCount: { type: Number, default: 0 },

  createdBy: { type: String, default: null }
}, { timestamps: true });

module.exports = mongoose.models['EngagementCopyPool'] ||
  mongoose.model('EngagementCopyPool', engagementCopySchema);
