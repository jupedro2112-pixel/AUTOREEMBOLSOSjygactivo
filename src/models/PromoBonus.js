/**
 * PromoBonus — bonificación de carga vigente para un usuario.
 *
 * La crea el motor de automatización cuando una regla con chargeBonus
 * dispara un push: cada usuario que recibe la notificación queda con un
 * bono de carga (un % extra sobre su próxima carga) vigente por un rato.
 *
 * Es válido por UNA sola carga: el agente lo aplica a mano cuando el
 * usuario carga y lo marca como usado. Si vence la ventana sin cargar,
 * queda 'expired'. Un bono nuevo reemplaza (expira) al anterior.
 *
 * "Vigente" = status==='active' && expiresAt > ahora.
 */
const mongoose = require('mongoose');

const promoBonusSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  userId:   { type: String, default: null, index: true },
  username: { type: String, required: true, index: true, lowercase: true, trim: true },

  // % extra sobre la carga del usuario (ej: 50, 100). 0 si es un regalo
  // de monto fijo (ver montoFijoARS).
  percent: { type: Number, required: true, min: 0 },

  // Regalo de monto fijo en pesos (ej: 5000). Si es > 0, el bono no es
  // un % sobre la carga sino un regalo directo que el agente acredita.
  montoFijoARS: { type: Number, default: 0 },

  // Monto de la carga (depósito) en la que se aplicó el bono. Se toma
  // automáticamente del depósito cuando éste incluye bono. Sirve para
  // calcular el ROI en pesos de las estrategias.
  cargaMonto: { type: Number, default: 0 },

  // De qué regla de automatización salió.
  sourceRuleId:   { type: String, default: null },
  sourceRuleCode: { type: String, default: null },
  sourceRuleName: { type: String, default: null },

  activatedAt: { type: Date, default: Date.now, index: true },
  expiresAt:   { type: Date, required: true, index: true },

  // active  = vigente para usar
  // used    = ya se aplicó en una carga (consumido — vale por 1 sola)
  // expired = se venció la ventana o lo reemplazó un bono nuevo
  status: { type: String, enum: ['active', 'used', 'expired'], default: 'active', index: true },
  usedBy: { type: String, default: null },
  usedAt: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now }
}, { timestamps: false });

promoBonusSchema.index({ username: 1, status: 1, expiresAt: -1 });

module.exports = mongoose.models['PromoBonus'] ||
  mongoose.model('PromoBonus', promoBonusSchema);
