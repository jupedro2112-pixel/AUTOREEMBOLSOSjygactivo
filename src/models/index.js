
/**
 * Índice de Modelos
 * Exporta todos los modelos de Mongoose
 */
const mongoose = require('mongoose');

// Importar modelos
const User = require('./User');
const Message = require('./Message');
const ChatStatus = require('./ChatStatus');
const Transaction = require('./Transaction');
const RefundClaim = require('./RefundClaim');
const FireStreak = require('./FireStreak');
const Command = require('./Command');
const Config = require('./Config');
const ReferralCommission = require('./ReferralCommission');
const ReferralPayout = require('./ReferralPayout');
const ReferralEvent = require('./ReferralEvent');
const OtpCode = require('./OtpCode');
const Campaign = require('./Campaign');
const CampaignClick = require('./CampaignClick');


/**
 * Migration: backfill settledOwnerRevenue / settledCommissionAmount on ReferralCommission records
 * that were created by old payouts (before the incremental settlement feature was introduced).
 *
 * Old payouts did not:
 *   1. Store perReferredDetails in the ReferralPayout document, AND
 *   2. Set settledOwnerRevenue / settledCommissionAmount on the commission records.
 *
 * Without this data the calculation service cannot find the correct settlement baseline and
 * incorrectly treats the already-settled revenue as new pending revenue (double calculation).
 *
 * This migration:
 *   - Finds all paid payouts where details.perReferredDetails is missing or empty.
 *   - For each such payout, loads the linked commission records via details.commissionIds.
 *   - For each commission that still has settledOwnerRevenue === 0, reconstructs the amount:
 *       * Single-commission payouts: exact (settledCommission = payout.totalCommissionAmount).
 *       * Multi-commission payouts: proportional by commission.totalOwnerRevenue (best estimate).
 *   - Writes settledOwnerRevenue and settledCommissionAmount to those commission records.
 *
 * After this migration the existing commissionFallback in referralCalculationService correctly
 * reads the backfilled amounts and computes the right delta, so the next Calculate run will
 * show the correct (reduced) pending amount instead of the full period total.
 *
 * This migration is idempotent: commissions that already have settledOwnerRevenue > 0 are
 * skipped, so running it multiple times is safe.
 */
async function backfillLegacyPayoutSettlements() {
  try {
    // Check if migration already completed
    const migrationFlag = await Config.findOne({ key: 'migration_backfilllegacypayoutsettlements_done' }).lean();
    if (migrationFlag && migrationFlag.value === true) {
      console.log('[Migration] backfillLegacyPayoutSettlements: already completed — skipping');
      return;
    }

    const legacyPayouts = await ReferralPayout.find({
      status: 'paid',
      $or: [
        { 'details.perReferredDetails': { $exists: false } },
        { 'details.perReferredDetails': null },
        { 'details.perReferredDetails': { $size: 0 } }
      ]
    }).lean();

    if (legacyPayouts.length === 0) {
      console.log('[Migration] backfillLegacyPayoutSettlements: no legacy payouts found — nothing to do');
      return;
    }

    console.log(
      `[Migration] backfillLegacyPayoutSettlements: found ${legacyPayouts.length} legacy payout(s) ` +
      'without perReferredDetails — beginning backfill'
    );

    let backfilledCount = 0;
    let skippedAlreadySet = 0;

    for (const payout of legacyPayouts) {
      const commissionIds = payout.details?.commissionIds;
      if (!Array.isArray(commissionIds) || commissionIds.length === 0) {
        console.log(
          `[Migration] backfillLegacyPayoutSettlements: payout ${payout.id} has no commissionIds — skipping`
        );
        continue;
      }

      const commissions = await ReferralCommission.find({ id: { $in: commissionIds } }).lean();
      const N = commissions.length;
      if (N === 0) {
        console.log(
          `[Migration] backfillLegacyPayoutSettlements: payout ${payout.id} — commissions not found — skipping`
        );
        continue;
      }

      // Compute total revenue for proportional distribution (only for multi-commission payouts)
      const totalRevenue = commissions.reduce((sum, c) => sum + (c.totalOwnerRevenue || 0), 0);

      for (const commission of commissions) {
        if ((commission.settledOwnerRevenue || 0) > 0) {
          skippedAlreadySet++;
          continue;
        }

        const rate = commission.referralRate || 0.07;
        let settledCommission;

        if (N === 1) {
          // Exact: only one commission in this payout
          settledCommission = payout.totalCommissionAmount;
        } else if (totalRevenue > 0) {
          // Proportional by revenue share (best estimate for multi-user payouts)
          const fraction = (commission.totalOwnerRevenue || 0) / totalRevenue;
          settledCommission = payout.totalCommissionAmount * fraction;
        } else {
          // Equal share fallback when revenue data is unavailable
          settledCommission = payout.totalCommissionAmount / N;
        }

        const settledRevenue = rate > 0 ? settledCommission / rate : 0;

        await ReferralCommission.updateOne(
          // Extra guard: only write if settledOwnerRevenue is still exactly 0 to prevent
          // overwriting a value that was set by a concurrent process since the in-memory check.
          { _id: commission._id, settledOwnerRevenue: { $eq: 0 } },
          {
            $set: {
              settledOwnerRevenue: settledRevenue,
              settledCommissionAmount: settledCommission
            }
          }
        );

        console.log(
          `[Migration] backfillLegacyPayoutSettlements: backfilled` +
          ` referredUsername=${commission.referredUsername}` +
          ` referrerUsername=${commission.referrerUsername}` +
          ` periodKey=${commission.periodKey}` +
          ` payoutId=${payout.id}` +
          ` commissionIdsInPayout=${N}` +
          ` settledRevenue=${settledRevenue.toFixed(2)}` +
          ` settledCommission=${settledCommission.toFixed(2)}` +
          ` stateRecoveredFromDatabase=true`
        );
        backfilledCount++;
      }
    }

    console.log(
      `[Migration] backfillLegacyPayoutSettlements: complete — ` +
      `backfilledCommissions=${backfilledCount} skippedAlreadySet=${skippedAlreadySet} ` +
      `mongoPersistenceEnabled=true serverRestartSafe=true`
    );

    // Mark migration as complete so it skips on next startup
    await Config.findOneAndUpdate(
      { key: 'migration_backfilllegacypayoutsettlements_done' },
      { key: 'migration_backfilllegacypayoutsettlements_done', value: true },
      { upsert: true }
    );
    console.log('[Migration] backfillLegacyPayoutSettlements: marked as complete — will skip on next startup');
  } catch (err) {
    // Log but do not block startup — the enhanced fallback in referralCalculationService
    // provides a secondary safety net for any commission records that could not be backfilled.
    console.error(`[Migration] backfillLegacyPayoutSettlements: error — ${err.message}`);
  }
}

/**
 * Migration: drop the old unique index on referralpayouts {periodKey, referrerUserId}.
 *
 * Background: the original schema had a unique compound index on (periodKey, referrerUserId)
 * which allowed only ONE payout per referrer per period.  The incremental settlement feature
 * requires multiple payouts for the same referrer/period (one per delta batch).  The Mongoose
 * schema was already updated to remove the `unique: true` flag, but the physical MongoDB index
 * must be explicitly dropped — Mongoose does not remove existing indexes automatically.
 *
 * The ReferralPayout schema uses autoIndex:false so Mongoose never tries to auto-create its
 * indexes.  After this migration runs, we manually call ReferralPayout.createIndexes() to
 * ensure the new non-unique composite index is in place.  This prevents the race condition
 * where Mongoose's autoIndex fires before the migration and either silently fails (leaving
 * the old unique index in place) or creates a redundant index.
 *
 * This migration is idempotent: if the unique index no longer exists it exits silently.
 */
async function migrateReferralPayoutIndex() {
  const INDEX_NAME = 'periodKey_1_referrerUserId_1';
  try {
    // Check if migration already completed
    const migrationFlag = await Config.findOne({ key: 'migration_referralpayoutindex_done' }).lean();
    if (migrationFlag && migrationFlag.value === true) {
      console.log('[Migration] referralpayouts: index migration already completed — skipping');
      return;
    }

    const collection = mongoose.connection.collection('referralpayouts');

    // List existing indexes to detect the old unique one
    let indexes = [];
    try {
      indexes = await collection.indexes();
    } catch (listErr) {
      // Collection may not exist yet on a fresh deployment — that is fine
      console.log('[Migration] referralpayouts: could not list indexes (collection may not exist yet):', listErr.message);
    }

    const oldIndex = indexes.find(idx => idx.name === INDEX_NAME);

    if (!oldIndex) {
      console.log(`[Migration] referralpayouts: index "${INDEX_NAME}" not found — nothing to drop`);
    } else {
      const isUnique = !!oldIndex.unique;
      console.log(
        `[Migration] referralpayouts: found index "${INDEX_NAME}" unique=${isUnique} — ` +
        (isUnique ? 'dropping to enable incremental payouts' : 'already non-unique, dropping to recreate cleanly')
      );
      try {
        await collection.dropIndex(INDEX_NAME);
        console.log(
          `[Migration] referralpayouts: index "${INDEX_NAME}" dropped successfully. ` +
          'Multiple payouts per period+referrer are now supported (incremental settlement).'
        );
      } catch (dropErr) {
        console.error(`[Migration] referralpayouts: error dropping index "${INDEX_NAME}":`, dropErr.message);
      }
    }

    // Now create (or re-create) the correct non-unique indexes via the schema definition.
    // ReferralPayout.autoIndex is false so this must be done explicitly here.
    try {
      await ReferralPayout.createIndexes();
      console.log('[Migration] referralpayouts: indexes (re)created successfully — mongoPersistenceEnabled=true serverRestartSafe=true');
    } catch (createErr) {
      console.error('[Migration] referralpayouts: error creating indexes:', createErr.message);
    }

    // Mark migration as complete so it skips on next startup
    await Config.findOneAndUpdate(
      { key: 'migration_referralpayoutindex_done' },
      { key: 'migration_referralpayoutindex_done', value: true },
      { upsert: true }
    );
    console.log('[Migration] referralpayouts: marked as complete — will skip on next startup');
  } catch (err) {
    // Log but do not block startup — worst case the old index may still exist; the payout
    // service has its own E11000 recovery handler for this situation.
    console.error('[Migration] referralpayouts: unexpected error during index migration:', err.message);
  }
}

/**
 * Conectar a MongoDB y ejecutar migraciones de inicio
 */
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/sala-de-juegos', {
      maxPoolSize: 20,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 30000,
    });
    console.log('✅ MongoDB conectado');

    // Run startup migrations
    await migrateReferralPayoutIndex();
    // Backfill settlement amounts for legacy payouts that lack perReferredDetails.
    // Must run AFTER migrateReferralPayoutIndex so the collection and indexes are stable.
    await backfillLegacyPayoutSettlements();

    // ============================================================
    // Auto-limpieza de mensajes antiguos (3 días)
    // ============================================================
    // Usamos el campo `timestamp` (declarado explícitamente en el schema con
    // default: Date.now) en lugar de `createdAt` (auto-generado por
    // timestamps:true) porque los mensajes viejos creados antes de que el
    // schema tuviera timestamps:true NO tienen createdAt — y un filtro
    // { createdAt: { $lt: ... } } nunca los matchea, así como el TTL sobre
    // createdAt los ignora.  `timestamp` está garantizado en todos los
    // mensajes, viejos y nuevos.
    //
    // Estrategia en capas:
    //   1) TTL index de MongoDB sobre `timestamp` → barrido automático cada
    //      ~60s por el motor de la base.
    //   2) Auto-reparación: si ya existe un índice timestamp_1 sin TTL
    //      (Mongoose lo creó por el `index: true` del schema), dropeamos y
    //      recreamos con expireAfterSeconds. Sin intervención manual.
    //   3) Limpieza one-shot al boot por si el TTL recién está activándose.
    //   4) Cron cada 6h como red de seguridad.
    // ============================================================
    const MESSAGE_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 días = 259200s

    async function ensureMessageTtlIndex() {
      try {
        await Message.collection.createIndex(
          { timestamp: 1 },
          { expireAfterSeconds: MESSAGE_TTL_SECONDS, name: 'timestamp_1_ttl' }
        );
        console.log('✅ TTL index sobre `timestamp` (3 días) creado/verificado');
        return true;
      } catch (err) {
        if (err.codeName === 'IndexOptionsConflict' || err.code === 85 /* IndexOptionsConflict */) {
          console.warn('⚠️ Existe un índice sobre `timestamp` sin TTL — autorreparando: drop + recreate con TTL...');
          try {
            // Buscar todos los índices sobre timestamp sin TTL y dropearlos.
            const indexes = await Message.collection.indexes();
            for (const idx of indexes) {
              const keys = Object.keys(idx.key || {});
              const isTimestampIndex = keys.length === 1 && keys[0] === 'timestamp';
              const hasTtl = typeof idx.expireAfterSeconds === 'number';
              if (isTimestampIndex && !hasTtl) {
                await Message.collection.dropIndex(idx.name);
                console.log(`🧹 Índice "${idx.name}" sin TTL dropeado`);
              }
            }
            await Message.collection.createIndex(
              { timestamp: 1 },
              { expireAfterSeconds: MESSAGE_TTL_SECONDS, name: 'timestamp_1_ttl' }
            );
            console.log('✅ TTL index sobre `timestamp` recreado tras autorreparación');
            return true;
          } catch (repairErr) {
            console.error('❌ Autorreparación del TTL index falló:', repairErr.message);
            return false;
          }
        } else if (err.code === 86 /* IndexKeySpecsConflict */) {
          console.warn('⚠️ Conflicto de spec de índice (code 86). Investigar manualmente:', err.message);
          return false;
        } else {
          console.error('❌ Error creando TTL index:', err.message);
          return false;
        }
      }
    }

    // Limpieza adicional: borrar el TTL viejo sobre `createdAt` si quedó de
    // un deploy anterior. No es crítico pero evita que el motor mantenga
    // un índice TTL inútil (createdAt no existe en mensajes viejos).
    async function dropLegacyCreatedAtTtl() {
      try {
        const indexes = await Message.collection.indexes();
        for (const idx of indexes) {
          if (idx.name === 'createdAt_1_ttl') {
            await Message.collection.dropIndex(idx.name);
            console.log('🧹 Índice TTL legacy "createdAt_1_ttl" dropeado (ya no se usa)');
          }
        }
      } catch (err) {
        // No bloquea: si el índice no existe, perfecto
        if (!/index not found/i.test(err.message || '')) {
          console.warn('⚠️ Limpieza de índice legacy createdAt_1_ttl:', err.message);
        }
      }
    }

    // 1+2) Crear/asegurar el TTL index sobre timestamp
    ensureMessageTtlIndex();
    dropLegacyCreatedAtTtl();

    // 3) Limpieza one-shot al boot — usa `timestamp` (no createdAt)
    async function cleanupOldMessages(label) {
      try {
        const cutoff = new Date(Date.now() - MESSAGE_TTL_SECONDS * 1000);
        const result = await Message.deleteMany({ timestamp: { $lt: cutoff } });
        if (result.deletedCount > 0) {
          console.log(`🧹 [${label}] ${result.deletedCount} mensajes antiguos (>3 días) eliminados`);
        } else {
          console.log(`✅ [${label}] No hay mensajes antiguos para eliminar`);
        }
      } catch (err) {
        console.error(`❌ [${label}] Error en limpieza de mensajes antiguos:`, err.message);
      }
    }
    cleanupOldMessages('boot');

    // 4) Cron de seguridad cada 6h
    const SAFETY_CRON_INTERVAL_MS = 6 * 60 * 60 * 1000;
    setInterval(() => cleanupOldMessages('cron-6h'), SAFETY_CRON_INTERVAL_MS).unref();

    return true;
  } catch (error) {
    console.error('❌ Error conectando MongoDB:', error.message);
    return false;
  }
}

/**
 * Desconectar de MongoDB
 */
async function disconnectDB() {
  await mongoose.disconnect();
  console.log('MongoDB desconectado');
}

// Exportar modelos y funciones
module.exports = {
  // Modelos
  User,
  Message,
  ChatStatus,
  Transaction,
  RefundClaim,
  FireStreak,
  Command,
  Config,
  ReferralCommission,
  ReferralPayout,
  ReferralEvent,
  OtpCode,
  Campaign,
  CampaignClick,

  // Funciones de conexión
  connectDB,
  disconnectDB,
  
  // Utilidad para verificar conexión
  isConnected: () => mongoose.connection.readyState === 1,
  
  // Exportar mongoose para acceso directo si es necesario
  mongoose
};