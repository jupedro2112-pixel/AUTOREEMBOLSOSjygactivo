const mongoose = require('mongoose');

// Snapshot diario del estado de la base re: app instalada / notifs.
// dayKey = YYYY-MM-DD (ART) — único por día. Permite trackear evolución.
const AppUsersDailySnapshotSchema = new mongoose.Schema({
  dayKey: { type: String, required: true, unique: true, index: true },
  takenAt: { type: Date, default: Date.now, index: true },
  totalUsers: { type: Number, default: 0 },
  withApp: { type: Number, default: 0 },
  withNotifs: { type: Number, default: 0 },
  withBoth: { type: Number, default: 0 },
  withAppNoNotifs: { type: Number, default: 0 },
  sinApp: { type: Number, default: 0 },
  byPlatform: { type: mongoose.Schema.Types.Mixed, default: {} }
}, {
  collection: 'app_users_daily_snapshot',
  timestamps: true,
  versionKey: false
});

module.exports = mongoose.model('AppUsersDailySnapshot', AppUsersDailySnapshotSchema);
