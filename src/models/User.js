
/**
 * Modelo de Usuario
 * Gestiona usuarios, admins y roles
 */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { generateReferralCode } = require('../utils/referralCode');

const userSchema = new mongoose.Schema({
  id: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  username: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true,
    trim: true,
    minlength: 3,
    maxlength: 30
  },
  password: { 
    type: String, 
    required: true,
    minlength: 6
  },
  email: { 
    type: String, 
    default: null,
    lowercase: true,
    trim: true
  },
  phone: { 
    type: String, 
    default: null,
    trim: true
  },
  phoneVerified: {
    type: Boolean,
    default: false,
    index: true
  },
  whatsapp: { 
    type: String, 
    default: null,
    trim: true
  },
  // Consentimiento explícito del usuario para recibir SMS (incluye marketing/avisos masivos).
  // Se setea automáticamente a true cuando el usuario verifica su teléfono vía OTP en el alta
  // o en el cambio de contraseña, ya que en ese momento confirma tener acceso a la línea.
  // Es uno de los filtros usados por el panel de SMS Masivo (ver buildBulkSmsQuery en server.js).
  smsConsent: {
    type: Boolean,
    default: false,
    index: true
  },
  role: {
    type: String,
    enum: ['user', 'admin', 'depositor', 'withdrawer', 'closings_viewer'],
    default: 'user',
    index: true
  },
  accountNumber: { 
    type: String, 
    unique: true,
    sparse: true
  },
  balance: { 
    type: Number, 
    default: 0,
    min: 0
  },
  isActive: { 
    type: Boolean, 
    default: true 
  },
  lastLogin: { 
    type: Date, 
    default: null 
  },
  createdAt: { 
    type: Date, 
    default: Date.now,
    immutable: true
  },
  passwordChangedAt: { 
    type: Date, 
    default: null 
  },
  // Forces the user to change their password before they can use the rest of the app.
  // Set to `true` when:
  //   - A new user is auto-imported from JUGAYGANA (default password "asd123").
  //   - Login detects the JUGAYGANA-default scenario (`needsPasswordChange`).
  //   - An admin resets the user's password.
  // Cleared (`false`) when the user successfully completes a password change
  // (POST /api/auth/change-password) or a password reset by SMS
  // (POST /api/auth/complete-password-reset).
  // Enforced server-side by `authMiddleware`: any authenticated request to a
  // non-allow-listed path returns 403 with `code: 'MUST_CHANGE_PASSWORD'` while
  // this flag is true. This prevents bypassing the mandatory change modal by
  // simply reloading the page.
  mustChangePassword: {
    type: Boolean,
    default: false,
    index: true
  },
  tokenVersion: { 
    type: Number, 
    default: 0 
  },
  
  // Campos JUGAYGANA
  jugayganaUserId: { 
    type: Number, 
    default: null,
    index: true
  },
  jugayganaUsername: { 
    type: String, 
    default: null 
  },
  jugayganaSyncStatus: { 
    type: String, 
    enum: ['pending', 'synced', 'linked', 'error', 'imported', 'not_applicable', 'na'], 
    default: 'pending',
    index: true
  },
  jugayganaSyncError: { 
    type: String, 
    default: null 
  },
  source: { 
    type: String, 
    enum: ['local', 'jugaygana'], 
    default: 'local' 
  },
  
  // Token FCM para notificaciones push (último registrado – se mantiene para compatibilidad y vista admin)
  fcmToken: { 
    type: String, 
    default: null,
    index: true
  },
  fcmTokenUpdatedAt: {
    type: Date,
    default: null
  },
  // Contexto en que se obtuvo el token: 'standalone' (PWA instalada) o 'browser'
  fcmTokenContext: {
    type: String,
    default: null
  },
  // Último permiso de notificaciones reportado por el cliente: 'granted' / 'denied' / 'default'
  notifPermission: {
    type: String,
    default: null
  },
  // Lista de todos los tokens FCM activos del usuario (uno por contexto/dispositivo).
  // Cada entrada: { token, context, updatedAt, notifPermission, platform }
  // Permite enviar notificaciones a Chrome Y a la PWA instalada al mismo tiempo.
  // platform: 'android' | 'ios' | 'desktop' | null (legacy/desconocido) — se
  // detecta del user-agent en el endpoint /register-token.
  fcmTokens: [{
    token: { type: String, required: true },
    context: { type: String, default: 'browser' },
    updatedAt: { type: Date, default: Date.now },
    notifPermission: { type: String, default: null },
    platform: { type: String, default: null }
  }],

  // Marca temporal de la PRIMERA vez que el user instala la app (PWA
  // standalone) con notificaciones granted. Se setea una sola vez en el
  // endpoint /register-token cuando el flag de "channel" pasa de false
  // a true. Sirve para detectar "clientes recuperados" en la sección
  // de Activos sin app: si pasamos del estado sin-app → con-app+notif,
  // este timestamp marca cuándo. NO se reescribe en re-installs.
  appFirstInstalledAt: { type: Date, default: null, index: true },

  // =============================================
  // Campos de sistema de referidos
  // =============================================
  referralCode: {
    type: String,
    default: null,
    unique: true,
    sparse: true,
    uppercase: true,
    trim: true,
    index: true
  },
  referredByUserId: {
    type: String,
    default: null,
    index: true
  },
  referredByCode: {
    type: String,
    default: null,
    trim: true
  },
  referredAt: {
    type: Date,
    default: null
  },
  referralStatus: {
    type: String,
    enum: ['none', 'referred', 'active'],
    default: 'none',
    index: true
  },
  // Codigo de campaña de marketing por la que vino el user (ej: 'promo2k').
  // Se setea al registrarse cuando el front detecta ?c=<code> en la URL y lo
  // tiene en localStorage. Permite hacer attribution para medir conversion
  // por campaña: cuanta gente entro al link, cuantos crearon cuenta, cuantos
  // reclamaron el bono, cuantos cargaron despues. Una vez seteado no se cambia
  // (first-touch attribution). null si vinieron por trafico directo.
  campaignCode: {
    type: String,
    default: null,
    lowercase: true,
    trim: true,
    maxlength: 60,
    index: true
  },
  campaignCodeAt: { type: Date, default: null },
  excludedFromReferral: {
    type: Boolean,
    default: false,
    index: true
  },
  // Para futura escalabilidad de tiers / tasas personalizadas
  referralTier: {
    type: String,
    default: null
  },
  referralRateOverride: {
    type: Number,
    default: null,
    min: 0,
    max: 1
  },

  // =============================================
  // Asignación explícita de línea (Drive import)
  // Cuando estos campos están seteados, ganan sobre el matcher por prefijo
  // (userLinesByPrefix). Permite que dos usuarios con el mismo prefijo (ej:
  // "ato") caigan en líneas distintas (Atomic Línea 1 vs Atomic Línea 2),
  // según lo que indique el .xlsx importado por el admin.
  // Si ambos campos están vacíos, el sistema cae al matcher por prefijo.
  // =============================================
  linePhone: {
    type: String,
    default: null,
    index: true,
    trim: true
  },
  lineTeamName: {
    type: String,
    default: null,
    trim: true
  },
  lineAssignedAt: {
    type: Date,
    default: null
  },
  lineAssignedBy: {
    type: String,
    default: null
  },
  // Cómo se asignó la línea actual:
  //   'drive-import' = por import .xlsx de Drive (admin o auto)
  //   'lookup'       = match en UserLineLookup (pre-asignación)
  //   'prefix-fallback' = matcheo por prefijo del username (longest-match)
  //   'general-default' = no matcheó nada → línea genérica del config
  //   'admin-manual' = admin lo seteó a mano
  //   null = sin asignación
  lineAssignmentSource: {
    type: String,
    enum: ['drive-import', 'lookup', 'prefix-fallback', 'general-default', 'admin-manual', null],
    default: null,
    index: true
  },
  // Nota human-readable de cómo se asignó: "argen → Argen 1 (+5491...)"
  // Útil en el panel admin para ver de un vistazo qué pasó con cada user.
  lineAssignmentNote: {
    type: String,
    default: null,
    trim: true
  },

  // =============================================
  // Bloqueo de cuenta (solo admin general puede bloquear/desbloquear)
  // =============================================
  isBlocked: {
    type: Boolean,
    default: false,
    index: true
  },
  blockReason: {
    type: String,
    default: null
  },
  blockedAt: {
    type: Date,
    default: null
  },
  blockedBy: {
    type: String,
    default: null
  },

  // Encuesta de preferencia de notificaciones (Fase 1).
  // El user elige al primer login post-survey. La estrategia mensual de
  // notifs (Fase 2) usa este campo + el tier de comportamiento del user
  // (VIP/Standard/Casual segun realDeposits30d) para decidir cuantos
  // bonos / invitaciones / regalos enviarle al mes.
  //   suave    = 2 bonos · 5 invitaciones · 2 regalos/mes
  //   normal   = 4 bonos · 5 invitaciones · 2 regalos/mes (default)
  //   activo   = 6 bonos · 10 invitaciones · 3 regalos/mes
  //   opt_out  = 0 (respetamos la decision)
  notifPreference: {
    type: String,
    // 'opt_out' queda en el enum por compatibilidad con users que ya
    // contestaron antes del cambio. 'solo_reembolsos' es el reemplazo
    // semantico (recibe notifs SOLO si hay un reembolso disponible).
    enum: ['suave', 'normal', 'activo', 'opt_out', 'solo_reembolsos'],
    default: null,
    index: true
  },
  notifPreferenceAt: { type: Date, default: null },

  // Fraud block: cuenta bloqueada por intento de estafa de bono.
  // Se setea cuando intentan reclamar el welcome bonus desde una IP que
  // ya cobró bajo otra cuenta. Cualquier login subsiguiente queda
  // rechazado con `fraudReason` como motivo. Cualquier claim queda
  // rechazado igual aunque tengan token viejo válido.
  fraudBlocked: { type: Boolean, default: false, index: true },
  fraudReason: { type: String, default: null },
  fraudBlockedAt: { type: Date, default: null },
  fraudBlockedIp: { type: String, default: null },
  // Bloqueo "soft" — el user puede LOGUEARSE y usar la app, pero NO
  // puede reclamar bono de bienvenida ni códigos canjeables. Se usa
  // cuando el admin levanta el fraudBlocked pero sospecha que hay
  // duplicación de IP/cuenta — le deja jugar pero sin regalos.
  bonusBlocked: { type: Boolean, default: false, index: true },
  bonusBlockedAt: { type: Date, default: null },
  bonusBlockedReason: { type: String, default: null },
  // Cuando admin desbloquea o restringe a un user, le activamos un cartel
  // grande en la home avisándole que NO cambie de sesión en la app
  // (porque notifs, bono y códigos van por user). El user lo dismissea
  // y se apaga. Auto-vence a los 7 días por si no entra en mucho tiempo.
  unblockNoticePending: { type: Boolean, default: false },
  unblockNoticeAt: { type: Date, default: null },
  // Confirmación de que el user se sumó al canal de Telegram. Lo seteamos
  // a true cuando reclama un código canjeable (los códigos solo viven en
  // Telegram; reclamarlo prueba que el user vio el canal). Sirve para que
  // las campañas de "Unite a Telegram" / "Activá comunidad 24h" no le
  // sigan apareciendo a quien ya está adentro.
  joinedTelegram: { type: Boolean, default: false },
  joinedTelegramAt: { type: Date, default: null },
  // Huella del dispositivo del último login del usuario (hash SHA-256 de
  // userAgent + pantalla + idioma + timezone + canvas hash). Permite
  // detectar el mismo dispositivo aunque el user borre caché/cookies y
  // cree cuenta nueva. Si dos users con huella idéntica intentan reclamar
  // el welcome bonus → fraudBlocked en el segundo.
  deviceFingerprint: { type: String, default: null, index: true },
  deviceFingerprintAt: { type: Date, default: null },

  // Win-back automático (estrategia de recuperación). Tier actual:
  //   0 = activo / nunca disparado
  //   1 = recibió tier1 (te extrañamos)
  //   2 = recibió tier2 (regalo cash)
  //   3 = recibió tier3 (cod100)
  //   4 = cooldown (no mandar más)
  // Si el user carga, vuelve a 0.
  winbackTier: { type: Number, default: 0, min: 0, max: 4, index: true },
  winbackLastSentAt: { type: Date, default: null, index: true },

  // Número de contacto de respaldo: lo deja el user en el chip "📞 Tu N°"
  // de la home. Sirve para tener una vía paralela si la página falla y
  // queremos avisarle. NO se valida con OTP — el user lo escribe libre.
  backupContactPhone: { type: String, default: null, trim: true },
  backupContactPhoneAt: { type: Date, default: null }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Índices compuestos
userSchema.index({ phone: 1 });
userSchema.index({ role: 1, createdAt: -1 });
userSchema.index({ isActive: 1, role: 1 });

// Virtual para verificar si es admin
userSchema.virtual('isAdmin').get(function() {
  return this.role === 'admin';
});

// Virtual para verificar si es agente
userSchema.virtual('isAgent').get(function() {
  return ['admin', 'depositor', 'withdrawer'].includes(this.role);
});

// Método para comparar contraseña
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Método para cambiar contraseña
userSchema.methods.changePassword = async function(newPassword) {
  this.password = await bcrypt.hash(newPassword, 12);
  this.passwordChangedAt = new Date();
  this.tokenVersion += 1;
  await this.save();
};

// Método para verificar si cambió contraseña después de cierta fecha
userSchema.methods.changedPasswordAfter = function(JWTTimestamp) {
  if (this.passwordChangedAt) {
    const changedTimestamp = parseInt(this.passwordChangedAt.getTime() / 1000, 10);
    return JWTTimestamp < changedTimestamp;
  }
  return false;
};

// Método estático para buscar por username (case-insensitive)
userSchema.statics.findByUsername = function(username) {
  return this.findOne({ 
    username: { $regex: new RegExp('^' + username + '$', 'i') } 
  });
};

// Método estático para buscar por teléfono
userSchema.statics.findByPhone = function(phone) {
  return this.findOne({ 
    $or: [{ phone }, { whatsapp: phone }] 
  });
};

// Middleware pre-save para hashear contraseña
userSchema.pre('save', async function(next) {
  // Solo hashear si la contraseña fue modificada
  if (!this.isModified('password')) return next();
  
  // Hashear con costo 12
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Middleware pre-save para generar accountNumber si no existe
userSchema.pre('save', async function(next) {
  if (!this.accountNumber && this.isNew) {
    this.accountNumber = 'ACC' + Date.now().toString().slice(-8) + 
      Math.random().toString(36).substr(2, 4).toUpperCase();
  }
  next();
});

// Middleware pre-save para generar referralCode si no existe
userSchema.pre('save', async function(next) {
  if (!this.referralCode && this.isNew) {
    this.referralCode = generateReferralCode();
  }
  next();
});

module.exports = mongoose.models['User'] || mongoose.model('User', userSchema);