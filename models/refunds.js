
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

// Helpers de fecha en zona Argentina (Render corre en UTC).
function _argDateString(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}
function _argDayOfWeek(d) {
  // 0=domingo, 1=lunes, ..., 6=sábado — calculado en TZ Argentina.
  const partsFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short'
  });
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[partsFmt.format(d)];
}
function _argDayOfMonth(d) {
  const s = _argDateString(d); // YYYY-MM-DD
  return parseInt(s.split('-')[2], 10);
}
function _argMonthStart(d) {
  const [y, m] = _argDateString(d).split('-');
  return new Date(`${y}-${m}-01T00:00:00-03:00`);
}
function _argWeekStart(d) {
  // Lunes de la semana actual en ARG.
  const dow = _argDayOfWeek(d);
  const offset = dow === 0 ? 6 : dow - 1;
  const dateStr = _argDateString(d);
  const todayMidnight = new Date(`${dateStr}T00:00:00-03:00`);
  return new Date(todayMidnight.getTime() - offset * 24 * 60 * 60 * 1000);
}

// Verificar si el usuario puede reclamar reembolso diario
async function canClaimDailyRefund(userId) {
  try {
    const now = new Date();
    const todayArg = _argDateString(now);

    const lastDaily = await RefundClaim.findOne({
      userId,
      type: 'daily'
    }).sort({ claimedAt: -1 }).lean();

    // Próximo reclamo: mañana 00:00 ARG (UTC-3).
    const [y, m, d] = todayArg.split('-');
    const tomorrowArg = new Date(`${y}-${m}-${d}T00:00:00-03:00`);
    tomorrowArg.setUTCDate(tomorrowArg.getUTCDate() + 1);

    if (!lastDaily) {
      return { canClaim: true, claimed: false, nextClaim: null, lastClaim: null };
    }

    const lastDateArg = _argDateString(new Date(lastDaily.claimedAt));
    const claimed = lastDateArg === todayArg;

    return {
      canClaim: !claimed,
      claimed,
      nextClaim: claimed ? tomorrowArg.toISOString() : null,
      lastClaim: lastDaily.claimedAt,
      lastClaimAmount: lastDaily.amount || 0
    };
  } catch (error) {
    console.error('Error verificando reembolso diario:', error);
    return { canClaim: false, claimed: false, nextClaim: null };
  }
}

// Verificar si el usuario puede reclamar reembolso semanal
// Ventana: lunes y martes (TZ Argentina). 1 reclamo por semana calendario (lun-dom).
async function canClaimWeeklyRefund(userId) {
  try {
    const now = new Date();
    const dow = _argDayOfWeek(now);
    const canClaimByDay = dow === 1 || dow === 2;
    const currentWeekStart = _argWeekStart(now);

    const lastWeekly = await RefundClaim.findOne({
      userId,
      type: 'weekly'
    }).sort({ claimedAt: -1 }).lean();

    const claimed = !!(lastWeekly && new Date(lastWeekly.claimedAt) >= currentWeekStart);
    const canClaim = canClaimByDay && !claimed;

    // Próximo lunes 00:00 ARG.
    const daysUntilMonday = dow === 0 ? 1 : 8 - dow;
    const nextMonday = new Date(currentWeekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

    return {
      canClaim,
      claimed,
      nextClaim: canClaim ? null : nextMonday.toISOString(),
      lastClaim: lastWeekly?.claimedAt || null,
      lastClaimAmount: lastWeekly?.amount || 0,
      availableDays: 'Lunes y Martes'
    };
  } catch (error) {
    console.error('Error verificando reembolso semanal:', error);
    return { canClaim: false, claimed: false, nextClaim: null, availableDays: 'Lunes y Martes' };
  }
}

// Verificar si el usuario puede reclamar reembolso mensual
// Ventana: día 7 al 15 de cada mes (TZ Argentina), para los movimientos
// del mes anterior. 1 reclamo por mes calendario.
const MONTHLY_WINDOW_START = 7;
const MONTHLY_WINDOW_END = 15;
async function canClaimMonthlyRefund(userId) {
  try {
    const now = new Date();
    const currentDay = _argDayOfMonth(now);
    const canClaimByDay = currentDay >= MONTHLY_WINDOW_START && currentDay <= MONTHLY_WINDOW_END;
    const currentMonthStart = _argMonthStart(now);

    const lastMonthly = await RefundClaim.findOne({
      userId,
      type: 'monthly'
    }).sort({ claimedAt: -1 }).lean();

    const claimed = !!(lastMonthly && new Date(lastMonthly.claimedAt) >= currentMonthStart);
    const canClaim = canClaimByDay && !claimed;

    // Próxima ventana: si todavía no llegó al día 7 de este mes y no
    // reclamó, es día 7 de este mes; en cualquier otro caso (ya pasó la
    // ventana o ya reclamó) es día 7 del mes próximo.
    const [yStr, mStr] = _argDateString(now).split('-');
    let nextClaimDate;
    if (currentDay < MONTHLY_WINDOW_START && !claimed) {
      nextClaimDate = new Date(`${yStr}-${mStr}-${String(MONTHLY_WINDOW_START).padStart(2, '0')}T00:00:00-03:00`);
    } else {
      let yNext = parseInt(yStr, 10);
      let mNext = parseInt(mStr, 10) + 1;
      if (mNext > 12) { mNext = 1; yNext += 1; }
      nextClaimDate = new Date(`${yNext}-${String(mNext).padStart(2, '0')}-${String(MONTHLY_WINDOW_START).padStart(2, '0')}T00:00:00-03:00`);
    }

    return {
      canClaim,
      claimed,
      nextClaim: canClaim ? null : nextClaimDate.toISOString(),
      lastClaim: lastMonthly?.claimedAt || null,
      lastClaimAmount: lastMonthly?.amount || 0,
      availableFrom: `Día ${MONTHLY_WINDOW_START} al ${MONTHLY_WINDOW_END} de cada mes`
    };
  } catch (error) {
    console.error('Error verificando reembolso mensual:', error);
    return { canClaim: false, claimed: false, nextClaim: null, availableFrom: `Día ${MONTHLY_WINDOW_START} al ${MONTHLY_WINDOW_END} de cada mes` };
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