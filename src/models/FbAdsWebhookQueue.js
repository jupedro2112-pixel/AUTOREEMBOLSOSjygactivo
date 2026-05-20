/**
 * FbAdsWebhookQueue — cola persistente de eventos pendientes a notificar
 * al sistema externo fb-ads.
 *
 * Cada item es un intento fallido (tras los 3 reintentos inmediatos) que
 * vuelve a procesarse desde el worker periódico de fbAdsWebhookService
 * (`processQueue`). Si tras N attempts no entra, se descarta.
 */
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  // Payload tal cual lo manda fbAdsWebhookService.notify().
  payload: { type: Object, required: true },
  // Cuántos POST se intentaron en total (reintentos inmediatos + de cola).
  attempts: { type: Number, default: 0 },
  // Último error capturado (truncado).
  lastError: { type: String, default: null },
  // Próximo momento en que el worker debe re-intentar este item.
  nextRetryAt: { type: Date, required: true, index: true },
  createdAt: { type: Date, default: Date.now }
});

// El worker barre `nextRetryAt <= now` ordenado por proximidad.
schema.index({ nextRetryAt: 1 });

module.exports = mongoose.models['FbAdsWebhookQueue']
  || mongoose.model('FbAdsWebhookQueue', schema);
