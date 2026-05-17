/**
 * Cierre de empleados: foto congelada del período (sueldos + movimientos +
 * cálculo de cada empleado). Se crea cuando el owner "cierra" — el 5 de
 * cada mes o cuando quiera. Queda como historial inmutable y se puede
 * tildar pagado.
 *
 * Al cerrar, la hoja viva (EmployeeEntry) arranca limpia de movimientos
 * (feriados / faltantes / descuentos) para el período siguiente — los
 * empleados, sueldos, francos y roles se conservan.
 */
const mongoose = require('mongoose');

const closingSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  periodLabel: { type: String, default: '', maxlength: 80 },

  closedAt: { type: Date, default: Date.now, index: true },
  closedBy: { type: String, default: '' },

  paid: { type: Boolean, default: false, index: true },
  paidAt: { type: Date, default: null },
  paidBy: { type: String, default: '' },

  // Foto de cada empleado con su cálculo, tal cual estaba al cerrar.
  employees: { type: [mongoose.Schema.Types.Mixed], default: [] },
  employeeCount: { type: Number, default: 0 },

  grandTotalARS: { type: Number, default: 0 },        // suma de sueldos a pagar
  comisionesTotalARS: { type: Number, default: 0 },    // suma de comisiones de transferencia
  costoTotalARS: { type: Number, default: 0 },         // grandTotal + comisiones
  bySector: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Configs de sector al momento del cierre (feriados generales) — para
  // poder reabrir el período y restaurar la hoja tal cual estaba.
  sectorConfigs: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

module.exports = mongoose.models['EmployeeClosing'] ||
  mongoose.model('EmployeeClosing', closingSchema);
