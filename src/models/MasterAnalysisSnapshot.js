/**
 * MasterAnalysisSnapshot: cada vez que el admin aprieta "📊 Analizar con
 * Maestro" en alguna seccion del panel (relampago / top jugadores /
 * top stats / recuperacion / automatizaciones), persistimos el resultado
 * aca para tener historial de como va evolucionando con cada upload nuevo
 * del archivo maestro.
 *
 * El front muestra el snapshot mas reciente como "Actual" y los anteriores
 * como historial — comparando con el inmediato anterior se ven los deltas.
 */
const mongoose = require('mongoose');

const masterAnalysisSnapshotSchema = new mongoose.Schema({
  // Que seccion del admin disparo este snapshot.
  section: {
    type: String,
    required: true,
    enum: ['relampago', 'top_jugadores', 'top_stats', 'recuperacion', 'automatizaciones'],
    index: true
  },
  ranAt: { type: Date, default: Date.now, index: true },
  ranBy: { type: String, default: 'admin' },

  // Que master se uso (slug) y rango temporal del analisis (filas que
  // entraron). Si rangeFrom/To son null = todo el archivo maestro.
  masterSlug: { type: String, default: null },
  masterUploadAt: { type: Date, default: null },
  rangeFrom: { type: Date, default: null },
  rangeTo: { type: Date, default: null },
  rowsAnalyzed: { type: Number, default: 0 },

  // Resultado del analisis. Schema-less porque cada seccion devuelve
  // estructura distinta. El front conoce el formato.
  data: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: false });

masterAnalysisSnapshotSchema.index({ section: 1, ranAt: -1 });

module.exports = mongoose.models['MasterAnalysisSnapshot'] ||
  mongoose.model('MasterAnalysisSnapshot', masterAnalysisSnapshotSchema);
