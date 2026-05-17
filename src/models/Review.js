/**
 * Review: opinión que deja un usuario sobre el servicio.
 *
 * 1 review por user — una vez enviada NO se puede editar ni volver a
 * votar: el endpoint POST /api/reviews rechaza si ya existe una.
 *
 * stars: 1-5 entero. Bucket de categoría se calcula al leer:
 *   1-2 = malo · 3 = regular · 4-5 = bueno
 *
 * Moderación: la reseña solo se muestra en la pantalla de registro
 * (feed público) si un admin la aprobó. Nace con approved=false y entra
 * a la cola de moderación del panel.
 */
const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  id:        { type: String, required: true, unique: true, index: true },
  userId:    { type: String, required: true, unique: true, index: true },
  username:  { type: String, required: true, index: true },
  stars:     { type: Number, required: true, min: 1, max: 5 },
  comment:   { type: String, default: '', maxlength: 100 },
  // Telefono opcional para que el admin lo recontacte. PRIVADO: nunca
  // se devuelve en el feed publico, solo en /api/admin/reviews.
  contactPhone: { type: String, default: '', maxlength: 25 },

  // Moderacion. approved=false al nacer → no se ve en el registro hasta
  // que un admin la aprueba desde el panel.
  approved:   { type: Boolean, default: false, index: true },
  approvedBy: { type: String, default: null },
  approvedAt: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: false });

reviewSchema.index({ stars: 1, createdAt: -1 });
reviewSchema.index({ approved: 1, createdAt: -1 });

module.exports = mongoose.models['Review'] ||
  mongoose.model('Review', reviewSchema);
