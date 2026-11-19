/**
 * Test EN FRÍO del motor de mudanza (#197) — sin DB, sin red, sin node_modules.
 * Simula las dos plataformas y la base en memoria y corre src/services/platform.js real.
 *   node scripts/test-platform-migration.js
 */
const Module = require('module');
const path = require('path');

// ---------- mini "Mongo" en memoria ----------
function match(doc, f) {
  return Object.keys(f || {}).every((k) => {
    const c = f[k];
    if (k === '$or') return c.some((x) => match(doc, x));
    const v = doc[k];
    if (c instanceof RegExp) return c.test(String(v || ''));
    if (c && typeof c === 'object' && !(c instanceof Date)) {
      return Object.keys(c).every((op) => {
        if (op === '$ne') return v !== c.$ne && !(c.$ne === null && v === undefined);
        if (op === '$lt') return v != null && v < c.$lt;
        if (op === '$lte') return v != null && v <= c.$lte;
        if (op === '$gte') return v != null && v >= c.$gte;
        if (op === '$not') return !match(doc, { [k]: c.$not });
        if (op === '$in') return c.$in.includes(v);
        throw new Error('op no soportado ' + op);
      });
    }
    return (v === undefined ? null : v) === c;
  });
}
function apply(doc, u, inserting) {
  if (u.$set) Object.assign(doc, u.$set);
  if (u.$inc) for (const k of Object.keys(u.$inc)) doc[k] = (doc[k] || 0) + u.$inc[k];
  if (inserting && u.$setOnInsert) Object.assign(doc, u.$setOnInsert);
  if (!u.$set && !u.$inc && !u.$setOnInsert) Object.assign(doc, u);
  doc.updatedAt = new Date();
}
function q(val) { const o = { select: () => o, lean: () => o, sort: () => o, limit: () => o, then: (a, b) => Promise.resolve(val).then(a, b), catch: (b) => Promise.resolve(val).catch(b) }; return o; }
function model() {
  const rows = [];
  return {
    rows,
    findOne: (f) => q(rows.find((d) => match(d, f)) || null),
    find: (f) => q(rows.filter((d) => match(d, f))),
    countDocuments: async (f) => rows.filter((d) => match(d, f)).length,
    aggregate: async () => [],
    updateOne: (f, u, o) => { let d = rows.find((x) => match(x, f)); let ins = false; if (!d && o && o.upsert) { d = {}; rows.push(d); ins = true; for (const k of Object.keys(f)) if (typeof f[k] !== 'object') d[k] = f[k]; } if (d) apply(d, u, ins); return q({ matchedCount: d ? 1 : 0 }); },
    findOneAndUpdate: (f, u, o) => { let d = rows.find((x) => match(x, f)); let ins = false; if (!d && o && o.upsert) { d = {}; rows.push(d); ins = true; } if (d) apply(d, u, ins); return q(d || null); }
  };
}
const User = model(), Config = model(), PM = model();

// ---------- plataformas simuladas ----------
const old = { bal: {}, withdrawMode: 'ok', calls: [], pass: {}, passMode: 'ok' };
const neu = { bal: {}, refs: {}, depositMode: 'ok', exists: new Set(), calls: [], createdWith: {}, opKeys: [] };
let resolver = null;
async function keyOf(u) { const k = resolver ? await resolver(u) : null; return k || 'KEY_GENERAL'; }
const jugaygana = {
  errToString: (e) => (typeof e === 'string' ? e : JSON.stringify(e || '')),
  withdrawFromUser: async (u, amt) => {
    old.calls.push(['withdraw', u, amt]);
    if (old.withdrawMode === 'ambiguous') return { success: false, ambiguous: true, error: 'HTML' };
    if (old.withdrawMode === 'fail') return { success: false, error: 'rechazado' };
    old.bal[u] -= amt; return { success: true, data: { transfer_id: 'T1' } };
  },
  depositToUser: async (u, amt) => { old.calls.push(['deposit', u, amt]); old.bal[u] = (old.bal[u] || 0) + amt; return { success: true, data: {} }; },
  creditUserBalance: async (u, amt) => { old.calls.push(['credit', u, amt]); old.bal[u] = (old.bal[u] || 0) + amt; return { success: true, data: {} }; }
};
const jugayganaMovements = {
  getUserBalance: async (u) => ({ success: true, balance: old.bal[u] || 0, username: u }),
  getUserBalanceWithRetry: async (u) => ({ success: true, balance: old.bal[u] || 0, username: u }),
  makeBonus: async () => ({ success: true }), getUserMovements: async () => ({ success: true })
};
const girox = {
  setKeyResolver: (fn) => { resolver = fn; },
  isEnabled: () => true, errToString: (e) => String(e || ''), getPlayUrl: () => 'https://jugaygana.io',
  // cada key solo ve a los jugadores creados con ella (igual que la plataforma real)
  lookupPlayer: async (u) => { const k = await keyOf(u); if (k === 'pk_sin_resolver') return { state: 'error', error: '401' }; return (neu.exists.has(u) && (neu.createdWith[u] || 'KEY_GENERAL') === k) ? { state: 'found', player: { balance: neu.bal[u] || 0 } } : { state: 'not_found' }; },
  createPlatformUser: async ({ username }) => { if (neu.exists.has(username)) return { success: false, alreadyExists: true, error: 'tomado' }; neu.exists.add(username); neu.createdWith[username] = await keyOf(username); return { success: true }; },
  depositToUser: async (u, amt, d, ref) => {
    neu.calls.push(['deposit', u, amt, ref]); neu.opKeys.push([u, await keyOf(u)]);
    if (neu.depositMode === 'down') return { success: false, error: 'timeout', httpStatus: null };
    if (neu.depositMode === 'nofunds') return { success: false, error: 'sin fichas', code: 'insufficient_funds', httpStatus: 422 };
    if (neu.refs[ref]) return { success: true, duplicate: true, data: { transfer_id: ref } };
    neu.refs[ref] = amt; neu.bal[u] = (neu.bal[u] || 0) + amt; return { success: true, data: { transfer_id: ref } };
  },
  withdrawFromUser: async (u, amt, d, ref) => { neu.calls.push(['withdraw', u, amt, ref]); return { success: false, error: 'boom', httpStatus: 503 }; },
  creditUserBalance: async (u, amt, ref) => { neu.calls.push(['credit', u, amt, ref]); neu.bal[u] = (neu.bal[u] || 0) + amt; return { success: true, data: {} }; },
  getUserBalance: async (u) => ({ success: true, username: u, balance: neu.bal[u] || 0, available: neu.bal[u] || 0 }),
  getUserBalanceWithRetry: async (u) => ({ success: true, username: u, balance: neu.bal[u] || 0, available: neu.bal[u] || 0 })
};

const stubs = {
  uuid: { v4: () => 'u' + Math.random().toString(36).slice(2) },
  [path.resolve(__dirname, '../src/utils/logger.js')]: { info() {}, warn() {}, error() {}, debug() {} },
  [path.resolve(__dirname, '../jugaygana.js')]: jugaygana,
  [path.resolve(__dirname, '../jugaygana-movements.js')]: jugayganaMovements,
  [path.resolve(__dirname, '../src/services/jugayganaService.js')]: {
    changeUserPasswordAsAdmin: async (u, p) => { old.calls.push(['password', u]); if (old.passMode === 'fail') return { success: false, error: 'IP bloqueada / HTML' }; old.pass[u] = p; return { success: true }; }
  },
  [path.resolve(__dirname, '../src/services/referralRevenueService.js')]: {},
  [path.resolve(__dirname, '../src/services/giroxService.js')]: girox,
  [path.resolve(__dirname, '../src/models/User.js')]: User,
  [path.resolve(__dirname, '../src/models/Config.js')]: Config,
  [path.resolve(__dirname, '../src/models/PlatformMigration.js')]: PM
};
const origResolve = Module._resolveFilename, origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (stubs[request]) return stubs[request];
  let resolved = null; try { resolved = origResolve.call(Module, request, parent, ...rest); } catch (_) {}
  if (resolved && stubs[resolved]) return stubs[resolved];
  return origLoad.call(Module, request, parent, ...rest);
};
const plat = require('../src/services/platform');
const alerts = []; plat.setHooks({ alert: async (t) => alerts.push(t), note: async () => {} });

let fails = 0;
function ok(cond, name) { console.log((cond ? '  ✅ ' : '  ❌ ') + name); if (!cond) fails++; }
function addUser(name, oldBal, inNew = true) {
  const u = { id: 'id-' + name, username: name, usernameLower: name, role: 'user', platform: 'jugaygana', platformMigrating: false, jugayganaUserId: 7 };
  User.rows.push(u); old.bal[name] = oldBal; if (inNew) neu.exists.add(name); return u;
}
const U = (n) => User.rows.find((x) => x.username === n);
const M = (n) => PM.rows.find((x) => x.username === n);
async function cfg(patch) { await plat.saveMigrationConfig(patch, 'test'); }

(async () => {
  console.log('1) Mudanza APAGADA: todo sigue en la vieja');
  addUser('ana', 5000);
  let r = await plat.migrateUser('id-ana');
  ok(r.status === 'skip' && U('ana').platform === 'jugaygana', 'no se muda');
  r = await plat.depositToUser('ana', 1000, 'x', 7);
  ok(r.success && old.bal.ana === 6000 && neu.calls.length === 0, 'la carga va a la vieja y la nueva ni se toca');

  console.log('2) Modo lista: solo los de la lista');
  addUser('beto', 300);
  await cfg({ mode: 'list', usernames: ['ana'] });
  r = await plat.migrateUser('id-beto');
  ok(r.status === 'skip' && U('beto').platform === 'jugaygana', 'beto (fuera de la lista) no se muda');
  r = await plat.migrateUser('id-ana');
  ok(r.status === 'done' && U('ana').platform === 'partner', 'ana se muda');
  ok(old.bal.ana === 0 && neu.bal.ana === 6000, 'el saldo pasó entero: vieja 0, nueva 6000');
  ok(M('ana').reference === 'vip-mig-id-ana-r1' && U('ana').platformMigrating === false, 'reference fija y candado liberado');
  r = await plat.depositToUser('ana', 500, 'x', 7, { reference: 'vip-hg-abc' });
  ok(r.success && neu.bal.ana === 6500 && old.bal.ana === 0, 'la carga siguiente ya entra en la nueva');
  r = await plat.migrateUser('id-ana');
  ok(r.status === 'done' && neu.bal.ana === 6500, 'repetir la mudanza no mueve nada');

  console.log('3) Modo todos: se muda al cargar');
  await cfg({ mode: 'all' });
  r = await plat.depositToUser('beto', 1000, 'x', 7);
  ok(r.success && U('beto').platform === 'partner' && neu.bal.beto === 1300 && old.bal.beto === 0, 'beto: saldo trasladado (300) + carga (1000) en la nueva');

  console.log('4) Tope $200.000');
  addUser('rico', 250000);
  r = await plat.migrateUser('id-rico');
  ok(r.status === 'held' && r.reason === 'cap' && old.bal.rico === 250000 && !neu.bal.rico, 'frenado, no se movió nada');
  ok(U('rico').platformMigrating === false && alerts.some((a) => /rico/.test(a) && /aprobaci/.test(a)), 'sin candado y con aviso');
  r = await plat.depositToUser('rico', 1000, 'x', 7);
  ok(r.success && old.bal.rico === 251000, 'mientras tanto sigue operando en la vieja');
  r = await plat.migrateUser('id-rico', { force: true, by: 'admin' });
  ok(r.status === 'done' && neu.bal.rico === 251000 && old.bal.rico === 0, 'aprobado por el admin: se muda con todo');

  console.log('5) No existe en la nueva');
  addUser('nuevo', 100, false);
  await cfg({ createMissing: false });
  r = await plat.migrateUser('id-nuevo');
  ok(r.status === 'held' && r.reason === 'not_in_new' && old.bal.nuevo === 100, 'con "crear" apagado: espera la copia, no se movió nada');
  await cfg({ createMissing: true });
  r = await plat.migrateUser('id-nuevo', { force: true });
  ok(r.status === 'done' && neu.exists.has('nuevo') && neu.bal.nuevo === 100 && old.bal.nuevo === 0, 'con "crear" prendido: se crea y se le pasa el saldo');

  console.log('6) Ya tiene saldo en la nueva');
  addUser('doble', 400); neu.bal.doble = 400;
  r = await plat.migrateUser('id-doble');
  ok(r.status === 'held' && r.reason === 'new_has_balance' && old.bal.doble === 400 && neu.bal.doble === 400, 'frenado: no se duplica el saldo');

  console.log('7) Retiro AMBIGUO en la vieja');
  addUser('dudoso', 900); old.withdrawMode = 'ambiguous';
  const before = neu.calls.length;
  r = await plat.migrateUser('id-dudoso');
  ok(r.status === 'review' && neu.calls.length === before, 'queda en revisión y NO se carga nada en la nueva');
  ok(U('dudoso').platform === 'jugaygana' && U('dudoso').platformMigrating === true, 'sigue en la vieja y con candado mientras se verifica solo (#201)');
  r = await plat.migrateUser('id-dudoso');
  ok(r.status === 'review' && old.calls.filter((c) => c[0] === 'withdraw' && c[1] === 'dudoso').length === 1, 'no se reintenta sola');
  const al0 = alerts.length;
  old.bal.dudoso = 400; // el saldo cambió: no se puede saber solo
  await plat.migrationTick();
  ok(M('dudoso').status === 'review' && U('dudoso').platformMigrating === true && alerts.length === al0, 'saldo distinto dentro de la ventana: sigue verificando, sin molestar a nadie todavía');
  M('dudoso').reviewAutoUntil = new Date(Date.now() - 1000);
  await plat.migrationTick();
  ok(M('dudoso').status === 'review' && U('dudoso').platformMigrating === false && alerts.length === al0 + 1 && !M('dudoso').reviewAutoUntil, 'terminada la ventana sin certeza: se suelta el candado y se avisa a una persona');
  // otro usuario: el saldo quedó intacto → el retiro no se hizo → se cancela sola y se reintenta
  addUser('dudoso2', 600);
  r = await plat.migrateUser('id-dudoso2');
  ok(r.status === 'review' && old.bal.dudoso2 === 600, 'dudoso2: retiro dudoso, saldo intacto en la vieja');
  await plat.migrationTick();
  ok(M('dudoso2').status === 'failed' && U('dudoso2').platformMigrating === false && !neu.bal.dudoso2, 'saldo intacto → la mudanza se CANCELA sola (sin persona, sin plata movida)');
  old.withdrawMode = 'ok'; M('dudoso2').updatedAt = new Date(Date.now() - 3600000);
  r = await plat.migrateUser('id-dudoso2');
  ok(r.status === 'done' && neu.bal.dudoso2 === 600 && old.bal.dudoso2 === 0, 'y en su próxima entrada se muda bien');
  old.withdrawMode = 'ambiguous';
  old.withdrawMode = 'ok'; old.bal.dudoso = 0; // el admin verificó: el retiro SÍ se había hecho
  r = await plat.resolveReview('id-dudoso', { withdrawn: true, by: 'admin' });
  ok(r.ok && U('dudoso').platform === 'partner' && neu.bal.dudoso === 900, 'el admin confirma el retiro → se cargan los 900 en la nueva');

  console.log('8) La nueva no responde después de retirar');
  addUser('caido', 700); neu.depositMode = 'down';
  r = await plat.migrateUser('id-caido');
  ok(r.status === 'deposit_pending' && old.bal.caido === 0 && !neu.bal.caido, 'retirado de la vieja, carga pendiente');
  ok(U('caido').platformMigrating === true && U('caido').platform === 'jugaygana', 'usuario con candado');
  r = await plat.depositToUser('caido', 100, 'x', 7);
  ok(!r.success && r.code === 'migrating' && old.bal.caido === 0, 'una carga en el medio se rechaza (no va a ninguna plataforma)');
  const b = await plat.getUserBalance('caido');
  ok(b.success && b.balance === 700, 'el cliente sigue viendo sus 700');
  neu.depositMode = 'ok';
  PM.rows.find((x) => x.username === 'caido').lockedAt = new Date(Date.now() - 120000);
  await plat.migrationTick();
  ok(U('caido').platform === 'partner' && neu.bal.caido === 700 && U('caido').platformMigrating === false, 'el reintento automático lo termina');
  ok(new Set(neu.calls.filter((c) => c[1] === 'caido').map((c) => c[3])).size === 1, 'siempre con la MISMA reference');

  console.log('9) La nueva sin fichas → pausa automática');
  addUser('sinfichas', 50); neu.depositMode = 'nofunds';
  r = await plat.migrateUser('id-sinfichas');
  const c9 = await plat.getMigrationConfig({ fresh: true });
  ok(r.status === 'deposit_pending' && !!c9.pausedTeams.default && c9.paused === false, 'se frena SOLO ese equipo (General)');
  addUser('otro', 10);
  r = await plat.migrateUser('id-otro');
  ok(r.status === 'skip' && old.bal.otro === 10, 'no se empieza ninguna mudanza nueva en ese equipo');
  neu.depositMode = 'ok';
  PM.rows.find((x) => x.username === 'sinfichas').lockedAt = new Date(Date.now() - 120000);
  await plat.migrationTick();
  ok(U('sinfichas').platform === 'partner' && neu.bal.sinfichas === 50, 'la pendiente entra sola cuando hay fichas');

  await cfg({ pausedTeams: {} });
  console.log('10) Error transitorio de la nueva = AMBIGUO para los callers');
  r = await plat.withdrawFromUser('ana', 100, 'x', 7, { reference: 'vip-payout-1' });
  ok(!r.success && r.ambiguous === true, 'un 503 se informa como ambiguous (no se reintenta ni se libera la reserva)');

  console.log('11) Usuario sin saldo');
  await cfg({ paused: false });
  addUser('cero', 0);
  r = await plat.migrateUser('id-cero');
  ok(r.status === 'done' && U('cero').platform === 'partner' && !old.calls.some((c) => c[1] === 'cero'), 'se muda sin mover plata');

  console.log('12) EQUIPOS: cada usuario se crea con la key de su equipo');
  plat.setTeams([{ id: 'tA', name: 'ATOMIC', prefixes: ['ato'], key: 'KEY_ATOMIC' }, { id: 'tB', name: 'ATOMIC VIP', prefixes: ['atovip'], key: 'KEY_VIP' }, { id: 'tC', name: 'SINKEY', prefixes: ['zz'], key: null }]);
  ok(plat.teamForUsername('AtoJuan299') === 'tA' && plat.teamForUsername('atovip_1') === 'tB' && plat.teamForUsername('pedro') === 'default', 'el inicio elige el equipo (gana el más largo; sin coincidencia → General)');
  addUser('atojuan299', 10560, false);
  r = await plat.migrateUser('id-atojuan299');
  ok(r.status === 'done' && neu.createdWith.atojuan299 === 'KEY_ATOMIC', 'atojuan299 se crea con la key de ATOMIC');
  ok(neu.bal.atojuan299 === 10560 && old.bal.atojuan299 === 0 && U('atojuan299').partnerTeam === 'tA', 'se le pasan los $10.560 y queda fijo en ATOMIC');
  ok(neu.opKeys.filter((x) => x[0] === 'atojuan299').every((x) => x[1] === 'KEY_ATOMIC'), 'la carga del traslado se firmó con la key de ATOMIC');
  r = await plat.depositToUser('atojuan299', 500, 'x', 7, { reference: 'vip-hg-zz1' });
  ok(r.success && neu.opKeys[neu.opKeys.length - 1][1] === 'KEY_ATOMIC' && neu.bal.atojuan299 === 11060, 'sus cargas siguientes también');
  plat.setTeams([{ id: 'tA', name: 'ATOMIC', prefixes: ['otro'], key: 'KEY_ATOMIC' }]);
  r = await plat.depositToUser('atojuan299', 100, 'x', 7, { reference: 'vip-hg-zz2' });
  ok(r.success && neu.opKeys[neu.opKeys.length - 1][1] === 'KEY_ATOMIC', 'aunque después cambie la tabla de inicios, sigue con SU key');
  plat.setTeams([{ id: 'tA', name: 'ATOMIC', prefixes: ['ato'], key: 'KEY_ATOMIC' }, { id: 'tC', name: 'SINKEY', prefixes: ['zz'], key: null }]);
  addUser('pedro77', 200, false);
  r = await plat.migrateUser('id-pedro77');
  ok(r.status === 'done' && neu.createdWith.pedro77 === 'KEY_GENERAL' && U('pedro77').partnerTeam === 'default', 'sin inicio reconocido → key general');
  addUser('zzluis', 300, false);
  r = await plat.migrateUser('id-zzluis');
  ok(r.status === 'held' && r.reason === 'team_no_key' && old.bal.zzluis === 300 && !neu.exists.has('zzluis'), 'equipo sin key cargada: frenado, no se movió nada');
  addUser('atorepe', 400, false); neu.exists.add('atorepe'); neu.createdWith.atorepe = 'KEY_GENERAL';
  r = await plat.migrateUser('id-atorepe');
  ok(r.status === 'held' && r.reason === 'foreign' && old.bal.atorepe === 400, 'el nombre ya existe en otro equipo: frenado, no se movió nada');

  console.log('13) Un equipo sin fichas no frena a los demás');
  addUser('atosinfichas', 80, false); neu.depositMode = 'nofunds';
  r = await plat.migrateUser('id-atosinfichas');
  const c13 = await plat.getMigrationConfig({ fresh: true });
  ok(r.status === 'deposit_pending' && !!c13.pausedTeams.tA && !c13.pausedTeams.default, 'se frena ATOMIC, no General');
  neu.depositMode = 'ok';
  addUser('maria', 60, false);
  r = await plat.migrateUser('id-maria');
  ok(r.status === 'done' && neu.bal.maria === 60, 'un usuario de General se muda igual');
  addUser('atootro', 70, false);
  r = await plat.migrateUser('id-atootro');
  ok(r.status === 'skip' && old.bal.atootro === 70, 'otro de ATOMIC espera');

  console.log('14) Botón del casino');
  let pc = await plat.prepareCasino('id-atojuan299');
  ok(pc.partner === true && pc.pending === false, 'mudado → entra directo a la nueva');
  addUser('casinero', 900, false);
  pc = await plat.prepareCasino('id-casinero');
  ok(pc.partner === true && neu.bal.casinero === 900 && old.bal.casinero === 0, 'sin mudar → se muda al tocar el botón y recién ahí entra');
  pc = await plat.prepareCasino('id-zzluis');
  ok(pc.partner === false && pc.pending === false, 'frenado → se le abre la página vieja, donde sigue su saldo');

  console.log('15) #198 Cierre de la cuenta VIEJA (clave al azar en JUGAYGANA)');
  await new Promise((r) => setTimeout(r, 20)); // deja correr los cierres en segundo plano de las mudanzas anteriores
  const pw = old.pass.ana;
  ok(typeof pw === 'string' && pw.length === 20 && /^[A-Za-z0-9]+$/.test(pw) && pw !== 'ana', 'a ana (ya mudada) se le puso una clave al azar en la vieja');
  ok(M('ana').oldLocked === true && !!M('ana').oldLockedAt, 'queda marcada como cuenta vieja cerrada');
  ok(!User.rows.some((u) => u.password === pw) && !PM.rows.some((m) => Object.values(m).includes(pw)), 'la clave al azar NO se guarda en ningún lado');
  ok(!Object.keys(old.pass).some((u) => U(u) && U(u).platform !== 'partner'), 'solo se cierran cuentas de usuarios ya mudados');
  // apagado: no se cierra
  await cfg({ mode: 'all', paused: false, pausedTeams: {}, lockOldAccount: false });
  addUser('lock1', 100);
  r = await plat.migrateUser('id-lock1');
  await new Promise((r) => setTimeout(r, 20)); await plat.migrationTick();
  ok(r.status === 'done' && !old.pass.lock1 && !M('lock1').oldLocked, 'con el interruptor apagado se muda pero la vieja queda abierta');
  // se prende: el tick cierra a los que quedaron abiertos
  await cfg({ lockOldAccount: true });
  await plat.migrationTick();
  ok(!!old.pass.lock1 && M('lock1').oldLocked === true, 'al prenderlo, el tick cierra a los ya mudados que quedaron abiertos');
  // JUGAYGANA falla: la mudanza termina igual y se reintenta después
  old.passMode = 'fail';
  addUser('lock2', 200);
  r = await plat.migrateUser('id-lock2');
  await new Promise((r) => setTimeout(r, 20));
  ok(r.status === 'done' && U('lock2').platform === 'partner' && neu.bal.lock2 === 200, 'si JUGAYGANA falla al cambiar la clave, la mudanza queda hecha igual');
  ok(M('lock2').oldLocked !== true && M('lock2').oldLockAttempts === 1 && /HTML/.test(M('lock2').oldLockError || ''), 'queda abierta con el error y el intento contado');
  const n0 = old.calls.filter((c) => c[0] === 'password' && c[1] === 'lock2').length;
  await plat.migrationTick();
  ok(old.calls.filter((c) => c[0] === 'password' && c[1] === 'lock2').length === n0, 'no reintenta antes de la espera (backoff)');
  old.passMode = 'ok';
  M('lock2').oldLockNextAt = new Date(Date.now() - 1000);
  await plat.migrationTick();
  ok(M('lock2').oldLocked === true, 'pasada la espera, el tick la cierra');
  // botón del panel (force) y usuario no mudado
  addUser('nomud', 50); // nunca se mudó (no hay PlatformMigration done)
  r = await plat.lockOldAccount('id-nomud', { force: true });
  ok(!r.ok && !old.pass.nomud, 'a un usuario NO mudado no se le toca la cuenta vieja (ni forzando)');
  r = await plat.lockOldAccount('id-lock2', { force: true, by: 'admin' });
  ok(r.ok, 'el botón del panel vuelve a cerrar aunque ya esté cerrada');

  console.log('16) #201 Plata que aparece en la vieja después de mudar: se traslada sola');
  old.passMode = 'ok'; neu.depositMode = 'ok'; old.withdrawMode = 'ok';
  await cfg({ mode: 'all', paused: false, pausedTeams: {}, capARS: 200000 });
  addUser('resi1', 1000);
  r = await plat.migrateUser('id-resi1');
  ok(r.status === 'done' && neu.bal.resi1 === 1000 && M('resi1').oldRecheckCount === 0, 'mudado; primera revisión programada');
  ok(M('resi1').oldRecheckAt - Date.now() < 11 * 60 * 1000, 'la primera revisión es a los 10 minutos (no a la hora)');
  old.bal.resi1 = 350; // apuesta que pagó después
  M('resi1').oldRecheckAt = new Date(Date.now() - 1000);
  await plat.migrationTick();
  ok(old.bal.resi1 === 0 && neu.bal.resi1 === 1350, 'el residuo pasó solo: vieja 0, nueva 1350');
  ok(M('resi1').residualPhase === null && M('resi1').residualMoved === 350 && M('resi1').residualRef === 'vip-mig-id-resi1-r2', 'queda registrado con reference propia (r2)');
  // residuo con la nueva caída: queda retirado y se reintenta con la misma reference
  old.bal.resi1 = 200; neu.depositMode = 'down';
  M('resi1').oldRecheckAt = new Date(Date.now() - 1000);
  await plat.migrationTick();
  ok(old.bal.resi1 === 0 && neu.bal.resi1 === 1350 && M('resi1').residualPhase === 'withdrawn' && M('resi1').residualAmount === 200, 'nueva caída: retirado de la vieja, pendiente de cargar (persistido)');
  r = await plat.moveOldResidual('id-resi1', 'admin');
  ok(!r.ok && old.calls.filter((c) => c[0] === 'withdraw' && c[1] === 'resi1').length === 3, 'mientras está pendiente NO se retira de nuevo en la vieja');
  neu.depositMode = 'ok';
  M('resi1').residualAt = new Date(Date.now() - 60000);
  await plat.migrationTick();
  ok(neu.bal.resi1 === 1550 && M('resi1').residualPhase === null && M('resi1').residualMoved === 550, 'cuando la nueva vuelve, el tick lo carga (una sola vez)');
  M('resi1').residualPhase = 'withdrawn'; M('resi1').residualAmount = 200; M('resi1').residualRef = 'vip-mig-id-resi1-r3'; M('resi1').residualAt = new Date(Date.now() - 60000);
  await plat.migrationTick();
  ok(neu.bal.resi1 === 1550, 'repetir la misma reference no duplica la plata');
  // retiro ambiguo del residuo → queda para una persona
  old.bal.resi1 = 90; old.withdrawMode = 'ambiguous';
  r = await plat.moveOldResidual('id-resi1', 'admin');
  ok(!r.ok && r.ambiguous && M('resi1').residualPhase === 'withdrawing' && neu.bal.resi1 === 1550, 'retiro ambiguo: no se carga nada y queda a medias para revisar');
  r = await plat.moveOldResidual('id-resi1', 'admin');
  ok(!r.ok, 'a medias: no se puede lanzar otro traslado encima');
  old.withdrawMode = 'ok';
  r = await plat.resolveResidual('id-resi1', { withdrawn: false, by: 'admin' });
  ok(r.ok && M('resi1').residualPhase === null && neu.bal.resi1 === 1550, 'resuelto "NO se hizo": se libera sin cargar');
  r = await plat.moveOldResidual('id-resi1', 'admin');
  ok(r.ok && r.amount === 90 && neu.bal.resi1 === 1640 && old.bal.resi1 === 0, 'y ahora sí se traslada');
  // por encima del tope: no se mueve solo
  await cfg({ capARS: 100 });
  old.bal.resi1 = 5000; M('resi1').oldRecheckAt = new Date(Date.now() - 1000); M('resi1').oldRecheckCount = 0;
  await plat.migrationTick();
  ok(old.bal.resi1 === 5000 && M('resi1').oldResidual === 5000, 'residuo mayor al tope: no se mueve solo, queda para aprobar');
  await cfg({ capARS: 200000 });

  console.log('17) #201 Cupo de mudanzas en segundo plano');
  for (let i = 0; i < 10; i++) addUser('bg' + i, 10);
  for (let i = 0; i < 10; i++) plat.migrateInBackground('id-bg' + i, 'app_open');
  await new Promise((r) => setTimeout(r, 50));
  const bgDone = User.rows.filter((u) => /^bg\d/.test(u.username) && u.platform === 'partner').length;
  ok(bgDone === 4, 'de 10 que abren la app a la vez, se mudan 4 (el cupo); el resto en su próxima apertura (' + bgDone + ')');
  ok(User.rows.filter((u) => /^bg\d/.test(u.username) && u.platformMigrating).length === 0, 'ninguno de los que no entró queda con candado');
  plat.migrateInBackground('id-bg9', 'app_open');
  await new Promise((r) => setTimeout(r, 50));
  ok(U('bg9').platform === 'partner', 'liberado el cupo, el siguiente se muda (sin esperar el minuto de throttle)');
  r = await plat.depositToUser('bg8', 100, 'x', 7);
  ok(r.success && U('bg8').platform === 'partner' && neu.bal.bg8 === 110, 'la carga no depende del cupo: muda y carga en la nueva');

  console.log('18) #201 Hallazgos de la auditoría');
  old.withdrawMode = 'fail'; neu.depositMode = 'ok';
  addUser('wdf', 800);
  r = await plat.migrateUser('id-wdf');
  ok(r.status === 'failed' && M('wdf').wdFailAmount === 800, 'la vieja "rechaza" el retiro: mudanza cancelada, queda anotado el intento');
  old.bal.wdf = 0; old.withdrawMode = 'ok'; // en realidad el retiro SÍ se había hecho
  M('wdf').updatedAt = new Date(Date.now() - 3600000);
  const depBefore = neu.calls.filter((c) => c[1] === 'wdf').length;
  r = await plat.migrateUser('id-wdf');
  ok(r.status === 'review' && U('wdf').platform === 'jugaygana' && neu.calls.filter((c) => c[1] === 'wdf').length === depBefore, 'al reintentar el saldo bajó justo ese monto → REVISIÓN, no se muda "lo que queda" (antes se perdían los 800)');
  r = await plat.resolveReview('id-wdf', { withdrawn: true, by: 'admin' });
  ok(r.ok && neu.bal.wdf === 800 && U('wdf').platform === 'partner', 'confirmado por el admin: los 800 entran en la nueva');
  // rechazo real (saldo intacto): el siguiente intento muda normal
  old.withdrawMode = 'fail'; addUser('wdf2', 300);
  await plat.migrateUser('id-wdf2');
  old.withdrawMode = 'ok'; M('wdf2').updatedAt = new Date(Date.now() - 3600000);
  r = await plat.migrateUser('id-wdf2');
  ok(r.status === 'done' && neu.bal.wdf2 === 300, 'rechazo real (saldo intacto): el reintento muda normal');
  // dos procesos terminando la misma carga a la vez
  addUser('tripl', 500); neu.depositMode = 'down';
  await plat.migrateUser('id-tripl');
  neu.depositMode = 'ok';
  const d0 = neu.calls.filter((c) => c[0] === 'deposit' && c[1] === 'tripl').length;
  const rr = await Promise.all([plat.migrateUser('id-tripl'), plat.migrateUser('id-tripl'), plat.migrateUser('id-tripl')]);
  ok(neu.calls.filter((c) => c[0] === 'deposit' && c[1] === 'tripl').length === d0 + 1 && neu.bal.tripl === 500, 'tres procesos a la vez: UNA sola carga en la nueva');
  ok(U('tripl').platform === 'partner' && U('tripl').platformMigrating === false && M('tripl').status === 'done' && rr.some((x) => x.status === 'done'), 'queda mudado y sin candado (nadie lo pisa con "pendiente")');
  // cortacorriente: 3 fallas seguidas de la nueva → no se arrancan mudanzas nuevas
  const realLookup = girox.lookupPlayer;
  girox.lookupPlayer = async () => ({ state: 'error', error: 'timeout' });
  for (const n of ['cb1', 'cb2', 'cb3', 'cb4']) addUser(n, 50);
  await plat.migrateUser('id-cb1'); await plat.migrateUser('id-cb2'); await plat.migrateUser('id-cb3');
  let lookups = 0; girox.lookupPlayer = async () => { lookups++; return { state: 'error', error: 'timeout' }; };
  r = await plat.migrateUser('id-cb4');
  ok(r.status === 'skip' && lookups === 0 && U('cb4').platformMigrating === false && old.bal.cb4 === 50, 'con la nueva caída (3 fallas seguidas) ni se intenta: el usuario sigue en la vieja intacto');
  girox.lookupPlayer = realLookup;
  r = await plat.depositToUser('cb4', 10, 'x', 7);
  ok(r.success && old.bal.cb4 === 60, 'y su carga entra normal en la vieja, sin esperar a la plataforma caída');

  // #204 Corte fijo del 1-ene-2027 (hora Argentina): un mudado deja de sumar lo jugado en la vieja.
  {
    const rrs = require('../src/services/referralRevenueService.js');
    let oldCalls = 0;
    rrs.getUserNetwinForDateRange = async () => { oldCalls++; return { success: true, totalGgr: 700, totalBets: 1000, totalWins: 300 }; };
    rrs.getUserRevenueForPeriod = async () => { oldCalls++; return { success: true, totalGgr: 700, totalBets: 1000, totalWins: 300 }; };
    const realStats = girox.getPlayerStats;
    girox.getPlayerStats = async () => ({ success: true, netwin: 200, casinoNetwin: 200, wagered: 500, payout: 300 });
    const realNow = Date.now;
    const from = new Date('2020-01-01T03:00:00Z'), to = new Date('2020-01-31T03:00:00Z'); // período anterior a la mudanza de ana
    ok(plat.OLD_NETWIN_CUTOFF_MS === Date.UTC(2027, 0, 1, 3, 0, 0), 'el corte es el 1-ene-2027 00:00 de Argentina');
    Date.now = () => plat.OLD_NETWIN_CUTOFF_MS - 1000;
    r = await plat.getUserNetwinForDateRange('ana', 7, from, to, 'monthly');
    ok(r.success && r.totalGgr === 900 && oldCalls === 1, 'antes del corte: mudado suma vieja (700) + nueva (200)');
    r = await plat.getUserRevenueForPeriod({ username: 'ana', jugayganaUserId: 7, platform: 'partner', platformMigratedAt: new Date() }, '2020-01');
    ok(r.success && r.totalGgr === 900 && oldCalls === 2, 'antes del corte: comisión de referidos también suma la vieja');
    Date.now = () => plat.OLD_NETWIN_CUTOFF_MS;
    r = await plat.getUserNetwinForDateRange('ana', 7, from, to, 'monthly');
    ok(r.success && r.totalGgr === 200 && oldCalls === 2, 'desde el corte: solo la nueva y la vieja NI SE CONSULTA');
    r = await plat.getUserRevenueForPeriod({ username: 'ana', jugayganaUserId: 7, platform: 'partner', platformMigratedAt: new Date() }, '2020-01');
    ok(r.success && r.totalGgr === 200 && oldCalls === 2, 'desde el corte: comisión de referidos solo con la nueva');
    r = await plat.getUserNetwinForDateRange('cb4', 7, from, to, 'monthly');
    ok(r.success && r.totalGgr === 700 && oldCalls === 3, 'un usuario NO mudado sigue leyendo la vieja después del corte');
    Date.now = realNow; girox.getPlayerStats = realStats;
  }

  console.log(fails ? `\n❌ ${fails} fallas` : '\n✅ Todo OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
