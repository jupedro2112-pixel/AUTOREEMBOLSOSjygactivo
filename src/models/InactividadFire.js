/**
 * InactividadFire — registro de cada disparo de la estrategia de
 * RECUPERACIÓN DE INACTIVOS.
 *
 * El fireKey es único e incluye el día del último login del usuario, así
 * cada vez que el usuario vuelve y se vuelve a ausentar, la escalera
 * (7d / 14d / 30d) arranca limpia de nuevo.
 */
const mongoose = require('mongoose');

const inactividadFireSchema = new mongoose.Schema({
  // "<username>|<diaUltimoLogin>|<stepDias>"
  fireKey: { type: String, required: true, unique: true, index: true },

  username: { type: String, required: true, index: true, lowercase: true, trim: true },
  stepDias: { type: Number, required: true },
  tipo:     { type: String, enum: ['bono', 'regalo'], default: 'bono' },
  percent:  { type: Number, default: 0 },
  montoARS: { type: Number, default: 0 },

  firedAt: { type: Date, default: Date.now, index: true }
}, { timestamps: false });

module.exports = mongoose.models['InactividadFire'] ||
  mongoose.model('InactividadFire', inactividadFireSchema);
