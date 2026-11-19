/**
 * PlatformMigration (#197) — un registro por usuario de su MUDANZA de plataforma
 * (JUGAYGANA → jugaygana.io / Partner API). Es el libro de la mudanza: cuánto tenía en la
 * vieja, cuánto se le retiró, cuánto se le cargó en la nueva y en qué quedó.
 *
 * status:
 *   running          en curso (ver `phase`); `lockedAt` = latido del proceso que la lleva
 *   done             mudado (User.platform = 'partner')
 *   failed           no se movió NADA (se reintenta solo en la próxima acción del usuario)
 *   held             frenada a propósito, ver `reason`:
 *                      cap              saldo mayor al tope → la aprueba el admin general
 *                      not_in_new       el jugador todavía no existe en la plataforma nueva
 *                      new_has_balance  ya tiene saldo en la nueva (¿se copió con saldo?)
 *                      invalid_username el username no cumple la regla de la plataforma nueva
 *                      foreign          el nombre existe allá fuera de su equipo (esa key no lo ve)
 *                      team_no_key      su equipo no tiene API key cargada
 *   review           🛑 el retiro en la vieja quedó AMBIGUO: lo resuelve una persona
 *   deposit_pending  se retiró de la vieja y la carga en la nueva todavía no entró: se
 *                    reintenta sola con la MISMA reference (idempotente) hasta que entra
 *
 * phase (solo con status running): check → withdrawing → withdrawn → depositing
 */
const mongoose = require('mongoose');

const platformMigrationSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true, index: true },
  status: { type: String, enum: ['running', 'done', 'failed', 'held', 'review', 'deposit_pending'], default: 'running', index: true },
  phase: { type: String, default: 'check' },
  reason: { type: String, default: null },
  team: { type: String, default: null },         // equipo (API key) de jugaygana.io: 'default' = key general
  oldBalance: { type: Number, default: null },   // saldo leído en la vieja antes de retirar
  amount: { type: Number, default: 0 },          // lo que se retiró de la vieja = lo que se carga en la nueva
  oldTransferId: { type: String, default: null },
  reference: { type: String, default: null },    // llave de idempotencia de la carga en la nueva
  newTransferId: { type: String, default: null },
  newBalanceBefore: { type: Number, default: null },
  round: { type: Number, default: 1 },           // sube solo si un admin rehace la mudanza de plata
  attempts: { type: Number, default: 0 },
  lastError: { type: String, default: null },
  trigger: { type: String, default: null },      // app_open | deposit | casino | admin | tick
  by: { type: String, default: null },           // admin que la forzó / aprobó
  startedAt: { type: Date, default: null },
  withdrawnAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  lockedAt: { type: Date, default: null },
  alertedAt: { type: Date, default: null },
  // Revisión posterior: plata que aparece en la vieja DESPUÉS de mudarse (apuesta que pagó tarde).
  oldRecheckAt: { type: Date, default: null },
  oldRecheckCount: { type: Number, default: 0 },
  oldResidual: { type: Number, default: 0 },
  // Cierre de la cuenta VIEJA (#198): tras mudarse se le pone en JUGAYGANA una clave al azar que
  // no se guarda en ningún lado → nadie vuelve a entrar ahí. Lo hace el motor (reintenta solo).
  oldLocked: { type: Boolean, default: false },
  oldLockedAt: { type: Date, default: null },
  oldLockNextAt: { type: Date, default: null },  // próximo intento (null = cuanto antes)
  oldLockAttempts: { type: Number, default: 0 },
  oldLockError: { type: String, default: null }
}, { timestamps: true });

platformMigrationSchema.index({ status: 1, updatedAt: -1 });
platformMigrationSchema.index({ status: 1, oldRecheckAt: 1 });
platformMigrationSchema.index({ status: 1, oldLocked: 1, oldLockNextAt: 1 });

module.exports = mongoose.models['PlatformMigration'] || mongoose.model('PlatformMigration', platformMigrationSchema);
