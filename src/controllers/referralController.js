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
const { getReferralRateForUser } = require('../utils/referralRate');
const logger = require('../utils/logger');

// Validate period key format (YYYY-MM)
const PERIOD_KEY_REGEX = /^\d{4}-\d{2}$/;
// Allowed status values for payout queries
const VALID_PAYOUT_STATUSES = ['pending', 'paid', 'failed', 'cancelled'];
// Brand domain used for referral links shown to end users
const REFERRAL_BASE_URL = 'https://vipcargas.com/linkreferido';

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
    ? `${REFERRAL_BASE_URL}?ref=${encodeURIComponent(user.referralCode)}`
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
      referralRate: getReferralRateForUser(user), // #143: el % real que se le paga (para el copy del modal)
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
  const referredUsers = await User.find({ referredByUserId: safeUserId })
    .select('id username referredAt referralStatus excludedFromReferral jugayganaUsername jugayganaUserId')
    .lean();

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
        referralLink: user.referralCode ? `${REFERRAL_BASE_URL}?ref=${encodeURIComponent(user.referralCode)}` : null,
        referralTier: user.referralTier,
        referralRateOverride: user.referralRateOverride,
        excludedFromReferral: user.excludedFromReferral
      },
      referredUsers,
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
  adminGetReferralRelationships
};
