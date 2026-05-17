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

    return {
        renderDiagnostics: renderDiagnostics,
        showInstallHelp: showInstallHelp,
        showNotifHelp: showNotifHelp,
        requestNotif: requestNotif
    };

})();
