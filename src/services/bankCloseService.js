/**
 * bankCloseService.js — CIERRE DIARIO del banco (#155).
 *
 * Concilia un día argentino completo en tres cruces y devuelve/persiste un DailyClose:
 *   1. BANCO ↔ SISTEMA
 *      · Toda transferencia ENTRANTE acreditada (status done) tiene una carga vinculada
 *        (auto/asignada/manual anclada) o una resolución explícita ("no corresponde").
 *      · Toda CARGA (Transaction deposit) tiene un movimiento vinculado o un origen
 *        declarado ("otro banco"). Las cargas manuales viejas que consumieron un
 *        movimiento por monto (sin vínculo guardado) se VINCULAN acá si el par es
 *        inequívoco (mismo usuario, mismo monto, ±3 h) y se persiste el vínculo.
 *      · Toda SALIDA es un pago a cliente (PendingPayout) o una bajada (BankSweep).
 *   2. SISTEMA ↔ JUGAYGANA (cajero): el saldo del cajero (CashierSnapshot) tiene que
 *      haberse movido exactamente Σ opAmount del día. Un descuadre = plata movida por
 *      fuera del sistema (carga directa en JUGAYGANA, operación ambigua que sí entró…).
 *   3. ERRORES: pagos hgcash sin descuento confirmado, pagos sin movimiento bancario,
 *      operaciones ambiguas (🛑 VERIFICAR) sin resolver.
 *
 * Los diffs tienen `key` estable (tipo:refId): al recalcular, los que ya estaban
 * marcados resueltos conservan la marca. El cierre queda `ok` cuando no hay diffs sin
 * resolver y el cajero cuadra; `warn` si faltan datos para cruzar; `diff` si hay algo.
 *
 * NO toca plata. Solo lee, vincula pares inequívocos y escribe el DailyClose.
 */
const BankMovement = require('../models/BankMovement');
const Transaction = require('../models/Transaction');
const PendingPayout = require('../models/PendingPayout');
const BankSweep = require('../models/BankSweep');
const DailyClose = require('../models/DailyClose');
const CashierSnapshot = require('../models/CashierSnapshot');
const RefundClaim = require('../models/RefundClaim');
const DailyRouletteSpin = require('../models/DailyRouletteSpin');
const hgcashPay = require('./hgcashService');
const logger = require('../utils/logger');

const CASHIER_TOLERANCE_ARS = 5;           // diferencia tolerada en el cruce con el cajero
const DEFAULT_GRACE_MIN = 60;              // #157 lo que entra en la última hora del día puede resolverse recién al día siguiente
const LINK_WINDOW_MS = 3 * 3600 * 1000;    // ±3 h para vincular carga manual vieja ↔ movimiento consumido por monto
const NOT_CHARGED_STATES = ['pending', 'no_match', 'needs_review', 'error', 'claiming', 'shadow_matched'];
// Fuentes de Transaction 'deposit' que NO son plata que entró por banco (regalos/devoluciones).
const NON_BANK_DEPOSIT_SOURCES = ['install_bonus', 'welcome_gift', 'payout_refund', 'notif_batch', 'notif_batch_auto', 'auto_hgcash_bonus'];

function _artDayRange(dayKey) {
  const start = new Date(`${dayKey}T03:00:00.000Z`); // 00:00 ART = 03:00 UTC (sin DST)
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000) };
}
function _artDateKey(d) { return new Date(d || Date.now()).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }); }
function _amountsEqual(a, b) { return Math.abs(Number(a) - Number(b)) < 0.005; }
function _round(n) { return Math.round(Number(n || 0) * 100) / 100; }
function _accredited(status, acceptStatuses) {
  const list = (acceptStatuses || ['done']).map(s => String(s).toLowerCase());
  return list.includes(String(status || '').toLowerCase());
}

/**
 * Calcula (y persiste) el cierre de un día.
 * @param {string} dayKey 'YYYY-MM-DD' (día ART)
 * @param {object} opts { computedBy, acceptStatuses, hgcashEnabled }
 */
async function computeDailyClose(dayKey, opts = {}) {
  const { start, end } = _artDayRange(dayKey);
  const prev = await DailyClose.findOne({ dateKey: dayKey }).lean();
  const prevResolved = new Map();
  if (prev && Array.isArray(prev.diffs)) {
    for (const d of prev.diffs) if (d.resolved) prevResolved.set(d.key, d);
  }
  const diffs = [];
  const push = (d) => {
    const key = `${d.type}:${d.refId || d.detail || ''}`;
    const was = prevResolved.get(key);
    diffs.push(Object.assign({ key, resolved: false, resolvedBy: null, resolvedAt: null, note: null }, d,
      was ? { resolved: true, resolvedBy: was.resolvedBy, resolvedAt: was.resolvedAt, note: was.note } : {}));
  };
  const acceptStatuses = opts.acceptStatuses || ['done'];
  // #157 Operación 24 h: una transferencia de las 23:54 puede acreditarse a las 00:08. Lo que
  // entró en los últimos `graceMinutes` del día y sigue abierto NO es diferencia: queda en
  // ARRASTRE y lo verifica el recálculo automático del día siguiente (cron recalcula D-2).
  const graceMs = Math.max(0, Number(opts.graceMinutes != null ? opts.graceMinutes : DEFAULT_GRACE_MIN)) * 60 * 1000;
  const graceFrom = new Date(end.getTime() - graceMs);
  const inGrace = (d) => d && new Date(d).getTime() >= graceFrom.getTime();
  const arrastre = { entrantes: [], pagos: [], salidas: [] };

  // ── 1a. ENTRADAS del banco ────────────────────────────────────────────────
  const inbound = await BankMovement.find({ direction: 'Inbound', createdAt: { $gte: start, $lt: end } })
    .sort({ createdAt: 1 }).lean();
  const inDone = inbound.filter(m => _accredited(m.status, acceptStatuses));
  const inCharged = inDone.filter(m => ['auto_charged', 'manual_charged'].includes(m.matchStatus));
  const inResolved = inDone.filter(m => m.matchStatus === 'ignored' && m.resolution);
  const inDuplicate = inDone.filter(m => m.matchStatus === 'duplicate');
  const inOpen = inDone.filter(m => NOT_CHARGED_STATES.includes(m.matchStatus) || (m.matchStatus === 'ignored' && !m.resolution));
  for (const m of inOpen) {
    if (inGrace(m.createdAt)) { arrastre.entrantes.push({ movementId: m.movementId, amount: m.amount, fromName: m.fromName || null, at: m.createdAt, status: m.matchStatus }); continue; }
    push({ type: 'mov_sin_acreditar', refType: 'movement', refId: m.movementId, amount: m.amount,
      userId: m.matchedUserId || null, username: m.matchedUsername || null, at: m.createdAt,
      detail: `Transferencia de ${m.fromName || m.fromCBU || 'origen desconocido'} sin acreditar (estado: ${m.matchStatus}${m.chargeError ? ' · ' + String(m.chargeError).slice(0, 80) : ''})` });
  }

  // ── 1b. CARGAS del sistema ────────────────────────────────────────────────
  const deposits = await Transaction.find({ type: 'deposit', timestamp: { $gte: start, $lt: end } })
    .sort({ timestamp: 1 }).lean();
  const bankDeposits = deposits.filter(t => !NON_BANK_DEPOSIT_SOURCES.includes(((t.metadata || {}).source) || ''));
  // Movimientos manual_charged por MONTO (sin vínculo): candidatos para vincular con cargas manuales viejas.
  const consumedUnlinked = await BankMovement.find({
    direction: 'Inbound', matchStatus: 'manual_charged', transactionId: null,
    chargedAt: { $gte: new Date(start.getTime() - LINK_WINDOW_MS), $lt: new Date(end.getTime() + LINK_WINDOW_MS) }
  }).lean();
  const linkedNow = [];
  let cargasOtroBanco = [], cargasSinTransferencia = [], cargasVinculadas = 0, sumCargas = 0;
  for (const t of bankDeposits) {
    sumCargas += Number(t.amount || 0);
    const md = t.metadata || {};
    if (md.movementId) { cargasVinculadas++; continue; }
    if (md.origin === 'otro_banco') { cargasOtroBanco.push(t); continue; }
    // Vínculo inequívoco con un movimiento consumido por monto (legacy): mismo usuario + monto + ±3 h.
    const tsMs = new Date(t.timestamp).getTime();
    const cands = consumedUnlinked.filter(m => m.matchedUserId === t.userId && _amountsEqual(m.amount, t.amount) &&
      m.chargedAt && Math.abs(new Date(m.chargedAt).getTime() - tsMs) <= LINK_WINDOW_MS && !linkedNow.includes(m.movementId));
    if (cands.length === 1) {
      const m = cands[0];
      linkedNow.push(m.movementId);
      try {
        await BankMovement.updateOne({ movementId: m.movementId, transactionId: null }, { $set: { transactionId: t.id, chargeSource: m.chargeSource || 'close_link' } });
        await Transaction.updateOne({ id: t.id }, { $set: { 'metadata.movementId': m.movementId, 'metadata.linkedByClose': dayKey } });
      } catch (e) { logger.warn(`[cierre] no se pudo persistir vínculo ${t.id}↔${m.movementId}: ${e.message}`); }
      cargasVinculadas++;
      continue;
    }
    cargasSinTransferencia.push(t);
  }
  for (const t of cargasSinTransferencia) {
    push({ type: 'carga_sin_transferencia', refType: 'transaction', refId: t.id, amount: t.amount, userId: t.userId, username: t.username, at: t.timestamp,
      detail: `Carga de $${Number(t.amount).toLocaleString('es-AR')} a @${t.username} por ${t.adminUsername || '?'} sin transferencia vinculada ni origen declarado` });
  }

  // ── 1c. SALIDAS del banco ─────────────────────────────────────────────────
  const outbound = await BankMovement.find({ direction: 'Outbound', createdAt: { $gte: start, $lt: end } }).sort({ createdAt: 1 }).lean();
  const outDone = outbound.filter(m => _accredited(m.status, acceptStatuses));
  const extIds = outDone.map(m => m.externalId).filter(Boolean);
  const hgIds = outDone.map(m => m.movementId).filter(Boolean);
  const payoutsByExt = new Map(), payoutsByTx = new Map();
  if (extIds.length || hgIds.length) {
    const or = [];
    if (extIds.length) or.push({ id: { $in: extIds } });
    if (hgIds.length) or.push({ hgTxId: { $in: hgIds } }, { hgTransactionId: { $in: hgIds } });
    const ps = await PendingPayout.find({ $or: or }).select('id username userId amount hgTxId hgTransactionId status debitConfirmed deductAtPay').lean();
    for (const p of ps) { payoutsByExt.set(p.id, p); if (p.hgTxId) payoutsByTx.set(p.hgTxId, p); if (p.hgTransactionId) payoutsByTx.set(p.hgTransactionId, p); }
  }
  const sweepIds = extIds.filter(e => /^sweep-/.test(e)).map(e => e.replace(/^sweep-/, ''));
  const sweeps = sweepIds.length ? await BankSweep.find({ id: { $in: sweepIds } }).lean() : [];
  const sweepById = new Map(sweeps.map(s => [s.id, s]));
  let outPagos = 0, sumPagos = 0, outBajadas = 0, sumBajadas = 0, outSinOrigen = [];
  for (const m of outDone) {
    const sweep = m.externalId && /^sweep-/.test(m.externalId) ? sweepById.get(m.externalId.replace(/^sweep-/, '')) : (m.sweepId ? sweepById.get(m.sweepId) : null);
    if (sweep || m.outKind === 'sweep') { outBajadas++; sumBajadas += Number(m.amount || 0); continue; }
    const p = (m.externalId && payoutsByExt.get(m.externalId)) || payoutsByTx.get(m.movementId) || (m.payoutId && payoutsByExt.get(m.payoutId));
    if (p || m.outKind === 'payout') { outPagos++; sumPagos += Number(m.amount || 0); continue; }
    if (m.outKind === 'fee' || m.resolution) continue;
    outSinOrigen.push(m);
  }
  for (const m of outSinOrigen) {
    if (inGrace(m.createdAt)) { arrastre.salidas.push({ movementId: m.movementId, amount: m.amount, toName: m.toName || null, at: m.createdAt }); continue; }
    push({ type: 'salida_sin_origen', refType: 'movement', refId: m.movementId, amount: m.amount, at: m.createdAt,
      detail: `Salida de $${Number(m.amount || 0).toLocaleString('es-AR')} a ${m.toName || m.toCBU || '?'} que no es un pago ni una bajada registrada` });
  }

  // ── 3a. Pagos del día: descuento confirmado y movimiento bancario ─────────
  const paidPayouts = await PendingPayout.find({ status: 'paid', paidAt: { $gte: start, $lt: end } }).lean();
  const outMovByExt = new Map(outbound.map(m => [m.externalId, m]).filter(([k]) => k));
  const outMovByHg = new Map(); for (const m of outbound) { outMovByHg.set(m.movementId, m); }
  let pagosOtroBanco = 0;
  for (const p of paidPayouts) {
    if (p.deductAtPay === true && p.debitConfirmed !== true) {
      push({ type: 'pago_sin_descuento', refType: 'payout', refId: p.id, amount: p.amount, userId: p.userId, username: p.username, at: p.paidAt,
        detail: `Pago de $${Number(p.amount).toLocaleString('es-AR')} a @${p.username} marcado PAGADO sin descuento de fichas confirmado en JUGAYGANA` });
    }
    if (p.paidVia === 'hgcash') {
      const has = outMovByExt.get(p.id) || (p.hgTxId && outMovByHg.get(p.hgTxId)) || (p.hgTransactionId && outMovByHg.get(p.hgTransactionId));
      if (!has) {
        if (inGrace(p.paidAt)) { arrastre.pagos.push({ payoutId: p.id, amount: p.amount, username: p.username, at: p.paidAt }); continue; }
        push({ type: 'pago_sin_movimiento', refType: 'payout', refId: p.id, amount: p.amount, userId: p.userId, username: p.username, at: p.paidAt,
          detail: `Pago hgcash de $${Number(p.amount).toLocaleString('es-AR')} a @${p.username} sin movimiento saliente en el banco (¿webhook perdido?)` });
      }
    } else if (p.paidVia === 'other_bank') { pagosOtroBanco++; }
  }

  // ── 3b. Operaciones AMBIGUAS (🛑 VERIFICAR) sin resolver ─────────────────
  const ambRefunds = await RefundClaim.find({ verifyPending: true, claimedAt: { $gte: start, $lt: end } }).lean().catch(() => []);
  for (const r of ambRefunds) {
    push({ type: 'ambiguo', refType: 'refund', refId: r.id || String(r._id), amount: r.amount, userId: r.userId, username: r.username, at: r.claimedAt,
      detail: `Reembolso ${r.type || ''} de $${Number(r.amount || 0).toLocaleString('es-AR')} a @${r.username} quedó en VERIFICAR (JUGAYGANA no confirmó)` });
  }
  const ambMovs = inbound.filter(m => /AMBIGUO/i.test(String(m.chargeError || '')) && NOT_CHARGED_STATES.includes(m.matchStatus));
  for (const m of ambMovs) {
    push({ type: 'ambiguo', refType: 'movement', refId: m.movementId, amount: m.amount, userId: m.matchedUserId, username: m.matchedUsername, at: m.createdAt,
      detail: `Carga automática de $${Number(m.amount || 0).toLocaleString('es-AR')} a @${m.matchedUsername || '?'} quedó AMBIGUA (verificar si entró en JUGAYGANA)` });
  }
  const ambSpins = await DailyRouletteSpin.find({ creditError: { $regex: '^VERIFICAR' }, spunAt: { $gte: start, $lt: end } }).lean().catch(() => []);
  for (const sp of ambSpins) {
    push({ type: 'ambiguo', refType: 'roulette', refId: String(sp._id), amount: sp.prizeARS || null, userId: sp.userId, username: sp.username, at: sp.spunAt,
      detail: `Premio de ruleta a @${sp.username || '?'} quedó en VERIFICAR` });
  }
  const ambPayouts = await PendingPayout.find({ error: { $regex: 'AMBIGUO' }, updatedAt: { $gte: start, $lt: end }, status: { $in: ['failed', 'paying'] } }).lean().catch(() => []);
  for (const p of ambPayouts) {
    push({ type: 'ambiguo', refType: 'payout', refId: p.id, amount: p.amount, userId: p.userId, username: p.username, at: p.updatedAt,
      detail: `Descuento del retiro de $${Number(p.amount).toLocaleString('es-AR')} a @${p.username} quedó AMBIGUO` });
  }

  // ── 2. CAJERO de JUGAYGANA ───────────────────────────────────────────────
  const snapStart = await CashierSnapshot.findOne({ at: { $lt: start, $gte: new Date(start.getTime() - 3 * 24 * 3600 * 1000) } }).sort({ at: -1 }).lean();
  const snaps = await CashierSnapshot.find({ at: { $gte: start, $lt: end } }).sort({ at: 1 }).lean();
  const cashier = { startBalance: null, startAt: null, endBalance: null, endAt: null, ops: snaps.length, expectedDelta: null, actualDelta: null, diff: null, status: 'sin_datos' };
  if (snaps.length) {
    const first = snaps[0], last = snaps[snaps.length - 1];
    // Inicio: último snapshot ANTES del día; si no hay, el saldo previo a la primera operación del día.
    const startBal = snapStart ? snapStart.balance : (first.balance - Number(first.opAmount || 0));
    cashier.startBalance = _round(startBal); cashier.startAt = snapStart ? snapStart.at : first.at;
    cashier.endBalance = _round(last.balance); cashier.endAt = last.at;
    cashier.expectedDelta = _round(snaps.reduce((a, s) => a + Number(s.opAmount || 0), 0));
    cashier.actualDelta = _round(last.balance - startBal);
    cashier.diff = _round(cashier.actualDelta - cashier.expectedDelta);
    cashier.status = Math.abs(cashier.diff) <= CASHIER_TOLERANCE_ARS ? 'ok' : 'descuadre';
    if (cashier.status === 'descuadre') {
      push({ type: 'cajero_descuadre', refType: 'cashier', refId: dayKey, amount: cashier.diff, at: last.at,
        detail: `El cajero de JUGAYGANA se movió $${cashier.actualDelta.toLocaleString('es-AR')} y nuestras operaciones suman $${cashier.expectedDelta.toLocaleString('es-AR')} → diferencia $${cashier.diff.toLocaleString('es-AR')} (plata movida por fuera del sistema, recarga del cajero, o una operación ambigua que sí entró)` });
    }
  }
  // Suma de lo que registramos en Transactions (informativo, para comparar con Σ opAmount).
  const txAgg = await Transaction.aggregate([
    { $match: { timestamp: { $gte: start, $lt: end }, type: { $in: ['deposit', 'bonus', 'refund', 'fire_reward', 'referral_commission', 'withdrawal'] } } },
    { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } }
  ]);
  const txTotals = {}; for (const r of txAgg) txTotals[r._id] = { total: _round(r.total), count: r.count };

  // ── Saldo hgcash al cierre (informativo) ─────────────────────────────────
  let bank = null;
  try {
    if (hgcashPay.isEnabled()) {
      const acc = await hgcashPay.getAccounts();
      if (acc.ok && Array.isArray(acc.data) && acc.data.length) {
        const a = acc.data[0];
        bank = { accountId: a.id, balance: a.balance, netBalance: a.netBalance, pendingFees: a.pendingFees, at: new Date() };
        const prevClose = await DailyClose.findOne({ dateKey: { $lt: dayKey }, 'bank.balance': { $ne: null } }).sort({ dateKey: -1 }).lean();
        if (prevClose && prevClose.bank) {
          bank.prevBalance = prevClose.bank.balance; bank.prevDate = prevClose.dateKey;
          bank.actualDelta = _round(Number(a.balance) - Number(prevClose.bank.balance));
          bank.expectedDelta = _round(inDone.reduce((s, m) => s + Number(m.amount || 0), 0) - outDone.reduce((s, m) => s + Number(m.amount || 0), 0));
          bank.note = 'Delta del ledger hgcash vs. entradas−salidas del día (informativo: las comisiones y movimientos fuera del rango lo corren).';
        }
      }
    }
  } catch (e) { logger.warn(`[cierre] saldo hgcash no disponible: ${e.message}`); }

  const summary = {
    entradas: { count: inDone.length, total: _round(inDone.reduce((s, m) => s + Number(m.amount || 0), 0)) },
    entradasCargadas: { count: inCharged.length, total: _round(inCharged.reduce((s, m) => s + Number(m.amount || 0), 0)),
      auto: inCharged.filter(m => m.matchStatus === 'auto_charged').length,
      asignadas: inCharged.filter(m => m.chargeSource === 'assigned').length,
      manuales: inCharged.filter(m => m.matchStatus === 'manual_charged' && m.chargeSource !== 'assigned').length },
    entradasNoCorresponde: { count: inResolved.length, total: _round(inResolved.reduce((s, m) => s + Number(m.amount || 0), 0)) },
    entradasDuplicadas: { count: inDuplicate.length },
    entradasSinAcreditar: { count: inOpen.length, total: _round(inOpen.reduce((s, m) => s + Number(m.amount || 0), 0)) },
    cargas: { count: bankDeposits.length, total: _round(sumCargas), vinculadas: cargasVinculadas, vinculadasPorCierre: linkedNow.length,
      otroBanco: { count: cargasOtroBanco.length, total: _round(cargasOtroBanco.reduce((s, t) => s + Number(t.amount || 0), 0)) },
      sinTransferencia: { count: cargasSinTransferencia.length, total: _round(cargasSinTransferencia.reduce((s, t) => s + Number(t.amount || 0), 0)) } },
    salidas: { count: outDone.length, total: _round(outDone.reduce((s, m) => s + Number(m.amount || 0), 0)), pagos: outPagos, pagosTotal: _round(sumPagos), bajadas: outBajadas, bajadasTotal: _round(sumBajadas), sinOrigen: outSinOrigen.length },
    pagos: { pagados: paidPayouts.length, total: _round(paidPayouts.reduce((s, p) => s + Number(p.amount || 0), 0)), otroBanco: pagosOtroBanco },
    transacciones: txTotals,
    // #157 lo que cruzó la medianoche: se resuelve solo con el recálculo del día siguiente.
    arrastre: { graceMinutes: graceMs / 60000, entrantes: arrastre.entrantes.slice(0, 50), pagos: arrastre.pagos.slice(0, 50), salidas: arrastre.salidas.slice(0, 50),
      total: arrastre.entrantes.length + arrastre.pagos.length + arrastre.salidas.length }
  };

  const unresolved = diffs.filter(d => !d.resolved).length;
  const status = unresolved > 0 ? 'diff' : (cashier.status === 'sin_datos' ? 'warn' : 'ok');
  const doc = await DailyClose.findOneAndUpdate(
    { dateKey: dayKey },
    { $set: { status, computedAt: new Date(), computedBy: opts.computedBy || 'cron', summary, cashier, bank, diffs, unresolvedCount: unresolved }, $inc: { runs: 1 }, $setOnInsert: { createdAt: new Date() } },
    { new: true, upsert: true }
  ).lean();
  return doc;
}

/** Marca un diff como resuelto (o lo reabre) y recalcula el estado del cierre. */
async function resolveDiff(dayKey, key, { by, note, reopen = false }) {
  const close = await DailyClose.findOne({ dateKey: dayKey });
  if (!close) return null;
  const d = (close.diffs || []).find(x => x.key === key);
  if (!d) return null;
  d.resolved = !reopen; d.resolvedBy = reopen ? null : (by || null); d.resolvedAt = reopen ? null : new Date(); d.note = reopen ? null : (note || null);
  close.unresolvedCount = close.diffs.filter(x => !x.resolved).length;
  close.status = close.unresolvedCount > 0 ? 'diff' : ((close.cashier && close.cashier.status === 'sin_datos') ? 'warn' : 'ok');
  await close.save();
  return close.toObject();
}

const TYPE_LABELS = {
  mov_sin_acreditar: 'Transferencias recibidas SIN acreditar',
  carga_sin_transferencia: 'Cargas SIN transferencia ni origen declarado',
  salida_sin_origen: 'Salidas del banco sin pago ni bajada',
  pago_sin_descuento: 'Pagos sin descuento de fichas confirmado',
  pago_sin_movimiento: 'Pagos hgcash sin movimiento bancario',
  ambiguo: 'Operaciones en VERIFICAR sin resolver',
  cajero_descuadre: 'Descuadre del cajero de JUGAYGANA'
};

/** Texto HTML (Telegram) del cierre. `esc` = escapador HTML del servicio de Telegram. */
function formatCloseTelegram(close, esc, projectLabel) {
  const s = close.summary || {}, c = close.cashier || {};
  const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR');
  const lines = [];
  lines.push(`🧾 <b>${esc(projectLabel || 'proyecto')}</b> — CIERRE ${esc(close.dateKey)}`);
  const un = close.unresolvedCount || 0;
  lines.push(un === 0 && close.status === 'ok' ? '✅ <b>0 diferencias</b> — todo cuadra' : (un === 0 ? '⚠️ Sin diferencias, pero falta el cruce con el cajero (sin operaciones registradas)' : `🔴 <b>${un} diferencia(s)</b> sin resolver`));
  lines.push(`⬇️ Entradas: ${s.entradas ? s.entradas.count : 0} · ${money(s.entradas && s.entradas.total)} (auto ${s.entradasCargadas ? s.entradasCargadas.auto : 0} · asignadas ${s.entradasCargadas ? s.entradasCargadas.asignadas : 0} · manuales ${s.entradasCargadas ? s.entradasCargadas.manuales : 0})`);
  lines.push(`💰 Cargas: ${s.cargas ? s.cargas.count : 0} · ${money(s.cargas && s.cargas.total)} (otro banco ${s.cargas && s.cargas.otroBanco ? s.cargas.otroBanco.count : 0})`);
  lines.push(`⬆️ Salidas: pagos ${s.salidas ? s.salidas.pagos : 0} · ${money(s.salidas && s.salidas.pagosTotal)} — bajadas ${s.salidas ? s.salidas.bajadas : 0} · ${money(s.salidas && s.salidas.bajadasTotal)}`);
  if (c.status && c.status !== 'sin_datos') {
    lines.push(`🎰 Cajero JUGAYGANA: real ${money(c.actualDelta)} vs. sistema ${money(c.expectedDelta)} → ${c.status === 'ok' ? '✅ cuadra' : '🔴 diferencia ' + money(c.diff)}`);
  }
  if (close.bank && close.bank.netBalance != null) lines.push(`🏦 Saldo hgcash al cierre: ${money(close.bank.netBalance)}`);
  if (s.arrastre && s.arrastre.total) lines.push(`⏭️ Arrastre a mañana (última hora del día, se verifica solo): ${s.arrastre.entrantes.length} entrada(s), ${s.arrastre.pagos.length} pago(s), ${s.arrastre.salidas.length} salida(s)`);
  const open = (close.diffs || []).filter(d => !d.resolved);
  if (open.length) {
    const byType = {};
    for (const d of open) { (byType[d.type] = byType[d.type] || []).push(d); }
    for (const t of Object.keys(byType)) {
      const arr = byType[t];
      const total = arr.reduce((a, d) => a + Math.abs(Number(d.amount || 0)), 0);
      lines.push(`• <b>${esc(TYPE_LABELS[t] || t)}</b>: ${arr.length} · ${money(total)}`);
      for (const d of arr.slice(0, 6)) lines.push(`   – ${esc(String(d.detail || '').slice(0, 160))}`);
      if (arr.length > 6) lines.push(`   – … y ${arr.length - 6} más (ver panel → 🏦 Banco → Cierre)`);
    }
  }
  return lines.join('\n');
}

module.exports = { computeDailyClose, resolveDiff, formatCloseTelegram, TYPE_LABELS, _artDateKey, _artDayRange };
