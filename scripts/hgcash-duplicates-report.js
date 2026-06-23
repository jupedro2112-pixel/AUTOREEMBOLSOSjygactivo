// =============================================================================
// REPORTE (SOLO LECTURA): cargas hgcash DUPLICADAS
// =============================================================================
// Detecta transferencias que se acreditaron MÁS DE UNA VEZ al mismo usuario,
// para poder descontar el sobrante a mano en JUGAYGANA.
//
// Distingue dos niveles de certeza:
//   1) DEFINITIVO  — mismo `coelsaCode` (la MISMA transferencia real) con 2+
//                    movimientos cargados (auto/manual). Esto es 100% duplicado:
//                    una sola transferencia que se cargó varias veces.
//   2) PROBABLE    — mismo usuario + mismo monto + 2+ cargas distintas dentro de
//                    una ventana corta (default 15 min) con coelsa distinto/ausente.
//                    OJO: puede ser una RECARGA LEGÍTIMA (el cliente transfirió dos
//                    veces el mismo monto). Hay que verificar a mano cada uno.
//
// NO modifica nada: sólo imprime. La corrección (descontar fichas) se hace a mano.
//
// Cómo ejecutarlo (en el servidor con shell, o local con la MONGODB_URI de prod):
//   node scripts/hgcash-duplicates-report.js
//   node scripts/hgcash-duplicates-report.js --window=20   (ventana en minutos para PROBABLE)
// =============================================================================

const mongoose = require('mongoose');
const path = require('path');

process.chdir(path.join(__dirname, '..'));
require('dotenv').config({ silent: true });

const CHARGED = ['auto_charged', 'manual_charged'];

function fmt(n) { return '$' + Number(n || 0).toLocaleString('es-AR'); }
function ts(d) { try { return new Date(d).toISOString().replace('T', ' ').slice(0, 19); } catch (_) { return String(d); } }

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('⛔ MONGODB_URI no definida. Setear la variable de entorno y reintentar.');
    process.exit(1);
  }
  const windowArg = (process.argv.find(a => a.startsWith('--window=')) || '').split('=')[1];
  const WINDOW_MIN = Number(windowArg) > 0 ? Number(windowArg) : 15;

  console.log('🔌 Conectando a MongoDB...');
  await mongoose.connect(uri);
  console.log('✅ Conectado\n');

  const BankMovement = require('../src/models/BankMovement');

  // ---------------------------------------------------------------------------
  // 1) DEFINITIVO: mismo coelsaCode cargado 2+ veces.
  // ---------------------------------------------------------------------------
  const dupByCoelsa = await BankMovement.aggregate([
    { $match: { direction: 'Inbound', coelsaCode: { $nin: [null, ''] }, matchStatus: { $in: CHARGED } } },
    { $group: {
        _id: '$coelsaCode',
        count: { $sum: 1 },
        amount: { $first: '$amount' },
        users: { $addToSet: '$matchedUsername' },
        userIds: { $addToSet: '$matchedUserId' },
        movements: { $push: { movementId: '$movementId', status: '$matchStatus', chargedAt: '$chargedAt', amount: '$amount' } }
    }},
    { $match: { count: { $gt: 1 } } },
    { $sort: { amount: -1 } }
  ]).allowDiskUse(true);

  console.log('==================================================================');
  console.log('  1) DUPLICADOS DEFINITIVOS  (mismo coelsaCode cargado 2+ veces)');
  console.log('==================================================================');
  let defOver = 0, defCount = 0;
  if (!dupByCoelsa.length) {
    console.log('  (ninguno) ✅');
  } else {
    for (const g of dupByCoelsa) {
      const extra = (g.count - 1) * Number(g.amount || 0); // lo cargado de más
      defOver += extra;
      defCount += 1;
      console.log(`\n  • coelsa=${g._id}  monto=${fmt(g.amount)}  cargas=${g.count}  SOBRANTE=${fmt(extra)}`);
      console.log(`    usuario(s): ${g.users.filter(Boolean).join(', ') || '(s/match)'}`);
      g.movements
        .sort((a, b) => new Date(a.chargedAt || 0) - new Date(b.chargedAt || 0))
        .forEach(m => console.log(`      - ${ts(m.chargedAt)}  ${m.status}  mov=${m.movementId}`));
    }
  }
  console.log(`\n  >>> Casos DEFINITIVOS: ${defCount} · sobrante total a descontar: ${fmt(defOver)}\n`);

  // ---------------------------------------------------------------------------
  // 2) PROBABLE: mismo usuario + mismo monto, 2+ cargas en ventana corta,
  //    con coelsa distinto/ausente (NO cubierto por el caso 1). Puede ser legítimo.
  // ---------------------------------------------------------------------------
  const coelsasDup = new Set(dupByCoelsa.map(g => g._id));
  const charged = await BankMovement.find({
    direction: 'Inbound', matchStatus: { $in: CHARGED }, matchedUserId: { $nin: [null, ''] }
  }).select('matchedUserId matchedUsername amount coelsaCode movementId matchStatus chargedAt createdAt').lean();

  // Agrupar por usuario+monto.
  const byUserAmount = new Map();
  for (const m of charged) {
    const key = `${m.matchedUserId}|${Math.round(Number(m.amount || 0) * 100)}`;
    if (!byUserAmount.has(key)) byUserAmount.set(key, []);
    byUserAmount.get(key).push(m);
  }

  const probable = [];
  for (const [, list] of byUserAmount) {
    list.sort((a, b) => new Date(a.chargedAt || a.createdAt || 0) - new Date(b.chargedAt || b.createdAt || 0));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const ta = new Date(a.chargedAt || a.createdAt || 0).getTime();
        const tb = new Date(b.chargedAt || b.createdAt || 0).getTime();
        const dtMin = Math.abs(tb - ta) / 60000;
        if (dtMin > WINDOW_MIN) continue;
        // Excluir los ya contados como DEFINITIVO (mismo coelsa).
        if (a.coelsaCode && b.coelsaCode && a.coelsaCode === b.coelsaCode) continue;
        if (coelsasDup.has(a.coelsaCode) && a.coelsaCode === b.coelsaCode) continue;
        probable.push({ user: a.matchedUsername || a.matchedUserId, amount: a.amount, dtMin: Math.round(dtMin),
          a: { mov: a.movementId, coelsa: a.coelsaCode, at: a.chargedAt || a.createdAt },
          b: { mov: b.movementId, coelsa: b.coelsaCode, at: b.chargedAt || b.createdAt } });
      }
    }
  }
  probable.sort((x, y) => Number(y.amount) - Number(x.amount));

  console.log('==================================================================');
  console.log(`  2) PROBABLES  (mismo usuario+monto en <${WINDOW_MIN} min, coelsa distinto)`);
  console.log('     ⚠️  REVISAR: puede ser recarga legítima del mismo monto.');
  console.log('==================================================================');
  if (!probable.length) {
    console.log('  (ninguno)');
  } else {
    for (const p of probable) {
      console.log(`\n  • ${p.user}  monto=${fmt(p.amount)}  +${p.dtMin} min`);
      console.log(`      A: ${ts(p.a.at)}  mov=${p.a.mov}  coelsa=${p.a.coelsa || '-'}`);
      console.log(`      B: ${ts(p.b.at)}  mov=${p.b.mov}  coelsa=${p.b.coelsa || '-'}`);
    }
  }
  console.log(`\n  >>> Pares PROBABLES (a verificar a mano): ${probable.length}\n`);

  console.log('==================================================================');
  console.log('  RESUMEN');
  console.log(`  DEFINITIVOS (descontar seguro): ${defCount} casos · ${fmt(defOver)}`);
  console.log(`  PROBABLES (revisar uno por uno): ${probable.length} pares`);
  console.log('==================================================================');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
