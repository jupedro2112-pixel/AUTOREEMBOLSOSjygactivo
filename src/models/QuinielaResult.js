/**
 * QuinielaResult — resultado oficial de un sorteo de quiniela publicado
 * por el admin. La app NO maneja juego de números; solo informa el
 * resultado para que los users sepan si ganaron (los que jugaron por
 * WhatsApp reclaman manualmente).
 *
 * Flow:
 *   1. Admin crea el resultado en draft (status='draft').
 *   2. Carga el número ganador (4 cifras) y premios.
 *   3. "Publicar" → status='published', publishedAt=now, dispara push
 *      a todos los users con PWA standalone.
 *   4. La PWA del user muestra el último publicado en el home.
 *
 * Solo hay UN resultado "activo" visible al user (el más reciente
 * publicado). Los anteriores quedan en histórico admin.
 */
const mongoose = require('mongoose');

const quinielaResultSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },

  // Nombre legible del sorteo (default "Quiniela Nacional Nocturna" pero
  // editable por si quieren agregar otras: "Vespertina", "Matutina", etc.)
  drawName: { type: String, required: true, maxlength: 80, trim: true, default: 'Quiniela Nacional Nocturna' },

  // Fecha del sorteo (cuándo se hizo). El admin la ingresa — puede ser
  // anterior al momento de carga (ej: sorteo del domingo, lo cargás lunes).
  drawDate: { type: Date, required: true, index: true },

  // Número ganador — STRING de 4 dígitos para mantener ceros a la izquierda
  // (0042 vale tanto como 1234). Validamos en el endpoint.
  winningNumber: { type: String, required: true, match: /^\d{4}$/ },

  // Premios. Default 5M / 500K pero editables por si en algún momento
  // cambia el negocio.
  prize4digits: { type: Number, required: true, default: 5000000, min: 1 },
  prize3digits: { type: Number, required: true, default: 500000, min: 1 },

  // 'draft' = el admin lo creó pero no lo publicó (los users no lo ven todavía).
  // 'published' = visible en la PWA + push ya enviado.
  status: { type: String, enum: ['draft', 'published'], default: 'draft', index: true },

  publishedAt: { type: Date, default: null },
  publishedBy: { type: String, default: null },

  // Cuántos pushes salieron (FYI admin). Si fallan, no bloquea publish.
  pushesSent: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now },
  createdBy: { type: String, default: null }
}, {
  collection: 'quiniela_results',
  timestamps: false,
  versionKey: false
});

quinielaResultSchema.index({ status: 1, publishedAt: -1 });
quinielaResultSchema.index({ drawDate: -1 });

module.exports = mongoose.models['QuinielaResult'] ||
  mongoose.model('QuinielaResult', quinielaResultSchema);
