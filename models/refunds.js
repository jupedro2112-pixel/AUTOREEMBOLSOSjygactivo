
// ============================================
// MODELO DE REEMBOLSOS - MONGODB
// ============================================

const { RefundClaim } = require('../config/database');

// Obtener reembolsos de un usuario
async function getUserRefunds(userId) {
  try {
    return await RefundClaim.find({ userId }).sort({ claimedAt: -1 }).lean();
  } catch (error) {
    console.error('Error obteniendo reembolsos del usuario:', error);
    return [];
  }
}

// Obtener todos los reembolsos (para admin)
async function getAllRefunds() {
  try {
    return await RefundClaim.find().sort({ claimedAt: -1 }).lean();
  } catch (error) {
    console.error('Error obteniendo todos los reembolsos:', error);
    return [];
  }
}

// TOMBSTONE (2026-07-28): canClaimDailyRefund ELIMINADA — el reembolso diario ya no
// existe (reemplazado por el sistema de rangos bronce/plata/oro en semanal/mensual).
// Rollback: git revert.

// Verificar si el usuario puede reclamar reembolso semanal
async function canClaimWeeklyRefund(userId) {
  try {
    const now = new Date();
    const currentDay = now.getDay(); // 0 = Domingo, 1 = Lunes, 2 = Martes
    
    // Solo puede reclamar lunes (1) o martes (2)
    const canClaimByDay = currentDay === 1 || currentDay === 2;
    
    // Verificar si ya reclamó esta semana
    const currentWeekStart = new Date(now);
    currentWeekStart.setDate(now.getDate() - currentDay + 1); // Lunes de esta semana
    currentWeekStart.setHours(0, 0, 0, 0);
    
    const lastWeekly = await RefundClaim.findOne({ 
      userId, 
      type: 'weekly' 
    }).sort({ claimedAt: -1 }).lean();
    
    let canClaim = canClaimByDay;
    
    if (lastWeekly) {
      const lastDate = new Date(lastWeekly.claimedAt);
      // Si ya reclamó esta semana, no puede reclamar de nuevo
      if (lastDate >= currentWeekStart) {
        canClaim = false;
      }
    }
    
    // Calcular próximo reclamo (próximo lunes)
    const nextMonday = new Date(now);
    const daysUntilMonday = currentDay === 0 ? 1 : 8 - currentDay;
    nextMonday.setDate(now.getDate() + daysUntilMonday);
    nextMonday.setHours(0, 0, 0, 0);
    
    return {
      canClaim,
      nextClaim: canClaim ? null : nextMonday.toISOString(),
      lastClaim: lastWeekly?.claimedAt || null,
      availableDays: 'Lunes y Martes'
    };
  } catch (error) {
    console.error('Error verificando reembolso semanal:', error);
    return { canClaim: false, nextClaim: null, availableDays: 'Lunes y Martes' };
  }
}

// Verificar si el usuario puede reclamar reembolso mensual
async function canClaimMonthlyRefund(userId) {
  try {
    const now = new Date();
    const currentDay = now.getDate();
    
    // Solo puede reclamar del día 7 en adelante
    const canClaimByDay = currentDay >= 7;
    
    // Verificar si ya reclamó este mes
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const lastMonthly = await RefundClaim.findOne({ 
      userId, 
      type: 'monthly' 
    }).sort({ claimedAt: -1 }).lean();
    
    let canClaim = canClaimByDay;
    
    if (lastMonthly) {
      const lastDate = new Date(lastMonthly.claimedAt);
      // Si ya reclamó este mes, no puede reclamar de nuevo
      if (lastDate >= currentMonthStart) {
        canClaim = false;
      }
    }
    
    // Calcular próximo reclamo (día 7 del próximo mes)
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 7);
    nextMonth.setHours(0, 0, 0, 0);
    
    return {
      canClaim,
      nextClaim: canClaim ? null : nextMonth.toISOString(),
      lastClaim: lastMonthly?.claimedAt || null,
      availableFrom: 'Día 7 de cada mes'
    };
  } catch (error) {
    console.error('Error verificando reembolso mensual:', error);
    return { canClaim: false, nextClaim: null, availableFrom: 'Día 7 de cada mes' };
  }
}

// Registrar un reembolso (ahora se hace directamente en el server.js)
// Esta función se mantiene por compatibilidad
async function recordRefund(userId, username, type, amount, netAmount, deposits, withdrawals) {
  try {
    const { v4: uuidv4 } = require('uuid');
    
    const refund = await RefundClaim.create({
      id: uuidv4(),
      userId,
      username,
      type,
      amount,
      netAmount,
      deposits,
      withdrawals,
      claimedAt: new Date()
    });
    
    return refund;
  } catch (error) {
    console.error('Error registrando reembolso:', error);
    return null;
  }
}

// Calcular reembolso
function calculateRefund(deposits, withdrawals, percentage) {
  const netAmount = Math.max(0, deposits - withdrawals);
  const refundAmount = netAmount * (percentage / 100);
  return {
    netAmount,
    refundAmount: Math.round(refundAmount),
    percentage
  };
}

// Calcular reembolso basado en NETWIN (GGR)
function calculateRefundFromNetwin(netwin, percentage) {
  const refundAmount = netwin > 0 ? Math.round(netwin * (percentage / 100)) : 0;
  return {
    netAmount: netwin,
    refundAmount,
    percentage
  };
}

module.exports = {
  getUserRefunds,
  getAllRefunds,
  canClaimWeeklyRefund,
  canClaimMonthlyRefund,
  recordRefund,
  calculateRefund,
  calculateRefundFromNetwin
};