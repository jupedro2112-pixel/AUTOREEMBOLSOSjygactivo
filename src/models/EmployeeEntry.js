/**
 * Empleados por sector (ganamos / publicidad / buffalo) y por puesto.
 *
 * El pago mensual se calcula proporcional a los días trabajados:
 *   valorDia        = sueldoARS / 30
 *   feriadosTotal   = Σ (feriado.amountARS > 0 ? feriado.amountARS : valorDia)
 *   faltantesTotal  = faltantes.length × valorDia
 *   descuentosTotal = Σ descuento.amountARS
 *   totalMensual    = sueldoARS + feriadosTotal − faltantesTotal − descuentosTotal
 *
 * Feriados trabajados suman (al valor/día, o a un monto manual si se carga).
 * Faltantes descuentan un día. Los descuentos sueltos restan cualquier
 * concepto puntual dejando su detalle.
 *
 * Los puestos (roles) son strings libres — los defaults son encargados,
 * pagos, comunidad, cargas, recontactacion, revision_chat, pero el owner
 * puede tipear cualquier otro nombre.
 */
const mongoose = require('mongoose');

// Feriado trabajado. amountARS = 0 → se paga el valor/día proporcional.
const feriadoSchema = new mongoose.Schema({
  dateKey: { type: String, default: '' }, // YYYY-MM-DD del feriado
  amountARS: { type: Number, default: 0, min: 0 },
  note: { type: String, default: '', maxlength: 200 }
}, { _id: false });

// Falta: descuenta un valor/día proporcional.
const faltanteSchema = new mongoose.Schema({
  dateKey: { type: String, default: '' }, // YYYY-MM-DD de la falta
  note: { type: String, default: '', maxlength: 200 }
}, { _id: false });

// Descuento puntual de cualquier concepto que no se le pague.
const descuentoSchema = new mongoose.Schema({
  dateKey: { type: String, default: '' }, // YYYY-MM-DD (opcional)
  amountARS: { type: Number, default: 0, min: 0 },
  note: { type: String, default: '', maxlength: 200 }
}, { _id: false });

// Ajuste manual del pago — puede ser POSITIVO o NEGATIVO. Cubre situaciones
// como un cambio de turno/sueldo a mitad de mes: se carga la diferencia
// con su detalle. Sin `min` para permitir montos negativos.
const ajusteSchema = new mongoose.Schema({
  dateKey: { type: String, default: '' }, // YYYY-MM-DD (opcional)
  amountARS: { type: Number, default: 0 },
  note: { type: String, default: '', maxlength: 200 }
}, { _id: false });

const employeeSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  // Estructura financiera a la que pertenece. Coincide con los sectores
  // de cierres para que sea fácil consolidar números totales.
  sector: {
    type: String,
    enum: ['ganamos', 'publicidad', 'buffalo'],
    required: true,
    index: true
  },

  // Puesto / rol dentro del sector. String libre — los defaults sugeridos:
  //   encargados, pagos, comunidad, cargas, recontactacion, revision_chat
  // Se guarda en minúscula sin espacios al final/principio.
  role: { type: String, required: true, trim: true, maxlength: 60, index: true },

  // Datos del empleado
  name: { type: String, default: '', trim: true, maxlength: 100 },
  schedule: { type: String, default: '', trim: true, maxlength: 200 },
  sueldoARS: { type: Number, default: 0, min: 0 },

  // Comisión por empleado: costo fijo de la transferencia del sueldo, en
  // USD. Se cuenta una vez en el cierre del pago. Default 2.
  comisionUSD: { type: Number, default: 2, min: 0 },

  // Movimientos del mes: feriados trabajados (suman), faltas (descuentan),
  // descuentos puntuales (restan con detalle), ajustes manuales (+ o −).
  feriados: { type: [feriadoSchema], default: [] },
  faltantes: { type: [faltanteSchema], default: [] },
  descuentos: { type: [descuentoSchema], default: [] },
  ajustes: { type: [ajusteSchema], default: [] },

  // IDs de feriados generales del sector que este empleado NO cobra.
  // Por defecto vacío = cobra todos los feriados generales del sector.
  feriadosGeneralesExcluidos: { type: [String], default: [] },

  // Francos: cuántos por semana y qué días (lunes..domingo).
  francosPerWeek: { type: Number, default: 0, min: 0, max: 7 },
  francoDays: { type: [String], default: [] },

  // Fecha hasta la que trabajó (último día / fin de relación). Vacío = sigue.
  workedUntil: { type: String, default: '' }, // YYYY-MM-DD

  notes: { type: String, default: '', maxlength: 500 },
  active: { type: Boolean, default: true, index: true },

  createdBy: { type: String, default: '' }
}, { timestamps: true });

employeeSchema.index({ sector: 1, role: 1, name: 1 });

module.exports = mongoose.models['EmployeeEntry'] ||
  mongoose.model('EmployeeEntry', employeeSchema);
