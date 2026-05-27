// =====================================================================
// PUBLISHER WELCOME — bienvenida en 2 pasos para usuarios atribuidos a
// una campaña/publicista.
//
// Cuándo se muestra:
//   - currentUser.acquisitionCampaign !== null  (vino de una campaña)
//   - currentUser.publisherWelcomeSeenAt === null  (todavía no aceptó el welcome)
//   - currentUser.mustChangePassword !== true  (cambio de pass tiene prioridad)
//   - currentUser.passwordChangePending !== true  (idem)
//
// Flujo:
//   Paso 1 (bienvenida) → [Siguiente] → Paso 2 (beneficios)
//   Paso 2: tildar checkbox habilita [COMENZAR A JUGAR]
//   Al tocar COMENZAR: POST /api/users/me/publisher-welcome-seen, cierra modal.
//
// Una vez marcado, el modal nunca vuelve a aparecer (publisherWelcomeSeenAt
// queda con timestamp en la DB).
// =====================================================================
window.VIP = window.VIP || {};

VIP.publisherWelcome = (function () {

    function _open() {
        const modal = document.getElementById('publisherWelcomeModal');
        if (!modal) return;
        // Reset al paso 1 cada vez que se abre (por si quedó algo del último render).
        const s1 = document.getElementById('publisherWelcomeStep1');
        const s2 = document.getElementById('publisherWelcomeStep2');
        if (s1) s1.style.display = '';
        if (s2) s2.style.display = 'none';
        const chk = document.getElementById('publisherWelcomeAcceptCheck');
        const finishBtn = document.getElementById('publisherWelcomeFinishBtn');
        if (chk) chk.checked = false;
        if (finishBtn) {
            finishBtn.disabled = true;
            finishBtn.style.opacity = '0.5';
        }
        VIP.ui.showModal('publisherWelcomeModal');
    }

    function _goToStep2() {
        const s1 = document.getElementById('publisherWelcomeStep1');
        const s2 = document.getElementById('publisherWelcomeStep2');
        if (s1) s1.style.display = 'none';
        if (s2) s2.style.display = '';
    }

    function _goToStep1() {
        const s1 = document.getElementById('publisherWelcomeStep1');
        const s2 = document.getElementById('publisherWelcomeStep2');
        if (s1) s1.style.display = '';
        if (s2) s2.style.display = 'none';
    }

    function _onCheckChange() {
        const chk = document.getElementById('publisherWelcomeAcceptCheck');
        const btn = document.getElementById('publisherWelcomeFinishBtn');
        if (!chk || !btn) return;
        const ok = chk.checked === true;
        btn.disabled = !ok;
        btn.style.opacity = ok ? '1' : '0.5';
    }

    async function _finish() {
        const chk = document.getElementById('publisherWelcomeAcceptCheck');
        if (!chk || !chk.checked) return;
        const btn = document.getElementById('publisherWelcomeFinishBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
        try {
            const r = await fetch(`${VIP.config.API_URL}/api/users/me/publisher-welcome-seen`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${VIP.state.currentToken}`,
                    'Content-Type': 'application/json'
                }
            });
            // Aún si el endpoint falla por red transitoria, no trabamos al
            // usuario. Marcamos local (sesión) y dejamos pasar. La próxima
            // vez que recargue, si la DB no se actualizó, vuelve a aparecer.
            if (VIP.state.currentUser) {
                VIP.state.currentUser.publisherWelcomeSeenAt = new Date().toISOString();
            }
            try { sessionStorage.setItem('vip_publisherWelcomeSeen', '1'); } catch (e) {}
            if (!r.ok) {
                console.warn('[publisherWelcome] endpoint devolvió error, cerrando igual', r.status);
            }
        } catch (e) {
            console.warn('[publisherWelcome] error marcando como visto:', e.message);
        } finally {
            VIP.ui.hideModal('publisherWelcomeModal');
            if (btn) { btn.disabled = false; btn.textContent = '🎮 COMENZAR A JUGAR'; }
        }
    }

    // Trigger desde ui.js. Muestra el modal sólo si corresponde.
    function maybeShow() {
        const u = VIP.state && VIP.state.currentUser;
        if (!u) return;
        // No bloquear al usuario si tiene cambio de contraseña pendiente —
        // ese flujo tiene prioridad y nuestro endpoint sería rechazado.
        if (u.mustChangePassword === true || u.needsPasswordChange === true) return;
        if (VIP.state.passwordChangePending) return;
        // Sólo si vino de una campaña/publicista.
        if (!u.acquisitionCampaign) return;
        // Si ya lo vio (DB o sessionStorage local), no repetir.
        if (u.publisherWelcomeSeenAt) return;
        try {
            if (sessionStorage.getItem('vip_publisherWelcomeSeen') === '1') return;
        } catch (e) {}
        _open();
    }

    // Bind events. Se llama una sola vez desde app.js.
    function init() {
        const nextBtn = document.getElementById('publisherWelcomeNextBtn');
        const backBtn = document.getElementById('publisherWelcomeBackBtn');
        const finishBtn = document.getElementById('publisherWelcomeFinishBtn');
        const chk = document.getElementById('publisherWelcomeAcceptCheck');
        if (nextBtn) nextBtn.addEventListener('click', _goToStep2);
        if (backBtn) backBtn.addEventListener('click', _goToStep1);
        if (finishBtn) finishBtn.addEventListener('click', _finish);
        if (chk) chk.addEventListener('change', _onCheckChange);
    }

    return { init: init, maybeShow: maybeShow };
})();
