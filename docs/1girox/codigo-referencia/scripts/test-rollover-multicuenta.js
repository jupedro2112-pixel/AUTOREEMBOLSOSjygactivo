#!/usr/bin/env node
/**
 * Validación EN FRÍO de ESPEC-ROLLOVER-GLOBAL-Y-MULTICUENTA-TITULAR.md (§A.6 y §B.6).
 * Sin DB ni API: la parte pura (src/utils/bonusRollover.js, src/utils/holderKey.js)
 * + chequeos ESTÁTICOS sobre el código de que los 3 puntos del cliente y las
 * exclusiones están cableados (lo que no se puede ejecutar sin la plataforma).
 *
 *   node scripts/test-rollover-multicuenta.js
 */
const fs = require('fs');
const path = require('path');
const { resolveGlobalRollover, pickRollover, BONUS_ROLLOVER_OPTIONS } = require('../src/utils/bonusRollover');
const { holderKey } = require('../src/utils/holderKey');

let fails = 0;
function check(name, got, exp) {
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  if (!ok) fails++;
  console.log(`${ok ? '✅' : '❌'} ${name} → ${JSON.stringify(got)}${ok ? '' : ` (esperado ${JSON.stringify(exp)})`}`);
}
const girox = fs.readFileSync(path.join(__dirname, '../src/services/giroxService.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const referral = fs.readFileSync(path.join(__dirname, '../src/services/referralPayoutService.js'), 'utf8');

console.log('== A) ROLLOVER GLOBAL (§A.6) ==');
const ALLOWED_REF = [0, 2, 5, 10, 20, 40]; // cuenta de referencia (x3 NO permitido)
// Global ON x3 (permitido) → carga manual con bonus → bonus_multiplier 3
let g = resolveGlobalRollover({ enabled: true, x: 3 }, [0, 2, 3, 5, 10]);
check('§A.6.1 ON x3 permitido → efectivo 3, sin snap', [g.enabled, g.effective, g.snapped], [true, 3, false]);
check('§A.6.1 getGiroxBonusMultiplier (carga con bonus) devuelve el global', pickRollover(g, 0), 3);
// Global ON x3 pero plataforma [0,2,5,10] → efectivo x5 y aviso
g = resolveGlobalRollover({ enabled: true, x: 3 }, [0, 2, 5, 10]);
check('§A.6.2 ON x3 con [0,2,5,10] → efectivo 5 + snapped', [g.effective, g.snapped], [5, true]);
g = resolveGlobalRollover({ enabled: true, x: 3 }, ALLOWED_REF);
check('§A.6.2b ON x3 con la cuenta de referencia [0,2,5,10,20,40] → 5', g.effective, 5);
// Global ON → flujo con rollover propio x2 → acredita el global y el mensaje dice el global
g = resolveGlobalRollover({ enabled: true, x: 3 }, [0, 2, 3, 5, 10]);
check('§A.6.3 ON x3, flujo con x2 propio (ruleta/fueguito/cashback) → 3', pickRollover(g, 2), 3);
// Global ON x0 → sin rollover
g = resolveGlobalRollover({ enabled: true, x: 0 }, ALLOWED_REF);
check('§A.6.4 ON x0 → todos sin rollover', [g.effective, pickRollover(g, 5)], [0, 0]);
// Global OFF → cada flujo con el suyo
g = resolveGlobalRollover({ enabled: false, x: 3 }, ALLOWED_REF);
check('§A.6.5 OFF → el flujo usa su rollover (x5 fueguito)', pickRollover(g, 5), 5);
check('§A.6.5 OFF → flujo x0 queda x0', pickRollover(g, 0), 0);
// Defaults y validación
g = resolveGlobalRollover(null, null);
check('default sin config ni plataforma → ON x3 efectivo 3', [g.enabled, g.x, g.effective, g.snapped], [true, 3, 3, false]);
g = resolveGlobalRollover({ enabled: true, x: 7 }, null);
check('x fuera de opciones (7) → cae al default 3', g.x, 3);
g = resolveGlobalRollover({ enabled: true, x: 10 }, [0, 2, 5]);
check('x10 con máximo permitido 5 → 5 (el máximo)', [g.effective, g.snapped], [5, true]);
check('opciones del panel', BONUS_ROLLOVER_OPTIONS, [0, 2, 3, 5, 10]);

// Cableado (estático): los 3 puntos del cliente + exclusiones (§A.6.6 y §A.6.7)
const between = (src, from, to) => { const i = src.indexOf(from); const j = src.indexOf(to, i + 1); return i >= 0 && j > i ? src.slice(i, j) : ''; };
check('§A.2.1 creditGift resuelve el global salvo ignoreGlobalRollover', /async function creditGift[\s\S]*?ignoreGlobalRollover[\s\S]*?_globalRollover\(\)/.test(girox), true);
check('§A.2.2 creditUserBalance con multiplier resuelve el global', /opts\.multiplier != null[\s\S]{0,300}_globalRollover\(\)/.test(girox), true);
check('§A.2.2 la rama sin multiplier delega en creditGift', /return creditGift\(username, amt, \{[\s\S]*?ignoreGlobalRollover: !!\(opts && opts\.ignoreGlobalRollover\)/.test(girox), true);
check('§A.2.3 depositToUser aplica el global solo con bonus_amount/bonus_percent', /\(body\.bonus_amount > 0 \|\| body\.bonus_percent > 0\) && !wagering\.ignoreGlobalRollover/.test(girox), true);
check('§A.6.6 comisión de referidos EXCLUIDA', /ignoreGlobalRollover: true/.test(between(referral, 'giroxService.creditUserBalance(', ');')), true);
check('§A.6.7 devolución de retiro rechazado (parte bono) EXCLUIDA', /vip-payoutref-bonus-\$\{payout\.id\}`, \{ ignoreGlobalRollover: true \}/.test(server), true);
check('§A.6.7 devolución de fichas va por depósito SIN wagering', /vip-payoutref-chips-\$\{payout\.id\}`\);/.test(server), true);
check('§A.3 resolver inyectado desde server.js', /girox\.setRolloverResolver\(async \(\) => \{[\s\S]*?g\.enabled \? g\.effective : null/.test(server), true);
check('§A.3 getGiroxBonusMultiplier devuelve el global cuando está encendido', /async function getGiroxBonusMultiplier\(\) \{\s*try \{ const g = await getGlobalBonusRollover\(\); if \(g\.enabled\) return g\.effective;/.test(server), true);
check('§A.4 fueguito / cashback / código de bienvenida muestran el global', (server.match(/await applyGlobalRollover\(/g) || []).length >= 5, true);
check('§A.5 endpoints GET/POST /api/admin/bonus-rollover', /app\.get\('\/api\/admin\/bonus-rollover'/.test(server) && /app\.post\('\/api\/admin\/bonus-rollover'/.test(server), true);

console.log('\n== B) MULTICUENTA POR TITULAR (§B.6) ==');
const K = holderKey('Mercedes Daniela Gaillard');
check('§B.6.1 titular normalizado', K, 'MERCEDES DANIELA GAILLARD');
check('§B.6.2 acentos/mayúsculas/puntuación distintas → misma key', holderKey('MERCEDES  GAILLARD, Daniela') === holderKey('Mercedes Gaillard Daniela'), true);
check('§B.6.2b "Gaillárd, Mercedes Daniela" vs "GAILLARD MERCEDES DANIELA" → misma key', holderKey('Gaillárd, Mercedes Daniela'), holderKey('GAILLARD MERCEDES DANIELA'));
check('§B.6.3 titular de 1 palabra ("JUAN") → no cruza', holderKey('JUAN'), null);
check('§B.6.3b "SA" → no cruza', holderKey('SA'), null);
check('§B.6.3c 2 palabras pero < 8 letras ("LU SA") → no cruza', holderKey('LU SA'), null);
check('vacío / null → null', [holderKey(''), holderKey(null)], [null, null]);
check('§B.2 se guarda originHolderKey al crear el comprobante', /originHolderKey: _holderKey\(result\.originHolder\)/.test(server), true);
check('§B.3 cruce por key nueva Y por nombre exacto (filas viejas)', /\$or: \[\{ originHolderKey: key \}, \{ originHolder: exact \}\]/.test(server), true);
check('§B.3 cruce contra movimientos bancarios de OTRAS cuentas', /\$or: \[\{ fromKey: key \}, \{ fromName: exact \}\],\s*matchedUserId: \{ \$exists: true, \$nin: \[null, String\(userId\)\] \}/.test(server), true);
check('§B.4.1 nota 🚨 MULTICUENTA POR TITULAR al verificar el comprobante', /MULTICUENTA POR TITULAR: el comprobante viene de/.test(server), true);
check('§B.4.2 auto-carga: si el cruce bancario no dio, prueba el titular', /if \(!_dupBank && movement\.fromName\) \{\s*const hc = await _findHolderConflict\(user\.id, movement\.fromName\)/.test(server), true);
check('§B.4.3 fraud-check con señal receipt_holder', /type: 'receipt_holder', strong: true/.test(server), true);
check('§B.5 fail-open: el cruce va en try/catch y no frena la carga', /chequeo multicuenta bancaria falló \(sigue la carga\)/.test(server), true);

console.log(fails ? `\n❌ ${fails} caso(s) fallaron` : '\n✅ Todos los casos de §A.6 y §B.6 dan lo esperado');
process.exit(fails ? 1 : 0);
