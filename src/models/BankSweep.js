/**
 * Modelo BankSweep — "BAJADAS" del banco (#155).
 *
 * Una bajada es una transferencia SALIENTE desde nuestra cuenta hgcash hacia un CBU
 * externo (financiera, etc.) para que el banco no acumule mucho capital junto.
 * NO es un pago a un cliente (eso es PendingPayout). Solo la pueden hacer el admin
 * general o el rol de pagos (withdrawer), y TODAS quedan registradas acá.
 *
 * Se paga por la misma API de cash-out de hgcash, con externalID `sweep-<id>`
 * (idempotencia: el mismo id nunca se paga dos veces). El webhook de estado
 * (topic TRANSACTION_REQUEST) actualiza `status`; el movimiento saliente del
 * ledger (direction Outbound, externalId = sweep-<id>) se vincula en `movementId`.
 * Registro permanente (sin TTL): es parte del cierre diario.
 */
const mongoose = require('mongoose');

const bankSweepSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  amount: { type: Number, required: true },
  toCBU: { type: String, required: true },
  toName: { type: String, default: null },
  toCUIT: { type: String, default: null },
  alias: { type: String, default: null },
  destLabel: { type: String, default: null },   // nombre del destino guardado (ej. "Financiera X")
  concept: { type: String, default: null },
  note: { type: String, default: null },
  requestedBy: { type: String, default: null },
  requestedByRole: { type: String, default: null },
  status: {
    type: String,
    enum: ['pending', 'paying', 'done', 'failed', 'cancelled'],
    default: 'pending',
    index: true
  },
  accountId: { type: String, default: null },
  balanceBefore: { type: Number, default: null }, // saldo neto hgcash antes de pedirla (informativo)
  hgRequestId: { type: String, default: null, index: true }, // id del REQUEST (createCashOut)
  hgTxId: { type: String, default: null },                   // id de la transacción real (ledger)
  hgStatus: { type: String, default: null },
  error: { type: String, default: null },
  movementId: { type: String, default: null },               // BankMovement saliente vinculado
  doneAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, index: true }
}, {
  timestamps: true
});

module.exports = mongoose.models['BankSweep'] || mongoose.model('BankSweep', bankSweepSchema);
