#!/usr/bin/env node
/**
 * Validación EN FRÍO del BONO NORMAL vs BONO WAGER (#226/#227).
 * Sin DB ni API: la parte pura (src/utils/bonusKind.js) + chequeos ESTÁTICOS de que
 * el cliente de la API, los dos flujos de carga y los regalos sin carga están
 * cableados (lo que no se puede ejecutar sin la plataforma).
 *
 *   node scripts/test-bonus-kind.js
 *
 * Las respuestas de ejemplo de la sección 3 son las REALES de la API (pruebas del
 * 2026-11-13 contra POST /players/{u}/promo).
 */
const fs = require('fs');
const path = require('path');
const bk = require('../src/utils/bonusKind');

let fails = 0;
function check(name, got, exp) {
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  if (!ok) fails++;
  console.log(`${ok ? '✅' : '❌'} ${name} → ${JSON.stringify(got)}${ok ? '' : ` (esperado ${JSON.stringify(exp)})`}`);
}
const girox = fs.readFileSync(path.join(__dirname, '../src/services/giroxService.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const vip = fs.readFileSync(path.join(__dirname, '../src/services/vipLevelService.js'), 'utf8');
const txModel = fs.readFileSync(path.join(__dirname, '../src/models/Transaction.js'), 'utf8');

console.log('== 1) CONFIG ==');
const d = bk.defaultConfig();
check('default: apagado, todo normal', [d.enabled, d.fallback, Object.values(d.flows).every((v) => v === 'normal')], [false, 'normal', true]);
check('normalizeConfig(null) = default', bk.normalizeConfig(null), d);
const n = bk.normalizeConfig({ enabled: 'si', fallback: 'x', flows: { install: 'wager', story: 'otro', refund: 'wager', inventado: 'wager' }, codes: [{ code: 'VIEJO', pct: 100 }] });
check('normalizeConfig descarta basura (y la tabla de códigos del #226)', [n.enabled, n.fallback, n.flows.install, n.flows.story, n.flows.refund, n.flows.inventado, n.codes], [false, 'normal', 'wager', 'normal', 'wager', undefined, undefined]);
let v = bk.validateConfig({ enabled: true, fallback: 'skip', flows: { install: 'wager', fire: 'wager' } });
check('validateConfig OK', [v.ok, v.config.enabled, v.config.fallback, v.config.flows.install, v.config.flows.fire, v.config.flows.lote, v.warnings.length], [true, true, 'skip', 'wager', 'wager', 'normal', 0]);
check('validateConfig: tipo de flujo inválido → error', bk.validateConfig({ flows: { install: 'promo' } }).ok, false);
check('validateConfig: respaldo inválido → error', bk.validateConfig({ fallback: 'otro' }).ok, false);
check('validateConfig: flujos en wager con el interruptor apagado → aviso', bk.validateConfig({ enabled: false, flows: { lote: 'wager' } }).warnings.length, 1);
check('el bono del agente, referidos y devoluciones NO son flujos configurables', ['agent', 'referral', 'payout_refund'].some((f) => bk.FLOWS.includes(f)), false);
check('flujos de carga y de regalo', [bk.DEPOSIT_FLOWS, bk.GIFT_FLOWS], [['install', 'publisher', 'roulette', 'story', 'lote'], ['refund', 'cashback', 'roulette_cash', 'fire', 'rakeback', 'vip_levelup', 'lote_fichas', 'welcome_code', 'manual_bonus']]);
check('todos los flujos tienen etiqueta', bk.FLOWS.every((f) => !!bk.FLOW_LABELS[f]), true);

console.log('\n== 2) PLAN DE UNA CARGA ==');
const cfg = bk.normalizeConfig({ enabled: true, flows: { install: 'wager', roulette: 'wager', lote: 'wager' } });
const install = { kind: 'install', pct: 100, amount: 5000 };
const roul = { kind: 'roulette', pct: 10, amount: 1000 };
const pub = { kind: 'publisher', pct: 50, amount: 4000 };
check('flowIsWager', [bk.flowIsWager(cfg, 'install'), bk.flowIsWager(cfg, 'publisher'), bk.flowIsWager(Object.assign({}, cfg, { enabled: false }), 'install')], [true, false, false]);
let p = bk.planDeposit(cfg, [install]);
check('instalar app en wager → todo wager, nada adjunto', [p.wagerTotal, p.normalTotal, p.wagerItems.length], [5000, 0, 1]);
p = bk.planDeposit(cfg, [install, roul]);
check('dos bonos en wager → se suman en UN promocional', [p.wagerTotal, p.wagerItems.map((i) => i.kind), p.normalTotal], [6000, ['install', 'roulette'], 0]);
p = bk.planDeposit(cfg, [pub, roul]);
check('publicista (normal) + ruleta (wager) → $4.000 adjunto y $1.000 promocional', [p.normalTotal, p.normalItems.map((i) => i.kind), p.wagerTotal], [4000, ['publisher'], 1000]);
p = bk.planDeposit(Object.assign({}, cfg, { enabled: false }), [install, roul]);
check('interruptor apagado → todo normal (camino de siempre)', [p.wagerItems.length, p.normalTotal], [0, 6000]);
p = bk.planDeposit(cfg, [{ kind: 'install', pct: 100, amount: 0 }, null]);
check('ítems vacíos o en $0 se ignoran', [p.wagerItems.length, p.normalItems.length], [0, 0]);

console.log('\n== 3) RESPUESTA REAL DE POST /promo ==');
const real = { duplicate: false, operation: { reference: 'wgt-1794592234-p1', type: 'promo', ledger_id: null, wager_ledger_id: 945 }, wager: 10, promo_bonus: { status: 'ok', amount: 10, source: 'partner' } };
check('promo otorgado', bk.readPromoResponse(real), { granted: true, amount: 10, wagerBalance: 10 });
check('reintento (duplicate:true) trae el mismo detalle → otorgado', bk.readPromoResponse(Object.assign({}, real, { duplicate: true })).granted, true);
check('respuesta sin promo_bonus → NO otorgado', bk.readPromoResponse({ wager: 0 }).granted, false);
check('promo_bonus con status distinto de ok → NO otorgado', bk.readPromoResponse({ promo_bonus: { status: 'failed', amount: 10 } }).granted, false);
check('fallo transitorio: sin respuesta / 429 / 5xx', [bk.isTransientFailure(null), bk.isTransientFailure({}), bk.isTransientFailure({ httpStatus: 429 }), bk.isTransientFailure({ httpStatus: 503 })], [true, true, true, true]);
check('rechazo de negocio (4xx) NO es transitorio → vale el respaldo', [bk.isTransientFailure({ httpStatus: 422 }), bk.isTransientFailure({ httpStatus: 404 }), bk.isTransientFailure({ httpStatus: 200 })], [false, false, false]);

console.log('\n== 4) CABLEADO (estático) ==');
check('cliente: creditPromo usa POST /players/{u}/promo', /async function creditPromo\([\s\S]*?path: `\/players\/\$\{encodeURIComponent\(String\(username\)\)\}\/promo`/.test(girox), true);
check('cliente: creditPromo solo es success con promo_bonus ok', /const granted = !!\(pb && String\(pb\.status \|\| ''\)\.toLowerCase\(\) === 'ok' && Number\(pb\.amount\) > 0\);\s*if \(!granted\)/.test(girox), true);
check('cliente: NUNCA manda wager_percent / wager_amount adentro del depósito', /body\.wager_(percent|amount)/.test(girox), false);
check('cliente: los regalos consultan el resolver una sola vez (_wagerChecked)', (girox.match(/_wagerChecked: true/g) || []).length >= 2 && /await _tryGiftAsWager\(username, amt, reference, opts\)/.test(girox), true);
check('cliente: fallo transitorio del promocional NO cae al bono normal', /if \(transient \|\| k\.fallback === 'skip'\) return r;/.test(girox), true);
check('cliente: saldos con wager', /wager: info\.wager != null \? info\.wager : null/.test(girox), true);
check('server: resolver de regalos inyectado', /girox\.setGiftKindResolver\(async \(flow\) => \{/.test(server), true);
check('modelo: tipo de Transaction wager_bonus', /'roulette', 'wager_bonus'\]/.test(txModel), true);
check('carga manual: promocional aparte con reference estable', /promoRef: `vip-depwager-\$\{_depTxId\}`, sideRef: `vip-depbonus-\$\{_depTxId\}`/.test(server), true);
check('carga del banco: promocional aparte con reference del movimiento', /promoRef: `vip-hgw-\$\{chargeKey \|\| movement\.movementId\}`/.test(server) && /sideRef: `vip-hgb-\$\{chargeKey \|\| movement\.movementId\}`/.test(server), true);
check('las cargas ya no mandan código promocional', /promoCode: _wg|promoCode: _hgWg/.test(server), false);
check('el wager NO se guarda como bono real de la carga', /wagerBonus: \{ amount: _wgOut\.wagerAmount/.test(server) && /wagerBonus: \{ amount: _hgWgOut\.wagerAmount/.test(server), true);
check('settle: solo los bonos entregados (ctx.kinds) y lista de wagers', /const _kOk = \(k\) => !_kinds \|\| _kinds\.includes\(k\);/.test(server) && /const _wgFor = \(k\) => _wgList\.find/.test(server), true);
check('respaldo normal solo ante rechazo NO transitorio', /if \(!out\.transient && wg\.cfg\.fallback === 'normal'\)/.test(server), true);
const flowsWired = { refund: /giftFlow: 'refund'/, cashback: /'CASHBACK', 'cashback'\)/, roulette_cash: /giftFlow: 'roulette_cash'/, fire: /'FIRE_REWARD', 'fire'\)/, rakeback: /giftFlow: 'rakeback'/, lote_fichas: /giftFlow: 'lote_fichas'/, welcome_code: /giftFlow: 'welcome_code'/, manual_bonus: /giftFlow: 'manual_bonus'/ };
check('regalos sin carga cableados en server.js', Object.keys(flowsWired).filter((f) => !flowsWired[f].test(server)), []);
check('nivel VIP cableado en vipLevelService', /giftFlow: 'vip_levelup'/.test(vip), true);
check('reembolsos: los 3 períodos pasan giftFlow', (server.match(/\{ giftFlow: 'refund' \}/g) || []).length, 3);
check('referidos y devolución de retiro NO pasan giftFlow', /vip-payoutref-bonus-\$\{payout\.id\}`, \{ ignoreGlobalRollover: true \}\)/.test(server), true);
check('resumen de Transacciones: wager fuera de gifts', /case 'wager_bonus': wagers = g\.total; break;/.test(server) && !/const gifts = [^;]*wagers/.test(server), true);
check('endpoints GET/POST /api/admin/bonus-kind', /app\.get\('\/api\/admin\/bonus-kind'/.test(server) && /app\.post\('\/api\/admin\/bonus-kind'/.test(server), true);
check('mensajes editables sembrados', /name: '\/sys_wager_bonus'/.test(server) && /name: '\/sys_wager_gift_note'/.test(server), true);
check('la base del reembolso en vivo NO incluye wager_bonus', /CASHBACK_GIFT_TX_TYPES = \[[^\]]*wager_bonus/.test(server), false);

check('#228 v1.20: bonus_mode del jugador y bono normal convertido en wager (motor unificado)', /bonusMode: player\.bonus_mode/.test(girox) && /out\.bonusAsWager = Number\(_pbDep\.amount\)/.test(girox), true);
check('#228 v1.20: aviso de motor unificado en el panel', /if \(plat\.engine === 'unified'\) w\.push/.test(server), true);

console.log(fails ? `\n❌ ${fails} caso(s) fallaron` : '\n✅ Todos los casos del bono wager dan lo esperado');
process.exit(fails ? 1 : 0);
