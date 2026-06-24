// =============================================================================
// LIMPIEZA de pagos VIEJOS colgados (paying / failed) — que "desaparezcan".
// =============================================================================
// Resuelve los PendingPayout viejos que quedaron en 'paying' o 'failed' (porque el
// webhook de hgcash no llegó) para que dejen de aparecer. Es SEGURO:
//   - DRY-RUN por defecto: solo muestra qué haría. Con --apply ejecuta.
//   - Verifica el estado REAL en hgcash (getTransactionStatus):
//       DONE              -> 'paid'      (silencioso: NO re-avisa ni re-paga)
//       ERROR / CANCELLED -> 'cancelled' (paidVia 'dismissed', NO devuelve fichas)
//       PENDING / s-dato  -> NO se toca  (sigue realmente pendiente -> se reporta)
//   - NUNCA mueve plata (no llama al cash-out). Solo actualiza el estado en la base.
//
// Cutoff: solo toca pagos con createdAt MÁS VIEJO que --hours (default 2h), para no
// pisar pagos recientes que el poller del back está confirmando.
//
// Uso (requiere MONGODB_URI; para verificar contra hgcash, HGCASH_API_TOKEN):
//   node scripts/hgcash-cleanup-old-payouts.js                 (dry-run, cutoff 2h)
//   node scripts/hgcash-cleanup-old-payouts.js --hours=6 --apply
//   node scripts/hgcash-cleanup-old-payouts.js --apply --no-verify
//        ^ sin chequear hgcash: marca TODO lo viejo como 'cancelled'. Usar SOLO si
//          estás 100% seguro de que esos pagos viejos ya se resolvieron a mano.
// =============================================================================

const mongoose = require('mongoose');
const path = require('path');

process.chdir(path.join(__dirname, '..'));
require('dotenv').config({ silent: true });

function arg(name) { return (process.argv.find(a => a.startsWith('--' + name + '=')) || '').split('=')[1]; }
function flag(name) { return process.argv.includes('--' + name); }
function fmt(n) { return '$' + Number(n || 0).toLocaleString('es-AR'); }

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('⛔ MONGODB_URI no definida.'); process.exit(1); }

  const HOURS = Number(arg('hours')) > 0 ? Number(arg('hours')) : 2;
  const APPLY = flag('apply');
  const VERIFY = !flag('no-verify');

  let hgcashPay = null;
  if (VERIFY) {
    hgcashPay = require('../src/services/hgcashService');
    if (!hgcashPay.isEnabled()) {
      console.error('⛔ HGCASH_API_TOKEN no configurado: no se puede verificar el estado real.');
      console.error('   Cargá el token, o corré con --no-verify (marca todo lo viejo como cancelado).');
      process.exit(1);
    }
  }

  console.log('🔌 Conectando a MongoDB...');
  await mongoose.connect(uri);
  console.log('✅ Conectado\n');
  const PendingPayout = require('../src/models/PendingPayout');

  const cutoff = new Date(Date.now() - HOURS * 60 * 60 * 1000);
  const STATES = ['pending_review', 'paying', 'failed'];
  const olds = await PendingPayout.find({ status: { $in: STATES }, createdAt: { $lt: cutoff } })
    .sort({ createdAt: 1 }).lean();

  console.log(`Modo: ${APPLY ? 'APLICAR ✍️' : 'DRY-RUN (no cambia nada) 👀'} · cutoff: >${HOURS}h · verificar hgcash: ${VERIFY ? 'sí' : 'NO'}`);
  console.log(`Pagos viejos (pending_review/paying/failed, más viejos que ${HOURS}h): ${olds.length}\n`);

  const counts = { paid: 0, cancelled: 0 };

  for (const p of olds) {
    const tag = `${p.username || p.userId} · ${fmt(p.amount)} · ${p.status} · ${new Date(p.createdAt).toISOString().slice(0, 16)}`;
    let decision;
    // Por defecto: DESCARTAR (sacar de la cola). Si verificamos y ya está DONE en hgcash, lo dejamos 'paid'.
    let set = { status: 'cancelled', paidVia: 'dismissed', chipsReturned: false, error: 'Limpieza de pago viejo (script)' };
    decision = '🗑️  -> cancelled (descartado)';

    if (VERIFY && p.hgTransactionId) {
      const st = await hgcashPay.getTransactionStatus(p.hgTransactionId);
      const S = (st.ok && st.status) ? String(st.status).toUpperCase() : null;
      if (S === 'DONE') { decision = '✅ DONE en hgcash -> paid (silencioso)'; set = { status: 'paid', hgStatus: 'DONE', paidAt: p.paidAt || new Date(), receiptSentAt: p.receiptSentAt || new Date() }; }
    }

    if (set.status === 'paid') counts.paid++; else counts.cancelled++;
    console.log(`  ${tag}\n     -> ${decision}`);
    if (APPLY) {
      await PendingPayout.updateOne({ id: p.id, status: { $in: STATES } }, { $set: set });
    }
  }

  console.log('\n==================================================================');
  console.log(`  RESUMEN  ${APPLY ? '(aplicado)' : '(DRY-RUN — nada cambió; agregá --apply para ejecutar)'}`);
  console.log(`  -> paid (ya pagados en hgcash): ${counts.paid}`);
  console.log(`  -> cancelled (descartados):     ${counts.cancelled}`);
  console.log('==================================================================');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
