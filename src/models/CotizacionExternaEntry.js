/**
 * Cotización EXTERNA — gemelo de CotizacionEntry pero en su propia collection.
 *
 * Idéntico schema, idéntica lógica. La separación se hace por collection
 * (cotizacionexternaentries) para que el flujo interno y el externo no se
 * mezclen ni en queries ni en índices.
 *
 * Misma estructura: hasta 10 equipos, totalARS + commissionPercent por team,
 * usdtRate, status (draft/closed), cotizado/no-cotizado.
 */
const mongoose = require('mongoose');

const teamSchema = new mongoose.Schema({
  slot: { type: Number, required: true, min: 0, max: 9 },
  name: { type: String, default: '', trim: true, maxlength: 80 },
  totalARS: { type: Number, default: 0, min: 0 },
  commissionPercent: { type: Number, default: 0, min: 0, max: 100 },
  // Tilde por equipo (idem CotizacionEntry).
  cotizado: { type: Boolean, default: false },
  cotizedAt: { type: Date, default: null },
  cotizedBy: { type: String, default: '' },
  photoUrl: { type: String, default: '' }
}, { _id: false });

const schema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  dateKey: { type: String, required: true },
  teams: {
    type: [teamSchema],
    default: () => Array.from({ length: 10 }, (_, i) => ({
      slot: i, name: '', totalARS: 0, commissionPercent: 0, photoUrl: ''
    }))
  },
  usdtRate: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ['draft', 'closed'], default: 'draft', index: true },
  closedAt: { type: Date, default: null },
  closedBy: { type: String, default: '' },
  cotizado: { type: Boolean, default: false },
  cotizedAt: { type: Date, default: null },
  cotizedBy: { type: String, default: '' },
  notes: { type: String, default: '', maxlength: 500 },
  createdBy: { type: String, default: '' }
}, { timestamps: true });

schema.index({ dateKey: 1 }, { unique: true });

module.exports = mongoose.models['CotizacionExternaEntry'] ||
  mongoose.model('CotizacionExternaEntry', schema);
