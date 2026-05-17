/**
 * DeviceAccount — vincula un dispositivo (navegador) con el usuario que
 * inició sesión en él por primera vez.
 *
 * El front genera un ID propio y lo guarda en localStorage; lo manda en
 * cada login. El primer login en un dispositivo lo "reclama" para ese
 * usuario. Si después alguien entra con OTRO usuario desde el mismo
 * dispositivo, esa cuenta se bloquea (anti multi-cuenta, sin usar IP).
 */
const mongoose = require('mongoose');

const deviceAccountSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: false });

module.exports = mongoose.models['DeviceAccount'] ||
  mongoose.model('DeviceAccount', deviceAccountSchema);
