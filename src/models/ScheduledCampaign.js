/**
 * ScheduledCampaign — CAMPAÑA PROGRAMADA (#190, owner 2026-10-16).
 *
 * Capa de programación encima de los lotes de notificaciones con regalo (NotifBatch):
 * guarda el MISMO body que acepta `POST /api/admin/notif-batches` (`payload`) y lo "dispara"
 * en una fecha/hora (hora Argentina). Un lote completo se puede dividir en TANDAS (`parts`):
 * la audiencia se resuelve UNA vez (cuando corre la primera tanda), se reparte en N listas
 * sin repetir usuarios y cada tanda sale a su hora como un lote con audiencia 'list'.
 *
 * Estado de cada tanda: scheduled | sending | sent | error | paused | cancelled.
 * Estado de la campaña (derivado al leer): scheduled | sending (alguna salió y falta otra) |
 * sent | error | paused | cancelled.
 *
 * Multi-instancia: el programador (setInterval en cada instancia) reclama cada tanda con un
 * findOneAndUpdate posicional (status 'scheduled' → 'sending'); dos instancias no pueden
 * mandar la misma tanda. Una tanda 'sending' colgada >15 min se marca error (no se reenvía
 * sola: el admin la reprograma desde el calendario).
 */
const mongoose = require('mongoose');

const partSchema = new mongoose.Schema({
  idx: { type: Number, required: true },           // 0..N-1
  runAt: { type: Date, required: true, index: true },
  status: { type: String, enum: ['scheduled', 'sending', 'sent', 'error', 'paused', 'cancelled'], default: 'scheduled' },
  // Lista de usernames de ESTA tanda (se llena al resolver la audiencia en la 1ª tanda).
  usernames: { type: [String], default: undefined },
  count: { type: Number, default: null },           // destinatarios reales (al enviar)
  batchId: { type: String, default: null },         // NotifBatch creado
  code: { type: String, default: null },
  sentAt: { type: Date, default: null },
  claimedAt: { type: Date, default: null },         // cuándo una instancia la tomó
  note: { type: String, default: null },            // #191 resumen del envío push (entregados/fallidos)
  error: { type: String, default: null }
}, { _id: false });

const scheduledCampaignSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  // #191 'lote' = lote con regalo (NotifBatch); 'push' = aviso del compositor "Redactar
  // notificación" (título + mensaje, segmento, lotes de N). Un push `manual:true` es el registro de
  // un envío hecho a mano desde el compositor (sólo para que el calendario lo muestre).
  kind: { type: String, enum: ['lote', 'push'], default: 'lote', index: true },
  manual: { type: Boolean, default: false },
  name: { type: String, default: '', trim: true, maxlength: 80 },
  // Body EXACTO de POST /api/admin/notif-batches (mode, giftType, amount, validHours, message,
  // title, applyMode, applyScope, applyFrom/To, capARS, capExcessPct, audiencia, etc.).
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  // Resumen legible de la audiencia y estimación al programar (para el calendario).
  audienceLabel: { type: String, default: '' },
  estimatedCount: { type: Number, default: null },
  // Tandas (1 = sin dividir).
  parts: { type: [partSchema], default: [] },
  runAt: { type: Date, required: true, index: true }, // = runAt de la primera tanda (para listar)
  paused: { type: Boolean, default: false },
  cancelled: { type: Boolean, default: false },
  createdBy: { type: String, default: null },
  createdByRole: { type: String, default: null },
  updatedBy: { type: String, default: null },
  notes: { type: String, default: '', maxlength: 500 }
}, { timestamps: true });

scheduledCampaignSchema.index({ runAt: 1, cancelled: 1 });
scheduledCampaignSchema.index({ 'parts.status': 1, 'parts.runAt': 1 });

module.exports = mongoose.models['ScheduledCampaign'] || mongoose.model('ScheduledCampaign', scheduledCampaignSchema);
