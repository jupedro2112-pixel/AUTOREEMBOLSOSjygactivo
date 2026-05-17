
/**
 * Modelo OTP - One-Time Password
 * Almacena códigos OTP hasheados para verificación de teléfono y reset de contraseña.
 * Se auto-elimina de MongoDB después de 5 minutos (TTL index).
 */
const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  codeHash: { type: String, required: true }, // bcrypt hash del código de 6 dígitos
  // 'register'        -> verificación de teléfono al crear cuenta
  // 'reset'           -> reset de contraseña por SMS (olvidé mi contraseña)
  // 'login'           -> login por SMS / OTP
  // 'change-password' -> verificación del nuevo número al cambiar contraseña (forzado o desde perfil)
  purpose: { type: String, enum: ['register', 'reset', 'login', 'change-password'], required: true },
  attempts: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: 300 } // TTL: 5 minutos auto-delete
});

// Índice compuesto para búsquedas eficientes por phone + purpose
otpSchema.index({ phone: 1, purpose: 1 });

module.exports = mongoose.model('OtpCode', otpSchema);
