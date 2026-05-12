/**
 * CampaignClick — un registro por cada clic que llegó con `?p=CODE`.
 * Se usa para contar clics (numerador de la conversion rate clicks→registros).
 *
 * TTL: 90 días. Pasado ese tiempo el clic se borra automáticamente. Las
 * conversiones ya están atribuidas en User.acquisitionCampaign / acquiredAt,
 * así que perder el detalle del clic individual no afecta las stats agregadas
 * (volumen total) — sólo limpia la colección.
 */
const mongoose = require('mongoose');

const CLICK_TTL_SECONDS = 90 * 24 * 60 * 60;

const campaignClickSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  campaignCode: {
    type: String,
    required: true,
    uppercase: true,
    trim: true,
    index: true
  },
  // Hash SHA256(ip + userAgent) para evitar contar varias veces al mismo
  // visitante sin guardar la IP cruda. No es un identificador estable
  // (cambia con la red), sólo sirve para deduplicar dentro de la ventana TTL.
  fingerprint: {
    type: String,
    default: null,
    index: true
  },
  userAgent: {
    type: String,
    default: null,
    maxlength: 500
  },
  referer: {
    type: String,
    default: null,
    maxlength: 500
  },
  utm: {
    source: { type: String, default: null, maxlength: 100 },
    medium: { type: String, default: null, maxlength: 100 },
    campaign: { type: String, default: null, maxlength: 100 },
    content: { type: String, default: null, maxlength: 100 },
    term: { type: String, default: null, maxlength: 100 }
  },
  // Cookie/fingerprint que el cliente generó y guarda en localStorage.
  // Se reusa al registrar para correlacionar clic→registro sin depender de IP.
  visitorId: {
    type: String,
    default: null,
    index: true
  },
  clickedAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

// TTL: los clicks se borran automáticamente a los 90 días.
campaignClickSchema.index({ clickedAt: 1 }, { expireAfterSeconds: CLICK_TTL_SECONDS });
campaignClickSchema.index({ campaignCode: 1, clickedAt: -1 });

module.exports = mongoose.models['CampaignClick'] || mongoose.model('CampaignClick', campaignClickSchema);
