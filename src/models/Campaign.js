/**
 * Campaign — publicista / pauta publicitaria.
 * Cada Campaign representa un canal de adquisición separado: un publicista
 * externo, una campaña de Meta, una colaboración con un influencer, etc.
 *
 * El `code` es el identificador que viaja en la URL del anuncio:
 *   https://vipcargas.com/?p=META_JUAN_ENE26
 *
 * Las estadísticas se calculan a demanda agregando User / Transaction /
 * CampaignClick filtradas por `acquisitionCampaign === campaign.code`.
 */
const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  // Código que se usa en los links. Inmutable una vez creado para no romper
  // atribuciones ya hechas. Sólo letras/números/guion bajo/guion, mayúsculas.
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
    minlength: 3,
    maxlength: 40,
    match: /^[A-Z0-9_-]+$/,
    index: true,
    immutable: true
  },
  // Nombre visible del publicista (puede tener múltiples campaigns).
  publisher: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
    index: true
  },
  // Nombre interno de la campaña (para distinguir varias del mismo publicista).
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  // Tipo de comisión que se le paga al publicista. Por ahora sólo se muestra
  // en el panel; los pagos son manuales.
  commissionType: {
    type: String,
    enum: ['cpa', 'revshare', 'none'],
    default: 'none'
  },
  // CPA: monto fijo por FTD (depósito inicial). RevShare: % sobre ganancia neta.
  // Se interpreta según commissionType: cpa = ARS, revshare = porcentaje 0-100.
  commissionValue: {
    type: Number,
    default: 0,
    min: 0
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  notes: {
    type: String,
    default: '',
    maxlength: 2000
  },
  createdBy: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

campaignSchema.index({ isActive: 1, publisher: 1 });

module.exports = mongoose.models['Campaign'] || mongoose.model('Campaign', campaignSchema);
