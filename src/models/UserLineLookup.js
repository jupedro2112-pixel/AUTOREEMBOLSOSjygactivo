/**
 * UserLineLookup
 * Tabla de búsqueda persistente que mapea username (normalizado) → línea/equipo.
 * Se popula cuando el admin importa un .xlsx desde el panel "Números vigentes".
 *
 * Por qué existe (en vez de solo escribir User.linePhone):
 *   - Muchos usernames del Drive todavía no existen en la DB cuando se hace
 *     el import (el usuario nunca ingresó por primera vez). Si solo seteamos
 *     User.linePhone, esos usuarios pierden la asignación.
 *   - Con esta tabla, cuando un usuario nuevo se crea (vía JUGAYGANA en login)
 *     o cuando hace login alguien con User.linePhone vacío, consultamos acá
 *     y le asignamos la línea correspondiente del .xlsx.
 *
 * El campo `usernameNorm` es el username normalizado (lowercase + sin tildes
 * + solo [a-z0-9]) — debe matchear la misma normalización que usa el endpoint
 * de import para garantizar consistencia.
 */
const mongoose = require('mongoose');

const userLineLookupSchema = new mongoose.Schema({
  usernameNorm: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
    lowercase: true
  },
  // Username "original" de la celda del .xlsx (para auditoría / display).
  usernameOriginal: {
    type: String,
    default: null
  },
  linePhone: {
    type: String,
    required: true,
    trim: true
  },
  lineTeamName: {
    type: String,
    required: true,
    trim: true
  },
  prefix: {
    type: String,
    default: null,
    lowercase: true,
    trim: true
  },
  importedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  importedBy: {
    type: String,
    default: null
  }
}, {
  timestamps: false
});

userLineLookupSchema.index({ linePhone: 1 });
userLineLookupSchema.index({ lineTeamName: 1 });

module.exports = mongoose.models['UserLineLookup'] || mongoose.model('UserLineLookup', userLineLookupSchema);
