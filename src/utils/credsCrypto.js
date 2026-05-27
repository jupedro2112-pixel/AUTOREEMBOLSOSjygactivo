/**
 * Cifrado simétrico para credenciales externas guardadas en MongoDB.
 *
 * Uso: creds JUGAYGANA de sub-agentes (uno por publicista). Permite guardar
 * el password en la DB sin exponerlo en plano: si la DB se filtra, las
 * passwords siguen cifradas y requieren la master key para leerse.
 *
 * Algoritmo: AES-256-GCM. Provee confidencialidad + autenticación
 * (authTag detecta cualquier modificación del ciphertext).
 *
 * Formato del string almacenado: "v1:<ivBase64>:<authTagBase64>:<ciphertextBase64>"
 * El prefijo v1 deja la puerta abierta a rotación de algoritmo en el futuro.
 *
 * Master key: variable de entorno JUGAYGANA_CREDS_KEY, 64 caracteres hex
 * (32 bytes). Generala una vez con:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * y guardala en SSM Parameter Store / EB env vars. Si se pierde, las creds
 * existentes son irrecuperables — hay que cargarlas de nuevo desde el panel.
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // recomendado para GCM
const FORMAT_VERSION = 'v1';

function _getKey() {
  const hex = process.env.JUGAYGANA_CREDS_KEY;
  if (!hex) {
    throw new Error('JUGAYGANA_CREDS_KEY no configurada. Generala con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('JUGAYGANA_CREDS_KEY inválida: debe ser un hex de 64 caracteres (32 bytes).');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encripta plaintext y devuelve el blob a almacenar en DB.
 * @param {string} plaintext
 * @returns {string} blob "v1:iv:authTag:ciphertext" (todos en base64)
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt() espera un string');
  }
  const key = _getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    FORMAT_VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ct.toString('base64')
  ].join(':');
}

/**
 * Desencripta el blob almacenado y devuelve el plaintext original.
 * Lanza Error si el blob fue manipulado (authTag inválido) o la key cambió.
 * @param {string} blob
 * @returns {string} plaintext
 */
function decrypt(blob) {
  if (typeof blob !== 'string' || !blob) {
    throw new Error('decrypt() requiere un blob válido');
  }
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error('Formato de blob inválido (esperado v1:iv:authTag:ct)');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const key = _getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * Chequea si la master key está bien configurada SIN throwear. Útil al
 * arranque para loguear un warning sin tirar abajo el server.
 * @returns {boolean}
 */
function isKeyConfigured() {
  try {
    _getKey();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  encrypt,
  decrypt,
  isKeyConfigured
};
