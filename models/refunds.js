
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

// Próxima medianoche de ARGENTINA en ISO. ART es UTC−3 FIJO (el país no usa
// horario de verano), así que se puede construir el instante exacto.
// ⚠️ NO usar `setHours(0,0,0,0)`: eso da la medianoche de la zona del SERVER, que
// en Elastic Beanstalk es UTC → serían las 21:00 de Argentina.
function _nextArgentinaMidnightISO() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const parts = fmt.formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  const todayArtMidnight = new Date(`${y}-${m}-${d}T00:00:00-03:00`);
  return new Date(todayArtMidnight.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

// Verificar si el usuario puede reclamar reembolso diario.
// RESTAURADO 2026-08-14 a pedido del owner (se había eliminado el 2026-07-28 junto
// con el paso a rangos). Convive con semanal y mensual y usa el MISMO % del rango
// del mes (bronce/plata/oro), editable desde el panel.
//
// `periodDateStr` = el día que se va a reembolsar (AYER en horario Argentina,
// 'YYYY-MM-DD', lo da getYesterdayRangeArgentinaEpoch). Con ese dato se pregunta
// por el periodKey EXACTO, así esta puerta de UX coincide 1:1 con el candado real
// (índice único userId+type+periodKey).
//
// ⚠️ POR QUÉ NO se compara por "día calendario del server" (que es lo que hacía la
// versión vieja con `toDateString()`): en EB el proceso corre en UTC y Argentina es
// UTC−3, así que el día UTC arranca a las 21:00 ART. Un usuario que reclamaba a las
// 22:00 ART quedaba marcado como "ya reclamó hoy" hasta las 21:00 del día siguiente
// — falso bloqueo de ~21 h — y si no volvía después de esa hora PERDÍA el período
// para siempre. Preguntando por periodKey el problema desaparece.
async function canClaimDailyRefund(userId, periodDateStr = null) {
  try {
    if (periodDateStr) {
      const existing = await RefundClaim.findOne({
        userId,
        type: 'daily',
        periodKey: 'daily:' + periodDateStr
      }).lean();

      return {
        canClaim: !existing,
        nextClaim: existing ? _nextArgentinaMidnightISO() : null,
        lastClaim: existing ? existing.claimedAt : null
      };
    }

    // Fallback defensivo (no debería usarse: los dos callers pasan la fecha).
    // Compara por día ARGENTINO, no por el del server.
    const artDay = (dt) => new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Argentina/Buenos_Aires',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(dt);

    const lastDaily = await RefundClaim.findOne({ userId, type: 'daily' })
      .sort({ claimedAt: -1 })
      .lean();

    if (!lastDaily) return { canClaim: true, nextClaim: null, lastClaim: null };

    const canClaim = artDay(new Date(lastDaily.claimedAt)) !== artDay(new Date());
    return {
      canClaim,
      nextClaim: canClaim ? null : _nextArgentinaMidnightISO(),
      lastClaim: lastDaily.claimedAt
    };
  } catch (error) {
    console.error('Error verificando reembolso diario:', error);
    return { canClaim: false, nextClaim: null };
  }
}

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
  canClaimDailyRefund,
  canClaimWeeklyRefund,
  canClaimMonthlyRefund,
  recordRefund,
  calculateRefund,
  calculateRefundFromNetwin
};