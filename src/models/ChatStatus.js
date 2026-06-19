
/**
 * Modelo de Estado de Chat
 * Gestiona el estado de las conversaciones (abierto/cerrado/asignado)
 */
const mongoose = require('mongoose');

const chatStatusSchema = new mongoose.Schema({
  userId: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  username: { 
    type: String, 
    required: true,
    trim: true
  },
  status: { 
    type: String, 
    enum: ['open', 'closed', 'payments', 'comunidad'],
    default: 'open',
    index: true
  },
  category: { 
    type: String, 
    enum: ['cargas', 'pagos'], 
    default: 'cargas',
    index: true
  },
  assignedTo: { 
    type: String, 
    default: null,
    index: true
  },
  closedAt: { 
    type: Date, 
    default: null 
  },
  closedBy: { 
    type: String, 
    default: null 
  },
  lastMessageAt: { 
    type: Date, 
    default: Date.now,
    index: true
  },
  priority: {
    type: String,
    enum: ['low', 'normal', 'high', 'urgent'],
    default: 'normal'
  },
  notes: {
    type: String,
    default: null
  },
  // ===== Reloj de demora de respuesta (control de SLA de atención) =====
  // Se setea cuando el cliente manda un mensaje y no hay una espera en curso;
  // se limpia cuando un agente responde (o cuando se cierra el chat). Permite
  // medir cuánto tardó la atención. Ver modelo ChatDelay.
  pendingSince: {
    type: Date,
    default: null,
    index: true
  },
  pendingPreview: {
    type: String,
    default: null
  },
  pendingType: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// Índices optimizados para consultas frecuentes
chatStatusSchema.index({ status: 1, lastMessageAt: -1 });
chatStatusSchema.index({ category: 1, lastMessageAt: -1 });
chatStatusSchema.index({ assignedTo: 1, status: 1 });

// Método estático para obtener chats abiertos
chatStatusSchema.statics.getOpenChats = function(options = {}) {
  const { limit = 100, category = null } = options;
  const query = { status: 'open' };
  
  if (category) {
    query.category = category;
  }
  
  return this.find(query)
    .sort({ lastMessageAt: -1 })
    .limit(limit)
    .lean();
};

// Método estático para obtener chats por agente
chatStatusSchema.statics.getByAgent = function(agentId) {
  return this.find({ assignedTo: agentId, status: 'open' })
    .sort({ lastMessageAt: -1 })
    .lean();
};

// Método estático para contar chats no asignados
chatStatusSchema.statics.countUnassigned = function() {
  return this.countDocuments({ 
    status: 'open', 
    assignedTo: null 
  });
};

// Método de instancia para cerrar chat
chatStatusSchema.methods.close = async function(closedBy) {
  this.status = 'closed';
  this.closedAt = new Date();
  this.closedBy = closedBy;
  this.assignedTo = null;
  await this.save();
  return this;
};

// Método de instancia para reabrir chat
chatStatusSchema.methods.reopen = async function() {
  this.status = 'open';
  this.closedAt = null;
  this.closedBy = null;
  await this.save();
  return this;
};

// Método de instancia para asignar a agente
chatStatusSchema.methods.assign = async function(agentId) {
  this.assignedTo = agentId;
  this.status = 'open';
  await this.save();
  return this;
};

// Método de instancia para actualizar último mensaje
chatStatusSchema.methods.updateLastMessage = async function() {
  this.lastMessageAt = new Date();
  await this.save();
  return this;
};

module.exports = mongoose.models['ChatStatus'] || mongoose.model('ChatStatus', chatStatusSchema);