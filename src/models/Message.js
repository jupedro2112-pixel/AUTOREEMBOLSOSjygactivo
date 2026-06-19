
/**
 * Modelo de Mensajes
 * Optimizado para chat en tiempo real de alto rendimiento
 */
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  id: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  senderId: { 
    type: String, 
    required: true, 
    index: true 
  },
  senderUsername: { 
    type: String, 
    required: true,
    trim: true
  },
  senderRole: { 
    type: String, 
    enum: ['user', 'admin', 'depositor', 'withdrawer', 'comunidad', 'system'],
    required: true,
    index: true
  },
  receiverId: { 
    type: String, 
    required: true, 
    index: true 
  },
  receiverRole: { 
    type: String, 
    enum: ['user', 'admin'], 
    required: true 
  },
  content: { 
    type: String, 
    required: true
  },
  type: { 
    type: String, 
    enum: ['text', 'image', 'system', 'file'], 
    default: 'text',
    index: true
  },
  read: { 
    type: Boolean, 
    default: false,
    index: true
  },
  readAt: {
    type: Date,
    default: null
  },
  timestamp: { 
    type: Date, 
    default: Date.now, 
    index: true,
    immutable: true
  },
  editedAt: {
    type: Date,
    default: null
  },
  adminOnly: {
    type: Boolean,
    default: false,
    index: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  }
}, {
  timestamps: true
});

// ÍNDICES CRÍTICOS PARA CHAT RÁPIDO
// Índice compuesto para consultas de conversación
messageSchema.index({ senderId: 1, receiverId: 1, timestamp: -1 });
messageSchema.index({ senderId: 1, timestamp: -1 });
messageSchema.index({ receiverId: 1, timestamp: -1 });

// Índice para mensajes no leídos (muy usado en el panel admin)
messageSchema.index({ receiverId: 1, read: 1, timestamp: -1 });

// Índice para mensajes de admin no leídos
messageSchema.index({ receiverRole: 1, read: 1, timestamp: -1 });

// Índice para búsqueda por tiempo
messageSchema.index({ timestamp: -1 });

// Índice TTL para mensajes antiguos (opcional, descomentar si se quiere auto-limpieza)
// messageSchema.index({ timestamp: 1 }, { expireAfterSeconds: 7776000 }); // 90 días

// Método estático para obtener mensajes de una conversación
messageSchema.statics.getConversation = async function(userId, options = {}) {
  const { limit = 50, before = null, after = null } = options;
  
  const query = {
    $or: [
      { senderId: userId },
      { receiverId: userId }
    ]
  };
  
  if (before) {
    query.timestamp = { $lt: new Date(before) };
  }
  if (after) {
    query.timestamp = { ...query.timestamp, $gt: new Date(after) };
  }
  
  return this.find(query)
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();
};

// Método estático para marcar mensajes como leídos
messageSchema.statics.markAsRead = async function(userId, readerId) {
  const result = await this.updateMany(
    { 
      senderId: userId, 
      receiverId: readerId,
      read: false 
    },
    { 
      read: true, 
      readAt: new Date() 
    }
  );
  return result.modifiedCount;
};

// Método estático para contar mensajes no leídos
messageSchema.statics.countUnread = async function(userId) {
  return this.countDocuments({
    receiverId: userId,
    read: false
  });
};

// Método estático para obtener últimos mensajes por usuario
messageSchema.statics.getLastMessagesByUser = async function(userIds, limit = 1) {
  return this.aggregate([
    {
      $match: {
        $or: [
          { senderId: { $in: userIds } },
          { receiverId: { $in: userIds } }
        ]
      }
    },
    { $sort: { timestamp: -1 } },
    {
      $group: {
        _id: {
          $cond: [
            { $in: ['$senderId', userIds] },
            '$senderId',
            '$receiverId'
          ]
        },
        messages: { $push: '$$ROOT' }
      }
    },
    {
      $project: {
        userId: '$_id',
        lastMessage: { $arrayElemAt: ['$messages', 0] },
        messageCount: { $size: '$messages' }
      }
    }
  ]);
};

// Método de instancia para marcar como leído
messageSchema.methods.markRead = async function() {
  if (!this.read) {
    this.read = true;
    this.readAt = new Date();
    await this.save();
  }
  return this;
};

// Método de instancia para editar mensaje
messageSchema.methods.edit = async function(newContent) {
  this.content = newContent;
  this.editedAt = new Date();
  await this.save();
  return this;
};

module.exports = mongoose.models['Message'] || mongoose.model('Message', messageSchema);