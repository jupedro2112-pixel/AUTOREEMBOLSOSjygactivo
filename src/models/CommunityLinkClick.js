/**
 * Click en link de comunidad (WhatsApp).
 *
 * Cada vez que un user tappea "💬 LINK COMUNIDAD" en home o "ENTRAR A LA
 * COMUNIDAD" en el modal forzado, se inserta un row acá. Sirve para medir
 * CTR real del link por equipo/prefijo y por día.
 */
const mongoose = require('mongoose');

const clickSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  username: { type: String, required: true, index: true, trim: true },

  // Prefijo del username (3 primeros chars o el matched contra
  // userCommunitiesByPrefix). Sirve para agrupar por equipo.
  teamPrefix: { type: String, default: '', index: true, lowercase: true },

  communityLink: { type: String, default: '', trim: true },

  // 'home_button' = click en el botón "LINK COMUNIDAD" del home (comunidad 1)
  // 'home_button_2' = click en el botón "COMUNIDAD 2" del home
  // 'modal_join' = click en "ENTRAR A LA COMUNIDAD" del modal forzado
  // 'replacement' = click en el link de reemplazo (cuando la anterior se cayó)
  source: {
    type: String,
    enum: ['home_button', 'home_button_2', 'modal_join', 'replacement'],
    default: 'home_button'
  },

  // Día del click en hora Argentina, YYYY-MM-DD. Indexed para agg rápida.
  dateKey: { type: String, required: true, index: true },

  clickedAt: { type: Date, default: Date.now, index: true, immutable: true }
}, { timestamps: false });

clickSchema.index({ dateKey: 1, teamPrefix: 1 });
clickSchema.index({ clickedAt: -1 });

module.exports = mongoose.models['CommunityLinkClick'] ||
  mongoose.model('CommunityLinkClick', clickSchema);
