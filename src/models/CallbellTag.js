const mongoose = require('mongoose');

// Tracking de etiquetas de Callbell (la herramienta que el equipo usa para
// recontactar por WhatsApp). Cada user puede tener 2 flags:
//   - etiqueta: lo marcaron en Callbell como "para-recontactar"
//   - wa: ya le mandaron el mensaje de WhatsApp
// Las dos son independientes (se pueden tildar en cualquier orden).
//
// Conversión: cuando un user etiquetado pasa a tener la app instalada
// (token con context=standalone) DESPUÉS de la primera etiqueta, se marca
// convertedAt y se considera atribuible a la campaña de Callbell.
const CallbellTagSchema = new mongoose.Schema({
  usernameNorm: { type: String, required: true, unique: true, index: true },
  username: String,

  // Flag etiqueta (marcado en Callbell)
  etiqueta: {
    tagged: { type: Boolean, default: false },
    taggedAt: Date,
    taggedBy: String,
    fromBucket: String,
    fromTier: String,
    analysisLabel: String
  },

  // Flag WhatsApp (mensaje enviado)
  wa: {
    tagged: { type: Boolean, default: false },
    taggedAt: Date,
    taggedBy: String,
    fromBucket: String,
    fromTier: String,
    analysisLabel: String
  },

  // Flag favorito/marcado — uso interno del admin para seguir users específicos
  // desde el buscador (sin XLSX). No es una etiqueta de Callbell; marcador personal.
  favorito: {
    tagged: { type: Boolean, default: false },
    taggedAt: Date,
    taggedBy: String
  },

  // Respuesta MANUAL del agente que recontactó: instaló | no_contesto | null
  // (mutuamente excluyentes en la UI, ambas pueden estar vacías al inicio).
  respuesta: {
    status: { type: String, enum: ['instalo', 'no_contesto', null], default: null },
    markedAt: Date,
    markedBy: String
  },

  // Snapshot del estado de app al momento del primer tag — sirve para
  // distinguir "ya tenía la app" de "instaló DESPUÉS de la etiqueta".
  hadAppAtFirstTag: { type: Boolean, default: false },
  firstTaggedAt: { type: Date, index: true },

  // Conversión auto: si tenía hadAppAtFirstTag=false y después se detectó
  // app, se setea esta fecha (la primera vez que se detecta).
  convertedAt: { type: Date, index: true },
  // Cómo se detectó la conversión: 'manual' (admin tildó "instaló") o
  // 'auto' (cron / endpoint detectó token standalone post-tag).
  convertedBy: String,

  notes: String
}, {
  collection: 'callbell_tags',
  timestamps: true,
  versionKey: false
});

// Permite query "etiquetados aún no convertidos"
CallbellTagSchema.index({ 'etiqueta.tagged': 1, convertedAt: 1 });

module.exports = mongoose.model('CallbellTag', CallbellTagSchema);
