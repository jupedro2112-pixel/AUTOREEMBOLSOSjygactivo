/**
 * DailyPlayerStats - una fila por (username, dia) con los agregados de
 * ese dia. Se llenan al importar CSVs de JUGAYGANA.
 *
 * Sirve para:
 *   - Sumar los ultimos 45 dias en cada momento (ventana movil) sin
 *     guardar las transacciones crudas.
 *   - Mostrar drill-down por dia: "Cargas de Atomic el 15/4" etc.
 *   - Imports incrementales: cada upload upsertea por (user, day),
 *     no pisa todo el historico.
 *
 * Cleanup: el cron de stats borra rows con dateUtc < hoy - 60d
 * (buffer de 15d sobre la ventana de 45d para que el admin pueda
 * extender la ventana si quiere sin perder data).
 */
const mongoose = require('mongoose');

const dailyPlayerStatsSchema = new mongoose.Schema({
  // El index del username viene del compound unique mas abajo — no declaramos
  // index:true aca para evitar el warning de Mongoose "Duplicate schema index".
  username: { type: String, required: true, lowercase: true, trim: true },

  // Fecha (solo dia, sin hora) en UTC. Lo guardamos como Date a las 00:00 UTC
  // para que las queries por rango ($gte/$lt) funcionen y unique index
  // sirva para idempotencia. El index explicito para cleanup va al final.
  dateUtc: { type: Date, required: true },

  // Aggregados del dia
  depositCount: { type: Number, default: 0 },
  depositSum: { type: Number, default: 0 },
  withdrawCount: { type: Number, default: 0 },
  withdrawSum: { type: Number, default: 0 },
  bonusCount: { type: Number, default: 0 },
  bonusSum: { type: Number, default: 0 },

  // Ultima vez que se actualizo este row (puede ser por re-importes).
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: false });

// Unique index (username, dateUtc) para que el upsert idempotente funcione.
dailyPlayerStatsSchema.index({ username: 1, dateUtc: 1 }, { unique: true });
// Index para cleanup eficiente.
dailyPlayerStatsSchema.index({ dateUtc: 1 });

module.exports = mongoose.models['DailyPlayerStats'] ||
  mongoose.model('DailyPlayerStats', dailyPlayerStatsSchema);
