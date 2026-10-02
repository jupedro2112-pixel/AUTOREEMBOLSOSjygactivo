// ============================================================================
// 2) BONO DE CARGA (PromoBonus): bono vigente del usuario + cartel del agente + marcar usado
// Extraído de AUTOREEMBOLSOSjygactivo/server.js (commit fd653ca, 2026-10-02). Pegar tal cual
// salvo lo indicado en README.md.
// ============================================================================

// Rutas: GET /api/promo-bonus/mine (cliente), GET /api/admin/promo-bonus?username= (cartel del chat,
// devuelve capTxt #172), POST /api/admin/promo-bonus/:id/use (marcar usado / cancelar).
// ⚠️ TDZ: pegar DESPUÉS de `const authMiddleware` / `adminMiddleware`.
// Dependencias: PromoBonus (modelo), _loteCapTxt (archivo 01), logger.

const PromoBonus = require('./src/models/PromoBonus');

// ============================================================================
// BONO DE CARGA (PromoBonus) — bonificación vigente activada por notificación.
// ============================================================================

// Devuelve el bono de carga vigente de un usuario (o null). Vigente =
// status 'active' y no vencido. De paso vence los que pasaron su ventana.
async function _getActivePromoBonus(username, opts = {}) {
  const u = String(username || '').toLowerCase();
  if (!u) return null;
  const now = new Date();
  await PromoBonus.updateMany(
    { username: u, status: 'active', expiresAt: { $lte: now } },
    { $set: { status: 'expired' } }
  ).catch(() => {});
  // Por default sólo bonos de carga (percent > 0). opts.includeFixed=true (lo
  // pasa el endpoint ADMIN) suma los regalos de $ fijo de los LOTES (#149): el
  // agente los ve en el cartel verde y los marca usados igual que un %.
  const cond = opts.includeFixed
    ? { $or: [{ percent: { $gt: 0 } }, { montoFijoARS: { $gt: 0 } }] }
    : { percent: { $gt: 0 } };
  const b = await PromoBonus.findOne({ username: u, status: 'active', expiresAt: { $gt: now }, ...cond })
    .sort({ activatedAt: -1 })
    .lean();
  if (!b) return null;
  // Tope de LECTURA (decisión owner 2026-07-08): los bonos AUTOMÁTICOS están
  // capeados a 30%. Los bonos de LOTE (sourceRuleCode 'lote') están EXENTOS:
  // los configura un agente a mano.
  if (!['lote', 'ruleta'].includes(b.sourceRuleCode) && Number(b.percent) > 30) b.percent = 30;
  return b;
}

// GET /api/promo-bonus/mine — el usuario ve su bonificación vigente.
app.get('/api/promo-bonus/mine', authMiddleware, async (req, res) => {
  try {
    const b = await _getActivePromoBonus(req.user.username);
    if (!b) return res.json({ bonus: null });
    res.json({
      bonus: { percent: b.percent, activatedAt: b.activatedAt, expiresAt: b.expiresAt }
    });
  } catch (err) {
    logger.error(`/api/promo-bonus/mine: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/promo-bonus?username=X — el agente ve el bono vigente del
// cliente con el que está hablando en el chat.
app.get('/api/admin/promo-bonus', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const username = String(req.query.username || '').trim();
    if (!username) return res.status(400).json({ error: 'Falta username' });
    const b = await _getActivePromoBonus(username, { includeFixed: true });
    if (!b) return res.json({ bonus: null });
    res.json({
      bonus: {
        id: b.id,
        percent: b.percent,
        montoFijoARS: b.montoFijoARS || 0,
        activatedAt: b.activatedAt,
        expiresAt: b.expiresAt,
        sourceRuleCode: b.sourceRuleCode,
        sourceRuleName: b.sourceRuleName,
        // #149: bonos de lote AUTOMÁTICOS (los aplica el sistema en la carga)
        autoApply: b.autoApply === true,
        applyScope: b.applyScope || 'first',
        applyFromMin: b.applyFromMin == null ? null : b.applyFromMin,
        applyToMin: b.applyToMin == null ? null : b.applyToMin,
        usesCount: b.usesCount || 0,
        rolloverX: b.rolloverX == null ? null : b.rolloverX,
        capTxt: Number(b.percent) > 0 ? _loteCapTxt(b.percent, await getHgcashAppBonusConfig()) : '' // #172
      }
    });
  } catch (err) {
    logger.error(`/api/admin/promo-bonus: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/admin/promo-bonus/:id/use — el agente marca el bono como usado
// (se aplicó en una carga). Vale por 1 sola carga: queda consumido.
app.post('/api/admin/promo-bonus/:id/use', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const b = await PromoBonus.findOneAndUpdate(
      { id, status: 'active' },
      { $set: { status: 'used', usedBy: req.user.username || null, usedAt: new Date() } },
      { new: true }
    );
    if (!b) return res.status(404).json({ error: 'Bono no encontrado o ya consumido' });
    logger.info(`[promo-bonus] ${b.username} bono ${b.percent}% marcado usado por ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`/api/admin/promo-bonus/:id/use: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});
