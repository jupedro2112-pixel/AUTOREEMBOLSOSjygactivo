#!/usr/bin/env node
/**
 * Test en frío de la PÁGINA DEL CASINO editable en COMANDOS (`/sys_casino_url`, #193) — JUGAYGANA.
 * Acá no hay login automático al casino: el comando cambia SOLO el link de "Abrir Casino".
 * Saca `_cleanCasinoUrl` / `getCasinoPlayUrl` del server.js REAL (no se puede requerir sin node_modules).
 *   node scripts/test-casino-url.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function grab(re, name) { const m = src.match(re); assert(m, 'no encontré ' + name + ' en server.js'); return m[0]; }
const code = [
  grab(/const CASINO_URL_DEFAULT = [^\n]*\n/, 'CASINO_URL_DEFAULT'),
  grab(/let _casinoUrlOverride = null;\n/, '_casinoUrlOverride'),
  grab(/function getCasinoPlayUrl\(\) \{[\s\S]*?\n\}/, 'getCasinoPlayUrl'),
  grab(/function _cleanCasinoUrl\(raw\) \{[\s\S]*?\n\}/, '_cleanCasinoUrl')
].join('\n');
// eslint-disable-next-line no-new-func
const env = new Function('process', code + '\nreturn { getCasinoPlayUrl, _cleanCasinoUrl, set: (u) => { _casinoUrlOverride = u; } };')({ env: {} });

let n = 0;
function t(name, fn) { fn(); n++; console.log('  ✓ ' + name); }
t('vacío = la de siempre', () => { assert.strictEqual(env._cleanCasinoUrl(''), ''); assert.strictEqual(env.getCasinoPlayUrl(), 'https://www.jugaygana44.bet'); });
t('dominio solo → https://', () => assert.strictEqual(env._cleanCasinoUrl('jugaygana55.bet'), 'https://jugaygana55.bet'));
t('barra final y texto de más se ignoran', () => assert.strictEqual(env._cleanCasinoUrl('https://www.jugaygana55.bet/ nuevo'), 'https://www.jugaygana55.bet'));
t('http se acepta (se abre en otra pestaña)', () => assert.strictEqual(env._cleanCasinoUrl('http://jugaygana55.bet'), 'http://jugaygana55.bet'));
t('texto sin dominio se rechaza', () => assert.strictEqual(env._cleanCasinoUrl('pagina nueva'), null));
t('otro esquema se rechaza', () => assert.strictEqual(env._cleanCasinoUrl('javascript:alert(1)'), null));
t('con página en COMANDOS el botón abre esa', () => { env.set('https://jugaygana55.bet'); assert.strictEqual(env.getCasinoPlayUrl(), 'https://jugaygana55.bet'); env.set(null); });
t('solo el admin general la cambia', () => assert(/name === '\/sys_casino_url'\) \{\n\s*if \(req\.user\.role !== 'admin'\) return res\.status\(403\)/.test(src)));
t('la PWA la pide y el botón la usa', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ui.js'), 'utf8');
  assert(ui.includes("'/api/config/casino-url'") && ui.includes('var plain = VIP.ui._casinoUrl ||') && ui.includes("window.open(plain, '_blank')")) // desde #197 la página pasa por `plain`; con sesión decide /api/platform/session (#200);
  assert(src.includes("app.get('/api/config/casino-url'"));
});
console.log(`\n✅ ${n} pruebas OK`);
