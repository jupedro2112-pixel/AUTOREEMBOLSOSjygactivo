/**
 * Modelo DailyClose — CIERRE DIARIO del banco (#155).
 *
 * Un documento por día argentino (`dateKey` = 'YYYY-MM-DD', único). Lo genera el
 * cron a las 00:05 ART para el día anterior (o el admin a mano desde el panel) y
 * concilia tres cruces:
 *   1. Banco ↔ sistema: cada transferencia entrante tiene una acreditación vinculada
 *      (o está marcada "no corresponde"); cada carga tiene su transferencia (o está
 *      declarada "otro banco"); cada salida es un pago o una bajada.
 *   2. Sistema ↔ JUGAYGANA: el saldo del CAJERO (CashierSnapshot) tiene que haberse
 *      movido exactamente lo que nosotros operamos.
 *   3. Errores humanos/sistema: pagos sin descuento confirmado, operaciones ambiguas
 *      sin resolver, etc.
 * `diffs[]` es la lista de diferencias; cada una se puede marcar RESUELTA desde el
 * panel con una nota (quién y cuándo). El cierre queda "ok" cuando no queda ninguna
 * sin resolver. Se recalcula al pedirlo (los diffs resueltos se conservan por `key`).
 * Registro permanente (sin TTL).
 */
const mongoose = require('mongoose');

const diffSchema = new mongoose.Schema({
  key: { type: String, required: true },      // identificador estable (tipo:refId) para conservar "resuelto" entre recálculos
  type: { type: String, required: true },     // mov_sin_acreditar | carga_sin_transferencia | salida_sin_origen | pago_sin_descuento | pago_sin_movimiento | ambiguo | cajero_descuadre | ...
  refType: { type: String, default: null },   // movement | transaction | payout | refund | roulette | cashier
  refId: { type: String, default: null },
  amount: { type: Number, default: null },
  userId: { type: String, default: null },
  username: { type: String, default: null },
  detail: { type: String, default: null },
  at: { type: Date, default: null },
  resolved: { type: Boolean, default: false },
  resolvedBy: { type: String, default: null },
  resolvedAt: { type: Date, default: null },
  note: { type: String, default: null }
}, { _id: false });

const dailyCloseSchema = new mongoose.Schema({
  dateKey: { type: String, required: true, unique: true, index: true },
  status: { type: String, enum: ['ok', 'diff', 'warn'], default: 'warn', index: true },
  computedAt: { type: Date, default: null },
  computedBy: { type: String, default: null },  // 'cron' | username
  runs: { type: Number, default: 0 },
  summary: { type: mongoose.Schema.Types.Mixed, default: null },   // totales del día (entradas, cargas, salidas, bajadas, otro banco…)
  cashier: { type: mongoose.Schema.Types.Mixed, default: null },   // cruce con el cajero de JUGAYGANA
  bank: { type: mongoose.Schema.Types.Mixed, default: null },      // saldo hgcash al cierre + delta vs. cierre anterior (informativo)
  diffs: { type: [diffSchema], default: [] },
  unresolvedCount: { type: Number, default: 0 },
  notifiedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

module.exports = mongoose.models['DailyClose'] || mongoose.model('DailyClose', dailyCloseSchema);
