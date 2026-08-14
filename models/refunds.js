
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

// ── Helpers de fecha ARGENTINA ────────────────────────────────────────────
// TODO lo que sea "qué día es hoy" tiene que resolverse en horario Argentina,
// NO en el del proceso: en Elastic Beanstalk el server corre en UTC y ART es
// UTC−3, así que el "día" del server arranca a las 21:00 de acá. Usar
// getDay()/getDate()/setHours() a secas corre las ventanas 3 horas.
// ART no tiene horario de verano (offset fijo −03:00), así que se puede
// construir el instante exacto con el string `...T00:00:00-03:00`.
const TZ_AR = 'America/Argentina/Buenos_Aires';

// Partes del día ARGENTINO para un instante dado.
function _artParts(date = new Date()) {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_AR, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date); // 'YYYY-MM-DD'
  const [y, m, d] = ymd.split('-').map(Number);
  // Día de la semana de ESE día calendario. Se usa el mediodía UTC para que
  // ningún corrimiento de zona lo empuje al día vecino.
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0=domingo
  return { ymd, y, m, d, dow };
}

// Instante exacto de la medianoche argentina de un 'YYYY-MM-DD'.
function _artMidnight(ymd) {
  return new Date(`${ymd}T00:00:00-03:00`);
}

// Suma días a un 'YYYY-MM-DD' (calendario puro, sin zonas).
function _addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const b = new Date(Date.UTC(y, m - 1, d));
  b.setUTCDate(b.getUTCDate() + n);
  return b.toISOString().slice(0, 10);
}

// Próxima medianoche de ARGENTINA en ISO.
function _nextArgentinaMidnightISO() {
  const { ymd } = _artParts();
  return _artMidnight(_addDays(ymd, 1)).toISOString();
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
// `periodDateStr` = LUNES ('YYYY-MM-DD') de la semana que se reembolsa (la
// pasada), tal como lo da getLastWeekRangeArgentinaEpoch. Con ese dato se
// pregunta por el periodKey EXACTO y la puerta coincide 1:1 con el candado.
async function canClaimWeeklyRefund(userId, periodDateStr = null) {
  try {
    const { ymd, dow } = _artParts();

    // Ventana: lunes (1) o martes (2), en día ARGENTINO.
    const canClaimByDay = dow === 1 || dow === 2;

    // Próximo lunes ART a las 00:00 (domingo → mañana).
    const nextMondayIso = _artMidnight(_addDays(ymd, dow === 0 ? 1 : 8 - dow)).toISOString();

    let already = null;
    if (periodDateStr) {
      already = await RefundClaim.findOne({
        userId, type: 'weekly', periodKey: 'weekly:' + periodDateStr
      }).lean();
    } else {
      // Fallback: ¿reclamó desde el lunes ART de esta semana?
      const mondayThisWeek = _artMidnight(_addDays(ymd, dow === 0 ? -6 : 1 - dow));
      already = await RefundClaim.findOne({
        userId, type: 'weekly', claimedAt: { $gte: mondayThisWeek }
      }).sort({ claimedAt: -1 }).lean();
    }

    const lastWeekly = already || await RefundClaim.findOne({ userId, type: 'weekly' })
      .sort({ claimedAt: -1 }).lean();

    const canClaim = canClaimByDay && !already;

    return {
      canClaim,
      nextClaim: canClaim ? null : nextMondayIso,
      lastClaim: lastWeekly?.claimedAt || null,
      availableDays: 'Lunes y Martes'
    };
  } catch (error) {
    console.error('Error verificando reembolso semanal:', error);
    return { canClaim: false, nextClaim: null, availableDays: 'Lunes y Martes' };
  }
}

// Verificar si el usuario puede reclamar reembolso mensual
// `periodMonthStr` = 'YYYY-MM' del mes que se reembolsa (el pasado).
async function canClaimMonthlyRefund(userId, periodMonthStr = null) {
  try {
    const { y, m, d } = _artParts();

    // Ventana: del día 7 en adelante, en día ARGENTINO.
    const canClaimByDay = d >= 7;

    // Día 7 del próximo mes, 00:00 ART.
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    const nextIso = _artMidnight(`${nextY}-${String(nextM).padStart(2, '0')}-07`).toISOString();

    let already = null;
    if (periodMonthStr) {
      already = await RefundClaim.findOne({
        userId, type: 'monthly', periodKey: 'monthly:' + periodMonthStr
      }).lean();
    } else {
      // Fallback: ¿reclamó desde el día 1 ART de este mes?
      const monthStart = _artMidnight(`${y}-${String(m).padStart(2, '0')}-01`);
      already = await RefundClaim.findOne({
        userId, type: 'monthly', claimedAt: { $gte: monthStart }
      }).sort({ claimedAt: -1 }).lean();
    }

    const lastMonthly = already || await RefundClaim.findOne({ userId, type: 'monthly' })
      .sort({ claimedAt: -1 }).lean();

    const canClaim = canClaimByDay && !already;

    return {
      canClaim,
      nextClaim: canClaim ? null : nextIso,
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