/**
 * Snapshot de "Clientes Activos sin App".
 *
 * Dos tipos:
 *   - kind='auto-daily': lo crea un cron a las 03:00 ART. Solo guarda
 *     AGREGADOS (sin usernames) para que el histórico no infle la DB.
 *     Sirve para el gráfico de evolución día a día.
 *   - kind='manual': lo crea el admin apretando "Generar reporte ahora".
 *     INCLUYE la lista completa de usernames + datos para que después
 *     pueda descargar el CSV. Tiene status (queued → running → ready)
 *     para que la UI muestre progreso.
 *
 * Filtros del snapshot quedan guardados en `params` para poder repetir
 * la query exacta o auditar qué definición de "activo" se usó esa vez.
 *
 * Cleanup: rows manuales viejos (>30 días) se purgan automáticamente
 * para no llenar la DB de listas que ya nadie va a descargar. Los
 * auto-daily se mantienen indefinidamente (son livianos).
 */
const mongoose = require('mongoose');

const teamAggSchema = new mongoose.Schema({
  teamName: String,
  count: Number,            // total activos en este equipo
  countWithApp: Number,
  countWithoutApp: Number,
  totalDepositsARS: Number,
  totalDepositCount: Number
}, { _id: false });

const userRowSchema = new mongoose.Schema({
  username: String,
  lineTeamName: String,
  linePhone: String,
  lastLogin: Date,
  totalDepositsARS: Number,
  depositCount: Number,
  totalWithdrawsARS: Number,
  withdrawCount: Number,
  lastActivityDate: Date,
  hasApp: Boolean,
  hasNotifs: Boolean,
  hasChannel: Boolean,
  welcomeBonusClaimed: Boolean
}, { _id: false });

const activePlayersSnapshotSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  // 'YYYY-MM-DD' en TZ Argentina. Para auto-daily es UNIQUE por día
  // (idempotente — si el cron corre 2 veces, el 2do no duplica).
  dateKey: { type: String, required: true, index: true },

  kind: {
    type: String,
    enum: ['auto-daily', 'manual'],
    required: true,
    index: true
  },

  // Status para snapshots manuales (los auto-daily van directo a 'ready').
  status: {
    type: String,
    enum: ['queued', 'running', 'ready', 'error'],
    default: 'ready'
  },

  // Filtros usados para el cómputo (los del UI o defaults del cron).
  params: {
    windowDays: { type: Number, default: 30 },
    minDepositCount: { type: Number, default: 1 },
    minDepositARS: { type: Number, default: 0 },
    excludeWithApp: { type: Boolean, default: true }
  },

  // Agregados (siempre presentes).
  totalActiveAll: { type: Number, default: 0 },
  totalWithApp: { type: Number, default: 0 },
  totalWithoutApp: { type: Number, default: 0 },
  matchedUsers: { type: Number, default: 0 },
  teams: { type: [teamAggSchema], default: [] },

  // Lista completa (solo para kind='manual').
  // Para auto-daily queda vacío para no inflar la DB.
  users: { type: [userRowSchema], default: [] },

  // Audit.
  generatedAt: { type: Date, default: Date.now },
  generatedBy: { type: String, default: null },  // username del admin o 'cron'
  computedInMs: { type: Number, default: 0 },
  errorMessage: { type: String, default: null }
}, { timestamps: true });

// Auto-daily único por día.
activePlayersSnapshotSchema.index(
  { dateKey: 1, kind: 1 },
  { unique: true, partialFilterExpression: { kind: 'auto-daily' } }
);
activePlayersSnapshotSchema.index({ generatedAt: -1 });
activePlayersSnapshotSchema.index({ kind: 1, generatedAt: -1 });

module.exports = mongoose.models['ActivePlayersSnapshot'] ||
  mongoose.model('ActivePlayersSnapshot', activePlayersSnapshotSchema);
