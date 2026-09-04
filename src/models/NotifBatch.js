/**
 * NotifBatch — LOTE de notificaciones con regalo (portado de PAUTANUEVA, WORKLOG #149 de este repo).
 *
 * Un agente (admin general o depositor) envía una notificación a una LISTA
 * de usuarios con un regalo asociado: % extra en la próxima carga o un monto
 * fijo en $. Dos modos:
 *
 *  - 'code':   la notificación lleva un CÓDIGO. Solo los usuarios DEL LOTE
 *              pueden canjearlo (en la PWA, "Reclamar Bono con Código").
 *              Al canjear se les activa un PromoBonus (cartel verde del
 *              agente) vigente hasta expiresAt del lote.
 *  - 'window': sin código. Al enviar, TODOS los del lote reciben el
 *              PromoBonus de una, vigente por validHours.
 *
 * El "bono" en sí es un PromoBonus (src/models/PromoBonus.js) con
 * sourceRuleCode='lote' — así el cartel verde del chat y el "Marcar como
 * usado" existentes funcionan sin duplicar nada. El lote guarda además el
 * resultado del envío por destinatario (canal + entrega) para el historial
 * del panel ("quién lo mandó y a quiénes, a quién le llegó").
 */
const mongoose = require('mongoose');

const notifBatchSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  // Etiqueta opcional para identificar el lote en el historial.
  name: { type: String, default: '', trim: true, maxlength: 60 },

  mode: { type: String, enum: ['code', 'window'], required: true },

  // percent = % extra sobre la próxima carga (lo APLICA EL AGENTE en la
  // carga, cartel verde). fixed = regalo de fichas: en modo 'code' se
  // ACREDITA AUTOMÁTICO al canjear (bono girox con rolloverX); en modo
  // 'window' va con cartel del agente como el %.
  giftType: { type: String, enum: ['percent', 'fixed'], required: true },
  amount: { type: Number, required: true, min: 1 },

  // APLICACIÓN del % (owner 2026-09-04): 'auto' = el sistema lo suma SOLO en
  // la carga (manual sin bonus del agente / hgcash), sin cartel que marcar;
  // 'agent' = el flujo viejo (cartel verde + "Marcar usado"). Lotes viejos sin
  // el campo → 'agent'.
  applyMode: { type: String, enum: ['agent', 'auto'], default: 'agent' },
  // 'first' = solo la primera carga; 'all' = TODAS las cargas hasta expiresAt.
  applyScope: { type: String, enum: ['first', 'all'], default: 'first' },
  // Franja horaria diaria (minutos del día, hora argentina) en la que aplica
  // el % automático. null = a cualquier hora dentro de la vigencia.
  applyFromMin: { type: Number, default: null },
  applyToMin: { type: Number, default: null },

  // (Heredado del repo hermano: en JUGAYGANA no hay rollover configurable por
  // crédito; se guarda solo por compatibilidad del historial.)
  rolloverX: { type: Number, default: 0, min: 0 },

  // Solo modo 'code'. SIEMPRE en mayúsculas (el canje compara uppercased).
  code: { type: String, default: null, uppercase: true, trim: true, index: true },

  // CÓDIGO PÚBLICO (owner 2026-08-10): sin lista de destinatarios — se crea
  // para subirlo a la Comunidad de Telegram / redes. CUALQUIER cliente
  // registrado puede canjearlo (una vez cada uno, hasta maxClaims si hay
  // cupo). Los que canjean se APPENDEAN a recipients (así el historial
  // muestra quiénes fueron). No se envía ninguna notificación (sendDone nace
  // true). Misma mecánica de regalo que un lote normal.
  isPublic: { type: Boolean, default: false },
  maxClaims: { type: Number, default: null },

  // Horas de vigencia (configurable por lote). En 'window': cuánto dura el
  // bono desde el envío. En 'code': hasta cuándo se puede canjear el código
  // Y hasta cuándo vale el bono canjeado (un solo reloj por lote).
  validHours: { type: Number, required: true, min: 1 },
  sentAt: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, required: true, index: true },

  // Texto que ve el cliente (push + mensaje de chat). El código se agrega
  // al final automáticamente en modo 'code'.
  title: { type: String, default: '', trim: true, maxlength: 100 },
  message: { type: String, required: true, maxlength: 500 },

  sentBy: { type: String, required: true },
  sentByRole: { type: String, default: null },

  // Cómo se armó la lista (para el historial): 'list' = usernames pegados,
  // 'inactive' = inactivos ≥ audienceDays sin login (tope audienceLimit,
  // los más recientes primero), 'all' = lote completo (todos los clientes).
  // 'segment' (2026-09-04) = filtro fino: base (sin login / sin cargar /
  // cargaron hace poco) + mín. cargas + mín. $ + publicista + cupo. El filtro
  // exacto queda en audienceFilter y su texto legible en audienceLabel.
  audienceType: { type: String, enum: ['list', 'inactive', 'all', 'public', 'segment'], default: 'list' },
  audienceDays: { type: Number, default: null },
  audienceLimit: { type: Number, default: null },
  audienceFilter: { type: mongoose.Schema.Types.Mixed, default: null },
  audienceLabel: { type: String, default: '' },

  // false hasta que TODOS los recipients tengan delivery final. El motor
  // (_processNotifBatchQueue, cron en server.js) retoma los lotes con
  // sendDone:false — un deploy/reinicio a mitad de envío NO pierde nada.
  sendDone: { type: Boolean, default: false, index: true },

  recipients: {
    type: [{
      userId: { type: String, required: true },
      username: { type: String, required: true },
      // Capacidad de push AL MOMENTO del envío (misma clasificación que el
      // badge del chat): app = token standalone, browser = token de
      // navegador, none = sin ningún token FCM.
      channel: { type: String, enum: ['app', 'browser', 'none'], default: 'none' },
      // Estado de entrega: null = pendiente; 'sending' = reclamado por una
      // instancia (si queda colgado >10 min se retoma); finales: socket
      // (estaba online), push (FCM OK), none (sin token), error (FCM falló;
      // el mensaje de chat igual le queda). El claim es ATÓMICO por
      // destinatario → dos instancias nunca le mandan doble.
      delivery: { type: String, default: null },
      deliveryAt: { type: Date, default: null },
      // Modo 'code': cuándo canjeó. Modo 'window': = sentAt (bono directo).
      claimedAt: { type: Date, default: null },
      promoBonusId: { type: String, default: null },
      // Solo regalo de fichas (auto-acreditado): cuándo y con qué
      // transferencia se le acreditó el bono en JUGAYGANA. creditError = por qué
      // NO se le acreditó (bono activo en el casino, tope de seguridad, fallo
      // de la API) — visible en el detalle del lote para resolverlo a mano.
      creditedAt: { type: Date, default: null },
      creditTxId: { type: String, default: null },
      creditError: { type: String, default: null },
      _id: false
    }],
    default: []
  }
}, { timestamps: false });

notifBatchSchema.index({ mode: 1, code: 1, expiresAt: -1 });
notifBatchSchema.index({ 'recipients.userId': 1 });

module.exports = mongoose.models['NotifBatch'] ||
  mongoose.model('NotifBatch', notifBatchSchema);
