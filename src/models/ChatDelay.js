/**
 * Modelo de Demora de Respuesta en Chats (CONTROL DE SLA DE ATENCIÓN)
 *
 * Registro PERMANENTE (sin TTL) de cada vez que un cliente esperó más que el
 * umbral configurado (default 2 min) entre que mandó un mensaje y que un agente
 * le respondió. Guardamos un SNAPSHOT del texto del mensaje porque `Message`
 * tiene TTL de 3 días y el reporte tiene que sobrevivir a esa limpieza.
 *
 * - status='responded'  → el agente respondió (al fin), guardamos quién y cuánto tardó.
 * - status='unanswered' → el chat se cerró sin que nadie respondiera ese mensaje.
 *
 * El reloj de espera vive en ChatStatus (pendingSince/pendingPreview/pendingType),
 * en MongoDB, así funciona en multi-instancia sin estado en memoria.
 */
const mongoose = require('mongoose');

const chatDelaySchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  // Cliente que esperó
  userId: { type: String, required: true, index: true },
  username: { type: String, trim: true },

  // El mensaje del cliente que arrancó la espera (snapshot, sobrevive al TTL)
  userMessageAt: { type: Date, required: true, index: true },
  userMessagePreview: { type: String, default: '' },
  userMessageType: { type: String, default: 'text' }, // text | image | video

  // Resolución
  respondedAt: { type: Date, default: null },
  delaySeconds: { type: Number, required: true, index: true },
  respondedById: { type: String, default: null },
  respondedByUsername: { type: String, default: null },
  respondedVia: { type: String, default: null }, // 'message' | 'command' | null

  assignedTo: { type: String, default: null },
  status: {
    type: String,
    enum: ['responded', 'unanswered'],
    default: 'responded',
    index: true
  },
  // Cola a la que pertenecía el chat cuando se midió la demora. Pagos suele tener
  // demoras largas esperadas (~30 min para pagar); cargas no debería pasar de pocos
  // minutos. Se usa para separar el reporte y aplicar umbrales distintos.
  category: {
    type: String,
    enum: ['cargas', 'pagos'],
    default: 'cargas',
    index: true
  }
}, {
  timestamps: true
});

// Índices para el reporte (listado por fecha, por agente, por peor demora)
chatDelaySchema.index({ userMessageAt: -1 });
chatDelaySchema.index({ respondedByUsername: 1, userMessageAt: -1 });
chatDelaySchema.index({ status: 1, userMessageAt: -1 });
chatDelaySchema.index({ delaySeconds: -1 });

module.exports = mongoose.models['ChatDelay'] || mongoose.model('ChatDelay', chatDelaySchema);
