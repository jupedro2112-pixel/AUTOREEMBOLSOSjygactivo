/**
 * Motor de evaluación de NotificationRule.
 *
 * Cada 5 minutos el cron llama a evaluateAllRules(). Para cada regla activa:
 *   1. ¿Le toca disparar AHORA según su trigger?
 *   2. Resolver audiencia (queries a User/PlayerStats/DailyPlayerStats/RefundClaim).
 *   3. Aplicar cooldown (excluir users que ya recibieron esta regla en las últimas N horas).
 *   4. Si requiresAdminApproval → crear NotificationRuleSuggestion en estado 'pending'.
 *      Sino → mandar push directo via sendNotificationToAllUsers.
 *
 * Toda la lógica de "quién" vive acá. server.js solo orquesta el cron.
 */

const { v4: uuidv4 } = require('uuid');

// Cache simple para evitar evaluar la misma regla 2 veces en la misma ventana
// de 5 min (idempotencia del cron incluso si se reinicia).
function _ruleAlreadyFiredThisWindow(rule, windowMinutes = 5) {
  if (!rule.lastFiredAt) return false;
  const ageMs = Date.now() - new Date(rule.lastFiredAt).getTime();
  return ageMs < windowMinutes * 60 * 1000;
}

// ============================================================
// MATCH DE TRIGGER: ¿le toca a esta regla disparar ahora?
// ============================================================
function _getArtParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false, weekday: 'short'
  });
  const parts = fmt.formatToParts(date);
  const get = (t) => parts.find(p => p.type === t).value;
  const weekdayStr = get('weekday'); // Mon, Tue, Wed, Thu, Fri, Sat, Sun
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour: parseInt(get('hour'), 10) % 24,
    minute: parseInt(get('minute'), 10),
    dayOfWeek: dowMap[weekdayStr]
  };
}

// El cron corre cada 5 min. Una regla con cronSchedule {hour:14, minute:0}
// matchea si la hora ART actual es 14 y los minutos están en [0, 5).
// Además chequea dayOfWeek/dayOfMonth si están seteados.
function _cronMatchesNow(rule, now = new Date()) {
  if (rule.triggerType !== 'cron') return false;
  const cs = rule.cronSchedule || {};
  if (cs.hour == null) return false;
  const p = _getArtParts(now);
  if (p.hour !== cs.hour) return false;
  // Ventana de 5 min para tolerar drift del cron y boot del server.
  const targetMin = cs.minute || 0;
  if (p.minute < targetMin || p.minute >= targetMin + 5) return false;
  if (cs.dayOfWeek != null && p.dayOfWeek !== cs.dayOfWeek) return false;
  if (cs.dayOfMonth != null && p.day !== cs.dayOfMonth) return false;
  return true;
}

// ============================================================
// AUDIENCIA: resolver lista de usernames a notificar
// ============================================================
async function _resolveAudience(rule, models) {
  const { User, RefundClaim, DailyPlayerStats, PlayerStats } = models;

  // Filtro base: solo users con app+notifs (sino el push no llega).
  const baseFilter = {
    role: 'user',
    isActive: { $ne: false },
    isBlocked: { $ne: true },
    fcmTokens: { $exists: true, $not: { $size: 0 } }
  };

  switch (rule.audienceType) {
    case 'has-app-notifs': {
      // Todos los con app+notifs. Filtro: algún token con context='standalone'
      // y notifPermission='granted'. Hacemos en memoria porque Mongo no
      // expresa fácil "algún elemento del array cumple X".
      const users = await User.find(baseFilter).select('username fcmTokens notifPermission fcmTokenContext').lean();
      return users.filter(u => {
        const tokens = u.fcmTokens || [];
        const hasApp = u.fcmTokenContext === 'standalone' || tokens.some(t => t && t.context === 'standalone');
        const hasNotifs = u.notifPermission === 'granted' || tokens.some(t => t && t.notifPermission === 'granted');
        return hasApp && hasNotifs;
      }).map(u => u.username);
    }

    case 'refund-pending-daily': {
      // Audiencia: usuarios con DailyPlayerStats de AYER (ART) donde perdieron
      // Y todavía no reclamaron el daily de ese día.
      const yest = _yesterdayInArt();
      const losses = await DailyPlayerStats.find({
        dateUtc: yest.dateUtc,
        $expr: { $gt: ['$depositSum', '$withdrawSum'] }
      }).select('username').lean();
      const losersNorm = losses.map(d => (d.username || '').toLowerCase());
      if (losersNorm.length === 0) return [];

      // Excluir los que ya reclamaron daily para ese periodKey.
      const periodKey = yest.dateKeyArt;
      const claimed = await RefundClaim.find({
        type: 'daily',
        periodKey,
        username: { $in: losersNorm }
      }).select('username').lean();
      const claimedSet = new Set(claimed.map(c => (c.username || '').toLowerCase()));

      // Y filtrar a solo los que tienen app+notifs.
      const eligible = losersNorm.filter(u => !claimedSet.has(u));
      return _filterUsersByChannel(eligible, User);
    }

    case 'refund-pending-weekly': {
      // Audiencia: usuarios con pérdida neta en la semana pasada (lun-dom)
      // y no reclamaron el weekly de ese período.
      const wk = _lastWeekInArt();
      const agg = await DailyPlayerStats.aggregate([
        { $match: { dateUtc: { $gte: wk.startUtc, $lt: wk.endUtc } } },
        { $group: { _id: '$username', dep: { $sum: '$depositSum' }, wd: { $sum: '$withdrawSum' } } },
        { $match: { $expr: { $gt: ['$dep', '$wd'] } } }
      ]);
      const losersNorm = agg.map(d => (d._id || '').toLowerCase());
      if (losersNorm.length === 0) return [];

      const claimed = await RefundClaim.find({
        type: 'weekly',
        periodKey: wk.periodKey,
        username: { $in: losersNorm }
      }).select('username').lean();
      const claimedSet = new Set(claimed.map(c => (c.username || '').toLowerCase()));

      const eligible = losersNorm.filter(u => !claimedSet.has(u));
      return _filterUsersByChannel(eligible, User);
    }

    case 'refund-pending-monthly': {
      const mn = _lastMonthInArt();
      const agg = await DailyPlayerStats.aggregate([
        { $match: { dateUtc: { $gte: mn.startUtc, $lt: mn.endUtc } } },
        { $group: { _id: '$username', dep: { $sum: '$depositSum' }, wd: { $sum: '$withdrawSum' } } },
        { $match: { $expr: { $gt: ['$dep', '$wd'] } } }
      ]);
      const losersNorm = agg.map(d => (d._id || '').toLowerCase());
      if (losersNorm.length === 0) return [];

      const claimed = await RefundClaim.find({
        type: 'monthly',
        periodKey: mn.periodKey,
        username: { $in: losersNorm }
      }).select('username').lean();
      const claimedSet = new Set(claimed.map(c => (c.username || '').toLowerCase()));

      const eligible = losersNorm.filter(u => !claimedSet.has(u));
      return _filterUsersByChannel(eligible, User);
    }

    case 'welcome-no-play-since': {
      // Reclamaron welcome hace [minHoursAgo, maxHoursAgo] y no han hecho un
      // depósito real desde entonces.
      const cfg = rule.audienceConfig || {};
      const minHours = Number(cfg.minHoursAgo || 24);
      const maxHours = Number(cfg.maxHoursAgo || 48);
      const now = Date.now();
      const claimed = await RefundClaim.find({
        type: 'welcome_install',
        claimedAt: {
          $gte: new Date(now - maxHours * 3600 * 1000),
          $lte: new Date(now - minHours * 3600 * 1000)
        }
      }).select('username claimedAt').lean();

      if (claimed.length === 0) return [];

      const usernames = claimed.map(c => (c.username || '').toLowerCase());
      // Filtrar los que SÍ depositaron real después del welcome.
      const ps = await PlayerStats.find({
        username: { $in: usernames }
      }).select('username lastRealDepositDate').lean();
      const depositedAfterWelcome = new Set();
      const claimMap = new Map(claimed.map(c => [c.username.toLowerCase(), new Date(c.claimedAt).getTime()]));
      for (const p of ps) {
        const last = p.lastRealDepositDate ? new Date(p.lastRealDepositDate).getTime() : 0;
        const welcomeAt = claimMap.get(p.username) || 0;
        if (last > welcomeAt) depositedAfterWelcome.add(p.username);
      }
      const eligible = usernames.filter(u => !depositedAfterWelcome.has(u));
      return _filterUsersByChannel(eligible, User);
    }

    case 'tier-state': {
      const cfg = rule.audienceConfig || {};
      const psFilter = { isOpportunist: { $ne: true } };
      if (cfg.tier) psFilter.tier = cfg.tier;
      if (cfg.activityStatus) psFilter.activityStatus = cfg.activityStatus;
      const ps = await PlayerStats.find(psFilter).select('username').lean();
      const usernames = ps.map(p => (p.username || '').toLowerCase());
      return _filterUsersByChannel(usernames, User);
    }

    case 'installed-but-inactive': {
      // Instalaron la PWA (tienen al menos un fcmToken con context='standalone')
      // y no abren la app (lastLogin) hace [minHoursAgo, maxHoursAgo].
      // Diferente a 'welcome-no-play-since' que mide depósitos: acá medimos
      // login efectivo a la app. Pensado para campañas de re-engagement
      // escalonadas (48h "te extrañamos", 72h "regalito", etc).
      const cfg = rule.audienceConfig || {};
      const minHours = Number(cfg.minHoursAgo || 48);
      const maxHours = Number(cfg.maxHoursAgo || 72);
      const now = Date.now();
      const minMs = now - maxHours * 3600 * 1000; // borde más viejo
      const maxMs = now - minHours * 3600 * 1000; // borde más reciente
      const docs = await User.find({
        role: 'user',
        isActive: { $ne: false },
        isBlocked: { $ne: true },
        lastLogin: { $gte: new Date(minMs), $lte: new Date(maxMs) },
        $or: [
          { fcmTokenContext: 'standalone' },
          { 'fcmTokens.context': 'standalone' }
        ]
      }).select('username').lean();
      const usernames = docs.map(u => (u.username || '').toLowerCase()).filter(Boolean);
      // _filterUsersByChannel re-chequea que sigan teniendo app+notifs.
      return _filterUsersByChannel(usernames, User);
    }

    default:
      return [];
  }
}

// Mantiene solo los usernames que tienen tokens FCM válidos (app+notifs).
async function _filterUsersByChannel(usernames, User) {
  if (usernames.length === 0) return [];
  const docs = await User.find({
    username: { $in: usernames },
    role: 'user',
    isActive: { $ne: false },
    isBlocked: { $ne: true }
  }).select('username fcmTokens notifPermission fcmTokenContext').lean();

  return docs.filter(u => {
    const tokens = u.fcmTokens || [];
    const hasApp = u.fcmTokenContext === 'standalone' || tokens.some(t => t && t.context === 'standalone');
    const hasNotifs = u.notifPermission === 'granted' || tokens.some(t => t && t.notifPermission === 'granted');
    return hasApp && hasNotifs;
  }).map(u => u.username);
}

// ============================================================
// HELPERS DE TIEMPO ART
// ============================================================
function _todayDateKeyArt() {
  const p = _getArtParts();
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function _yesterdayInArt() {
  const todayMs = Date.now();
  const yMs = todayMs - 24 * 60 * 60 * 1000;
  const p = _getArtParts(new Date(yMs));
  const dateKeyArt = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  // dateUtc: midnight UTC del mismo día calendario ART (los CSVs guardan así).
  const dateUtc = new Date(`${dateKeyArt}T00:00:00.000Z`);
  return { dateKeyArt, dateUtc };
}

function _lastWeekInArt() {
  const p = _getArtParts();
  // Calcular el lunes de la semana pasada (ISO week starting Monday).
  // Hoy es day-of-week p.dayOfWeek (0=Sun..6=Sat). Lunes pasado = hoy - dow - 6
  // si hoy es lunes (1), lunes pasado = hoy - 7. Si hoy es domingo (0), lunes pasado = hoy - 13.
  const todayMs = new Date(`${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T00:00:00.000Z`).getTime();
  const dowMon = (p.dayOfWeek + 6) % 7; // 0 si es lunes
  const lastWeekMonMs = todayMs - (dowMon + 7) * 24 * 60 * 60 * 1000;
  const lastWeekSunEndMs = lastWeekMonMs + 7 * 24 * 60 * 60 * 1000; // exclusivo
  const startUtc = new Date(lastWeekMonMs);
  const endUtc = new Date(lastWeekSunEndMs);
  // periodKey: usamos EXACTAMENTE la misma fórmula que computePeriodKey('weekly')
  // del server.js (líneas 324-332), basándonos en y/m/d ART de un día de la
  // semana pasada (el lunes mismo). Sin esto, en semanas borde (W52/W53) los
  // periodKeys no matchean y los users que ya reclamaron NO se filtran → spam
  // de recordatorios y desconfianza.
  const lwParts = _getArtParts(new Date(lastWeekMonMs));
  const periodKey = _computeWeeklyPeriodKey(lwParts.year, lwParts.month, lwParts.day);
  return { startUtc, endUtc, periodKey };
}

// Réplica exacta de computePeriodKey('weekly') de server.js. Crítico:
// si esta función diverge, los reembolsos semanales se duplican.
function _computeWeeklyPeriodKey(year, month, day) {
  const target = new Date(Date.UTC(year, month - 1, day));
  const dayNum = (target.getUTCDay() + 6) % 7; // lunes=0
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((target.getTime() - firstThursday.getTime()) / 86400000 - 3 +
      ((firstThursday.getUTCDay() + 6) % 7)) / 7
  );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function _lastMonthInArt() {
  const p = _getArtParts();
  let year = p.year;
  let month = p.month - 1; // mes pasado (1-indexed)
  if (month < 1) { month = 12; year -= 1; }
  const startKey = `${year}-${String(month).padStart(2, '0')}-01`;
  const startUtc = new Date(`${startKey}T00:00:00.000Z`);
  // Fin: primer día del mes actual.
  const endUtc = new Date(Date.UTC(p.year, p.month - 1, 1, 0, 0, 0));
  const periodKey = `${year}-${String(month).padStart(2, '0')}`;
  return { startUtc, endUtc, periodKey };
}

// ============================================================
// EVALUACIÓN DE TODAS LAS REGLAS
// ============================================================
async function evaluateAllRules({ models, sendPushFn, logger }) {
  const { NotificationRule, NotificationRuleSuggestion, NotificationHistory, MoneyGiveaway, User } = models;

  const now = new Date();
  const enabled = await NotificationRule.find({
    enabled: true,
    triggerType: 'cron'
  }).lean();

  let firedCount = 0;
  let suggestedCount = 0;

  for (const rule of enabled) {
    try {
      if (!_cronMatchesNow(rule, now)) continue;
      if (_ruleAlreadyFiredThisWindow(rule, 5)) continue;

      // Resolver audiencia.
      const audienceUsernames = await _resolveAudience(rule, models);
      if (!audienceUsernames || audienceUsernames.length === 0) {
        await NotificationRule.updateOne(
          { id: rule.id },
          { $set: { lastEvaluatedAt: now } }
        );
        continue;
      }

      // Cap diario: si ya disparamos a más de maxFiresPerDay hoy, skip.
      // (Implementación simple: revisar el último fire y reset por día.)
      // Para MVP aceptamos audiencia sin cap.

      // Si requiere aprobación → crear suggestion.
      if (rule.requiresAdminApproval || rule.bonus.type !== 'none') {
        await NotificationRuleSuggestion.create({
          id: uuidv4(),
          ruleId: rule.id,
          ruleCode: rule.code,
          ruleName: rule.name,
          ruleCategory: rule.category,
          title: rule.title,
          body: rule.body,
          audienceUsernames,
          audienceCount: audienceUsernames.length,
          audienceSummary: `${audienceUsernames.length} usuarios (regla ${rule.code})`,
          bonus: rule.bonus || { type: 'none' },
          status: 'pending',
          suggestedAt: now,
          expiresAt: new Date(now.getTime() + 48 * 3600 * 1000)
        });
        suggestedCount++;
        await NotificationRule.updateOne(
          { id: rule.id },
          {
            $set: { lastEvaluatedAt: now, lastFiredAt: now },
            $inc: { totalSuggestionsLifetime: 1 }
          }
        );
        if (logger) logger.info(`[notif-rules] regla ${rule.code} sugirió ${audienceUsernames.length} envíos (pendiente aprobación)`);
        continue;
      }

      // Sin aprobación: mandar directo.
      const filter = { username: { $in: audienceUsernames } };
      const data = {
        source: 'notif-rule',
        ruleCode: rule.code,
        tag: 'notif-rule-' + rule.code
      };
      const sendResult = await sendPushFn(User, rule.title, rule.body, data, filter);

      // Registrar en NotificationHistory.
      try {
        await NotificationHistory.create({
          id: uuidv4(),
          sentAt: now,
          audienceType: 'list',
          audienceCount: audienceUsernames.length,
          title: rule.title,
          body: rule.body,
          type: 'plain',
          successCount: sendResult.successCount || 0,
          failureCount: sendResult.failureCount || 0,
          sentBy: 'auto-rule:' + rule.code,
          meta: { ruleId: rule.id, ruleCode: rule.code, source: 'notification-rule' }
        });
      } catch (histErr) {
        if (logger) logger.warn(`[notif-rules] history create error: ${histErr.message}`);
      }

      await NotificationRule.updateOne(
        { id: rule.id },
        {
          $set: { lastEvaluatedAt: now, lastFiredAt: now },
          $inc: { totalFiresLifetime: 1 }
        }
      );
      firedCount++;
      if (logger) logger.info(`[notif-rules] regla ${rule.code} disparó a ${audienceUsernames.length} (entregados ${sendResult.successCount || 0})`);
    } catch (err) {
      if (logger) logger.error(`[notif-rules] error en regla ${rule.code}: ${err.message}`);
    }
  }

  // Expirar suggestions viejas.
  try {
    await NotificationRuleSuggestion.updateMany(
      { status: 'pending', expiresAt: { $lt: now } },
      { $set: { status: 'expired' } }
    );
  } catch (_) {}

  return { firedCount, suggestedCount };
}

// ============================================================
// SEED INICIAL DE REGLAS — el playbook plasmado
// ============================================================
async function seedDefaultRulesIfMissing(NotificationRule) {
  const defaults = [
    // ============= REEMBOLSOS =============
    {
      id: uuidv4(),
      code: 'B1',
      name: 'Recordatorio reembolso diario — tarde (14:00)',
      description: 'Push al mediodía a quienes perdieron ayer y no reclamaron todavía.',
      category: 'refund',
      enabled: true,
      triggerType: 'cron',
      cronSchedule: { hour: 14, minute: 0 },
      audienceType: 'refund-pending-daily',
      title: '💰 Tu reembolso del 8% te espera',
      body: 'Perdiste ayer? Tenés un reembolso disponible. Tocá para reclamarlo.',
      bonus: { type: 'none' },
      cooldownMinutes: 12 * 60
    },
    {
      id: uuidv4(),
      code: 'B2',
      name: 'Recordatorio reembolso diario — última hora (22:00)',
      description: 'Último aviso 2h antes del cierre del día ART.',
      category: 'refund',
      enabled: true,
      triggerType: 'cron',
      cronSchedule: { hour: 22, minute: 0 },
      audienceType: 'refund-pending-daily',
      title: '⏰ Última hora para tu reembolso',
      body: 'Quedan 2 horas. No te pierdas el 8% de tu pérdida de ayer.',
      bonus: { type: 'none' },
      cooldownMinutes: 8 * 60
    },
    {
      id: uuidv4(),
      code: 'B3',
      name: 'Recordatorio reembolso semanal — lunes 12:00',
      description: 'Aviso al mediodía del lunes sobre el 5% de la semana pasada.',
      category: 'refund',
      enabled: true,
      triggerType: 'cron',
      cronSchedule: { hour: 12, minute: 0, dayOfWeek: 1 },
      audienceType: 'refund-pending-weekly',
      title: '📆 Reembolso del 5% disponible',
      body: 'Hoy y mañana podés reclamar el reembolso de la semana pasada.',
      bonus: { type: 'none' },
      cooldownMinutes: 24 * 60
    },
    {
      id: uuidv4(),
      code: 'B4',
      name: 'Recordatorio reembolso semanal — martes 18:00 (último día)',
      description: 'Último aviso. El weekly solo se reclama lunes y martes.',
      category: 'refund',
      enabled: true,
      triggerType: 'cron',
      cronSchedule: { hour: 18, minute: 0, dayOfWeek: 2 },
      audienceType: 'refund-pending-weekly',
      title: '⚠️ Último día para tu reembolso semanal',
      body: 'Vence a las 23:59. Tocá ahora y reclamá tu 5%.',
      bonus: { type: 'none' },
      cooldownMinutes: 18 * 60
    },
    {
      id: uuidv4(),
      code: 'B5',
      name: 'Recordatorio reembolso mensual — día 7 12:00',
      description: 'Aviso de apertura del 3% mensual.',
      category: 'refund',
      enabled: true,
      triggerType: 'cron',
      cronSchedule: { hour: 12, minute: 0, dayOfMonth: 7 },
      audienceType: 'refund-pending-monthly',
      title: '🗓️ Tu reembolso mensual del 3% está abierto',
      body: 'Reclamalo cualquier día entre hoy y el 15. Cuanto antes, mejor.',
      bonus: { type: 'none' },
      cooldownMinutes: 24 * 60
    },
    {
      id: uuidv4(),
      code: 'B6',
      name: 'Recordatorio reembolso mensual — día 14 18:00 (último día)',
      description: 'Último aviso. El monthly cierra el día 15.',
      category: 'refund',
      enabled: true,
      triggerType: 'cron',
      cronSchedule: { hour: 18, minute: 0, dayOfMonth: 14 },
      audienceType: 'refund-pending-monthly',
      title: '⚠️ Último día para tu reembolso mensual',
      body: 'Mañana cierra el 3% del mes pasado. No te lo pierdas.',
      bonus: { type: 'none' },
      cooldownMinutes: 24 * 60
    },

    // ============= WELCOME FOLLOW-UPS =============
    {
      id: uuidv4(),
      code: 'A3',
      name: 'Welcome follow-up — 24h sin jugar',
      description: 'Reclamó welcome hace ~24h y no hizo deposito real.',
      category: 'welcome',
      enabled: true,
      triggerType: 'cron',
      cronSchedule: { hour: 17, minute: 0 }, // 17:00 ART
      audienceType: 'welcome-no-play-since',
      audienceConfig: { minHoursAgo: 24, maxHoursAgo: 30 },
      title: '🎁 Tu bono está esperando',
      body: 'Triplicá tu saldo y pedí RETIRO10 al chat de WhatsApp.',
      bonus: { type: 'none' },
      cooldownMinutes: 6 * 60
    },
    {
      id: uuidv4(),
      code: 'A4',
      name: 'Welcome follow-up — 48h sin jugar',
      description: 'Reclamó welcome hace ~48h y no hizo deposito real.',
      category: 'welcome',
      enabled: true,
      triggerType: 'cron',
      cronSchedule: { hour: 19, minute: 0 }, // 19:00 ART
      audienceType: 'welcome-no-play-since',
      audienceConfig: { minHoursAgo: 48, maxHoursAgo: 54 },
      title: '⏳ Tu bono se está enfriando',
      body: 'Pasaron 2 días. Probá unas jugadas y triplicá. RETIRO10 te espera.',
      bonus: { type: 'none' },
      cooldownMinutes: 6 * 60
    },

    // ============= RECUPERACIÓN DE INACTIVOS (instalaron PWA, no entran) =============
    // Estas reglas detectan usuarios que tienen la app instalada (fcmToken
    // standalone) pero hace varias horas que no abren la app. Cada una tiene
    // requiresAdminApproval=true: el cron resuelve audiencia y crea una
    // NotificationRuleSuggestion; el admin la abre desde el panel, ve la
    // lista de afectados, edita el copy si quiere, y recién ahí confirma
    // el envío. Pensadas para re-engagement escalonado.
    {
      id: uuidv4(),
      code: 'D-INST-48H',
      name: 'Inactivos 48h — Te extrañamos',
      description: 'Instalaron la app pero no entran hace 48-72h. Push suave de re-engagement.',
      category: 'recovery',
      enabled: true,
      triggerType: 'cron',
      cronSchedule: { hour: 18, minute: 0 }, // 18:00 ART todos los días
      audienceType: 'installed-but-inactive',
      audienceConfig: { minHoursAgo: 48, maxHoursAgo: 72 },
      title: '👀 Te extrañamos!',
      body: 'Hace 2 días que no te vemos. Volvé y probá tu suerte!',
      bonus: { type: 'none' },
      requiresAdminApproval: true,
      cooldownMinutes: 48 * 60
    },
    {
      id: uuidv4(),
      code: 'D-INST-72H',
      name: 'Inactivos 72h — Regalito de vuelta',
      description: 'Instalaron la app pero no entran hace 72-168h (3 a 7 días). Push con regalito.',
      category: 'recovery',
      enabled: true,
      triggerType: 'cron',
      cronSchedule: { hour: 19, minute: 0 }, // 19:00 ART todos los días
      audienceType: 'installed-but-inactive',
      audienceConfig: { minHoursAgo: 72, maxHoursAgo: 168 },
      title: '🎁 Tenemos un regalito esperándote',
      body: 'Hace varios días que no entrás. Volvé y reclamá tu regalo.',
      bonus: { type: 'none' },
      requiresAdminApproval: true,
      cooldownMinutes: 72 * 60
    }
  ];

  for (const def of defaults) {
    const existing = await NotificationRule.findOne({ code: def.code }).lean();
    if (existing) continue;
    await NotificationRule.create(def);
  }
}

module.exports = {
  evaluateAllRules,
  seedDefaultRulesIfMissing,
  // Exportados para tests / uso desde admin endpoints.
  _resolveAudience,
  _cronMatchesNow
};
