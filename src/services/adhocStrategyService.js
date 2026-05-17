/**
 * Ad-hoc Strategy Service
 *
 * Lanzador de estrategia bajo demanda. A diferencia del semanal (que
 * corre lunes/jueves automático), acá el admin elige fecha de análisis
 * y monto máximo, le mostramos un plan per-user, y si confirma lo
 * lanzamos.
 *
 * Filosofía: REUSA TODO del semanal — APP_NOTIFS_FILTER, canSendToUser,
 * recordSent, weekKey, MoneyGiveaway con strategySource='auto-strategy'.
 * La diferencia es que el corte por usuario lo hacemos sobre
 * DailyPlayerStats (no JUGAYGANA per-user, que es muy lento) y
 * clasificamos en 4 paquetes (gran perdedor / medio / chico / dormido).
 *
 * Storage: el plan no va a Mongo. Vive en memoria (Map con TTL 60 min).
 * Si Render reinicia, se pierde — no es problema porque el admin
 * confirma en cuestión de segundos. Si pasa mucho tiempo, se vuelve
 * a analizar.
 */
const { v4: uuidv4 } = require('uuid');

const PLAN_TTL_MS = 60 * 60 * 1000; // 1 hora
const _adhocPlans = new Map(); // planId -> { plan, expiresAt }

function _gcAdhocPlans() {
  const now = Date.now();
  for (const [k, v] of _adhocPlans) {
    if (v.expiresAt < now) _adhocPlans.delete(k);
  }
}

function storeAdhocPlan(plan) {
  _gcAdhocPlans();
  const planId = plan.id || uuidv4();
  _adhocPlans.set(planId, { plan: { ...plan, id: planId }, expiresAt: Date.now() + PLAN_TTL_MS });
  return planId;
}

function getAdhocPlan(planId) {
  _gcAdhocPlans();
  const e = _adhocPlans.get(planId);
  return e ? e.plan : null;
}

function consumeAdhocPlan(planId) {
  _gcAdhocPlans();
  const e = _adhocPlans.get(planId);
  if (!e) return null;
  _adhocPlans.delete(planId);
  return e.plan;
}

// ============================================
// PERFILES Y MONTOS
// ============================================
//
// Los "paquetes" son tiers de ofertas que se asignan según cómo jugó el
// user en el rango de análisis. Cada paquete tiene:
//   - matcher(stats): true/false según features
//   - giftAmount(stats): monto ARS de regalo de plata (0 = sin regalo)
//   - bonusPct(stats): % de bono sobre próxima carga (vía WhatsApp)
//   - kind: 'money' | 'whatsapp_promo' (define el flujo de envío)
//
// El orden importa: el primer match gana. Por eso el más grave/valioso
// va arriba.
const ADHOC_PACKAGES = [
  {
    code: 'big_loser_hot',
    label: '🎰 Gran perdedor caliente',
    description: 'Perdió mucho hace ≤2 días — máxima retención',
    kind: 'money',
    matcher: (s) => s.netwinARS >= 200000 && s.daysSinceLastDeposit != null && s.daysSinceLastDeposit <= 2,
    giftAmount: (s) => {
      if (s.netwinARS >= 500000) return 15000;
      if (s.netwinARS >= 350000) return 12000;
      return 10000;
    },
    bonusPct: () => 0
  },
  {
    code: 'medium_loser',
    label: '💸 Perdedor medio',
    description: 'Perdió $50k-$200k en últimos 7 días',
    kind: 'money',
    matcher: (s) => s.netwinARS >= 50000 && s.netwinARS < 200000 && s.daysSinceLastDeposit != null && s.daysSinceLastDeposit <= 7,
    giftAmount: (s) => {
      if (s.netwinARS >= 120000) return 7500;
      if (s.netwinARS >= 80000) return 5000;
      return 3000;
    },
    bonusPct: () => 0
  },
  {
    code: 'small_loser',
    label: '😐 Perdedor chico',
    description: 'Perdió $10k-$50k — bono % carga',
    kind: 'whatsapp_promo',
    matcher: (s) => s.netwinARS >= 10000 && s.netwinARS < 50000,
    giftAmount: () => 0,
    bonusPct: (s) => {
      if (s.netwinARS >= 30000) return 25;
      if (s.netwinARS >= 20000) return 20;
      return 15;
    }
  },
  {
    code: 'dormant_hot',
    label: '💤 Dormido caliente',
    description: 'Cargaba antes pero hace 3-7d que no',
    kind: 'money',
    matcher: (s) => s.totalDepositsARS > 0 && s.daysSinceLastDeposit != null && s.daysSinceLastDeposit >= 3 && s.daysSinceLastDeposit <= 7,
    giftAmount: (s) => {
      if (s.totalDepositsARS >= 100000) return 5000;
      if (s.totalDepositsARS >= 50000) return 3500;
      return 2000;
    },
    bonusPct: () => 0
  }
];

// ============================================
// COMPUTE PLAN
// ============================================
/**
 * Analiza un rango de fechas y devuelve un plan accionable.
 *
 * @param {Object} params
 * @param {Object} params.models - { User, DailyPlayerStats, WeeklyNotifBudget, WeeklyStrategyConfig }
 * @param {string} params.weeklyService - reference al weeklyStrategyService para reusar APP_NOTIFS_FILTER, canSendToUser
 * @param {Date} params.analysisFrom
 * @param {Date} params.analysisTo
 * @param {number} params.maxBudgetARS
 * @param {string} params.focus - 'lift_today' | 'reactivate_dormant' | 'mix'
 * @param {Object} params.logger
 * @returns {Promise<Object>} plan
 */
async function computeAdhocPlan({ models, weeklyService, analysisFrom, analysisTo, maxBudgetARS, focus, logger }) {
  const { User, DailyPlayerStats, WeeklyNotifBudget, WeeklyStrategyConfig } = models;
  const config = await weeklyService.getOrCreateConfig(WeeklyStrategyConfig);
  const wk = weeklyService._weekKey();

  // 1) Universo: TODOS los users role='user'. Marcamos por separado quién
  //    tiene app+notifs (canal de push) y quién no — para que el admin
  //    sepa a quiénes targetear por WhatsApp manual aunque no le podamos
  //    mandar push directo.
  const allUsers = await User.find(
    { role: 'user' },
    { username: 1, lineTeamName: 1, linePhone: 1,
      fcmTokens: 1, fcmTokenContext: 1, notifPermission: 1, _id: 0 }
  ).lean();
  const userIndex = new Map(); // username lower -> { hasChannel, linePhone, lineTeamName }
  for (const u of allUsers) {
    const tokens = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
    // hasApp / hasNotifs son flags sueltos (legacy o cualquier token).
    const hasApp = u.fcmTokenContext === 'standalone' ||
                   tokens.some(t => t && t.context === 'standalone');
    const hasNotifs = u.notifPermission === 'granted' ||
                      tokens.some(t => t && t.notifPermission === 'granted');
    // hasChannel ESTRICTO: AMBAS condiciones tienen que estar en el MISMO
    // token (legacy single, o algún elemento del array). Mismo criterio
    // que APP_NOTIFS_FILTER ($elemMatch) — sin esto un user con un
    // standalone-no-permiso + browser-permiso pasaba como with-channel.
    const legacyMatch = u.fcmTokenContext === 'standalone' && u.notifPermission === 'granted';
    const arrayMatch = tokens.some(t => t && t.context === 'standalone' && t.notifPermission === 'granted');
    userIndex.set(String(u.username).toLowerCase(), {
      username: u.username,
      hasApp, hasNotifs,
      hasChannel: legacyMatch || arrayMatch,
      linePhone: u.linePhone || null,
      lineTeamName: u.lineTeamName || null
    });
  }
  const candidatesAppNotifs = Array.from(userIndex.values()).filter(u => u.hasChannel).length;

  // 2) Aggregate de DailyPlayerStats en el rango.
  const stats = await DailyPlayerStats.aggregate([
    { $match: { dateUtc: { $gte: analysisFrom, $lte: analysisTo } } },
    {
      $group: {
        _id: '$username',
        totalDepositsARS: { $sum: '$depositSum' },
        depositCount: { $sum: '$depositCount' },
        totalWithdrawsARS: { $sum: '$withdrawSum' },
        withdrawCount: { $sum: '$withdrawCount' },
        lastDepositDate: { $max: { $cond: [{ $gt: ['$depositSum', 0] }, '$dateUtc', null] } }
      }
    }
  ]);

  // 3) Enriquecer con info de canal (sin filtrar por app+notifs todavía).
  //    Todo el que tenga actividad en el rango Y exista en User entra.
  const now = Date.now();
  const enrichedStats = [];
  for (const s of stats) {
    const u = userIndex.get(String(s._id).toLowerCase());
    if (!u) continue; // existe en stats pero no en users (raro)
    const netwin = (Number(s.totalDepositsARS) || 0) - (Number(s.totalWithdrawsARS) || 0);
    const lastDep = s.lastDepositDate ? new Date(s.lastDepositDate).getTime() : null;
    const daysSinceLastDeposit = lastDep ? Math.floor((now - lastDep) / 86400000) : null;
    enrichedStats.push({
      username: u.username,
      totalDepositsARS: Number(s.totalDepositsARS) || 0,
      depositCount: s.depositCount || 0,
      totalWithdrawsARS: Number(s.totalWithdrawsARS) || 0,
      withdrawCount: s.withdrawCount || 0,
      netwinARS: netwin,
      lastDepositDate: s.lastDepositDate || null,
      daysSinceLastDeposit,
      hasApp: u.hasApp,
      hasNotifs: u.hasNotifs,
      hasChannel: u.hasChannel,
      linePhone: u.linePhone,
      lineTeamName: u.lineTeamName
    });
  }

  // 4) Filtrar por focus. 'mix' = todos.
  let filtered = enrichedStats;
  if (focus === 'lift_today') {
    // Solo perdedores recientes (≤7d)
    filtered = enrichedStats.filter(s => s.netwinARS > 0 && s.daysSinceLastDeposit != null && s.daysSinceLastDeposit <= 7);
  } else if (focus === 'reactivate_dormant') {
    // Solo dormidos calientes
    filtered = enrichedStats.filter(s => s.totalDepositsARS > 0 && s.daysSinceLastDeposit != null && s.daysSinceLastDeposit >= 3 && s.daysSinceLastDeposit <= 14);
  }

  // 5) Asignar paquete a cada user (con o sin app).
  const audienceWithChannel = [];   // pueden recibir push
  const audienceNoChannel = [];     // hicieron match pero sin app+notifs (target WhatsApp manual)
  const noMatch = [];
  for (const s of filtered) {
    const pkg = ADHOC_PACKAGES.find(p => p.matcher(s));
    if (!pkg) { noMatch.push(s); continue; }
    const giftAmount = pkg.giftAmount(s);
    const bonusPct = pkg.bonusPct(s);
    const item = {
      username: s.username,
      package: pkg.code,
      packageLabel: pkg.label,
      kind: pkg.kind,
      giftAmount,
      bonusPct,
      netwinARS: s.netwinARS,
      totalDepositsARS: s.totalDepositsARS,
      daysSinceLastDeposit: s.daysSinceLastDeposit,
      hasApp: s.hasApp,
      hasNotifs: s.hasNotifs,
      hasChannel: s.hasChannel,
      linePhone: s.linePhone,
      lineTeamName: s.lineTeamName
    };
    if (s.hasChannel) audienceWithChannel.push(item);
    else audienceNoChannel.push(item);
  }

  // 6) Cap + cooldown gate SOLO sobre los que pueden recibir push.
  //    Los sin app no aplican porque no se les manda nada por la app.
  const targets = [];
  const blocked = [];
  for (const item of audienceWithChannel) {
    const gate = await weeklyService.canSendToUser({
      username: item.username,
      weekKey: wk,
      cooldownHours: config.cooldownHours,
      capPerUser: config.capPerUserPerWeek,
      WeeklyNotifBudget
    });
    if (gate.ok) targets.push(item);
    else blocked.push({ ...item, blockReason: gate.reason });
  }

  // 7) Aplicar tope de presupuesto: ordenamos por valor esperado (giftAmount
  //    descendente) y vamos sumando hasta llegar al cap. El resto se descarta.
  targets.sort((a, b) => (b.giftAmount || 0) - (a.giftAmount || 0));
  const capped = [];
  let runningCost = 0;
  let droppedByBudget = 0;
  for (const t of targets) {
    if (runningCost + (t.giftAmount || 0) > maxBudgetARS) {
      droppedByBudget++;
      continue;
    }
    capped.push(t);
    runningCost += (t.giftAmount || 0);
  }

  // 8) Resumen por paquete.
  const breakdown = {};
  for (const t of capped) {
    if (!breakdown[t.package]) {
      const pkg = ADHOC_PACKAGES.find(p => p.code === t.package);
      breakdown[t.package] = {
        code: t.package,
        label: pkg.label,
        kind: pkg.kind,
        count: 0,
        totalGiftARS: 0,
        avgBonusPct: 0,
        bonusPctSum: 0
      };
    }
    breakdown[t.package].count++;
    breakdown[t.package].totalGiftARS += (t.giftAmount || 0);
    breakdown[t.package].bonusPctSum += (t.bonusPct || 0);
  }
  for (const k of Object.keys(breakdown)) {
    const b = breakdown[k];
    b.avgBonusPct = b.count > 0 ? Math.round(b.bonusPctSum / b.count) : 0;
    delete b.bonusPctSum;
  }

  // 9) Resumen de los matches SIN app (para campaña WhatsApp manual).
  const noAppBreakdown = {};
  for (const t of audienceNoChannel) {
    if (!noAppBreakdown[t.package]) {
      const pkg = ADHOC_PACKAGES.find(p => p.code === t.package);
      noAppBreakdown[t.package] = {
        code: t.package, label: pkg.label, kind: pkg.kind,
        count: 0, totalGiftARS: 0
      };
    }
    noAppBreakdown[t.package].count++;
    noAppBreakdown[t.package].totalGiftARS += (t.giftAmount || 0);
  }

  return {
    id: uuidv4(),
    createdAt: new Date(),
    analysisFrom,
    analysisTo,
    focus,
    maxBudgetARS,
    candidatesAppNotifs,
    statsCount: enrichedStats.length,
    audienceCount: audienceWithChannel.length + audienceNoChannel.length,
    audienceWithChannelCount: audienceWithChannel.length,
    audienceNoChannelCount: audienceNoChannel.length,
    blockedCount: blocked.length,
    droppedByBudget,
    targetCount: capped.length,
    totalCostARS: runningCost,
    breakdown: Object.values(breakdown),
    noAppBreakdown: Object.values(noAppBreakdown),
    noAppTargets: audienceNoChannel, // detalle per-user de los sin app
    targets: capped, // detalle per-user
    blocked // para visualizar quién quedó afuera (cap/cooldown)
  };
}

// ============================================
// EXECUTE PLAN
// ============================================
/**
 * Ejecuta un plan ya analizado: crea giveaways, manda push, registra
 * historial con strategyDetails para que ROI por difusión los detecte.
 *
 * @param {Object} params
 * @param {Object} params.plan - el plan devuelto por computeAdhocPlan
 * @param {Object} params.models
 * @param {Object} params.weeklyService
 * @param {Function} params.sendPushFn - sendNotificationToAllUsers
 * @param {Function} params.setConfig
 * @param {string} params.PROMO_ALERT_KEY
 * @param {string} params.TIER_PROMOS_KEY
 * @param {Date} params.validUntil - giveaways/promos se cierran a esta hora
 * @param {string} params.title
 * @param {string} params.body
 * @param {string} params.triggeredBy
 * @param {Object} params.logger
 */
async function executeAdhocPlan({
  plan, models, weeklyService, sendPushFn,
  setConfig, getConfig, PROMO_ALERT_KEY, TIER_PROMOS_KEY,
  validUntil, title, body, triggeredBy, logger,
  bonusPctOverride // { low, mid, high } — opcional, override del % por tier de small_loser
}) {
  const { User, MoneyGiveaway, NotificationHistory, WeeklyNotifBudget } = models;
  const wk = weeklyService._weekKey();

  if (!plan.targets || plan.targets.length === 0) {
    return { skipped: 'no-targets' };
  }

  // Re-check elegibilidad (entre análisis y launch puede haber pasado un
  // rato — si alguien revocó permisos, lo sacamos).
  const allUsernames = plan.targets.map(t => t.username);
  const stillEligible = await weeklyService.filterToEligibleUsernames(User, allUsernames);
  const eligibleSet = new Set(stillEligible.map(u => u.toLowerCase()));
  const liveTargets = plan.targets.filter(t => eligibleSet.has(t.username.toLowerCase()));

  if (liveTargets.length === 0) {
    return { skipped: 'no-eligible-after-recheck' };
  }

  const droppedAtSend = plan.targets.length - liveTargets.length;
  if (droppedAtSend > 0) {
    logger.warn(`[adhoc] ${droppedAtSend} users perdieron app+notifs entre análisis y launch — excluidos`);
  }

  // Aplicar override de bonosPct si vino. Solo afecta a los del paquete
  // small_loser (whatsapp_promo). Tiers segun netwin:
  //   low  = 10k-20k → default 15
  //   mid  = 20k-30k → default 20
  //   high = 30k-50k → default 25
  if (bonusPctOverride && typeof bonusPctOverride === 'object') {
    const lo = Number(bonusPctOverride.low);
    const mi = Number(bonusPctOverride.mid);
    const hi = Number(bonusPctOverride.high);
    for (const t of liveTargets) {
      if (t.package !== 'small_loser') continue;
      const n = t.netwinARS || 0;
      if (n >= 30000 && Number.isFinite(hi) && hi >= 1 && hi <= 100) t.bonusPct = Math.round(hi);
      else if (n >= 20000 && Number.isFinite(mi) && mi >= 1 && mi <= 100) t.bonusPct = Math.round(mi);
      else if (Number.isFinite(lo) && lo >= 1 && lo <= 100) t.bonusPct = Math.round(lo);
    }
  }

  // Separar por kind: money (giveaway) vs whatsapp_promo (bono % carga).
  const moneyTargets = liveTargets.filter(t => t.kind === 'money' && (t.giftAmount || 0) > 0);
  const promoTargets = liveTargets.filter(t => t.kind === 'whatsapp_promo' && (t.bonusPct || 0) > 0);

  const historyId = require('uuid').v4();
  const giveawayIds = [];

  // 1) Cancelar giveaways auto-strategy viejos antes de crear nuevos.
  await MoneyGiveaway.updateMany(
    { status: 'active', strategySource: 'auto-strategy' },
    { $set: { status: 'cancelled' } }
  );

  // 2) Crear UN giveaway por cada monto distinto (agrupa users del mismo tier).
  if (moneyTargets.length > 0) {
    const byAmount = new Map();
    for (const t of moneyTargets) {
      const k = String(t.giftAmount);
      if (!byAmount.has(k)) byAmount.set(k, []);
      byAmount.get(k).push(t);
    }
    for (const [amountKey, list] of byAmount) {
      const amount = Number(amountKey);
      const ga = await MoneyGiveaway.create({
        id: require('uuid').v4(),
        amount,
        totalBudget: amount * list.length,
        maxClaims: list.length,
        expiresAt: validUntil,
        createdBy: triggeredBy || 'adhoc-strategy',
        strategySource: 'auto-strategy',
        prefix: null,
        audienceWhitelist: list.map(x => String(x.username).toLowerCase()),
        notificationHistoryId: historyId,
        status: 'active',
        requireZeroBalance: false
      });
      giveawayIds.push(ga.id);
    }
  }

  // 3) Para promo % carga, registramos UN tier-promo por porcentaje distinto
  //    en TIER_PROMOS_KEY (array). El endpoint /api/promo-alert/active resuelve
  //    el match por audienceWhitelist + percentage.
  const promoConfigs = [];
  if (promoTargets.length > 0) {
    const byPct = new Map();
    for (const t of promoTargets) {
      const k = String(t.bonusPct);
      if (!byPct.has(k)) byPct.set(k, []);
      byPct.get(k).push(t);
    }
    for (const [pctKey, list] of byPct) {
      promoConfigs.push({
        id: require('uuid').v4(),
        pct: Number(pctKey),
        audienceWhitelist: list.map(x => String(x.username).toLowerCase()),
        message: `🎁 ${pctKey}% de bono en tu próxima carga — válido hasta ${validUntil.toLocaleString('es-AR')}. Reclamá por WhatsApp.`,
        expiresAt: validUntil.toISOString(),
        createdAt: new Date().toISOString(),
        createdBy: triggeredBy || 'adhoc-strategy',
        source: 'adhoc-strategy'
      });
    }
    // MERGE en vez de overwrite: leemos los promos existentes (típicamente
    // del tier-bonus del jueves, que pueden estar vivos), filtramos los
    // expirados, y APPENDEAMOS los nuevos del adhoc. Sin esto, un adhoc
    // del viernes wipeaba la campaña del jueves.
    if (setConfig && TIER_PROMOS_KEY) {
      let existingPromos = [];
      if (typeof getConfig === 'function') {
        try {
          const cur = await getConfig(TIER_PROMOS_KEY);
          if (Array.isArray(cur)) {
            const nowMs = Date.now();
            existingPromos = cur.filter(p => {
              try { return p && p.expiresAt && new Date(p.expiresAt).getTime() > nowMs; }
              catch (_) { return false; }
            });
          }
        } catch (e) {
          logger && logger.warn(`[adhoc] no se pudo leer TIER_PROMOS_KEY existente: ${e.message}`);
        }
      }
      await setConfig(TIER_PROMOS_KEY, [...existingPromos, ...promoConfigs]);
    }
  }

  // 4) Mandar push.
  let sendResult = { successCount: 0, failureCount: 0, error: null };
  try {
    sendResult = await sendPushFn(
      User,
      title || '🎁 Tenés un regalo esperándote',
      body || 'Abrí la app y reclamalo antes de que se termine.',
      {
        source: 'adhoc-strategy',
        strategyType: 'adhoc-lift',
        historyId
      },
      { username: { $in: liveTargets.map(t => t.username) } }
    );
  } catch (err) {
    sendResult.error = err.message;
  }

  // 5) Si push falló completo, cancelar giveaways.
  if (sendResult.error && (sendResult.successCount || 0) === 0) {
    for (const gid of giveawayIds) {
      await MoneyGiveaway.updateOne({ id: gid }, { $set: { status: 'cancelled' } }).catch(() => {});
    }
    return { error: sendResult.error, giveawaysCancelled: giveawayIds.length };
  }

  // 6) Registrar NotificationHistory con strategyDetails per-user.
  const strategyDetails = liveTargets.map(t => ({
    username: t.username,
    lossARS: t.netwinARS,
    giftAmount: t.giftAmount || 0,
    tierLabel: t.packageLabel,
    bonusPct: t.bonusPct || null,
    refundsARS: 0,
    percentile: 0,
    claimed: false,
    classification: null
  }));

  await NotificationHistory.create({
    id: historyId,
    sentAt: new Date(),
    audienceType: 'list',
    audienceCount: liveTargets.length,
    title: title || '🎁 Tenés un regalo esperándote',
    body: body || 'Abrí la app y reclamalo antes de que se termine.',
    type: moneyTargets.length > 0 ? 'money_giveaway' : (promoTargets.length > 0 ? 'whatsapp_promo' : 'plain'),
    giveawayAmount: null, // multi-tier, no aplica un único monto
    giveawayExpiresAt: validUntil,
    totalUsers: sendResult.totalUsers || liveTargets.length,
    successCount: sendResult.successCount || 0,
    failureCount: sendResult.failureCount || 0,
    cleanedTokens: sendResult.cleanedTokens || 0,
    strategyType: 'adhoc-lift',
    strategyMeta: {
      analysisFrom: plan.analysisFrom,
      analysisTo: plan.analysisTo,
      focus: plan.focus,
      maxBudgetARS: plan.maxBudgetARS,
      totalCostARS: plan.totalCostARS,
      breakdown: plan.breakdown,
      droppedAtSend
    },
    strategyWeekKey: wk,
    strategyDetails,
    audienceUsernames: liveTargets.map(t => t.username),
    sentBy: triggeredBy || 'admin'
  });

  // 7) Registrar en WeeklyNotifBudget (cap+cooldown).
  for (const t of liveTargets) {
    await weeklyService.recordSent({
      username: t.username,
      weekKey: wk,
      type: 'adhoc-lift',
      historyId,
      tier: t.package,
      giftAmount: t.giftAmount || null,
      bonusPct: t.bonusPct || null,
      WeeklyNotifBudget
    });
  }

  return {
    success: true,
    historyId,
    giveawayIds,
    promoConfigs,
    sentCount: sendResult.successCount || 0,
    failureCount: sendResult.failureCount || 0,
    droppedAtSend,
    totalCostARS: plan.totalCostARS
  };
}

module.exports = {
  computeAdhocPlan,
  executeAdhocPlan,
  storeAdhocPlan,
  getAdhocPlan,
  consumeAdhocPlan,
  ADHOC_PACKAGES
};
