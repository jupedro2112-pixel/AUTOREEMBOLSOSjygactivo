const mongoose = require('mongoose');

// Singleton "current": guarda el último análisis activo (compartido entre
// admins). Los items se almacenan comprimidos con gzip para meter ~50k
// usuarios en un solo documento (16MB de límite Mongo).
const RecontactAnalysisSchema = new mongoose.Schema({
  _id: { type: String, default: 'current' },
  savedAt: { type: Date, default: Date.now, index: true },
  fileLabel: String,
  savedByUsername: String,
  summary: { type: mongoose.Schema.Types.Mixed, default: {} },
  itemsCompressed: Buffer,
  itemsCount: { type: Number, default: 0 },
  expiresAt: { type: Date, index: true }
}, {
  collection: 'recontact_analysis',
  timestamps: true,
  versionKey: false
});

// TTL — los docs expiran solos cuando expiresAt vence.
RecontactAnalysisSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RecontactAnalysis', RecontactAnalysisSchema);
