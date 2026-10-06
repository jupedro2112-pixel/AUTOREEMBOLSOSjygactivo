// ============================================================================
// 2) server.js — BLOQUE '#168 REFERIDOS' completo: dashboard del cliente, config de niveles (#171), netwin por referido para el admin (#175)
// Extraído de AUTOREEMBOLSOSjygactivo/server.js (commit 3860f83, 2026-10-06). Pegar tal cual
// salvo lo indicado en README.md.
// ============================================================================

// Rutas: GET /api/referrals/dashboard · POST /api/referrals/milestones/claim (410) · GET/POST
// /api/admin/referrals/milestones-config · GET /api/admin/referrals/:userId/netwin.
// ⚠️ TDZ: pegar DESPUÉS de authMiddleware/adminMiddleware/sensitiveLimiter. Dependencias en README.

// ============================================
// #168 REFERIDOS — tablero vivo, premios por cantidad y link propio
// ============================================
// Pedido del encargado (2026-09-28): que los referidos se VEAN (popup al entrar + card en
// el home), que el cliente vea en vivo cuántos referidos trajo, cuánto cargaron, su
// pérdida neta y la comisión que va a cobrar, y un premio EXTRA por cantidad de
// referidos que cargaron (3/5/10…), cobrable en fichas sin condiciones, en su propia
// fecha (no la del reembolso mensual). Total transparencia: montos variables explicados.
// #171 (owner 2026-09-29): los premios en PLATA por cantidad de referidos (#168) se
// reemplazan por NIVELES de % de comisión sobre el netwin: 3 activos → 1%, 5 → 2%, 10 → 3%
// (máximo), editable en el panel. Motivo: 3 cuentas × $3.000 puestos = $10.000 retirables
// (estafa directa). Con % del netwin, sin pérdida real no hay premio. Lógica en
// src/services/referralTierService.js (la usan el cálculo mensual, el dashboard y el controller).
const REFERRAL_NON_BANK_SOURCES = referralTiers.NON_BANK_SOURCES;
async function getReferralMilestonesConfig() { return referralTiers.getReferralTiersConfig(); }
// Cache del NETWIN del mes por referido (1 llamada a JUGAYGANA por referido con cargas).
const _refNetwinCache = new Map(); // key userId → { at, ggr }
const REF_NETWIN_TTL_MS = 15 * 60 * 1000;
async function _referralNetwinMonth(u, range) {
  const hit = _refNetwinCache.get(u.id);
  if (hit && Date.now() - hit.at < REF_NETWIN_TTL_MS) return hit.ggr;
  let ggr = null;
  try {
    let jgId = u.jugayganaUserId || null;
    if (!jgId) { try { jgId = await resolveJugayganaUserId(u.id, u.username); } catch (_) {} }
    if (jgId) {
      const r = await referralRevenueService.getUserNetwinForDateRange(u.username, jgId, range.from, range.to, 'ref-dashboard');
      if (r && r.success) ggr = Number(r.totalGgr) || 0;
    }
  } catch (_) {}
  if (ggr !== null) _refNetwinCache.set(u.id, { at: Date.now(), ggr });
  return ggr;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of _refNetwinCache) if (now - v.at > REF_NETWIN_TTL_MS * 2) _refNetwinCache.delete(k); }, 10 * 60 * 1000).unref();

// Dominio del link: PUBLIC_BASE_URL si está seteada; si no, el host del request (así en Render
// el link apunta a Render y en EB a autoreembolsos.com, sin tocar config). Ver _publicBaseUrlFromRequest.
function _referralLinkFor(code, req) {
  let base = '';
  try { base = req ? _publicBaseUrlFromRequest(req) : ''; } catch (_) {}
  if (!base) base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') || 'https://autoreembolsos.com';
  return base + '/?ref=' + encodeURIComponent(code);
}
async function _ensureReferralCode(user) {
  if (user.referralCode) return user.referralCode;
  for (let i = 0; i < 10; i++) {
    const cand = generateReferralCode();
    if (await User.findOne({ referralCode: cand }).select('_id').lean()) continue;
    const upd = await User.findOneAndUpdate({ id: user.id, referralCode: null }, { $set: { referralCode: cand } }, { new: true }).lean();
    if (upd && upd.referralCode) return upd.referralCode;
    const re = await User.findOne({ id: user.id }).select('referralCode').lean();
    if (re && re.referralCode) return re.referralCode;
  }
  return null;
}
function _artDayOfMonth() { return Number(new Date().toLocaleString('en-US', { day: 'numeric', timeZone: 'America/Argentina/Buenos_Aires' })); }

// Tablero del referidor: link, totales, tabla por referido y NIVEL de comisión (#171).
app.get('/api/referrals/dashboard', authMiddleware, async (req, res) => {
  try {
    const user = await User.findOne({ id: req.user.userId }).lean();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const code = await _ensureReferralCode(user);
    const cfg = await getReferralMilestonesConfig();
    const refs = await User.find({ referredByUserId: user.id }).sort({ createdAt: -1 }).select('id username createdAt jugayganaUserId isBlocked').lean();
    const depBy = await referralTiers.depositsByReferred(user.id);
    const activeCount = Array.from(depBy.values()).filter(v => v.total >= cfg.minChargedARS).length;
    const lv = await referralTiers.resolveReferralRate(user, { activeCount });
    const rate = lv.rate;
    const range = jugaygana.getCurrentMonthToDateRangeArgentinaEpoch();
    const monthRange = { from: new Date(range.fromEpoch * 1000), to: new Date(range.toEpoch * 1000) };
    // NETWIN del mes solo para los que cargaron (los demás no tienen juego). Concurrencia 4, tope 60.
    const withDeposits = refs.filter(r => depBy.has(r.id)).slice(0, 60);
    const netBy = new Map();
    for (let i = 0; i < withDeposits.length; i += 4) {
      const chunk = withDeposits.slice(i, i + 4);
      const vals = await Promise.all(chunk.map(u => _referralNetwinMonth(u, monthRange)));
      chunk.forEach((u, k) => netBy.set(u.id, vals[k]));
    }
    const rows = refs.map(r => {
      const d = depBy.get(r.id);
      const total = d ? d.total : 0;
      const net = netBy.has(r.id) ? netBy.get(r.id) : (d ? null : 0);
      const netPos = net === null ? null : Math.max(0, net);
      return {
        username: r.username, registeredAt: r.createdAt, blocked: !!r.isBlocked,
        charges: d ? d.count : 0, totalCharged: total, lastChargeAt: d ? d.last : null,
        active: !!d, qualified: total >= cfg.minChargedARS && !!d,
        netLossMonth: net, commissionMonth: netPos === null ? null : Math.round(netPos * rate)
      };
    });
    const sumNet = rows.reduce((a, r) => a + (r.netLossMonth === null ? 0 : Math.max(0, r.netLossMonth)), 0);
    const periodKey = _periodKey.getCurrentPeriodKey();
    // Total histórico acreditado por comisiones (+ premios viejos #168 si los hubo).
    const credited = await Transaction.aggregate([
      { $match: { userId: user.id, status: 'completed', $or: [{ type: 'referral_commission' }, { type: 'bonus', 'metadata.source': 'referral_milestone' }] } },
      { $group: { _id: '$type', total: { $sum: '$amount' } } }
    ]);
    const hist = {}; for (const c of credited) hist[c._id] = c.total;
    const tiers = cfg.tiers.map(t => ({ count: t.count, pct: t.pct, reached: activeCount >= t.count, current: !!(lv.tier && lv.tier.count === t.count) }));
    res.json({
      success: true,
      referralCode: code, referralLink: code ? _referralLinkFor(code, req) : null, rate,
      period: { key: periodKey, label: _periodKey.getPeriodLabel(periodKey), nextCredit: `Primer día hábil de ${_periodKey.getNextPeriodLabel(periodKey)}` },
      totals: { referred: rows.length, active: rows.filter(r => r.active).length, qualified: activeCount, totalCharged: rows.reduce((a, r) => a + r.totalCharged, 0),
        netLossMonth: Math.round(sumNet), commissionMonth: Math.round(sumNet * rate), netwinPartial: rows.some(r => r.active && r.netLossMonth === null),
        historicalCommission: Math.round(hist.referral_commission || 0), historicalMilestones: Math.round(hist.bonus || 0) },
      referrals: rows,
      // #171 nivel de comisión según referidos activos (cargaron ≥ minChargedARS).
      level: { enabled: cfg.enabled, mode: lv.mode, minChargedARS: cfg.minChargedARS, basePct: cfg.basePct, active: activeCount, pct: lv.pct, maxPct: lv.maxPct,
        tiers, currentTier: lv.tier ? { count: lv.tier.count, pct: lv.tier.pct } : null, nextTier: lv.nextTier ? { count: lv.nextTier.count, pct: lv.nextTier.pct, missing: lv.missing } : null,
        maxCount: cfg.tiers.length ? cfg.tiers[cfg.tiers.length - 1].count : 0 }
    });
  } catch (error) {
    logger.error(`[referrals] dashboard: ${error.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// #171: los premios en plata por hitos se discontinuaron (eran estafables). El endpoint queda
// cerrado para clientes con la app vieja cacheada. El historial en ReferralMilestoneClaim se conserva.
app.post('/api/referrals/milestones/claim', authMiddleware, sensitiveLimiter, async (req, res) => {
  res.status(410).json({ error: 'Los premios en plata por referidos se reemplazaron por niveles de comisión: cuantos más referidos activos, más % cobrás. Actualizá la app.' });
});

// Config de niveles de comisión por referidos activos (admin general) — #171.
app.get('/api/admin/referrals/milestones-config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin general' });
    const cfg = await referralTiers.getReferralTiersConfig({ force: true });
    res.json(Object.assign({}, cfg, { flatPct: Math.round(getGlobalReferralRate() * 10000) / 100 }));
  } catch (e) { res.status(500).json({ error: 'Error del servidor' }); }
});
app.post('/api/admin/referrals/milestones-config', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin general' });
    const b = req.body || {};
    const rawTiers = Array.isArray(b.tiers) ? b.tiers : [];
    for (const t of rawTiers) {
      const pct = Number(t && t.pct);
      if (!(Number.isFinite(pct) && pct > 0 && pct <= 50)) return res.status(400).json({ error: 'Cada nivel necesita un % entre 0,01 y 50' });
    }
    const tiers = referralTiers.normalizeTiers(rawTiers);
    if (!tiers.length) return res.status(400).json({ error: 'Cargá al menos un nivel (cantidad de referidos activos + %)' });
    const counts = rawTiers.map(t => Math.round(Number(t.count) || 0)).filter(c => c > 0);
    if (new Set(counts).size !== counts.length) return res.status(400).json({ error: 'Hay una cantidad de referidos repetida' });
    for (let i = 1; i < tiers.length; i++) if (tiers[i].pct < tiers[i - 1].pct) return res.status(400).json({ error: 'El % tiene que subir (o mantenerse) con más referidos' });
    const basePct = Number(b.basePct);
    if (!(Number.isFinite(basePct) && basePct >= 0 && basePct <= 50)) return res.status(400).json({ error: '% base inválido (0 a 50)' });
    if (basePct > tiers[0].pct) return res.status(400).json({ error: 'El % base no puede superar al del primer nivel' });
    const next = { enabled: b.enabled !== false, minChargedARS: Math.max(0, Math.round(Number(b.minChargedARS) || 0)), basePct: Math.round(basePct * 100) / 100, tiers, updatedBy: req.user.username, updatedAt: new Date() };
    await setConfig('referralMilestones', next);
    referralTiers.invalidateCache();
    logger.info(`[referrals] niveles de comisión actualizados por ${req.user.username}: base ${next.basePct}% · ${tiers.map(t => t.count + '→' + t.pct + '%').join(', ')} · activo = cargó ≥ $${next.minChargedARS} · ${next.enabled ? 'ON' : 'OFF'}`);
    res.json(Object.assign({}, await referralTiers.getReferralTiersConfig({ force: true }), { flatPct: Math.round(getGlobalReferralRate() * 10000) / 100 }));
  } catch (e) { logger.warn(`[referrals] milestones-config POST: ${e.message}`); res.status(500).json({ error: 'Error del servidor' }); }
});

// #175 Netwin del MES EN VIVO de cada referido de un referidor (admin). Misma fuente y mismo
// cache (15 min) que el tablero del cliente (_referralNetwinMonth → royalty-statistics). Sólo
// consulta a los referidos con cargas reales (los demás no tienen juego); concurrencia 4, tope 80.
// Va separado del detalle (referralController.adminGetUserReferrals) para que el detalle cargue
// al instante y el netwin llegue después, aunque JUGAYGANA esté lento.
app.get('/api/admin/referrals/:userId/netwin', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const referrer = await User.findOne({ id: String(req.params.userId || '') }).lean();
    if (!referrer) return res.status(404).json({ error: 'Referidor no encontrado' });
    const cfg = await getReferralMilestonesConfig();
    const refs = await User.find({ referredByUserId: referrer.id }).select('id username jugayganaUserId').lean();
    const depBy = await referralTiers.depositsByReferred(referrer.id);
    const activeCount = Array.from(depBy.values()).filter(v => v.total >= cfg.minChargedARS).length;
    const lv = await referralTiers.resolveReferralRate(referrer, { activeCount });
    const range = jugaygana.getCurrentMonthToDateRangeArgentinaEpoch();
    const monthRange = { from: new Date(range.fromEpoch * 1000), to: new Date(range.toEpoch * 1000) };
    const withDeposits = refs.filter(r => depBy.has(r.id)).slice(0, 80);
    const netBy = new Map();
    for (let i = 0; i < withDeposits.length; i += 4) {
      const chunk = withDeposits.slice(i, i + 4);
      const vals = await Promise.all(chunk.map(u => _referralNetwinMonth(u, monthRange)));
      chunk.forEach((u, k) => netBy.set(u.id, vals[k]));
    }
    const rows = refs.map(r => {
      const has = depBy.has(r.id);
      const net = netBy.has(r.id) ? netBy.get(r.id) : (has ? null : 0); // null = no se pudo leer
      return { userId: r.id, username: r.username, netwinMonth: net, commissionMonth: net === null ? null : Math.round(Math.max(0, net) * lv.rate) };
    });
    const sumNet = rows.reduce((a, r) => a + (r.netwinMonth === null ? 0 : Math.max(0, r.netwinMonth)), 0);
    res.json({ success: true, period: { key: _periodKey.getCurrentPeriodKey(), label: _periodKey.getPeriodLabel(_periodKey.getCurrentPeriodKey()) },
      rate: lv.rate, pct: lv.pct, mode: lv.mode, active: activeCount,
      totals: { netwinMonth: Math.round(sumNet), commissionMonth: Math.round(sumNet * lv.rate), partial: rows.some(r => r.netwinMonth === null), skipped: Math.max(0, refs.filter(r => depBy.has(r.id)).length - withDeposits.length) },
      referrals: rows });
  } catch (e) {
    logger.warn(`[referrals] admin netwin ${req.params.userId}: ${e.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});
