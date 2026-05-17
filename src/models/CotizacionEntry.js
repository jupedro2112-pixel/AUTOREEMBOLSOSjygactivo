/**
 * Cotización semanal — sección financiera dedicada.
 *
 * Cada lunes se hace un cierre que totaliza por equipo (hasta 10) y se
 * cotiza al valor del USDT. El valor a cotizar de cada equipo es:
 *   precio = total_ARS_equipo / usdt_rate
 *
 * El owner marca con ✓ "cotizado" o ✗ "sin cotizar".
 *
 * Una entrada por fecha (típicamente lunes, pero se puede usar cualquier
 * fecha — el owner elige).
 */
const mongoose = require('mongoose');

const cotizacionTeamSchema = new mongoose.Schema({
  slot: { type: Number, required: true, min: 0, max: 9 },
  name: { type: String, default: '', trim: true, maxlength: 80 },
  totalARS: { type: Number, default: 0, min: 0 },
  // % de comisión que se descuenta del total del equipo antes de cotizar.
  // Si totalARS = 1.000.000 y commissionPercent = 5, el neto es 950.000 y
  // el precio USDT se calcula sobre 950.000 / usdtRate.
  // Ajustable por fila (cada equipo puede tener una comisión distinta).
  commissionPercent: { type: Number, default: 0, min: 0, max: 100 },
  // === Tilde por equipo ===
  // Cada equipo se cotiza por separado y a su tiempo. Cuando el dueño
  // confirma que el equipo X ya pagó/cotizó, tilda su fila → pasa a
  // cotizado=true. El tag de la cotización completa se deriva: queda
  // "cotizada" cuando todos los equipos con monto están cotizados.
  cotizado: { type: Boolean, default: false },
  cotizedAt: { type: Date, default: null },
  cotizedBy: { type: String, default: '' },
  // Foto opcional para respaldar el monto del equipo
  photoUrl: { type: String, default: '' }
}, { _id: false });

const cotizacionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  // YYYY-MM-DD — típicamente un lunes, pero el owner elige libremente.
  // Index único declarado abajo con cotizacionSchema.index().
  dateKey: { type: String, required: true },

  // Hasta 10 equipos
  teams: {
    type: [cotizacionTeamSchema],
    default: () => Array.from({ length: 10 }, (_, i) => ({
      slot: i, name: '', totalARS: 0, photoUrl: ''
    }))
  },

  // Valor del USDT (en ARS) para esta cotización
  usdtRate: { type: Number, default: 0, min: 0 },

  // === Ciclo de vida ===
  // draft  → editable libre. Cuando el owner termina de cargar, "cierra".
  // closed → los datos quedan lockeados (teams, rate, fecha). Sólo el tag
  //          de cotizado/no-cotizado se puede seguir cambiando, porque eso
  //          es una etiqueta posterior (puede pasar días después que cierre
  //          el cuadre de números).
  status: { type: String, enum: ['draft', 'closed'], default: 'draft', index: true },
  closedAt: { type: Date, default: null },
  closedBy: { type: String, default: '' },

  // Tilde / cruz — el owner confirma manualmente cuando ya cotizó.
  // Independiente del status: se puede tildar/destildar incluso después de
  // cerrar la cotización (la cotización efectiva pasa días después).
  cotizado: { type: Boolean, default: false },
  cotizedAt: { type: Date, default: null },
  cotizedBy: { type: String, default: '' },

  notes: { type: String, default: '', maxlength: 500 },
  createdBy: { type: String, default: '' }
}, { timestamps: true });

cotizacionSchema.index({ dateKey: 1 }, { unique: true });

module.exports = mongoose.models['CotizacionEntry'] ||
  mongoose.model('CotizacionEntry', cotizacionSchema);
