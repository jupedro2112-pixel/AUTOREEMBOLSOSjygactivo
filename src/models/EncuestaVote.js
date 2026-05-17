/**
 * EncuestaVote — historial de votos de la encuesta de notificaciones.
 *
 * El campo notificationPlan del usuario guarda solo el estado actual;
 * este modelo guarda cada voto con su fecha para poder ver y analizar
 * qué fue eligiendo la gente a lo largo del tiempo.
 */
const mongoose = require('mongoose');

const encuestaVoteSchema = new mongoose.Schema({
  username: { type: String, required: true, index: true, lowercase: true, trim: true },
  plan:     { type: String, required: true },
  votedAt:  { type: Date, default: Date.now, index: true }
}, { timestamps: false });

module.exports = mongoose.models['EncuestaVote'] ||
  mongoose.model('EncuestaVote', encuestaVoteSchema);
