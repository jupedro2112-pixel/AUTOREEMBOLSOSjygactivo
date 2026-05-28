/**
 * Servicio de Cálculo Mensual de Referidos
 * Fase A: calcula comisiones por período sin pagar
 */
const { v4: uuidv4 } = require('uuid');
const { User, ReferralCommission, ReferralPayout } = require('../models');
const referralRevenueService = require('./referralRevenueService');
const { getReferralRateForUser } = require('../utils/referralRate');
const logger = require('../utils/logger');

/**
 * Calcular comisiones de referidos para un período
 * @param {string} periodKey - e.g. "2026-04"
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false] - si true no guarda en DB
 * @param {string} [options.referrerUserId] - calcular solo para un referidor
 * @returns {Object} resultado del cálculo
 */
async function calculateCommissionsForPeriod(periodKey, options = {}) {
  const { dryRun = false, referrerUserId = null } = options;
  const mode = dryRun ? 'preview' : 'calculate';

  logger.info(`[ReferralCalc] Iniciando cálculo | period=${periodKey} mode=${mode}`);

  const results = {
    periodKey,
    dryRun,
    mode,
    referrersProcessed: 0,
    referredsProcessed: 0,
    commissionsCreated: 0,
    commissionsSkipped: 0,
    commissionsExcluded: 0,
    errors: [],
    details: []
  };

  let providerCallsCount = 0;

  // Armar mapa de referidores -> referidos
  // Buscar usuarios que tienen referredByUserId establecido (son los referidos)
  const referredQuery = {
    role: 'user',
    isActive: true,
    referredByUserId: { $ne: null, $exists: true }
  };
  // Si se filtró por referidor, solo buscar referidos de ese referidor
  if (referrerUserId) {
    referredQuery.referredByUserId = referrerUserId;
  }

  const referredUsers = await User.find(referredQuery).lean();

  // Armar mapa de referidores -> sus referidos
  const referrers = new Map();
  for (const user of referredUsers) {
    const referrerId = user.referredByUserId;
    if (!referrers.has(referrerId)) {
      referrers.set(referrerId, []);
    }
    referrers.get(referrerId).push(user);
  }

  if (referrers.size === 0) {
    logger.info('[ReferralCalc] No hay referidores activos con referidos asignados');
    return results;
  }

  results.referrersProcessed = referrers.size;

  // Cargar datos de los referidores por sus IDs (sin restricción de rol/estado para que funcione incluso si el referidor fue desactivado)
  const referrerIds = Array.from(referrers.keys());
  const referrerDocs = await User.find({ id: { $in: referrerIds } }).lean();
  const referrerMap = new Map();
  for (const u of referrerDocs) {
    referrerMap.set(u.id, u);
  }

  // ── Pre-fetch de revenues en PARALELO (batches) ──────────────────────────
  // Antes el cálculo consultaba JUGAYGANA secuencialmente (1 llamada por
  // referido dentro del loop). Con muchos referidos (ej. 59) eso eran 59
  // llamadas en serie → minutos de espera → el proxy/ALB cortaba con un 504
  // HTML y el frontend reventaba con "JSON.parse: unexpected character".
  //
  // Ahora pre-cargamos todos los revenues con concurrencia limitada (5 a la vez)
  // y el loop principal los lee de un Map (O(1)). Reduce el tiempo total ~5x y
  // mantiene la carga sobre JUGAYGANA acotada para no disparar su rate-limit.
  const REVENUE_CONCURRENCY = 5;
  const revenueByReferredId = new Map();
  const usersNeedingRevenue = referredUsers.filter(u => !u.excludedFromReferral);
  for (let i = 0; i < usersNeedingRevenue.length; i += REVENUE_CONCURRENCY) {
    const batch = usersNeedingRevenue.slice(i, i + REVENUE_CONCURRENCY);
    const settled = await Promise.all(batch.map(async (u) => {
      const jgUsername = u.jugayganaUsername || u.username;
      const jgUserId = u.jugayganaUserId || null;
      try {
        const r = await referralRevenueService.getUserRevenueForPeriod(jgUsername, periodKey, jgUserId);
        return [u.id, r];
      } catch (err) {
        return [u.id, { success: false, error: err.message }];
      }
    }));
    for (const [id, r] of settled) revenueByReferredId.set(id, r);
  }
  logger.info(`[ReferralCalc] Pre-fetch revenues completado | period=${periodKey} usuarios=${usersNeedingRevenue.length} concurrency=${REVENUE_CONCURRENCY}`);

  for (const [referrerId, usersReferredByThisReferrer] of referrers) {
    const referrer = referrerMap.get(referrerId);
    if (!referrer) {
      logger.warn(`[ReferralCalc] Referidor ${referrerId} no encontrado en la base de datos`);
      continue;
    }

    const referralRate = getReferralRateForUser(referrer);

    // ── Load authoritative settlement state from payout history ──────────────
    // ReferralPayout documents are the source of truth for what was already paid.
    // Relying solely on ReferralCommission.settledOwnerRevenue was fragile: running
    // calculate() more than once after a payout caused the field to be overwritten
    // with 0 (because existingIsPaid was false on the second run), which made the
    // next payout treat the already-settled slice as pending again (double payment).
    //
    // We query once per referrer and build a map keyed by referredUserId so the
    // inner loop has O(1) lookup.  The maximum cumulative value across all payouts
    // for a given referred user is taken because:
    //   • each successive payout's alreadySettled already includes all prior payouts
    //   • commissions are never negative, so the highest cumulative is always the
    //     most recent and complete settlement baseline
    //
    // referrerId comes from referredByUserId stored in the users collection.  That
    // field is populated during registration from user-provided input.  We use a
    // capturing regex (/^([a-zA-Z0-9_-]{1,128})$/) so that only the captured group
    // referrerId comes from referredByUserId stored in the users collection.  That
    // field is populated during registration from user-provided input.  We use a
    // capturing regex (/^([a-zA-Z0-9_-]{1,128})$/) so that only the captured group
    // — derived exclusively from safe characters — is used in the DB query.  This
    // breaks the taint chain: the query value is a new string produced by the regex
    // engine from safe character matches, not the original tainted input.
    // Only coerce to string for a primitive referrerId; objects (e.g. with a custom
    // toString) are rejected by the regex and result in safeReferrerId=null.
    const referrerIdPrimitive = (typeof referrerId === 'string' || typeof referrerId === 'number')
      ? String(referrerId) : '';
    const SAFE_ID_CAPTURE = /^([a-zA-Z0-9_-]{1,128})$/;
    const idMatch = SAFE_ID_CAPTURE.exec(referrerIdPrimitive);
    const safeReferrerId = idMatch ? idMatch[1] : null;

    if (!safeReferrerId) {
      logger.warn(
        `[ReferralCalc] referrerId contains unsafe characters — skipping payout history lookup ` +
        `referrer=${referrer.username} period=${periodKey}`
      );
    }

    const paidPayoutsForReferrer = safeReferrerId
      ? await ReferralPayout.find({
          periodKey,
          referrerUserId: safeReferrerId,
          status: 'paid'
        }).lean()
      : [];

    // settlementByReferred: Map<referredUserId, { settledRevenue, settledCommission }>
    // Helper: compute cumulative settled amount from a single payout detail entry
    const cumulative = (already, delta) => (already || 0) + (delta || 0);

    const settlementByReferred = new Map();
    for (const payout of paidPayoutsForReferrer) {
      const perReferredDetails = payout.details?.perReferredDetails;
      if (!Array.isArray(perReferredDetails)) continue;
      for (const detail of perReferredDetails) {
        if (!detail.referredUserId) continue;
        const cumRevenue = cumulative(detail.alreadySettledRevenue, detail.newDeltaRevenue);
        const cumCommission = cumulative(detail.alreadySettledCommission, detail.newDeltaCommission);
        const prev = settlementByReferred.get(detail.referredUserId);
        // Take the entry with the highest cumulative revenue.
        // If revenue is equal, prefer the entry with higher settled commission
        // (tie-breaker for duplicate or concurrent payout records).
        if (!prev || cumRevenue > prev.settledRevenue ||
            (cumRevenue === prev.settledRevenue && cumCommission > prev.settledCommission)) {
          settlementByReferred.set(detail.referredUserId, {
            settledRevenue: cumRevenue,
            settledCommission: cumCommission
          });
        }
      }
    }

    logger.info(
      `[ReferralCalc] paidPayoutsLoaded=${paidPayoutsForReferrer.length} ` +
      `referrer=${referrer.username} period=${periodKey} ` +
      `referredsWithSettlement=${settlementByReferred.size}`
    );
    // ─────────────────────────────────────────────────────────────────────────

    for (const referredUser of usersReferredByThisReferrer) {
      results.referredsProcessed++;

      // Verificar exclusión
      if (referredUser.excludedFromReferral) {
        logger.info(`[ReferralCalc] Usuario ${referredUser.username} excluido de referidos`);
        results.commissionsExcluded++;

        results.details.push({
          referredUsername: referredUser.username,
          referrerUsername: referrer.username,
          totalOwnerRevenue: 0,
          commissionAmount: 0,
          status: 'excluded',
          reason: 'Usuario marcado como excluido del sistema de referidos'
        });

        if (!dryRun) {
          // Find existing record first so we can preserve its id on update.
          const excludedExisting = await ReferralCommission.findOne({
            periodKey, referredUserId: referredUser.id
          }).lean();
          const excludedId = excludedExisting?.id || uuidv4();
          // Use $set so stale excluded records are corrected (data is always refreshed).
          // The id is included in $set to ensure it is always present, whether inserting or updating.
          await ReferralCommission.findOneAndUpdate(
            { periodKey, referredUserId: referredUser.id },
            {
              $set: {
                id: excludedId,
                periodKey,
                referrerUserId: referrerId,
                referrerUsername: referrer.username,
                referredUserId: referredUser.id,
                referredUsername: referredUser.username,
                currency: 'ARS',
                totalBets: 0,
                totalWins: 0,
                totalGgr: 0,
                totalOwnerRevenue: 0,
                referralRate,
                commissionAmount: 0,
                providersBreakdown: [],
                status: 'excluded',
                calculatedAt: new Date()
              }
            },
            { upsert: true, new: true }
          ).catch(err => {
            if (err.code !== 11000) {
              logger.error(`[ReferralCalc] Error guardando excluded para ${referredUser.username}:`, err.message);
            }
          });
        }
        continue;
      }

      // Verificar si ya existe comisión para este período y usuario referido.
      // Se consulta siempre (tanto en preview como en calculate) para poder hacer upsert correcto.
      const existing = await ReferralCommission.findOne({
        periodKey,
        referredUserId: referredUser.id
      }).lean();

      const existingCalculationFound = !!existing;
      const existingIsPaid = existingCalculationFound && existing.status === 'paid';
      // Will replace when: not dryRun and record exists (paid records get delta recalculation).
      const existingCalculationWillBeReplaced = existingCalculationFound && !dryRun;

      logger.info(
        `[ReferralCalc] mode=${mode} period=${periodKey} referrer=${referrer.username} ` +
        `referredUser=${referredUser.username} ` +
        `existingCalculationFound=${existingCalculationFound} ` +
        `existingIsPaid=${existingIsPaid} ` +
        `existingCalculationWillBeReplaced=${existingCalculationWillBeReplaced} ` +
        `calculationSource=fresh`
      );

      // Consultar revenue real en JUGAYGANA usando child_user_id (ID numérico del proveedor).
      // El panel oficial envía { child_user_id: <numeric_id>, date_from, date_to }.
      // Usar solo username/login en el body devuelve el agregado global del agente — ese era el bug
      // que causaba que todos los referidos mostraran los mismos valores enormes.
      // Si jugayganaUserId es null, el servicio retorna error explícito (revenue=0) en lugar de
      // copiar el agregado global.
      const jugayganaUsername = referredUser.jugayganaUsername || referredUser.username;
      const jugayganaUserId = referredUser.jugayganaUserId || null;

      providerCallsCount++;
      logger.info(
        `[ReferralCalc] Revenue (pre-fetch) | mode=${mode} referido=${referredUser.username} referredUserId=${jugayganaUserId} ` +
        `jugayganaUsername=${jugayganaUsername} período=${periodKey} providerCallsCount=${providerCallsCount} ` +
        `revenueScope=perUser commissionCalculationMode=individual_revenue`
      );

      // El revenue ya se consultó en paralelo en el pre-fetch de arriba; lo
      // leemos del Map. Fallback defensivo por si el usuario no estaba en el
      // batch (no debería pasar para no-excluidos).
      const revenueResult = revenueByReferredId.get(referredUser.id)
        || await referralRevenueService.getUserRevenueForPeriod(jugayganaUsername, periodKey, jugayganaUserId);

      if (!revenueResult.success) {
        const authDetail = revenueResult.authDetail || null;
        const providerMessage = revenueResult.providerMessage || null;
        const providerCode = revenueResult.providerCode || null;
        logger.error(
          `[ReferralCalc] Error revenue | referido=${referredUser.username} ` +
          `jugayganaUsername=${jugayganaUsername} período=${periodKey} error=${revenueResult.error}` +
          (providerMessage ? ` providerMsg="${providerMessage}"` : '') +
          (providerCode ? ` providerCode=${providerCode}` : '') +
          (authDetail
            ? ` authScheme=${authDetail.authScheme} tokenSource=${authDetail.tokenSource}` +
              ` tokenPresente=${authDetail.tokenPresente} reloginAttempted=${authDetail.reloginAttempted}` +
              (authDetail.isV1TokenForV2Api ? ' isV1TokenForV2Api=true' : '') +
              (authDetail.derivedLoginUrl ? ` derivedLoginUrl=${authDetail.derivedLoginUrl}` : '')
            : '')
        );

        // Armar razón descriptiva para el detalle del admin
        let reason = `Error consultando revenue: ${revenueResult.error}`;
        if (revenueResult.statusCode === 401 || revenueResult.statusCode === 403) {
          reason = `Autenticación rechazada por el proveedor (${revenueResult.statusCode})`;
          if (providerMessage) reason += `: ${providerMessage}`;
          if (authDetail) {
            reason += ` | diagnosisCategory=${revenueResult.diagnosisCategory || authDetail.diagnosisCategory || 'provider_response_inconclusive'}`;
            reason += ` | providerStatus=${revenueResult.statusCode}`;
            reason += ` | tokenSource=${authDetail.tokenSource}`;
            reason += ` | cookiePresent=${authDetail.cookiePresente}`;
            reason += ` | authModeTested=${authDetail.authModeTested || authDetail.authScheme || 'Bearer'}`;
            if (authDetail.variantsTested && authDetail.variantsTested.length > 0) {
              const varA = authDetail.variantsTested.find(v => v.variant === 'Bearer');
              const varB = authDetail.variantsTested.find(v => v.variant === 'Bearer+Cookie');
              if (varA) reason += ` | variantAStatus=${varA.status}`;
              if (varB) reason += ` | variantBStatus=${varB.status}`;
              else if (!authDetail.cookiePresente) reason += ` | variantBStatus=not_applicable_no_provider_cookie`;
              else reason += ` | variantBStatus=skipped`;
            }
            if (authDetail.sessionState) reason += ` | sessionState=${authDetail.sessionState}`;
            if (revenueResult.conclusion || authDetail.conclusion) {
              reason += ` | conclusion=${revenueResult.conclusion || authDetail.conclusion}`;
            }
          }
        } else if (revenueResult.statusCode === 422) {
          reason = `Validación rechazada por el proveedor (422)`;
          if (providerMessage) reason += `: ${providerMessage}`;
        } else if (providerMessage) {
          reason += ` | ${providerMessage}`;
        }

        results.errors.push({
          referredUsername: referredUser.username,
          jugayganaUsername,
          periodKey,
          error: revenueResult.error,
          statusCode: revenueResult.statusCode || null,
          providerMessage,
          providerCode,
          authDetail,
          providerResponse: revenueResult.rawProviderBody || null
        });
        results.details.push({
          referredUsername: referredUser.username,
          referrerUsername: referrer.username,
          jugayganaUsername,
          periodKey,
          revenueOk: false,
          totalBets: 0,
          totalWins: 0,
          totalGgr: 0,
          totalOwnerRevenue: 0,
          commissionAmount: 0,
          status: 'error',
          reason,
          providerMessage,
          providerCode,
          authDetail,
          providerResponse: revenueResult.rawProviderBody || null
        });
        continue;
      }

      const { totalOwnerRevenue, totalBets, totalWins, totalGgr, providers } = revenueResult;

      // ── Incremental settlement: delta calculation ─────────────────────────────
      // Primary source: payout history ledger (paidPayoutsForReferrer, built above).
      // This is authoritative and resilient to multiple calculate() runs because it
      // reads directly from persisted ReferralPayout documents rather than from
      // the mutable ReferralCommission.settledOwnerRevenue field.
      //
      // Fallback: ReferralCommission.settledOwnerRevenue (for backward compatibility
      // with payouts created before the perReferredDetails field was introduced, and
      // for any edge case where the payout document lacks that sub-structure).
      const historySettlement = settlementByReferred.get(referredUser.id);
      let alreadySettledRevenue = historySettlement?.settledRevenue || 0;
      let alreadySettledCommission = historySettlement?.settledCommission || 0;
      // Track how the settlement baseline was resolved (for logging and debugging)
      let settlementSource = historySettlement ? 'payoutLedger' : 'none';

      // Second fallback: if payout history has no entry for this referred user but the
      // commission record itself carries settled amounts (e.g. old payouts without
      // perReferredDetails, or the current record was freshly marked 'paid'), use them.
      if (alreadySettledRevenue === 0 && existing) {
        const fallbackRevenue = existing.settledOwnerRevenue || 0;
        if (fallbackRevenue > 0) {
          alreadySettledRevenue = fallbackRevenue;
          alreadySettledCommission = existing.settledCommissionAmount || 0;
          settlementSource = 'commissionFallback';
          logger.info(
            `[ReferralCalc] settlementFallbackUsed=true referido=${referredUser.username} ` +
            `fallbackSettledRevenue=${fallbackRevenue.toFixed(2)} period=${periodKey} ` +
            `referrerUserId=${referrerId} referredUserId=${referredUser.id}`
          );
        }
      }

      // Third fallback: legacy payout without perReferredDetails — use the commission's
      // payoutId to find the matching paid payout and reconstruct the settlement baseline.
      // This handles the case where: (a) the startup backfill migration could not run or
      // failed for this record, AND (b) settledOwnerRevenue is still 0. The commission's
      // payoutId field is set during every payout (old and new) and is preserved across
      // subsequent calculate() runs because the update $set does not include payoutId.
      if (alreadySettledRevenue === 0 && existing && existing.payoutId) {
        const matchingPayout = paidPayoutsForReferrer.find(p => p.id === existing.payoutId);
        if (matchingPayout && matchingPayout.totalCommissionAmount > 0) {
          const commissionIds = matchingPayout.details?.commissionIds;
          const N = Array.isArray(commissionIds) ? commissionIds.length : 0;
          const rate = existing.referralRate || referralRate;
          if (N > 0 && rate > 0) {
            let estimatedSettledCommission;
            if (N === 1) {
              // Exact reconstruction for single-commission payouts
              estimatedSettledCommission = matchingPayout.totalCommissionAmount;
            } else {
              // For multi-commission payouts the exact per-user commission amounts at payout
              // time are no longer available (the commissionAmount field is overwritten by each
              // Calculate run). Equal share is used here as a conservative lower bound.
              // Note: the startup backfill migration (backfillLegacyPayoutSettlements) reaches
              // this branch first and uses a revenue-proportional split which is more accurate.
              // The inline fallback here only fires when that migration was skipped or failed for
              // this specific record, so equal share is an acceptable safety-net approximation.
              estimatedSettledCommission = matchingPayout.totalCommissionAmount / N;
            }
            alreadySettledRevenue = estimatedSettledCommission / rate;
            alreadySettledCommission = estimatedSettledCommission;
            settlementSource = 'legacyPayoutReconstruction';
            logger.info(
              `[ReferralCalc] legacyPayoutFallbackUsed=true referido=${referredUser.username} ` +
              `payoutId=${existing.payoutId} ` +
              `totalPayoutAmount=${matchingPayout.totalCommissionAmount.toFixed(2)} ` +
              `commissionIdsInPayout=${N} rate=${rate} ` +
              `historicalPaidAmountByReferred=${estimatedSettledCommission.toFixed(2)} ` +
              `historicalSettledRevenueByReferred=${alreadySettledRevenue.toFixed(2)} ` +
              `historicalSettledCommissionByReferred=${alreadySettledCommission.toFixed(2)} ` +
              `period=${periodKey} referrerUserId=${referrerId} referredUserId=${referredUser.id}`
            );
          }
        }
      }

      logger.info(
        `[ReferralCalc] settlementBaseline referido=${referredUser.username} period=${periodKey} ` +
        `periodKey=${periodKey} referrerUserId=${referrerId} referredUserId=${referredUser.id} ` +
        `ledgerPayouts=${paidPayoutsForReferrer.length} ` +
        `historicalPaidAmountByReferrer=${paidPayoutsForReferrer.reduce((s, p) => s + p.totalCommissionAmount, 0).toFixed(2)} ` +
        `historicalSettledRevenueByReferred=${alreadySettledRevenue.toFixed(2)} ` +
        `historicalSettledCommissionByReferred=${alreadySettledCommission.toFixed(2)} ` +
        `settlementSource=${settlementSource}`
      );

      // Revenue not yet settled
      const newPendingRevenue = Math.max(0, totalOwnerRevenue - alreadySettledRevenue);
      // Commission on new pending revenue only (delta)
      const commissionAmount = newPendingRevenue > 0
        ? newPendingRevenue * referralRate
        : 0;

      const calculationWindowStart = alreadySettledRevenue > 0
        ? `after-settlement(${alreadySettledRevenue.toFixed(2)})`
        : 'full-period';

      logger.info(
        `[ReferralCalc] Revenue obtenido | referido=${referredUser.username} referredUserId=${jugayganaUserId} ` +
        `GGR=${totalGgr?.toFixed(2)} ownerRevenue=${totalOwnerRevenue?.toFixed(2)} ` +
        `alreadyPaidCommission=${alreadySettledCommission.toFixed(2)} ` +
        `alreadySettledRevenue=${alreadySettledRevenue.toFixed(2)} ` +
        `newPendingRevenue=${newPendingRevenue.toFixed(2)} ` +
        `pendingCommission=${commissionAmount.toFixed(2)} ` +
        `calculationWindowStart=${calculationWindowStart} ` +
        `calculationWindowEnd=period-end ` +
        `individualRevenueFound=${revenueResult.individualRevenueFound ?? true} ` +
        `usedGlobalAggregate=${revenueResult.usedGlobalAggregate ?? false} ` +
        `revenueScope=${revenueResult.revenueScope || 'perUser'} ` +
        `revenueSourceField=${revenueResult.revenueSourceField || 'child_user_id'} ` +
        `commissionCalculationMode=${alreadySettledRevenue > 0 ? 'delta_after_settlement' : 'individual_revenue'}`
      );
      // Mandatory per-referred audit log (matches problem-statement logging requirements)
      logger.info(
        `[ReferralCalc] perReferredAudit` +
        ` periodKey=${periodKey}` +
        ` referrerUserId=${referrerId}` +
        ` referredUserId=${referredUser.id}` +
        ` historicalPaidAmountByReferrer=${paidPayoutsForReferrer.reduce((s, p) => s + p.totalCommissionAmount, 0).toFixed(2)}` +
        ` historicalSettledRevenueByReferred=${alreadySettledRevenue.toFixed(2)}` +
        ` historicalSettledCommissionByReferred=${alreadySettledCommission.toFixed(2)}` +
        ` calculatedPendingRevenueByReferred=${newPendingRevenue.toFixed(2)}` +
        ` calculatedPendingCommissionByReferred=${commissionAmount.toFixed(2)}` +
        ` settlementSource=${settlementSource}` +
        ` stateRecoveredFromDatabase=true`
      );
      // ─────────────────────────────────────────────────────────────────────────

      // Status: calculated only if there is something to pay; skipped if zero revenue;
      // 'paid' kept for records where everything was already settled and revenue hasn't grown.
      // NOTE: when commissionAmount === 0 but totalOwnerRevenue > 0 it means the full period
      // revenue is already settled — we keep status='paid' so the record shows as fully settled
      // (not pending). This is correct: there is nothing new to pay for this commission record.
      const status = commissionAmount > 0
        ? 'calculated'
        : (totalOwnerRevenue <= 0 ? 'skipped' : 'paid');
      const reason = commissionAmount <= 0
        ? (totalOwnerRevenue <= 0
            ? `Revenue del período es $0 (GGR: $${(totalGgr ?? 0).toFixed(2)}, apuestas: $${(totalBets ?? 0).toFixed(2)}, ganancias: $${(totalWins ?? 0).toFixed(2)})`
            : `Todo el revenue del período ya fue liquidado en un pago anterior (settledRevenue=$${alreadySettledRevenue.toFixed(2)})`)
        : null;

      const commissionData = {
        id: existing?.id || uuidv4(),
        periodKey,
        referrerUserId: referrerId,
        referrerUsername: referrer.username,
        referredUserId: referredUser.id,
        referredUsername: referredUser.username,
        currency: 'ARS',
        totalBets,
        totalWins,
        totalGgr,
        totalOwnerRevenue,
        referralRate,
        commissionAmount,
        settledOwnerRevenue: alreadySettledRevenue,
        settledCommissionAmount: alreadySettledCommission,
        providersBreakdown: providers || [],
        status,
        calculatedAt: new Date()
      };

      results.details.push({
        referredUsername: referredUser.username,
        referrerUsername: referrer.username,
        jugayganaUsername,
        periodKey,
        revenueOk: true,
        totalBets,
        totalWins,
        totalGgr,
        totalOwnerRevenue,
        alreadySettledRevenue,
        alreadySettledCommission,
        newPendingRevenue,
        referralRate,
        commissionAmount,
        status,
        reason: reason || undefined,
        isDelta: alreadySettledRevenue > 0
      });

      if (!dryRun) {
        if (existing) {
          const { status: _omit, ...dataWithoutStatus } = commissionData;
          await ReferralCommission.updateOne(
            { _id: existing._id },
            { $set: { ...dataWithoutStatus, status } }
          );
          if (alreadySettledRevenue > 0 && commissionAmount > 0) {
            logger.info(
              `[ReferralCalc] Delta commission calculated after last payment | mode=${mode} period=${periodKey} ` +
              `referrer=${referrer.username} referredUser=${referredUser.username} ` +
              `historicalCommission=${alreadySettledCommission.toFixed(2)} ` +
              `newCommissionSinceLastSettlement=${commissionAmount.toFixed(2)} ` +
              `alreadySettledRevenueFloor=${alreadySettledRevenue.toFixed(2)} newPendingRevenue=${newPendingRevenue.toFixed(2)} ` +
              `upsertPerformed=true paymentApplied=false`
            );
          } else {
            logger.info(
              `[ReferralCalc] Reemplazando cálculo previo | mode=${mode} period=${periodKey} ` +
              `referrer=${referrer.username} referredUser=${referredUser.username} ` +
              `upsertPerformed=true calculationSource=fresh existingCalculationFound=true ` +
              `finalCommission=${commissionAmount.toFixed(2)}`
            );
          }
        } else {
          await ReferralCommission.create(commissionData).catch(err => {
            if (err.code === 11000) {
              logger.warn(`[ReferralCalc] Conflicto de duplicado para ${referredUser.username} - ignorando`);
            } else {
              throw err;
            }
          });
          logger.info(
            `[ReferralCalc] Nuevo registro guardado | mode=${mode} period=${periodKey} ` +
            `referrer=${referrer.username} referredUser=${referredUser.username} ` +
            `upsertPerformed=true calculationSource=fresh existingCalculationFound=false ` +
            `finalCommission=${commissionAmount.toFixed(2)}`
          );
        }
      }

      if (status === 'calculated') {
        results.commissionsCreated++;
      } else {
        results.commissionsSkipped++;
      }
    }
  }

  logger.info(
    `[ReferralCalc] Período ${periodKey} | mode=${mode} providerCallsCount=${providerCallsCount} ` +
    `commissionsCreated=${results.commissionsCreated} commissionsSkipped=${results.commissionsSkipped} ` +
    `commissionsExcluded=${results.commissionsExcluded} errors=${results.errors.length}`
  );

  if (!dryRun) {
    logger.info(`[ReferralCalc] calculate aligned with preview for period ${periodKey}`);
  }

  return results;
}

/**
 * Obtener resumen de comisiones pendientes por referidor para un período
 * @param {string} periodKey
 * @returns {Array}
 */
async function getPendingCommissionsSummary(periodKey) {
  return ReferralCommission.aggregate([
    { $match: { periodKey, status: 'calculated' } },
    {
      $group: {
        _id: '$referrerUserId',
        referrerUsername: { $first: '$referrerUsername' },
        totalCommission: { $sum: '$commissionAmount' },
        referralCount: { $sum: 1 }
      }
    },
    { $sort: { totalCommission: -1 } }
  ]);
}

module.exports = {
  calculateCommissionsForPeriod,
  getPendingCommissionsSummary
};
