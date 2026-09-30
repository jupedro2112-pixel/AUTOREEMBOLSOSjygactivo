/**
 * Controlador de Referidos
 * Endpoints de usuario y admin para el sistema de referidos
 */
const asyncHandler = require('../utils/asyncHandler');
const { AppError } = require('../utils/AppError');
const { User, ReferralCommission, ReferralPayout, ReferralEvent, Transaction } = require('../models');
const referralCalculationService = require('../services/referralCalculationService');
const referralPayoutService = require('../services/referralPayoutService');
const { getCurrentPeriodKey, getPreviousPeriodKey, getPeriodLabel, getPeriodRange, getNextPeriodLabel } = require('../utils/periodKey');
const { generateReferralCode } = require('../utils/referralCode');
const referralTierService = require('../services/referralTierService'); // #171
const { getGlobalReferralRate } = require('../utils/referralRate'); // #174
const logger = require('../utils/logger');

// Validate period key format (YYYY-MM)
const PERIOD_KEY_REGEX = /^\d{4}-\d{2}$/;
// Allowed status values for payout queries
const VALID_PAYOUT_STATUSES = ['pending', 'paid', 'failed', 'cancelled'];
// Brand domain used for referral links shown to end users
// #168: el link sale del dominio PROPIO (antes apuntaba a vipcargas.com, el hermano). La PWA
// lee ?ref= en la raíz; /linkreferido redirige por compatibilidad.
// Base del link: PUBLIC_BASE_URL si está seteada; si no, el host del request (Render de pruebas
// → link de Render; EB → autoreembolsos.com). Mismo criterio que _publicBaseUrlFromRequest en server.js.
function referralBaseUrl(req) {
  const fromEnv = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (fromEnv) return fromEnv + '/';
  const host = req && req.get && req.get('host');
  if (host) {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    return `${proto}://${host}/`;
  }
  return 'https://autoreembolsos.com/';
}

/**
 * Sanitize a string for use as a plain-string query filter (no operators)
 * Strips MongoDB operator prefixes to prevent NoSQL injection via query objects.
 */
function sanitizeString(value) {
  if (typeof value !== 'string') return null;
  // Remove any $ prefixes that could inject Mongo operators
  return value.replace(/^\$/, '').trim();
}

/**
 * Sanitize a period key — only allow YYYY-MM format
 */
function sanitizePeriodKey(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return PERIOD_KEY_REGEX.test(s) ? s : null;
}

// =============================================
// Endpoints de Usuario
// =============================================

/**
 * GET /api/referrals/me
 * Información del referido del usuario actual: código, link, stats
 */
const getMyReferralInfo = asyncHandler(async (req, res) => {
  logger.info(`[Referrals] GET /me solicitado por ${req.user.username} (${req.user.userId})`);
  let user = await User.findOne({ id: req.user.userId }).lean();
  if (!user) throw new AppError('Usuario no encontrado', 404);

  // Auto-generate referralCode for legacy users who don't have one
  if (!user.referralCode) {
    logger.info(`[Referrals] Usuario ${req.user.username} sin referralCode — generando automáticamente`);
    let newCode = null;
    for (let attempts = 0; attempts < 10; attempts++) {
      const candidate = generateReferralCode();
      const collision = await User.findOne({ referralCode: candidate }).lean();
      if (!collision) { newCode = candidate; break; }
    }
    if (!newCode) throw new AppError('No se pudo generar un código de referido único. Reintentá.', 500);

    const updated = await User.findOneAndUpdate(
      { id: user.id, referralCode: null },
      { $set: { referralCode: newCode } },
      { new: true }
    ).lean();

    if (!updated) {
      // Race condition: another concurrent request already set the code — re-fetch
      const refetched = await User.findOne({ id: user.id }).lean();
      if (!refetched || !refetched.referralCode) {
        throw new AppError('No se pudo guardar el código de referido. Reintentá.', 500);
      }
      user = refetched;
      logger.info(`[Referrals] Código ya generado concurrentemente para ${user.username}: ${user.referralCode}`);
    } else if (!updated.referralCode) {
      throw new AppError('No se pudo guardar el código de referido. Reintentá.', 500);
    } else {
      user = updated;
      logger.info(`[Referrals] Código generado automáticamente para ${user.username}: ${user.referralCode}`);
    }
  }

  const referralLink = user.referralCode
    ? `${referralBaseUrl(req)}?ref=${encodeURIComponent(user.referralCode)}`
    : null;

  // Contar referidos
  const totalReferred = await User.countDocuments({ referredByUserId: user.id });
  const activeReferred = await User.countDocuments({
    referredByUserId: user.id,
    referralStatus: 'active'
  });

  // Período actual
  const currentPeriod = getCurrentPeriodKey();

  // Total históricamente acreditado
  const totalCredited = await Transaction.aggregate([
    { $match: { userId: user.id, type: 'referral_commission', status: 'completed' } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);

  const historicalTotal = totalCredited[0]?.total || 0;

  res.json({
    status: 'success',
    data: {
      referralCode: user.referralCode,
      referralLink,
      referralRate: (await referralTierService.resolveReferralRate(user)).rate, // #143/#171: el % real que se le paga (nivel por referidos activos)
      totalReferred,
      activeReferred,
      currentPeriod,
      currentPeriodLabel: getPeriodLabel(currentPeriod),
      historicalTotalCredited: historicalTotal,
      note: 'Las ganancias por referidos se acreditan mensualmente en fichas'
    }
  });
});

/**
 * GET /api/referrals/summary
 * Resumen de comisiones: pendiente del mes actual y acumulado
 */
const getMyReferralSummary = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const currentPeriod = getCurrentPeriodKey();
  const previousPeriod = getPreviousPeriodKey();

  // Comisiones del período actual
  const currentCommissions = await ReferralCommission.find({
    periodKey: currentPeriod,
    referrerUserId: userId
  }).lean();

  const pendingAmount = currentCommissions
    .filter(c => c.status === 'calculated')
    .reduce((sum, c) => sum + c.commissionAmount, 0);

  // Payout del período anterior (si existe)
  const lastPayout = await ReferralPayout.findOne({
    referrerUserId: userId,
    status: 'paid'
  }).sort({ createdAt: -1 }).lean();

  res.json({
    status: 'success',
    data: {
      currentPeriod,
      currentPeriodLabel: getPeriodLabel(currentPeriod),
      pendingCommissions: currentCommissions.filter(c => c.status === 'calculated').length,
      pendingEstimatedAmount: pendingAmount,
      lastPayout: lastPayout ? {
        periodKey: lastPayout.periodKey,
        periodLabel: getPeriodLabel(lastPayout.periodKey),
        amount: lastPayout.totalCommissionAmount,
        creditedAt: lastPayout.creditedAt
      } : null,
      estimatedCreditDate: `Primer día hábil de ${getNextPeriodLabel(currentPeriod)}`
    }
  });
});

/**
 * GET /api/referrals/history
 * Historial de pagos del usuario
 */
const getMyReferralHistory = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const payouts = await ReferralPayout.find({ referrerUserId: userId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit))
    .lean();

  const total = await ReferralPayout.countDocuments({ referrerUserId: userId });

  const payoutsWithLabels = payouts.map(p => ({
    ...p,
    periodLabel: getPeriodLabel(p.periodKey)
  }));

  res.json({
    status: 'success',
    data: {
      payouts: payoutsWithLabels,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit))
      }
    }
  });
});

/**
 * GET /api/referrals/pending
 * Comisiones pendientes del período actual
 */
const getMyPendingCommissions = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const currentPeriod = getCurrentPeriodKey();

  const commissions = await ReferralCommission.find({
    referrerUserId: userId,
    periodKey: currentPeriod,
    status: 'calculated'
  }).lean();

  res.json({
    status: 'success',
    data: {
      periodKey: currentPeriod,
      periodLabel: getPeriodLabel(currentPeriod),
      commissions,
      totalPending: commissions.reduce((sum, c) => sum + c.commissionAmount, 0)
    }
  });
});

// =============================================
// Endpoints de Admin
// =============================================

/**
 * GET /api/admin/referrals
 * Resumen de todos los referidores
 */
const adminGetReferralsSummary = asyncHandler(async (req, res) => {
  logger.info(`[Referrals] Admin summary solicitado por ${req.user.username}`);
  const { page = 1, limit = 50 } = req.query;
  const rawPeriod = req.query.period;
  const period = sanitizePeriodKey(rawPeriod);

  if (rawPeriod && !period) {
    throw new AppError('Formato de período inválido. Usar YYYY-MM', 400);
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  // Contar totales globales
  const referrerIdsAll = await User.distinct('referredByUserId', { referredByUserId: { $ne: null, $exists: true } });
  const totalReferrers = referrerIdsAll.length;
  const totalReferred = await User.countDocuments({ referredByUserId: { $ne: null, $exists: true } });

  // Global financial metrics from payout records (paid payouts = settled commissions)
  const [globalPayoutStats] = await ReferralPayout.aggregate([
    { $match: { status: 'paid' } },
    {
      $group: {
        _id: null,
        totalPaid: { $sum: '$totalCommissionAmount' },
        payoutCount: { $sum: 1 }
      }
    }
  ]);
  const totalHistoricalPaid = globalPayoutStats?.totalPaid || 0;
  const totalPayouts = globalPayoutStats?.payoutCount || 0;

  // Global pending: sum of commissionAmount where status=calculated
  const [globalPendingStats] = await ReferralCommission.aggregate([
    { $match: { status: 'calculated' } },
    {
      $group: {
        _id: null,
        totalPending: { $sum: '$commissionAmount' }
      }
    }
  ]);
  const totalPending = globalPendingStats?.totalPending || 0;

  // Global settled revenue: totalGenerated uses the authoritative paid-payout total (not
  // settledCommissionAmount which is 0 for legacy payouts) plus current calculated-commission
  // pending amounts.  After the backfill migration and a fresh Calculate run the pending figure
  // will drop to the correct delta (e.g. $53 instead of $109), giving an accurate total.
  // Immediately after deployment (before Calculate is re-run) totalGenerated will reflect the
  // pre-Calculate pending amount, which is intentional — it shows paid + all-outstanding-pending.
  const totalGenerated = totalHistoricalPaid + totalPending;

  logger.info(
    `[Referrals] adminSummary summaryTotalPaid=${totalHistoricalPaid.toFixed(2)} ` +
    `summaryPending=${totalPending.toFixed(2)} summaryTotalGenerated=${totalGenerated.toFixed(2)} ` +
    `totalPayouts=${totalPayouts}`
  );

  // Current period stats
  const currentPeriodKey = getCurrentPeriodKey();
  const [currentPeriodStats] = await ReferralCommission.aggregate([
    { $match: { periodKey: currentPeriodKey } },
    {
      $group: {
        _id: null,
        totalCommission: { $sum: '$commissionAmount' },
        calculatedCount: { $sum: { $cond: [{ $eq: ['$status', 'calculated'] }, 1, 0] } }
      }
    }
  ]);

  // Top referidores por todos los tiempos
  const topReferrers = await User.aggregate([
    {
      $lookup: {
        from: 'users',
        localField: 'id',
        foreignField: 'referredByUserId',
        as: 'referredUsers'
      }
    },
    { $match: { 'referredUsers.0': { $exists: true } } },
    {
      $project: {
        id: 1,
        username: 1,
        referralCode: 1,
        referralTier: 1,
        referralRateOverride: 1,
        excludedFromReferral: 1,
        totalReferreds: { $size: '$referredUsers' },
        referredUsernames: {
          $map: { input: '$referredUsers', as: 'u', in: '$$u.username' }
        },
        referredUserIds: {
          $map: { input: '$referredUsers', as: 'u', in: '$$u.id' }
        }
      }
    },
    { $sort: { totalReferreds: -1 } },
    { $skip: skip },
    { $limit: parseInt(limit) }
  ]);

  // Enrich each referrer with historical paid and pending balances
  if (topReferrers.length > 0) {
    const referrerIds = topReferrers.map(r => r.id);

    const commissionStats = await ReferralCommission.aggregate([
      { $match: { referrerUserId: { $in: referrerIds } } },
      {
        $group: {
          _id: '$referrerUserId',
          totalSettled: { $sum: '$settledCommissionAmount' },
          totalPending: { $sum: { $cond: [{ $eq: ['$status', 'calculated'] }, '$commissionAmount', 0] } },
          currentPeriodCommission: {
            $sum: { $cond: [{ $eq: ['$periodKey', currentPeriodKey] }, '$commissionAmount', 0] }
          }
        }
      }
    ]);
    const commissionsByReferrer = new Map(commissionStats.map(c => [c._id, c]));

    const lastPayoutStats = await ReferralPayout.aggregate([
      { $match: { referrerUserId: { $in: referrerIds }, status: 'paid' } },
      { $sort: { creditedAt: -1 } },
      {
        $group: {
          _id: '$referrerUserId',
          lastPayoutDate: { $first: '$creditedAt' },
          lastPayoutAmount: { $first: '$totalCommissionAmount' },
          lastPayoutPeriod: { $first: '$periodKey' },
          // Authoritative total paid per referrer — sourced from ReferralPayout (paid) records,
          // not from ReferralCommission.settledCommissionAmount which is 0 for legacy payouts
          // that were created before the incremental settlement feature was deployed.
          totalPaidFromPayouts: { $sum: '$totalCommissionAmount' }
        }
      }
    ]);
    const lastPayoutByReferrer = new Map(lastPayoutStats.map(p => [p._id, p]));

    // Most-recent payout of ANY status per referrer — used to show "último estado" in admin table
    const latestAnyStatusPayout = await ReferralPayout.aggregate([
      { $match: { referrerUserId: { $in: referrerIds } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$referrerUserId',
          latestPayoutStatus: { $first: '$status' },
          latestPayoutPeriod: { $first: '$periodKey' }
        }
      }
    ]);
    const latestAnyStatusByReferrer = new Map(latestAnyStatusPayout.map(p => [p._id, p]));

    for (const r of topReferrers) {
      const cs = commissionsByReferrer.get(r.id);
      const lp = lastPayoutByReferrer.get(r.id);
      const lap = latestAnyStatusByReferrer.get(r.id);
      // Use paid-payout total as the authoritative "total paid" per referrer.
      // This is consistent with the detail view (adminGetUserReferrals) and fixes the
      // "$0 paid" inconsistency that occurred when settledCommissionAmount was 0 for
      // old payouts (created before the perReferredDetails / incremental settlement feature).
      const totalPaid = lp?.totalPaidFromPayouts || 0;
      const totalPending = cs?.totalPending || 0;
      r.financialStats = {
        totalSettledCommission: totalPaid,
        totalPendingCommission: totalPending,
        totalGenerated: totalPaid + totalPending,
        currentPeriodCommission: cs?.currentPeriodCommission || 0,
        lastPayoutDate: lp?.lastPayoutDate || null,
        lastPayoutAmount: lp?.lastPayoutAmount || null,
        lastPayoutPeriod: lp?.lastPayoutPeriod || null,
        // Status of the most recent payout attempt (any status — used for "Último estado" badge)
        latestPayoutStatus: lap?.latestPayoutStatus || null,
        latestPayoutPeriod: lap?.latestPayoutPeriod || null
      };

      logger.info(
        `[Referrals] summaryTableRow referrerUserId=${r.id} referrerUsername=${r.username} ` +
        `tableRowTotalPaid=${totalPaid.toFixed(2)} tableRowPending=${totalPending.toFixed(2)} ` +
        `tableRowTotalGenerated=${(totalPaid + totalPending).toFixed(2)}`
      );

      // Period-specific stats if requested
      if (period) {
        const periodCommissionStats = await ReferralCommission.aggregate([
          { $match: { periodKey: period, referrerUserId: r.id } },
          {
            $group: {
              _id: null,
              totalOwnerRevenue: { $sum: '$totalOwnerRevenue' },
              totalCommission: { $sum: '$commissionAmount' },
              totalSettled: { $sum: '$settledCommissionAmount' },
              activeReferreds: { $sum: { $cond: [{ $gt: ['$totalOwnerRevenue', 0] }, 1, 0] } }
            }
          }
        ]);
        const ps = periodCommissionStats[0];
        r.periodStats = ps ? {
          totalOwnerRevenue: ps.totalOwnerRevenue,
          estimatedCommission: ps.totalCommission,
          settledCommission: ps.totalSettled,
          activeReferreds: ps.activeReferreds
        } : null;
      }
    }
  }

  // Agregar estadísticas de comisiones por período para cada referidor
  const periodFilter = period ? { periodKey: period } : {};
  const payoutStats = await ReferralPayout.aggregate([
    { $match: periodFilter },
    {
      $group: {
        _id: '$status',
        total: { $sum: '$totalCommissionAmount' },
        count: { $sum: 1 }
      }
    }
  ]);

  res.json({
    status: 'success',
    data: {
      summary: {
        totalReferrers,
        totalReferred,
        totalHistoricalPaid,
        totalPending,
        totalGenerated,
        totalPayouts,
        currentPeriodKey,
        currentPeriodPending: currentPeriodStats?.totalCommission || 0,
        period: period || null
      },
      topReferrers,
      payoutStats,
      pagination: { page: parseInt(page), limit: parseInt(limit) }
    }
  });
});

/**
 * GET /api/admin/referrals/:userId
 * Detalle de referidos y comisiones para un usuario específico
 */
const adminGetUserReferrals = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const rawPeriod = req.query.period;
  const period = sanitizePeriodKey(rawPeriod);

  if (rawPeriod && !period) {
    throw new AppError('Formato de período inválido. Usar YYYY-MM', 400);
  }

  // Sanitize userId - must be a non-empty string without Mongo operators
  const safeUserId = sanitizeString(userId);
  if (!safeUserId) throw new AppError('userId inválido', 400);

  const user = await User.findOne({ id: safeUserId }).lean();
  if (!user) throw new AppError('Usuario no encontrado', 404);

  // Usuarios referidos por este usuario
  const referredUsersRaw = await User.find({ referredByUserId: safeUserId })
    .select('id username referredAt createdAt referralStatus excludedFromReferral jugayganaUsername jugayganaUserId isBlocked')
    .lean();
  // #174: cargas reales por referido (sin regalos) + si califica como "activo" para el nivel.
  const tierCfg = await referralTierService.getReferralTiersConfig();
  const depBy = await referralTierService.depositsByReferred(safeUserId);
  const referredUsers = referredUsersRaw.map(ru => {
    const d = depBy.get(ru.id);
    return Object.assign({}, ru, {
      referredAt: ru.referredAt || ru.createdAt,
      charges: d ? d.count : 0, totalCharged: d ? Math.round(d.total) : 0, lastChargeAt: d ? d.last : null,
      qualified: !!(d && d.total >= tierCfg.minChargedARS)
    });
  }).sort((a, b) => new Date(b.referredAt || 0) - new Date(a.referredAt || 0));
  const activeCount = referredUsers.filter(r => r.qualified).length;
  const level = await referralTierService.resolveReferralRate(user, { activeCount });

  // Comisiones del período (o todas)
  const commissionQuery = { referrerUserId: safeUserId };
  if (period) commissionQuery.periodKey = period;

  const commissions = await ReferralCommission.find(commissionQuery)
    .sort({ calculatedAt: -1 })
    .lean();

  // Pagos
  const payoutQuery = { referrerUserId: safeUserId };
  if (period) payoutQuery.periodKey = period;

  const payouts = await ReferralPayout.find(payoutQuery)
    .sort({ createdAt: -1 })
    .lean();

  // Financial summary — use two authoritative sources:
  //   • ReferralPayout (status=paid) → "total paid" (reliable even for pre-migration payouts
  //     that did not populate settledCommissionAmount on ReferralCommission records)
  //   • ReferralCommission.commissionAmount where status=calculated → "pending"
  //
  // This resolves the inconsistency where the global summary cards showed a non-zero "total paid"
  // derived from ReferralPayout while the referrer detail showed $0 because it relied on
  // settledCommissionAmount (which was 0 for payouts made before the incremental settlement
  // feature was deployed).
  const payoutMatchQuery = { referrerUserId: safeUserId, status: 'paid' };
  if (period) payoutMatchQuery.periodKey = period;
  const [paidPayoutsSummary] = await ReferralPayout.aggregate([
    { $match: payoutMatchQuery },
    {
      $group: {
        _id: null,
        total: { $sum: '$totalCommissionAmount' },
        count: { $sum: 1 }
      }
    }
  ]);
  const totalPaidFromPayouts = paidPayoutsSummary?.total || 0;
  const totalPayoutsCount = paidPayoutsSummary?.count || 0;

  // pendingAmount is commissionAmount when it is > 0 and status is 'calculated'.
  // A record with status 'paid' always has commissionAmount=0 (zeroed after payout).
  const totalPendingCommission = commissions.reduce(
    (sum, c) => sum + (c.commissionAmount > 0 ? c.commissionAmount : 0), 0
  );
  const totalGeneratedCommission = totalPaidFromPayouts + totalPendingCommission;

  logger.info(
    `[Referrals] detailView referrerUserId=${safeUserId} referrerUsername=${user.username} ` +
    `detailTotalPaid=${totalPaidFromPayouts.toFixed(2)} detailPending=${totalPendingCommission.toFixed(2)} ` +
    `detailTotalGenerated=${totalGeneratedCommission.toFixed(2)} payoutCount=${totalPayoutsCount}`
  );

  // Enrich commissions with computed fields for UI clarity
  const enrichedCommissions = commissions.map(c => ({
    ...c,
    periodLabel: getPeriodLabel(c.periodKey),
    alreadyPaidAmount: c.settledCommissionAmount || 0,
    // commissionAmount represents the current pending amount (0 after payout, delta after recalculation)
    pendingAmount: c.commissionAmount > 0 ? c.commissionAmount : 0,
    totalGeneratedAmount: (c.settledCommissionAmount || 0) + (c.commissionAmount > 0 ? c.commissionAmount : 0),
    isDelta: (c.settledCommissionAmount || 0) > 0
  }));

  res.json({
    status: 'success',
    data: {
      user: {
        id: user.id,
        username: user.username,
        referralCode: user.referralCode,
        referralLink: user.referralCode ? `${referralBaseUrl(req)}?ref=${encodeURIComponent(user.referralCode)}` : null,
        referralTier: user.referralTier,
        referralRateOverride: user.referralRateOverride,
        excludedFromReferral: user.excludedFromReferral
      },
      referredUsers,
      // #174 actividad del referidor: activos (≥ mínimo), con carga, nivel actual.
      activity: { minChargedARS: tierCfg.minChargedARS, active: activeCount, charged: referredUsers.filter(r => r.charges > 0).length,
        totalCharged: referredUsers.reduce((a, r) => a + r.totalCharged, 0), pct: level.pct, mode: level.mode,
        nextTier: level.nextTier ? { count: level.nextTier.count, pct: level.nextTier.pct, missing: level.missing } : null },
      commissions: enrichedCommissions,
      payouts: payouts.map(p => ({
        ...p,
        periodLabel: getPeriodLabel(p.periodKey)
      })),
      totalReferred: referredUsers.length,
      // Legacy field kept for backward compatibility
      totalCommissionHistorical: totalPaidFromPayouts,
      // Richer financial breakdown
      financialSummary: {
        totalSettledCommission: totalPaidFromPayouts,
        totalPendingCommission,
        totalGeneratedCommission,
        payoutCount: totalPayoutsCount
      }
    }
  });
});

/**
 * GET /api/admin/referrals/payouts
 * Historial de todos los pagos con filtros
 */
const adminGetPayouts = asyncHandler(async (req, res) => {
  logger.info(`[Referrals] Admin payouts solicitado por ${req.user.username}`);
  const { page = 1, limit = 50 } = req.query;
  const rawPeriod = req.query.period;
  const rawStatus = req.query.status;
  const rawUsername = req.query.username;
  const rawIsDelta = req.query.isDelta;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const period = sanitizePeriodKey(rawPeriod);
  if (rawPeriod && !period) throw new AppError('Formato de período inválido. Usar YYYY-MM', 400);

  const status = rawStatus && VALID_PAYOUT_STATUSES.includes(rawStatus) ? rawStatus : null;
  if (rawStatus && !status) throw new AppError('Estado inválido', 400);

  // For username search, sanitize and escape for regex
  const safeUsername = rawUsername ? sanitizeString(rawUsername) : null;

  const query = {};
  if (period) query.periodKey = period;
  if (status) query.status = status;
  if (rawIsDelta === 'true') query.isDelta = true;
  if (rawIsDelta === 'false') query.isDelta = { $ne: true };
  if (safeUsername) {
    // Escape special regex chars to prevent ReDoS
    const escaped = safeUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.referrerUsername = { $regex: escaped, $options: 'i' };
  }

  const [payouts, total] = await Promise.all([
    ReferralPayout.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    ReferralPayout.countDocuments(query)
  ]);

  res.json({
    status: 'success',
    data: {
      payouts: payouts.map(p => ({ ...p, periodLabel: getPeriodLabel(p.periodKey) })),
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit))
      }
    }
  });
});

/**
 * POST /api/admin/referrals/calculate
 * Ejecutar cálculo mensual (Fase A)
 */
const adminCalculate = asyncHandler(async (req, res) => {
  const { periodKey, dryRun = false } = req.body;
  const rawReferrerUserId = req.body.referrerUserId;

  if (!periodKey || !PERIOD_KEY_REGEX.test(periodKey)) {
    throw new AppError('periodKey inválido. Formato esperado: YYYY-MM', 400);
  }

  const referrerUserId = rawReferrerUserId ? sanitizeString(rawReferrerUserId) : null;

  logger.info(`[Admin] Cálculo de referidos iniciado por ${req.user.username} para ${periodKey}`);

  const result = await referralCalculationService.calculateCommissionsForPeriod(
    periodKey,
    { dryRun: Boolean(dryRun), referrerUserId }
  );

  res.json({
    status: 'success',
    data: result
  });
});

/**
 * POST /api/admin/referrals/preview
 * Preview del cálculo sin guardar (dry run)
 */
const adminPreview = asyncHandler(async (req, res) => {
  const { periodKey } = req.body;
  const rawReferrerUserId = req.body.referrerUserId;

  if (!periodKey || !PERIOD_KEY_REGEX.test(periodKey)) {
    throw new AppError('periodKey inválido. Formato esperado: YYYY-MM', 400);
  }

  const referrerUserId = rawReferrerUserId ? sanitizeString(rawReferrerUserId) : null;

  logger.info(`[Admin] Preview de referidos por ${req.user.username} para ${periodKey}`);

  const result = await referralCalculationService.calculateCommissionsForPeriod(
    periodKey,
    { dryRun: true, referrerUserId }
  );

  res.json({
    status: 'success',
    data: result
  });
});

/**
 * POST /api/admin/referrals/payout
 * Ejecutar pago mensual (Fase B)
 */
const adminPayout = asyncHandler(async (req, res) => {
  const { periodKey } = req.body;
  const rawReferrerUserId = req.body.referrerUserId;

  if (!periodKey || !PERIOD_KEY_REGEX.test(periodKey)) {
    throw new AppError('periodKey inválido. Formato esperado: YYYY-MM', 400);
  }

  const referrerUserId = rawReferrerUserId ? sanitizeString(rawReferrerUserId) : null;

  logger.info(`[Admin] payout request started by=${req.user.username} periodKey=${periodKey}`);

  const result = await referralPayoutService.executePayoutsForPeriod(periodKey, {
    referrerUserId,
    adminId: req.user.userId,
    adminUsername: req.user.username
  });

  // Determine logical status from actual outcome
  let finalStatus;
  if (result.payoutsCreated > 0 && result.payoutsFailed === 0) {
    finalStatus = 'success';
  } else if (result.payoutsCreated > 0 && result.payoutsFailed > 0) {
    finalStatus = 'partial';
  } else if (result.payoutsFailed > 0) {
    finalStatus = 'failed';
  } else {
    // All skipped or no commissions — not a failure
    finalStatus = 'success';
  }

  logger.info(
    `[Admin] payout completed by=${req.user.username} periodKey=${periodKey} ` +
    `payoutsCreated=${result.payoutsCreated} payoutsFailed=${result.payoutsFailed} ` +
    `payoutsSkipped=${result.payoutsSkipped} finalPayoutStatus=${finalStatus}`
  );

  res.json({
    status: finalStatus,
    data: result
  });
});

/**
 * GET /api/referrals/admin/relationships
 * Lista de todas las relaciones referidor → referido para auditoría
 */
const adminGetReferralRelationships = asyncHandler(async (req, res) => {
  logger.info(`[Referrals] Admin relationships solicitado por ${req.user.username}`);
  const { page = 1, limit = 100 } = req.query;
  const rawReferrerUsername = req.query.referrerUsername;
  const rawReferredUsername = req.query.referredUsername;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const safeReferrerUsername = rawReferrerUsername ? sanitizeString(rawReferrerUsername) : null;
  const safeReferredUsername = rawReferredUsername ? sanitizeString(rawReferredUsername) : null;

  // Buscar todos los usuarios referidos (tienen referredByUserId)
  const referredQuery = {
    referredByUserId: { $ne: null, $exists: true }
  };
  if (safeReferredUsername) {
    const escaped = safeReferredUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    referredQuery.username = { $regex: escaped, $options: 'i' };
  }

  const [referredUsers, total] = await Promise.all([
    User.find(referredQuery)
      .select('id username referredByUserId referredByCode referredAt referralStatus excludedFromReferral jugayganaUsername')
      .sort({ referredAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    User.countDocuments(referredQuery)
  ]);

  if (referredUsers.length === 0) {
    return res.json({
      status: 'success',
      data: {
        relationships: [],
        pagination: { total: 0, page: parseInt(page), pages: 0 },
        message: 'No se encontraron relaciones de referido en la base de datos. Esto indica que ningún usuario se registró usando un código de referido.'
      }
    });
  }

  // Cargar datos de referidores
  const referrerIds = [...new Set(referredUsers.map(u => u.referredByUserId))];
  const referrerDocs = await User.find({ id: { $in: referrerIds } })
    .select('id username referralCode referralTier excludedFromReferral')
    .lean();
  const referrerMap = new Map(referrerDocs.map(r => [r.id, r]));

  // Filtrar por referrerUsername si se especificó
  let relationships = referredUsers.map(referred => {
    const referrer = referrerMap.get(referred.referredByUserId);
    return {
      referredUserId: referred.id,
      referredUsername: referred.username,
      referredAt: referred.referredAt,
      referralStatus: referred.referralStatus,
      excludedFromReferral: referred.excludedFromReferral,
      jugayganaUsername: referred.jugayganaUsername || referred.username,
      codeUsed: referred.referredByCode,
      referrer: referrer ? {
        id: referrer.id,
        username: referrer.username,
        referralCode: referrer.referralCode,
        excludedFromReferral: referrer.excludedFromReferral
      } : {
        id: referred.referredByUserId,
        username: '(no encontrado)',
        referralCode: referred.referredByCode
      }
    };
  });

  if (safeReferrerUsername) {
    const escaped = safeReferrerUsername.toLowerCase();
    relationships = relationships.filter(r =>
      r.referrer.username.toLowerCase().includes(escaped)
    );
  }

  res.json({
    status: 'success',
    data: {
      relationships,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit))
      }
    }
  });
});

/**
 * GET /api/referrals/admin/activity?months=6
 * #174 — Actividad y evolución del programa de referidos para el admin: cuántos referidos hay,
 * cuántos cargaron / son activos (≥ mínimo del nivel), cuántos entraron en los últimos 7 y 30
 * días contra la ventana anterior, serie diaria de 30 días, tabla por mes y actividad por
 * referidor. Todo sale de User (referredByUserId) + Transaction deposit reales (sin regalos)
 * + ReferralCommission/ReferralPayout; NO consulta JUGAYGANA (rápido, sin netwin en vivo).
 * Fechas en día argentino (UTC-3 fijo, mismo criterio que _artDayRange en server.js).
 */
const ART_OFFSET_MS = 3 * 60 * 60 * 1000;
function _artDayKey(d) { return new Date(new Date(d).getTime() - ART_OFFSET_MS).toISOString().slice(0, 10); }
function _artMonthKey(d) { return _artDayKey(d).slice(0, 7); }
function _addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
function _pctChange(cur, prev) {
  if (!prev) return cur ? null : 0;
  return Math.round(((cur - prev) / prev) * 100);
}

const adminGetReferralActivity = asyncHandler(async (req, res) => {
  const months = Math.min(24, Math.max(1, parseInt(req.query.months) || 6));
  const cfg = await referralTierService.getReferralTiersConfig();
  const minCharged = cfg.minChargedARS;
  const now = new Date();
  const todayKey = _artDayKey(now);
  const thisMonth = _artMonthKey(now);
  const firstMonth = _addMonths(thisMonth, -(months - 1));
  // Inicio del rango mensual en UTC (00:00 ART del día 1 del primer mes).
  const rangeStart = new Date(new Date(firstMonth + '-01T00:00:00Z').getTime() + ART_OFFSET_MS);
  const dayStart60 = new Date(now.getTime() - 60 * 24 * 3600 * 1000);

  const referred = await User.find({ referredByUserId: { $ne: null, $exists: true } })
    .select('id username referredByUserId referredAt createdAt isBlocked excludedFromReferral')
    .lean();
  const ids = referred.map(r => r.id);
  const depositMatch = { userId: { $in: ids }, type: 'deposit', status: 'completed', 'metadata.source': { $nin: referralTierService.NON_BANK_SOURCES } };

  const [depByUser, depByMonth, depByDay, commByPeriod, paidByPeriod] = await Promise.all([
    ids.length ? Transaction.aggregate([
      { $match: depositMatch },
      { $group: { _id: '$userId', total: { $sum: '$amount' }, count: { $sum: 1 }, first: { $min: '$timestamp' }, last: { $max: '$timestamp' } } }
    ]) : [],
    ids.length ? Transaction.aggregate([
      { $match: Object.assign({ timestamp: { $gte: rangeStart } }, depositMatch) },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: { $subtract: ['$timestamp', ART_OFFSET_MS] } } }, total: { $sum: '$amount' }, count: { $sum: 1 }, users: { $addToSet: '$userId' } } }
    ]) : [],
    ids.length ? Transaction.aggregate([
      { $match: Object.assign({ timestamp: { $gte: dayStart60 } }, depositMatch) },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: { $subtract: ['$timestamp', ART_OFFSET_MS] } } }, total: { $sum: '$amount' }, count: { $sum: 1 }, users: { $addToSet: '$userId' } } }
    ]) : [],
    ReferralCommission.aggregate([
      { $match: { periodKey: { $gte: firstMonth } } },
      { $group: { _id: '$periodKey', commission: { $sum: { $add: [{ $ifNull: ['$settledCommissionAmount', 0] }, { $cond: [{ $gt: ['$commissionAmount', 0] }, '$commissionAmount', 0] }] } },
        withNetwin: { $sum: { $cond: [{ $gt: ['$totalOwnerRevenue', 0] }, 1, 0] } }, referrers: { $addToSet: '$referrerUserId' }, rows: { $sum: 1 } } }
    ]),
    ReferralPayout.aggregate([
      { $match: { status: 'paid', periodKey: { $gte: firstMonth } } },
      { $group: { _id: '$periodKey', paid: { $sum: '$totalCommissionAmount' }, count: { $sum: 1 } } }
    ])
  ]);

  const depMap = new Map(depByUser.map(d => [d._id, { total: Number(d.total) || 0, count: d.count, first: d.first, last: d.last }]));
  const monthDep = new Map(depByMonth.map(m => [m._id, { total: Number(m.total) || 0, count: m.count, users: (m.users || []).length }]));
  const dayDep = new Map(depByDay.map(d => [d._id, { total: Number(d.total) || 0, count: d.count, users: (d.users || []).length }]));
  const commMap = new Map(commByPeriod.map(c => [c._id, c]));
  const paidMap = new Map(paidByPeriod.map(p => [p._id, p]));

  // ── Totales ──
  let charged = 0, active = 0, blocked = 0, totalCharged = 0;
  for (const r of referred) {
    const d = depMap.get(r.id);
    if (r.isBlocked) blocked++;
    if (d) { charged++; totalCharged += d.total; if (d.total >= minCharged) active++; }
  }

  // ── Ventanas 7 / 30 días (por día ART) ──
  const dayKeys = [];
  for (let i = 59; i >= 0; i--) dayKeys.push(_artDayKey(new Date(now.getTime() - i * 24 * 3600 * 1000)));
  const newByDay = new Map(), firstByDay = new Map();
  for (const r of referred) {
    const k = _artDayKey(r.referredAt || r.createdAt);
    newByDay.set(k, (newByDay.get(k) || 0) + 1);
    const d = depMap.get(r.id);
    if (d && d.first) { const fk = _artDayKey(d.first); firstByDay.set(fk, (firstByDay.get(fk) || 0) + 1); }
  }
  const sumWindow = (map, keys, field) => keys.reduce((a, k) => { const v = map.get(k); return a + (v == null ? 0 : (field ? (v[field] || 0) : v)); }, 0);
  const win = (n) => {
    const cur = dayKeys.slice(60 - n), prev = dayKeys.slice(60 - 2 * n, 60 - n);
    const mk = (keys) => ({ newReferred: sumWindow(newByDay, keys), firstDeposits: sumWindow(firstByDay, keys), depositors: null, depositTotal: sumWindow(dayDep, keys, 'total'), depositCount: sumWindow(dayDep, keys, 'count') });
    const c = mk(cur), p = mk(prev);
    return { days: n, current: c, previous: p, change: { newReferred: _pctChange(c.newReferred, p.newReferred), firstDeposits: _pctChange(c.firstDeposits, p.firstDeposits), depositTotal: _pctChange(c.depositTotal, p.depositTotal) } };
  };
  const windows = { last7: win(7), last30: win(30) };
  const daily = dayKeys.slice(30).map(k => ({ day: k, newReferred: newByDay.get(k) || 0, firstDeposits: firstByDay.get(k) || 0, depositTotal: (dayDep.get(k) || {}).total || 0, depositors: (dayDep.get(k) || {}).users || 0 }));

  // ── Veredicto: mejora / estable / baja (nuevos + primeras cargas, 30 vs 30 anteriores) ──
  const w = windows.last30;
  const score = (x) => x.newReferred + 2 * x.firstDeposits;
  const sc = score(w.current), sp = score(w.previous);
  let trend = 'flat';
  if (sc === 0 && sp === 0) trend = 'none';
  else if (sp === 0 || sc >= sp * 1.15) trend = 'up';
  else if (sc <= sp * 0.85) trend = 'down';

  // ── Por referidor ──
  const byReferrer = new Map();
  const firstReferralByReferrer = new Map();
  const cut30 = now.getTime() - 30 * 24 * 3600 * 1000;
  for (const r of referred) {
    const rid = r.referredByUserId;
    let s = byReferrer.get(rid);
    if (!s) { s = { referred: 0, charged: 0, active: 0, new30: 0, totalCharged: 0, lastReferredAt: null, lastChargeAt: null }; byReferrer.set(rid, s); }
    const at = r.referredAt || r.createdAt;
    const atMs = at ? new Date(at).getTime() : 0;
    s.referred++;
    if (atMs >= cut30) s.new30++;
    if (!s.lastReferredAt || atMs > new Date(s.lastReferredAt).getTime()) s.lastReferredAt = at;
    const fr = firstReferralByReferrer.get(rid);
    if (!fr || atMs < fr) firstReferralByReferrer.set(rid, atMs);
    const d = depMap.get(r.id);
    if (d) {
      s.charged++; s.totalCharged += d.total;
      if (d.total >= minCharged) s.active++;
      if (d.last && (!s.lastChargeAt || new Date(d.last) > new Date(s.lastChargeAt))) s.lastChargeAt = d.last;
    }
  }
  const referrerIds = Array.from(byReferrer.keys());
  const referrerDocs = referrerIds.length ? await User.find({ id: { $in: referrerIds } }).select('id username referralRateOverride excludedFromReferral').lean() : [];
  const referrerDoc = new Map(referrerDocs.map(u => [u.id, u]));
  const referrers = [];
  for (const [rid, s] of byReferrer) {
    const u = referrerDoc.get(rid);
    let pct = null, mode = 'tiers';
    if (u && typeof u.referralRateOverride === 'number') { pct = Math.round(u.referralRateOverride * 10000) / 100; mode = 'override'; }
    else if (cfg.enabled) { pct = referralTierService.levelForCount(cfg, s.active).pct; }
    else { pct = Math.round(getGlobalReferralRate() * 10000) / 100; mode = 'flat'; }
    const lv = cfg.enabled ? referralTierService.levelForCount(cfg, s.active) : null;
    referrers.push(Object.assign({ id: rid, username: u ? u.username : '(no encontrado)', excluded: !!(u && u.excludedFromReferral), pct, mode,
      nextTier: lv && lv.nextTier ? { count: lv.nextTier.count, pct: lv.nextTier.pct, missing: lv.missing } : null }, s));
  }
  referrers.sort((a, b) => (b.active - a.active) || (b.charged - a.charged) || (b.referred - a.referred));
  const movers = referrers.filter(r => r.new30 > 0).sort((a, b) => b.new30 - a.new30).slice(0, 10)
    .map(r => ({ id: r.id, username: r.username, new30: r.new30, active: r.active, referred: r.referred }));
  const levelDist = { none: 0 };
  for (const t of cfg.tiers) levelDist[String(t.count)] = 0;
  for (const r of referrers) {
    if (r.mode !== 'tiers') continue;
    const lv = referralTierService.levelForCount(cfg, r.active);
    if (lv.tier) levelDist[String(lv.tier.count)]++; else levelDist.none++;
  }

  // ── Por mes ──
  const newReferrersByMonth = new Map();
  for (const [, ms] of firstReferralByReferrer) { const k = _artMonthKey(new Date(ms)); newReferrersByMonth.set(k, (newReferrersByMonth.get(k) || 0) + 1); }
  const newByMonth = new Map(), firstByMonth = new Map();
  for (const r of referred) {
    const k = _artMonthKey(r.referredAt || r.createdAt);
    newByMonth.set(k, (newByMonth.get(k) || 0) + 1);
    const d = depMap.get(r.id);
    if (d && d.first) { const fk = _artMonthKey(d.first); firstByMonth.set(fk, (firstByMonth.get(fk) || 0) + 1); }
  }
  const monthly = [];
  for (let i = 0; i < months; i++) {
    const k = _addMonths(firstMonth, i);
    const md = monthDep.get(k) || { total: 0, count: 0, users: 0 };
    const c = commMap.get(k), p = paidMap.get(k);
    monthly.push({
      month: k, label: getPeriodLabel(k), current: k === thisMonth,
      newReferred: newByMonth.get(k) || 0, newReferrers: newReferrersByMonth.get(k) || 0, firstDeposits: firstByMonth.get(k) || 0,
      depositors: md.users, depositTotal: Math.round(md.total), depositCount: md.count,
      withNetwin: c ? c.withNetwin : 0, commissionTotal: c ? Math.round(c.commission) : 0, referrersWithCommission: c ? (c.referrers || []).length : 0,
      calculated: !!c, paidTotal: p ? Math.round(p.paid) : 0, payouts: p ? p.count : 0
    });
  }
  for (let i = 0; i < monthly.length; i++) {
    const prev = i > 0 ? monthly[i - 1] : null;
    monthly[i].change = prev ? { newReferred: _pctChange(monthly[i].newReferred, prev.newReferred), firstDeposits: _pctChange(monthly[i].firstDeposits, prev.firstDeposits), depositTotal: _pctChange(monthly[i].depositTotal, prev.depositTotal) } : null;
  }

  res.json({
    status: 'success',
    data: {
      generatedAt: now, today: todayKey, minChargedARS: minCharged, tiersEnabled: cfg.enabled, tiers: cfg.tiers,
      totals: { referred: referred.length, referrers: referrerIds.length, charged, active, noCharge: referred.length - charged, blocked, totalCharged: Math.round(totalCharged),
        referrersWithActive: referrers.filter(r => r.active > 0).length, referrersAtLevel: referrers.filter(r => r.mode === 'tiers' && r.pct > 0).length, levelDist },
      windows, daily, trend, monthly, referrers, movers
    }
  });
});

module.exports = {
  getMyReferralInfo,
  getMyReferralSummary,
  getMyReferralHistory,
  getMyPendingCommissions,
  adminGetReferralsSummary,
  adminGetUserReferrals,
  adminGetPayouts,
  adminCalculate,
  adminPreview,
  adminPayout,
  adminGetReferralRelationships,
  adminGetReferralActivity
};
