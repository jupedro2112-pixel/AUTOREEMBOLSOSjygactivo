
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
    enum: ['user', 'admin', 'depositor', 'withdrawer'], 
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
  // Cada entrada: { token, context, updatedAt, notifPermission }
  // Permite enviar notificaciones a Chrome Y a la PWA instalada al mismo tiempo.
  fcmTokens: [{
    token: { type: String, required: true },
    context: { type: String, default: 'browser' },
    updatedAt: { type: Date, default: Date.now },
    notifPermission: { type: String, default: null }
  }],

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
  // Atribución de campañas / publicistas
  // =============================================
  // Código de la campaña (Campaign.code) que trajo a este usuario.
  // Se setea durante el signup si el cliente envió un campaignCode válido
  // (vía link ?p=CODE). Una vez seteado no debería cambiar (atribución first-touch
  // a nivel de registro, last-touch a nivel de clic).
  acquisitionCampaign: {
    type: String,
    default: null,
    uppercase: true,
    trim: true,
    index: true
  },
  // UTM parameters capturados del link de pauta (para reporting cross-campaña
  // y para cruzar con datos de Meta Ads).
  acquisitionUtm: {
    source: { type: String, default: null },
    medium: { type: String, default: null },
    campaign: { type: String, default: null },
    content: { type: String, default: null },
    term: { type: String, default: null }
  },
  acquiredAt: {
    type: Date,
    default: null
  },
  // Identificadores de Meta Ads capturados en el registro del usuario.
  // Permiten atribuir conversiones server-side vía Conversions API — en
  // particular el evento Purchase, que se dispara desde el endpoint de admin
  // donde la cookie del navegador del jugador no viaja en el request.
  //   metaFbc — cookie _fbc: identificador del clic del anuncio. Es lo que
  //             ata la conversión al clic en Meta Ads. Formato fb.1.<ts>.<fbclid>.
  //   metaFbp — cookie _fbp: identificador del navegador.
  // Se envían sin hashear en user_data. Una vez seteados no se pisan con null.
  metaFbc: {
    type: String,
    default: null
  },
  metaFbp: {
    type: String,
    default: null
  },
  // URL completa con la que aterrizó el usuario (incluye ?fbclid, ?p=,
  // utm_*). Se manda en cada conversión al sistema externo fb-ads para
  // que pueda atribuir al anuncio específico que lo trajo. Se actualiza
  // last-touch (al registrarse y en cada login si hay nueva atribución).
  landingUrl: {
    type: String,
    default: null
  },
  // True cuando el usuario se registró por el flujo rápido sin OTP de teléfono.
  // El authMiddleware NO bloquea (a diferencia de mustChangePassword): el
  // usuario puede usar todo normalmente excepto retirar. Los endpoints de
  // retiro (/api/movements/withdraw y /api/admin/withdrawal) devuelven 403
  // con code:'PHONE_VERIFICATION_REQUIRED' hasta que /api/auth/verify-phone
  // se complete con éxito.
  phoneVerificationPending: {
    type: Boolean,
    default: false,
    index: true
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

  // =============================================
  // Datos bancarios guardados para retiros
  // =============================================
  // Se completan/actualizan cuando el usuario marca "Guardar mis datos" en el
  // modal de retiro, para autocompletar el formulario la próxima vez.
  withdrawalAccount: {
    titular: { type: String, default: null, trim: true },
    cbu: { type: String, default: null, trim: true },
    alias: { type: String, default: null, trim: true },
    savedAt: { type: Date, default: null }
  },

  // Código temporal de 6 dígitos generado cuando el usuario no pudo verificar
  // el SMS al cambiar la contraseña y eligió "entrar de forma temporal".
  // El acceso real queda condicionado por `phoneVerificationPending`: el usuario
  // puede usar la app pero NO puede retirar hasta verificar su teléfono por SMS.
  pendingAccessCode: {
    type: String,
    default: null
  },

  // Bono one-time por instalar la app (PWA). Se acredita una sola vez cuando el
  // usuario toca "Reclamar" estando dentro de la app instalada (standalone).
  installBonusClaimed: {
    type: Boolean,
    default: false
  },
  installBonusClaimedAt: {
    type: Date,
    default: null
  },

  // Plan de notificaciones elegido en la encuesta inicial (app instalada).
  // Define el volumen de notificaciones push que el usuario quiere recibir.
  // null = todavía no respondió la encuesta.
  notificationPlan: {
    type: String,
    enum: ['suave', 'normal', 'activo', 'solo_reembolsos', null],
    default: null,
    index: true
  },

  // Cuando un admin lo activa, el cliente puede iniciar sesión solo con su
  // usuario, sin contraseña ni SMS. Se controla por cliente desde el panel.
  loginWithoutPassword: {
    type: Boolean,
    default: false,
    index: true
  },

  // Conteo mensual de notificaciones de estrategia recibidas, para respetar
  // los topes del plan de notificaciones del usuario. period = 'YYYY-MM';
  // cuando cambia el mes, los contadores se resetean.
  notifMonthlyCounts: {
    period: { type: String, default: null },
    bonos: { type: Number, default: 0 },
    invitaciones: { type: Number, default: 0 },
    regalos: { type: Number, default: 0 }
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Índices compuestos
userSchema.index({ phone: 1 });
userSchema.index({ role: 1, createdAt: -1 });
userSchema.index({ isActive: 1, role: 1 });
// Para el feed de reclamos y la vista admin del bono $5.000: filtra por
// reclamado y ordena por fecha de reclamo sin ordenar en memoria.
userSchema.index({ installBonusClaimed: 1, installBonusClaimedAt: -1 });

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