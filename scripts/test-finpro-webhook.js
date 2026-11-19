#!/usr/bin/env node
/**
 * Test en frío de los webhooks de Finpro (#220): firma HMAC-SHA256 (`timestamp.body`),
 * ventana del timestamp, lista de secretos (panel + SSM) y parseo de los dos payloads
 * de la doc (principal = resultado de retiros; secundario = eventos bancarios).
 * No toca la red ni la base. Correr tras cualquier cambio en finproService.js:
 *   node scripts/test-finpro-webhook.js
 */
const assert = require('assert');
// En Tails no hay node_modules: si faltan axios/winston se stubean (acá no se usa la red ni el log).
const Module = require('module');
const _origLoad = Module._load;
const noop = () => {};
Module._load = function (request) {
  if (request === '../utils/logger') return { info: noop, warn: noop, error: noop, debug: noop }; // logger (winston) no hace falta acá
  try { return _origLoad.apply(this, arguments); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && request === 'axios') return function () { throw new Error('sin red en el test'); };
    throw e;
  }
};
const finpro = require('../src/services/finproService');

let n = 0;
function t(name, fn) { fn(); n++; console.log('  ✓ ' + name); }

const secret = 'secreto-de-prueba-0123456789';
const secondary = JSON.stringify({
  notification_id: 12345, bank_id: 'creedence', webhook_type: 'notification', notification_type: 'CT',
  received_at: '2026-03-20T15:30:45.000Z',
  transaction_data: { transfer_type: 'E', coelsa_id: 'Z6OLMDN3VYMYJQ0W2E7RQ5', amount: '15000.00', cbu_from: '0000000000000000000001', cbu_to: '0000000000000000000002' }
});
const principal = JSON.stringify({
  status: 'completed', process_id: '11111111-2222-4333-8444-555555555555', transaction_id: 'TX000000002',
  transaction_success_count: 1, transaction_fail_count: 0,
  data: [{ coelsa_id: 'R7ZG0QNDWKMQLRPG9EXYPO', response_code: '0200', amount: '100.00', cbu_from: '0000000000000000000002', cbu_to: '0000000000000000000003', authorization_code: '358164' }]
});

console.log('Firma:');
t('firma válida con el secreto correcto', () => {
  const { timestamp, signature } = finpro.signWebhook(secondary, secret);
  const r = finpro.verifyWebhookSignature({ rawBody: secondary, timestamp, signature, secrets: [secret] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});
t('acepta el body como Buffer (bytes exactos) y la firma con prefijo sha256=', () => {
  const { timestamp, signature } = finpro.signWebhook(Buffer.from(secondary, 'utf8'), secret);
  const r = finpro.verifyWebhookSignature({ rawBody: Buffer.from(secondary, 'utf8'), timestamp, signature: 'sha256=' + signature.toUpperCase(), secrets: [secret] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});
t('acepta cualquiera de la lista de secretos (panel + SSM)', () => {
  const { timestamp, signature } = finpro.signWebhook(secondary, secret);
  const r = finpro.verifyWebhookSignature({ rawBody: secondary, timestamp, signature, secrets: ['otro-secreto-viejo-del-panel', secret] });
  assert.strictEqual(r.ok, true);
});
t('rechaza secreto distinto', () => {
  const { timestamp, signature } = finpro.signWebhook(secondary, secret);
  const r = finpro.verifyWebhookSignature({ rawBody: secondary, timestamp, signature, secrets: ['secreto-equivocado-xxxxxxxxx'] });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'firma_invalida']);
});
t('rechaza body alterado (un espacio cambia la firma)', () => {
  const { timestamp, signature } = finpro.signWebhook(secondary, secret);
  const r = finpro.verifyWebhookSignature({ rawBody: secondary.replace('15000.00', '15000.01'), timestamp, signature, secrets: [secret] });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'firma_invalida']);
});
t('rechaza timestamp distinto al firmado', () => {
  const { timestamp, signature } = finpro.signWebhook(secondary, secret);
  const r = finpro.verifyWebhookSignature({ rawBody: secondary, timestamp: String(Number(timestamp) + 1), signature, secrets: [secret] });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'firma_invalida']);
});
t('rechaza timestamp viejo (fuera de la ventana de 300 s)', () => {
  const old = Math.floor(Date.now() / 1000) - 301;
  const { timestamp, signature } = finpro.signWebhook(secondary, secret, old);
  const r = finpro.verifyWebhookSignature({ rawBody: secondary, timestamp, signature, secrets: [secret] });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'timestamp_vencido']);
});
t('acepta timestamp viejo si la ventana está desactivada (maxAgeSec 0)', () => {
  const old = Math.floor(Date.now() / 1000) - 99999;
  const { timestamp, signature } = finpro.signWebhook(secondary, secret, old);
  const r = finpro.verifyWebhookSignature({ rawBody: secondary, timestamp, signature, secrets: [secret], maxAgeSec: 0 });
  assert.strictEqual(r.ok, true);
});
t('rechaza sin secreto / sin firma / sin timestamp / timestamp no numérico', () => {
  const { timestamp, signature } = finpro.signWebhook(secondary, secret);
  assert.strictEqual(finpro.verifyWebhookSignature({ rawBody: secondary, timestamp, signature, secrets: [] }).reason, 'sin_secreto');
  assert.strictEqual(finpro.verifyWebhookSignature({ rawBody: secondary, timestamp, signature: '', secrets: [secret] }).reason, 'sin_firma');
  assert.strictEqual(finpro.verifyWebhookSignature({ rawBody: secondary, timestamp: '', signature, secrets: [secret] }).reason, 'sin_timestamp');
  assert.strictEqual(finpro.verifyWebhookSignature({ rawBody: secondary, timestamp: 'ayer', signature, secrets: [secret] }).reason, 'timestamp_invalido');
});
t('la firma coincide con un HMAC calculado a mano (timestamp + "." + body)', () => {
  const crypto = require('crypto');
  const ts = '1770000000';
  const manual = crypto.createHmac('sha256', secret).update(ts + '.' + principal).digest('hex');
  assert.strictEqual(finpro.signWebhook(principal, secret, ts).signature, manual);
});
t('ventana por defecto 300 s y configurable por env', () => {
  const prev = process.env.FINPRO_WEBHOOK_MAX_AGE_SEC;
  delete process.env.FINPRO_WEBHOOK_MAX_AGE_SEC; assert.strictEqual(finpro.webhookMaxAgeSec(), 300);
  process.env.FINPRO_WEBHOOK_MAX_AGE_SEC = '60'; assert.strictEqual(finpro.webhookMaxAgeSec(), 60);
  process.env.FINPRO_WEBHOOK_MAX_AGE_SEC = 'x'; assert.strictEqual(finpro.webhookMaxAgeSec(), 300);
  if (prev === undefined) delete process.env.FINPRO_WEBHOOK_MAX_AGE_SEC; else process.env.FINPRO_WEBHOOK_MAX_AGE_SEC = prev;
});

console.log('Payloads:');
t('secundario: entrante (E) con coelsa, monto numérico y CVUs en dígitos', () => {
  const n = finpro.parseIncomingWebhook(JSON.parse(secondary));
  assert.strictEqual(n.notificationId, '12345');
  assert.strictEqual(n.webhookType, 'notification');
  assert.strictEqual(n.notificationType, 'CT');
  assert.strictEqual(n.incoming, true);
  assert.strictEqual(n.transferType, 'E');
  assert.strictEqual(n.coelsaId, 'Z6OLMDN3VYMYJQ0W2E7RQ5');
  assert.strictEqual(n.amount, 15000);
  assert.strictEqual(n.cbuFrom, '0000000000000000000001');
  assert.strictEqual(n.cbuTo, '0000000000000000000002');
  assert.strictEqual(n.receivedAt, '2026-03-20T15:30:45.000Z');
});
t('secundario: transfer_type distinto de E no es entrante; payload vacío no rompe', () => {
  const b = JSON.parse(secondary); b.transaction_data.transfer_type = 'S';
  assert.strictEqual(finpro.parseIncomingWebhook(b).incoming, false);
  const e = finpro.parseIncomingWebhook({});
  assert.deepStrictEqual([e.notificationId, e.incoming, e.amount, e.coelsaId], [null, false, null, null]);
});
t('principal: completed + 0200 + coelsa; 0200 NO es código de error', () => {
  const cb = finpro.parsePayoutCallback(JSON.parse(principal));
  assert.strictEqual(cb.processId, '11111111-2222-4333-8444-555555555555');
  assert.strictEqual(cb.transactionId, 'TX000000002');
  assert.strictEqual(cb.status, 'completed');
  assert.strictEqual(cb.hasRows, true);
  assert.strictEqual(cb.rows[0].coelsaId, 'R7ZG0QNDWKMQLRPG9EXYPO');
  assert.strictEqual(cb.rows[0].responseCode, '0200');
  assert.strictEqual(finpro.isErrorCode('0200'), false);
  assert.strictEqual(finpro.isErrorCode('2449'), true);
});
t('principal legacy (solo contadores) → sin filas', () => {
  const cb = finpro.parsePayoutCallback({ process_id: 'abc-123', status: 'finished', transaction_success_count: 1 });
  assert.deepStrictEqual([cb.hasRows, cb.status, cb.successCount], [false, 'finished', 1]);
});

t('secundario: titular/CUIT/concepto/id de cuenta del aviso se leen con claves alternativas (defensivo)', () => {
  const b = JSON.parse(secondary);
  b.account_id = 'ACC-77'; b.transaction_data.titular = 'JUAN PEREZ'; b.transaction_data.cuit = '20-12345678-9'; b.transaction_data.concepto = 'VAR';
  const n = finpro.parseIncomingWebhook(b);
  assert.deepStrictEqual([n.fromName, n.fromCuit, n.concept, n.accountId], ['JUAN PEREZ', '20123456789', 'VAR', 'ACC-77']);
  const e = finpro.parseIncomingWebhook(JSON.parse(secondary));
  assert.deepStrictEqual([e.fromName, e.fromCuit, e.accountId], [null, null, null]);
});

console.log('CVUs (un Cliente API agrupa varias cuentas):');
t('ourCvus = principal + extras (coma), isOurCvu compara dígitos', () => {
  finpro.setSettingsOverride({ fromCvu: '0000000000000000000002', extraCvus: '0000000000000000000005, 0000-0000-0000-0000-000006;0000000000000000000005' });
  assert.deepStrictEqual(finpro.ourCvus(), ['0000000000000000000002', '0000000000000000000005', '0000000000000000000006']);
  assert.strictEqual(finpro.isOurCvu('0000 0000 0000 0000 000005'), true);
  assert.strictEqual(finpro.isOurCvu('0000000000000000000009'), false);
  finpro.setSettingsOverride({});
});

console.log(`\n${n} pruebas OK`);
