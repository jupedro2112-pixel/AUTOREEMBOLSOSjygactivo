// =====================================================================
// NOTIF CHECK — card en el home cuando admin manda un test de notifs.
// =====================================================================
// Flujo:
//   1) Boot: fetch /api/notif-check/active.
//   2) Si hay check activo y el user NO confirmó: muestra card amarillo
//      con el mensaje del admin + botón "CONFIRMAR".
//   3) Click → POST /api/notif-check/confirm → muestra "✅ confirmado".
//   4) Listener de PUSH_NOTIFICATION_CLICK con source='notif-check'
//      → auto-confirma (source='push_tap') + refresh.
// =====================================================================
(function () {
    'use strict';
    window.VIP = window.VIP || {};

    let _active = null;

    function _esc(s) {
        const d = document.createElement('div');
        d.textContent = String(s == null ? '' : s);
        return d.innerHTML;
    }

    async function loadActive() {
        if (!VIP.state || !VIP.state.currentToken) return;
        try {
            const r = await fetch(`${VIP.config.API_URL}/api/notif-check/active`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (!r.ok) return;
            const d = await r.json();
            if (!d || !d.success) return;
            _active = d.active;
            render();
        } catch (e) { /* best-effort */ }
    }

    function render() {
        const card = document.getElementById('notifCheckCard');
        if (!card) return;
        if (!_active) { card.style.display = 'none'; card.innerHTML = ''; return; }

        const a = _active;
        let html = '';
        if (a.alreadyConfirmed) {
            html += '<div style="background:linear-gradient(135deg,rgba(102,255,102,0.10),rgba(102,255,102,0.04));border:1.5px solid #66ff66;border-radius:12px;padding:10px 12px;margin:10px auto;max-width:560px;display:flex;align-items:center;gap:10px;">';
            html += '<div style="font-size:24px;">✅</div>';
            html += '<div style="flex:1;"><div style="color:#66ff66;font-weight:900;font-size:12px;letter-spacing:1px;text-transform:uppercase;">Notificaciones funcionando</div><div style="color:#ddd;font-size:11.5px;line-height:1.3;">Confirmaste que te llegan las notificaciones. Gracias 🙌</div></div>';
            html += '</div>';
        } else {
            html += '<div style="background:linear-gradient(135deg,rgba(0,212,255,0.10),rgba(255,215,0,0.05));border:2px solid #00d4ff;border-radius:12px;padding:13px 14px;margin:10px auto;max-width:560px;box-shadow:0 0 16px rgba(0,212,255,0.20);">';
            html += '<div style="color:#00d4ff;font-weight:900;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">🔔 ' + _esc(a.title || 'Test de notificaciones') + '</div>';
            html += '<div style="color:#fff;font-size:13px;line-height:1.4;margin-bottom:10px;">' + _esc(a.message) + '</div>';
            html += '<button id="ncConfirmBtn" onclick="VIP.notifCheck && VIP.notifCheck.confirm()" style="width:100%;background:linear-gradient(135deg,#00d4ff,#0080ff);color:#000;border:none;padding:11px;border-radius:8px;font-weight:900;font-size:13px;cursor:pointer;letter-spacing:1px;">✅ SÍ, ME LLEGÓ — CONFIRMAR</button>';
            html += '<div style="color:#888;font-size:10.5px;text-align:center;margin-top:6px;">Tocar este botón le confirma al admin que las notificaciones te están llegando bien.</div>';
            html += '</div>';
        }
        card.innerHTML = html;
        card.style.display = '';
    }

    async function confirm(source) {
        if (!_active || _active.alreadyConfirmed) return;
        const btn = document.getElementById('ncConfirmBtn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Confirmando…'; }
        try {
            const r = await fetch(`${VIP.config.API_URL}/api/notif-check/confirm`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${VIP.state.currentToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ checkId: _active.id, source: source || 'manual_button' })
            });
            const d = await r.json();
            if (r.ok && d.success) {
                _active.alreadyConfirmed = true;
                render();
            } else {
                if (btn) { btn.disabled = false; btn.textContent = '✅ SÍ, ME LLEGÓ — CONFIRMAR'; }
                alert(d.error || 'Error confirmando');
            }
        } catch (e) {
            if (btn) { btn.disabled = false; btn.textContent = '✅ SÍ, ME LLEGÓ — CONFIRMAR'; }
        }
    }

    VIP.notifCheck = { loadActive, confirm };

    // Boot.
    document.addEventListener('DOMContentLoaded', () => {
        const tryLoad = () => {
            if (VIP.state && VIP.state.currentToken) loadActive();
            else setTimeout(tryLoad, 1500);
        };
        setTimeout(tryLoad, 900);
    });

    // SW postMessage: cuando el user toca el push de notif-check,
    // auto-confirmamos sin que tenga que tocar el botón.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            const msg = event && event.data;
            if (!msg || msg.type !== 'PUSH_NOTIFICATION_CLICK') return;
            const d = msg.data || {};
            if (d.source === 'notif-check' && d.checkId) {
                // Auto-confirm vía push tap.
                if (!_active || _active.id !== d.checkId) {
                    _active = { id: d.checkId, alreadyConfirmed: false, title: '', message: '' };
                }
                confirm('push_tap');
            }
        });
    }

    // Refresh al volver visible.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') loadActive();
    });
})();
