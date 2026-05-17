/**
 * MOTOR DE ESTRATEGIA SEMANAL
 *
 * 2 campañas automáticas + 1 reporte:
 *   - Lunes 11:00 ART  → regalo de plata a perdedores semana previa
 *   - Jueves 18:00 ART → bono % carga segmentado por tier de reembolsos
 *   - Miércoles 09:00  → reporte ROI de la semana anterior (al admin)
 *
 * Cinturones de seguridad:
 *   - cap por usuario por semana (default 2)
 *   - cooldown entre 2 notifs al mismo user (default 48h)
 *   - tope global de plata regalada por semana (default 500.000 ARS)
 *   - escalación a humano si una pérdida individual supera X ARS
 *   - kill switch (emergencyStop) y pausedUntil
 *
 * El cron de tracking de ROI corre cada 30 min: busca pushes con
 * sentAt < now - 48h y roiTrackedAt = null, y mide la carga (deposits
 * JUGAYGANA) 48h post vs 48h pre del segmento target Y del control.
 */
const { v4: uuidv4 } = require('uuid');

// Helpers reutilizados de server.js — los inyectamos por params para
// que este módulo no dependa del orden de require.

// ============================================
// PERIODO ISO WEEK (replica computePeriodKey('weekly') de server.js)
// ============================================
function _getArgentinaParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const parts = fmt.formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10)
  };
}

function _getArgentinaPartsWithTime(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false
  });
  const parts = fmt.formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour: parseInt(get('hour'), 10),
    minute: parseInt(get('minute'), 10),
    dayOfWeek: wdMap[get('weekday')]
  };
}

function _weekKey(date = new Date()) {
  const { year, month, day } = _getArgentinaParts(date);
  const target = new Date(Date.UTC(year, month - 1, day));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Devuelve la weekKey de la SEMANA ANTERIOR (la que acabamos de cerrar).
function _previousWeekKey(date = new Date()) {
  const prev = new Date(date.getTime() - 7 * 24 * 3600 * 1000);
  return _weekKey(prev);
}

// ============================================
// CONFIG SINGLETON
// ============================================
async function getOrCreateConfig(WeeklyStrategyConfig) {
  let cfg = await WeeklyStrategyConfig.findOne({ id: 'main' });
  if (!cfg) {
    cfg = await WeeklyStrategyConfig.create({ id: 'main' });
  }
  return cfg;
}

// ============================================
// FILTRO ÚNICO: USUARIOS CON APP + NOTIFS
// ============================================
// REGLA HARD del producto: la estrategia automática SOLO le habla a
// usuarios que tengan PWA instalada (fcmToken con context='standalone')
// Y permiso de notificaciones concedido. Sin app o sin notifs → fuera.
//
// Esta es la ÚNICA función que decide quién es "elegible" en toda la
// estrategia. La usamos en:
//   - cómputo de audiencias (netwin / tier-bonus)
//   - cálculo del universo elegible para mostrar al admin en preview
//   - re-check defensivo justo antes de cada sendPushFn (por si alguien
//     revocó permisos entre el cómputo y el envío)
//   - filtrado del grupo control para ROI tracker
//
// Si querés cambiar la definición de "elegible" en el futuro,
// CAMBIALA SOLO ACÁ.
const APP_NOTIFS_FILTER = {
  role: 'user',
  $or: [
    // Caso 1: campos legacy top-level (un solo token "principal").
    { fcmTokenContext: 'standalone', notifPermission: 'granted' },
    // Caso 2: array fcmTokens — usamos $elemMatch para que AMBAS
    // condiciones caigan en el MISMO elemento del array. Sin
    // $elemMatch, MongoDB matchea si CUALQUIER token tiene
    // context='standalone' Y CUALQUIER (otro) token tiene
    // notifPermission='granted', dejando entrar users sin PWA real.
    { fcmTokens: { $elemMatch: { context: 'standalone', notifPermission: 'granted' } } }
  ]
};

async function getAppNotifsCandidates(User) {
  return User.find(APP_NOTIFS_FILTER, { username: 1, _id: 0 }).lean();
}

async function countAppNotifsCandidates(User) {
  return User.countDocuments(APP_NOTIFS_FILTER);
}

async function countTotalRealUsers(User) {
  return User.countDocuments({ role: 'user' });
}

// Re-check defensivo. Recibe lista de usernames y devuelve solo los que
// SIGUEN siendo elegibles AHORA. Se usa justo antes de mandar el push,
// por si alguien revocó permisos en el ínterin entre cómputo y envío.
async function filterToEligibleUsernames(User, usernames) {
  if (!usernames || usernames.length === 0) return [];
  const docs = await User.find(
    { ...APP_NOTIFS_FILTER, username: { $in: usernames } },
    { username: 1, _id: 0 }
  ).lean();
  return docs.map(d => d.username);
}

// ============================================
// CAP + COOLDOWN GATE
// ============================================
// Devuelve { ok: true } si el user puede recibir, o { ok: false, reason }.
async function canSendToUser({ username, weekKey, cooldownHours, capPerUser, WeeklyNotifBudget }) {
  const row = await WeeklyNotifBudget.findOne({ username, weekKey }).lean();
  if (!row) return { ok: true, count: 0, lastSentAt: null };
  if (row.count >= capPerUser) return { ok: false, reason: 'cap', count: row.count };
  if (row.lastSentAt) {
    const ageHours = (Date.now() - new Date(row.lastSentAt).getTime()) / 3600000;
    if (ageHours < cooldownHours) return { ok: false, reason: 'cooldown', count: row.count, hoursLeft: cooldownHours - ageHours };
  }
  return { ok: true, count: row.count, lastSentAt: row.lastSentAt };
}

async function recordSent({ username, weekKey, type, historyId, tier, giftAmount, bonusPct, WeeklyNotifBudget }) {
  await WeeklyNotifBudget.updateOne(
    { username, weekKey },
    {
      $inc: { count: 1 },
      $set: { lastSentAt: new Date() },
      $push: {
        notifications: {
          sentAt: new Date(),
          type, historyId,
          tier: tier || null,
          giftAmount: giftAmount || null,
          bonusPct: bonusPct || null
        }
      }
    },
    { upsert: true }
  );
}

// ============================================
// AUDIENCIA: CAMPAÑA NETWIN GIFT (LUNES)
// ============================================
// Para cada user con app+notifs, consulta JUGAYGANA su net de la semana
// previa. Si perdió (deposits > withdrawals) y la pérdida cae en alguno
// de los rangos configurados, lo asigna a ese tier.
//
// Retorna [{ username, lossARS, tier: { minLoss, maxLoss, giftAmount } }, ...]
//
// IMPORTANTE: este loop hace una llamada HTTP por usuario a JUGAYGANA.
// Para 5000 usuarios eso son 5000 requests. Pero solo corre una vez
// por semana (lunes 11:00) y se puede paralelizar de a 10.
async function computeNetwinGiftAudience({ User, jugaygana, config, logger }) {
  const tiers = config.netwinGift.tiers || [];
  const escalateAbove = config.netwinGift.escalateAboveARS || 500000;

  // GATE: solo usuarios con app + notifs (filtro único centralizado).
  const candidates = await getAppNotifsCandidates(User);
  const totalRealUsers = await countTotalRealUsers(User);
  const excluded = totalRealUsers - candidates.length;

  logger.info(`[strategy] netwin: ${candidates.length} elegibles con app+notifs / ${totalRealUsers} usuarios totales (${excluded} excluidos por no tener canal de push)`);

  const result = [];
  const escalated = []; // perdidas > escalateAbove → manual review
  const concurrency = 10;

  for (let i = 0; i < candidates.length; i += concurrency) {
    const slice = candidates.slice(i, i + concurrency);
    const batch = await Promise.all(slice.map(async (u) => {
      try {
        const net = await jugaygana.getUserNetLastWeek(u.username);
        if (!net || !net.success) return null;
        const dep = Number(net.totalDeposits) || 0;
        const wit = Number(net.totalWithdraws) || 0;
        const loss = dep - wit;
        if (loss <= 0) return null;
        if (loss > escalateAbove) {
          return { __escalate: true, username: u.username, loss };
        }
        const matchedTier = tiers.find(t => loss >= t.minLoss && loss <= t.maxLoss);
        if (!matchedTier) return null;
        return { username: u.username, lossARS: loss, tier: matchedTier };
      } catch (err) {
        logger.warn(`[strategy] netwin lookup falló para ${u.username}: ${err.message}`);
        return null;
      }
    }));
    for (const x of batch) {
      if (!x) continue;
      if (x.__escalate) escalated.push(x);
      else result.push(x);
    }
  }

  return { audience: result, escalated };
}

// ============================================
// AUDIENCIA: CAMPAÑA TIER BONUS (JUEVES)
// ============================================
// Computa el monto acumulado de reembolsos por usuario en los últimos
// N días, ranquea por percentiles, y asigna tier según los thresholds
// del config.
async function computeTierBonusAudience({ User, RefundClaim, config, logger }) {
  const { refundsLookbackDays, tiers } = config.tierBonus;

  // GATE: solo usuarios con app + notifs (filtro único centralizado).
  const candidates = await getAppNotifsCandidates(User);
  const totalRealUsers = await countTotalRealUsers(User);
  const excluded = totalRealUsers - candidates.length;
  logger.info(`[strategy] tier-bonus: ${candidates.length} elegibles con app+notifs / ${totalRealUsers} totales (${excluded} excluidos)`);
  const candidateUsernames = new Set(candidates.map(u => u.username));

  // 2) Suma de reembolsos por user en la ventana (status='completed').
  const since = new Date(Date.now() - refundsLookbackDays * 24 * 3600 * 1000);
  const refundAgg = await RefundClaim.aggregate([
    { $match: { status: 'completed', claimedAt: { $gte: since } } },
    { $group: { _id: '$username', total: { $sum: '$amount' } } }
  ]);

  // Filtrar a candidatos con canal abierto.
  const userRefunds = refundAgg
    .filter(r => candidateUsernames.has(r._id))
    .map(r => ({ username: r._id, totalRefundsARS: Number(r.total) || 0 }))
    .filter(r => r.totalRefundsARS > 0)
    .sort((a, b) => b.totalRefundsARS - a.totalRefundsARS);

  if (userRefunds.length === 0) {
    logger.info(`[strategy] tier-bonus: 0 usuarios con reembolsos en últimos ${refundsLookbackDays} días`);
    return { audience: [], distribution: { oro: 0, plata: 0, bronce: 0 } };
  }

  // 3) Calcular percentil de cada user.
  // Ranking: el #0 es el mejor. percentile = 100 * (N - rank) / N
  const total = userRefunds.length;
  const enriched = userRefunds.map((u, idx) => ({
    ...u,
    percentile: 100 * (total - idx) / total
  }));

  // 4) Asignar tier (primer match: oro > plata > bronce).
  // Tiers vienen ordenados de mejor a peor en el config.
  const sortedTiers = tiers.slice().sort((a, b) => b.minPercentile - a.minPercentile);
  const audience = [];
  const dist = {};
  for (const u of enriched) {
    const matched = sortedTiers.find(t =>
      u.percentile >= t.minPercentile && u.totalRefundsARS >= t.minRefundsARS
    );
    if (!matched) continue;
    audience.push({
      username: u.username,
      tier: matched,
      totalRefundsARS: u.totalRefundsARS,
      percentile: u.percentile
    });
    dist[matched.code] = (dist[matched.code] || 0) + 1;
  }

  logger.info(`[strategy] tier-bonus: ${audience.length} usuarios califican (${JSON.stringify(dist)})`);
  return { audience, distribution: dist };
}

// ============================================
// LANZAR CAMPAÑA NETWIN (LUNES)
// ============================================
async function runMondayNetwinGift({ models, jugaygana, sendPushFn, logger, dryRun = false, force = false, manualTrigger = false }) {
  const {
    User, RefundClaim, MoneyGiveaway, NotificationHistory,
    WeeklyStrategyConfig, WeeklyNotifBudget, WeeklyStrategyReport
  } = models;
  const config = await getOrCreateConfig(WeeklyStrategyConfig);

  if (!config.enabled) return { skipped: 'config.enabled = false' };
  if (config.emergencyStop) return { skipped: 'emergencyStop' };
  if (config.pausedUntil && new Date(config.pausedUntil) > new Date()) return { skipped: 'paused' };
  if (!config.netwinGift.enabled) return { skipped: 'netwinGift.enabled = false' };

  const wk = _weekKey();

  // LOCK ATÓMICO antes de cualquier side-effect. findOneAndUpdate con
  // condición lastNetwinFireWeek != wk reserva la semana en una sola
  // operación. Si dos instancias del cron corren en paralelo (cluster /
  // replicas), solo UNA gana — la otra recibe null y skipea.
  // force=true (manual run-now) salta la lock pero sigue actualizando
  // el timestamp para que el cron natural no re-dispare.
  if (!force) {
    const claim = await WeeklyStrategyConfig.findOneAndUpdate(
      {
        id: 'main',
        $or: [
          { lastNetwinFireWeek: { $ne: wk } },
          { lastNetwinFireWeek: null },
          { lastNetwinFireWeek: { $exists: false } }
        ]
      },
      { $set: { lastNetwinFireWeek: wk, lastNetwinFireAt: new Date() } },
      { new: false }
    );
    if (!claim) {
      return { skipped: `already fired this week (${wk})` };
    }
  } else if (!dryRun) {
    // Manual: actualizar timestamps igual para evitar que el cron
    // natural re-dispare en la misma semana.
    await WeeklyStrategyConfig.updateOne(
      { id: 'main' },
      { $set: { lastNetwinFireWeek: wk, lastNetwinFireAt: new Date() } }
    );
  }

  // 1) Resolver audiencia.
  const { audience, escalated } = await computeNetwinGiftAudience({ User, jugaygana, config, logger });

  // 2) Filtrar por cap + cooldown.
  const targets = [];
  const blocked = []; // <- candidatos a "control group"
  for (const item of audience) {
    const gate = await canSendToUser({
      username: item.username,
      weekKey: wk,
      cooldownHours: config.cooldownHours,
      capPerUser: config.capPerUserPerWeek,
      WeeklyNotifBudget
    });
    if (gate.ok) targets.push(item);
    else blocked.push({ ...item, blockReason: gate.reason });
  }

  // 3) Cinturón: ¿el costo total supera el budget cap?
  const totalCost = targets.reduce((s, t) => s + (t.tier.giftAmount || 0), 0);
  if (totalCost > config.weeklyBudgetCapARS) {
    logger.error(`[strategy] netwin BLOQUEADO: costo ${totalCost} > cap ${config.weeklyBudgetCapARS}`);
    await WeeklyStrategyReport.create({
      id: uuidv4(), weekKey: wk, kind: 'auto',
      status: 'budget-exceeded',
      totalSpentARS: 0, totalDeltaSalesARS: 0, totalROI: 0,
      campaigns: [],
      recommendations: [
        `🚨 La campaña de regalo netwin se frenó: costo computado ${totalCost.toLocaleString('es-AR')} ARS supera el tope semanal ${config.weeklyBudgetCapARS.toLocaleString('es-AR')}.`,
        'Subí el tope desde el panel o reducí los montos por tier antes de soltarlo.'
      ],
      configSnapshot: config.toObject(),
      errorMessage: `Cost ${totalCost} exceeds cap ${config.weeklyBudgetCapARS}`
    });
    return { skipped: 'budget-cap-exceeded', totalCost, cap: config.weeklyBudgetCapARS };
  }

  if (dryRun) {
    return {
      dryRun: true,
      audienceSize: audience.length,
      blockedCount: blocked.length,
      targetCount: targets.length,
      escalatedCount: escalated.length,
      totalCost,
      breakdown: targets.reduce((acc, t) => {
        const k = `${t.tier.minLoss}-${t.tier.maxLoss}`;
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {})
    };
  }

  if (targets.length === 0) {
    // Lock ya seteado arriba — no hace falta re-update.
    return { skipped: 'audience-empty', escalatedCount: escalated.length };
  }

  // 4) Crear giveaway con audienceWhitelist + push.
  // Estrategia: 1 giveaway por TIER (no 1 por user) para reusar el flujo
  // de MoneyGiveaway que ya tenemos. Cada tier crea su propio giveaway
  // con su monto y su whitelist.
  const tierGroups = new Map(); // key: giftAmount -> [{username, lossARS}]
  for (const t of targets) {
    const k = String(t.tier.giftAmount);
    if (!tierGroups.has(k)) tierGroups.set(k, []);
    tierGroups.get(k).push(t);
  }

  // Cancelar giveaways VIEJOS de estrategia automática antes de crear
  // los nuevos. NO toca giveaways manuales del admin (strategySource='manual')
  // ni de aprobación de reglas ('auto-rule') — esos son intocables.
  await MoneyGiveaway.updateMany(
    { status: 'active', strategySource: 'auto-strategy' },
    { $set: { status: 'cancelled' } }
  );

  const historyId = uuidv4();
  const giveawayIds = [];
  for (const [amountKey, list] of tierGroups) {
    const amount = Number(amountKey);
    const ga = await MoneyGiveaway.create({
      id: uuidv4(),
      amount,
      totalBudget: amount * list.length,
      maxClaims: list.length,
      expiresAt: new Date(Date.now() + (config.netwinGift.durationMinutes || 60 * 48) * 60 * 1000),
      createdBy: manualTrigger ? 'manual-trigger' : 'auto-strategy',
      strategySource: 'auto-strategy',
      prefix: null,
      audienceWhitelist: list.map(x => String(x.username).toLowerCase()),
      notificationHistoryId: historyId,
      status: 'active',
      requireZeroBalance: false
    });
    giveawayIds.push(ga.id);
  }

  // 5) Defensa pre-send: re-check de elegibilidad app+notifs por si
  //    alguien revocó permisos entre el cómputo de audiencia y el envío.
  let allUsernames = targets.map(t => t.username);
  const stillEligible = await filterToEligibleUsernames(User, allUsernames);
  const droppedCount = allUsernames.length - stillEligible.length;
  if (droppedCount > 0) {
    logger.warn(`[strategy] netwin: ${droppedCount} users perdieron app+notifs entre cómputo y envío — los excluyo`);
  }
  allUsernames = stillEligible;
  if (allUsernames.length === 0) {
    logger.warn(`[strategy] netwin: 0 elegibles tras re-check; aborto`);
    for (const gid of giveawayIds) {
      await MoneyGiveaway.updateOne({ id: gid }, { $set: { status: 'cancelled' } }).catch(() => {});
    }
    return { skipped: 'no-eligible-after-recheck', giveawaysCancelled: giveawayIds.length };
  }

  // Mandar push.
  const data = {
    source: 'weekly-strategy',
    strategyType: 'netwin-gift',
    weekKey: wk,
    historyId
  };
  let sendResult = { successCount: 0, failureCount: 0, error: null };
  try {
    sendResult = await sendPushFn(
      User,
      _renderTemplate(config.netwinGift.title, { amount: 'tu regalo' }),
      _renderTemplate(config.netwinGift.body, { amount: 'tu regalo' }),
      data,
      { username: { $in: allUsernames } }
    );
  } catch (err) {
    sendResult.error = err.message;
  }

  // 5.5) Si el push falló totalmente, cancelar giveaways.
  if (sendResult.error && (sendResult.successCount || 0) === 0) {
    for (const gid of giveawayIds) {
      await MoneyGiveaway.updateOne({ id: gid }, { $set: { status: 'cancelled' } }).catch(() => {});
    }
    logger.error(`[strategy] netwin giveaways CANCELADOS: push falló (${sendResult.error})`);
    return { error: sendResult.error, giveawaysCancelled: giveawayIds.length };
  }

  // 6) NotificationHistory con tracking de ROI.
  // Control group: candidatos elegibles que NO recibieron por cap/cooldown.
  // Filtramos también por app+notifs (deberían estarlo ya, pero defensiva).
  const blockedUsernames = blocked.map(b => b.username);
  const controlUsernames = await filterToEligibleUsernames(User, blockedUsernames);
  // Plan per-user para forecast detallado en ROI por difusión.
  // Se construye desde `targets` (los que efectivamente recibieron;
  // si alguno se cayó en el re-check post-send queda fuera).
  const allUsernamesSet = new Set(allUsernames);
  const strategyDetails = targets
    .filter(t => allUsernamesSet.has(t.username))
    .map(t => ({
      username: t.username,
      lossARS: t.lossARS,
      giftAmount: t.tier.giftAmount,
      tierLabel: `${t.tier.minLoss.toLocaleString('es-AR')}–${t.tier.maxLoss.toLocaleString('es-AR')}`,
      claimed: false,
      classification: null
    }));

  await NotificationHistory.create({
    id: historyId,
    sentAt: new Date(),
    audienceType: 'list',
    audienceCount: allUsernames.length,
    title: config.netwinGift.title,
    body: config.netwinGift.body,
    type: 'money_giveaway',
    strategyType: 'netwin-gift',
    strategyWeekKey: wk,
    strategyMeta: {
      giveawayIds,
      tiersBreakdown: Array.from(tierGroups.entries()).map(([amt, list]) => ({
        giftAmount: Number(amt),
        userCount: list.length
      })),
      escalatedCount: escalated.length,
      escalatedSample: escalated.slice(0, 5)
    },
    strategyDetails,
    audienceUsernames: allUsernames,
    controlGroupCount: controlUsernames.length,
    controlGroupUsernames: controlUsernames,
    successCount: sendResult.successCount || 0,
    failureCount: sendResult.failureCount || 0,
    sentBy: manualTrigger ? `manual:${manualTrigger}` : 'auto-strategy'
  });

  // 7) Marcar budget para cada user + actualizar config.
  for (const t of targets) {
    await recordSent({
      username: t.username, weekKey: wk,
      type: 'netwin-gift', historyId,
      giftAmount: t.tier.giftAmount,
      WeeklyNotifBudget
    });
  }
  // Solo $inc — el lock ya se seteó arriba al inicio.
  await WeeklyStrategyConfig.updateOne(
    { id: 'main' },
    { $inc: { totalNotifsSent: targets.length } }
  );

  logger.info(`[strategy] netwin OK: ${targets.length} push enviados, ${giveawayIds.length} giveaways activos, costo potencial ${totalCost} ARS`);
  return {
    sent: targets.length,
    delivered: sendResult.successCount || 0,
    failed: sendResult.failureCount || 0,
    blocked: blocked.length,
    escalated: escalated.length,
    totalCostARS: totalCost,
    giveawayIds,
    historyId
  };
}

// ============================================
// LANZAR CAMPAÑA TIER BONUS (JUEVES)
// ============================================
async function runThursdayTierBonus({ models, sendPushFn, setConfig, PROMO_ALERT_KEY, TIER_PROMOS_KEY, logger, dryRun = false, force = false, manualTrigger = false }) {
  const {
    User, RefundClaim, NotificationHistory,
    WeeklyStrategyConfig, WeeklyNotifBudget, WeeklyStrategyReport
  } = models;
  const config = await getOrCreateConfig(WeeklyStrategyConfig);

  if (!config.enabled) return { skipped: 'config.enabled = false' };
  if (config.emergencyStop) return { skipped: 'emergencyStop' };
  if (config.pausedUntil && new Date(config.pausedUntil) > new Date()) return { skipped: 'paused' };
  if (!config.tierBonus.enabled) return { skipped: 'tierBonus.enabled = false' };

  const wk = _weekKey();

  // LOCK ATÓMICO — ver comentario en runMondayNetwinGift.
  if (!force) {
    const claim = await WeeklyStrategyConfig.findOneAndUpdate(
      {
        id: 'main',
        $or: [
          { lastTierBonusFireWeek: { $ne: wk } },
          { lastTierBonusFireWeek: null },
          { lastTierBonusFireWeek: { $exists: false } }
        ]
      },
      { $set: { lastTierBonusFireWeek: wk, lastTierBonusFireAt: new Date() } },
      { new: false }
    );
    if (!claim) {
      return { skipped: `already fired this week (${wk})` };
    }
  } else if (!dryRun) {
    await WeeklyStrategyConfig.updateOne(
      { id: 'main' },
      { $set: { lastTierBonusFireWeek: wk, lastTierBonusFireAt: new Date() } }
    );
  }

  const { audience, distribution } = await computeTierBonusAudience({ User, RefundClaim, config, logger });

  // Filtrar por cap + cooldown.
  const targets = [];
  const blocked = [];
  for (const item of audience) {
    const gate = await canSendToUser({
      username: item.username,
      weekKey: wk,
      cooldownHours: config.cooldownHours,
      capPerUser: config.capPerUserPerWeek,
      WeeklyNotifBudget
    });
    if (gate.ok) targets.push(item);
    else blocked.push({ ...item, blockReason: gate.reason });
  }

  if (dryRun) {
    const byTier = targets.reduce((acc, t) => {
      acc[t.tier.code] = (acc[t.tier.code] || 0) + 1;
      return acc;
    }, {});
    return {
      dryRun: true,
      audienceSize: audience.length,
      blockedCount: blocked.length,
      targetCount: targets.length,
      byTier,
      distribution
    };
  }

  if (targets.length === 0) {
    // Lock ya seteado arriba — no re-update.
    return { skipped: 'audience-empty' };
  }

  // Tier bonus es una promo (no plata directa) — usamos el sistema de
  // PROMO_ALERT con audienceWhitelist. Como solo puede haber UNA promo
  // activa, agrupamos por tier y mandamos UN push por tier con su promo
  // específica (pero solo la "mayor" queda como activePromoAlert; las
  // otras se piden vía API por user).
  //
  // Simplificación: 1 push global con datos del tier en el payload.
  // Cada user ve el bonus que le corresponde porque el config del
  // promo se setea con el % del tier MÁS BAJO y el cliente respeta
  // el % suyo según su tier server-side al momento de cargar.
  //
  // Para data limpia y simple: mandamos un solo push genérico con
  // {{tier}} {{bonusPct}} renderizado por user. El sistema de push
  // soporta payload data — pero el title/body son globales por
  // batch. Para máxima precisión mandamos UN push por tier.

  const historyId = uuidv4();
  const tierResults = [];
  let totalDelivered = 0;
  let totalFailed = 0;
  let pushError = null;

  // Agrupar usuarios por código de tier.
  const byTierCode = new Map();
  for (const t of targets) {
    if (!byTierCode.has(t.tier.code)) byTierCode.set(t.tier.code, { tier: t.tier, users: [] });
    byTierCode.get(t.tier.code).users.push(t);
  }

  // No tocamos PROMO_ALERT_KEY (singleton manual / line-down) — sino que
  // acumulamos las N tier promos en el array TIER_PROMOS_KEY. Cada user ve
  // SU promo (la que tiene su username en audienceWhitelist) sin que oro
  // pise plata pise bronce.
  const tierPromosArray = [];

  for (const [code, group] of byTierCode) {
    const tier = group.tier;
    let usernames = group.users.map(u => u.username);

    // Defensa pre-send: re-check elegibilidad app+notifs.
    const stillEligible = await filterToEligibleUsernames(User, usernames);
    const dropped = usernames.length - stillEligible.length;
    if (dropped > 0) {
      logger.warn(`[strategy] tier-bonus ${code}: ${dropped} users perdieron app+notifs entre cómputo y envío — los excluyo`);
    }
    usernames = stillEligible;
    if (usernames.length === 0) {
      logger.warn(`[strategy] tier-bonus ${code}: 0 elegibles tras re-check; skip tier`);
      continue;
    }

    // Promo del tier — se añade al array, no pisa nada.
    const promo = {
      id: uuidv4(),
      message: `🎁 ${tier.label}: cargá ahora y te damos +${tier.bonusPct}% extra`,
      code: `${code.toUpperCase()}${tier.bonusPct}`,
      expiresAt: new Date(Date.now() + (config.tierBonus.promoDurationHours || 48) * 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
      createdBy: manualTrigger ? 'manual-trigger' : 'auto-strategy',
      prefix: null,
      audienceWhitelist: usernames.map(u => u.toLowerCase()),
      notificationHistoryId: historyId,
      strategyTier: code,
      strategyBonusPct: tier.bonusPct
    };
    tierPromosArray.push(promo);

    // Push.
    const data = {
      source: 'weekly-strategy',
      strategyType: 'tier-bonus',
      weekKey: wk,
      tier: code,
      bonusPct: String(tier.bonusPct),
      historyId
    };
    const title = _renderTemplate(config.tierBonus.title, {
      tier: tier.label, bonusPct: tier.bonusPct
    });
    const body = _renderTemplate(config.tierBonus.body, {
      tier: tier.label, bonusPct: tier.bonusPct,
      validHours: config.tierBonus.promoDurationHours
    });

    let sendResult = { successCount: 0, failureCount: 0, error: null };
    try {
      sendResult = await sendPushFn(User, title, body, data, { username: { $in: usernames } });
    } catch (err) {
      sendResult.error = err.message;
    }
    if (sendResult.error) pushError = sendResult.error;
    totalDelivered += sendResult.successCount || 0;
    totalFailed += sendResult.failureCount || 0;
    tierResults.push({
      code, label: tier.label, bonusPct: tier.bonusPct,
      audienceCount: usernames.length,
      delivered: sendResult.successCount || 0,
      failed: sendResult.failureCount || 0
    });
  }

  // Persistir TODOS los tier promos en el array (los users los ven via
  // /api/promo-alert/active que matchea por whitelist). Reemplaza tier
  // promos previas (las semana anterior ya no aplican).
  if (TIER_PROMOS_KEY) {
    if (tierPromosArray.length > 0) {
      await setConfig(TIER_PROMOS_KEY, tierPromosArray);
    } else {
      await setConfig(TIER_PROMOS_KEY, null);
    }
  }

  // NotificationHistory.
  const allUsernames = targets.map(t => t.username);
  const blockedUsernames = blocked.map(b => b.username);
  const controlUsernames = await filterToEligibleUsernames(User, blockedUsernames);

  // Plan per-user para forecast en ROI por difusión.
  const strategyDetails = targets.map(t => ({
    username: t.username,
    tier: t.tier.code,
    bonusPct: t.tier.bonusPct,
    refundsARS: t.totalRefundsARS,
    percentile: Math.round(t.percentile * 10) / 10,
    claimed: false,
    classification: null
  }));

  await NotificationHistory.create({
    id: historyId,
    sentAt: new Date(),
    audienceType: 'list',
    audienceCount: allUsernames.length,
    title: 'Bono % carga semanal (auto)',
    body: 'Strategy weekly tier bonus broadcast',
    type: 'whatsapp_promo',
    strategyType: 'tier-bonus',
    strategyWeekKey: wk,
    strategyMeta: { tierResults, distribution },
    strategyDetails,
    audienceUsernames: allUsernames,
    controlGroupCount: controlUsernames.length,
    controlGroupUsernames: controlUsernames,
    successCount: totalDelivered,
    failureCount: totalFailed,
    sentBy: manualTrigger ? `manual:${manualTrigger}` : 'auto-strategy'
  });

  for (const t of targets) {
    await recordSent({
      username: t.username, weekKey: wk,
      type: 'tier-bonus', historyId,
      tier: t.tier.code, bonusPct: t.tier.bonusPct,
      WeeklyNotifBudget
    });
  }

  // Solo $inc — el lock ya se seteó arriba al inicio.
  await WeeklyStrategyConfig.updateOne(
    { id: 'main' },
    { $inc: { totalNotifsSent: targets.length } }
  );

  logger.info(`[strategy] tier-bonus OK: ${targets.length} push, ${totalDelivered} entregados, breakdown ${JSON.stringify(distribution)}`);
  return {
    sent: targets.length,
    delivered: totalDelivered,
    failed: totalFailed,
    blocked: blocked.length,
    tierResults,
    historyId,
    pushError
  };
}

// ============================================
// REPORTE MIÉRCOLES
// ============================================
async function runWednesdayReport({ models, jugaygana, logger, weekKey: weekKeyArg, dryRun = false, force = false }) {
  const {
    NotificationHistory, MoneyGiveawayClaim, RefundClaim,
    WeeklyStrategyConfig, WeeklyStrategyReport
  } = models;
  const config = await getOrCreateConfig(WeeklyStrategyConfig);
  const wk = weekKeyArg || _previousWeekKey();

  // LOCK ATÓMICO — ver comentario en runMondayNetwinGift.
  if (!force) {
    const claim = await WeeklyStrategyConfig.findOneAndUpdate(
      {
        id: 'main',
        $or: [
          { lastReportWeek: { $ne: wk } },
          { lastReportWeek: null },
          { lastReportWeek: { $exists: false } }
        ]
      },
      { $set: { lastReportWeek: wk, lastReportAt: new Date() } },
      { new: false }
    );
    if (!claim) {
      return { skipped: `already generated for ${wk}` };
    }
  }

  // Buscar pushes de estrategia de la semana objetivo.
  const histories = await NotificationHistory.find({
    strategyWeekKey: wk
  }).lean();

  const campaigns = [];
  let totalSpentARS = 0;
  let totalDeltaSalesARS = 0;

  for (const h of histories) {
    // Costo: para netwin-gift es la suma de claims; para tier-bonus es Δ
    // de carga * bonus% pagado. Acá aproximamos.
    let totalGiftedARS = 0;
    let totalClaimedCount = 0;
    if (h.strategyType === 'netwin-gift') {
      const claims = await MoneyGiveawayClaim.aggregate([
        { $match: { notificationHistoryId: h.id } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]);
      totalGiftedARS = claims[0] ? Number(claims[0].total) || 0 : 0;
      totalClaimedCount = claims[0] ? Number(claims[0].count) || 0 : 0;
    } else if (h.strategyType === 'tier-bonus') {
      // En bonus % no hay "claim" directo de plata regalada — el gasto
      // se materializa solo cuando el user efectivamente carga. Lo
      // estimamos como (chargesAfter48h del segmento) * (bonus% promedio)
      // pero acá lo dejamos en 0 hasta que el ROI tracker mida cargas.
      totalGiftedARS = 0;
      totalClaimedCount = h.waClicks || 0;
    }

    totalSpentARS += totalGiftedARS;
    totalDeltaSalesARS += (Number(h.chargesAfter48hARS) || 0) - (Number(h.chargesBefore48hARS) || 0);

    const roi = totalGiftedARS > 0
      ? (((Number(h.chargesAfter48hARS) || 0) - (Number(h.chargesBefore48hARS) || 0)) - totalGiftedARS) / totalGiftedARS
      : null;

    campaigns.push({
      campaign: h.strategyType,
      notifsSent: h.successCount || 0,
      audienceSize: h.audienceCount || 0,
      controlGroupSize: h.controlGroupCount || 0,
      totalGiftedARS,
      totalClaimedCount,
      waClicks: h.waClicks || 0,
      chargesBefore48hARS: Number(h.chargesBefore48hARS) || 0,
      chargesAfter48hARS: Number(h.chargesAfter48hARS) || 0,
      controlChargesBefore48hARS: Number(h.controlChargesBefore48hARS) || 0,
      controlChargesAfter48hARS: Number(h.controlChargesAfter48hARS) || 0,
      deltaSalesAttributableARS: (Number(h.chargesAfter48hARS) || 0) - (Number(h.chargesBefore48hARS) || 0)
                                 - ((Number(h.controlChargesAfter48hARS) || 0) - (Number(h.controlChargesBefore48hARS) || 0)),
      roi,
      perTier: h.strategyMeta && h.strategyMeta.tierResults ? h.strategyMeta.tierResults : null
    });
  }

  // Recomendaciones automáticas.
  const recommendations = _generateRecommendations(campaigns, config);
  const totalROI = totalSpentARS > 0 ? (totalDeltaSalesARS - totalSpentARS) / totalSpentARS : null;

  if (dryRun) {
    return { dryRun: true, weekKey: wk, campaigns, totalSpentARS, totalDeltaSalesARS, totalROI, recommendations };
  }

  // Upsert (idempotente — si se vuelve a generar para la misma semana,
  // sobreescribe en vez de crear duplicado).
  const existing = await WeeklyStrategyReport.findOne({ weekKey: wk, kind: 'auto' });
  if (existing) {
    await WeeklyStrategyReport.updateOne(
      { _id: existing._id },
      {
        $set: {
          generatedAt: new Date(),
          status: 'ok',
          totalSpentARS, totalDeltaSalesARS, totalROI: totalROI || 0,
          campaigns, recommendations,
          configSnapshot: config.toObject()
        }
      }
    );
  } else {
    await WeeklyStrategyReport.create({
      id: uuidv4(),
      weekKey: wk,
      kind: 'auto',
      status: 'ok',
      generatedAt: new Date(),
      totalSpentARS, totalDeltaSalesARS, totalROI: totalROI || 0,
      campaigns, recommendations,
      configSnapshot: config.toObject()
    });
  }

  await WeeklyStrategyConfig.updateOne(
    { id: 'main' },
    { $set: { lastReportWeek: wk, lastReportAt: new Date(), totalSpentARS: (config.totalSpentARS || 0) + totalSpentARS } }
  );

  logger.info(`[strategy] reporte semana ${wk}: ${campaigns.length} campañas, gastado ${totalSpentARS} ARS, ROI ${totalROI}`);
  return { weekKey: wk, campaigns, totalSpentARS, totalDeltaSalesARS, totalROI, recommendations };
}

function _generateRecommendations(campaigns, config) {
  const recs = [];
  if (campaigns.length === 0) {
    recs.push('Esta semana no se ejecutó ninguna campaña automática. Revisá si la estrategia está pausada o si la audiencia quedó vacía.');
    return recs;
  }
  for (const c of campaigns) {
    if (c.notifsSent === 0) {
      recs.push(`⚠ La campaña ${c.campaign} se intentó disparar pero no entregó pushes (failureCount alto). Revisá logs FCM.`);
      continue;
    }
    if (c.roi !== null && c.roi !== undefined) {
      if (c.roi >= 1) recs.push(`✅ ${c.campaign}: ROI x${(1 + c.roi).toFixed(2)}. Está pagando bien — considerar mantener/ampliar.`);
      else if (c.roi >= 0) recs.push(`🟡 ${c.campaign}: ROI positivo pero bajo (${(c.roi * 100).toFixed(0)}%). Probá subir el % de bono o cambiar el copy.`);
      else recs.push(`🔴 ${c.campaign}: ROI NEGATIVO (${(c.roi * 100).toFixed(0)}%). Bajá los montos o pausá esta campaña.`);
    }
    if (c.audienceSize > 0 && c.notifsSent / c.audienceSize < 0.7) {
      recs.push(`📉 ${c.campaign}: solo entregaste a ${Math.round(100 * c.notifsSent / c.audienceSize)}% de la audiencia. Revisá tokens FCM viejos.`);
    }
    if (c.audienceSize === 0) {
      recs.push(`💤 ${c.campaign}: audiencia vacía. Bajá los thresholds de tier o el piso de reembolsos.`);
    }
    // Análisis por tier.
    if (c.perTier && Array.isArray(c.perTier)) {
      const oro = c.perTier.find(t => t.code === 'oro');
      if (oro && oro.audienceCount === 0) {
        recs.push('🥇 No hay usuarios en el tier Oro esta semana. Bajá el percentil mínimo (95→90) o el piso de reembolsos.');
      }
    }
  }
  if (config.weeklyBudgetCapARS) {
    const totalCost = campaigns.reduce((s, c) => s + (c.totalGiftedARS || 0), 0);
    const pctUsed = 100 * totalCost / config.weeklyBudgetCapARS;
    if (pctUsed < 30) recs.push(`💰 Solo usaste ${pctUsed.toFixed(0)}% del tope semanal. Tenés margen para subir % de tiers.`);
    else if (pctUsed > 90) recs.push(`⚠ Usaste ${pctUsed.toFixed(0)}% del tope semanal. Subí el cap o reducí montos por tier.`);
  }
  return recs;
}

// ============================================
// ROI TRACKER (cron cada 30 min)
// ============================================
// Encuentra histories con sentAt < now - 48h y roiTrackedAt = null.
// Para cada uno, mide carga 48h pre y 48h post del segmento target Y
// del control group (usando jugaygana movements). Llena los campos.
async function runROITracker({ models, jugayganaMovements, logger, batchSize = 5 }) {
  const { NotificationHistory } = models;
  const cutoff = new Date(Date.now() - 48 * 3600 * 1000);
  const pending = await NotificationHistory.find({
    strategyType: { $ne: null },
    roiTrackedAt: null,
    sentAt: { $lt: cutoff }
  }).limit(batchSize);

  if (pending.length === 0) return { tracked: 0 };

  let tracked = 0;
  for (const h of pending) {
    try {
      const sentAt = new Date(h.sentAt).getTime();
      const preFromMs = sentAt - 48 * 3600 * 1000;
      const preToMs = sentAt;
      const postFromMs = sentAt;
      const postToMs = sentAt + 48 * 3600 * 1000;

      const tgtUsernames = h.audienceUsernames || [];
      const ctlUsernames = h.controlGroupUsernames || [];

      const tgtPre = await _sumChargesForUsers(jugayganaMovements, tgtUsernames, preFromMs, preToMs);
      const tgtPost = await _sumChargesForUsers(jugayganaMovements, tgtUsernames, postFromMs, postToMs);
      const ctlPre = await _sumChargesForUsers(jugayganaMovements, ctlUsernames, preFromMs, preToMs);
      const ctlPost = await _sumChargesForUsers(jugayganaMovements, ctlUsernames, postFromMs, postToMs);

      await NotificationHistory.updateOne(
        { _id: h._id },
        {
          $set: {
            roiTrackedAt: new Date(),
            chargesBefore48hARS: tgtPre.totalARS,
            chargesAfter48hARS: tgtPost.totalARS,
            chargedUsersAfter: tgtPost.usersWithCharges,
            controlChargesBefore48hARS: ctlPre.totalARS,
            controlChargesAfter48hARS: ctlPost.totalARS,
            controlChargedUsersAfter: ctlPost.usersWithCharges
          }
        }
      );
      tracked++;
      logger.info(`[strategy] ROI tracked id=${h.id} pre=${tgtPre.totalARS} post=${tgtPost.totalARS} ctl_pre=${ctlPre.totalARS} ctl_post=${ctlPost.totalARS}`);
    } catch (err) {
      logger.error(`[strategy] ROI tracker falló para ${h.id}: ${err.message}`);
    }
  }
  return { tracked };
}

// Suma de deposits (cargas) en ARS de una lista de users dentro de una
// ventana de tiempo. Usa jugayganaMovements.getUserMovements y parsea
// los items igual que server.js getRealMovementsTotals fallback.
// Filtra por timestamp del movimiento (NO por solo fecha) para precisión
// de 48h.
async function _sumChargesForUsers(jugayganaMovements, usernames, fromMs, toMs) {
  if (!usernames || usernames.length === 0) return { totalARS: 0, usersWithCharges: 0 };
  const fromStr = _ymd(new Date(fromMs));
  const toStr = _ymd(new Date(toMs));
  let total = 0;
  let withCharges = 0;
  const concurrency = 5;
  for (let i = 0; i < usernames.length; i += concurrency) {
    const slice = usernames.slice(i, i + concurrency);
    const results = await Promise.all(slice.map(async (u) => {
      try {
        const r = await jugayganaMovements.getUserMovements(u, {
          startDate: fromStr, endDate: toStr, pageSize: 500
        });
        if (!r || !r.success) return 0;
        let dep = 0;
        for (const m of (r.movements || [])) {
          // Filtro por timestamp si está disponible; si no, asumimos
          // que el rango YYYY-MM-DD ya filtró.
          const ts = _parseTimestamp(m);
          if (ts && (ts < fromMs || ts > toMs)) continue;
          const type = String(m.type || m.operation || m.OperationType || m.Type || m.Operation || '').toLowerCase();
          let amount = 0;
          if (m.amount !== undefined) amount = parseFloat(m.amount);
          else if (m.Amount !== undefined) amount = parseFloat(m.Amount);
          else if (m.value !== undefined) amount = parseFloat(m.value);
          else if (m.Value !== undefined) amount = parseFloat(m.Value);
          else if (m.monto !== undefined) amount = parseFloat(m.monto);
          const isDep = type.includes('deposit') || type.includes('credit') ||
                        type.includes('carga') || type.includes('recarga') || amount > 0;
          if (isDep) dep += Math.abs(amount);
        }
        return dep;
      } catch (_) {
        return 0;
      }
    }));
    for (const v of results) {
      total += v;
      if (v > 0) withCharges++;
    }
  }
  return { totalARS: total, usersWithCharges: withCharges };
}

function _parseTimestamp(m) {
  const candidates = [m.timestamp, m.Timestamp, m.date, m.Date, m.datetime, m.fecha, m.Fecha, m.createdAt];
  for (const c of candidates) {
    if (!c) continue;
    const t = new Date(c).getTime();
    if (isFinite(t) && t > 0) return t;
  }
  return null;
}

// ============================================
// CLASIFICADOR PER-USER (caro, on-demand o cron lento)
// ============================================
// Mide carga 48h pre/post POR usuario (1 llamada JUGAYGANA por user)
// y clasifica cada uno como converter / passive / no_response /
// regressive. Persiste en strategyDetails.$.classification y guarda
// classificationCounts agregado.
//
// Pensado para correr UNA vez por difusión: el cron auto-classifier
// (server.js) lo llama cada 3h sobre la más vieja sin clasificar.
async function classifyHistoryPerUser({ historyId, models, jugayganaMovements, logger }) {
  const { NotificationHistory } = models;
  const h = await NotificationHistory.findOne({ id: historyId }).lean();
  if (!h) throw new Error('History not found');
  if (!h.sentAt) throw new Error('sentAt empty');
  const sentAtMs = new Date(h.sentAt).getTime();
  const ageHours = (Date.now() - sentAtMs) / 3600000;
  if (ageHours < 48) {
    return { skipped: 'too-recent', ageHours };
  }

  const preFromMs = sentAtMs - 48 * 3600 * 1000;
  const preToMs = sentAtMs;
  const postFromMs = sentAtMs;
  const postToMs = sentAtMs + 48 * 3600 * 1000;
  const fromStr = _ymd(new Date(preFromMs));
  const toStr = _ymd(new Date(postToMs));

  // Devuelve detalle granular post-push: pre/post sumas, count de
  // depósitos post, primer depósito post (timestamp + monto), y si vino
  // claimedAt, también la suma/count de depósitos POST-CLAIM (más limpio
  // para detectar reactivación atribuible al regalo).
  async function userCharges(username, claimedAtMs) {
    try {
      const r = await jugayganaMovements.getUserMovements(username, {
        startDate: fromStr, endDate: toStr, pageSize: 500
      });
      if (!r || !r.success) return { pre: 0, post: 0, postCount: 0, firstAt: null, firstAmt: 0, postClaim: null, postClaimCount: null };
      let pre = 0, post = 0, postCount = 0, firstAt = null, firstAmt = 0;
      let postClaim = null, postClaimCount = null;
      const hasClaim = Number.isFinite(claimedAtMs) && claimedAtMs > 0;
      if (hasClaim) { postClaim = 0; postClaimCount = 0; }

      // Recorremos todos los movimientos. Para timing del primer depósito
      // post, ordenamos por timestamp asc primero.
      const deposits = [];
      for (const m of (r.movements || [])) {
        const ts = _parseTimestamp(m);
        if (!ts) continue;
        const type = String(m.type || m.operation || m.OperationType || m.Type || m.Operation || '').toLowerCase();
        let amount = 0;
        if (m.amount !== undefined) amount = parseFloat(m.amount);
        else if (m.Amount !== undefined) amount = parseFloat(m.Amount);
        else if (m.value !== undefined) amount = parseFloat(m.value);
        else if (m.Value !== undefined) amount = parseFloat(m.Value);
        else if (m.monto !== undefined) amount = parseFloat(m.monto);
        const isDep = type.includes('deposit') || type.includes('credit') ||
                     type.includes('carga') || type.includes('recarga') || amount > 0;
        if (!isDep) continue;
        const a = Math.abs(amount);
        if (a <= 0) continue;
        deposits.push({ ts, amount: a });
      }
      deposits.sort((a, b) => a.ts - b.ts);

      for (const d of deposits) {
        if (d.ts >= preFromMs && d.ts < preToMs) {
          pre += d.amount;
        } else if (d.ts >= postFromMs && d.ts < postToMs) {
          post += d.amount;
          postCount++;
          if (firstAt === null) {
            firstAt = d.ts;
            firstAmt = d.amount;
          }
          // Si reclamó, contar SOLO los posteriores al claim.
          if (hasClaim && d.ts >= claimedAtMs) {
            postClaim += d.amount;
            postClaimCount++;
          }
        }
      }
      return { pre, post, postCount, firstAt, firstAmt, postClaim, postClaimCount };
    } catch (_) {
      return { pre: 0, post: 0, postCount: 0, firstAt: null, firstAmt: 0, postClaim: null, postClaimCount: null };
    }
  }

  const details = h.strategyDetails || [];
  const counts = { converter: 0, passive: 0, no_response: 0, regressive: 0 };
  const concurrency = 5;
  for (let i = 0; i < details.length; i += concurrency) {
    const slice = details.slice(i, i + concurrency);
    const results = await Promise.all(slice.map(async (d) => {
      const claimedAtMs = d.claimedAt ? new Date(d.claimedAt).getTime() : null;
      const c = await userCharges(d.username, claimedAtMs);
      let cls = null;
      const post = c.post, pre = c.pre;
      if (!d.claimed) cls = 'no_response';
      else if (pre > 0 && post < pre * 0.5) cls = 'regressive';
      else if (post > pre) cls = 'converter';
      else cls = 'passive';
      counts[cls]++;
      return {
        username: d.username,
        pre, post,
        postCount: c.postCount,
        firstAt: c.firstAt,
        firstAmt: c.firstAmt,
        postClaim: c.postClaim,
        postClaimCount: c.postClaimCount,
        classification: cls
      };
    }));

    const ops = results.map(r => {
      const setOps = {
        'strategyDetails.$.chargedBefore48hARS': r.pre,
        'strategyDetails.$.chargedAfter48hARS': r.post,
        'strategyDetails.$.depositCountAfter': r.postCount || 0,
        'strategyDetails.$.firstDepositAfterAt': r.firstAt ? new Date(r.firstAt) : null,
        'strategyDetails.$.firstDepositAfterAmountARS': r.firstAmt || 0,
        'strategyDetails.$.chargedAfterClaimARS': r.postClaim,
        'strategyDetails.$.depositCountAfterClaim': r.postClaimCount,
        'strategyDetails.$.perUserChargesTrackedAt': new Date(),
        'strategyDetails.$.classification': r.classification
      };
      return {
        updateOne: {
          filter: { id: historyId, 'strategyDetails.username': r.username },
          update: { $set: setOps }
        }
      };
    });
    if (ops.length > 0) await NotificationHistory.bulkWrite(ops, { ordered: false });
  }

  await NotificationHistory.updateOne(
    { id: historyId },
    { $set: { classificationCounts: { ...counts, classifiedAt: new Date() } } }
  );
  if (logger) logger.info(`[strategy] perf clasificado ${historyId}: ${JSON.stringify(counts)}`);
  return { classified: details.length, counts };
}

// Cron: encuentra la difusión más vieja con roiTrackedAt y SIN
// classificationCounts.classifiedAt, y la clasifica.
// Procesa 1 por vez para no saturar JUGAYGANA. Como la cadencia
// del cron en server.js es ~3h, en el peor caso clasifica 1
// difusión cada 3h — suficiente para el ritmo de la estrategia
// (lunes + jueves = 2 difusiones/semana).
async function runAutoClassifier({ models, jugayganaMovements, logger, batchLimit = 1 }) {
  const { NotificationHistory } = models;
  const pending = await NotificationHistory.find({
    strategyType: { $ne: null },
    roiTrackedAt: { $ne: null },
    sentAt: { $lt: new Date(Date.now() - 48 * 3600 * 1000) },
    $or: [
      { 'classificationCounts.classifiedAt': null },
      { 'classificationCounts.classifiedAt': { $exists: false } }
    ]
  }).sort({ sentAt: 1 }).limit(batchLimit);

  if (pending.length === 0) return { processed: 0 };

  let processed = 0;
  for (const h of pending) {
    try {
      await classifyHistoryPerUser({
        historyId: h.id, models, jugayganaMovements, logger
      });
      processed++;
    } catch (err) {
      logger.error(`[strategy] auto-classifier error en ${h.id}: ${err.message}`);
    }
  }
  return { processed };
}

function _ymd(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(date);
}

// ============================================
// CRON CHECKER (corre cada 5 min, decide qué disparar)
// ============================================
async function checkAndFireScheduledRuns({ models, jugaygana, jugayganaMovements, sendPushFn, setConfig, PROMO_ALERT_KEY, TIER_PROMOS_KEY, logger }) {
  const config = await getOrCreateConfig(models.WeeklyStrategyConfig);
  if (!config.enabled || config.emergencyStop) return;
  if (config.pausedUntil && new Date(config.pausedUntil) > new Date()) return;

  const now = _getArgentinaPartsWithTime();

  // ¿Toca lunes netwin?
  const ng = config.netwinGift;
  if (ng.enabled && now.dayOfWeek === ng.dayOfWeek && now.hour === ng.hour && now.minute >= ng.minute && now.minute < ng.minute + 10) {
    const wk = _weekKey();
    if (config.lastNetwinFireWeek !== wk) {
      logger.info(`[strategy] disparando netwin (${wk})`);
      await runMondayNetwinGift({ models, jugaygana, sendPushFn, logger });
    }
  }

  // ¿Toca jueves tier-bonus?
  const tb = config.tierBonus;
  if (tb.enabled && now.dayOfWeek === tb.dayOfWeek && now.hour === tb.hour && now.minute >= tb.minute && now.minute < tb.minute + 10) {
    const wk = _weekKey();
    if (config.lastTierBonusFireWeek !== wk) {
      logger.info(`[strategy] disparando tier-bonus (${wk})`);
      await runThursdayTierBonus({ models, sendPushFn, setConfig, PROMO_ALERT_KEY, TIER_PROMOS_KEY, logger });
    }
  }

  // ¿Toca miércoles reporte?
  const rep = config.weeklyReport;
  if (rep.enabled && now.dayOfWeek === rep.dayOfWeek && now.hour === rep.hour && now.minute >= rep.minute && now.minute < rep.minute + 10) {
    const prevWk = _previousWeekKey();
    if (config.lastReportWeek !== prevWk) {
      logger.info(`[strategy] generando reporte de ${prevWk}`);
      await runWednesdayReport({ models, jugaygana, logger });
    }
  }
}

// ============================================
// HELPERS
// ============================================
function _renderTemplate(tpl, vars) {
  if (!tpl) return '';
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

module.exports = {
  getOrCreateConfig,
  getAppNotifsCandidates,
  countAppNotifsCandidates,
  countTotalRealUsers,
  filterToEligibleUsernames,
  APP_NOTIFS_FILTER,
  runMondayNetwinGift,
  runThursdayTierBonus,
  runWednesdayReport,
  runROITracker,
  runAutoClassifier,
  classifyHistoryPerUser,
  checkAndFireScheduledRuns,
  computeNetwinGiftAudience,
  computeTierBonusAudience,
  canSendToUser,
  recordSent,
  _weekKey,
  _previousWeekKey,
  _renderTemplate
};
