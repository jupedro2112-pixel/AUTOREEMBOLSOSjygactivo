#!/usr/bin/env node
// Diagnóstico de conexión a una MONGODB_URI sin tocar producción.
// Uso:
//   node scripts/test-mongo-uri.js "mongodb+srv://USER:PASS@HOST/?appName=X"
// Reporta:
//   - Si pudo conectar
//   - Listado de bases de datos disponibles
//   - Cantidad de usuarios / refunds en cada base (si las hay)

const mongoose = require('mongoose');

const uri = process.argv[2];
if (!uri) {
  console.error('❌ Falta la URI. Uso: node scripts/test-mongo-uri.js "<MONGODB_URI>"');
  process.exit(1);
}

(async () => {
  console.log('🔌 Probando conexión a:', uri.replace(/:[^:@]+@/, ':****@'));
  const start = Date.now();

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 15000
    });
  } catch (err) {
    console.error(`❌ FALLA al conectar (${Date.now() - start}ms):`);
    console.error(`   ${err.name}: ${err.message}`);
    if (err.message.includes('IP') || err.message.includes('whitelist') || err.message.includes('not authorized')) {
      console.error('   → Revisar Network Access en Atlas (agregar 0.0.0.0/0).');
    }
    if (err.message.includes('authentication') || err.message.includes('bad auth')) {
      console.error('   → Usuario o contraseña incorrectos. Revisar Database Access en Atlas.');
    }
    if (err.message.includes('ENOTFOUND') || err.message.includes('querySrv')) {
      console.error('   → Hostname inválido. Verificar que la URI sea exacta.');
    }
    process.exit(2);
  }

  console.log(`✅ Conectado OK en ${Date.now() - start}ms`);
  console.log(`   readyState: ${mongoose.connection.readyState} (1=connected)`);
  console.log(`   host: ${mongoose.connection.host}`);
  console.log(`   db por defecto: ${mongoose.connection.name}`);

  try {
    const admin = mongoose.connection.db.admin();
    const result = await admin.listDatabases();
    console.log('\n📊 Bases de datos disponibles:');
    for (const db of result.databases) {
      console.log(`   - ${db.name} (${(db.sizeOnDisk / 1024).toFixed(1)} KB)`);
    }
  } catch (err) {
    console.warn(`⚠️  No se pudieron listar bases (${err.message}). Probablemente el usuario no tiene permiso de admin.`);
  }

  // Contar usuarios y refunds en la base por defecto
  try {
    const usersCount = await mongoose.connection.db.collection('users').countDocuments();
    const refundsCount = await mongoose.connection.db.collection('refundclaims').countDocuments();
    const messagesCount = await mongoose.connection.db.collection('messages').countDocuments();
    console.log(`\n📁 Base "${mongoose.connection.name}":`);
    console.log(`   users:        ${usersCount}`);
    console.log(`   refundclaims: ${refundsCount}`);
    console.log(`   messages:     ${messagesCount}`);
    if (usersCount === 0) {
      console.log('   ⚠️  La base está VACÍA. Si cambiás a esta URI, ningún usuario podrá loguearse hasta migrar los datos.');
    }
  } catch (err) {
    console.warn(`⚠️  No se pudo leer las collections en "${mongoose.connection.name}": ${err.message}`);
  }

  await mongoose.disconnect();
  console.log('\n✅ Test finalizado correctamente.');
  process.exit(0);
})();
