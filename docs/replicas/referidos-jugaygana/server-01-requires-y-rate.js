// ============================================================================
// 1) server.js — requires, redirect /linkreferido, carga del % plano y endpoints /api/admin/referral-rate (#168/#169)
// Extraído de AUTOREEMBOLSOSjygactivo/server.js (commit 3860f83, 2026-10-06). Pegar tal cual
// salvo lo indicado en README.md.
// ============================================================================

// (a) Requires (arriba, junto a los otros modelos/servicios):
const ReferralMilestoneClaim = require('./src/models/ReferralMilestoneClaim'); // #168 premios por cantidad de referidos
const _periodKey = require('./src/utils/periodKey');
const { getReferralRateForUser, setGlobalReferralRate, getGlobalReferralRate } = require('./src/utils/referralRate'); // #168/#169 % del referidor (global editable)
const referralTiers = require('./src/services/referralTierService'); // #171 niveles de % por cantidad de referidos activos
const hgcashPay = require('./src/services/hgcashService');
const pdfImage = require('./src/services/pdfImageService');
const { generateReferralCode } = require('./src/utils/referralCode');

// (b) Ruta pública (antes del static / donde estén las rutas públicas; no usa middlewares):
// #168 Link de referido: /linkreferido?ref=CODE → /?ref=CODE (la PWA lee ?ref= en la raíz).
// Antes el link se armaba con https://vipcargas.com/linkreferido (dominio del hermano y ruta
// inexistente): ahora sale de PUBLIC_BASE_URL y esta ruta cubre los links viejos.
app.get('/linkreferido', (req, res) => {
  const ref = String(req.query.ref || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toUpperCase();
  res.redirect(302, '/?ref=' + encodeURIComponent(ref));
});

// (c) Carga del % plano desde Config al arrancar y cada 60 s (multi-instancia). Acá vive dentro de
//     `_loadAiConfigIntoService`; si el destino no tiene una función así, usar esta y llamarla en el
//     bootstrap (después de connectDB) y en un setInterval de 60 s:
async function _loadReferralRateFromConfig() {
    // #169: % de comisión de referidos editable en COMANDOS (Config['referralRate'] = { rate }).
    try { const rr = (await getConfig('referralRate', null)) || {}; setGlobalReferralRate(rr.rate != null ? rr.rate : null); } catch (_) {}
}

// (d) Endpoints del % PLANO (admin general). ⚠️ TDZ: después de `const authMiddleware/adminMiddleware`.
//     Usan getConfig/setConfig(key, value) de Config y logger.
// #169 % de comisión de referidos (global). GET admin general; POST admin general.
app.get('/api/admin/referral-rate', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin general' });
    res.json({ rate: getGlobalReferralRate(), percent: Math.round(getGlobalReferralRate() * 1000) / 10 });
  } catch (e) { res.status(500).json({ error: 'Error del servidor' }); }
});
app.post('/api/admin/referral-rate', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin general' });
    const pct = Number(req.body && req.body.percent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 50) return res.status(400).json({ error: 'El porcentaje tiene que ser un número entre 0 y 50' });
    const rate = Math.round(pct * 10) / 1000;
    await setConfig('referralRate', { rate, updatedBy: req.user.username, updatedAt: new Date() });
    setGlobalReferralRate(rate);
    logger.info(`[referrals] % de comisión cambiado a ${pct}% por ${req.user.username}`);
    res.json({ rate, percent: Math.round(rate * 1000) / 10 });
  } catch (e) { res.status(500).json({ error: 'Error del servidor' }); }
});
