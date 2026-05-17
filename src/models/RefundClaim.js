
/**
 * Modelo de Reclamos de Reembolso
 * Gestiona reembolsos diarios, semanales y mensuales
 */
const mongoose = require('mongoose');

const refundClaimSchema = new mongoose.Schema({
  id: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  userId: { 
    type: String, 
    required: true, 
    index: true 
  },
  username: { 
    type: String, 
    required: true, 
    index: true,
    trim: true
  },
  type: {
    type: String,
    enum: ['daily', 'weekly', 'monthly', 'welcome_install'],
    required: true,
    index: true
  },
  amount: { 
    type: Number, 
    required: true,
    min: 0
  },
  netAmount: { 
    type: Number, 
    required: true 
  },
  percentage: { 
    type: Number, 
    required: true,
    min: 0,
    max: 100
  },
  deposits: { 
    type: Number, 
    default: 0,
    min: 0
  },
  withdrawals: { 
    type: Number, 
    default: 0,
    min: 0
  },
  period: { 
    type: String, 
    default: '',
    trim: true
  },
  periodKey: {
    type: String,
    default: null,
    trim: true
  },
  transactionId: { 
    type: String, 
    default: null,
    index: true
  },
  claimedAt: {
    type: Date,
    default: Date.now,
    index: true,
    immutable: true
  },
  // Estado del reclamo. 'completed' = credito en JUGAYGANA confirmado.
  // 'pending_credit_failed' = el RefundClaim fue insertado pero el credito
  // a JUGAYGANA fallo o no pudo confirmarse (puede haber sido aplicado y
  // perdido en el cable). NO se reemite credito hasta que un admin reconcilie
  // contra JUGAYGANA y resuelva (eliminar el row si el credito no aplico, o
  // marcar 'completed' si si aplico).
  status: {
    type: String,
    // 'pending'              → claim creado, credit a JUGAYGANA en vuelo
    //                          (estado intermedio del welcome bonus claim).
    // 'completed'            → credit aplicado y confirmado.
    // 'pending_credit_failed'→ credit fallo o no se pudo confirmar; el admin
    //                          debe reconciliar manualmente contra JUGAYGANA.
    enum: ['pending', 'completed', 'pending_credit_failed'],
    default: 'completed',
    index: true
  },
  // Texto del error reportado por JUGAYGANA si status === 'pending_credit_failed'.
  creditError: {
    type: String,
    default: null
  },
  // Snapshot post-claim: cantidad de cargas reales (depósitos en JUGAYGANA,
  // excluyendo bonos nuestros) que el usuario hizo DESPUÉS de claimedAt.
  // Se popula cuando el admin toca "Refrescar cargas" (endpoint
  // /api/admin/reports/welcome-bonus/refresh-charges) consultando los
  // movimientos de JUGAYGANA. Persiste por claim para que el reporte sea
  // estable y rápido (no requiere consulta a JUGAYGANA por render).
  chargesAfterClaim: { type: Number, default: 0, min: 0 },
  chargesAfterClaimAmount: { type: Number, default: 0, min: 0 },
  lastChargeAfterClaimAt: { type: Date, default: null },
  chargesAfterClaimCheckedAt: { type: Date, default: null },

  // IP del cliente al momento del claim. Se usa para anti-fraude del welcome
  // bonus: bloqueamos múltiples claims desde la misma IP (uninstall +
  // reinstall + cuenta JUGAYGANA nueva → mismo router/red).
  clientIp: { type: String, default: null, index: true },
  // Huella del dispositivo (hash SHA-256 del UA + pantalla + idioma + tz +
  // canvas hash) al momento del claim. Permite detectar el mismo dispositivo
  // aunque el user borre caché/cookies y cree cuenta nueva. Si otro usuario
  // intenta reclamar con la misma huella → fraudBlocked.
  deviceFingerprint: { type: String, default: null, index: true }
}, {
  timestamps: true
});

// Índices para consultas frecuentes
refundClaimSchema.index({ userId: 1, type: 1 });
refundClaimSchema.index({ userId: 1, claimedAt: -1 });
refundClaimSchema.index({ claimedAt: -1 });
refundClaimSchema.index({ type: 1, claimedAt: -1 });
// Indice unique por periodo para prevenir doble reclamo. Usamos
// partialFilterExpression en lugar de sparse: en un indice compuesto, sparse
// solo excluye documentos donde TODOS los campos estan ausentes, lo cual no
// se cumple aca porque userId/username/type son required. partialFilterExpression
// es el mecanismo correcto: indexa SOLO los rows con periodKey string (los
// rows viejos con periodKey null quedan fuera del indice y no rompen su build).
refundClaimSchema.index(
  { userId: 1, type: 1, periodKey: 1 },
  {
    name: 'unique_userId_type_periodKey_v2',
    unique: true,
    partialFilterExpression: { periodKey: { $exists: true, $type: 'string' } }
  }
);
// Indice unique adicional sobre username + type + periodKey. Defensa en
// profundidad: aunque el userId varie por algun bug futuro (login que crea
// nuevo record local, etc.), el username sigue siendo barrera atomica.
refundClaimSchema.index(
  { username: 1, type: 1, periodKey: 1 },
  {
    name: 'unique_username_type_periodKey_v2',
    unique: true,
    partialFilterExpression: { periodKey: { $exists: true, $type: 'string' } }
  }
);

// Método estático para verificar si puede reclamar
refundClaimSchema.statics.canClaim = async function(userId, type) {
  const now = new Date();
  let startDate;
  
  switch(type) {
    case 'daily':
      startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      break;
    case 'weekly':
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'monthly':
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    default:
      return { canClaim: false, reason: 'Tipo inválido' };
  }
  
  const lastClaim = await this.findOne({
    userId,
    type,
    claimedAt: { $gte: startDate }
  }).sort({ claimedAt: -1 });
  
  if (lastClaim) {
    const nextClaim = new Date(lastClaim.claimedAt.getTime());
    switch(type) {
      case 'daily':
        nextClaim.setDate(nextClaim.getDate() + 1);
        break;
      case 'weekly':
        nextClaim.setDate(nextClaim.getDate() + 7);
        break;
      case 'monthly':
        nextClaim.setDate(nextClaim.getDate() + 30);
        break;
    }
    
    return {
      canClaim: false,
      lastClaim: lastClaim.claimedAt,
      nextClaim,
      message: `Ya reclamaste tu reembolso ${type}. Próximo disponible: ${nextClaim.toLocaleDateString()}`
    };
  }
  
  return { canClaim: true };
};

// Método estático para obtener historial de usuario
refundClaimSchema.statics.getUserHistory = function(userId, options = {}) {
  const { limit = 50 } = options;
  
  return this.find({ userId })
    .sort({ claimedAt: -1 })
    .limit(limit)
    .lean();
};

// Método estático para obtener resumen
refundClaimSchema.statics.getSummary = async function() {
  return this.aggregate([
    {
      $group: {
        _id: '$type',
        totalAmount: { $sum: '$amount' },
        count: { $sum: 1 },
        avgAmount: { $avg: '$amount' }
      }
    }
  ]);
};

module.exports = mongoose.models['RefundClaim'] || mongoose.model('RefundClaim', refundClaimSchema);