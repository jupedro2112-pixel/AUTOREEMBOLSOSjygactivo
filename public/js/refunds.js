// ========================================
// REFUNDS - Reembolsos module
// ========================================

window.VIP = window.VIP || {};

VIP.refunds = (function () {

    // ---- Requisitos para reclamar: PWA instalada + notificaciones permitidas ----
    function isStandalone() {
        try {
            return window.matchMedia('(display-mode: standalone)').matches ||
                   window.navigator.standalone === true;
        } catch (_) { return false; }
    }

    function isNotifGranted() {
        try {
            return ('Notification' in window) && Notification.permission === 'granted';
        } catch (_) { return false; }
    }

    function canClaim() {
        return isStandalone() && isNotifGranted();
    }

    // Solo el reembolso mensual y el bono de bienvenida exigen PWA instalada
    // + notificaciones activas. Daily y weekly se reclaman libremente, aunque
    // seguimos sugiriendo instalar la app y activar notificaciones para que
    // el usuario reciba los avisos de acreditacion.
    function claimRequirementsMet(type) {
        if (type === 'monthly' || type === 'welcome') return canClaim();
        return true;
    }

    // Estado pendiente: si el user intenta reclamar sin cumplir, recordamos el
    // tipo para retomar automáticamente cuando los requisitos se cumplan.
    let _pendingClaimType = null;

    // Detecta si la app ya fue instalada en este navegador. Combina dos señales:
    //  - el flag persistido en localStorage por el handler `appinstalled`,
    //  - el modo standalone actual (caso de instalaciones previas al flag).
    function isAppInstalled() {
        try {
            if (localStorage.getItem('vipAppInstalled') === '1') return true;
        } catch (_) {}
        return isStandalone();
    }

    function refreshRequirementsModal() {
        const inApp = isStandalone();
        const installed = isAppInstalled();
        const notifOk = isNotifGranted();
        const isWelcome = _pendingClaimType === 'welcome';

        const installBadge = document.getElementById('reqInstallBadge');
        const openAppBadge = document.getElementById('reqOpenAppBadge');
        const notifBadge   = document.getElementById('reqNotifBadge');
        const installBtn   = document.getElementById('reqInstallBtn');
        const notifBtn     = document.getElementById('reqNotifBtn');
        const introMsg     = document.getElementById('reqIntroMsg');
        const notifHelp    = document.getElementById('reqNotifHelp');
        const openAppHelp  = document.getElementById('reqOpenAppHelp');
        // Customizacion del titulo del modal segun el origen del trigger.
        const titleEl = document.querySelector('#refundRequirementsModal .modal-header h2');
        if (titleEl) {
            titleEl.textContent = isWelcome
                ? '🎁 Pasos para tu bono de $5.000'
                : '🔒 Para reclamar tu reembolso';
        }

        // 3 estados independientes: instalada, abierta-desde-app, notifs ok.
        if (installBadge) installBadge.textContent = installed ? '✅' : '⏳';
        if (openAppBadge) openAppBadge.textContent = inApp ? '✅' : '⏳';
        if (notifBadge)   notifBadge.textContent   = notifOk ? '✅' : '⏳';

        if (installBtn) {
            installBtn.disabled = installed;
            installBtn.textContent = installed ? '✅ App instalada' : '📱 Instalar la app';
            installBtn.style.opacity = installed ? '0.6' : '1';
        }

        // El paso 3 (notificaciones) solo tiene sentido cuando el user ya
        // esta dentro de la app. Si no, deshabilitamos el boton y avisamos.
        if (notifBtn) {
            const canRequestNotif = inApp && !notifOk;
            notifBtn.disabled = !canRequestNotif;
            if (notifOk) {
                notifBtn.textContent = '✅ Notificaciones activas';
                notifBtn.style.opacity = '0.6';
            } else if (!inApp) {
                notifBtn.textContent = '🔒 Primero abrí la app';
                notifBtn.style.opacity = '0.5';
            } else {
                notifBtn.textContent = '🔔 Activar notificaciones';
                notifBtn.style.opacity = '1';
            }
        }
        if (notifHelp) {
            notifHelp.innerHTML = inApp
                ? 'Cuando el sistema te lo pida, tocá <strong>Permitir</strong>. Sin notificaciones no podemos avisarte cuando tu bono se acredite.'
                : '<strong>Este paso solo se desbloquea desde la app.</strong> Abrí el ícono de la app en tu celular y volvé acá para activarlas.';
        }
        if (openAppHelp) {
            openAppHelp.innerHTML = inApp
                ? '✅ Estás dentro de la app. Andá al paso 3.'
                : 'Una vez instalada, salí del navegador y abrí la app desde el ícono que quedó en tu celular. Después volvé a este botón para completar el último paso.';
        }

        // Mensaje introductorio: cambia segun en que paso esta el user.
        const subjectClaim = isWelcome ? 'tu bono de $5.000' : 'tu reembolso';
        if (introMsg) {
            if (!installed) {
                introMsg.innerHTML = 'Para desbloquear ' + subjectClaim + ' tenés que completar 3 pasos. <strong>Empezá instalando la app.</strong>';
            } else if (!inApp) {
                introMsg.innerHTML = '✅ App instalada. Ahora <strong>abrí la app desde el ícono</strong> de tu celular para continuar.';
            } else if (!notifOk) {
                introMsg.innerHTML = '✅ Estás dentro de la app. Último paso: <strong>activá las notificaciones</strong> para reclamar ' + subjectClaim + '.';
            } else {
                introMsg.innerHTML = '🎉 ¡Listo! Cumpliste todos los pasos. Cerrá este aviso y reclamá ' + subjectClaim + '.';
            }
        }

        // Sincronizar tambien el subtitulo del card del bono de bienvenida
        // (refleja el estado actual de instalacion + notifs).
        try { renderWelcomeBonusCard(); } catch (_) {}

        return inApp && notifOk;
    }

    function openRequirementsModal(claimType) {
        _pendingClaimType = claimType || null;
        refreshRequirementsModal();
        VIP.ui.showModal('refundRequirementsModal');
    }

    async function handleRequirementInstall() {
        try {
            if (VIP.ui && typeof VIP.ui.installApp === 'function') {
                await VIP.ui.installApp();
            } else {
                VIP.ui.showToast('Buscá "Instalar app" en el menú de tu navegador.', 'info');
            }
        } catch (err) {
            console.error('installApp error:', err);
        }
        // Esperar un poco a que el sistema haga el cambio de display-mode
        setTimeout(() => {
            const ready = refreshRequirementsModal();
            if (ready) tryResumePendingClaim();
        }, 800);
    }

    async function handleRequirementNotif() {
        try {
            if (typeof window.enableNotifications === 'function') {
                await window.enableNotifications();
            } else if (VIP.notifications && typeof VIP.notifications.requestNotificationPermission === 'function') {
                VIP.notifications.requestNotificationPermission();
            } else if ('Notification' in window) {
                await Notification.requestPermission();
            }
        } catch (err) {
            console.error('enableNotifications error:', err);
        }
        setTimeout(() => {
            const ready = refreshRequirementsModal();
            if (ready) tryResumePendingClaim();
        }, 600);
    }

    function tryResumePendingClaim() {
        if (!_pendingClaimType) return;
        if (!claimRequirementsMet(_pendingClaimType)) return;
        const type = _pendingClaimType;
        _pendingClaimType = null;
        VIP.ui.hideModal('refundRequirementsModal');
        if (type === 'welcome') {
            VIP.ui.showToast('✅ Listo. Reclamando tu bono de bienvenida…', 'success');
            setTimeout(() => claimWelcomeBonus(), 250);
            return;
        }
        VIP.ui.showToast('✅ Listo. Continuamos con tu reembolso…', 'success');
        // Pequeño delay para que el toast sea visible antes de abrir el modal del reembolso.
        setTimeout(() => showRefundModal(type), 250);
    }

    async function loadRefundStatus() {
        // Prefill desde cache ANTES de la fetch. La primera vez que se llama
        // este modulo el listener de DOMContentLoaded ya corrio con currentUser
        // null, por lo que el prefill miro el bucket 'anon'. Aca currentUser
        // ya esta seteado tras login -> reintentamos con la key correcta.
        try { _prefillFromCache(); } catch (_) {}
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/refunds/status`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (response.ok) {
                VIP.state.refundStatus = await response.json();
                updateRefundButtons();
                updateUserBalance();
            }
        } catch (error) {
            console.error('Error cargando reembolsos:', error);
        }
        // Cargar estado del bono de bienvenida en paralelo (no bloqueante).
        loadWelcomeBonusStatus();
        // Cargar estado del regalo de difusion en paralelo (no bloqueante).
        loadGiveawayStatus();
        // Cargar total historico para el subtexto del welcome.
        loadGiveawayTotal();
        // Banner de ganador reciente en el home (ventana 6h). Es el cartel
        // que el owner pidio para que la gente vea ganadores sin abrir el
        // modal de sorteos. Render condicional (no aparece si no hay
        // ganadores en la ventana).
        if (VIP.raffles && typeof VIP.raffles.loadHomeWinnerBanner === 'function') {
            VIP.raffles.loadHomeWinnerBanner();
        }
    }

    // ---- Cache de montos en localStorage para evitar el flash de $0 en cold-start ----
    // Cuando el user cierra y reabre la app, mientras la API responde, mostramos
    // el ultimo valor conocido en vez de $0. Por usuario para no mezclar sesiones.
    function _cacheKey(field) {
        // currentUser es un OBJETO. Concatenarlo daria "[object Object]"
        // y mezclaria sesiones entre usuarios + romperia el match write/read.
        // Usamos .username (puede venir undefined antes del login → 'anon').
        const u = (VIP.state && VIP.state.currentUser && VIP.state.currentUser.username) || 'anon';
        return 'vipAmtCache:' + u + ':' + field;
    }
    function _saveCachedAmount(field, value) {
        try { localStorage.setItem(_cacheKey(field), String(value)); } catch (_) {}
    }
    function _loadCachedAmount(field) {
        try {
            const v = localStorage.getItem(_cacheKey(field));
            if (v == null) return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        } catch (_) { return null; }
    }

    // Pinta el saldo del usuario en la plataforma JUGAYGANA en el card del home.
    function updateUserBalance() {
        const el = document.getElementById('userBalanceAmount');
        if (!el) return;
        const bal = (VIP.state.refundStatus && VIP.state.refundStatus.user && VIP.state.refundStatus.user.currentBalance) || 0;
        el.textContent = '$' + Number(bal).toLocaleString('es-AR');
        _saveCachedAmount('balance', bal);
    }

    function updateRefundButtons() {
        if (!VIP.state.refundStatus) return;
        updateRefundButton('daily', VIP.state.refundStatus.daily);
        updateRefundButton('weekly', VIP.state.refundStatus.weekly);
        updateRefundButton('monthly', VIP.state.refundStatus.monthly);
    }

    function updateRefundButton(type, data) {
        const btn    = document.getElementById(`${type}RefundBtn`);
        const amount = document.getElementById(`${type}RefundAmount`);
        const timer  = document.getElementById(`${type}RefundTimer`);

        btn.disabled = false;
        btn.classList.remove('claimed');

        // Caso "ya reclamado este período": mostramos el monto reclamado en gris
        // y el countdown al próximo, sin sugerir que se puede volver a reclamar.
        if (data.claimed) {
            const claimedAmt = Number(data.lastClaimAmount || 0);
            amount.textContent = `$${claimedAmt.toLocaleString()}`;
            _saveCachedAmount('refund_' + type, claimedAmt);
            btn.classList.add('claimed');
            btn.style.opacity = '0.55';
            if (data.nextClaim) {
                startCountdown(type, data.nextClaim);
            } else {
                timer.textContent = '✓ Reclamado';
            }
            return;
        }

        amount.textContent = `$${(data.potentialAmount || 0).toLocaleString()}`;
        _saveCachedAmount('refund_' + type, data.potentialAmount || 0);

        if (data.canClaim && data.potentialAmount > 0) {
            timer.textContent = '¡Listo!';
            btn.style.opacity = '1';
        } else {
            btn.style.opacity = '0.7';
            if (data.nextClaim) {
                startCountdown(type, data.nextClaim);
            } else {
                timer.textContent = 'Ver info';
            }
        }
    }

    function startCountdown(type, targetDate) {
        const timerElement = document.getElementById(`${type}RefundTimer`);

        function update() {
            const now    = getArgentinaDate();
            const target = new Date(targetDate);
            const diff   = target - now;

            if (diff <= 0) {
                timerElement.textContent = '¡Listo!';
                loadRefundStatus();
                return;
            }

            const hours   = Math.floor(diff / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

            if (hours > 24) {
                timerElement.textContent = `${Math.floor(hours / 24)}d`;
            } else {
                timerElement.textContent = `${hours}h ${minutes}m`;
            }
        }

        update();
        if (VIP.state.refundTimers[type]) clearInterval(VIP.state.refundTimers[type]);
        VIP.state.refundTimers[type] = setInterval(update, 60000);
    }

    async function showRefundModal(type) {
        console.log('🎁 Abriendo modal de reembolso:', type);

        if (!VIP.state.refundStatus) {
            VIP.ui.showToast('Cargando información de reembolsos...', 'info');
            await loadRefundStatus();
            if (!VIP.state.refundStatus) {
                VIP.ui.showToast('Error: No se pudo cargar la información de reembolsos. Intenta recargar la página.', 'error');
                return;
            }
        }

        const typeData = VIP.state.refundStatus[type];
        const titles = {
            daily:   '📅 Reembolso Diario (8%)',
            weekly:  '📆 Reembolso Semanal (5%)',
            monthly: '🗓️ Reembolso Mensual (3%)'
        };
        const periodLabels = {
            daily:   '📊 PÉRDIDAS DE AYER',
            weekly:  '📊 PÉRDIDAS DE LA SEMANA PASADA (Lun-Dom)',
            monthly: '📊 PÉRDIDAS DEL MES PASADO'
        };

        document.getElementById('refundModalTitle').textContent = titles[type];
        document.getElementById('refundMovementsTitle').textContent = periodLabels[type];

        const currentBalance = VIP.state.refundStatus.user?.currentBalance || 0;
        document.getElementById('refundCurrentBalance').textContent = `$${currentBalance.toLocaleString()}`;
        document.getElementById('refundPeriod').textContent = typeData.period || '-';
        document.getElementById('refundNetAmount').textContent = `$${(typeData.netAmount || 0).toLocaleString()}`;
        document.getElementById('refundAmount').textContent = `$${(typeData.potentialAmount || 0).toLocaleString()}`;
        const depEl = document.getElementById('refundDeposits');
        const witEl = document.getElementById('refundWithdrawals');
        const srcEl = document.getElementById('refundDebugSource');
        if (depEl) depEl.textContent = `$${(typeData.deposits || 0).toLocaleString()}`;
        if (witEl) witEl.textContent = `$${(typeData.withdrawals || 0).toLocaleString()}`;
        if (srcEl) srcEl.textContent = 'Gracias por confiar en nosotros.';

        const availabilityInfo = document.getElementById('refundAvailabilityInfo');
        availabilityInfo.style.display = 'none';
        availabilityInfo.innerHTML = '';

        if (type === 'weekly') {
            const today = new Date().getDay();
            const isClaimableDay = today === 1 || today === 2;
            if (!isClaimableDay) {
                availabilityInfo.style.display = 'block';
                availabilityInfo.style.background = 'rgba(255,165,0,0.1)';
                availabilityInfo.style.border = '1px solid rgba(255,165,0,0.3)';
                availabilityInfo.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 20px;">ℹ️</span>
                        <div>
                            <p style="color: #ffa500; font-weight: bold; margin: 0; font-size: 12px;">Reembolso Semanal</p>
                            <p style="color: #ccc; margin: 0; font-size: 11px;">Solo reclamable los días <strong>LUNES y MARTES</strong></p>
                            <p style="color: #aaa; margin: 0; font-size: 10px;">Corresponde a la semana anterior (Lunes a Domingo)</p>
                        </div>
                    </div>
                `;
            }
        } else if (type === 'monthly') {
            const today = new Date().getDate();
            const isClaimableDay = today >= 7 && today <= 15;
            if (!isClaimableDay) {
                availabilityInfo.style.display = 'block';
                availabilityInfo.style.background = 'rgba(255,165,0,0.1)';
                availabilityInfo.style.border = '1px solid rgba(255,165,0,0.3)';
                availabilityInfo.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 20px;">ℹ️</span>
                        <div>
                            <p style="color: #ffa500; font-weight: bold; margin: 0; font-size: 12px;">Reembolso Mensual</p>
                            <p style="color: #ccc; margin: 0; font-size: 11px;">Solo reclamable entre los <strong>días 7 y 15</strong> de cada mes</p>
                            <p style="color: #aaa; margin: 0; font-size: 10px;">Corresponde al mes anterior completo</p>
                        </div>
                    </div>
                `;
            }
        }

        const extraInfo = document.getElementById('refundExtraInfo');
        const claimBtn  = document.getElementById('claimRefundBtn');
        // El backend ahora devuelve `claimed` y `nextClaim` ya calculados en
        // TZ Argentina, así que no recalculamos en el front (evita drift por
        // desfase horario y bugs como dejar reclamar cuando ya se reclamó).
        const isClaimed = !!typeData.claimed;
        let timeRemaining = '';
        if (isClaimed && typeData.nextClaim) {
            const diff = new Date(typeData.nextClaim) - new Date();
            if (diff > 0) {
                const days  = Math.floor(diff / (1000 * 60 * 60 * 24));
                const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                const mins  = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                timeRemaining = days > 0 ? `${days}d ${hours}h` : `${hours}h ${mins}m`;
            }
        }

        if (isClaimed) {
            const claimedAmt = Number(typeData.lastClaimAmount || 0);
            extraInfo.innerHTML = `<span style="color: #ffaa44;">✓ Ya reclamaste <strong>$${claimedAmt.toLocaleString()}</strong> en este período. Disponible en: <strong>${timeRemaining || 'pronto'}</strong></span>`;
            claimBtn.disabled = true;
            claimBtn.textContent = timeRemaining ? `✓ Reclamado — disponible en ${timeRemaining}` : '✓ Reclamado';
            claimBtn.style.background = 'linear-gradient(135deg, #666 0%, #444 100%)';
            claimBtn.onclick = null;
        } else if (typeData.potentialAmount <= 0) {
            // Mensaje claro: el reembolso es SOBRE LA PÉRDIDA. Si el user
            // ganó o no jugó, no hay nada que reembolsar.
            const periodLabel = type === 'daily' ? 'ayer' : (type === 'weekly' ? 'esta última semana' : 'este último mes');
            extraInfo.innerHTML =
                '<div style="background:rgba(255,170,68,0.08);border:1px solid rgba(255,170,68,0.40);border-radius:8px;padding:10px 12px;color:#ffaa44;font-size:12.5px;line-height:1.5;">' +
                '<strong>Hoy no te corresponde reembolso.</strong><br>' +
                'El reembolso se calcula sobre la <strong>plata que perdiste</strong> ' + periodLabel + ' (cargas − retiros). Si ganaste o no jugaste, no hay nada para reembolsar. Probá cargar y jugar — si te va mal, mañana podés reclamar.' +
                '</div>';
            claimBtn.disabled = true;
            claimBtn.textContent = '😐 No te corresponde reembolso';
            claimBtn.style.background = 'linear-gradient(135deg, #666 0%, #444 100%)';
            claimBtn.onclick = null;
        } else if (!typeData.canClaim) {
            extraInfo.innerHTML = '<span style="color: #ffaa44;">⏳ No puedes reclamar este reembolso en este momento.</span>';
            claimBtn.disabled = true;
            claimBtn.textContent = '⏳ No disponible';
            claimBtn.style.background = 'linear-gradient(135deg, #666 0%, #444 100%)';
            claimBtn.onclick = null;
        } else if (!claimRequirementsMet(type)) {
            // Solo aplica al reembolso mensual: si no tiene app instalada o no
            // tiene notificaciones, mostramos el bloque embebido de "Condición
            // para reclamar" + el botón principal cambia a "Activar para reclamar".
            extraInfo.innerHTML = '';
            claimBtn.disabled = false;
            claimBtn.textContent = '🔒 Activar para reclamar';
            claimBtn.style.background = 'linear-gradient(135deg, #6a0dad 0%, #9d4edd 100%)';
            claimBtn.onclick = () => {
                if (claimRequirementsMet(type)) return claimRefund(type);
                VIP.ui.hideModal('refundModal');
                openRequirementsModal(type);
            };
        } else {
            extraInfo.innerHTML = '<span style="color: #00ff88;">✅ ¡Puedes reclamar este reembolso!</span>';
            claimBtn.disabled = false;
            claimBtn.textContent = '🎁 Reclamar Reembolso';
            claimBtn.style.background = '';
            claimBtn.onclick = () => claimRefund(type);
        }

        // Render del bloque de requisitos embebido en el detalle.
        renderRefundRequirementsBlock(type);

        VIP.ui.showModal('refundModal');
    }

    // Pinta el bloque de requisitos dentro del refundModal según el estado actual.
    // Solo se muestra cuando el reembolso es 'monthly' y aun no estan cumplidos
    // los requisitos. Para daily/weekly nunca se muestra (no son obligatorios).
    function renderRefundRequirementsBlock(claimType) {
        const block = document.getElementById('refundRequirementsBlock');
        if (!block) return;
        if (claimType !== 'monthly' || canClaim()) {
            block.style.display = 'none';
            return;
        }
        block.style.display = 'block';

        const inApp = isStandalone();
        const installed = isAppInstalled();
        const notifOk = isNotifGranted();

        const installBadge = document.getElementById('refundReqInstallBadge');
        const notifBadge   = document.getElementById('refundReqNotifBadge');
        const installBtn   = document.getElementById('refundReqInstallBtn');
        const notifBtn     = document.getElementById('refundReqNotifBtn');
        const stepInstall  = document.getElementById('refundReqStepInstall');
        const introMsg     = document.getElementById('refundReqIntroMsg');

        if (installBadge) installBadge.textContent = inApp ? '✅' : '⏳';
        if (notifBadge)   notifBadge.textContent   = notifOk ? '✅' : '⏳';

        if (installBtn) {
            installBtn.disabled = inApp;
            installBtn.textContent = inApp ? '✅ App instalada' : '📱 Instalar la app';
            installBtn.style.opacity = inApp ? '0.6' : '1';
            installBtn.onclick = async () => {
                _pendingClaimType = claimType || null;
                await handleRequirementInstall();
                renderRefundRequirementsBlock(claimType);
                refreshClaimButtonState(claimType);
            };
        }
        if (notifBtn) {
            notifBtn.disabled = notifOk;
            notifBtn.textContent = notifOk ? '✅ Notificaciones activas' : '🔔 Activar notificaciones';
            notifBtn.style.opacity = notifOk ? '0.6' : '1';
            notifBtn.onclick = async () => {
                _pendingClaimType = claimType || null;
                await handleRequirementNotif();
                renderRefundRequirementsBlock(claimType);
                refreshClaimButtonState(claimType);
            };
        }

        // Mismo criterio que refreshRequirementsModal: si ya esta instalada
        // pero el user esta en navegador, ocultamos el paso 1 y reescribimos
        // el mensaje superior.
        if (installed && !inApp) {
            if (stepInstall) stepInstall.style.display = 'none';
            if (introMsg) {
                introMsg.innerHTML = '<strong>Ingresá desde la aplicación</strong> para reclamar tu reembolso. No olvides <strong>activar las notificaciones</strong> para que se active la opción de reclamar.';
            }
        } else {
            if (stepInstall) stepInstall.style.display = '';
            if (introMsg) {
                introMsg.innerHTML = 'Para reclamar este reembolso necesitás <strong>instalar la app</strong> y <strong>activar las notificaciones</strong>. Cuando completes los dos pasos vas a poder reclamarlo sin problemas.';
            }
        }
    }

    // Refresca el botón "Reclamar" del refundModal cuando cambia el estado.
    function refreshClaimButtonState(claimType) {
        const claimBtn = document.getElementById('claimRefundBtn');
        if (!claimBtn) return;
        if (claimRequirementsMet(claimType)) {
            claimBtn.textContent = '🎁 Reclamar Reembolso';
            claimBtn.style.background = '';
            claimBtn.onclick = () => claimRefund(claimType);
            VIP.ui.showToast('✅ Listo, ya podés reclamar', 'success');
        }
    }

    async function claimRefund(type) {
        // Guardia de requisitos: solo el monthly exige app instalada + notificaciones.
        if (!claimRequirementsMet(type)) {
            VIP.ui.hideModal('refundModal');
            openRequirementsModal(type);
            return;
        }
        const claimBtn = document.getElementById('claimRefundBtn');
        if (claimBtn) {
            if (claimBtn.disabled) return;
            claimBtn.disabled = true;
            claimBtn.textContent = '⏳ Procesando...';
        }
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/refunds/claim/${type}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });

            const data = await response.json();

            if (data.success) {
                VIP.ui.showToast(`✅ ${data.message}`, 'success');
                VIP.ui.hideModal('refundModal');
                loadRefundStatus();
                try { VIP.chat && VIP.chat.sendSystemMessage && VIP.chat.sendSystemMessage(`🎁 Reembolso ${type} reclamado: $${data.amount.toLocaleString()}`); } catch (_) { /* refunds-only: chat may be hidden */ }
            } else {
                VIP.ui.showToast(`ℹ️ ${data.message}`, 'info');
                VIP.ui.hideModal('refundModal');
                loadRefundStatus();
            }
        } catch (error) {
            VIP.ui.showToast('Error de conexión', 'error');
        } finally {
            if (claimBtn) {
                claimBtn.disabled = false;
                claimBtn.textContent = '🎁 Reclamar Reembolso';
            }
        }
    }

    async function showUnifiedRefundModal() {
        // Req 3: Precargar el estado de reembolsos ANTES de mostrar el modal unificado,
        // para que al presionar una opción funcione de inmediato sin depender de cargas previas.
        if (!VIP.state.refundStatus) {
            await loadRefundStatus();
        }
        VIP.ui.showModal('unifiedRefundModal');
    }

    // Botón "🎰 Abrir plataforma" del card de saldo: mismo tab/ventana
    // (window.location.href en vez de window.open con _blank). En PWA
    // standalone esto mantiene la app activa en lugar de abrir el browser.
    function wireGoToPlatform() {
        const btn = document.getElementById('goToPlatformBtn');
        if (!btn) return;
        btn.addEventListener('click', function () {
            window.location.href = 'https://www.jugaygana44.bet';
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wireGoToPlatform);
    } else {
        wireGoToPlatform();
    }

    // Wire-up de los botones del modal de requisitos (después de DOM ready).
    function wireRequirementsModal() {
        const installBtn = document.getElementById('reqInstallBtn');
        const notifBtn   = document.getElementById('reqNotifBtn');
        const retryBtn   = document.getElementById('reqRetryBtn');
        if (installBtn) installBtn.addEventListener('click', handleRequirementInstall);
        if (notifBtn)   notifBtn.addEventListener('click', handleRequirementNotif);
        if (retryBtn)   retryBtn.addEventListener('click', () => {
            const ok = refreshRequirementsModal();
            if (ok) {
                tryResumePendingClaim();
            } else {
                VIP.ui.showToast('Todavía falta algún paso. Revisalos arriba.', 'info');
            }
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wireRequirementsModal);
    } else {
        wireRequirementsModal();
    }

    // Si el user instala la app o cambia el permiso de notificaciones mientras
    // algún modal está abierto (ej: vuelve de Settings), refrescamos los badges.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;

        // 1) Modal de requisitos standalone
        const reqModal = document.getElementById('refundRequirementsModal');
        if (reqModal && !reqModal.classList.contains('hidden')) {
            const ok = refreshRequirementsModal();
            if (ok) tryResumePendingClaim();
        }

        // 2) Bloque embebido dentro del refundModal (detalle del reembolso)
        const refundModal = document.getElementById('refundModal');
        if (refundModal && !refundModal.classList.contains('hidden')) {
            renderRefundRequirementsBlock(_pendingClaimType);
            refreshClaimButtonState(_pendingClaimType);
        }
    });

    // =====================================================
    // BONO DE BIENVENIDA $5.000 (one-time, requiere PWA + notifs +
    // minimo 5 cargas en los ultimos 30 dias)
    // =====================================================
    let _welcomeStatus = null; // { amount, claimed, claimedAt, status }

    // Clave por usuario para que si en el mismo dispositivo se loguea otra
    // persona (poco probable pero posible), no se herede el flag.
    function _welcomeClaimedKey() {
        const u = (VIP.state && VIP.state.currentUser && VIP.state.currentUser.username) || '';
        return 'vipWelcomeBonusClaimed:' + u.toLowerCase();
    }
    function _isLocallyMarkedClaimed() {
        try { return localStorage.getItem(_welcomeClaimedKey()) === '1'; }
        catch (_) { return false; }
    }
    function _markLocallyClaimed() {
        try { localStorage.setItem(_welcomeClaimedKey(), '1'); } catch (_) {}
    }

    async function loadWelcomeBonusStatus() {
        // Si ya quedo marcado como reclamado en este device, asumimos
        // claimed=true sin esperar al server (UX: no parpadea el card).
        // El backend sigue siendo la fuente de verdad real, pero esto
        // garantiza que el cliente que ya reclamo nunca lo ve devuelta.
        if (_isLocallyMarkedClaimed()) {
            _welcomeStatus = { amount: 5000, claimed: true };
            renderWelcomeBonusCard();
        }
        try {
            // Huella del dispositivo: si el front la pudo calcular, la mandamos
            // como query param para que el server pueda bloquear ANTES de
            // mostrar el botón si detecta cuenta duplicada en el mismo celular.
            const fp = (window.VIP && VIP.fingerprint && typeof VIP.fingerprint.get === 'function')
                ? await VIP.fingerprint.get().catch(() => null) : null;
            const fpQuery = fp ? ('?deviceFingerprint=' + encodeURIComponent(fp)) : '';
            const r = await fetch(`${VIP.config.API_URL}/api/refunds/welcome/status${fpQuery}`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (!r.ok) return;
            _welcomeStatus = await r.json();
            // Sincronizar flag local con la verdad del server.
            if (_welcomeStatus && _welcomeStatus.claimed) _markLocallyClaimed();
            renderWelcomeBonusCard();
        } catch (err) {
            console.error('loadWelcomeBonusStatus error:', err);
        }
    }

    function renderWelcomeBonusCard() {
        const card = document.getElementById('welcomeBonusCard');
        const amountEl = document.getElementById('welcomeBonusAmount');
        const subtitleEl = document.getElementById('welcomeBonusSubtitle');
        const btn = document.getElementById('welcomeBonusBtn');
        if (!card || !btn) return;

        // OJO: el card tiene `display:block !important` en el CSS para que
        // no se aplaste en mobile, asi que un `card.style.display='none'`
        // simple NO lo oculta (el !important del CSS gana). Usamos
        // setProperty con flag 'important' para que la JS gane.
        const hideCard = () => card.style.setProperty('display', 'none', 'important');
        const showCard = () => card.style.setProperty('display', 'block', 'important');
        // Cuando el bono ya está reclamado hay que sacar del inicio TAMBIÉN el
        // hero de instalación (ui.js). Su renderHero solo mira el flag local,
        // así que si corrió antes de cargar el estado del server podía quedar
        // visible mostrando "RECLAMAR $5.000" a alguien que ya cobró.
        const hideInstallHero = () => {
            try { const h = document.getElementById('installHeroCard'); if (h) h.hidden = true; } catch (_) {}
        };

        // Defensa-en-profundidad: si el flag local dice reclamado, ocultamos
        // de entrada (cubre el caso donde el render corre antes de que el
        // fetch de status termine).
        if (_isLocallyMarkedClaimed()) {
            hideCard();
            hideInstallHero();
            return;
        }

        // Dismiss explícito del user (tocó la ✕ del card). Persiste por
        // username en localStorage. No anula el derecho al bono — solo
        // oculta el card. Si reinstala la app vuelve a aparecer.
        try {
            const u = (VIP.state && VIP.state.currentUser && VIP.state.currentUser.username) || '_anon';
            if (localStorage.getItem('welcomeBonusDismissed:' + u) === '1') {
                hideCard();
                return;
            }
        } catch (_) {}

        const s = _welcomeStatus || { amount: 5000, claimed: false };
        const amountNum = Number(s.amount || 5000);

        // Si ya reclamo (en este device o cualquier otro: el backend lo
        // chequea por userId Y username, asi que aunque borre la app y
        // reinstale, sigue marcado como reclamado), ocultamos el card
        // entero. El bono es one-time real.
        if (s.claimed) {
            _markLocallyClaimed();
            hideCard();
            hideInstallHero();
            return;
        }

        // Este card YA tiene todo: hook \$5.000 + 3 pasos + botón dinámico.
        // Ocultamos installHeroCard para no duplicar boxes con los mismos
        // pasos. Un solo recuadro con todo adentro.
        try {
            const heroCard = document.getElementById('installHeroCard');
            if (heroCard) heroCard.hidden = true;
        } catch (_) {}

        // NOTA: antes este bloque ocultaba el card si isAppInstalled() === true,
        // pero eso rompia el flujo: el user instalaba la app y nunca podia
        // reclamar porque el card desaparecia. Ahora el card sigue visible
        // en TODOS los estados (browser, app instalada fuera, dentro sin
        // notifs, dentro con todo OK) — la logica de abajo elige el copy y
        // el estado del boton segun la situacion.

        // Cargas insuficientes en la ventana: el backend exige minimo N
        // cargas en los ultimos M dias. Mostramos progreso y boton
        // deshabilitado hasta que cumpla.
        if (s.notEnoughDeposits) {
            const need = Number(s.requiredDeposits || 5);
            const have = Number(s.depositCount || 0);
            const days = Number(s.windowDays || 30);
            showCard();
            if (amountEl) amountEl.textContent = '$' + amountNum.toLocaleString('es-AR');
            card.classList.remove('claimed');
            if (subtitleEl) subtitleEl.textContent = `Necesitás ${need} cargas en los últimos ${days} días. Llevás ${have}/${need}.`;
            btn.textContent = `🔒 ${have}/${need} CARGAS`;
            btn.disabled = true;
            btn.onclick = null;
            return;
        }

        // No reclamado: mostramos card con los pasos.
        showCard();
        if (amountEl) amountEl.textContent = '$' + amountNum.toLocaleString('es-AR') + ' GRATIS';

        card.classList.remove('claimed');
        // Subtitulo dinamico segun estado actual de instalacion + notifs.
        // Textos del boton cortos para no romper layout en mobile.
        const inApp = isStandalone();
        const installed = isAppInstalled();
        const notifOk = isNotifGranted();
        if (!installed) {
            subtitleEl.textContent = 'Paso 1: tocá para instalar la app en tu celular.';
            btn.textContent = '📲 INSTALAR LA APP';
        } else if (!inApp) {
            subtitleEl.textContent = 'Paso 2: cerrá esta pantalla y abrí la app desde el ícono nuevo de tu celular.';
            btn.textContent = '📱 ABRIR DESDE EL ÍCONO';
        } else if (!notifOk) {
            subtitleEl.textContent = 'Paso 3: activá las notificaciones desde acá adentro de la app.';
            btn.textContent = '🔔 ACTIVAR NOTIFICACIONES';
        } else {
            subtitleEl.textContent = '🎉 ¡Listo! Tocá el botón para acreditarte $' + amountNum.toLocaleString('es-AR') + '.';
            btn.textContent = '🎁 RECLAMAR $' + amountNum.toLocaleString('es-AR');
        }
        btn.disabled = false;
        btn.onclick = handleWelcomeBonusClick;

        // Stepper: pinta cada badge según el estado real. Usuarios que se
        // pierden en el modal de pasos ahora ven la checklist directo en el card.
        try {
            const b1 = document.getElementById('welcomeStep1Badge');
            const b2 = document.getElementById('welcomeStep2Badge');
            const b3 = document.getElementById('welcomeStep3Badge');
            if (b1) b1.textContent = installed ? '✅' : '⏳';
            if (b2) b2.textContent = inApp    ? '✅' : '⏳';
            if (b3) b3.textContent = notifOk  ? '✅' : '⏳';
        } catch (_) {}
    }

    function handleWelcomeBonusClick() {
        const inApp = isStandalone();
        const installed = isAppInstalled();
        const notifOk = isNotifGranted();

        // Paso 1: no tiene la app instalada. Disparar el flow de instalación
        // — iOS muestra modal con video, Android dispara prompt nativo de
        // Chrome (o el modal de pasos si Chrome no lo dejó).
        if (!installed) {
            if (window.VIP && VIP.ui && typeof VIP.ui.installApp === 'function') {
                VIP.ui.installApp();
            }
            return;
        }

        // Paso 2: tiene la app instalada pero está usando el browser, no
        // el ícono. Le indicamos que abra desde el ícono de su celular.
        if (!inApp) {
            VIP.ui.showToast('📱 Abrí la app desde el ícono que quedó en tu pantalla', 'info', 6000);
            return;
        }

        // Paso 3: ya está dentro de la app pero le faltan las notificaciones.
        // Disparar la pedida de permiso del browser. Si granted, re-renderear
        // para que aparezca el botón "RECLAMAR".
        if (!notifOk) {
            if (typeof Notification === 'undefined') {
                VIP.ui.showToast('Tu navegador no soporta notificaciones.', 'error');
                return;
            }
            Notification.requestPermission().then((perm) => {
                if (perm === 'granted') {
                    VIP.ui.showToast('✅ Notificaciones activadas. Ya podés reclamar tu bono.', 'success');
                } else {
                    VIP.ui.showToast('⚠️ Necesitamos las notificaciones activas para acreditarte el bono.', 'error');
                }
                renderWelcomeBonusCard();
            }).catch(() => {});
            return;
        }

        // Los 3 pasos OK: reclamar.
        claimWelcomeBonus();
    }

    async function claimWelcomeBonus() {
        const btn = document.getElementById('welcomeBonusBtn');
        if (btn) {
            if (btn.disabled) return;
            btn.disabled = true;
            btn.textContent = '⏳ Procesando...';
        }
        try {
            const fp = (window.VIP && VIP.fingerprint && typeof VIP.fingerprint.get === 'function')
                ? await VIP.fingerprint.get().catch(() => null) : null;
            const response = await fetch(`${VIP.config.API_URL}/api/refunds/claim/welcome`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${VIP.state.currentToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ deviceFingerprint: fp || null })
            });
            const data = await response.json();
            if (data.success) {
                VIP.ui.showToast('✅ ' + data.message, 'success');
                _markLocallyClaimed();
                _welcomeStatus = { ...(_welcomeStatus || {}), claimed: true, claimedAt: new Date().toISOString(), status: 'completed' };
                renderWelcomeBonusCard();
                // Ocultar tambien el installHeroCard apenas se reclama el bono.
                // Una vez que ya cobro el regalo de $5000, el card pierde sentido.
                try { if (typeof window.renderInstallHeroCard === 'function') window.renderInstallHeroCard(); } catch (_) {}
                // Refrescar saldo en pantalla.
                if (typeof loadRefundStatus === 'function') loadRefundStatus();
                // Meta Pixel: Purchase con valor real. Esta es la metrica
                // de ROI directa para Meta Ads — Meta calcula CPA contra
                // este evento. amount viene del server (default $2.000 ARS).
                if (typeof window.metaPixelTrack === 'function') {
                    window.metaPixelTrack('Purchase', {
                        content_name: 'welcome_bonus_claimed',
                        currency: 'ARS',
                        value: Number(data.amount) || 2000
                    });
                }
            } else {
                VIP.ui.showToast('⚠️ ' + (data.message || 'No se pudo reclamar'), 'error');
                // Si el server dice "te faltan cargas", refrescamos el card
                // con el progreso actual sin marcar como reclamado.
                if (data.notEnoughDeposits) {
                    _welcomeStatus = {
                        ...(_welcomeStatus || {}),
                        notEnoughDeposits: true,
                        depositCount: data.depositCount,
                        requiredDeposits: data.requiredDeposits,
                        windowDays: data.windowDays
                    };
                    renderWelcomeBonusCard();
                } else if (data.canClaim === false) {
                    // canClaim:false → server dice "ya reclamado" o "pending review".
                    // En ambos casos el bono no se puede reintentar, ocultamos.
                    _markLocallyClaimed();
                    _welcomeStatus = { ...(_welcomeStatus || {}), claimed: true };
                    renderWelcomeBonusCard();
                } else if (btn) {
                    btn.disabled = false;
                    btn.textContent = '🎁 Reclamar bono';
                }
            }
        } catch (err) {
            console.error('claimWelcomeBonus error:', err);
            VIP.ui.showToast('Error de conexión', 'error');
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🎁 Reclamar bono';
            }
        }
    }

    // =====================================================
    // MONEY GIVEAWAY (regalo de plata por difusion del admin)
    // Card pulsante verde que aparece cuando hay regalo activo. Polling
    // cada 60s para detectar regalos nuevos sin recargar la pagina.
    // =====================================================
    let _giveawayState = null; // datos del regalo activo
    let _giveawayCountdownId = null;
    let _giveawayPollId = null;

    function _clearGiveawayCountdown() {
        if (_giveawayCountdownId) { clearInterval(_giveawayCountdownId); _giveawayCountdownId = null; }
    }

    async function loadGiveawayStatus() {
        try {
            if (!VIP.state.currentToken) return;
            const r = await fetch(`${VIP.config.API_URL}/api/money-giveaway/active`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (!r.ok) return;
            const data = await r.json();
            _giveawayState = data && data.active ? data : null;
            renderGiveawayCard();
        } catch (err) {
            console.warn('loadGiveawayStatus error:', err);
        }
    }

    // Total historico de plata regalada via giveaway. Lo muestra el home
    // como prueba social: "Total regalada a usuarios con app+notifs: $X".
    async function loadGiveawayTotal() {
        try {
            if (!VIP.state.currentToken) return;
            const r = await fetch(`${VIP.config.API_URL}/api/giveaway-stats/total`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (!r.ok) return;
            const data = await r.json();
            const line = document.getElementById('giveawayTotalLine');
            const amountEl = document.getElementById('giveawayTotalAmount');
            if (!line || !amountEl) return;
            const amt = Number(data.amount || 0);
            if (amt <= 0) {
                line.style.display = 'none';
                return;
            }
            amountEl.textContent = '$' + amt.toLocaleString('es-AR');
            line.style.display = '';
            try { localStorage.setItem('vipGiveawayTotalCache', String(amt)); } catch (_) {}
        } catch (err) {
            console.warn('loadGiveawayTotal error:', err);
        }
    }

    // Dismiss del card del regalo de plata. Guardamos el giveaway ID +
    // username en localStorage para que no le aparezca otra vez en ese
    // device hasta que venza el regalo (después renderGiveawayCard ya no
    // lo muestra porque _giveawayState queda en null al expirar).
    function _giveawayDismissKey(giveawayId) {
        const u = (VIP.state && VIP.state.currentUser && VIP.state.currentUser.username) || '';
        return 'vipGiveawayDismissed:' + u.toLowerCase() + ':' + giveawayId;
    }
    function _isGiveawayDismissed(giveawayId) {
        try { return localStorage.getItem(_giveawayDismissKey(giveawayId)) === '1'; }
        catch (_) { return false; }
    }
    function _markGiveawayDismissed(giveawayId) {
        try { localStorage.setItem(_giveawayDismissKey(giveawayId), '1'); } catch (_) {}
    }
    function dismissGiveaway() {
        if (!_giveawayState || !_giveawayState.id) return;
        _markGiveawayDismissed(_giveawayState.id);
        const card = document.getElementById('giveawayCard');
        if (card) card.style.setProperty('display', 'none', 'important');
        _clearGiveawayCountdown();
    }

    function renderGiveawayCard() {
        const card = document.getElementById('giveawayCard');
        if (!card) return;
        const hide = () => card.style.setProperty('display', 'none', 'important');
        const show = () => card.style.setProperty('display', 'block', 'important');

        const g = _giveawayState;
        if (!g) {
            _clearGiveawayCountdown();
            hide();
            return;
        }
        // Si el user lo cerró antes con la X, no volverlo a mostrar.
        if (g.id && _isGiveawayDismissed(g.id)) {
            _clearGiveawayCountdown();
            hide();
            return;
        }

        const amountEl = document.getElementById('giveawayAmount');
        const subEl = document.getElementById('giveawaySub');
        const btn = document.getElementById('giveawayBtn');
        const timerEl = document.getElementById('giveawayTimer');

        const amountStr = '$' + Number(g.amount || 0).toLocaleString('es-AR');

        card.classList.remove('claimed');

        // Estados visibles del card. Todos quedan en pantalla hasta que el
        // regalo venza (expiresAt), incluso si el user ya reclamó o si se
        // agotó el cupo — sirve como prueba social de la difusión.
        if (g.alreadyClaimed) {
            // Usuario que ya reclamó: mostramos "ya reclamaste $X" sin botón.
            const claimedAmt = Number(g.claimedAmount || g.amount || 0);
            const claimedStr = '$' + claimedAmt.toLocaleString('es-AR');
            if (amountEl) amountEl.textContent = '✓ ' + claimedStr + ' RECLAMADO';
            if (subEl) subEl.textContent = '¡Felicitaciones! Ya recibiste tu regalo. Triplicá tu saldo y pedí RETIRO10 al chat.';
            if (btn) {
                btn.disabled = true;
                btn.textContent = '✅ Ya reclamado';
                btn.style.opacity = '0.55';
                btn.style.cursor = 'not-allowed';
            }
            if (timerEl) timerEl.style.display = '';
        } else if (g.soldOut) {
            // Cupo o presupuesto agotado: visible para todos, sin posibilidad
            // de reclamar. Mostramos cuántos llegaron a tiempo como referencia.
            if (amountEl) amountEl.textContent = '🚫 ' + amountStr + ' AGOTADO';
            const claimed = Number(g.claimedCount || 0);
            const cap = Number(g.maxClaims || 0);
            const peopleStr = cap > 0
                ? ('Lo reclamaron ' + claimed + ' de ' + cap + ' personas.')
                : ('Lo reclamaron ' + claimed + ' personas.');
            if (subEl) subEl.textContent = 'Bono no disponible — llegaste tarde. ' + peopleStr;
            if (btn) {
                btn.disabled = true;
                btn.textContent = '🚫 Cupo agotado';
                btn.style.opacity = '0.55';
                btn.style.cursor = 'not-allowed';
            }
            if (timerEl) timerEl.style.display = '';
        } else if (g.notEligibleReason === 'has_balance') {
            // Regalo exige saldo cero y este user tiene saldo: visible pero
            // sin posibilidad de reclamar.
            if (amountEl) amountEl.textContent = amountStr + ' GRATIS';
            if (subEl) subEl.textContent = 'No disponible — tenés saldo en tu cuenta. Regalo exclusivo para clientes sin saldo.';
            if (btn) {
                btn.disabled = true;
                btn.textContent = '🚫 No disponible';
                btn.style.opacity = '0.55';
                btn.style.cursor = 'not-allowed';
            }
            if (timerEl) timerEl.style.display = '';
        } else {
            // Si el giveaway es broadcastAll y tiene customMessage, usamos
            // el texto y emoji del admin. Si no, fallback al texto default.
            const emoji = g.customEmoji || '🎁';
            if (amountEl) amountEl.textContent = emoji + ' ' + amountStr + ' GRATIS';
            if (subEl) {
                subEl.textContent = (g.customMessage && g.customMessage.trim())
                    ? g.customMessage.trim()
                    : 'Tocá ahora antes que se acabe.';
            }
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'RECLAMÁ ' + amountStr + ' AQUÍ';
                btn.style.opacity = '';
                btn.style.cursor = '';
            }
            if (timerEl) timerEl.style.display = '';
        }

        // Countdown vivo.
        _clearGiveawayCountdown();
        const expiresMs = new Date(g.expiresAt).getTime();
        const updateCountdown = () => {
            const left = expiresMs - Date.now();
            if (!timerEl) return;
            if (left <= 0) {
                timerEl.textContent = '⏰ vencido';
                _clearGiveawayCountdown();
                _giveawayState = null;
                renderGiveawayCard();
                return;
            }
            const totalSec = Math.floor(left / 1000);
            const m = Math.floor(totalSec / 60);
            const s = totalSec % 60;
            timerEl.textContent = '⏰ vence en ' + m + 'm ' + String(s).padStart(2, '0') + 's';
        };
        updateCountdown();
        _giveawayCountdownId = setInterval(updateCountdown, 1000);

        show();
    }

    async function handleGiveawayClick() {
        if (!_giveawayState || _giveawayState.alreadyClaimed) return;
        // Si el card está en modo "no disponible por saldo" o "agotado",
        // el botón ya está disabled — el handler no debería disparar, pero
        // por las dudas también lo bloqueamos aquí.
        if (_giveawayState.notEligibleReason === 'has_balance') return;
        if (_giveawayState.soldOut) return;
        const btn = document.getElementById('giveawayBtn');
        if (btn) {
            if (btn.disabled) return;
            btn.disabled = true;
            btn.textContent = '⏳ Procesando…';
        }
        try {
            const r = await fetch(`${VIP.config.API_URL}/api/money-giveaway/claim`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            const data = await r.json();
            if (data.success) {
                VIP.ui.showToast('✅ ' + data.message, 'success');
                _giveawayState = {
                    ...(_giveawayState || {}),
                    alreadyClaimed: true,
                    claimedAmount: data.amount || (_giveawayState && _giveawayState.amount),
                    claimedAt: new Date().toISOString()
                };
                renderGiveawayCard();
                if (typeof loadRefundStatus === 'function') loadRefundStatus();
            } else {
                if (data.needsAppNotifs) {
                    _showGiveawayNeedsAppModal(_giveawayState && _giveawayState.amount);
                } else {
                    VIP.ui.showToast('⚠️ ' + (data.message || 'No se pudo reclamar'), 'error');
                }
                if (data.alreadyClaimed) {
                    _giveawayState = { ...(_giveawayState || {}), alreadyClaimed: true };
                    renderGiveawayCard();
                } else if (data.closed) {
                    // Cupo o presupuesto agotado: refetch para que el server
                    // devuelva soldOut + claimedCount actualizados, así el
                    // card se queda visible hasta expiresAt en modo "agotado".
                    loadGiveawayStatus();
                } else if (data.notEligible && data.reason === 'has_balance') {
                    // Servidor confirmó que el user tiene saldo — actualizar
                    // el card para mostrar "no disponible" sin que tenga que
                    // refrescar la app.
                    _giveawayState = { ...(_giveawayState || {}), notEligibleReason: 'has_balance' };
                    renderGiveawayCard();
                } else if (btn) {
                    btn.disabled = false;
                    btn.textContent = '🎁 RECLAMAR';
                }
            }
        } catch (err) {
            console.error('giveaway claim error:', err);
            VIP.ui.showToast('Error de conexión', 'error');
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🎁 RECLAMAR';
            }
        }
    }

    // Modal cuando el user toca "RECLAMAR" en el regalo de plata pero no
    // tiene la app instalada / sin notifs. Explica los 3 pasos clarito.
    // Detecta plataforma y estado actual para dar el siguiente paso correcto:
    //   - sin app -> botón "Instalar la app" (dispara installApp)
    //   - app instalada pero browser -> "Abrí desde el ícono"
    //   - en standalone sin notifs -> "Activar notificaciones"
    function _showGiveawayNeedsAppModal(amount) {
        const inApp = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
                       window.navigator.standalone === true;
        const notifPerm = (typeof Notification !== 'undefined') ? Notification.permission : 'default';
        const amtTxt = amount ? '$' + Number(amount).toLocaleString('es-AR') : 'este regalo';

        document.getElementById('giveawayNeedsAppModal')?.remove();
        const overlay = document.createElement('div');
        overlay.id = 'giveawayNeedsAppModal';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:99998;display:flex;align-items:flex-start;justify-content:center;padding:14px;overflow-y:auto;-webkit-overflow-scrolling:touch;';
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        // Determinar el paso actual y el CTA primario.
        let step1Badge, step2Badge, step3Badge;
        let primaryTxt, primaryAction;
        if (!inApp) {
            // Browser: paso 1 (instalar) pendiente
            step1Badge = '⏳'; step2Badge = '⏳'; step3Badge = '⏳';
            primaryTxt = '📲 INSTALAR LA APP AHORA';
            primaryAction = 'window.VIP&&VIP.ui&&VIP.ui.installApp&&VIP.ui.installApp();document.getElementById(\'giveawayNeedsAppModal\').remove();';
        } else if (notifPerm !== 'granted') {
            // Standalone pero sin notifs: pasos 1 y 2 OK, falta 3
            step1Badge = '✅'; step2Badge = '✅'; step3Badge = '⏳';
            primaryTxt = '🔔 ACTIVAR NOTIFICACIONES';
            primaryAction = '(async()=>{try{const p=await Notification.requestPermission();if(p===\'granted\')VIP.ui.showToast(\'✅ Notificaciones activadas — tocá RECLAMAR de nuevo\',\'success\');}catch(_){}document.getElementById(\'giveawayNeedsAppModal\').remove();})();';
        } else {
            // Edge case: standalone + notifs OK pero igual rebota — algo más
            // raro (sin token FCM por timing). Le pedimos refrescar.
            step1Badge = '✅'; step2Badge = '✅'; step3Badge = '⚠️';
            primaryTxt = '🔄 REFRESCAR LA APP';
            primaryAction = 'location.reload();';
        }

        overlay.innerHTML =
            '<div style="background:linear-gradient(180deg,#1a0033,#0a001a);border:2.5px solid #ffd700;border-radius:18px;padding:22px 18px;max-width:440px;width:100%;color:#fff;margin:16px auto;box-shadow:0 0 40px rgba(255,215,0,0.35);">' +
                '<div style="text-align:center;font-size:54px;line-height:1;margin-bottom:6px;">🎁</div>' +
                '<div style="text-align:center;color:#ffd700;font-weight:900;font-size:17px;letter-spacing:1px;margin-bottom:4px;">Para reclamar ' + amtTxt + '</div>' +
                '<div style="text-align:center;color:#fff;font-size:13.5px;line-height:1.55;margin-bottom:14px;">Necesitamos asegurarnos que sos vos el que reclama. Por eso, primero tenés que tener <strong>la app instalada con notificaciones activas</strong>.</div>' +

                // Stepper visual con los 3 pasos clarísimos
                '<div style="background:rgba(255,215,0,0.06);border:1px dashed rgba(255,215,0,0.45);border-radius:12px;padding:14px;margin-bottom:14px;">' +
                    '<div style="color:#ffd700;font-weight:900;font-size:11px;letter-spacing:1.5px;text-align:center;margin-bottom:10px;">🧭 SEGUÍ ESTOS 3 PASOS</div>' +

                    '<div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:9px;">' +
                        '<div style="flex-shrink:0;width:30px;height:30px;border-radius:50%;background:rgba(255,215,0,0.15);border:1.5px solid #ffd700;color:#ffd700;font-weight:900;display:flex;align-items:center;justify-content:center;font-size:14px;">' + step1Badge + '</div>' +
                        '<div style="flex:1;font-size:12.5px;line-height:1.5;color:#fff;"><strong>Instalá la app</strong> en tu celular (tocá el botón de abajo — Android lo hace solo, iPhone te muestra un video).</div>' +
                    '</div>' +

                    '<div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:9px;">' +
                        '<div style="flex-shrink:0;width:30px;height:30px;border-radius:50%;background:rgba(255,215,0,0.15);border:1.5px solid #ffd700;color:#ffd700;font-weight:900;display:flex;align-items:center;justify-content:center;font-size:14px;">' + step2Badge + '</div>' +
                        '<div style="flex:1;font-size:12.5px;line-height:1.5;color:#fff;"><strong>Abrí la app desde el ícono</strong> nuevo que te quedó en la pantalla del celular — no desde Chrome.</div>' +
                    '</div>' +

                    '<div style="display:flex;gap:10px;align-items:flex-start;">' +
                        '<div style="flex-shrink:0;width:30px;height:30px;border-radius:50%;background:rgba(255,215,0,0.15);border:1.5px solid #ffd700;color:#ffd700;font-weight:900;display:flex;align-items:center;justify-content:center;font-size:14px;">' + step3Badge + '</div>' +
                        '<div style="flex:1;font-size:12.5px;line-height:1.5;color:#fff;"><strong>Dentro de la app, aceptá las notificaciones</strong> cuando te aparezca el pedido. Después tocá RECLAMAR.</div>' +
                    '</div>' +
                '</div>' +

                // Bonus: mención del $5K si todavía no instalan
                (!inApp ? '<div style="background:linear-gradient(135deg,rgba(37,211,102,0.15),rgba(0,212,255,0.12));border:1px solid rgba(37,211,102,0.45);border-radius:10px;padding:10px 12px;margin-bottom:12px;text-align:center;font-size:12.5px;color:#aaffaa;">🎁 <strong style="color:#ffd700;">Bonus extra:</strong> si instalás la app por primera vez, también te llevás <strong style="color:#ffd700;">$5.000 GRATIS</strong> de bienvenida.</div>' : '') +

                '<button onclick="' + primaryAction + '" style="width:100%;background:linear-gradient(135deg,#ffd700,#ff8800);color:#000;border:none;padding:13px;border-radius:11px;font-weight:900;font-size:14px;cursor:pointer;letter-spacing:0.5px;margin-bottom:8px;box-shadow:0 4px 14px rgba(255,215,0,0.40);">' + primaryTxt + '</button>' +
                '<button onclick="document.getElementById(\'giveawayNeedsAppModal\').remove();" style="width:100%;background:transparent;color:#aaa;border:1px solid rgba(255,255,255,0.20);padding:10px;border-radius:9px;font-weight:700;font-size:12px;cursor:pointer;">Cerrar</button>' +
            '</div>';
        document.body.appendChild(overlay);
    }

    // ---- Prefill desde cache para evitar el flash de $0 en cold-start ----
    // En el cold-start (PWA cerrada y reabierta) el HTML pinta $0 hasta que
    // la API de /api/refunds/status responde (~3-5s en redes lentas). Para
    // que el usuario no vea ese parpadeo en cero, leemos el ultimo valor
    // conocido de localStorage y lo plantamos en el DOM apenas el modulo
    // carga. Cuando la API responda, los valores se sobreescriben con la
    // verdad — esta es solo una capa visual.
    function _prefillFromCache() {
        try {
            const balEl = document.getElementById('userBalanceAmount');
            if (balEl) {
                const cached = _loadCachedAmount('balance');
                if (cached != null) {
                    balEl.textContent = '$' + cached.toLocaleString('es-AR');
                }
            }
            ['daily', 'weekly', 'monthly'].forEach((t) => {
                const amtEl = document.getElementById(t + 'RefundAmount');
                if (!amtEl) return;
                const cached = _loadCachedAmount('refund_' + t);
                if (cached != null) {
                    amtEl.textContent = '$' + cached.toLocaleString();
                }
            });
            // Total historico de plata regalada (subtexto del welcome). No
            // depende del usuario, asi que va en una key global.
            const totalLine = document.getElementById('giveawayTotalLine');
            const totalAmt = document.getElementById('giveawayTotalAmount');
            if (totalLine && totalAmt) {
                const raw = (function () {
                    try { return localStorage.getItem('vipGiveawayTotalCache'); }
                    catch (_) { return null; }
                })();
                const cached = raw == null ? null : Number(raw);
                if (cached != null && Number.isFinite(cached) && cached > 0) {
                    totalAmt.textContent = '$' + cached.toLocaleString('es-AR');
                    totalLine.style.display = '';
                }
            }
        } catch (_) {}
    }

    // Forzar oculto los cards "condicionales" (giveaway + welcome bonus) al
    // iniciar el modulo. CSS ya no los pone display:block !important, y el
    // HTML los trae inline con display:none, pero garantizamos el oculto
    // desde JS por defensa en profundidad: que ningun render intermedio
    // los muestre vacios o con un estado falso (ej: usuario que ya
    // reclamo el welcome bonus pero borro la app -> al reinstalar el
    // localStorage esta vacio y veria el card hasta que la API responda).
    function _ensureConditionalCardsHiddenAtBoot() {
        try {
            const g = document.getElementById('giveawayCard');
            if (g) g.style.setProperty('display', 'none', 'important');
            const w = document.getElementById('welcomeBonusCard');
            if (w) w.style.setProperty('display', 'none', 'important');
        } catch (_) {}
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            _prefillFromCache();
            _ensureConditionalCardsHiddenAtBoot();
        });
    } else {
        _prefillFromCache();
        _ensureConditionalCardsHiddenAtBoot();
    }

    // Polling cada 60s para detectar regalos nuevos mientras la app esta
    // abierta. Solo si la pestaña esta visible.
    // Tambien refrescamos el TOTAL regalado para que el cartel del home
    // se actualice en vivo cuando otros usuarios vayan reclamando — antes
    // solo se actualizaba al recargar la pagina o al reclamar uno mismo.
    if (!_giveawayPollId) {
        _giveawayPollId = setInterval(() => {
            if (document.visibilityState !== 'visible') return;
            loadGiveawayStatus();
            loadGiveawayTotal();
        }, 60 * 1000);
    }

    // Cuando la pestaña vuelve a estar visible (user vuelve a la app
    // despues de tenerla en background), refrescamos al instante.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        try { loadGiveawayStatus(); } catch (_) {}
        try { loadGiveawayTotal(); } catch (_) {}
    });

    // Escuchar postMessage del Service Worker (notificationclick): asi
    // cuando el user toca el push, el SW nos manda los datos del payload
    // y podemos forzar el fetch inmediato del estado de promo/giveaway
    // sin esperar al polling de 60s.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            const msg = event && event.data;
            if (!msg || msg.type !== 'PUSH_NOTIFICATION_CLICK') return;
            const d = msg.data || {};
            // Tracking: registramos que el user tapeó este push. El backend
            // hace dedup por (userId, source, giveawayId) — no contamos taps
            // duplicados aunque el postMessage llegue 2 veces.
            try {
                if (d.source && VIP && VIP.state && VIP.state.currentToken) {
                    fetch(`${VIP.config.API_URL}/api/push/tap-track`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${VIP.state.currentToken}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            source: d.source,
                            giveawayId: d.giveawayId || null,
                            raffleId: d.raffleId || null
                        })
                    }).catch(() => {});
                }
            } catch (_) {}
            // Forzar fetch INMEDIATO de ambos estados (promo y giveaway)
            // independientemente de que campos vengan en data — el server
            // es la fuente de verdad. Esto reemplaza la espera al polling.
            try { loadGiveawayStatus(); } catch (_) {}
            try {
                if (typeof window.applyPromoAlertIfActive === 'function') {
                    window.applyPromoAlertIfActive();
                }
            } catch (_) {}
        });
    }

    return {
        loadRefundStatus,
        updateRefundButtons,
        updateRefundButton,
        startCountdown,
        showRefundModal,
        claimRefund,
        showUnifiedRefundModal,
        canClaim,
        openRequirementsModal,
        loadWelcomeBonusStatus,
        renderWelcomeBonusCard,
        claimWelcomeBonus,
        handleWelcomeBonusClick,
        loadGiveawayStatus,
        renderGiveawayCard,
        handleGiveawayClick,
        dismissGiveaway
    };

})();

// Window aliases
window.showRefundModal = VIP.refunds.showRefundModal;
window.claimRefund     = VIP.refunds.claimRefund;

// Defensa extra para el boton del bono de bienvenida: capturamos clicks
// en cualquier elemento del card via event delegation a nivel document.
// Asi funciona aunque el inline onclick haya quedado caido (cache vieja),
// el render dinamico no haya enlazado btn.onclick aun, o el evento se
// dispare en un hijo del boton (icono/text node).
document.addEventListener('click', function (e) {
    const btn = e.target && e.target.closest && e.target.closest('#welcomeBonusBtn');
    if (!btn) return;
    if (btn.disabled) return;
    e.preventDefault();
    try {
        if (VIP && VIP.refunds && typeof VIP.refunds.handleWelcomeBonusClick === 'function') {
            VIP.refunds.handleWelcomeBonusClick();
        }
    } catch (err) {
        console.error('welcome bonus click failed:', err);
    }
}, true);
