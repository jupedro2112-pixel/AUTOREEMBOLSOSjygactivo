// =============================================================================
// MIGRACIÓN: activar el índice único de RefundClaim (anti doble cobro)
// =============================================================================
// Qué hace este script (una sola vez, ejecución manual):
//   1) Rellena el campo `periodKey` en todos los RefundClaim existentes que
//      no lo tengan, derivándolo de `claimedAt` + `type`.
//   2) Borra el índice viejo `{userId,type,periodKey} sparse` si existe en
//      la BD (no se puede usar `sparse` con valores null repetidos).
//   3) Crea el índice nuevo con `partialFilterExpression: { periodKey: string }`,
//      que sólo incluye los docs con periodKey seteado.
//
// Cómo ejecutarlo (en el servidor de Render con shell, o local con la
// MONGODB_URI de producción):
//   node scripts/migrate-refund-periodkey.js
//
// Es idempotente: si lo corrés dos veces no hace daño.
// =============================================================================

const mongoose = require('mongoose');
const path = require('path');

// Cargar la config / modelos.
process.chdir(path.join(__dirname, '..'));
require('dotenv').config({ silent: true });

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('⛔ MONGODB_URI no definida. Setear la variable de entorno y reintentar.');
    process.exit(1);
  }

  console.log('🔌 Conectando a MongoDB...');
  await mongoose.connect(uri);
  console.log('✅ Conectado');

  const RefundClaim = require('../src/models/RefundClaim');
  const collection = RefundClaim.collection;

  // ---------- 1) Backfill periodKey en docs viejos ----------
  console.log('\n📝 Paso 1: backfill de periodKey en RefundClaim existentes...');
  const cursor = RefundClaim.find({
    $or: [
      { periodKey: { $exists: false } },
      { periodKey: null },
      { periodKey: '' }
    ]
  }).cursor();

  let scanned = 0, updated = 0, skipped = 0;
  for await (const doc of cursor) {
    scanned++;
    const claimedAt = doc.claimedAt || doc.createdAt || new Date();
    // Fecha en horario Argentina (UTC-3) — coincide con cómo se calcula al crear.
    const ymd = new Date(claimedAt).toLocaleDateString('en-CA', {
      timeZone: 'America/Argentina/Buenos_Aires'
    }); // YYYY-MM-DD
    let pk = null;
    if (doc.type === 'daily') {
      pk = 'daily:' + ymd;
    } else if (doc.type === 'weekly') {
      // Lunes ART de la semana del claimedAt.
      const d = new Date(claimedAt);
      const dow = new Date(d.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })).getDay();
      const offsetToMonday = dow === 0 ? -6 : (1 - dow);
      const monday = new Date(d);
      monday.setDate(d.getDate() + offsetToMonday);
      const mondayYmd = monday.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
      pk = 'weekly:' + mondayYmd;
    } else if (doc.type === 'monthly') {
      pk = 'monthly:' + ymd.slice(0, 7); // YYYY-MM
    } else {
      skipped++;
      continue;
    }
    try {
      await RefundClaim.updateOne({ _id: doc._id }, { $set: { periodKey: pk } });
      updated++;
    } catch (e) {
      // Si choca con el índice único es porque ya había un duplicado real:
      // dejamos el segundo sin periodKey (queda fuera del índice) para no
      // perder el dato. Lo logueamos para revisión manual.
      console.warn(`⚠️  No se pudo setear periodKey en ${doc._id}: ${e.message}`);
      skipped++;
    }
  }
  console.log(`✅ Backfill: ${scanned} revisados, ${updated} actualizados, ${skipped} saltados`);

  // ---------- 2) Borrar el índice viejo (sparse) si existe ----------
  console.log('\n🗑️  Paso 2: borrar índice viejo (sparse) si existe...');
  const indexes = await collection.indexes();
  for (const idx of indexes) {
    const isOurs =
      idx.key &&
      idx.key.userId === 1 &&
      idx.key.type === 1 &&
      idx.key.periodKey === 1;
    if (isOurs) {
      // Borrarlo siempre que tenga sparse:true y NO partialFilterExpression
      // (la versión vieja). Si ya está como partialFilterExpression, lo dejamos.
      if (idx.sparse === true && !idx.partialFilterExpression) {
        try {
          await collection.dropIndex(idx.name);
          console.log(`✅ Borrado índice viejo: ${idx.name}`);
        } catch (e) {
          console.warn(`⚠️  No se pudo borrar ${idx.name}: ${e.message}`);
        }
      } else if (idx.partialFilterExpression) {
        console.log(`ℹ️  Índice nuevo ya existe (${idx.name}), no se toca.`);
      }
    }
  }

  // ---------- 3) Crear el índice nuevo (partialFilterExpression) ----------
  console.log('\n➕ Paso 3: crear índice único nuevo...');
  try {
    await collection.createIndex(
      { userId: 1, type: 1, periodKey: 1 },
      {
        unique: true,
        partialFilterExpression: { periodKey: { $type: 'string' } },
        name: 'userId_1_type_1_periodKey_1_partial'
      }
    );
    console.log('✅ Índice único creado (solo aplica a docs con periodKey string).');
  } catch (e) {
    if (String(e.message).includes('already exists')) {
      console.log('ℹ️  El índice ya existía con la misma definición.');
    } else {
      console.error('⛔ Error al crear el índice:', e.message);
      throw e;
    }
  }

  await mongoose.disconnect();
  console.log('\n🎉 Migración completada.');
  process.exit(0);
}

main().catch(function (err) {
  console.error('⛔ Error en la migración:', err);
  process.exit(1);
});
