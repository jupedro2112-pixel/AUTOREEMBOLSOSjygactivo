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
  },
  // === Credenciales del sub-agente JUGAYGANA del publicista (opcional) ===
  // Cuando están configuradas, la creación de usuarios desde un publisher_admin
  // se hace usando ESTAS credenciales (no la cuenta master del env). Así cada
  // usuario nuevo queda colgado del sub-agente correcto en JUGAYGANA y la
  // comisión la cobra el publicista que corresponde.
  //
  // Si quedan null, el publisher_admin crea contra la cuenta master (comportamiento
  // legacy). Las cargas y retiros siguen siempre por la master porque ésta tiene
  // permiso sobre todos sus sub-agentes en la jerarquía de JUGAYGANA.
  //
  // El password se guarda en texto plano. select:false impide que viaje en
  // queries normales: sólo se trae cuando se necesita explícitamente para login.
  jugayganaUsername: {
    type: String,
    default: null,
    trim: true
  },
  jugayganaPassword: {
    type: String,
    default: null,
    select: false
  },
  // === Influencers del publicista (sub-atribución para analítica) ===
  // Lista fija, gestionada por el admin general. Cuando un publisher_admin crea
  // un usuario, elige uno de estos influencers y el nombre queda en
  // User.acquisitionInfluencer para poder desglosar las estadísticas por
  // influencer. NO tiene link propio ni creds: es puramente una etiqueta para
  // segmentar la analítica de este publicista.
  // `name` es único case-insensitive dentro de la campaña (se valida al guardar).
  influencers: {
    type: [{
      name: { type: String, required: true, trim: true, maxlength: 80 },
      isActive: { type: Boolean, default: true }
    }],
    default: []
  }
}, {
  timestamps: true
});

// Helper estático: ¿esta campaña tiene creds JUGAYGANA configuradas?
// Usa countDocuments para no traer datos sensibles si sólo necesitamos saber sí/no.
campaignSchema.statics.hasJugayganaCreds = async function(code) {
  const c = await this.findOne(
    { code: String(code).toUpperCase().trim() },
    { jugayganaUsername: 1 }
  ).lean();
  return !!(c && c.jugayganaUsername);
};

campaignSchema.index({ isActive: 1, publisher: 1 });

module.exports = mongoose.models['Campaign'] || mongoose.model('Campaign', campaignSchema);
