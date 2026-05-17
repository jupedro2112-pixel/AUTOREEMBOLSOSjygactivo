/**
 * Cierre diario por sector.
 *
 * Modelo financiero para que el owner controle día a día:
 *   - depósitos que entran (banco cobra comisión por cada uno)
 *   - ventas que hay que pagar (bajar)
 *   - cuánto se bajó y cuánto quedó pendiente (arrastra al día siguiente)
 *   - bonos regalados
 *   - comprobantes de bajada (fotos)
 *   - si quedó pendiente, comprobante del banco que muestre que la plata
 *     sigue ahí (sino se considera plata faltante)
 *
 * Sectores: ganamos | publicidad | buffalo (este último tiene 7 slots
 * de equipo individual, con nombre editable).
 *
 * Reglas:
 *   - draft: editable libremente.
 *   - confirmed: editable hasta 24h del confirmedAt. Después, locked.
 *   - Cualquier edit registra en editHistory para auditoría.
 */
const mongoose = require('mongoose');

const editEntrySchema = new mongoose.Schema({
  editedAt: { type: Date, default: Date.now },
  editedBy: { type: String, default: '' },
  field: { type: String, default: '' },
  before: { type: mongoose.Schema.Types.Mixed },
  after: { type: mongoose.Schema.Types.Mixed }
}, { _id: false });

// Sub-equipo para sector Buffalo. Buffalo tiene 7 equipos pero comparte
// algunos datos (% banco, bajada, pendiente, descargas) porque la bajada
// se hace UNA sola vez desde un mismo banco. Lo demás (depositos, ventas,
// bonos, transacciones) sí es individual por equipo.
const buffaloTeamSchema = new mongoose.Schema({
  slot: { type: Number, required: true, min: 0, max: 6 },
  name: { type: String, default: '', trim: true },
  depositsARS: { type: Number, default: 0, min: 0 },       // cargas $
  depositsCount: { type: Number, default: 0, min: 0 },     // cargas # (count of deposits)
  // VENTA acepta negativos — pedido del dueño 2026-05-14: si la operatoria
  // del equipo cerró perdiendo (cash-out > depósitos), el monto es negativo.
  ventasARS: { type: Number, default: 0 },
  bonusARS: { type: Number, default: 0, min: 0 },          // bonos $
  bonusCount: { type: Number, default: 0, min: 0 },        // bonificaciones #
  withdrawalsCount: { type: Number, default: 0, min: 0 }   // descargas # (count per team)
}, { _id: false });

const comprobanteSchema = new mongoose.Schema({
  url: { type: String, required: true },
  // Tipos de comprobantes que el owner puede adjuntar:
  //  'deposito'        — foto del panel del equipo: muestra cargas$ +
  //                      venta$ + transacciones (todo en una sola imagen)
  //  'venta'           — (legacy) foto separada para venta — opcional
  //  'bonificacion'    — foto del bono dado
  //  'bajada'          — comprobante de transferencia hecha (plata pagada)
  //                      se pueden adjuntar varios (hasta 10 por cierre)
  //  'pendiente_bank'  — screenshot del banco mostrando que la plata
  //                      pendiente SIGUE en la cuenta (defensa contra
  //                      plata faltante al confirmar)
  //  'ingreso'         — foto del préstamo recibido (plata extra que entró)
  //  'egreso'          — foto del préstamo hecho (plata que prestamos)
  //  'gasto'           — foto del gasto del día (ticket, factura, etc.)
  kind: {
    type: String,
    enum: ['deposito', 'venta', 'bonificacion', 'bajada', 'pendiente_bank', 'ingreso', 'egreso', 'gasto'],
    default: 'deposito'
  },
  // Slot del equipo asociado (0..6) — opcional. Cuando es null/undefined,
  // el comprobante aplica al sector completo, no a un equipo puntual.
  teamSlot: { type: Number, default: null, min: 0, max: 6 },
  note: { type: String, default: '' },
  uploadedAt: { type: Date, default: Date.now },
  uploadedBy: { type: String, default: '' }
}, { _id: false });

const closingSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  // YYYY-MM-DD hora Argentina
  dateKey: { type: String, required: true, index: true },

  sector: {
    type: String,
    enum: ['ganamos', 'publicidad', 'buffalo'],
    required: true,
    index: true
  },

  // Solo para sector 'buffalo': qué slot de equipo (0-6) y nombre editable.
  // El nombre se persiste en cada cierre para que aunque el owner lo
  // cambie en config, los cierres viejos mantengan el nombre con el que
  // se cargaron.
  teamSlot: { type: Number, default: null }, // 0..6 para buffalo
  teamName: { type: String, default: '', trim: true },

  // === Plata que entra ===
  depositsARS: { type: Number, default: 0 },
  // % que cobra el banco por cada depósito. Editable porque varía según
  // qué banco se usa ese día.
  bankMarginPercent: { type: Number, default: 0, min: 0, max: 100 },

  // === Plata que tiene que bajar (ventas a pagar) ===
  ventasARS: { type: Number, default: 0 },
  // Cuánto efectivamente bajó hoy (transferencias hechas).
  bajadaARS: { type: Number, default: 0 },
  // Plata que quedó pendiente del día ANTERIOR (arrastre). Setable manual
  // o se calcula automático leyendo el cierre del día previo.
  pendienteAnteriorARS: { type: Number, default: 0 },

  // Saldo INICIAL del día — plata que ya estaba en el CVU al arrancar
  // (carry-over de días anteriores). Se suma al CVU esperado al cierre:
  //   CVU al final = pendiente_a_bajar + saldo_inicial
  // Si no hay plata previa, queda en 0.
  saldoInicialARS: { type: Number, default: 0, min: 0 },
  saldoInicialNote: { type: String, default: '', trim: true },

  // === Movimientos extra del día ===
  // ingresosARS: plata que ENTRÓ extra (nos prestaron / movimos de otra cuenta)
  // egresosARS:  préstamos que HICIMOS (prestamos a alguien — vuelve después)
  // gastosARS:   gastos del día (consumido — NO vuelve: insumos, sueldos, etc.)
  // Los 3 afectan el saldo esperado del CVU al cierre. Cada uno tiene
  // un detalle (note) que el owner llena para auditoría.
  ingresosARS: { type: Number, default: 0, min: 0 },
  ingresosNote: { type: String, default: '', trim: true },
  egresosARS: { type: Number, default: 0, min: 0 },
  egresosNote: { type: String, default: '', trim: true },
  gastosARS: { type: Number, default: 0, min: 0 },
  gastosNote: { type: String, default: '', trim: true },

  // Saldo REAL del CVU/banco a las 00 hs (al cerrar el día).
  // Sirve para verificar: ¿coincide con el saldo esperado calculado?
  //   - Si coincide → todo cuadra.
  //   - Si hay menos → 🚨 PLATA FALTANTE (problema).
  //   - Si hay más  → sobra (revisar movimientos no registrados).
  cvuMidnightARS: { type: Number, default: 0, min: 0 },

  // === Bonificaciones / regalos ===
  bonusARS: { type: Number, default: 0 },
  bonusNote: { type: String, default: '', trim: true },

  // === Volumen operacional ===
  // Cantidad de transacciones procesadas ese día por el sector.
  // Sirve para tracking de actividad — ticket promedio, comparativas,
  // detectar caídas de volumen.
  transactionsCount: { type: Number, default: 0, min: 0 },

  // Cantidad de descargas (retiros / cash-outs) ese día. Permite calcular
  // descarga promedio (bajadaARS / withdrawalsCount).
  withdrawalsCount: { type: Number, default: 0, min: 0 },

  // Cantidad de bonificaciones entregadas ese día. Permite calcular
  // bonus promedio (bonusARS / bonusCount) y cuántos clientes recibieron.
  bonusCount: { type: Number, default: 0, min: 0 },

  // Sólo para sector Buffalo: array de 7 equipos. Los campos
  // depositsARS/ventasARS/bonusARS/bonusCount/transactionsCount del padre
  // se calculan como suma de los teams (no se editan directo). Los campos
  // bankMarginPercent/bajadaARS/pendienteAnteriorARS/withdrawalsCount del
  // padre son generales (compartidos por todo Buffalo, una sola bajada).
  teams: { type: [buffaloTeamSchema], default: undefined },

  // === Adjuntos: comprobantes de bajada + screenshots de banco ===
  comprobantes: { type: [comprobanteSchema], default: [] },

  // === Estado + auditoría ===
  status: {
    type: String,
    enum: ['draft', 'confirmed'],
    default: 'draft',
    index: true
  },
  confirmedAt: { type: Date, default: null },
  confirmedBy: { type: String, default: '' },
  lockedAt: { type: Date, default: null }, // confirmedAt + 24h
  // Tilde de "VERIFICADO" — el owner revisó el análisis post-confirm
  // y validó manualmente que el cierre dió OK. Es separado del confirm:
  // confirmed = pasó el gate de comprobantes; verified = el owner lo
  // revisó visualmente y dió el ok final.
  verifiedAt: { type: Date, default: null },
  verifiedBy: { type: String, default: '' },

  editHistory: { type: [editEntrySchema], default: [] },

  createdBy: { type: String, default: '' },
  notes: { type: String, default: '' }
}, { timestamps: true });

// Índices útiles
closingSchema.index({ dateKey: 1, sector: 1, teamSlot: 1 }, { unique: true, partialFilterExpression: { teamSlot: { $ne: null } } });
closingSchema.index({ dateKey: 1, sector: 1 }, { unique: true, partialFilterExpression: { teamSlot: null } });
closingSchema.index({ status: 1, dateKey: -1 });

module.exports = mongoose.models['ClosingEntry'] ||
  mongoose.model('ClosingEntry', closingSchema);
