const mongoose = require('mongoose');

// Snapshot de cada análisis subido — sólo summary (sin items detallados)
// para ir trackeando la evolución bucket por bucket entre uploads.
const RecontactHistorySchema = new mongoose.Schema({
  at: { type: Date, default: Date.now, index: true },
  fileLabel: String,
  savedByUsername: String,
  totalAnalyzed: { type: Number, default: 0 },
  foundInDb: { type: Number, default: 0 },
  buckets: { type: mongoose.Schema.Types.Mixed, default: {} },
  tiers: { type: mongoose.Schema.Types.Mixed, default: {} },
  withApp: { type: Number, default: 0 },
  withNotifs: { type: Number, default: 0 },
  withoutApp: { type: Number, default: 0 },
  fileTotalDeposits: { type: Number, default: 0 },
  fileTotalWithdraws: { type: Number, default: 0 },
  fileTotalBonuses: { type: Number, default: 0 },
  totalRecoverableValue: { type: Number, default: 0 },
  sinLinea: { type: Number, default: 0 }
}, {
  collection: 'recontact_history',
  timestamps: true,
  versionKey: false
});

module.exports = mongoose.model('RecontactHistory', RecontactHistorySchema);
