/**
 * Modelo HgcashCharge — candado de idempotencia de la CARGA automática hgcash.
 *
 * Cada acreditación automática reclama de forma ATÓMICA (índice único en
 * `chargeKey`) la transferencia real, identificada por su `coelsaCode` (el código
 * Coelsa de la red bancaria, único e irrepetible por transferencia). Si la misma
 * transferencia intenta acreditarse de nuevo (porque hgcash reenvió el movimiento
 * con otro id, o porque hay dos documentos de comprobante del mismo recibo), el
 * insert falla con 11000 y la segunda carga se BLOQUEA. Así una transferencia se
 * acredita UNA sola vez, aunque el proceso corra en varias instancias (AWS EB).
 *
 * Colección nueva → no requiere migración. Sólo la usa la auto-carga hgcash.
 * NOTA: si la carga falla en JUGAYGANA, el registro se BORRA (deleteOne) para que
 * un reintento legítimo pueda volver a reclamar la misma transferencia.
 */
const mongoose = require('mongoose');

const hgcashChargeSchema = new mongoose.Schema({
  // Clave única de la transferencia real: coelsaCode (o externalId como fallback).
  chargeKey: { type: String, required: true, unique: true, index: true },
  userId: { type: String, default: null },
  username: { type: String, default: null },
  amount: { type: Number, default: null },
  movementId: { type: String, default: null },     // movimiento que ganó la carga
  comprobanteId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

module.exports = mongoose.models['HgcashCharge'] || mongoose.model('HgcashCharge', hgcashChargeSchema);
