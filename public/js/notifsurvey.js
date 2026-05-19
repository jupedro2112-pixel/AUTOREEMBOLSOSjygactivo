// ========================================
// NOTIF SURVEY - Encuesta de plan de notificaciones
// ========================================
// Al abrir la app instalada (standalone), si el usuario todavía no eligió un
// plan de notificaciones, se le muestra una encuesta obligatoria. El plan
// queda guardado en el usuario y se puede cambiar después desde Configuración.

window.VIP = window.VIP || {};

VIP.notifSurvey = (function () {

    const PLAN_LABELS = {
        suave: 'Suave',
        normal: 'Normal',
        activo: 'Activo',
        solo_reembolsos: 'Solo reembolsos'
    };

    // Abre el modal. editable=true muestra la X para cerrar (cambio desde
    // Configuración); editable=false es el modo obligatorio (encuesta inicial).
    function _open(editable) {
        const closeBtn = document.getElementById('notifSurveyCloseBtn');
        if (closeBtn) closeBtn.style.display = editable ? '' : 'none';
        const errEl = document.getElementById('notifSurveyError');
        if (errEl) { errEl.textContent = ''; errEl.classList.remove('show'); }
        VIP.ui.showModal('notifSurveyModal');
    }

    // Se llama al entrar al chat. Muestra la encuesta obligatoria solo si:
    // el usuario está en la app instalada, no hay cambio de clave pendiente,
    // y todavía no eligió un plan.
    function maybeShow() {
        if (VIP.state.passwordChangePending) return;
        const u = VIP.state.currentUser;
        // No mostrar la encuesta si hay un cambio de contraseña obligatorio:
        // en modo obligatorio la encuesta no se puede cerrar y guardar el plan
        // responde 403 MUST_CHANGE_PASSWORD -> el usuario quedaría trabado.
        if (u && (u.mustChangePassword === true || u.needsPasswordChange === true)) return;
        const plan = u && u.notificationPlan;
        if (plan) return;
        // Guarda local: si ya votó en este dispositivo, no volver a mostrar la
        // encuesta aunque el plan no haya viajado en el objeto de usuario.
        try { if (localStorage.getItem('vip_notifPlanVoted') === '1') return; } catch (e) {}
        _open(false);
    }

    // Cambio voluntario del plan desde Configuración.
    function openEditable() {
        VIP.ui.hideModal('settingsModal');
        _open(true);
    }

    async function select(plan) {
        if (!PLAN_LABELS[plan]) return;
        const errEl = document.getElementById('notifSurveyError');
        if (errEl) { errEl.textContent = ''; errEl.classList.remove('show'); }
        const cards = document.querySelectorAll('.notif-plan-card');
        cards.forEach(c => { c.disabled = true; });

        try {
            const res = await fetch(`${VIP.config.API_URL}/api/notification-plan`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                },
                body: JSON.stringify({ plan })
            });
            const data = await res.json().catch(() => ({}));

            // Cambio de contraseña obligatorio: el server rechaza con 403. La
            // encuesta en modo obligatorio no tiene botón de cerrar, así que la
            // cerramos a mano y abrimos el modal de cambio de contraseña para
            // que el usuario no quede trabado detrás de la encuesta.
            if (res.status === 403 && data && data.code === 'MUST_CHANGE_PASSWORD') {
                VIP.state.passwordChangePending = true;
                VIP.ui.hideModal('notifSurveyModal');
                try {
                    if (VIP.auth && typeof VIP.auth.prepareChangePasswordModal === 'function') {
                        VIP.auth.prepareChangePasswordModal();
                    }
                } catch (e) { /* ignore */ }
                VIP.ui.showModal('changePasswordModal');
                return;
            }

            if (res.ok && data.success) {
                if (VIP.state.currentUser) VIP.state.currentUser.notificationPlan = plan;
                try { localStorage.setItem('vip_notifPlanVoted', '1'); } catch (e) {}
                VIP.ui.hideModal('notifSurveyModal');
                VIP.ui.showToast('✅ Plan guardado: ' + PLAN_LABELS[plan], 'success');
            } else {
                if (errEl) {
                    errEl.textContent = data.error || 'No se pudo guardar el plan. Intentá de nuevo.';
                    errEl.classList.add('show');
                }
            }
        } catch (e) {
            if (errEl) {
                errEl.textContent = 'Error de conexión. Intentá de nuevo.';
                errEl.classList.add('show');
            }
        } finally {
            cards.forEach(c => { c.disabled = false; });
        }
    }

    function close() {
        VIP.ui.hideModal('notifSurveyModal');
    }

    return { maybeShow, openEditable, select, close };

})();
