/**
 * DailyAppOpen — 1 row por (username, dayKey) con la actividad real
 * en la PWA de ese día. Se upsertea desde authMiddleware en cada
 * request authed de un user con app (throttled 1/min — el mismo
 * throttle del touch de PlayerStats.lastSeenApp).
 *
 * Cada day "cierra" naturalmente: cuando el reloj cruza al día
 * siguiente, los upserts apuntan a un nuevo dayKey y el row del
 * día anterior queda inmutable. Sirve para:
 *   - Serie histórica de DAU (Daily Active Users con app).
 *   - "Cuántos usuarios distintos abrieron la app cada día".
 *   - Drill-down: lista de usernames que abrieron el día X.
 *
 * dayKey = YYYY-MM-DD en hora Argentina (ART, UTC-3). El día empieza
 * a las 00:00 ART = 03:00 UTC.
 *
 * Retención: el cron de stats puede borrar rows con dayKey muy viejo
 * (>365 días) si la tabla crece mucho. Default sin cleanup — los rows
 * son pequeños (~120 bytes c/u) y aún con 200k users × 365 días son
 * ~9GB en el peor caso. Realista 1-2GB.
 */
const mongoose = require('mongoose');

const dailyAppOpenSchema = new mongoose.Schema({
  // Username normalizado a lowercase para que el unique compound sirva
  // independiente del case. El index del username viene del compound.
  username: { type: String, required: true, lowercase: true, trim: true },

  // YYYY-MM-DD en ART. Se compone server-side para evitar drift de TZ
  // entre cliente y server.
  dayKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

  // Contador de aperturas/sesiones del día. $inc en cada touch.
  // No es el número exacto de "abrir la app" (el throttle a 1/min y la
  // PWA que mantiene la sesión hacen que sea una aproximación), pero
  // como señal de "qué tan activo está el user ese día" sirve.
  opens: { type: Number, default: 0 },

  // Cuándo se vio por primera y última vez ese día (timestamps reales).
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now }
}, { timestamps: false });

// Unique compound para idempotencia del upsert.
dailyAppOpenSchema.index({ username: 1, dayKey: 1 }, { unique: true });
// Index para queries por rango de fecha (la métrica principal).
dailyAppOpenSchema.index({ dayKey: 1 });

module.exports = mongoose.models['DailyAppOpen'] ||
  mongoose.model('DailyAppOpen', dailyAppOpenSchema);
