// =====================================================================
// APP TEST — diagnóstico dentro del modal de Información.
// Testea (1) app instalada y (2) notificaciones activadas. Si está OK
// muestra ✓ verde; si falta algo muestra ✕ roja y abre un menú
// explicativo de cómo instalar la app o activar las notificaciones.
// =====================================================================
window.VIP = window.VIP || {};

VIP.appTest = (function () {

    function _isAppOk() {
        try {
            return !!(VIP.ui && typeof VIP.ui.isAppStandalone === 'function' && VIP.ui.isAppStandalone());
        } catch (e) { return false; }
    }

    function _notifOk() {
        return (typeof Notification !== 'undefined' && Notification.permission === 'granted');
    }

    function _row(icon, label, ok, helpFn, helpLabel) {
        let h = '<div style="display:flex;align-items:center;gap:9px;background:rgba(0,0,0,0.30);border:1px solid '
            + (ok ? 'rgba(102,255,102,0.45)' : 'rgba(255,80,80,0.5)')
            + ';border-radius:10px;padding:9px 11px;">';
        h += '<span style="font-size:18px;">' + icon + '</span>';
        h += '<span style="flex:1;color:#fff;font-weight:700;font-size:12.5px;">' + label + '</span>';
        if (ok) {
            h += '<span style="color:#66ff66;font-weight:900;font-size:13px;letter-spacing:.5px;">✓ OK</span>';
        } else {
            h += '<span style="color:#ff5050;font-weight:900;font-size:17px;line-height:1;">✕</span>';
        }
        h += '</div>';
        if (!ok) {
            h += '<button onclick="' + helpFn + '" style="width:100%;margin-top:5px;background:linear-gradient(135deg,#9d4edd,#6603a8);color:#fff;border:none;border-radius:9px;padding:9px;font-weight:800;font-size:11.5px;cursor:pointer;">'
                + helpLabel + '</button>';
        }
        return h;
    }

    function renderDiagnostics() {
        const box = document.getElementById('infoDiagnostics');
        if (!box) return;
        const appOk = _isAppOk();
        const notifOk = _notifOk();

        let html = '<div style="margin-top:8px;border-top:1px solid rgba(212,175,55,0.3);padding-top:14px;">';
        html += '<h3 style="color:#ffd700;text-align:center;font-size:14px;font-weight:900;margin:0 0 8px;">⚙️ Estado de tu app</h3>';
        html += '<div style="display:flex;flex-direction:column;gap:7px;">';
        html += _row('📲', 'App instalada', appOk, 'VIP.appTest.showInstallHelp()', '📲 Cómo instalar la app');
        html += _row('🔔', 'Notificaciones activadas', notifOk, 'VIP.appTest.showNotifHelp()', '🔔 Cómo activar las notificaciones');
        html += '</div>';
        if (appOk && notifOk) {
            html += '<div style="text-align:center;color:#66ff66;font-weight:800;font-size:12px;margin-top:9px;">✅ ¡Todo perfecto! Estás recibiendo todos los beneficios.</div>';
        }
        html += '</div>';
        box.innerHTML = html;
    }

    function _showHelp(title, bodyHtml) {
        const old = document.getElementById('appTestHelpOverlay');
        if (old) old.remove();
        const ov = document.createElement('div');
        ov.id = 'appTestHelpOverlay';
        ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:27000;display:flex;align-items:center;justify-content:center;padding:16px;';
        ov.onclick = function (e) { if (e.target === ov) ov.remove(); };
        ov.innerHTML = '<div style="background:linear-gradient(135deg,#1a0033,#0a0015);border:2px solid #d4af37;border-radius:16px;padding:20px 18px;max-width:420px;width:100%;color:#fff;box-sizing:border-box;max-height:88vh;overflow-y:auto;">'
            + '<h3 style="color:#ffd700;text-align:center;margin:0 0 12px;font-size:16px;font-weight:900;">' + title + '</h3>'
            + bodyHtml
            + '<button onclick="document.getElementById(\'appTestHelpOverlay\').remove()" style="width:100%;margin-top:14px;background:#d4af37;color:#000;border:none;border-radius:10px;padding:11px;font-weight:800;font-size:13px;cursor:pointer;">Entendido</button>'
            + '</div>';
        document.body.appendChild(ov);
    }

    function _isIOS() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    }

    function showInstallHelp() {
        const steps = _isIOS()
            ? ['Abrí esta página en <strong>Safari</strong>.',
               'Tocá el botón <strong>Compartir</strong> ⬆️ en la barra de abajo.',
               'Elegí <strong>"Agregar a pantalla de inicio"</strong> y después <strong>"Agregar"</strong>.',
               'Abrí la app desde el ícono nuevo en tu pantalla de inicio.']
            : ['Abrí esta página en <strong>Google Chrome</strong>.',
               'Tocá el menú <strong>⋮</strong> (arriba a la derecha).',
               'Elegí <strong>"Instalar app"</strong> o <strong>"Agregar a pantalla de inicio"</strong>.',
               'Abrí la app desde el ícono nuevo en tu pantalla de inicio.'];
        let body = '<p style="color:#ddd;font-size:12.5px;text-align:center;margin:0 0 10px;line-height:1.5;">Instalá la app para recibir notificaciones, bonus y todos los beneficios.</p>';
        body += '<ol style="text-align:left;color:#eee;font-size:12.5px;line-height:1.7;padding-left:20px;margin:0;">';
        steps.forEach(function (s) { body += '<li>' + s + '</li>'; });
        body += '</ol>';
        _showHelp('📲 Cómo instalar la app', body);
    }

    function showNotifHelp() {
        let body = '';
        if (!_isAppOk()) {
            body += '<p style="color:#ffb86b;font-size:12px;text-align:center;margin:0 0 10px;line-height:1.5;">Primero instalá la app: las notificaciones se activan desde la app instalada.</p>';
        }
        const perm = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
        if (perm === 'denied') {
            body += '<p style="color:#ddd;font-size:12.5px;text-align:center;margin:0 0 10px;">Las notificaciones están bloqueadas. Para activarlas:</p>';
            const steps = _isIOS()
                ? ['Entrá a <strong>Ajustes</strong> de tu celular.',
                   'Buscá esta app en la lista de apps.',
                   'Entrá en <strong>Notificaciones</strong> y activá <strong>"Permitir notificaciones"</strong>.']
                : ['Mantené presionado el ícono de la app en tu pantalla.',
                   'Tocá <strong>"Información de la app"</strong>.',
                   'Entrá en <strong>Notificaciones</strong> y activá <strong>"Mostrar notificaciones"</strong>.'];
            body += '<ol style="text-align:left;color:#eee;font-size:12.5px;line-height:1.7;padding-left:20px;margin:0;">';
            steps.forEach(function (s) { body += '<li>' + s + '</li>'; });
            body += '</ol>';
        } else {
            body += '<p style="color:#ddd;font-size:12.5px;text-align:center;margin:0 0 12px;line-height:1.5;">Tocá el botón para activar las notificaciones ahora mismo.</p>';
            body += '<button onclick="VIP.appTest.requestNotif()" style="width:100%;background:linear-gradient(135deg,#00d4ff,#0080ff);color:#000;border:none;border-radius:10px;padding:12px;font-weight:900;font-size:13px;cursor:pointer;">🔔 Activar notificaciones</button>';
        }
        _showHelp('🔔 Cómo activar las notificaciones', body);
    }

    function requestNotif() {
        if (typeof Notification === 'undefined') return;
        Notification.requestPermission().then(function () {
            const ov = document.getElementById('appTestHelpOverlay');
            if (ov) ov.remove();
            renderDiagnostics();
        }).catch(function () {});
    }

    // =================================================================
    // MODAL PROACTIVO DE VERIFICACIÓN (appCheckModal)
    // Se abre al entrar, una vez por sesión, mientras al usuario le falte
    // instalar la app o activar las notificaciones (token push). Cuando
    // ya está todo OK no se muestra más.
    // =================================================================

    // "Push listo" = permiso concedido Y hay un token FCM registrado en el
    // dispositivo. Permiso sin token no alcanza para recibir notificaciones.
    function _hasToken() {
        try { return !!localStorage.getItem('fcmToken'); } catch (e) { return false; }
    }
    function _pushReady() {
        return _notifOk() && _hasToken();
    }

    function renderAppCheck() {
        const box = document.getElementById('appCheckBody');
        if (!box) return;
        const appOk = _isAppOk();
        const pushOk = _pushReady();
        let html = '<div style="display:flex;flex-direction:column;gap:7px;">';
        html += _row('📲', 'App instalada', appOk, 'VIP.appTest.doInstall()', '📲 Instalar la app');
        html += _row('🔔', 'Notificaciones activadas', pushOk, 'VIP.appTest.activateNotifs()', '🔔 Activar notificaciones');
        html += '</div>';
        if (appOk && pushOk) {
            html += '<div style="text-align:center;color:#66ff66;font-weight:800;font-size:12px;margin-top:10px;">✅ ¡Listo! Vas a recibir todas las notificaciones.</div>';
        } else {
            html += '<p style="text-align:center;color:#b0b0b0;font-size:11px;margin:10px 0 0;line-height:1.45;">Completá los pasos en rojo para no perderte bonus ni regalos.</p>';
        }
        box.innerHTML = html;
    }

    function doInstall() {
        if (window.deferredPrompt && VIP.ui && typeof VIP.ui.installApp === 'function') {
            VIP.ui.installApp();
        } else {
            showInstallHelp();
        }
    }

    function activateNotifs() {
        if (typeof Notification === 'undefined') { showNotifHelp(); return; }
        // Permiso bloqueado: no se puede repedir por JS, hay que guiar al usuario.
        if (Notification.permission === 'denied') { showNotifHelp(); return; }
        if (typeof window.enableNotifications === 'function') {
            window.enableNotifications()
                .then(function () { renderAppCheck(); })
                .catch(function () { renderAppCheck(); });
        } else {
            requestNotif();
            renderAppCheck();
        }
    }

    // Decide si abrir el modal: solo si falta app o push, una vez por sesión.
    // Si ya hay otro modal abierto, cede el turno y reintenta en otra sesión
    // (no marca el flag, para no "gastar" la única aparición de la sesión).
    function maybeShowAppCheck() {
        try {
            if (VIP.state && VIP.state.passwordChangePending) return;
            if (sessionStorage.getItem('vip_appCheckShown') === '1') return;
            if (_isAppOk() && _pushReady()) return; // ya está todo OK
            setTimeout(function () {
                try {
                    if (sessionStorage.getItem('vip_appCheckShown') === '1') return;
                    if (_isAppOk() && _pushReady()) return;
                    // No apilar sobre otro modal que ya esté abierto.
                    if (document.querySelector('.modal:not(.hidden)')) return;
                    sessionStorage.setItem('vip_appCheckShown', '1');
                    renderAppCheck();
                    VIP.ui.showModal('appCheckModal');
                } catch (e) { /* noop */ }
            }, 1500);
        } catch (e) { /* sessionStorage no disponible: no bloquear */ }
    }

    // =================================================================
    // TEST DE NOTIFICACIONES — verificación de entrega real
    // Al entrar, manda un push de prueba y le pregunta al usuario si lo
    // recibió. Si dice que no, limpia el token y le pide reiniciar para
    // regenerarlo. Solo corre si el usuario tiene app + permiso + token,
    // y una vez que pasó el test no vuelve a correr.
    // =================================================================

    // Decide si correr el test. Si el token todavía no está (puede estar
    // regenerándose tras un reinicio) reintenta unas veces.
    function maybeRunNotifTest(attempt) {
        attempt = attempt || 0;
        try {
            if (VIP.state && VIP.state.passwordChangePending) return;
            if (!_isAppOk() || !_notifOk()) return;        // sin app/permiso no aplica
            if (localStorage.getItem('vip_notifTestPassed') === '1') return;
            if (sessionStorage.getItem('vip_notifTestRan') === '1') return;
            if (!_hasToken()) {
                // El token puede estar generándose (post-reinicio). Reintentar.
                if (attempt < 6) setTimeout(function () { maybeRunNotifTest(attempt + 1); }, 3000);
                return;
            }
            sessionStorage.setItem('vip_notifTestRan', '1');
            setTimeout(_runNotifTest, 2000);
        } catch (e) { /* noop */ }
    }

    async function _runNotifTest() {
        let token = null;
        try { token = localStorage.getItem('fcmToken'); } catch (e) { /* noop */ }
        if (!token || !VIP.state || !VIP.state.currentToken) return;
        try {
            const res = await fetch(VIP.config.API_URL + '/api/notifications/self-test', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + VIP.state.currentToken
                },
                body: JSON.stringify({ fcmToken: token })
            });
            const data = await res.json().catch(function () { return {}; });
            if (data && data.ok) {
                // El push salió: esperar a que llegue y preguntar.
                setTimeout(_showTestQuestion, 3500);
            } else if (data && data.invalidToken) {
                // FCM rechazó el token: ya está muerto, sin preguntar.
                _showTestFailed(true);
            }
            // Otros errores: silencioso, se reintenta en otra sesión.
        } catch (e) { /* error de red: no molestar */ }
    }

    function _showTestQuestion() {
        const box = document.getElementById('notifTestBody');
        if (!box) return;
        let html = '<div style="text-align:center;">';
        html += '<div style="font-size:46px;line-height:1;margin-bottom:6px;">📩</div>';
        html += '<h2 style="color:#d4af37;font-size:18px;margin:0 0 6px;">Test de notificaciones</h2>';
        html += '<p style="color:#ccc;font-size:13px;line-height:1.5;margin:0 0 16px;">Te acabamos de enviar una notificación de prueba. <strong style="color:#fff;">¿La recibiste?</strong></p>';
        html += '</div>';
        html += '<div style="display:flex;flex-direction:column;gap:8px;">';
        html += '<button onclick="VIP.appTest.notifTestYes()" class="btn btn-primary" style="width:100%;">✅ Sí, la recibí</button>';
        html += '<button onclick="VIP.appTest.notifTestNo()" class="btn btn-secondary" style="width:100%;">❌ No me llegó</button>';
        html += '</div>';
        box.innerHTML = html;
        try { VIP.ui.showModal('notifTestModal'); } catch (e) { /* noop */ }
    }

    function notifTestYes() {
        try { localStorage.setItem('vip_notifTestPassed', '1'); } catch (e) { /* noop */ }
        try { VIP.ui.hideModal('notifTestModal'); } catch (e) { /* noop */ }
        if (VIP.ui && VIP.ui.showToast) VIP.ui.showToast('✅ Notificaciones verificadas', 'success');
    }

    async function notifTestNo() {
        const box = document.getElementById('notifTestBody');
        if (box) box.innerHTML = '<div style="text-align:center;color:#ccc;padding:24px 12px;font-size:13px;">⏳ Limpiando tu conexión de notificaciones...</div>';
        let token = null;
        try { token = localStorage.getItem('fcmToken'); } catch (e) { /* noop */ }
        // Avisar al backend que borre el token muerto.
        if (token && VIP.state && VIP.state.currentToken) {
            try {
                await fetch(VIP.config.API_URL + '/api/notifications/unregister-token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + VIP.state.currentToken
                    },
                    body: JSON.stringify({ fcmToken: token })
                });
            } catch (e) { /* best-effort */ }
        }
        _showTestFailed(true);
    }

    // Limpia el token del lado cliente y muestra el cartel de reinicio.
    function _showTestFailed() {
        if (typeof window.resetFcmToken === 'function') {
            try { window.resetFcmToken(); } catch (e) { /* noop */ }
        } else {
            try {
                localStorage.removeItem('fcmToken');
                localStorage.removeItem('fcmTokenContext');
                localStorage.removeItem('fcmPushEndpoint');
            } catch (e) { /* noop */ }
        }
        try {
            localStorage.removeItem('vip_notifTestPassed');
            // Permitir que el test vuelva a correr tras el reinicio.
            sessionStorage.removeItem('vip_notifTestRan');
        } catch (e) { /* noop */ }

        const box = document.getElementById('notifTestBody');
        if (!box) return;
        let html = '<div style="text-align:center;">';
        html += '<div style="font-size:46px;line-height:1;margin-bottom:6px;">🔄</div>';
        html += '<h2 style="color:#ffaa66;font-size:17px;margin:0 0 8px;">Reiniciá la app</h2>';
        html += '<p style="color:#ccc;font-size:13px;line-height:1.55;margin:0 0 16px;">Limpiamos tu conexión de notificaciones. <strong style="color:#fff;">Cerrá y volvé a abrir la app</strong> (o tocá el botón) para reactivarlas y quedar 100% verificado.</p>';
        html += '</div>';
        html += '<button onclick="location.reload()" class="btn btn-primary" style="width:100%;">🔄 Reiniciar ahora</button>';
        box.innerHTML = html;
        try { VIP.ui.showModal('notifTestModal'); } catch (e) { /* noop */ }
    }

    return {
        renderDiagnostics: renderDiagnostics,
        showInstallHelp: showInstallHelp,
        showNotifHelp: showNotifHelp,
        requestNotif: requestNotif,
        renderAppCheck: renderAppCheck,
        maybeShowAppCheck: maybeShowAppCheck,
        doInstall: doInstall,
        activateNotifs: activateNotifs,
        maybeRunNotifTest: maybeRunNotifTest,
        notifTestYes: notifTestYes,
        notifTestNo: notifTestNo
    };

})();
