#!/usr/bin/env python3
"""Regenera el paquete de réplica del sistema de REFERIDOS (#168–#175) a partir del código ACTUAL.
Correr desde la raíz del repo:  python3 docs/replicas/referidos-jugaygana/_extract.py
Busca por MARCADORES (comentarios), no por números de línea."""
import os, subprocess, datetime, shutil
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
D = os.path.join(ROOT, 'docs/replicas/referidos-jugaygana/')
os.chdir(ROOT)
COMMIT = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()
TODAY = datetime.date.today().isoformat()

def read(path): return open(path, encoding='utf-8').read().split('\n')
def find(L, needle, start=0):
    for i in range(start, len(L)):
        if needle in L[i]: return i + 1
    raise SystemExit(f'marcador no encontrado: {needle!r} (desde {start})')
def rfind_before(L, needle, before):
    for i in range(before - 2, -1, -1):
        if needle in L[i]: return i + 1
    raise SystemExit(f'marcador previo no encontrado: {needle!r}')
def trim_end(L, b):
    while b > 0 and not L[b-1].strip(): b -= 1
    return b
def lines(L, a, b): return '\n'.join(L[a-1:b])
def write(name, content): open(D + name, 'w', encoding='utf-8').write(content.rstrip('\n') + '\n')
def hdr(t, src='server.js'): return f"// ============================================================================\n// {t}\n// Extraído de AUTOREEMBOLSOSjygactivo/{src} (commit {COMMIT}, {TODAY}). Pegar tal cual\n// salvo lo indicado en README.md.\n// ============================================================================\n\n"

# ── archivos completos ──
for src, dst in [('src/services/referralTierService.js', 'src-services-referralTierService.js'),
                 ('src/utils/referralRate.js', 'src-utils-referralRate.js'),
                 ('src/controllers/referralController.js', 'src-controllers-referralController.js'),
                 ('src/routes/referralRoutes.js', 'src-routes-referralRoutes.js'),
                 ('src/services/referralCalculationService.js', 'src-services-referralCalculationService.js'),
                 ('src/models/ReferralMilestoneClaim.js', 'src-models-ReferralMilestoneClaim.js')]:
    shutil.copyfile(src, D + dst)
for img in ['referidos-promo-top.jpg', 'referidos-promo-bottom.jpg']:
    shutil.copyfile('public/img/' + img, D + img)

# ── server.js ──
S = read('server.js')
r1 = find(S, "const ReferralMilestoneClaim = require('./src/models/ReferralMilestoneClaim')")
r2 = find(S, "const { generateReferralCode } = require('./src/utils/referralCode')")
l1 = find(S, '// #168 Link de referido: /linkreferido?ref=CODE'); l2 = find(S, "app.get('/linkreferido'", l1) + 3
c1 = find(S, "// #169: % de comisión de referidos editable en COMANDOS (Config['referralRate']"); c2 = c1 + 1
p1 = find(S, '// #169 % de comisión de referidos (global). GET admin general; POST admin general.')
p2 = find(S, "app.get('/api/admin/refund-tiers'", p1) - 2; p2 = trim_end(S, p2)
b1 = find(S, '// #168 REFERIDOS — tablero vivo, premios por cantidad y link propio') - 1
b2 = find(S, '// PAGOS AUTOMÁTICOS (retiros)', b1) - 2; b2 = trim_end(S, b2)
write('server-01-requires-y-rate.js', hdr("1) server.js — requires, redirect /linkreferido, carga del % plano y endpoints /api/admin/referral-rate (#168/#169)") +
  "// (a) Requires (arriba, junto a los otros modelos/servicios):\n" + lines(S, r1, r2) + "\n\n" +
  "// (b) Ruta pública (antes del static / donde estén las rutas públicas; no usa middlewares):\n" + lines(S, l1, l2) + "\n\n" +
  "// (c) Carga del % plano desde Config al arrancar y cada 60 s (multi-instancia). Acá vive dentro de\n//     `_loadAiConfigIntoService`; si el destino no tiene una función así, usar esta y llamarla en el\n//     bootstrap (después de connectDB) y en un setInterval de 60 s:\nasync function _loadReferralRateFromConfig() {\n" + lines(S, c1, c2) + "\n}\n\n" +
  "// (d) Endpoints del % PLANO (admin general). ⚠️ TDZ: después de `const authMiddleware/adminMiddleware`.\n//     Usan getConfig/setConfig(key, value) de Config y logger.\n" + lines(S, p1, p2))
write('server-02-bloque-168-referidos.js', hdr("2) server.js — BLOQUE '#168 REFERIDOS' completo: dashboard del cliente, config de niveles (#171), netwin por referido para el admin (#175)") +
  "// Rutas: GET /api/referrals/dashboard · POST /api/referrals/milestones/claim (410) · GET/POST\n// /api/admin/referrals/milestones-config · GET /api/admin/referrals/:userId/netwin.\n// ⚠️ TDZ: pegar DESPUÉS de authMiddleware/adminMiddleware/sensitiveLimiter. Dependencias en README.\n\n" +
  lines(S, b1, b2))

# ── panel ──
P = read('public/adminprivado2026/index.html'); A = read('public/adminprivado2026/admin.js')
k1 = find(P, '<!-- #169 % de comisión de referidos (solo admin general) -->')
k2 = find(P, '<!-- Rangos de reembolso bronce/plata/oro', k1) - 1; k2 = trim_end(P, k2)
s1 = find(P, '<!-- Referidos Section -->'); s2 = find(P, '<!-- Publicistas / Campañas Section -->', s1) - 1; s2 = trim_end(P, s2)
write('panel-index.html.part', "<!-- ============================================================================\n     PANEL ADMIN — 2 fragmentos para public/adminprivado2026/index.html\n     ============================================================================ -->\n\n"
  "<!-- (a) En la sección COMANDOS (junto a las otras cards de config del admin general): % plano (#169) -->\n" + lines(P, k1, k2) + "\n\n"
  "<!-- (b) La sección REFERIDOS completa (reemplaza a la vieja). El nav-item data-section=\"referrals\" ya existe. -->\n" + lines(P, s1, s2))
j1 = find(A, '// PANEL DE REFERIDOS - ADMIN') - 1
j2 = find(A, '// =====', j1 + 2)  # fin: siguiente header de sección
j2 = trim_end(A, j2 - 1)
m1 = find(A, '// ── #168 Premios por cantidad de referidos'); m2 = find(A, 'window.loadReferralRate = loadReferralRate;', m1)
sw = find(A, "if (section === 'referrals') loadAdminReferralSummary();"); lr = find(A, '    loadReferralRate();')
write('panel-admin.js.part', "// ============================================================================\n// PANEL ADMIN — fragmentos para public/adminprivado2026/admin.js\n// ============================================================================\n\n"
  "// (a) En el switch de secciones:\n" + lines(A, sw, sw) + "\n\n// (b) En loadCommands() (al abrir COMANDOS):\n" + lines(A, lr - 1, lr) + "\n\n"
  "// (c) BLOQUE 'PANEL DE REFERIDOS - ADMIN' completo (reemplaza al viejo): resumen, actividad (#174),\n//     ranking (#175), tabla de referidores, detalle con netwin por referido, pagos, relaciones, preview/calcular/pagar.\n//     Usa: API_URL, currentToken, fmtFechaAR, fmtFechaHoraAR, showToast, formatMoney.\n\n" + lines(A, j1, j2) + "\n\n"
  "// (d) Config de niveles (#171) y % plano (#169) — van junto a las otras funciones de COMANDOS:\n\n" + lines(A, m1, m2))

# ── PWA ──
I = read('public/index.html'); U = read('public/js/ui.js'); AP = read('public/js/app.js'); AU = read('public/js/auth.js')
css1 = find(I, '/* #168 Card INVITÁ A TUS AMIGOS (home) */'); css2 = find(I, '.ref-pill {', css1)
reg1 = find(I, 'id="registerReferralGroup"'); reg2 = find(I, 'id="registerReferralHint"', reg1) + 1
hc1 = find(I, '<!-- #168 INVITÁ A TUS AMIGOS: progreso'); hc2 = find(I, 'id="referralHomeCard"', hc1)
pm1 = find(I, '<!-- #168 Popup promocional de referidos'); pm2 = find(I, '<!-- #168 Modal de referidos:', pm1) - 1; pm2 = trim_end(I, pm2)
rm1 = pm2 + 2; rm2 = find(I, '    </div>', find(I, 'id="referralModal"', rm1))
write('pwa-index.html.part', "<!-- ============================================================================\n     PWA CLIENTE — fragmentos para public/index.html (+ copiar las 2 imágenes a public/img/)\n     ============================================================================ -->\n\n"
  "<!-- (a) CSS (dentro del <style> principal): card del home, popup y modal de referidos -->\n<style>\n" + lines(I, css1, css2) + "\n</style>\n\n"
  "<!-- (b) En el modal de REGISTRO: campo de código de referido (si el destino ya lo tiene, conservar los ids) -->\n" + lines(I, reg1, reg2) + "\n\n"
  "<!-- (c) En el home (panel colapsable, junto a las otras cards): -->\n" + lines(I, hc1, hc2) + "\n\n"
  "<!-- (d) Popup promocional (1× por apertura) — imágenes /img/referidos-promo-top.jpg y -bottom.jpg -->\n" + lines(I, pm1, pm2) + "\n\n"
  "<!-- (e) Modal de referidos (link + nivel + tablero por referido; lo pinta ui.js) -->\n" + lines(I, rm1, rm2) + "\n\n"
  "<!-- (f) El botón 🤝 de la barra/menú que abre el modal llama VIP.ui.openReferralModal() -->")
u1 = find(U, 'let _refData = null;'); u2 = find(U, 'function copyReferralCode() { copyReferralLink(); }', u1)
ex1 = find(U, '        openReferralModal,'); ex2 = find(U, '        toggleReferralNetLossInfo,', ex1)
a1 = find(AP, '// Auto-fill referral code from URL ?ref=CODE. #168'); a2 = find(AP, "}, 500);", a1) + 2
au1 = find(AU, '// #168: si vino por link de referido (?ref=), el código queda FIJO'); au2 = find(AU, '} else {', find(AU, '} else if (attribution) {', au1)) + 3
au3 = find(AU, 'if (VIP.ui.loadReferralHomeCard) VIP.ui.loadReferralHomeCard();')
write('pwa-js.part', "// ============================================================================\n// PWA CLIENTE — fragmentos para public/js/ui.js, app.js y auth.js (namespace window.VIP)\n// ============================================================================\n\n"
  "// (a) ui.js — bloque de referidos (fetch del dashboard con cache 60 s, modal, card del home, popup,\n//     compartir por WhatsApp/Telegram/share nativo). Usa showModal/hideModal, VIP.config.API_URL,\n//     VIP.state.currentToken, _esc, showToast si existe.\n\n" + lines(U, u1, u2) + "\n\n"
  "// (b) ui.js — sumar al objeto exportado de VIP.ui:\n" + lines(U, ex1, ex2) + "\n\n"
  "// (c) app.js — al cargar la página (antes de que se muestre el login): ?ref= fijo 30 días + abre el registro solo\n" + lines(AP, a1, a2) + "\n\n"
  "// (d) auth.js — dentro de applyRegisterModalMode() (el código queda fijo y no editable si vino por link):\n" + lines(AU, au1, au2) + "\n\n"
  "// (e) auth.js — en initializeSession() (cuando ya hay sesión), junto a las otras cargas del home:\n" + lines(AU, au3, au3 + 1))
print('paquete regenerado en', D, 'commit', COMMIT)
for f in sorted(os.listdir(D)):
    if f.endswith('.js') and not f.startswith('_'):
        r = subprocess.run(['node', '--check', D + f], capture_output=True, text=True)
        print(('OK  ' if r.returncode == 0 else 'FAIL') + ' ' + f + ('' if r.returncode == 0 else '\n' + r.stderr[:400]))
