/**
 * InfluencerStory — una "historia" (placement) que un influencer subió para un
 * publicista. Es la unidad de seguimiento de costo/ROAS por publicación.
 *
 * El precio del influencer es POR HISTORIA, y normalmente arranca ~20hs (ART).
 * Cada historia se queda con los registros (usuarios creados por el
 * publisher_admin con ese influencer) cuyo createdAt cae en la ventana
 * [postedAt, postedAt de la próxima historia del mismo influencer). La última
 * historia se queda con todo hasta ahora. Esa atribución por ventana se calcula
 * a demanda en publisherAnalyticsService (no se persiste el vínculo).
 *
 * Se identifica por (campaignCode, influencer): el influencer vive en
 * Campaign.influencers y la atribución de usuarios es por
 * acquisitionCampaign + acquisitionInfluencer.
 */
const mongoose = require('mongoose');

const influencerStorySchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  // Code de la Campaign del publicista (= User.acquisitionCampaign).
  campaignCode: {
    type: String,
    required: true,
    uppercase: true,
    trim: true,
    index: true
  },
  // Nombre del influencer (= User.acquisitionInfluencer y Campaign.influencers[].name).
  influencer: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80,
    index: true
  },
  // Momento en que subió la historia (fecha + hora). La hora importa: la ventana
  // de atribución arranca acá. Default de UX en el front: 20:00 ART.
  postedAt: {
    type: Date,
    required: true
  },
  // Precio pagado por esta historia (ARS).
  cost: {
    type: Number,
    default: 0,
    min: 0
  },
  // Etiqueta/nota opcional (ej: "Historia con sorteo", "2da del día").
  label: {
    type: String,
    default: '',
    maxlength: 200,
    trim: true
  },
  createdBy: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// Para listar/ordenar las historias de un influencer por fecha.
influencerStorySchema.index({ campaignCode: 1, influencer: 1, postedAt: 1 });

module.exports = mongoose.models['InfluencerStory'] || mongoose.model('InfluencerStory', influencerStorySchema);
