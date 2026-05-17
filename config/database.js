
// ============================================
// CONFIGURACIÓN MONGODB - PARA 100K+ USUARIOS
// ============================================

const mongoose = require('mongoose');


// ============================================
// MODELOS COMPARTIDOS
// Se importan desde src/models para evitar doble registro en Mongoose.
// config/database.js era el archivo legacy que definía los schemas inline;
// src/models/ es ahora la fuente canónica de todos los modelos compartidos.
// ============================================
const {
  User,
  Message,
  Command,
  Config,
  RefundClaim,
  FireStreak,
  ChatStatus,
  Transaction,
  NotificationHistory,
  MoneyGiveaway,
  MoneyGiveawayClaim,
  ScheduledNotification,
  WaClickLog,
  PlayerStats,
  RecoveryPush,
  TeamCampaign,
  JugayganaImport,
  DailyPlayerStats,
  DailyAppOpen,
  QuinielaResult,
  UserNotification,
  UserLineLookup,
  AppNotifSnapshot,
  NotificationRule,
  NotificationRuleSuggestion,
  WeeklyStrategyConfig,
  WeeklyNotifBudget,
  WeeklyStrategyReport,
  ActivePlayersSnapshot,
  RefundReminderConfig,
  Raffle,
  RaffleParticipation,
  RaffleSpend,
  WeeklyCalendarPlan,
  Segment,
  MasterAnalysisSnapshot,
  NotifStrategyConfig,
  Review,
  WinbackStrategyConfig,
  RecontactAnalysis,
  RecontactHistory,
  AppUsersDailySnapshot,
  CallbellTag,
  Complaint
} = require('../src/models');

// ============================================
// SCHEMA DE USUARIOS EXTERNOS (BASE EXTERNA)
// ============================================
const externalUserSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, sparse: true },
  username: { type: String, required: true, unique: true, index: true },
  phone: { type: String, default: null },
  whatsapp: { type: String, default: null },
  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now },
  messageCount: { type: Number, default: 0 }
}, {
  timestamps: true
});

// ============================================
// SCHEMA DE ACTIVIDAD DE USUARIOS (PARA FUEGUITO)
// ============================================
const userActivitySchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  date: { type: String, required: true, index: true },
  deposits: { type: Number, default: 0 },
  withdrawals: { type: Number, default: 0 },
  lastActivity: { type: Date, default: Date.now }
}, {
  timestamps: true
});

userActivitySchema.index({ userId: 1, date: 1 }, { unique: true });

// ============================================
// CREAR MODELOS (solo los exclusivos de config/database)
// User, Message, Command, Config, RefundClaim, FireStreak,
// ChatStatus y Transaction se importan desde src/models arriba.
// ============================================
const ExternalUser = mongoose.models['ExternalUser'] || mongoose.model('ExternalUser', externalUserSchema);
const UserActivity = mongoose.models['UserActivity'] || mongoose.model('UserActivity', userActivitySchema);

// ============================================
// CONEXIÓN A MONGODB
// ============================================
// Listeners globales de la conexión: nos ayudan a debuggear
// reconexiones espontáneas y deja log de cualquier error de driver.
mongoose.connection.on('connected',     () => console.log('🟢 [Mongo] connected'));
mongoose.connection.on('disconnected',  () => console.warn('🟡 [Mongo] disconnected — driver intentará reconectar'));
mongoose.connection.on('reconnected',   () => console.log('🟢 [Mongo] reconnected'));
mongoose.connection.on('error',         (err) => console.error('🔴 [Mongo] error:', err.message));

// Asegura que la conexión esté lista antes de una query. Si está caída,
// dispara una reconexión y espera hasta `timeoutMs`. Si no se recupera,
// tira un error que el caller puede mapear a 503. Esto cubre el caso en
// que Mongoose se desconectó por un blip de Atlas y se quedó "stuck"
// (a veces el reconnect automático no se dispara).
async function ensureMongoReady(timeoutMs = 4000) {
  // 1=connected. 2=connecting. 0=disconnected. 3=disconnecting.
  if (mongoose.connection.readyState === 1) return true;
  if (mongoose.connection.readyState === 0) {
    try {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/sala-de-juegos', {
        maxPoolSize: 20,
        serverSelectionTimeoutMS: 4000,
        socketTimeoutMS: 30000,
      });
    } catch (e) {
      throw new Error(`Mongo reconnect failed: ${e.message}`);
    }
  }
  // Esperar hasta que readyState===1 o se acabe el tiempo.
  const deadline = Date.now() + timeoutMs;
  while (mongoose.connection.readyState !== 1 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (mongoose.connection.readyState !== 1) {
    throw new Error(`Mongo not ready after ${timeoutMs}ms (state=${mongoose.connection.readyState})`);
  }
  return true;
}

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/sala-de-juegos', {
      maxPoolSize: 20,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    console.log('✅ MongoDB conectado');

    // ============================================================
    // Auto-limpieza de mensajes antiguos (3 días)
    // ============================================================
    // Estrategia en capas para garantizar que mensajes >3 días no sobrevivan:
    //   1) TTL index sobre `timestamp` (campo que existe en todos los
    //      mensajes, viejos y nuevos). MongoDB barre solo cada ~60s.
    //   2) Auto-reparación: si el índice timestamp_1 ya existe sin TTL
    //      (creado por Mongoose por el `index: true` del schema), drop +
    //      recreate con expireAfterSeconds. Sin intervención manual.
    //   3) Limpieza one-shot al boot por si el TTL recién está activándose
    //      o por si alguna fecha vieja escapó al barrido.
    //   4) Cron cada 6h como red de seguridad por si el TTL se rompe.
    //
    // Esta lógica vive acá (en el archivo `config/database.js` que es el
    // único `connectDB` que server.js llama) en lugar de en
    // `src/models/index.js` (que tiene su propio connectDB pero NO se usa
    // desde server.js — solo se usa para exportar modelos).
    // ============================================================
    const MESSAGE_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 días = 259200s

    async function ensureMessageTtlIndex() {
      try {
        await Message.collection.createIndex(
          { timestamp: 1 },
          { expireAfterSeconds: MESSAGE_TTL_SECONDS, name: 'timestamp_1_ttl' }
        );
        console.log('✅ TTL index sobre `timestamp` (3 días) creado/verificado');
      } catch (err) {
        if (err.codeName === 'IndexOptionsConflict' || err.code === 85) {
          console.warn('⚠️ Existe un índice timestamp_1 sin TTL — autorreparando: drop + recreate...');
          try {
            const indexes = await Message.collection.indexes();
            for (const idx of indexes) {
              const keys = Object.keys(idx.key || {});
              const isTimestampIndex = keys.length === 1 && keys[0] === 'timestamp';
              const hasTtl = typeof idx.expireAfterSeconds === 'number';
              if (isTimestampIndex && !hasTtl) {
                await Message.collection.dropIndex(idx.name);
                console.log(`🧹 Índice "${idx.name}" sin TTL dropeado`);
              }
            }
            await Message.collection.createIndex(
              { timestamp: 1 },
              { expireAfterSeconds: MESSAGE_TTL_SECONDS, name: 'timestamp_1_ttl' }
            );
            console.log('✅ TTL index sobre `timestamp` recreado tras autorreparación');
          } catch (repairErr) {
            console.error('❌ Autorreparación del TTL index falló:', repairErr.message);
          }
        } else {
          console.error('❌ Error creando TTL index:', err.message);
        }
      }
    }

    async function cleanupOldMessages(label) {
      try {
        const cutoff = new Date(Date.now() - MESSAGE_TTL_SECONDS * 1000);
        const result = await Message.deleteMany({ timestamp: { $lt: cutoff } });
        if (result.deletedCount > 0) {
          console.log(`🧹 [${label}] ${result.deletedCount} mensajes antiguos (>3 días) eliminados`);
        } else {
          console.log(`✅ [${label}] No hay mensajes antiguos para eliminar`);
        }
      } catch (err) {
        console.error(`❌ [${label}] Error en limpieza de mensajes antiguos:`, err.message);
      }
    }

    // Disparar en background para no bloquear el bootstrap del server
    ensureMessageTtlIndex();
    cleanupOldMessages('boot');

    // Cron cada 6h como red de seguridad. .unref() evita bloquear shutdown.
    setInterval(() => cleanupOldMessages('cron-6h'), 6 * 60 * 60 * 1000).unref();

    return true;
  } catch (error) {
    console.error('❌ Error conectando MongoDB:', error.message);
    return false;
  }
}

// ============================================
// DESCONECTAR
// ============================================
async function disconnectDB() {
  await mongoose.disconnect();
  console.log('MongoDB desconectado');
}

// ============================================
// FUNCIONES HELPER PARA CONFIGURACIÓN
// ============================================

// Obtener configuración por clave
async function getConfig(key, defaultValue = null) {
  try {
    const config = await Config.findOne({ key });
    return config ? config.value : defaultValue;
  } catch (error) {
    console.error(`Error obteniendo config ${key}:`, error);
    return defaultValue;
  }
}

// Guardar configuración
async function setConfig(key, value) {
  try {
    await Config.findOneAndUpdate(
      { key },
      { key, value, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    return true;
  } catch (error) {
    console.error(`Error guardando config ${key}:`, error);
    return false;
  }
}

// ============================================
// FUNCIONES HELPER PARA COMANDOS
// ============================================

// Obtener todos los comandos
async function getAllCommands() {
  try {
    const commands = await Command.find({ isActive: true }).lean();
    const result = {};
    commands.forEach(cmd => {
      result[cmd.name] = cmd;
    });
    return result;
  } catch (error) {
    console.error('Error obteniendo comandos:', error);
    return {};
  }
}

// Obtener comando por nombre
async function getCommand(name) {
  try {
    return await Command.findOne({ name, isActive: true });
  } catch (error) {
    console.error(`Error obteniendo comando ${name}:`, error);
    return null;
  }
}

// Guardar comando
async function saveCommand(name, data) {
  try {
    await Command.findOneAndUpdate(
      { name },
      { ...data, name, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    return true;
  } catch (error) {
    console.error(`Error guardando comando ${name}:`, error);
    return false;
  }
}

// Eliminar comando
async function deleteCommand(name) {
  try {
    await Command.deleteOne({ name });
    return true;
  } catch (error) {
    console.error(`Error eliminando comando ${name}:`, error);
    return false;
  }
}

// Incrementar uso de comando
async function incrementCommandUsage(name) {
  try {
    await Command.updateOne({ name }, { $inc: { usageCount: 1 } });
    return true;
  } catch (error) {
    console.error(`Error incrementando uso de comando ${name}:`, error);
    return false;
  }
}

// ============================================
// EXPORTAR
// ============================================
module.exports = {
  connectDB,
  disconnectDB,
  ensureMongoReady,
  User,
  Message,
  Command,
  Config,
  RefundClaim,
  FireStreak,
  ChatStatus,
  Transaction,
  ExternalUser,
  UserActivity,
  NotificationHistory,
  MoneyGiveaway,
  MoneyGiveawayClaim,
  ScheduledNotification,
  WaClickLog,
  PlayerStats,
  RecoveryPush,
  TeamCampaign,
  JugayganaImport,
  DailyPlayerStats,
  DailyAppOpen,
  QuinielaResult,
  UserNotification,
  UserLineLookup,
  AppNotifSnapshot,
  NotificationRule,
  NotificationRuleSuggestion,
  WeeklyStrategyConfig,
  WeeklyNotifBudget,
  WeeklyStrategyReport,
  ActivePlayersSnapshot,
  RefundReminderConfig,
  Raffle,
  RaffleParticipation,
  RaffleSpend,
  WeeklyCalendarPlan,
  Segment,
  MasterAnalysisSnapshot,
  NotifStrategyConfig,
  Review,
  WinbackStrategyConfig,
  RecontactAnalysis,
  RecontactHistory,
  AppUsersDailySnapshot,
  CallbellTag,
  Complaint,
  // Helpers
  getConfig,
  setConfig,
  getAllCommands,
  getCommand,
  saveCommand,
  deleteCommand,
  incrementCommandUsage
};