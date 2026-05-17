/**
 * Configuración por sector del módulo de empleados.
 *
 * Un documento por sector (ganamos / publicidad / buffalo). Guarda:
 *  - feriadosGenerales: feriados que aplican a TODOS los empleados del
 *    sector. Cada empleado los cobra por defecto; puede excluirse uno
 *    puntual vía EmployeeEntry.feriadosGeneralesExcluidos.
 *  - usdRate: cuántos ARS equivalen a 1 USD, para mostrar el total en
 *    dólares en el resumen general. Lo carga el owner a mano.
 *
 * Cada sector se maneja de forma independiente.
 */
const mongoose = require('mongoose');

const generalFeriadoSchema = new mongoose.Schema({
  id: { type: String, required: true },
  dateKey: { type: String, default: '' }, // YYYY-MM-DD
  amountARS: { type: Number, default: 0, min: 0 }, // 0 = usar valor/día de cada empleado
  note: { type: String, default: '', maxlength: 200 }
}, { _id: false });

const sectorConfigSchema = new mongoose.Schema({
  sector: {
    type: String,
    enum: ['ganamos', 'publicidad', 'buffalo'],
    required: true,
    unique: true,
    index: true
  },
  feriadosGenerales: { type: [generalFeriadoSchema], default: [] },
  usdRate: { type: Number, default: 0, min: 0 } // ARS por 1 USD
}, { timestamps: true });

module.exports = mongoose.models['EmployeeSectorConfig'] ||
  mongoose.model('EmployeeSectorConfig', sectorConfigSchema);
