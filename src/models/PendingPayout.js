/**
 * Modelo de Pago Pendiente (retiro a pagar)
 *
 * Cuando un cliente hace un retiro self-service (ya se le descontó el saldo en
 * JUGAYGANA), se crea un PendingPayout con sus datos bancarios. Un AGENTE lo
 * verifica en la sección Pagos y, al confirmar, se paga AUTOMÁTICAMENTE al CBU del
 * cliente vía la API de hgcash (cash-out). Registro permanente (sin TTL).
 */
const mongoose = require('mongoose');

const pendingPayoutSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  userId: { type: String, index: true },
  username: { type: String, index: true, trim: true },

  amount: { type: Number, required: true },
  // Datos bancarios cargados por el cliente en el self-retiro.
  titular: { type: String, default: null, trim: true },
  cbu: { type: String, default: null, trim: true },     // CBU/CVU (puede venir alias)
  alias: { type: String, default: null, trim: true },

  // Estado del pago
  status: {
    type: String,
    // pending_review: esperando que el agente verifique y confirme
    // paying: se llamó al cash-out, esperando confirmación de hgcash
    // paid: hgcash confirmó el pago (DONE)
    // failed: el cash-out falló (ERROR/CANCELLED) → revisar/reintentar
    // cancelled: el agente lo rechazó (no se paga; el saldo ya fue descontado)
    enum: ['pending_review', 'paying', 'paid', 'failed', 'cancelled'],
    default: 'pending_review',
    index: true
  },

  // Datos del cash-out en hgcash
  hgTransactionId: { type: String, default: null, index: true }, // id del REQUEST del cash-out (createCashOut)
  hgTxId: { type: String, default: null },                       // id de la TRANSACCIÓN real (ledger) → para el comprobante PDF
  receiptSentAt: { type: Date, default: null },                  // cuándo se le envió el comprobante PDF al cliente (idempotencia)
  hgStatus: { type: String, default: null },                     // PENDING/PROCESSING/DONE/ERROR...
  hgAccountKey: { type: String, default: null },                 // #194 perfil de cuenta hgcash que pagó (su token consulta estado/recibo aunque se rote)
  // #202 Finpro (paidVia 'finpro'): un payout = un proceso (`process_id` uuid) con una transferencia.
  fpProcessId: { type: String, default: null, index: true },     // process_id del lote en Finpro (se reusa SOLO si fpAccepted)
  fpTransactionId: { type: String, default: null },              // transaction_id (≤ 11 chars, determinístico del payout.id)
  fpCoelsaId: { type: String, default: null, index: true },      // coelsa_id del resultado = "número de comprobante" para el operador
  fpAccepted: { type: Boolean, default: null },                  // true = Finpro aceptó el lote (0201); false = rechazado; null = sin respuesta / no enviado
  hgSendUnknown: { type: Boolean, default: false }, // #202 el envío a hgcash quedó SIN respuesta (no se sabe si salió): frena pagarlo por el otro banco sin confirmar
  fpAccountKey: { type: String, default: null },                 // perfil de cuenta Finpro que pagó (sus credenciales consultan el estado aunque se rote)
  resolvedCbu: { type: String, default: null },                  // CBU/CVU 22 díg. usado para pagar
  lookupName: { type: String, default: null },                   // titular real del CBU (alias-lookup)

  // Auditoría
  paidBy: { type: String, default: null },   // agente que confirmó
  paidAt: { type: Date, default: null },
  error: { type: String, default: null },
  // Forma de pago: 'hgcash' (automático) | 'other_bank' (pagado manual por otro banco)
  paidVia: { type: String, default: null },
  // Si al rechazar se le devolvieron las fichas al cliente (re-crédito en JUGAYGANA)
  chipsReturned: { type: Boolean, default: false },
  refundTxId: { type: String, default: null }, // Transaction del re-crédito de fichas
  // Link al retiro original (Transaction)
  withdrawalTxId: { type: String, default: null },

  // ANTI RETIRO FANTASMA: confirmación de que el descuento en JUGAYGANA ocurrió de
  // verdad al solicitar el retiro. JUGAYGANA puede devolver "éxito" sin descontar
  // (saldo del listado ShowUsers desactualizado tras un pago grande → WithdrawMoney
  // falso-positivo). balanceBefore/After son las lecturas de saldo antes/después del
  // retiro; debitConfirmed=true SÓLO si el saldo bajó al menos el monto retirado.
  // Si es false → el RECHAZO no devuelve fichas a ciegas (devolverlas acuñaría saldo
  // que el cliente nunca tuvo descontado). null = pago viejo previo a esta verificación.
  balanceBefore: { type: Number, default: null },
  balanceAfter: { type: Number, default: null },
  debitConfirmed: { type: Boolean, default: null },

  // FLUJO NUEVO: descontar las fichas al CONFIRMAR el pago (no al solicitarlo). Si es
  // true, el self-retiro NO descontó nada al pedir; el descuento ocurre en /pay (o
  // /pay-other-bank). Si es false/undefined = pago viejo (fichas ya descontadas al
  // solicitar) → mantiene el comportamiento previo (no re-descontar; devolver al rechazar).
  deductAtPay: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now, index: true }
}, {
  timestamps: true
});

pendingPayoutSchema.index({ userId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.models['PendingPayout'] || mongoose.model('PendingPayout', pendingPayoutSchema);
