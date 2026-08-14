
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
    enum: ['daily', 'weekly', 'monthly'], 
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
  // Rango del cliente al momento del reclamo (sistema bronce/plata/oro, 2026-07-28).
  // null en reclamos anteriores al sistema de rangos.
  tier: {
    type: String,
    enum: ['bronce', 'plata', 'oro', null],
    default: null
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
  }
}, {
  timestamps: true
});

// Índices para consultas frecuentes
refundClaimSchema.index({ userId: 1, type: 1 });
refundClaimSchema.index({ userId: 1, claimedAt: -1 });
refundClaimSchema.index({ claimedAt: -1 });
refundClaimSchema.index({ type: 1, claimedAt: -1 });
// Índice ÚNICO por período: es el candado REAL contra el doble cobro (ver #96 —
// se crea el RefundClaim ANTES de acreditar y el E11000 aborta el pago).
//
// ⚠️ Va con `partialFilterExpression`, NO con `sparse`. En un índice COMPUESTO,
// `sparse` sólo excluye el documento si le faltan TODOS los campos: como `userId`
// siempre está, los claims viejos con `periodKey` null quedaban indexados como
// null y, con dos o más, la construcción del índice fallaba EN SILENCIO → la app
// arrancaba sin ninguna protección contra doble cobro.
// Con el filtro parcial sólo entran los docs que tienen periodKey string, que son
// exactamente los que hay que proteger.
// El arranque de server.js repara el índice viejo si lo encuentra (busca
// "índice único de RefundClaim").
refundClaimSchema.index(
  { userId: 1, type: 1, periodKey: 1 },
  { unique: true, partialFilterExpression: { periodKey: { $type: 'string' } } }
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