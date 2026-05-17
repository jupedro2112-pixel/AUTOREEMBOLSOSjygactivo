/**
 * Confirmación individual de un NotifCheck.
 *
 * Cada vez que un user toca "CONFIRMAR" en la PWA del check activo, se
 * inserta un row. Unique index (checkId, userId) garantiza que el mismo
 * user no sume 2 veces el mismo check.
 */
const mongoose = require('mongoose');

const confirmSchema = new mongoose.Schema({
  checkId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  username: { type: String, required: true, index: true, trim: true },

  // 'manual_button' = tocó "CONFIRMAR" en la PWA.
  // 'push_tap' = abrió el push (auto-confirmado por tap-track).
  source: {
    type: String,
    enum: ['manual_button', 'push_tap'],
    default: 'manual_button'
  },

  confirmedAt: { type: Date, default: Date.now, index: true, immutable: true },

  hasApp: { type: Boolean, default: false },
  hasNotifs: { type: Boolean, default: false }
}, { timestamps: false });

confirmSchema.index(
  { checkId: 1, userId: 1 },
  { name: 'unique_check_userid', unique: true }
);

module.exports = mongoose.models['NotifCheckConfirm'] ||
  mongoose.model('NotifCheckConfirm', confirmSchema);
