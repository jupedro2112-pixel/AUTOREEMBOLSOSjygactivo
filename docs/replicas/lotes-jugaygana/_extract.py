#!/usr/bin/env python3
"""Regenera el paquete de réplica del sistema de lotes a partir del código ACTUAL del repo.
Correr desde la raíz del repo:  python3 docs/replicas/lotes-jugaygana/_extract.py
Busca por MARCADORES (comentarios), no por números de línea, así sobrevive a los cambios."""
import os, re, subprocess
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
D = os.path.join(ROOT, 'docs/replicas/lotes-jugaygana/')
os.chdir(ROOT)
COMMIT = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()
import datetime; TODAY = datetime.date.today().isoformat()

def read(path): return open(path, encoding='utf-8').read().split('\n')
def find(L, needle, start=0, contains=True):
    for i in range(start, len(L)):
        if (needle in L[i]) if contains else L[i].startswith(needle): return i + 1  # 1-based
    raise SystemExit(f'marcador no encontrado: {needle!r} en línea >= {start}')
def rfind_before(L, needle, before):
    for i in range(before - 2, -1, -1):
        if needle in L[i]: return i + 1
    raise SystemExit(f'marcador previo no encontrado: {needle!r}')
def lines(L, a, b): return '\n'.join(L[a-1:b])
def write(name, content): open(D + name, 'w', encoding='utf-8').write(content.rstrip('\n') + '\n')
def hdr(t): return f"// ============================================================================\n// {t}\n// Extraído de AUTOREEMBOLSOSjygactivo/server.js (commit {COMMIT}, {TODAY}). Pegar tal cual\n// salvo lo indicado en README.md.\n// ============================================================================\n\n"

S = read('server.js')
# 01 tope
a = find(S, 'const HGCASH_APP_BONUS_20_UNTIL')
a = rfind_before(S, '// automáticos hgcash")', a + 1)
b = find(S, 'let _hgcashAppBonusCfgCache')
c = find(S, 'async function getHgcashAppBonusConfig()')
d = find(S, '// Anti-multicuenta por dispositivo', c) - 1
while not S[d-1].strip(): d -= 1
write('server-01-tope-lote.js', hdr("1) TOPE DEL % DE LOTE (#172) — comparte Config['hgcashAppBonus'] con el bono app (#164)") +
  "// Si el repo destino NO tiene el bono app, igual hace falta ESTA config (firstCapARS /\n// firstExcessPct) y getHgcashAppBonusConfig(): es lo que limita un lote de 100% a $5.000 + 20%.\n// Dependencias: getConfig (Config), logger.\n\n" +
  lines(S, a, b) + "\n\n" + lines(S, c, d))
# 02 promo bonus
p2 = find(S, '// BONO DE CARGA (PromoBonus)') - 1
p3 = find(S, '// LOTES DE NOTIFICACIONES CON REGALO (NotifBatch)') - 1
write('server-02-promo-bonus-endpoints.js', hdr("2) BONO DE CARGA (PromoBonus): bono vigente del usuario + cartel del agente + marcar usado") +
  "// Rutas: GET /api/promo-bonus/mine (cliente), GET /api/admin/promo-bonus?username= (cartel del chat,\n// devuelve capTxt #172), POST /api/admin/promo-bonus/:id/use (marcar usado / cancelar).\n// ⚠️ TDZ: pegar DESPUÉS de `const authMiddleware` / `adminMiddleware`.\n// Dependencias: PromoBonus (modelo), _loteCapTxt (archivo 01), logger.\n\n" +
  "const PromoBonus = require('./src/models/PromoBonus');\n\n" + lines(S, p2, p3 - 1))
# 03 bloque lotes
e = find(S, 'const BonusStrategyConfig = require')
e = rfind_before(S, '// =====', e); e = rfind_before(S, '// =====', e) - 1
while not S[e-1].strip(): e -= 1
write('server-03-lotes-block.js', hdr("3) BLOQUE COMPLETO 'LOTES DE NOTIFICACIONES CON REGALO' (#149 + #172 + #173 + #177)") +
  "// Contiene: franja horaria (_argMinuteOfDay/_inDailyWindow), claim/revert/settle del % automático,\n// audiencias (lista / segmento / todos / código público), topes anti-abuso de fichas, motor de envío\n// reanudable multi-instancia (cron 45 s), activación del PromoBonus (vence a useHours tras canje),\n// fichas tras el claim (_notifBatchFichasAfterClaim), canje de código (_tryClaimNotifBatchCode) y las rutas:\n//   POST /api/admin/notif-batches/preview · POST /api/admin/notif-batches · GET /api/admin/notif-batches\n//   GET /api/admin/notif-batches/:id · POST /api/gift-code/claim · GET /api/gift/pending · POST /api/gift/claim (#177)\n// ⚠️ TDZ: pegar DESPUÉS de authMiddleware/adminMiddleware/authLimiter (ver README §Dependencias).\n\n" +
  lines(S, p3, e))
# 04 hooks
h1 = find(S, '// #149 BONO DE LOTE AUTOMÁTICO (carga manual SIN bonus del agente)')
h2 = find(S, "await recordUserActivity(user.id, 'deposit', parseFloat(amount));", h1) - 2
m1 = find(S, 'Incluye tu regalo: +${_loteClaim.pct}%')
g1 = find(S, '// #149 BONO DE LOTE AUTOMÁTICO en la carga hgcash')
g2 = find(S, '// Mensaje al cliente (usa /sys_deposit o /sys_deposit_bonus', g1) - 2
m2 = find(S, "Incluye tu regalo: +${appBonus.pct}%")
n1 = find(S, 'const bonusNote = appBonus.applied'); n2 = n1 + 5
hooks = "# 4) HOOKS en los flujos de carga (dónde se aplica el % automático del lote)\n\n"
hooks += "Estos fragmentos NO se pegan sueltos: van DENTRO de los flujos de carga que ya tiene el repo destino.\nSon el contrato de \"una carga = como mucho UN bono automático\" (bono app o lote, nunca ambos).\n\n"
hooks += "## 4.a Carga MANUAL del agente — `POST /api/admin/deposit` (después de acreditar la carga y el bonus del agente)\n\n"
hooks += "Variables del flujo que usa: `user`, `amount`, `bonus` (let), `bonusRequested`, `bonusActuallyApplied`,\n`bonusJgResult`, `_dupBankManual` (anti-multicuenta por banco #152; si el destino no lo tiene, tratarlo como `null`),\n`_loteClaim` (declarar `let _loteClaim = null;` arriba, se usa después para el mensaje al cliente).\n\n```js\n" + lines(S, h1, h2) + "\n```\n\n"
hooks += "Mensaje al cliente (donde se arma el texto de /sys_deposit_bonus):\n\n```js\n" + lines(S, m1, m1) + "\n```\n\n"
hooks += "## 4.b Carga AUTOMÁTICA hgcash — `hgcashAutoCarga` (después de `_hgcashApplyAppBonus`)\n\n"
hooks += "`appBonus` tiene que ser `let`. `_dupBank` = multicuenta por banco (#152) o `null`.\n\n```js\n" + lines(S, g1, g2) + "\n```\n\nMensaje al cliente y nota interna de la carga automática:\n\n```js\n" + lines(S, m2, m2) + "\n\n" + lines(S, n1, n2) + "\n```\n\n"
hooks += "## 4.c Si el repo destino NO tiene hgcash\n\nSolo va 4.a. El motor del lote y el canje no dependen de hgcash.\n"
write('server-04-hooks-cargas.md', hooks)
# 05 deps
def fn(L, start_needle):
    a = find(L, start_needle, contains=False)
    for i in range(a, len(L)):
        if L[i].startswith('}'): return a, i + 1
    raise SystemExit('fin de función no hallado: ' + start_needle)
parts = []
for title, needle in [("sendPushIfOffline(user, title, body, data) → { delivery: 'socket'|'push'|'none'|'error' }", 'async function sendPushIfOffline('),
                      ("renderSystemCommand(name, fallback, vars): mensajes automáticos editables desde COMANDOS", 'async function renderSystemCommand('),
                      ("resolveSysContent (helper de renderSystemCommand)", 'function resolveSysContent('),
                      ("_alertMoneyAmbiguous: alerta 🛑 cuando JUGAYGANA no confirma una operación de plata (#151)", 'async function _alertMoneyAmbiguous('),
                      ("_emitAdminOnlyChatNote: nota INTERNA (solo agentes) en el chat del cliente", 'async function _emitAdminOnlyChatNote('),
                      ("_rouletteHasAppInstalled: 'tiene la app instalada' por token FCM standalone", 'function _rouletteHasAppInstalled(')]:
    a, b = fn(S, needle); parts.append(f"// --- {title} ---\n" + lines(S, a, b))
write('server-05-dependencias-helpers.js', hdr("5) HELPERS que el bloque asume existentes. Copiar SOLO los que falten en el repo destino") +
  "// Si el destino ya tiene un equivalente (otro nombre), adaptar las llamadas del bloque 03, no duplicar.\n\n" + "\n\n".join(parts))
# modelos
write('models-NotifBatch.js', open('src/models/NotifBatch.js', encoding='utf-8').read())
write('models-PromoBonus.js', open('src/models/PromoBonus.js', encoding='utf-8').read())
# panel
P = read('public/adminprivado2026/index.html'); A = read('public/adminprivado2026/admin.js')
ba = find(P, 'Bono de carga vigente del cliente'); bb = ba + 1
la = find(P, '<!-- LOTE CON REGALO (#149'); lb = find(P, '<!-- Historial de lotes enviados', la) - 2
while not P[lb-1].strip(): lb -= 1
ha = lb + 2; hb = find(P, '<!-- Resultado del último envío', ha) - 2
while not P[hb-1].strip(): hb -= 1
write('panel-index.html.part', "<!-- ============================================================================\n     PANEL ADMIN — 3 fragmentos para public/adminprivado2026/index.html\n     ============================================================================ -->\n\n"
  "<!-- (a) Dentro del header del CHAT (arriba de los mensajes): banner del bono vigente del cliente -->\n" + lines(P, ba, bb) + "\n\n"
  "<!-- (b) En la sección NOTIFICACIONES: card '🎁 Lote con regalo' (formulario + guía ❓) -->\n" + lines(P, la, lb) + "\n\n"
  "<!-- (c) Debajo: '📤 Lotes enviados' (historial con 👥 Ver lote) -->\n" + lines(P, ha, hb))
ja = find(A, '// BONO DE CARGA — banner en el chat del admin') - 1
jb = find(A, '// ESTRATEGIA DE BONOS POR ENCUESTA', ja) - 2
while not A[jb-1].strip(): jb -= 1
write('panel-admin.js.part', "// ============================================================================\n// PANEL ADMIN — fragmentos para public/adminprivado2026/admin.js\n// ============================================================================\n\n"
  "// (a) Al abrir un chat (donde ya se carga el header/fraud-check del usuario):\n//     loadChatPromoBonus(username);\n\n"
  "// (b) En loadNotificationsPanel() (al entrar a la sección Notificaciones):\n//     loadNotifBatches(); updateGiftBatchModeUI(); updateGiftBatchTypeUI(); updateGiftBatchAudienceUI();\n\n"
  "// (c) Funciones (usan authFetch(path, opts) → Response con el token/cookie del panel, showToast, escHtml,\n//     fmtFechaHoraAR). Si el panel destino no tiene authFetch, reemplazar por fetch + header Authorization.\n\n" + lines(A, ja, jb))
# PWA
I = read('public/index.html'); U = read('public/js/ui.js'); K = read('public/js/socket.js')
ib = find(I, 'id="giftCodeBtn"')
ca = find(I, '#177 Regalo de fichas pendiente de RECLAMAR'); cb = find(I, 'id="promoBonusCard"', ca)
ma = find(I, '<!-- #149 Reclamar Bono con Código'); mb = find(I, '#168 Popup promocional de referidos', ma) - 2
while not I[mb-1].strip(): mb -= 1
sc = find(I, 'promobonus.js?v=')
write('pwa-index.html.part', "<!-- ============================================================================\n     PWA CLIENTE — fragmentos para public/index.html\n     ============================================================================ -->\n\n"
  "<!-- (a) Botón 🎁 en la barra superior (junto a los otros .tb-btn) -->\n" + lines(I, ib, ib) + "\n\n"
  "<!-- (b) En el home: card del regalo para RECLAMAR (#177) + card del bono vigente (las pinta js/promobonus.js) -->\n" + lines(I, ca, cb) + "\n\n"
  "<!-- (c) Modal 'Regalos con código' (reclamar con botón + canjear código + información) -->\n" + lines(I, ma, mb) + "\n\n"
  "<!-- (d) Script (bumpear ?v y CACHE_VERSION del SW): -->\n" + lines(I, sc, sc))
ua = find(U, 'function openGiftCodeModal()')
ub = find(U, 'function escapeHtml(t)', ua) - 1
while not U[ub-1].strip(): ub -= 1
ap = read('public/js/app.js'); aa = find(ap, "getElementById('giftCodeBtn')")
ka = find(K, '#177: un mensaje del sistema puede traer un regalo')
write('pwa-ui.js.part', "// ============================================================================\n// PWA CLIENTE — fragmentos para public/js/ui.js (namespace window.VIP.ui), app.js y socket.js\n// ============================================================================\n\n"
  "// (a) Funciones de ui.js (usan showModal/hideModal, VIP.config.API_URL, token en localStorage, VIP.ui.installApp\n//     y el 🔔 de la barra para activar notifs; adaptar nombres si difieren):\n\n" + lines(U, ua, ub) + "\n\n"
  "// (b) Sumar al objeto exportado de VIP.ui:\n//     openGiftCodeModal, claimGiftCode, giftCodeShowView, giftInfoEnableNotifs, syncBalance (#177: promobonus.js lo llama tras reclamar)\n\n"
  "// (c) En app.js, al inicializar la UI logueada:\n" + lines(ap, aa, aa + 1) + "\n\n"
  "// (d) En socket.js, dentro del handler de 'new_message' (después del dedupe por id) — #177:\n" + lines(K, ka, ka + 1))
write('pwa-promobonus.js', open('public/js/promobonus.js', encoding='utf-8').read())
print('paquete regenerado en', D, 'commit', COMMIT)
for f in sorted(os.listdir(D)):
    if f.endswith('.js'):
        r = subprocess.run(['node', '--check', D + f], capture_output=True, text=True)
        print(('OK  ' if r.returncode == 0 else 'FAIL') + ' ' + f + ('' if r.returncode == 0 else '\n' + r.stderr[:300]))
