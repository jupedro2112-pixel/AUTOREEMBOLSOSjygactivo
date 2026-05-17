/**
 * Asignación user → comunidad.
 *
 * Cuando admin sube una lista de usernames + link de comunidad, se crea
 * un row por user. El login resuelve la comunidad para un user primero
 * desde acá (asignación explícita) y si no hay, cae al fallback de
 * `userCommunitiesByPrefix` (prefijo).
 *
 * Cada vez que se reasigna a otra comunidad, se actualiza el row
 * existente y se incrementa `version` para auditoría.
 */
const mongoose = require('mongoose');

const lookupSchema = new mongoose.Schema({
  username: { type: String, required: true, index: true, trim: true },
  usernameNorm: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },

  communityLink: { type: String, required: true, trim: true },
  communityLabel: { type: String, default: '' },

  // Estado de la comunidad: si el admin la marca 'down' (se cayó el grupo),
  // la PWA muestra alerta "tu comunidad cerró, sumate a la nueva".
  status: {
    type: String,
    enum: ['active', 'down'],
    default: 'active',
    index: true
  },
  replacementLink: { type: String, default: null },
  replacementLabel: { type: String, default: null },

  assignedAt: { type: Date, default: Date.now, index: true },
  assignedBy: { type: String, default: null },

  version: { type: Number, default: 1 }
}, { timestamps: true });

module.exports = mongoose.models['UserCommunityLookup'] ||
  mongoose.model('UserCommunityLookup', lookupSchema);
