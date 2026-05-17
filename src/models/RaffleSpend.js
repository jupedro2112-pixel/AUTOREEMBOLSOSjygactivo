/**
 * Log inmutable de gasto en sorteos PAGOS por compra individual.
 *
 * Cada vez que un user compra cupos en /api/raffles/:id/buy y el descuento
 * en JUGAYGANA prospera, se inserta un row aca con el monto y los numeros
 * comprados. Es la fuente de verdad para el "cierre diario" — sumamos por
 * fecha (TZ ARG) y obtenemos cuanta plata se gasto en sorteos cada dia,
 * dato que el dueño usa para cuadrar el cierre contable contra JUGAYGANA.
 *
 * Inmutable: una vez insertado, NO se modifica. Si hubiera que reembolsar
 * (cancel/purge) creamos otro row negativo o lo reflejamos en RaffleParticipation
 * (que ya tiene refundedAt/refundedAmount).
 *
 * No se loguean gratis (entryCostPaid = 0) porque no afectan la caja.
 */
const mongoose = require('mongoose');

const raffleSpendSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true, index: true, trim: true },
  raffleId: { type: String, required: true, index: true },
  raffleType: { type: String, required: true, index: true },
  raffleName: { type: String, default: '' },
  // Cantidad de cupos comprados en ESTE evento (no acumulado).
  cuposCount: { type: Number, required: true, min: 1 },
  ticketNumbers: { type: [Number], default: [] },
  // Monto total en pesos descontado en JUGAYGANA en ESTE evento.
  amountARS: { type: Number, required: true, min: 0 },
  // Transaction id devuelto por JUGAYGANA (para auditoria).
  jugayganaTxId: { type: String, default: null },
  // Fecha de la compra. Indexada para query por rango.
  createdAt: { type: Date, default: Date.now, index: true },
  // Clave dia en TZ ARG (YYYY-MM-DD). Pre-calculada en el insert para
  // poder hacer aggregation por dia sin reconvertir TZ en cada query.
  dayKeyArg: { type: String, required: true, index: true }
}, { timestamps: false });

raffleSpendSchema.index({ dayKeyArg: 1, raffleType: 1 });

module.exports = mongoose.models['RaffleSpend'] || mongoose.model('RaffleSpend', raffleSpendSchema);
