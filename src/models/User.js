
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
  // Copia en minúsculas del username, indexada. Es el camino RÁPIDO de las
  // búsquedas case-insensitive (login, check-username, unicidad al crear):
  // el regex 'i' anclado no puede usar el índice de username → COLLSCAN.
  // La mantiene el hook pre('save') + backfill al arranque (server.js).
  usernameLower: {
    type: String,
    index: true,
    default: null
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
  // Clave NORMALIZADA del teléfono (solo dígitos, últimos 10) para unicidad robusta:
  // detecta el MISMO número aunque venga en distinto formato (+54.., 011.., con/sin 9).
  // Se setea al verificar el teléfono. El chequeo de "número ya usado" se hace por acá.
  phoneKey: {
    type: String,
    default: null,
    index: true
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
    enum: ['user', 'admin', 'depositor', 'withdrawer', 'publisher_admin', 'comunidad'],
    default: 'user',
    index: true
  },
  // Para cuentas con role='publisher_admin': código de la Campaign a la que
  // están atadas permanentemente. Todo usuario que crean queda atribuido a
  // este código. Ignorado en cualquier otro rol.
  publisherCampaignCode: {
    type: String,
    default: null,
    uppercase: true,
    trim: true,
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
  // 'organic' = el usuario llegó solo por link de pauta (?p=CODE o vanity URL).
  // 'manual'  = lo creó un publisher_admin desde el panel.
  // El default es 'organic' por compatibilidad con usuarios pre-existentes y
  // con el flujo de registro público que no toca este campo.
  acquisitionSource: {
    type: String,
    enum: ['organic', 'manual'],
    default: 'organic',
    index: true
  },
  // Sólo se llena cuando acquisitionSource='manual': identifica al
  // publisher_admin (o admin futuro) que creó el usuario desde el panel.
  // Permite reportes de "cuántos usuarios trajo cada cuenta publicista".
  createdByEmployeeId: {
    type: String,
    default: null,
    index: true
  },
  createdByEmployeeUsername: {
    type: String,
    default: null
  },
  // Sub-atribución por influencer DENTRO de un publicista. Se setea cuando un
  // publisher_admin crea el usuario y elige un influencer de la lista fija de su
  // campaña (Campaign.influencers). Guarda el NOMBRE del influencer (la lista es
  // gestionada → sin typos). Es sólo para desglosar la analítica del publicista
  // por influencer; no tiene link ni creds propias.
  acquisitionInfluencer: {
    type: String,
    default: null,
    trim: true,
    index: true
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

  // ── Link de autologin (alta por agente / migración desde autoreembolsos) ──
  // El admin genera un link desde el panel y se lo pasa al usuario por WhatsApp;
  // al abrirlo, el usuario entra sin escribir contraseña y cae directo en el
  // cambio obligatorio (`mustChangePassword`).
  // Se guarda SOLO el hash SHA-256: el token en claro existe únicamente dentro
  // del link. Un link nuevo PISA al anterior (queda un solo link vivo por
  // usuario). Es de UN SOLO USO y vence — ver AUTOLOGIN_TTL_HOURS en server.js.
  autologinTokenHash: {
    type: String,
    default: null
  },
  autologinExpiresAt: {
    type: Date,
    default: null
  },
  // Sello del canje. No-null ⇒ el link ya se usó y no vuelve a servir.
  autologinUsedAt: {
    type: Date,
    default: null
  },
  // Username del staff que generó el link (auditoría: es un acceso a la cuenta).
  autologinCreatedBy: {
    type: String,
    default: null
  },

  // Bono one-time por instalar la app (PWA). Se reclama una sola vez desde la
  // app instalada (standalone). Hasta 2026-07-28 acreditaba $5.000; ahora el
  // reclamo otorga un CUPÓN de 100% extra en la próxima carga (campos de abajo).
  installBonusClaimed: {
    type: Boolean,
    default: false
  },
  installBonusClaimedAt: {
    type: Date,
    default: null
  },
  // Cupón "100% EXTRA en tu próxima carga" por instalar la app. Lo aplica el
  // AGENTE a mano en la carga (+100% del modal de depósito) y lo marca usado
  // desde el banner del chat (POST /api/admin/users/:id/install-bonus-100/apply).
  installBonus100Pending: {
    type: Boolean,
    default: false
  },
  installBonus100GrantedAt: {
    type: Date,
    default: null
  },
  installBonus100UsedAt: {
    type: Date,
    default: null
  },
  installBonus100UsedBy: {
    type: String,
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
  },

  // Anti-multicuenta: IP y user-agent capturados al momento del registro.
  // Permiten auditar cuentas creadas desde el mismo dispositivo/conexión y
  // detectar patrones de abuso del bono de instalación.
  registrationIp: {
    type: String,
    default: null,
    index: true
  },
  registrationUserAgent: {
    type: String,
    default: null
  },

  // =============================================
  // Etiquetas y notas internas (panel admin)
  // =============================================
  // Etiquetas para clasificar/marcar clientes (ej: 'comprobante-duplicado',
  // 'comprobante-usado', 'sospechoso', 'confiable', 'VIP'). Sólo las usa el staff
  // desde el panel admin: permiten filtrar la lista de usuarios y segmentar
  // difusiones push por etiqueta. Se guardan normalizadas (minúsculas, sin espacios
  // duplicados) desde el backend para que el filtro sea consistente.
  tags: {
    type: [String],
    default: [],
    index: true
  },
  // Nota libre interna sobre el cliente (sólo la ve el staff en el panel).
  adminNotes: {
    type: String,
    default: ''
  },
  // Auditoría liviana de cambios de etiquetas: quién agregó/quitó qué y cuándo.
  tagHistory: [{
    tag: { type: String },
    action: { type: String, enum: ['add', 'remove'] },
    byUsername: { type: String },
    at: { type: Date, default: Date.now }
  }]
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
// Multikey sobre el token FCM del array: lo consultan el reclamo del bono
// instalación, el fraud-check de multicuenta y el logout/limpieza de tokens
// (sin esto son COLLSCAN de toda la colección).
userSchema.index({ 'fcmTokens.token': 1 });
// Audiencias de recuperación/inactividad y cron de reglas (cada 5 min):
// countDocuments/find por role + rango de lastLogin.
userSchema.index({ role: 1, lastLogin: 1 });
// Canje del link de autologin: se busca por el hash del token. Sparse porque
// sólo una minoría de usuarios tiene un link vivo en un momento dado.
userSchema.index({ autologinTokenHash: 1 }, { sparse: true });

// Virtual para verificar si es admin
userSchema.virtual('isAdmin').get(function() {
  return this.role === 'admin';
});

// Virtual para verificar si es agente
userSchema.virtual('isAgent').get(function() {
  return ['admin', 'depositor', 'withdrawer', 'comunidad'].includes(this.role);
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
  // Escapar metacaracteres de regex (anti-ReDoS / inyección de regex).
  const escaped = String(username).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return this.findOne({
    username: { $regex: new RegExp('^' + escaped + '$', 'i') }
  });
};

// Método estático para buscar por teléfono
userSchema.statics.findByPhone = function(phone) {
  return this.findOne({ 
    $or: [{ phone }, { whatsapp: phone }] 
  });
};

// Middleware pre-save: mantener usernameLower sincronizado con username.
userSchema.pre('save', function(next) {
  if (this.isModified('username') || !this.usernameLower) {
    this.usernameLower = String(this.username || '').toLowerCase();
  }
  next();
});

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