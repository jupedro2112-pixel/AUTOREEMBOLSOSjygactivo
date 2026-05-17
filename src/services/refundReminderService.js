/**
 * Refund Reminder Service
 *
 * Manda push a los usuarios que TIENEN un reembolso para reclamar
 * (daily/weekly/monthly) y todavía no lo reclamaron en el período actual.
 *
 * Computa elegibilidad usando DailyPlayerStats (no JUGAYGANA per-user
 * que es lentísimo): suma deposits - withdrawals en la ventana del
 * período. Si netLoss > 0 → tiene plata para reclamar.
 *
 * Cross-referencia con RefundClaim type=X, periodKey=current → excluye
 * los que ya reclamaron.
 *
 * Respeta cap semanal + cooldown del config global de estrategia (los
 * users que ya recibieron 2 pushes esta semana NO se les manda).
 */
const { v4: uuidv4 } = require('uuid');

// Argentina day key in YYYY-MM-DD.
function _argDayKey(date = new Date()) {
  const ms = date.getTime() - 3 * 60 * 60 * 1000; // ART = UTC-3
  return new Date(ms).toISOString().slice(0, 10);
}

// ISO week key like 2026-W18 in ART.
function _argWeekKey(date = new Date()) {
  const ms = date.getTime() - 3 * 60 * 60 * 1000;
  const d = new Date(ms);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Month key YYYY-MM in ART.
function _argMonthKey(date = new Date()) {
  const ms = date.getTime() - 3 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 7);
}

// Devuelve la ventana de fechas (start/end UTC) que cuenta para cada tipo.
//   daily   = AYER en ART (00:00 ART ayer hasta 00:00 ART hoy)
//   weekly  = SEMANA PASADA en ART (Lun a Dom anteriores)
//   monthly = MES PASADO en ART (1 al último del mes anterior)
function _periodWindow(type, now = new Date()) {
  const ART_OFFSET_MS = 3 * 60 * 60 * 1000;
  const localMs = now.getTime() - ART_OFFSET_MS;
  const local = new Date(localMs);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();

  if (type === 'daily') {
    // Ayer en ART: [hoy 00:00 ART - 1 día, hoy 00:00 ART)
    const todayStartArtUtc = Date.UTC(y, m, d) + ART_OFFSET_MS;
    return {
      start: new Date(todayStartArtUtc - 24 * 3600 * 1000),
      end: new Date(todayStartArtUtc - 1)
    };
  }
  if (type === 'weekly') {
    // Semana pasada Lun-Dom en ART. Lunes de la semana actual en ART:
    const dayNum = (local.getUTCDay() + 6) % 7; // lun=0 .. dom=6
    const thisMondayArtUtc = Date.UTC(y, m, d - dayNum) + ART_OFFSET_MS;
    return {
      start: new Date(thisMondayArtUtc - 7 * 24 * 3600 * 1000),
      end: new Date(thisMondayArtUtc - 1)
    };
  }
  if (type === 'monthly') {
    // Mes pasado en ART.
    const thisMonth1ArtUtc = Date.UTC(y, m, 1) + ART_OFFSET_MS;
    const lastMonth1ArtUtc = Date.UTC(y, m - 1, 1) + ART_OFFSET_MS;
    return {
      start: new Date(lastMonth1ArtUtc),
      end: new Date(thisMonth1ArtUtc - 1)
    };
  }
  return null;
}

const _PERCENTAGES = { daily: 0.08, weekly: 0.05, monthly: 0.03 };

// El periodKey actual (mismo formato que computePeriodKey en server.js).
function _currentPeriodKey(type, now = new Date()) {
  if (type === 'daily') return _argDayKey(now);
  if (type === 'weekly') return _argWeekKey(now);
  if (type === 'monthly') return _argMonthKey(now);
  return null;
}

// ============================================
// COMPUTAR AUDIENCIA
// ============================================
/**
 * Devuelve usernames con: app+notifs, netLoss>0 en el período, NO
 * reclamado todavía, opcionalmente filtrado por equipo.
 *
 * @returns { usernames, totals: { eligible, alreadyClaimed, withoutChannel } }
 */
async function computeRefundReminderAudience({ type, teamFilter, models, weeklyService, logger }) {
  const { User, DailyPlayerStats, RefundClaim } = models;
  const window = _periodWindow(type);
  if (!window) throw new Error(`type inválido: ${type}`);
  const periodKey = _currentPeriodKey(type);

  // 1) Aggregate en DailyPlayerStats: usuarios con netLoss > 0.
  const stats = await DailyPlayerStats.aggregate([
    { $match: { dateUtc: { $gte: window.start, $lte: window.end } } },
    {
      $group: {
        _id: '$username',
        deposits: { $sum: '$depositSum' },
        withdrawals: { $sum: '$withdrawSum' }
      }
    },
    { $project: { netLoss: { $subtract: ['$deposits', '$withdrawals'] }, deposits: 1, withdrawals: 1 } },
    { $match: { netLoss: { $gt: 0 } } }
  ]);

  if (stats.length === 0) return { usernames: [], totals: { eligible: 0, alreadyClaimed: 0, withoutChannel: 0, blocked: 0 }, periodKey, window, perUser: [] };

  const eligibleUsernames = stats.map(s => s._id);
  const eligibleSet = new Set(eligibleUsernames.map(u => u.toLowerCase()));

  // 2) Pull users con app+notifs, role='user', opcionalmente equipo.
  const userQuery = { ...weeklyService.APP_NOTIFS_FILTER, username: { $in: eligibleUsernames } };
  if (teamFilter) userQuery.lineTeamName = teamFilter;
  const eligibleUsers = await User.find(userQuery, { username: 1, lineTeamName: 1, _id: 0 }).lean();
  const eligibleUsersSet = new Set(eligibleUsers.map(u => u.username.toLowerCase()));
  const withoutChannel = eligibleUsernames.length - eligibleUsersSet.size;

  // 3) Excluir los que ya reclamaron (RefundClaim type=X, periodKey=current).
  const claimed = await RefundClaim.find(
    { type, periodKey, username: { $in: eligibleUsers.map(u => u.username) } },
    { username: 1, _id: 0 }
  ).lean();
  const claimedSet = new Set(claimed.map(c => String(c.username).toLowerCase()));

  // 4) Final: elegibles - reclamados.
  const finalUsers = eligibleUsers.filter(u => !claimedSet.has(u.username.toLowerCase()));

  // Per-user data para el preview (monto sugerido).
  const statsByUser = new Map();
  for (const s of stats) statsByUser.set(s._id.toLowerCase(), s);
  const perUser = finalUsers.map(u => {
    const s = statsByUser.get(u.username.toLowerCase()) || {};
    const netLoss = Math.max(0, (s.deposits || 0) - (s.withdrawals || 0));
    const potentialAmount = Math.round(netLoss * _PERCENTAGES[type]);
    return {
      username: u.username,
      lineTeamName: u.lineTeamName || null,
      netLoss,
      potentialAmount
    };
  });
  perUser.sort((a, b) => b.potentialAmount - a.potentialAmount);

  return {
    usernames: finalUsers.map(u => u.username),
    totals: {
      eligible: eligibleUsernames.length,
      withoutChannel,
      alreadyClaimed: claimedSet.size,
      blocked: 0, // se llena en runRefundReminder con cap+cooldown
      finalAudience: finalUsers.length
    },
    periodKey,
    window,
    perUser
  };
}

// ============================================
// EJECUTAR
// ============================================
const _DEFAULT_COPY = {
  daily: {
    title: '💰 Tu reembolso de ayer te espera',
    body: 'No te olvides — pasá por la app y reclamalo antes de que se pierda.'
  },
  weekly: {
    title: '📅 Reembolso semanal disponible',
    body: 'Tenés tu reembolso de la semana pasada esperándote. Reclamalo en la app.'
  },
  monthly: {
    title: '🏆 Reembolso mensual sin reclamar',
    body: 'Tu reembolso del mes pasado todavía está. Pasá por la app y cobralo.'
  }
};

async function runRefundReminder({
  type, teamFilter, models, weeklyService, sendPushFn,
  logger, force = false, manualTrigger = false,
  customTitle = null, customBody = null
}) {
  const { User, NotificationHistory, RefundReminderConfig, WeeklyStrategyConfig, WeeklyNotifBudget } = models;
  if (!['daily','weekly','monthly'].includes(type)) {
    throw new Error(`type inválido: ${type}`);
  }

  const cfg = await RefundReminderConfig.findOne({ id: 'main' }) || await RefundReminderConfig.create({ id: 'main' });
  const sub = cfg[type];
  if (!sub.enabled && !force) {
    return { skipped: 'config-disabled', type };
  }

  // Lock por día: si ya disparamos hoy, skipeamos (a menos que force=true).
  const todayKey = _argDayKey();
  if (!force && sub.lastFiredKey === todayKey) {
    return { skipped: 'already-fired-today', type, lastFiredKey: sub.lastFiredKey };
  }

  // 1) Audiencia.
  const audience = await computeRefundReminderAudience({
    type, teamFilter: teamFilter || sub.teamFilter || null,
    models, weeklyService, logger
  });

  if (audience.usernames.length === 0) {
    if (!force) {
      cfg[type].lastFiredKey = todayKey;
      cfg[type].lastFiredAt = new Date();
      await cfg.save();
    }
    return { skipped: 'audience-empty', type, totals: audience.totals };
  }

  // 2) Cap+cooldown gate (reusa weeklyStrategyService).
  const wkKey = weeklyService._weekKey();
  const config = await weeklyService.getOrCreateConfig(WeeklyStrategyConfig);
  const targets = [];
  let blocked = 0;
  for (const u of audience.usernames) {
    const gate = await weeklyService.canSendToUser({
      username: u,
      weekKey: wkKey,
      cooldownHours: config.cooldownHours,
      capPerUser: config.capPerUserPerWeek,
      WeeklyNotifBudget
    });
    if (gate.ok) targets.push(u);
    else blocked++;
  }
  audience.totals.blocked = blocked;

  if (targets.length === 0) {
    return { skipped: 'all-blocked-by-cap', type, totals: audience.totals };
  }

  // 3) Re-check de elegibilidad (alguien revocó permisos en el ínterin).
  const stillEligible = await weeklyService.filterToEligibleUsernames(User, targets);
  if (stillEligible.length === 0) {
    return { skipped: 'no-eligible-after-recheck', type };
  }

  // 4) Mandar push.
  const title = (customTitle || sub.customTitle || _DEFAULT_COPY[type].title).slice(0, 200);
  const body = (customBody || sub.customBody || _DEFAULT_COPY[type].body).slice(0, 500);
  const historyId = uuidv4();
  const data = {
    source: 'refund-reminder',
    refundType: type,
    historyId
  };
  let sendResult = { successCount: 0, failureCount: 0, error: null };
  try {
    sendResult = await sendPushFn(
      User, title, body, data,
      { username: { $in: stillEligible } }
    );
  } catch (err) {
    sendResult.error = err.message;
  }

  // 5) Registrar history + bump cap.
  await NotificationHistory.create({
    id: historyId,
    sentAt: new Date(),
    audienceType: 'list',
    audienceCount: stillEligible.length,
    title, body,
    type: 'plain',
    totalUsers: sendResult.totalUsers || stillEligible.length,
    successCount: sendResult.successCount || 0,
    failureCount: sendResult.failureCount || 0,
    cleanedTokens: sendResult.cleanedTokens || 0,
    strategyType: 'refund-reminder-' + type,
    strategyMeta: {
      type, teamFilter: teamFilter || sub.teamFilter || null,
      periodKey: audience.periodKey,
      totals: audience.totals
    },
    audienceUsernames: stillEligible,
    sentBy: manualTrigger ? `manual:${manualTrigger}` : 'cron-refund-reminder'
  });

  for (const u of stillEligible) {
    await weeklyService.recordSent({
      username: u, weekKey: wkKey,
      type: 'refund-reminder-' + type,
      historyId,
      WeeklyNotifBudget
    });
  }

  // 6) Marcar fired.
  if (!force) {
    cfg[type].lastFiredKey = todayKey;
    cfg[type].lastFiredAt = new Date();
    cfg[type].totalFiresAllTime = (cfg[type].totalFiresAllTime || 0) + 1;
    await cfg.save();
  }

  return {
    success: true,
    type, historyId,
    sentCount: sendResult.successCount || 0,
    failureCount: sendResult.failureCount || 0,
    audienceTotals: audience.totals,
    periodKey: audience.periodKey
  };
}

// ============================================
// CRON CHECK
// ============================================
/**
 * Tick cada N minutos. Para cada tipo (daily/weekly/monthly) chequea si
 * hourART:minuteART ya pasó hoy y todavía no se disparó.
 */
async function checkAndFireRefundReminders({ models, weeklyService, sendPushFn, logger }) {
  const cfg = await models.RefundReminderConfig.findOne({ id: 'main' });
  if (!cfg) return { skipped: 'no-config' };

  const now = new Date();
  const localMs = now.getTime() - 3 * 60 * 60 * 1000;
  const local = new Date(localMs);
  const nowHourART = local.getUTCHours();
  const nowMinuteART = local.getUTCMinutes();
  const todayKey = _argDayKey(now);
  const results = {};

  for (const type of ['daily', 'weekly', 'monthly']) {
    const sub = cfg[type];
    if (!sub.enabled) { results[type] = 'disabled'; continue; }
    if (sub.lastFiredKey === todayKey) { results[type] = 'already-fired-today'; continue; }

    // Comparamos como minutos del día.
    const nowMinTotal = nowHourART * 60 + nowMinuteART;
    const targetMinTotal = sub.hourART * 60 + sub.minuteART;
    if (nowMinTotal < targetMinTotal) { results[type] = `not-yet (${nowHourART}:${String(nowMinuteART).padStart(2,'0')} < ${sub.hourART}:${String(sub.minuteART).padStart(2,'0')})`; continue; }

    try {
      const r = await runRefundReminder({
        type, models, weeklyService, sendPushFn, logger
      });
      results[type] = r;
    } catch (err) {
      logger && logger.error(`[refund-reminder] ${type} error: ${err.message}`);
      results[type] = { error: err.message };
    }
  }
  return results;
}

module.exports = {
  computeRefundReminderAudience,
  runRefundReminder,
  checkAndFireRefundReminders,
  _argDayKey,
  _periodWindow,
  _currentPeriodKey,
  _DEFAULT_COPY
};
