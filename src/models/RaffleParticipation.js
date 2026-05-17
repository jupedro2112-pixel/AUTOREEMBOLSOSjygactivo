/**
 * Participacion de un usuario en un sorteo PAGADO.
 *
 * Modelo MULTI-CUPO con numeros asignados: un user puede ocupar multiples
 * cupos en el MISMO sorteo. Cada cupo recibe un NUMERO UNICO secuencial
 * dentro del sorteo (1..totalTickets), guardado en `ticketNumbers`. Una
 * sola row per (raffleId, username) que acumula cuposCount + ticketNumbers
 * + total pagado cuando compra mas cupos.
 *
 * Ej.: sorteo de $1M con entryCost=15.000 y user que compra 4 numeros.
 * Recibe 4 numeros consecutivos: ej [42, 43, 44, 45]. El ganador se
 * determina por el 1er premio de la Loteria Nacional Nocturna del lunes
 * proximo: si sale el numero 44, este user gana.
 */
const mongoose = require('mongoose');

const raffleParticipationSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  raffleId: { type: String, required: true, index: true },
  username: { type: String, required: true, index: true, trim: true },
  joinedAt: { type: Date, default: Date.now, index: true },
  lastBoughtAt: { type: Date, default: Date.now },

  // Cantidad de cupos comprados por este user en este sorteo.
  // Cada cupo cuesta raffle.entryCost — se descuenta del budget.
  cuposCount: { type: Number, default: 1, min: 1 },

  // Números de cupo asignados a esta participación. Cada cupo comprado
  // recibe un número único secuencial dentro del sorteo (1..totalTickets).
  // El ganador se elige cuando la Lotería Nacional saca un número que
  // está en el `ticketNumbers` de alguna participación.
  ticketNumbers: { type: [Number], default: [] },

  // Snapshot del total pagado y del netwin al primer join (auditoria).
  // entryCostPaid representa el TOTAL acumulado (cuposCount * entryCost),
  // se mantiene para que el budget calc por sumatoria siga funcionando.
  entryCostPaid: { type: Number, required: true, min: 0 },
  netwinAtEntry: { type: Number, default: 0 },

  // Resultado: si este user gano (con cualquiera de sus cupos).
  isWinner: { type: Boolean, default: false },

  // Reembolso: si este user ya recibio reembolso en un cancel/purge.
  // Se setea atomicamente antes de llamar a creditUserBalance para que
  // un re-execute del cancel no reembolse dos veces.
  refundedAt: { type: Date, default: null, index: true },
  refundedAmount: { type: Number, default: 0 },
  refundedTxId: { type: String, default: null },

  // Legacy (modelo loss-credit anterior, no se usa en el flow paid actual).
  blocked: { type: Boolean, default: false },
  blockedReason: { type: String, default: null, maxlength: 300 },
  blockedBy: { type: String, default: null },
  blockedAt: { type: Date, default: null }
}, { timestamps: true });

raffleParticipationSchema.index({ raffleId: 1, username: 1 }, { unique: true });

module.exports = mongoose.models['RaffleParticipation'] ||
  mongoose.model('RaffleParticipation', raffleParticipationSchema);
