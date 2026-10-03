// ============================================================================
// 3) BLOQUE COMPLETO 'LOTES DE NOTIFICACIONES CON REGALO' (#149 + #172 + #173 + #177)
// Extraído de AUTOREEMBOLSOSjygactivo/server.js (commit 714dd04, 2026-10-03). Pegar tal cual
// salvo lo indicado en README.md.
// ============================================================================

// Contiene: franja horaria (_argMinuteOfDay/_inDailyWindow), claim/revert/settle del % automático,
// audiencias (lista / segmento / todos / código público), topes anti-abuso de fichas, motor de envío
// reanudable multi-instancia (cron 45 s), activación del PromoBonus (vence a useHours tras canje),
// fichas tras el claim (_notifBatchFichasAfterClaim), canje de código (_tryClaimNotifBatchCode) y las rutas:
//   POST /api/admin/notif-batches/preview · POST /api/admin/notif-batches · GET /api/admin/notif-batches
//   GET /api/admin/notif-batches/:id · POST /api/gift-code/claim · GET /api/gift/pending · POST /api/gift/claim (#177)
// ⚠️ TDZ: pegar DESPUÉS de authMiddleware/adminMiddleware/authLimiter (ver README §Dependencias).

// ============================================================================
// LOTES DE NOTIFICACIONES CON REGALO (NotifBatch) — #149, portado de PAUTANUEVA
// (#160/#169/#263 de aquel repo). Un agente manda una notificación a una LISTA
// de usuarios con regalo: % en la carga (AUTOMÁTICO: se suma solo en la carga
// manual sin bonus del agente o en la carga hgcash, en la 1ª carga o en todas,
// con franja horaria opcional; o "lo aplica el agente": cartel verde + marcar
// usado) o fichas (se acreditan solas). Modo 'code' (solo los del lote pueden
// canjear) o 'window' (bono activado a todos por N horas). El bono es un
// PromoBonus con sourceRuleCode='lote'.
// ============================================================================
// BONO DE LOTE AUTOMÁTICO (#149, portado de PAUTANUEVA #263) — % de un "Lote con regalo"
// que se aplica SOLO en la carga (sin cartel que marcar), con el mismo contrato
// que los % de ruleta: reserva atómica antes de cargar, reversión si la carga
// falla. Vive en PromoBonus (autoApply:true):
//  - applyScope 'first' → vale UNA carga: active→used al reservar.
//  - applyScope 'all'   → vale TODAS las cargas hasta vencer: queda active y
//    solo se incrementa usesCount (la reversión lo decrementa).
//  - applyFromMin/ToMin → franja horaria DIARIA (hora argentina) en la que se
//    aplica; fuera de la franja la carga entra sin el bono y el bono sigue vivo.
function _argMinuteOfDay(date) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(date || new Date());
    const h = Number((parts.find((x) => x.type === 'hour') || {}).value) % 24;
    const m = Number((parts.find((x) => x.type === 'minute') || {}).value);
    return h * 60 + m;
  } catch (_) { const d = date || new Date(); return d.getHours() * 60 + d.getMinutes(); }
}
function _inDailyWindow(fromMin, toMin, date) {
  if (fromMin == null || toMin == null) return true;
  const m = _argMinuteOfDay(date);
  if (fromMin === toMin) return true; // franja de 24h
  // #172: el minuto HASTA es inclusive ("de 18:50 a 18:52" vale durante todo el 18:52).
  return fromMin < toMin ? (m >= fromMin && m <= toMin) : (m >= fromMin || m <= toMin);
}
function _fmtMinOfDay(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
// (En el hermano acá vivía _bonusMultiplierFor: JUGAYGANA no usa multiplicador de rollover en el crédito.)
async function claimAutoPromoPercent(user, usedBy) {
  try {
    const uname = String(user.username || '').toLowerCase();
    if (!uname) return { pct: 0, claimed: false };
    const now = new Date();
    const pb = await PromoBonus.findOne({
      username: uname, status: 'active', expiresAt: { $gt: now }, autoApply: true, percent: { $gt: 0 }
    }).sort({ activatedAt: -1 }).lean();
    if (!pb) return { pct: 0, claimed: false };
    if (!_inDailyWindow(pb.applyFromMin, pb.applyToMin, now)) return { pct: 0, claimed: false, outOfWindow: true };
    const scope = pb.applyScope === 'all' ? 'all' : 'first';
    let upd;
    if (scope === 'first') {
      upd = await PromoBonus.updateOne(
        { id: pb.id, status: 'active' },
        { $set: { status: 'used', usedBy: usedBy || 'auto', usedAt: now }, $inc: { usesCount: 1 } }
      );
    } else {
      upd = await PromoBonus.updateOne(
        { id: pb.id, status: 'active' },
        { $set: { usedBy: usedBy || 'auto', usedAt: now }, $inc: { usesCount: 1 } }
      );
    }
    if (!upd.modifiedCount) return { pct: 0, claimed: false };
    const label = `${pb.percent}% ${pb.sourceRuleName || 'lote'}` +
      (scope === 'all' ? ' (todas las cargas' + (pb.applyFromMin != null ? ` ${_fmtMinOfDay(pb.applyFromMin)}-${_fmtMinOfDay(pb.applyToMin)}` : '') + ')' : '');
    const rolloverX = (pb.rolloverX == null || !Number.isFinite(Number(pb.rolloverX))) ? null : Number(pb.rolloverX);
    return { pct: Number(pb.percent), claimed: true, id: pb.id, scope, label, usedBy: usedBy || 'auto', rolloverX };
  } catch (e) {
    logger.warn(`[promo-auto] claim % falló: ${e.message}`);
    return { pct: 0, claimed: false };
  }
}
async function revertAutoPromoPercent(claim) {
  try {
    if (!claim || !claim.claimed || !claim.id) return;
    if (claim.scope === 'first') {
      await PromoBonus.updateOne(
        { id: claim.id, status: 'used', usedBy: claim.usedBy },
        { $set: { status: 'active', usedBy: null, usedAt: null }, $inc: { usesCount: -1 } }
      );
    } else {
      await PromoBonus.updateOne({ id: claim.id }, { $inc: { usesCount: -1 } });
    }
  } catch (_) {}
}
// Tras una carga OK con el bono: registra la carga y el bono acreditado (ROI).
async function settleAutoPromoPercent(claim, amount, bonus) {
  try {
    if (!claim || !claim.claimed || !claim.id) return;
    await PromoBonus.updateOne(
      { id: claim.id },
      { $inc: { usesTotalBonus: Number(bonus) || 0, cargaMonto: Number(amount) || 0 } }
    );
  } catch (_) {}
}

const NotifBatch = require('./src/models/NotifBatch');

// Tope de sanidad, no de negocio: cubre "lote completo" con margen de sobra
// (hoy ~1.6k clientes). El envío es en segundo plano y reanudable, así que el
// tamaño no compromete nada.
const NOTIF_BATCH_MAX_RECIPIENTS = 20000;
const NOTIF_BATCH_SEND_ROLES = ['admin', 'depositor'];
const NOTIF_BATCH_VIEW_ROLES = ['admin', 'depositor', 'withdrawer'];

// Misma clasificación que el badge del chat (APP INSTALADA / NOTIS EN
// NAVEGADOR / NOTIS INACTIVAS): standalone en CUALQUIER token = app.
function _notifChannelOf(u) {
  const tokens = (u && u.fcmTokens) || [];
  const hasStandalone = tokens.some((t) => t && t.token && t.context === 'standalone') ||
    (u && u.fcmToken && u.fcmTokenContext === 'standalone');
  if (hasStandalone) return 'app';
  if (tokens.some((t) => t && t.token) || (u && u.fcmToken)) return 'browser';
  return 'none';
}

const NOTIF_BATCH_USER_SELECT = 'id username role isBlocked fcmToken fcmTokens fcmTokenContext notifPermission';

// Resuelve la lista de usernames del panel (case-insensitive) a usuarios
// reales. Devuelve { users, notFound, skipped } — skipped = bloqueados.
async function _resolveNotifBatchUsers(usernames) {
  const wanted = [...new Set((usernames || []).map((s) => String(s || '').trim()).filter(Boolean))];
  const found = wanted.length ? await User.find({ role: 'user', username: { $in: wanted } })
    .collation({ locale: 'en', strength: 2 })
    .select(NOTIF_BATCH_USER_SELECT).lean() : [];
  const byId = new Map();
  for (const u of found) if (!byId.has(u.id)) byId.set(u.id, u);
  const users = [...byId.values()].filter((u) => u.isBlocked !== true);
  const skipped = [...byId.values()].filter((u) => u.isBlocked === true).map((u) => u.username);
  const foundLower = new Set(found.map((u) => u.username.toLowerCase()));
  const notFound = wanted.filter((w) => !foundLower.has(w.toLowerCase()));
  return { users, notFound, skipped };
}

// Resuelve la AUDIENCIA del lote según el body del panel:
//  - 'list':     usernames pegados (default, compat con el flujo original).
//  - 'inactive': clientes sin login hace >= audienceDays (mismo criterio que
//                los segmentos del push masivo: lastLogin viejo o inexistente),
//                ordenados por lastLogin DESC (los "más frescos" primero — los
//                más probables de volver) y recortados a audienceLimit si se
//                pidió cupo (ej. "lote de 300 inactivos de 15 días").
//  - 'all':      lote completo — todos los clientes activos.
// Siempre excluye bloqueados. Devuelve además el descriptor de audiencia que
// se guarda en el lote para el historial.
// 'segment' (#263, owner 2026-09-04 — "filtrar más, no tanto lotes generales"):
//   segBase 'nologin'   = sin entrar hace ≥ N días (= 'inactive' de siempre)
//   segBase 'nodeposit' = cargaron alguna vez pero NO cargan hace ≥ N días
//                         (ex-cargadores: los que más vale recuperar)
//   segBase 'deposited' = cargaron en los últimos N días (activos / VIP)
//   + minDeposits (cargas históricas ≥), minTotalArs ($ histórico ≥),
//     campaign (código de publicista), audienceLimit (cupo).
// Las cargas salen de Transaction (permanente), excluyendo devoluciones de
// retiro. Devuelve además audienceLabel legible para el historial.
async function _notifBatchDepositStats() {
  const rows = await Transaction.aggregate([
    { $match: { type: 'deposit', 'metadata.source': { $ne: 'payout_refund' } } },
    { $group: { _id: '$userId', last: { $max: '$timestamp' }, count: { $sum: 1 }, total: { $sum: '$amount' } } }
  ]);
  const m = new Map();
  for (const r of rows) if (r._id) m.set(String(r._id), { last: r.last, count: r.count, total: r.total });
  return m;
}
function _segmentLabel(f, days, limit) {
  const base = f.segBase === 'nodeposit' ? `💸 sin cargar ≥${days}d`
    : f.segBase === 'deposited' ? `🔥 cargaron en los últimos ${days}d`
    : `😴 sin entrar ≥${days}d`;
  const extras = [];
  if (f.minDeposits > 0) extras.push(`≥${f.minDeposits} cargas`);
  if (f.minTotalArs > 0) extras.push(`≥$${Number(f.minTotalArs).toLocaleString('es-AR')} cargados`);
  if (f.campaign) extras.push(`publicista ${f.campaign}`);
  return base + (extras.length ? ' · ' + extras.join(' · ') : '') + (limit ? ` (cupo ${limit})` : '');
}
async function _resolveNotifBatchSegment(b) {
  const days = Math.round(Number(b.audienceDays));
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return { error: 'Los días tienen que estar entre 1 y 365.' };
  }
  let limit = b.audienceLimit == null || b.audienceLimit === '' ? null : Math.round(Number(b.audienceLimit));
  if (limit != null && (!Number.isFinite(limit) || limit < 1 || limit > NOTIF_BATCH_MAX_RECIPIENTS)) {
    return { error: `El cupo tiene que estar entre 1 y ${NOTIF_BATCH_MAX_RECIPIENTS} (o vacío = sin cupo).` };
  }
  const segBase = ['nologin', 'nodeposit', 'deposited'].includes(b.segBase) ? b.segBase : 'nologin';
  const minDeposits = (b.minDeposits == null || b.minDeposits === '') ? 0 : Math.round(Number(b.minDeposits));
  const minTotalArs = (b.minTotalArs == null || b.minTotalArs === '') ? 0 : Math.round(Number(b.minTotalArs));
  if (!Number.isFinite(minDeposits) || minDeposits < 0 || minDeposits > 100000) return { error: 'Mínimo de cargas inválido.' };
  if (!Number.isFinite(minTotalArs) || minTotalArs < 0 || minTotalArs > 1e9) return { error: 'Mínimo de $ cargados inválido.' };
  const campaign = String(b.campaign || '').trim().slice(0, 60);
  const f = { segBase, minDeposits, minTotalArs, campaign };
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const q = { role: 'user', isBlocked: { $ne: true } };
  if (segBase === 'nologin') q.$or = [{ lastLogin: { $lt: cutoff } }, { lastLogin: { $exists: false } }];
  if (campaign) q.acquisitionCampaign = new RegExp('^' + campaign.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  const needStats = segBase !== 'nologin' || minDeposits > 0 || minTotalArs > 0;
  const stats = needStats ? await _notifBatchDepositStats() : null;

  let users = await User.find(q).select(NOTIF_BATCH_USER_SELECT + ' lastLogin').lean();
  if (needStats) {
    const minCount = segBase === 'nodeposit' ? Math.max(1, minDeposits) : minDeposits;
    users = users.filter((u) => {
      const st = stats.get(String(u.id)) || { last: null, count: 0, total: 0 };
      if (st.count < minCount) return false;
      if (st.total < minTotalArs) return false;
      if (segBase === 'nodeposit' && !(st.last && st.last < cutoff)) return false;
      if (segBase === 'deposited' && !(st.last && st.last >= cutoff)) return false;
      u._st = st;
      return true;
    });
  }
  // Orden: los "más frescos" primero (más probables de volver); en cargadores
  // recientes, los que más pusieron primero.
  if (segBase === 'nologin') users.sort((a, b2) => new Date(b2.lastLogin || 0) - new Date(a.lastLogin || 0));
  else if (segBase === 'nodeposit') users.sort((a, b2) => new Date(b2._st.last) - new Date(a._st.last));
  else users.sort((a, b2) => (b2._st.total || 0) - (a._st.total || 0));
  users = users.slice(0, limit || NOTIF_BATCH_MAX_RECIPIENTS);
  for (const u of users) delete u._st;
  return {
    users, notFound: [], skipped: [],
    audience: { audienceType: 'segment', audienceDays: days, audienceLimit: limit, audienceFilter: f, audienceLabel: _segmentLabel(f, days, limit) }
  };
}

async function _resolveNotifBatchAudience(b) {
  if (b.audienceType === 'segment') return _resolveNotifBatchSegment(b);
  const type = (b.audienceType === 'inactive' || b.audienceType === 'all') ? b.audienceType : 'list';
  if (type === 'list') {
    const usernames = Array.isArray(b.usernames) ? b.usernames : [];
    if (!usernames.length) return { error: 'Pegá al menos un username.' };
    if (usernames.length > NOTIF_BATCH_MAX_RECIPIENTS) return { error: `Máximo ${NOTIF_BATCH_MAX_RECIPIENTS} usuarios por lote.` };
    const r = await _resolveNotifBatchUsers(usernames);
    return { ...r, audience: { audienceType: 'list', audienceDays: null, audienceLimit: null } };
  }
  if (type === 'all') {
    const users = await User.find({ role: 'user', isBlocked: { $ne: true } })
      .limit(NOTIF_BATCH_MAX_RECIPIENTS)
      .select(NOTIF_BATCH_USER_SELECT).lean();
    return { users, notFound: [], skipped: [], audience: { audienceType: 'all', audienceDays: null, audienceLimit: null } };
  }
  // inactive
  const days = Math.round(Number(b.audienceDays));
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return { error: 'Los días de inactividad tienen que estar entre 1 y 365.' };
  }
  let limit = b.audienceLimit == null || b.audienceLimit === '' ? null : Math.round(Number(b.audienceLimit));
  if (limit != null && (!Number.isFinite(limit) || limit < 1 || limit > NOTIF_BATCH_MAX_RECIPIENTS)) {
    return { error: `El cupo tiene que estar entre 1 y ${NOTIF_BATCH_MAX_RECIPIENTS} (o vacío = sin cupo).` };
  }
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const users = await User.find({
    role: 'user', isBlocked: { $ne: true },
    $or: [{ lastLogin: { $lt: cutoff } }, { lastLogin: { $exists: false } }]
  })
    .sort({ lastLogin: -1 })
    .limit(limit || NOTIF_BATCH_MAX_RECIPIENTS)
    .select(NOTIF_BATCH_USER_SELECT).lean();
  return { users, notFound: [], skipped: [], audience: { audienceType: 'inactive', audienceDays: days, audienceLimit: limit } };
}

// ============================================================
// ACREDITACIÓN AUTOMÁTICA de fichas de lote + candados anti-abuso
// ============================================================
// TODO regalo de FICHAS se acredita solo (owner 2026-08-10): por código al
// canjear, por tiempo al enviarse el lote. Para que "automático" no se vuelva
// fichas infinitas si alguien encuentra un bug, hay TOPES DUROS por usuario
// (independientes del lote): máx acreditaciones en 24hs y máx $ en 7 días,
// contados de las Transaction source 'notif_batch' (permanentes). Superar un
// tope BLOQUEA el crédito y dispara una ALERTA URGENTE: log ERROR, nota roja
// en el chat del usuario y aviso en vivo a todos los admins conectados
// (socket 'security_alert' → toast rojo en el panel).
const NOTIF_BATCH_USER_MAX_CREDITS_24H = 3;
const NOTIF_BATCH_USER_MAX_ARS_7D = 300000;

function _emitNotifBatchSecurityAlert(uDoc, detalle) {
  const msg = `🚨 URGENTE — POSIBLE ABUSO DE REGALOS DE LOTE: ${uDoc.username} ${detalle}. ` +
    `El crédito se BLOQUEÓ automáticamente. Revisar su historial de bonos antes de acreditarle nada a mano.`;
  logger.error(`[notif-batch][ALERTA] ${msg}`);
  _emitAdminOnlyChatNote(uDoc.id, uDoc.username, msg).catch(() => {});
  try {
    io.to('admins').emit('security_alert', { username: uDoc.username, message: msg, at: new Date() });
  } catch (_) { /* socket no disponible: quedan el log y la nota */ }
}

// Topes por usuario. Devuelve null si está OK, o el string del motivo.
async function _notifBatchCreditCapCheck(uDoc, amount) {
  const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const since24 = new Date(Date.now() - 24 * 3600 * 1000);
  const rows = await Transaction.aggregate([
    { $match: { type: 'bonus', 'metadata.source': 'notif_batch', userId: uDoc.id, timestamp: { $gte: since7d } } },
    { $group: {
      _id: null,
      count24: { $sum: { $cond: [{ $gte: ['$timestamp', since24] }, 1, 0] } },
      total7d: { $sum: '$amount' }
    } }
  ]);
  const r = rows[0] || { count24: 0, total7d: 0 };
  if (r.count24 >= NOTIF_BATCH_USER_MAX_CREDITS_24H) {
    return `ya recibió ${r.count24} regalos de lote en 24hs (tope ${NOTIF_BATCH_USER_MAX_CREDITS_24H})`;
  }
  if (r.total7d + amount > NOTIF_BATCH_USER_MAX_ARS_7D) {
    return `acumularía $${(r.total7d + amount).toLocaleString('es-AR')} en regalos de lote en 7 días (tope $${NOTIF_BATCH_USER_MAX_ARS_7D.toLocaleString('es-AR')})`;
  }
  return null;
}

// Acredita el regalo de fichas de un lote a un usuario, con TODOS los guards.
// Devuelve { ok:true, txId } o { ok:false, reason, blocked, retryable }:
//  - blocked=true → tope de seguridad (alerta ya emitida) o bono activo.
//  - retryable=true → fallo transitorio (API caída): se puede reintentar.
// Idempotente: reference vip-nbatch-{batchId}-{userId} — reintentar tras un
// fallo FALSO da duplicate:true en la plataforma, jamás doble pago.
async function _creditNotifBatchGift(uDoc, batch) {
  const capMsg = await _notifBatchCreditCapCheck(uDoc, batch.amount);
  if (capMsg) {
    _emitNotifBatchSecurityAlert(uDoc, capMsg);
    return { ok: false, blocked: true, reason: 'tope de seguridad' };
  }
  // JUGAYGANA: individual_bonus (misma llamada que el bonus de una carga manual).
  // ⚠️ No hay reference idempotente en esta API → ante un fallo AMBIGUO (timeout)
  // NO se reintenta solo: queda creditError "verificar" para que el agente mire
  // el saldo antes de acreditar a mano. Nunca doble pago automático.
  let credit;
  try {
    credit = await jugaygana.creditUserBalance(uDoc.username, batch.amount, uDoc.jugayganaUserId || null);
  } catch (e) {
    logger.warn(`[notif-batch] crédito de fichas EXCEPCIÓN para ${uDoc.username} (lote ${batch.id}): ${e.message}`);
    return { ok: false, retryable: false, reason: 'error de red — VERIFICAR en JUGAYGANA si entró antes de acreditar a mano' };
  }
  if (!credit || !credit.success) {
    const why = jugaygana.errToString((credit && credit.error) || 's/detalle');
    logger.warn(`[notif-batch] crédito de fichas falló para ${uDoc.username} (lote ${batch.id}): ${why}`);
    if (credit && credit.ambiguous) await _alertMoneyAmbiguous('Regalo de fichas (lote)', uDoc.id, uDoc.username, batch.amount, credit.error);
    return { ok: false, retryable: false, ambiguous: !!(credit && credit.ambiguous), reason: why };
  }
  const txId = (credit.data && (credit.data.transfer_id || credit.data.transferId)) || null;
  await Transaction.create({
    id: uuidv4(), type: 'bonus', userId: uDoc.id, username: uDoc.username,
    amount: batch.amount, description: `Regalo por notificación — lote de ${batch.sentBy}${batch.name ? ' ("' + batch.name + '")' : ''}`,
    transactionId: txId, metadata: { source: 'notif_batch', batchId: batch.id },
    timestamp: new Date()
  }).catch((e) => logger.warn(`[notif-batch] no se pudo guardar la Transaction: ${e.message}`));
  return { ok: true, txId };
}

// Texto que ve el cliente en el chat (el push lleva title + message pelado).
function _notifBatchChatContent(batch) {
  if (batch.mode === 'code') {
    // Fichas por código = acreditación AUTOMÁTICA al canjear; % = lo aplica
    // el agente en la próxima carga.
    const giftLabel = batch.giftType === 'fixed'
      ? `$${Number(batch.amount).toLocaleString('es-AR')} en fichas — se acreditan al instante cuando canjeás el código`
      : _giftLabelOf(batch);
    return `${batch.message}\n\n🎁 Tu regalo: ${giftLabel}.\n🔑 Tu código: ${batch.code}\nCanjealo desde el menú ☰ → "🎁 Reclamar Bono con Código". ⏰ Válido por ${batch.validHours}hs${batch.giftType === 'percent' ? ` y, una vez canjeado, tenés ${Number(batch.useHours) > 0 ? batch.useHours : 24}hs para usarlo en tu carga` : ''}.`;
  }
  // #177: fichas por tiempo CON RECLAMO → no hay nada acreditado todavía: que toque el botón.
  if (batch.giftType === 'fixed' && batch.claimRequired) {
    return `${batch.message}\n\n💰 Tenés $${Number(batch.amount).toLocaleString('es-AR')} en fichas de regalo esperándote.\n🎁 Para cobrarlas tocá RECLAMAR en el cartel del inicio de la app (o el botón 🎁 de arriba): se acreditan al instante en tu cuenta. ⏰ Tenés ${batch.validHours}hs para reclamarlo; después vence.`;
  }
  // #263: % automático → no hay que avisar a nadie; % viejo → avisar al agente.
  const como = (batch.giftType === 'percent' && batch.applyMode === 'auto')
    ? 'Se te suma SOLO cuando cargás, no tenés que avisar nada.'
    : 'Avisale al agente cuando cargues.';
  return `${batch.message}\n\n🎁 Tenés un ${_giftLabelOf(batch)}, ya activado. ${como}${_batchRolloverTxt(batch)} ⏰ Válido por ${batch.validHours}hs.`;
}

// ============================================================
// MOTOR DE ENVÍO de lotes — "que nunca falle" (owner 2026-08-10).
// ============================================================
// El envío NO vive en la request: los recipients quedan con delivery:null y
// este motor los procesa de a uno con CLAIM ATÓMICO ($elemMatch delivery:null
// → 'sending' con findOneAndUpdate). Garantías:
//  - Deploy/reinicio a mitad de un lote: el cron lo retoma donde quedó
//    (los 'sending' colgados >10 min se recuperan solos).
//  - Multi-instancia EB: dos instancias pueden procesar EL MISMO lote a la
//    vez sin duplicar a nadie (el claim es por destinatario; el que pierde
//    la carrera no matchea y pasa al siguiente).
//  - Cada destinatario recibe: PromoBonus (si el lote es modo window y aún
//    no lo tiene) + mensaje de chat + push/socket. Si el push falla queda
//    'error' registrado (el mensaje de chat le queda igual).
// Ritmo: pausa corta entre destinatarios para no saturar FCM/Mongo — un lote
// completo (~1.6k) tarda ~1-2 min en segundo plano.
const NOTIF_BATCH_STALE_SENDING_MS = 10 * 60 * 1000;
const NOTIF_BATCH_SEND_PAUSE_MS = 35;
let _notifBatchQueueRunning = false;

async function _processNotifBatchQueue() {
  if (_notifBatchQueueRunning) return; // guard por proceso (cada instancia corre el suyo)
  _notifBatchQueueRunning = true;
  try {
    const pendientes = await NotifBatch.find({ sendDone: { $ne: true } })
      .select('id').sort({ sentAt: 1 }).limit(20).lean();
    for (const p of pendientes) {
      await _processOneNotifBatch(p.id);
    }
  } catch (e) {
    logger.warn(`[notif-batch] motor: ${e.message}`);
  } finally {
    _notifBatchQueueRunning = false;
  }
}

async function _processOneNotifBatch(batchId) {
  const batch = await NotifBatch.findOne({ id: batchId }).select('-recipients').lean();
  if (!batch) return;
  const chatContent = _notifBatchChatContent(batch);
  const pushTitle = batch.title || '🎁 Tenés un regalo';
  const pushBody = String(batch.message || '').slice(0, 150);
  let procesados = 0;

  for (;;) {
    const stale = new Date(Date.now() - NOTIF_BATCH_STALE_SENDING_MS);
    // Claim atómico del PRÓXIMO pendiente (o un 'sending' colgado). La
    // proyección posicional devuelve el elemento matcheado (pre-update) →
    // sabemos a QUIÉN reclamamos sin traer los 20k recipients.
    const doc = await NotifBatch.findOneAndUpdate(
      { id: batchId, recipients: { $elemMatch: { $or: [
        { delivery: null },
        { delivery: 'sending', deliveryAt: { $lt: stale } }
      ] } } },
      { $set: { 'recipients.$.delivery': 'sending', 'recipients.$.deliveryAt': new Date() } },
      { new: false, projection: { id: 1, 'recipients.$': 1 } }
    ).lean();
    const rec = doc && doc.recipients && doc.recipients[0];
    if (!rec) break; // sin pendientes reclamables (puede quedar un 'sending' vivo en otra instancia)

    let delivery = 'error';
    let dejarEnSending = false; // fallo transitorio del crédito → reintento automático
    try {
      const u = await User.findOne({ id: rec.userId })
        .select('id username fcmToken fcmTokens jugayganaUserId').lean();
      if (u) {
        let mensajeChat = chatContent;
        let notificar = true;
        if (batch.mode === 'window' && batch.giftType === 'fixed' && !batch.claimRequired) {
          // FICHAS POR TIEMPO = acreditación AUTOMÁTICA al enviar (owner
          // 2026-08-10), con los mismos guards anti-abuso que el canje por
          // código. Idempotente ante retomes: si ya tiene creditedAt (claim
          // stale re-procesado) no se acredita de nuevo — y la reference fija
          // hace imposible el doble pago igual.
          if (rec.creditedAt) {
            // ya acreditado en un pase anterior: solo asegurar la notificación
          } else {
            const res2 = await _creditNotifBatchGift(u, batch);
            if (!res2.ok && res2.retryable) {
              // API caída/lenta: dejar el recipient EN 'sending' — el claim
              // vence a los 10 min y el motor lo reintenta solo (la reference
              // fija hace imposible pagar dos veces si en realidad entró).
              await NotifBatch.updateOne(
                { id: batchId, 'recipients.userId': u.id },
                { $set: { 'recipients.$.creditError': res2.reason || 'error transitorio' } }
              ).catch(() => {});
              dejarEnSending = true;
              notificar = false;
            } else if (!res2.ok) {
              // Bloqueo definitivo (tope de seguridad / bono activo): sin
              // crédito no se le promete nada — ni mensaje ni push.
              await NotifBatch.updateOne(
                { id: batchId, 'recipients.userId': u.id },
                { $set: { 'recipients.$.creditError': res2.reason || 'bloqueado', 'recipients.$.claimedAt': null } }
              ).catch(() => {});
              notificar = false;
            } else {
              await NotifBatch.updateOne(
                { id: batchId, 'recipients.userId': u.id },
                { $set: { 'recipients.$.creditedAt': new Date(), 'recipients.$.creditTxId': res2.txId, 'recipients.$.creditError': null } }
              ).catch(() => {});
            }
          }
          if (notificar) {
            const rollover = Math.max(0, Number(batch.rolloverX) || 0);
            const rollTxt = rollover > 0
              ? ` (bono con rollover x${rollover}: apostá ${rollover}× el monto y después podés retirar)`
              : '';
            mensajeChat = `${batch.message}\n\n💰 ¡Te ACREDITAMOS $${Number(batch.amount).toLocaleString('es-AR')} en fichas${rollTxt}! Ya están en tu cuenta. ¡A jugarlas! 🎰`;
          }
        } else if (batch.mode === 'window' && batch.giftType !== 'fixed' && !rec.promoBonusId) {
          // % por tiempo: cartel verde del agente (PromoBonus), como siempre.
          // (#177: las fichas con reclamo NO crean PromoBonus: se acreditan al reclamar.)
          const pb = await _activateBatchPromoBonus(u, batch);
          await NotifBatch.updateOne(
            { id: batchId, 'recipients.userId': u.id },
            { $set: { 'recipients.$.promoBonusId': pb.id } }
          ).catch(() => {});
        }
        if (notificar) {
          await Message.create({
            id: uuidv4(), senderId: 'system', senderUsername: 'Sistema', senderRole: 'admin',
            receiverId: u.id, receiverRole: 'user', content: mensajeChat,
            type: 'system', timestamp: new Date(), read: false
          });
          const r = await sendPushIfOffline(u, pushTitle, pushBody, batch.claimRequired ? { tag: 'notif-batch', giftClaim: batch.id } : { tag: 'notif-batch' });
          delivery = (r && r.delivery) || 'none';
        } else {
          delivery = 'none';
        }
      } else {
        delivery = 'error'; // usuario borrado entre el armado y el envío
      }
    } catch (e) {
      logger.warn(`[notif-batch] error notificando a ${rec.username}: ${e.message}`);
    }
    if (!dejarEnSending) {
      await NotifBatch.updateOne(
        { id: batchId, 'recipients.userId': rec.userId },
        { $set: { 'recipients.$.delivery': delivery, 'recipients.$.deliveryAt': new Date() } }
      ).catch(() => {});
    }
    procesados++;
    await new Promise((r) => setTimeout(r, NOTIF_BATCH_SEND_PAUSE_MS));
  }

  // ¿Terminó? Sin pendientes NI 'sending' (los vivos de otra instancia
  // también cuentan — el próximo pase del cron lo cierra).
  const queda = await NotifBatch.findOne({
    id: batchId,
    recipients: { $elemMatch: { $or: [{ delivery: null }, { delivery: 'sending' }] } }
  }).select('id').lean();
  if (!queda) {
    const done = await NotifBatch.updateOne(
      { id: batchId, sendDone: { $ne: true } },
      { $set: { sendDone: true } }
    );
    if (done.modifiedCount) {
      logger.info(`[notif-batch] lote ${batchId} COMPLETADO (${procesados} procesados en este pase)`);
    }
  } else if (procesados) {
    logger.info(`[notif-batch] lote ${batchId}: ${procesados} procesados en este pase, sigue en cola`);
  }
}

// Cron del motor: cada 45s retoma lo que haya quedado pendiente (arranques,
// deploys, lotes creados en la otra instancia). Idempotente por diseño.
setInterval(() => { _processNotifBatchQueue().catch(() => {}); }, 45000);

// Activa el PromoBonus de un lote para un usuario. Reemplaza (vence) el bono
// activo anterior — mismo criterio que el motor de reglas: UN cartel a la vez.
async function _activateBatchPromoBonus(user, batch) {
  const uname = String(user.username).toLowerCase();
  await PromoBonus.updateMany(
    { username: uname, status: 'active' },
    { $set: { status: 'expired' } }
  ).catch(() => {});
  return PromoBonus.create({
    id: uuidv4(),
    userId: user.id,
    username: uname,
    percent: batch.giftType === 'percent' ? batch.amount : 0,
    montoFijoARS: batch.giftType === 'fixed' ? batch.amount : 0,
    sourceRuleId: batch.id,
    sourceRuleCode: 'lote',
    sourceRuleName: `Lote de ${batch.sentBy}${batch.name ? ' — ' + batch.name : ''}`,
    activatedAt: new Date(),
    // #173: en modo código el bono vale `useHours` (24 h default) desde el CANJE, no hasta
    // que venza el lote. En modo 'window' (activado al enviar) sigue la vigencia del lote.
    expiresAt: batch.mode === 'code'
      ? new Date(Date.now() + (Number(batch.useHours) > 0 ? Number(batch.useHours) : 24) * 3600 * 1000)
      : batch.expiresAt,
    status: 'active',
    // #263: aplicación automática del % (solo giftType percent)
    autoApply: batch.giftType === 'percent' && batch.applyMode === 'auto',
    applyScope: batch.applyScope === 'all' ? 'all' : 'first',
    applyFromMin: batch.applyFromMin == null ? null : batch.applyFromMin,
    applyToMin: batch.applyToMin == null ? null : batch.applyToMin,
    // rollover propio del % automático (owner 2026-09-04: "que se use rollover
    // en bonus y evitamos cosas raras"); null = global
    rolloverX: (batch.giftType === 'percent' && batch.applyMode === 'auto' && Number.isFinite(Number(batch.rolloverX))) ? Number(batch.rolloverX) : null
  });
}

// Texto de la franja horaria del % automático ("de 18:00 a 23:00").
function _batchWindowTxt(batch) {
  if (batch.applyFromMin == null || batch.applyToMin == null) return '';
  return ` de ${_fmtMinOfDay(batch.applyFromMin)} a ${_fmtMinOfDay(batch.applyToMin)}`;
}

// Frase de rollover del % automático para el cliente ('' si no tiene).
function _batchRolloverTxt(batch) {
  if (batch.giftType !== 'percent' || batch.applyMode !== 'auto') return '';
  const r = Number(batch.rolloverX) || 0;
  return r > 0 ? ` El extra entra como bono con rollover x${r} (apostá ${r}× el bono y después podés retirar).` : '';
}
function _giftLabelOf(batch) {
  if (batch.giftType !== 'percent') {
    return `regalo de $${Number(batch.amount).toLocaleString('es-AR')} en tu próxima carga`;
  }
  const capTxt = batch.applyMode === 'auto' ? _loteCapTxt(batch.amount) : ''; // #172
  if (batch.applyMode === 'auto' && batch.applyScope === 'all') {
    return `+${batch.amount}% EXTRA en TODAS tus cargas${_batchWindowTxt(batch)}${capTxt}`;
  }
  return `+${batch.amount}% EXTRA en tu próxima carga${batch.applyMode === 'auto' ? _batchWindowTxt(batch) : ''}${capTxt}`;
}

// Canje de un código de LOTE. Devuelve null si el código no corresponde a
// ningún lote (el caller sigue con el código de bienvenida) o { http, body }.
// Exclusividad: el código solo sirve para quien está EN el lote; para el
// resto es "no válido" (sin revelar que existe).
// Fichas de un lote DESPUÉS de reservar el claim (una vez por usuario): acredita en JUGAYGANA,
// marca creditedAt, avisa al cliente y deja nota interna. Lo usan el canje por código y el
// reclamo con botón (#177). Devuelve { http, body }. Reglas de plata (#151): ambiguo = la
// reserva NO se libera (puede haber entrado) y se alerta; fallo limpio = se libera la reserva
// (público: se lo saca de recipients; lista: claimedAt vuelve a null) para que pueda reintentar.
async function _notifBatchFichasAfterClaim(uDoc, batch, { via, codeUp } = {}) {
  const montoFmt = Number(batch.amount).toLocaleString('es-AR');
  const esCodigo = via === 'code';
  const res2 = await _creditNotifBatchGift(uDoc, batch);
  if (!res2.ok && res2.ambiguous) {
    return { http: 502, body: { error: 'Tu regalo quedó en verificación (la plataforma no confirmó). Un agente lo revisa; no hace falta que vuelvas a reclamar.' } };
  }
  if (!res2.ok) {
    if (batch.isPublic) {
      await NotifBatch.updateOne({ id: batch.id }, { $pull: { recipients: { userId: uDoc.id, creditedAt: null } } }).catch(() => {});
    } else {
      await NotifBatch.updateOne(
        { id: batch.id, 'recipients.userId': uDoc.id },
        { $set: { 'recipients.$.claimedAt': null, 'recipients.$.creditError': res2.reason || null } }
      ).catch(() => {});
    }
    if (res2.blocked && res2.reason === 'bono activo en el casino') {
      return { http: 400, body: { error: `Tenés un bono activo (o sin reclamar) en el casino. Terminalo y después ${esCodigo ? 'canjeá tu código' : 'reclamá tu regalo'}.` } };
    }
    if (res2.blocked) {
      return { http: 400, body: { error: 'No pudimos acreditar tu regalo. Hablá con el soporte desde el chat.' } };
    }
    return { http: 502, body: { error: 'No pudimos acreditar el regalo en este momento. Probá de nuevo en unos minutos.' } };
  }
  await NotifBatch.updateOne(
    { id: batch.id, 'recipients.userId': uDoc.id },
    { $set: { 'recipients.$.creditedAt': new Date(), 'recipients.$.creditTxId': res2.txId, 'recipients.$.creditError': null } }
  ).catch(() => {});

  const rollover = Math.max(0, Number(batch.rolloverX) || 0);
  const rollTxt = rollover > 0 ? ` (bono con rollover x${rollover}: apostá ${rollover}× el monto y después podés retirar)` : '';
  const loteTxt = `lote de ${batch.sentBy}${batch.name ? ' ("' + batch.name + '")' : ''}`;
  await Message.create({
    id: uuidv4(), senderId: 'system', senderUsername: 'Sistema', senderRole: 'admin',
    receiverId: uDoc.id, receiverRole: 'user',
    content: esCodigo
      ? `🎉 ¡Código canjeado, ${uDoc.username}!\n\n💰 Tu regalo de $${montoFmt} ya está ACREDITADO en tu cuenta${rollTxt}. ¡A jugarlo! 🎰`
      : `🎉 ¡Regalo reclamado, ${uDoc.username}!\n\n💰 Tus $${montoFmt} ya están ACREDITADOS en tu cuenta${rollTxt}. ¡A jugarlos! 🎰`,
    type: 'system', timestamp: new Date(), read: false
  }).catch(() => {});
  await _emitAdminOnlyChatNote(
    uDoc.id, uDoc.username,
    `💰 REGALO DE LOTE ACREDITADO AUTOMÁTICAMENTE ($${montoFmt}${rollover > 0 ? ', rollover x' + rollover : ', sin rollover'}) — ${esCodigo ? 'canjeó el código del ' + loteTxt : 'lo RECLAMÓ con el botón 🎁 (' + loteTxt + ')'}. No hay que hacer nada: la plata ya está en su cuenta.`
  ).catch(() => {});
  logger.info(`[notif-batch] ${uDoc.username} ${esCodigo ? 'canjeó ' + codeUp : 'reclamó con botón'} (lote ${batch.id}) — $${batch.amount} acreditados automáticamente (rollover x${rollover})`);
  return {
    http: 200,
    body: {
      success: true, status: 'credited', amount: batch.amount, type: 'cash',
      message: esCodigo
        ? `¡Código válido! Tu regalo de $${montoFmt} ya está acreditado en tu cuenta. 🎰`
        : `¡Listo! Tus $${montoFmt} ya están acreditados en tu cuenta. 🎰`
    }
  };
}

async function _tryClaimNotifBatchCode(reqUser, attempt) {
  const codeUp = String(attempt).toUpperCase();
  const now = new Date();
  let batch = await NotifBatch.findOne({ mode: 'code', code: codeUp, expiresAt: { $gt: now } }).lean();
  if (!batch) {
    const vencido = await NotifBatch.findOne({ mode: 'code', code: codeUp }).select('id isPublic recipients.userId').lean();
    if (vencido && (vencido.isPublic || (vencido.recipients || []).some((r) => r.userId === reqUser.userId))) {
      return { http: 400, body: { error: '⏰ Este código ya venció. Estate atento a la próxima notificación.' } };
    }
    return null; // no es un código de lote (o no es de este usuario) → sigue el flujo normal
  }
  const rec = (batch.recipients || []).find((r) => r.userId === reqUser.userId);
  if (!batch.isPublic) {
    // Lote con destinatarios: EXCLUSIVO de los que están en la lista.
    if (!rec) {
      logger.warn(`[notif-batch] ${reqUser.username} intentó canjear el código ${codeUp} sin estar en el lote ${batch.id}`);
      return { http: 400, body: { error: 'Este código no es para tu cuenta: el lote se envió a otros usuarios.' } };
    }
    if (rec.claimedAt) {
      return { http: 400, body: { error: 'Ya canjeaste este código. Tu bono te lo aplica el agente en tu próxima carga (si todavía no venció).' } };
    }
  } else if (rec) {
    return { http: 400, body: { error: 'Ya canjeaste este código. Es una sola vez por cuenta.' } };
  }
  const uDoc = await User.findOne({ id: reqUser.userId }).select('id username role jugayganaUserId').lean();
  if (!uDoc || uDoc.role !== 'user') {
    return { http: 400, body: { error: 'Solo las cuentas de clientes pueden canjear códigos.' } };
  }
  const esFichas = batch.giftType === 'fixed';
  const montoFmt = Number(batch.amount).toLocaleString('es-AR');

  // Reserva atómica (una vez por usuario):
  //  - Lote con lista: $elemMatch claimedAt:null → $set. Dos requests
  //    concurrentes → una sola matchea.
  //  - Código PÚBLICO: el usuario se APPENDEA a recipients; el filtro exige
  //    que NO esté ya (y que haya cupo si maxClaims). Los updates sobre un
  //    mismo doc se serializan en Mongo, así que dos claims concurrentes no
  //    pueden duplicarse: el segundo re-evalúa el filtro y no matchea.
  let upd;
  if (batch.isPublic) {
    const filtro = {
      id: batch.id,
      expiresAt: { $gt: now },
      recipients: { $not: { $elemMatch: { userId: uDoc.id } } }
    };
    if (batch.maxClaims > 0) {
      filtro.$expr = { $lt: [{ $size: { $ifNull: ['$recipients', []] } }, batch.maxClaims] };
    }
    upd = await NotifBatch.updateOne(filtro, {
      $push: { recipients: {
        userId: uDoc.id, username: uDoc.username,
        channel: 'none', delivery: 'none', deliveryAt: null,
        claimedAt: now, promoBonusId: null,
        creditedAt: null, creditTxId: null, creditError: null
      } }
    });
    if (!upd.modifiedCount) {
      const otra = await NotifBatch.findOne({ id: batch.id, 'recipients.userId': uDoc.id }).select('id').lean();
      if (otra) return { http: 400, body: { error: 'Ya canjeaste este código. Es una sola vez por cuenta.' } };
      return { http: 400, body: { error: '⏰ Este código llegó a su límite de canjes (o ya venció). ¡La próxima vez llegá antes!' } };
    }
  } else {
    upd = await NotifBatch.updateOne(
      { id: batch.id, recipients: { $elemMatch: { userId: uDoc.id, claimedAt: null } } },
      { $set: { 'recipients.$.claimedAt': now } }
    );
    if (!upd.modifiedCount) {
      return { http: 400, body: { error: 'Ya canjeaste este código.' } };
    }
  }

  // ============ REGALO DE FICHAS: acreditación AUTOMÁTICA ============
  if (esFichas) {
    return _notifBatchFichasAfterClaim(uDoc, batch, { via: 'code', codeUp });
  }

  // ============ % EN PRÓXIMA CARGA: cartel verde, lo aplica el agente ============
  const pb = await _activateBatchPromoBonus(uDoc, batch);
  await NotifBatch.updateOne(
    { id: batch.id, 'recipients.userId': uDoc.id },
    { $set: { 'recipients.$.promoBonusId': pb.id } }
  ).catch(() => {});

  const hastaFmt = new Date(pb.expiresAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); // #173 vence a las useHours del canje
  const esAuto = batch.applyMode === 'auto';
  const giftTxt = _giftLabelOf(batch);
  const comoTxt = esAuto
    ? 'Se te suma SOLO cuando cargás (por transferencia automática o con el agente), no tenés que avisar nada.'
    : 'Cuando vayas a cargar, avisale al agente que tenés el bono y te lo suma en el momento.';
  await Message.create({
    id: uuidv4(), senderId: 'system', senderUsername: 'Sistema', senderRole: 'admin',
    receiverId: uDoc.id, receiverRole: 'user',
    content: `🎉 ¡Código canjeado, ${uDoc.username}!\n\n🎁 Tenés un ${giftTxt}.\n\n${comoTxt}${_batchRolloverTxt(batch)} ⏰ Válido hasta ${hastaFmt}.`,
    type: 'system', timestamp: new Date(), read: false
  }).catch(() => {});
  await _emitAdminOnlyChatNote(
    uDoc.id,
    uDoc.username,
    esAuto
      ? `⚡ BONO DE LOTE AUTOMÁTICO (${giftTxt.replace(/ EXTRA en tu| EXTRA en TODAS tus/, ' en')}) — canjeó el código del lote de ${batch.sentBy}${batch.name ? ' ("' + batch.name + '")' : ''}.\n` +
        `👉 Se aplica SOLO en la carga (manual sin bonus o hgcash). NO hay que marcar nada. Vence ${hastaFmt}.`
      : `🎁 BONO DE LOTE PENDIENTE (+${batch.amount}% EXTRA) — canjeó el código del lote de ${batch.sentBy}${batch.name ? ' ("' + batch.name + '")' : ''}.\n` +
        `👉 En su PRÓXIMA CARGA aplicáselo y marcalo como usado desde el cartel verde del chat. Vence ${hastaFmt}.`
  ).catch(() => {});

  logger.info(`[notif-batch] ${uDoc.username} canjeó el código ${codeUp} del lote ${batch.id} (+${batch.amount}%${esAuto ? ', auto' : ''})`);
  return {
    http: 200,
    body: {
      success: true,
      status: 'pending',
      amount: batch.amount,
      type: 'next_charge',
      message: `¡Código válido! Tenés un ${giftTxt}.${esAuto ? ' Se aplica solo al cargar.' : ''}`
    }
  };
}

// POST /api/admin/notif-batches/preview — resuelve la AUDIENCIA (lista pegada,
// inactivos de N días con cupo, o lote completo) ANTES de enviar: cuántos son,
// quién existe/está bloqueado y qué canal de push tiene cada uno (app /
// navegador / sin notis). Es la vista de "quién puede recibir y quién no".
// Para lotes grandes la lista visible se recorta a 150 (los totales son
// completos igual).
app.post('/api/admin/notif-batches/preview', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (!NOTIF_BATCH_SEND_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Solo admin general y cajeros de carga pueden enviar lotes.' });
    }
    const resolved = await _resolveNotifBatchAudience(req.body || {});
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const { users, notFound, skipped } = resolved;
    const list = users.map((u) => ({ username: u.username, channel: _notifChannelOf(u) }));
    res.json({
      users: list.slice(0, 150),
      truncated: Math.max(0, list.length - 150),
      notFound,
      skipped,
      totals: {
        ok: list.length,
        app: list.filter((x) => x.channel === 'app').length,
        browser: list.filter((x) => x.channel === 'browser').length,
        none: list.filter((x) => x.channel === 'none').length
      }
    });
  } catch (err) {
    logger.error(`/api/admin/notif-batches/preview: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// POST /api/admin/notif-batches — crea Y envía un lote. Responde apenas el
// lote queda guardado (y los bonos creados en modo window); las
// notificaciones salen en segundo plano y la entrega por usuario se va
// registrando en el doc (se ve en el historial del panel).
app.post('/api/admin/notif-batches', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (!NOTIF_BATCH_SEND_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Solo admin general y cajeros de carga pueden enviar lotes.' });
    }
    const b = req.body || {};
    const mode = b.mode === 'window' ? 'window' : (b.mode === 'code' ? 'code' : null);
    if (!mode) return res.status(400).json({ error: 'Modo inválido (code | window).' });
    const giftType = b.giftType === 'fixed' ? 'fixed' : (b.giftType === 'percent' ? 'percent' : null);
    if (!giftType) return res.status(400).json({ error: 'Tipo de regalo inválido (percent | fixed).' });

    const amount = Math.round(Number(b.amount));
    if (giftType === 'percent' && (!Number.isFinite(amount) || amount < 1 || amount > 200)) {
      return res.status(400).json({ error: 'El % del regalo tiene que estar entre 1 y 200.' });
    }
    if (giftType === 'fixed' && (!Number.isFinite(amount) || amount < 1 || amount > 500000)) {
      return res.status(400).json({ error: 'El monto del regalo tiene que estar entre $1 y $500.000.' });
    }

    const validHours = Number(b.validHours);
    if (!Number.isFinite(validHours) || validHours < 1 || validHours > 168) {
      return res.status(400).json({ error: 'La vigencia tiene que estar entre 1 y 168 horas.' });
    }
    // #173 horas para USAR el bono después de canjearlo (solo modo código con %). Default 24.
    let useHours = 24;
    if (b.useHours != null && b.useHours !== '') {
      useHours = Number(b.useHours);
      if (!Number.isFinite(useHours) || useHours < 1 || useHours > 168) {
        return res.status(400).json({ error: 'Las horas para usar el bono (tras canjear) tienen que estar entre 1 y 168.' });
      }
      useHours = Math.round(useHours);
    }

    // #263 APLICACIÓN del % (solo giftType percent): auto (default del panel
    // nuevo) o agent (cartel verde). Alcance first|all y franja horaria
    // opcional "HH:MM" (hora argentina; puede cruzar medianoche).
    let applyMode = 'agent', applyScope = 'first', applyFromMin = null, applyToMin = null;
    if (giftType === 'percent') {
      applyMode = b.applyMode === 'agent' ? 'agent' : 'auto';
      applyScope = (applyMode === 'auto' && b.applyScope === 'all') ? 'all' : 'first';
      const parseHM = (v) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
        if (!m) return null;
        const h = Number(m[1]), mi = Number(m[2]);
        if (h > 23 || mi > 59) return NaN;
        return h * 60 + mi;
      };
      const fromRaw = String(b.applyFrom || '').trim(), toRaw = String(b.applyTo || '').trim();
      if (applyMode === 'auto' && (fromRaw || toRaw)) {
        applyFromMin = parseHM(fromRaw); applyToMin = parseHM(toRaw);
        if (applyFromMin == null || applyToMin == null || Number.isNaN(applyFromMin) || Number.isNaN(applyToMin)) {
          return res.status(400).json({ error: 'La franja horaria tiene que tener DESDE y HASTA en formato HH:MM (ej. 18:00 a 23:00), o dejar los dos vacíos.' });
        }
      }
    }

    // Rollover del regalo de fichas (giftType fixed, cualquier modo — las
    // fichas SIEMPRE se acreditan solas: por código al canjear, por tiempo al
    // enviar). Se valida contra bonus.multipliers de JUGAYGANA (⚠️ NO los de
    // depósito) para que la acreditación jamás falle — mismo criterio que el
    // código de bienvenida (#143).
    // #263b: también aplica al % AUTOMÁTICO (el depósito lo manda como
    // bonus_multiplier). Con % modo agente no se usa (el cajero pone el suyo).
    let rolloverX = 0;
    if (giftType === 'fixed' || (giftType === 'percent' && applyMode === 'auto')) {
      rolloverX = Number(b.rolloverX);
      if (!Number.isFinite(rolloverX) || rolloverX < 0 || rolloverX > 50) {
        return res.status(400).json({ error: 'El rollover debe ser un número entre 0 y 50 (0 = sin rollover).' });
      }
      rolloverX = Math.round(rolloverX);
      // (JUGAYGANA no tiene multiplicadores de rollover configurables: el valor se guarda solo para el historial.)
    }

    // CÓDIGO PÚBLICO: sin destinatarios ni notificación — el código se sube a
    // Telegram/redes a mano. El mensaje es opcional (no se envía nada).
    const esPublico = b.audienceType === 'public';
    if (esPublico && mode !== 'code') {
      return res.status(400).json({ error: 'El código público solo funciona en modo CON CÓDIGO.' });
    }

    const message = String(b.message || '').trim();
    if (!esPublico && (message.length < 5 || message.length > 500)) {
      return res.status(400).json({ error: 'El mensaje tiene que tener entre 5 y 500 caracteres.' });
    }
    if (esPublico && message.length > 500) {
      return res.status(400).json({ error: 'El mensaje puede tener hasta 500 caracteres.' });
    }
    const title = String(b.title || '').trim().slice(0, 100) || '🎁 Tenés un regalo';
    const name = String(b.name || '').trim().slice(0, 60);

    // Código (solo modo code): el que mandó el panel o uno autogenerado.
    // Sin caracteres confundibles (0/O, 1/I/L) para dictarlo fácil.
    let code = null;
    if (mode === 'code') {
      code = String(b.code || '').trim().toUpperCase();
      if (!code) {
        const AB = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        code = Array.from({ length: 8 }, () => AB[Math.floor(Math.random() * AB.length)]).join('');
      }
      if (!/^[A-Z0-9-]{4,30}$/.test(code)) {
        return res.status(400).json({ error: 'Código inválido: 4 a 30 caracteres, solo letras, números y guiones.' });
      }
      const welcome = String((await getConfig('communityWelcomeCode', '')) || '').trim();
      if (welcome && welcome.toLowerCase() === code.toLowerCase()) {
        return res.status(400).json({ error: 'Ese código ya es el código de bienvenida de la Comunidad. Elegí otro.' });
      }
      const clash = await NotifBatch.findOne({ mode: 'code', code, expiresAt: { $gt: new Date() } }).select('id').lean();
      if (clash) return res.status(400).json({ error: 'Ya hay un lote ACTIVO con ese código. Elegí otro o esperá a que venza.' });
    }

    // Rama del CÓDIGO PÚBLICO: se crea el "lote" vacío y listo — los que
    // canjeen se van agregando solos a recipients. Nada que enviar.
    if (esPublico) {
      let maxClaims = (b.maxClaims == null || b.maxClaims === '') ? null : Math.round(Number(b.maxClaims));
      if (maxClaims != null && (!Number.isFinite(maxClaims) || maxClaims < 1 || maxClaims > 100000)) {
        return res.status(400).json({ error: 'El cupo de canjes tiene que estar entre 1 y 100.000 (o vacío = sin cupo).' });
      }
      const sentAtP = new Date();
      const batchP = {
        id: uuidv4(),
        name, mode: 'code', giftType, amount, rolloverX, code, validHours, useHours,
        applyMode, applyScope, applyFromMin, applyToMin,
        sentAt: sentAtP, expiresAt: new Date(sentAtP.getTime() + validHours * 3600 * 1000),
        title: '', message,
        sentBy: req.user.username, sentByRole: req.user.role,
        audienceType: 'public', audienceDays: null, audienceLimit: null,
        isPublic: true, maxClaims,
        sendDone: true, // no hay nada que enviar
        recipients: []
      };
      await NotifBatch.create(batchP);
      logger.info(`[notif-batch] CÓDIGO PÚBLICO ${code} creado por ${req.user.username} (${giftType} ${amount}, ${validHours}hs${maxClaims ? ', cupo ' + maxClaims : ''})`);
      return res.json({
        success: true,
        id: batchP.id,
        code,
        expiresAt: batchP.expiresAt,
        isPublic: true,
        maxClaims,
        totals: { recipients: 0, app: 0, browser: 0, none: 0 },
        notFound: [], skipped: [],
        message: `Código público ${code} creado — subilo a Telegram/redes. Vigente ${validHours}hs${maxClaims ? ', cupo ' + maxClaims + ' canjes' : ', sin cupo'}.`
      });
    }

    const resolved = await _resolveNotifBatchAudience(b);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const { users, notFound, skipped, audience } = resolved;
    if (!users.length) {
      return res.status(400).json({ error: 'La audiencia quedó vacía (¿usernames inexistentes o sin inactivos con ese criterio?).', notFound, skipped });
    }

    const sentAt = new Date();
    const expiresAt = new Date(sentAt.getTime() + validHours * 3600 * 1000);
    // #177: fichas POR TIEMPO se acreditan recién cuando el cliente las RECLAMA con el botón
    // (default). Sólo si el panel manda directCredit:true se acreditan a todos al enviar.
    const claimRequired = mode === 'window' && giftType === 'fixed' && b.directCredit !== true;
    const batch = {
      id: uuidv4(),
      name, mode, giftType, amount, rolloverX, code, validHours, useHours, sentAt, expiresAt,
      applyMode, applyScope, applyFromMin, applyToMin, claimRequired,
      title, message,
      sentBy: req.user.username, sentByRole: req.user.role,
      ...audience,
      sendDone: false,
      recipients: users.map((u) => ({
        userId: u.id, username: u.username,
        channel: _notifChannelOf(u), delivery: null, deliveryAt: null,
        // Modo window: el bono nace activado para todos → claimedAt = envío
        // (el PromoBonus lo crea el motor al procesar a cada uno). #177: con reclamo
        // queda null hasta que el cliente toque RECLAMAR.
        claimedAt: (mode === 'window' && !claimRequired) ? sentAt : null,
        promoBonusId: null
      }))
    };
    await NotifBatch.create(batch);

    // TODO el trabajo por destinatario (PromoBonus del modo window + mensaje de
    // chat + push) lo hace el MOTOR en segundo plano, con claim atómico por
    // destinatario y reanudación tras deploy/reinicio (ver
    // _processNotifBatchQueue). Acá solo se lo patea para que arranque ya.
    setImmediate(() => { _processNotifBatchQueue().catch(() => {}); });

    res.json({
      success: true,
      id: batch.id,
      code,
      expiresAt,
      totals: {
        recipients: users.length,
        app: batch.recipients.filter((r) => r.channel === 'app').length,
        browser: batch.recipients.filter((r) => r.channel === 'browser').length,
        none: batch.recipients.filter((r) => r.channel === 'none').length
      },
      notFound,
      skipped,
      message: claimRequired
        ? `Lote creado: ${users.length} destinatarios. Las notificaciones están saliendo en segundo plano. Las fichas se acreditan SOLO a los que toquen RECLAMAR en la app (vigente ${validHours}hs).`
        : `Lote creado: ${users.length} destinatarios. Las notificaciones están saliendo en segundo plano.`
    });
  } catch (err) {
    logger.error(`/api/admin/notif-batches: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/notif-batches — historial de lotes (sin el detalle por
// usuario; eso lo trae el GET /:id). Lo ven admin, depositor y withdrawer.
app.get('/api/admin/notif-batches', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (!NOTIF_BATCH_VIEW_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Sin permiso.' });
    }
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const rows = await NotifBatch.aggregate([
      { $sort: { sentAt: -1 } },
      { $limit: limit },
      { $project: {
        _id: 0, id: 1, name: 1, mode: 1, giftType: 1, amount: 1, code: 1,
        validHours: 1, sentAt: 1, expiresAt: 1, title: 1, message: 1,
        sentBy: 1, sentByRole: 1,
        audienceType: 1, audienceDays: 1, audienceLimit: 1, audienceLabel: 1, sendDone: 1,
        isPublic: 1, maxClaims: 1,
        applyMode: 1, applyScope: 1, applyFromMin: 1, applyToMin: 1, rolloverX: 1, useHours: 1, claimRequired: 1,
        total: { $size: { $ifNull: ['$recipients', []] } },
        credited: { $size: { $filter: { input: { $ifNull: ['$recipients', []] }, as: 'r', cond: { $ne: ['$$r.creditedAt', null] } } } },
        claimed: { $size: { $filter: { input: { $ifNull: ['$recipients', []] }, as: 'r', cond: { $ne: ['$$r.claimedAt', null] } } } },
        delivered: { $size: { $filter: { input: { $ifNull: ['$recipients', []] }, as: 'r', cond: { $in: ['$$r.delivery', ['socket', 'push']] } } } },
        pendientes: { $size: { $filter: { input: { $ifNull: ['$recipients', []] }, as: 'r', cond: { $in: ['$$r.delivery', [null, 'sending']] } } } },
        sinNotis: { $size: { $filter: { input: { $ifNull: ['$recipients', []] }, as: 'r', cond: { $eq: ['$$r.channel', 'none'] } } } }
      } }
    ]);
    // #173 resultado de los bonos de cada lote: usados / activos / vencidos sin usar.
    try {
      const now = new Date();
      const ids = rows.map(r => r.id);
      const agg = ids.length ? await PromoBonus.aggregate([
        { $match: { sourceRuleCode: 'lote', sourceRuleId: { $in: ids } } },
        { $group: { _id: '$sourceRuleId',
          usados: { $sum: { $cond: [{ $or: [{ $eq: ['$status', 'used'] }, { $gt: ['$usesCount', 0] }] }, 1, 0] } },
          activos: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'active'] }, { $gt: ['$expiresAt', now] }, { $eq: [{ $ifNull: ['$usesCount', 0] }, 0] }] }, 1, 0] } },
          vencidos: { $sum: { $cond: [{ $and: [{ $eq: [{ $ifNull: ['$usesCount', 0] }, 0] }, { $ne: ['$status', 'used'] }, { $or: [{ $eq: ['$status', 'expired'] }, { $lte: ['$expiresAt', now] }] }] }, 1, 0] } },
          bonoTotal: { $sum: { $ifNull: ['$usesTotalBonus', 0] } }
        } }
      ]) : [];
      const by = new Map(agg.map(a => [a._id, a]));
      for (const r of rows) { const a = by.get(r.id) || {}; r.usados = a.usados || 0; r.activos = a.activos || 0; r.vencidos = a.vencidos || 0; r.bonoTotal = a.bonoTotal || 0; }
    } catch (e) { logger.warn(`[notif-batch] resumen de bonos: ${e.message}`); }
    res.json({ batches: rows });
  } catch (err) {
    logger.error(`GET /api/admin/notif-batches: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/admin/notif-batches/:id — detalle del lote: cada destinatario con
// canal, entrega real, canje y estado del bono (activo/usado/vencido + quién
// lo marcó usado — se lee del PromoBonus asociado).
app.get('/api/admin/notif-batches/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (!NOTIF_BATCH_VIEW_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Sin permiso.' });
    }
    const batch = await NotifBatch.findOne({ id: String(req.params.id || '') }).lean();
    if (!batch) return res.status(404).json({ error: 'Lote no encontrado' });
    const now = new Date();
    // #173: vencer en DB los bonos de este lote que pasaron su plazo (el vencimiento es lazy).
    await PromoBonus.updateMany({ sourceRuleId: batch.id, status: 'active', expiresAt: { $lte: now } }, { $set: { status: 'expired' } }).catch(() => {});
    const pbIds = (batch.recipients || []).map((r) => r.promoBonusId).filter(Boolean);
    const bonuses = pbIds.length ? await PromoBonus.find({ id: { $in: pbIds } })
      .select('id status usedBy usedAt expiresAt activatedAt autoApply applyScope usesCount usesTotalBonus cargaMonto').lean() : [];
    const pbMap = new Map(bonuses.map((p) => [p.id, p]));
    const summary = { total: 0, canjearon: 0, usaron: 0, activos: 0, vencidos: 0, cancelados: 0, bonoTotal: 0, acreditados: 0, sinReclamar: 0, vencidosSinReclamar: 0, fichasTotal: 0 };
    const loteVencido = new Date(batch.expiresAt) <= now;
    const recipients = (batch.recipients || []).map((r) => {
      const pb = r.promoBonusId ? pbMap.get(r.promoBonusId) : null;
      // #177 fichas: acreditadas / sin reclamar / venció sin reclamar.
      if (batch.giftType === 'fixed') {
        if (r.creditedAt) { summary.acreditados++; summary.fichasTotal += Number(batch.amount) || 0; }
        else if (!r.claimedAt && batch.claimRequired) { if (loteVencido) summary.vencidosSinReclamar++; else summary.sinReclamar++; }
      }
      // Estado resumido del bono: used | active | expired (venció sin usar) | cancelled
      // (lo vencieron antes de tiempo: reemplazado por otro bono o cancelado por el agente).
      let outcome = null;
      if (pb) {
        const used = pb.status === 'used' || (pb.usesCount || 0) > 0;
        if (used) outcome = 'used';
        else if (pb.status === 'active' && new Date(pb.expiresAt) > now) outcome = 'active';
        else if (pb.status === 'expired' && new Date(pb.expiresAt) > now) outcome = 'cancelled';
        else outcome = 'expired';
      }
      summary.total++;
      if (r.claimedAt) summary.canjearon++;
      if (outcome === 'used') summary.usaron++;
      if (outcome === 'active') summary.activos++;
      if (outcome === 'expired') summary.vencidos++;
      if (outcome === 'cancelled') summary.cancelados++;
      if (pb) summary.bonoTotal += Number(pb.usesTotalBonus) || 0;
      return {
        username: r.username,
        channel: r.channel,
        delivery: r.delivery,
        claimedAt: r.claimedAt,
        giftOutcome: batch.giftType === 'fixed' ? (r.creditedAt ? 'credited' : (batch.claimRequired && !r.claimedAt ? (loteVencido ? 'expired_unclaimed' : 'pending_claim') : null)) : null,
        creditedAt: r.creditedAt || null,
        creditError: r.creditError || null,
        bonusStatus: pb ? pb.status : null,
        outcome,
        bonusExpiresAt: pb ? pb.expiresAt : null,
        usedBy: pb ? pb.usedBy : null,
        usedAt: pb ? pb.usedAt : null,
        autoApply: pb ? pb.autoApply === true : false,
        applyScope: pb ? (pb.applyScope || 'first') : null,
        usesCount: pb ? (pb.usesCount || 0) : 0,
        usesTotalBonus: pb ? (pb.usesTotalBonus || 0) : 0,
        cargaMonto: pb ? (pb.cargaMonto || 0) : 0
      };
    });
    delete batch.recipients;
    res.json({ batch, recipients, summary });
  } catch (err) {
    logger.error(`GET /api/admin/notif-batches/:id: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});



// POST /api/gift-code/claim — el cliente canjea un código de LOTE desde la PWA
// (modal "🎁 Reclamar Bono con Código"). Este repo no tiene código de
// bienvenida de comunidad, así que si no es un código de lote → "no válido".
app.post('/api/gift-code/claim', authMiddleware, authLimiter, async (req, res) => {
  try {
    if (isAdminRole(req.user.role)) return res.status(403).json({ error: 'Solo clientes' });
    const attempt = String((req.body || {}).code || '').trim();
    if (!/^[A-Za-z0-9-]{4,30}$/.test(attempt)) return res.status(400).json({ error: 'Ingresá el código tal como te llegó.' });
    const r = await _tryClaimNotifBatchCode(req.user, attempt);
    if (!r) return res.status(400).json({ error: 'El código no es válido. Fijate bien cómo aparece en la notificación.' });
    res.status(r.http).json(r.body);
  } catch (err) {
    logger.error(`/api/gift-code/claim: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// #177 GET /api/gift/pending — regalos de FICHAS con reclamo que este cliente todavía no
// reclamó y siguen vigentes (los pinta la card del home y el modal 🎁 de la PWA).
app.get('/api/gift/pending', authMiddleware, async (req, res) => {
  try {
    if (isAdminRole(req.user.role)) return res.json({ gifts: [] });
    const now = new Date();
    const rows = await NotifBatch.find({
      claimRequired: true, giftType: 'fixed', expiresAt: { $gt: now },
      recipients: { $elemMatch: { userId: req.user.userId, claimedAt: null } }
    }).select('id name title message amount sentAt expiresAt rolloverX').sort({ sentAt: -1 }).limit(5).lean();
    res.json({ gifts: rows.map(b => ({ batchId: b.id, name: b.name || '', title: b.title || '', message: b.message || '', amount: b.amount, sentAt: b.sentAt, expiresAt: b.expiresAt, rolloverX: b.rolloverX || 0 })) });
  } catch (err) {
    logger.error(`/api/gift/pending: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// #177 POST /api/gift/claim { batchId } — el cliente RECLAMA las fichas de un lote con reclamo.
// Reserva atómica (claimedAt null → ahora) y recién después se acredita en JUGAYGANA, con las
// mismas reglas que el canje por código (ambiguo = no se libera + alerta; fallo = se libera).
app.post('/api/gift/claim', authMiddleware, authLimiter, async (req, res) => {
  try {
    if (isAdminRole(req.user.role)) return res.status(403).json({ error: 'Solo clientes' });
    const batchId = String((req.body || {}).batchId || '').trim();
    if (!/^[A-Za-z0-9-]{8,64}$/.test(batchId)) return res.status(400).json({ error: 'Regalo inválido.' });
    const now = new Date();
    const batch = await NotifBatch.findOne({ id: batchId, claimRequired: true, giftType: 'fixed' }).select('-recipients').lean();
    if (!batch) return res.status(404).json({ error: 'Ese regalo no existe.' });
    if (new Date(batch.expiresAt) <= now) return res.status(400).json({ error: '⏰ Este regalo ya venció. Estate atento a la próxima notificación.' });
    const uDoc = await User.findOne({ id: req.user.userId }).select('id username role jugayganaUserId').lean();
    if (!uDoc || uDoc.role !== 'user') return res.status(400).json({ error: 'Solo las cuentas de clientes pueden reclamar regalos.' });
    const upd = await NotifBatch.updateOne(
      { id: batch.id, expiresAt: { $gt: now }, recipients: { $elemMatch: { userId: uDoc.id, claimedAt: null } } },
      { $set: { 'recipients.$.claimedAt': now } }
    );
    if (!upd.modifiedCount) {
      const mio = await NotifBatch.findOne({ id: batch.id, 'recipients.userId': uDoc.id }).select('id').lean();
      return res.status(400).json({ error: mio ? 'Ya reclamaste este regalo.' : 'Este regalo no es para tu cuenta.' });
    }
    const r = await _notifBatchFichasAfterClaim(uDoc, batch, { via: 'claim' });
    res.status(r.http).json(r.body);
  } catch (err) {
    logger.error(`/api/gift/claim: ${err.message}`);
    res.status(500).json({ error: 'Error del servidor' });
  }
});
