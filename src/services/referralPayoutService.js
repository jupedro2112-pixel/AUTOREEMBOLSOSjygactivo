/**
 * Servicio de Pagos de Referidos
 * Fase B: agrupa comisiones calculadas, acredita fichas y marca como pagado.
 * Soporta pagos incrementales: si el referido sigue jugando después de un pago,
 * el siguiente cálculo detecta el delta y este servicio puede pagar solo ese nuevo monto.
 *
 * Persistence model:
 *   - ReferralPayout is the source of truth for what was paid and when.
 *   - ReferralCommission tracks the delta ledger (settledOwnerRevenue, settledCommissionAmount).
 *   - Both are persisted in MongoDB — no server-memory state is required after a restart.
 *   - stateRecoveredFromDatabase=true is always the case: the calculation service reads
 *     existing ReferralCommission records to determine what has already been settled.
 */
const { v4: uuidv4 } = require('uuid');
const { User, Transaction, Message, ReferralCommission, ReferralPayout, mongoose } = require('../models');
const jugayganaService = require('./jugayganaService');
const logger = require('../utils/logger');
const { getPeriodLabel } = require('../utils/periodKey');

/**
 * Drop the stale unique index on referralpayouts {periodKey, referrerUserId} at runtime.
 * Used as a fallback when the startup migration in connectDB() did not run or failed.
 * After a successful drop the caller should retry the payout creation.
 * @returns {boolean} true if dropped (or already absent), false on error
 */
async function dropStalePayoutUniqueIndexIfPresent() {
  const INDEX_NAME = 'periodKey_1_referrerUserId_1';
  try {
    const collection = mongoose.connection.collection('referralpayouts');
    const indexes = await collection.indexes();
    const staleIndex = indexes.find(idx => idx.name === INDEX_NAME);
    if (!staleIndex) {
      logger.info(`[ReferralPayout] dropStaleIndex: "${INDEX_NAME}" does not exist — no action needed`);
      return true;
    }
    // Drop unconditionally (whether unique or not) so we can recreate the correct non-unique version.
    // The unique=false check was fragile: on some MongoDB drivers the flag is absent even for
    // unique indexes, causing the function to return true without dropping and leaving the
    // constraint in place, which made the retry also fail with E11000.
    logger.warn(
      `[ReferralPayout] dropStaleIndex: dropping index "${INDEX_NAME}" (unique=${!!staleIndex.unique}) ` +
      `to allow multiple payouts per period+referrer (incremental settlement)`
    );
    await collection.dropIndex(INDEX_NAME);
    // Re-create the non-unique version immediately
    try {
      await ReferralPayout.createIndexes();
    } catch (ci) {
      logger.warn(`[ReferralPayout] dropStaleIndex: createIndexes after drop: ${ci.message}`);
    }
    logger.info(`[ReferralPayout] dropStaleIndex: "${INDEX_NAME}" dropped and non-unique index recreated — mongoPersistenceEnabled=true serverRestartSafe=true`);
    return true;
  } catch (err) {
    logger.error(`[ReferralPayout] dropStaleIndex: error — ${err.message}`);
    return false;
  }
}

/**
 * Ejecutar el pago mensual para un período
 * @param {string} periodKey - e.g. "2026-04"
 * @param {Object} [options]
 * @param {string} [options.referrerUserId] - pagar solo para un referidor
 * @param {string} [options.adminId]
 * @param {string} [options.adminUsername]
 * @returns {Object} resultado del pago
 */
async function executePayoutsForPeriod(periodKey, options = {}) {
  const { referrerUserId = null, adminId = null, adminUsername = null } = options;

  logger.info(
    `[ReferralPayout] payout request started period=${periodKey} admin=${adminUsername || 'system'} ` +
    `mongoPersistenceEnabled=true stateRecoveredFromDatabase=true`
  );

  const results = {
    periodKey,
    payoutsCreated: 0,
    payoutsFailed: 0,
    payoutsSkipped: 0,
    errors: [],
    details: []
  };

  const commissionQuery = { periodKey, status: 'calculated' };
  if (referrerUserId) commissionQuery.referrerUserId = referrerUserId;

  const commissions = await ReferralCommission.find(commissionQuery).lean();

  const existingSettlementItems = commissions.length;
  logger.info(
    `[ReferralPayout] paymentLoadedFromDatabase=true existingSettlementItems=${existingSettlementItems} periodKey=${periodKey}`
  );

  if (commissions.length === 0) {
    logger.info(`[ReferralPayout] No hay comisiones calculadas para ${periodKey}`);
    return results;
  }

  // Agrupar comisiones por referidor
  const byReferrer = new Map();
  for (const commission of commissions) {
    if (!byReferrer.has(commission.referrerUserId)) {
      byReferrer.set(commission.referrerUserId, {
        referrerUserId: commission.referrerUserId,
        referrerUsername: commission.referrerUsername,
        commissions: []
      });
    }
    byReferrer.get(commission.referrerUserId).commissions.push(commission);
  }

  for (const [refId, group] of byReferrer) {
    // Only eligible commissions: status=calculated AND commissionAmount > 0
    const eligibleCommissions = group.commissions.filter(c => c.commissionAmount > 0);
    const zeroAmountCommissions = group.commissions.filter(c => c.commissionAmount <= 0);
    const zeroAmountReferralsExcluded = zeroAmountCommissions.length > 0;
    const totalAmount = eligibleCommissions.reduce((sum, c) => sum + c.commissionAmount, 0);
    const paidReferralsCount = eligibleCommissions.length;
    const skippedReferralsCount = zeroAmountCommissions.length;

    // Determine if any commission is a delta (incremental after a previous payout)
    const isDeltaPayout = eligibleCommissions.some(c => (c.settledCommissionAmount || 0) > 0);
    const payoutType = isDeltaPayout ? 'delta' : 'full';

    logger.info(
      `[ReferralPayout] payFlowStarted=true period=${periodKey} referrer=${group.referrerUsername} ` +
      `eligibleCommissionsCount=${paidReferralsCount} eligibleCommissionTotal=${totalAmount.toFixed(2)} ` +
      `paymentType=${payoutType} ` +
      `zeroAmountReferralsExcluded=${zeroAmountReferralsExcluded} skippedReferralsCount=${skippedReferralsCount}`
    );

    if (totalAmount <= 0) {
      logger.info(`[ReferralPayout] Total $0 para ${group.referrerUsername} - skipping`);
      results.payoutsSkipped++;
      continue;
    }

    // Determine the sequence index for this payout (how many paid payouts already exist for this period+referrer)
    // Coerce to strings to prevent any potential NoSQL injection from loosely-typed inputs
    const safePeriodKey = String(periodKey);
    const safeRefId = String(refId);
    const previousPaidPayoutsCount = await ReferralPayout.countDocuments({
      periodKey: safePeriodKey,
      referrerUserId: safeRefId,
      status: 'paid'
    });
    const existingPayoutFound = previousPaidPayoutsCount > 0;
    const payoutIndex = previousPaidPayoutsCount + 1;

    // Aggregate settled amounts already paid to this referrer for this period
    const alreadySettledRevenuePeriod = eligibleCommissions.reduce(
      (sum, c) => sum + (c.settledOwnerRevenue || 0), 0
    );
    const alreadySettledCommissionPeriod = eligibleCommissions.reduce(
      (sum, c) => sum + (c.settledCommissionAmount || 0), 0
    );
    const newPendingRevenuePeriod = eligibleCommissions.reduce(
      (sum, c) => sum + (c.totalOwnerRevenue - (c.settledOwnerRevenue || 0)), 0
    );
    const newPendingCommissionPeriod = totalAmount;

    logger.info(
      `[ReferralPayout] referrerUserId=${refId} periodKey=${periodKey} ` +
      `existingPayoutFound=${existingPayoutFound} existingPayoutCount=${previousPaidPayoutsCount} ` +
      `alreadySettledRevenue=${alreadySettledRevenuePeriod.toFixed(2)} ` +
      `alreadySettledCommission=${alreadySettledCommissionPeriod.toFixed(2)} ` +
      `newPendingRevenue=${newPendingRevenuePeriod.toFixed(2)} ` +
      `newPendingCommission=${newPendingCommissionPeriod.toFixed(2)} ` +
      `payoutSequence=${payoutIndex} paymentSequence=${payoutIndex} ` +
      `creatingDeltaPayout=${isDeltaPayout}`
    );

    const periodLabel = getPeriodLabel(periodKey);
    const description = `Ganancias por referidos - ${periodLabel}${isDeltaPayout ? ` (pago #${payoutIndex})` : ''}`;
    const payoutCutoffEnd = new Date();

    // Per-referred detail for full audit trail — stored inside the payout document so the
    // record is self-contained and survives a server restart without needing to re-read the
    // commission rows.
    const perReferredDetails = eligibleCommissions.map(c => ({
      referredUserId: c.referredUserId,
      referredUsername: c.referredUsername,
      totalOwnerRevenue: c.totalOwnerRevenue,
      alreadySettledRevenue: c.settledOwnerRevenue || 0,
      newDeltaRevenue: c.totalOwnerRevenue - (c.settledOwnerRevenue || 0),
      alreadySettledCommission: c.settledCommissionAmount || 0,
      newDeltaCommission: c.commissionAmount,
      referralRate: c.referralRate,
      commissionId: c.id
    }));

    let payoutDoc;

    try {
      // Helper to build the full payout document — used for creation and retry after index drop
      const buildPayoutData = (payoutId) => ({
        id: payoutId,
        periodKey,
        referrerUserId: refId,
        referrerUsername: group.referrerUsername,
        currency: 'ARS',
        totalCommissionAmount: totalAmount,
        referralCount: paidReferralsCount,
        status: 'pending',
        payoutIndex,
        isDelta: isDeltaPayout,
        adminId: adminId || null,
        adminUsername: adminUsername || null,
        cutoffEnd: payoutCutoffEnd,
        details: {
          commissionIds: eligibleCommissions.map(c => c.id),
          payoutType,
          alreadySettledRevenue: alreadySettledRevenuePeriod,
          alreadySettledCommission: alreadySettledCommissionPeriod,
          newDeltaRevenue: newPendingRevenuePeriod,
          newDeltaCommission: newPendingCommissionPeriod,
          perReferredDetails
        }
      });

      // Always create a new payout document (incremental settlement support).
      // If E11000 is raised on the {periodKey, referrerUserId} compound index it means the
      // startup migration has not yet run or failed silently.  We recover at runtime by
      // dropping the stale unique index and retrying once.
      const payoutId = uuidv4();
      try {
        payoutDoc = await ReferralPayout.create(buildPayoutData(payoutId));
      } catch (createErr) {
        const isDuplicateOnCompound =
          (createErr.code === 11000 || /E11000|duplicate key/.test(createErr.message)) &&
          /periodKey.*referrerUserId|referrerUserId.*periodKey|periodKey_1_referrerUserId_1/.test(createErr.message);

        if (isDuplicateOnCompound) {
          logger.warn(
            `[ReferralPayout] E11000 on {periodKey, referrerUserId} detected — stale unique index present. ` +
            `Attempting runtime index drop and retry. referrer=${group.referrerUsername} period=${periodKey}`
          );
          let dropped = false;
          try {
            dropped = await dropStalePayoutUniqueIndexIfPresent();
          } catch (dropErr) {
            logger.error(
              `[ReferralPayout] Index drop for 'periodKey_1_referrerUserId_1' threw unexpectedly: ` +
              `${dropErr.message} referrer=${group.referrerUsername} period=${periodKey}`
            );
          }
          if (dropped) {
            // Retry with the same payoutId — the original create failed before writing to DB
            // (E11000 rejects before commit), so the UUID was never persisted.
            try {
              payoutDoc = await ReferralPayout.create(buildPayoutData(payoutId));
              logger.info(
                `[ReferralPayout] Retry after index drop succeeded. referrer=${group.referrerUsername} period=${periodKey} ` +
                `actionSupported=true`
              );
            } catch (retryErr) {
              logger.error(
                `[ReferralPayout] Retry after index drop also failed: ${retryErr.message} ` +
                `referrer=${group.referrerUsername} period=${periodKey}`
              );
              throw retryErr;
            }
          } else {
            throw createErr;
          }
        } else {
          throw createErr;
        }
      }

      logger.info(
        `[ReferralPayout] historyRecordCreated=true referrer=${group.referrerUsername} ` +
        `period=${periodKey} payoutId=${payoutDoc.id} paidReferralsCount=${paidReferralsCount} ` +
        `payoutIndex=${payoutIndex} isDelta=${isDeltaPayout} adminUsername=${adminUsername || 'system'}`
      );

      // Acreditar fichas en JUGAYGANA usando DepositMoney + childid
      // (restaurado al comportamiento correcto de PR #189 — CREDITBALANCE causa "action does not exist")
      const referrer = await User.findOne({ id: refId }).lean();
      if (!referrer) {
        throw new Error(`Referidor ${refId} no encontrado en DB local`);
      }

      const jugayganaUsername = referrer.jugayganaUsername || referrer.username;

      logger.info(
        `[ReferralPayout] referralPayoutProviderAction=DepositMoney ` +
        `referralPayoutProviderPayloadShape=childid+amount+currency+deposit_type ` +
        `usesChildId=true usesUsername=false ` +
        `providerCallSource=referralPayoutService/executePayoutsForPeriod ` +
        `isDeltaPayout=${isDeltaPayout} periodKey=${periodKey} referrer=${group.referrerUsername} ` +
        `commissionToPay=${totalAmount.toFixed(2)} jugayganaUsername=${jugayganaUsername} ` +
        `referrerUserId=${refId} paymentType=${payoutType} paymentApplied=false`
      );

      // #197 MUDANZA: la comisión se acredita en la plataforma del referidor. En jugaygana.io va
      // con reference ESTABLE (período + referidor + nº de pago: un reintento no duplica) y SIN
      // rollover global (es plata ganada, no un bono promocional).
      if (referrer.platformMigrating === true) {
        throw new Error('La cuenta del referidor se está actualizando de plataforma. Reintentá en unos minutos.');
      }
      const creditResult = referrer.platform === 'partner'
        ? await require('./platform').creditUserBalance(referrer.username, totalAmount, null, {
            reference: `vip-refcom-${periodKey}-${refId}-p${payoutIndex}`,
            // #222 (réplica #239): descripción detallada SOLO hacia jugaygana.io; la vieja y el registro local usan `description`.
            description: `COMISIÓN de referidos — ganancias por referidos de ${periodLabel}${isDeltaPayout ? ` (pago #${payoutIndex})` : ''} (plata ganada, no es un bono promocional)`,
            ignoreGlobalRollover: true
          })
        : await jugayganaService.bonus(
        jugayganaUsername,
        totalAmount,
        description
      );

      if (!creditResult.success) {
        // Ensure the error is a plain string — creditResult.error may be an object from the API
        const rawErr = creditResult.error;
        const errStr =
          typeof rawErr === 'string'
            ? rawErr
            : (rawErr && typeof rawErr === 'object'
                ? (rawErr.message || rawErr.reason || rawErr.code || JSON.stringify(rawErr))
                : 'Error al acreditar en JUGAYGANA');
        logger.error(
          `[ReferralPayout] referralPayoutProviderAction=DepositMoney usesChildId=true ` +
          `providerResponse=${errStr} ` +
          `errorCode=${rawErr && rawErr.code ? rawErr.code : 'n/a'} ` +
          `errorMessage=${errStr} referrer=${group.referrerUsername} ` +
          `referrerUserId=${refId} period=${periodKey} ` +
          `isDeltaPayout=${isDeltaPayout} commissionToPay=${totalAmount.toFixed(2)} ` +
          `finalPayoutStatus=failed paymentApplied=false`
        );
        throw new Error(errStr);
      }

      logger.info(
        `[ReferralPayout] providerResponse=success referralPayoutProviderAction=DepositMoney ` +
        `usesChildId=true referrer=${group.referrerUsername} period=${periodKey} ` +
        `isDeltaPayout=${isDeltaPayout} commissionToPay=${totalAmount.toFixed(2)} ` +
        `finalPayoutStatus=success paymentApplied=true`
      );

      // Registrar transacción local
      const tx = await Transaction.create({
        id: uuidv4(),
        type: 'referral_commission',
        amount: totalAmount,
        username: referrer.username,
        userId: refId,
        description,
        adminId: adminId || 'system',
        adminUsername: adminUsername || 'system',
        adminRole: 'admin',
        transactionId: creditResult.data?.transfer_id || null,
        externalId: payoutDoc.id,
        status: 'completed',
        metadata: {
          periodKey,
          referralCount: paidReferralsCount,
          payoutId: payoutDoc.id,
          payoutIndex,
          isDelta: isDeltaPayout
        }
      });

      // Marcar payout como pagado
      await ReferralPayout.updateOne(
        { _id: payoutDoc._id },
        {
          $set: {
            status: 'paid',
            creditedAt: new Date(),
            transactionId: tx.id,
            externalTransactionId: creditResult.data?.transfer_id || null
          }
        }
      );

      // Mark commissions as paid (status and payoutId), then update settled amounts individually.
      // commissionAmount is set to 0 intentionally: it represents "currently pending amount".
      // The historical value is captured in settledCommissionAmount before being zeroed out.
      const eligibleIds = eligibleCommissions.map(c => c._id);
      await ReferralCommission.updateMany(
        { _id: { $in: eligibleIds } },
        {
          $set: {
            status: 'paid',
            paidAt: new Date(),
            payoutId: payoutDoc.id
          }
        }
      );

      // Update each eligible commission individually to accumulate settled amounts correctly
      for (const c of eligibleCommissions) {
        const newSettledOwnerRevenue = c.totalOwnerRevenue;
        const newSettledCommissionAmount = (c.settledCommissionAmount || 0) + c.commissionAmount;
        await ReferralCommission.updateOne(
          { _id: c._id },
          {
            $set: {
              settledOwnerRevenue: newSettledOwnerRevenue,
              settledCommissionAmount: newSettledCommissionAmount,
              commissionAmount: 0
            }
          }
        );
        logger.info(
          `[ReferralPayout] referral payout ledger updated successfully ` +
          `referrer=${group.referrerUsername} referredUser=${c.referredUsername} ` +
          `period=${periodKey} ` +
          `historicalCommission=${(c.settledCommissionAmount || 0).toFixed(2)} ` +
          `alreadyPaidCommission=${(c.settledCommissionAmount || 0).toFixed(2)} ` +
          `newCommissionSinceLastSettlement=${c.commissionAmount.toFixed(2)} ` +
          `settledOwnerRevenue=${newSettledOwnerRevenue.toFixed(2)} ` +
          `settledCommissionAmount=${newSettledCommissionAmount.toFixed(2)} ` +
          `paymentApplied=true paymentType=${payoutType}`
        );
      }

      // Enviar mensaje automático al usuario
      await sendReferralCreditMessage(referrer, totalAmount, periodLabel, isDeltaPayout, payoutIndex);

      logger.info(
        `[ReferralPayout] paymentStatusPersisted=paid referrer=${group.referrerUsername} ` +
        `period=${periodKey} amount=${totalAmount.toFixed(2)} paidReferralsCount=${paidReferralsCount} ` +
        `skippedReferralsCount=${skippedReferralsCount} payoutIndex=${payoutIndex} ` +
        `recordsUpdated=${eligibleCommissions.length} finalPayoutStatus=success`
      );
      logger.info(
        `[ReferralPayout] payment flow completed with persisted status=paid and uiSuccess=true ` +
        `referrer=${group.referrerUsername} period=${periodKey} serverRestartSafe=true`
      );

      results.payoutsCreated++;
      results.details.push({
        referrerUsername: group.referrerUsername,
        amount: totalAmount,
        referralCount: paidReferralsCount,
        status: 'paid',
        payoutIndex,
        isDelta: isDeltaPayout
      });
    } catch (err) {
      const errMessage = typeof err.message === 'string' ? err.message : String(err.message || 'Error desconocido');
      // Detect duplicate key error (e.g. old unique index still in DB)
      const isDuplicateKey = err.code === 11000 || /E11000|duplicate key/.test(errMessage);

      logger.error(
        `[ReferralPayout] Error pagando a ${group.referrerUsername}: ${errMessage}`
      );
      logger.error(
        `[ReferralPayout] referrer=${group.referrerUsername} referrerUserId=${refId} period=${periodKey} ` +
        `errorMessage=${errMessage} duplicateKeyPrevented=${isDuplicateKey} ` +
        `finalPayoutStatus=failed paymentApplied=false`
      );

      // Marcar payout como fallido pero no eliminar
      if (payoutDoc) {
        await ReferralPayout.updateOne(
          { _id: payoutDoc._id },
          { $set: { status: 'failed', errorMessage: errMessage } }
        ).catch(() => {});
      }

      logger.info(
        `[ReferralPayout] paymentStatusPersisted=failed referrer=${group.referrerUsername} ` +
        `period=${periodKey} paidReferralsCount=0`
      );

      results.payoutsFailed++;
      results.errors.push({
        referrer: group.referrerUsername,
        message: errMessage,
        error: errMessage
      });
    }
  }

  const finalPayoutStatus = results.payoutsFailed === 0 ? 'success' : results.payoutsCreated > 0 ? 'partial' : 'failed';
  logger.info(
    `[ReferralPayout] periodKey=${periodKey} payoutsCreated=${results.payoutsCreated} ` +
    `payoutsFailed=${results.payoutsFailed} payoutsSkipped=${results.payoutsSkipped} ` +
    `successfulPayoutCount=${results.payoutsCreated} failedPayoutCount=${results.payoutsFailed} ` +
    `finalPayoutStatus=${finalPayoutStatus}`
  );

  return results;
}

/**
 * Enviar mensaje automático al usuario sobre el crédito de referidos
 */
async function sendReferralCreditMessage(user, amount, periodLabel, isDelta = false, payoutIndex = 1) {
  try {
    const amountFormatted = new Intl.NumberFormat('es-AR').format(Math.round(amount));
    const suffix = isDelta && payoutIndex > 1
      ? ` (pago adicional #${payoutIndex} por actividad posterior al período)`
      : '';
    const content = `🎁 Se acreditaron $${amountFormatted} en fichas por ganancias de referidos correspondientes a ${periodLabel}${suffix}.`;

    await Message.create({
      id: uuidv4(),
      senderId: 'system',
      senderUsername: 'Sistema',
      senderRole: 'system',
      receiverId: user.id,
      receiverRole: 'user',
      content,
      type: 'system',
      read: false,
      timestamp: new Date()
    });

    logger.info(`[ReferralPayout] Mensaje de crédito enviado a ${user.username}`);
  } catch (err) {
    logger.error(`[ReferralPayout] Error enviando mensaje a ${user.username}:`, err.message);
    // No interrumpir el flujo si el mensaje falla
  }
}

module.exports = {
  executePayoutsForPeriod
};
