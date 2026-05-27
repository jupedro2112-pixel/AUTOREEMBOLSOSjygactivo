// ========================================
// UI - User-interface utilities module
// ========================================

window.VIP = window.VIP || {};

VIP.ui = (function () {

    // ---- Modal helpers ----

    function showModal(modalId) {
        document.getElementById(modalId).classList.remove('hidden');
    }

    function hideModal(modalId) {
        if (modalId === 'changePasswordModal' && VIP.state.passwordChangePending) {
            return;
        }
        document.getElementById(modalId).classList.add('hidden');

        // Reset OTP step states when closing modals
        if (modalId === 'resetPassModal') {
            const s1 = document.getElementById('resetStep1');
            const s2 = document.getElementById('resetStep2');
            const s3 = document.getElementById('resetStep3');
            if (s1) s1.style.display = '';
            if (s2) s2.style.display = 'none';
            if (s3) s3.style.display = 'none';
        }
        if (modalId === 'registerModal') {
            const s1 = document.getElementById('registerStep1');
            if (s1) s1.style.display = '';
        }
    }

    // ---- Toast & copy ----

    function showToast(message, type = 'success') {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => toast.remove(), 3000);
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            showToast('✅ Copiado');
        } catch (error) {
            showToast('Error al copiar', 'error');
        }
    }

    function copyToClipboard(elementId) {
        const element = document.getElementById(elementId);
        const text = element.textContent;
        if (navigator.clipboard) {
            navigator.clipboard.writeText(text).then(() => {
                showToast('📋 Copiado al portapapeles', 'success');
            }).catch(() => { fallbackCopy(text); });
        } else {
            fallbackCopy(text);
        }
    }

    function fallbackCopy(text) {
        const el = document.createElement('textarea');
        el.value = text;
        el.style.position = 'fixed';
        el.style.opacity  = '0';
        document.body.appendChild(el);
        el.focus();
        el.select();
        try { document.execCommand('copy'); showToast('✅ Copiado', 'success'); } catch (e) {}
        document.body.removeChild(el);
    }

    // ---- Screen switching ----

    function showLoginScreen() {
        document.getElementById('loginScreen').classList.remove('hidden');
        document.getElementById('chatScreen').classList.add('hidden');
    }

    function showChatScreen() {
        document.getElementById('loginScreen').classList.add('hidden');
        document.getElementById('chatScreen').classList.remove('hidden');
        const _username = VIP.state.currentUser?.username || 'Usuario';
        const _curUser = document.getElementById('currentUser');
        if (_curUser) _curUser.textContent = _username;
        const _dashUser = document.getElementById('dashUserName');
        if (_dashUser) _dashUser.textContent = _username;

        adjustLayout();
        syncBalance();
        startBalancePolling();
        sendWelcomeMessages();

        // Cartel del bono por instalar la app (se muestra si no lo reclamó aún).
        if (VIP.installBonus && typeof VIP.installBonus.init === 'function') {
            VIP.installBonus.init();
        }

        // Publisher welcome: bienvenida de 2 pasos para usuarios que vinieron
        // de un publicista (acquisitionCampaign set). Se muestra ANTES de la
        // encuesta de notificaciones porque es contextual al onboarding —
        // explica qué es VIPCARGAS antes de pedirle decisiones al usuario.
        if (VIP.publisherWelcome && typeof VIP.publisherWelcome.maybeShow === 'function') {
            VIP.publisherWelcome.maybeShow();
        }

        // Encuesta de notificaciones: aparece una sola vez para que el
        // usuario elija su grupo (suave / normal / activo / solo reembolsos).
        if (VIP.notifSurvey && typeof VIP.notifSurvey.maybeShow === 'function') {
            VIP.notifSurvey.maybeShow();
        }
    }

    // ---- Layout ----

    function adjustLayout() {
        // El layout ahora es una columna flex (.chat-screen): el header y la
        // barra de escribir están en el flujo normal y el chat ocupa el resto
        // con flex:1. No hace falta compensar con márgenes.
    }

    // ---- Balance ----

    async function syncBalance() {
        if (!VIP.state.currentToken || !VIP.state.currentUser) return;

        try {
            const response = await fetch(`${VIP.config.API_URL}/api/balance/live`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.balance !== undefined) {
                    VIP.state.currentUser.balance = data.balance;
                    updateBalanceDisplay(data.balance);

                    const previousBalance = parseFloat(localStorage.getItem('lastBalance') || '0');
                    const newBalance      = parseFloat(data.balance);
                    if (Math.abs(newBalance - previousBalance) > 0.01) {
                        localStorage.setItem('lastBalance', newBalance);
                        showBalanceToast(newBalance);
                    }
                }
            }
        } catch (error) {
            console.error('Error sincronizando saldo:', error);
        }
    }

    function showBalanceToast(balance) {
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            top: 100px;
            right: 20px;
            background: linear-gradient(135deg, #00ff88 0%, #00cc6a 100%);
            color: #000;
            padding: 15px 25px;
            border-radius: 12px;
            font-weight: bold;
            font-size: 16px;
            z-index: 10000;
            animation: slideIn 0.3s ease;
            box-shadow: 0 5px 20px rgba(0, 255, 136, 0.4);
        `;
        toast.innerHTML = `💰 Saldo actualizado: <span style="font-size: 20px;">$${balance.toLocaleString()}</span>`;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    function updateBalanceDisplay(balance) {
        const balanceElement = document.getElementById('userBalance');
        if (balanceElement) {
            balanceElement.textContent = `$${balance.toLocaleString()}`;
        }
        console.log('Saldo actualizado:', balance);
    }

    function startBalancePolling() {
        if (VIP.state.balanceCheckInterval) {
            clearInterval(VIP.state.balanceCheckInterval);
        }
        VIP.state.balanceCheckInterval = setInterval(syncBalance, 30000);
    }

    function stopBalancePolling() {
        if (VIP.state.balanceCheckInterval) {
            clearInterval(VIP.state.balanceCheckInterval);
            VIP.state.balanceCheckInterval = null;
        }
    }

    // ---- Welcome message ----

    async function sendWelcomeMessages() {
        const welcomeKey  = 'lastWelcome_' + (VIP.state.currentUser?.userId || '');
        const lastWelcome = parseInt(localStorage.getItem(welcomeKey) || '0');
        const hoursSince  = (Date.now() - lastWelcome) / 3600000;
        if (hoursSince < 24) {
            console.log('ℹ️ Bienvenida ya enviada recientemente, omitiendo');
            return;
        }

        const username = VIP.state.currentUser?.username || 'Usuario';

        let cbuNumber = 'No disponible';
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/config/cbu`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (response.ok) {
                const cbuData = await response.json();
                cbuNumber = cbuData.number || 'No disponible';
            }
        } catch (error) {
            console.log('No se pudo obtener CBU para bienvenida:', error);
        }

        const welcomeMessage = `🎉 ¡Bienvenido a la Sala de Juegos, ${username}!

🎁 Beneficios exclusivos:
• Reembolso DIARIO del 20%
• Reembolso SEMANAL del 10%
• Reembolso MENSUAL del 5%
• Fueguito diario con recompensas
• Atención 24/7

💬 Escribe aquí para hablar con un agente.

Link de pagina: https://www.jugaygana44.bet/

CBU activo: ${cbuNumber}`;

        await VIP.chat.sendSystemMessage(welcomeMessage);

        if (cbuNumber && cbuNumber !== 'No disponible') {
            await VIP.chat.sendSystemMessage(cbuNumber);
        }

        localStorage.setItem(welcomeKey, Date.now().toString());
        console.log('✅ Mensaje de bienvenida enviado con CBU:', cbuNumber);
    }

    // ---- CBU ----

    async function loadAndShowCBU() {
        const now = Date.now();
        if (now - VIP.state.lastCbuClickTime < VIP.config.CBU_CLICK_COOLDOWN_MS) {
            showToast('Espera unos segundos antes de volver a solicitar el CBU.', 'info');
            return;
        }
        VIP.state.lastCbuClickTime = now;

        try {
            const metaEventId = VIP.pixel && VIP.pixel.enabled ? VIP.pixel.newEventId() : null;
            const response = await fetch(`${VIP.config.API_URL}/api/cbu/request`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${VIP.state.currentToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ metaEventId })
            });

            if (response.ok) {
                const data = await response.json();
                document.getElementById('cbuBankDisplay').textContent    = data.cbu.bank    || '-';
                document.getElementById('cbuTitularDisplay').textContent = data.cbu.titular || '-';
                document.getElementById('cbuNumberDisplay').textContent  = data.cbu.number  || '-';
                document.getElementById('cbuAliasDisplay').textContent   = data.cbu.alias   || '-';

                showModal('cbuModal');
                setTimeout(() => VIP.chat.loadMessages(), 500);
                showToast('💳 Datos CBU enviados al chat', 'success');

                // Meta Pixel — InitiateCheckout (usuario va a depositar).
                if (VIP.pixel) VIP.pixel.trackWithId(metaEventId, 'InitiateCheckout', { content_name: 'cbu_request' });
            } else {
                showToast('Error solicitando CBU', 'error');
            }
        } catch (error) {
            console.error('Error solicitando CBU:', error);
            showToast('Error de conexión', 'error');
        }
    }

    // ---- Referrals ----

    async function openReferralModal() {
        showModal('referralModal');
        await loadReferralData();
    }

    async function loadReferralData() {
        const histContainer = document.getElementById('referralPayoutHistory');
        if (histContainer) histContainer.innerHTML = '<span style="color:#888;font-size:12px;">Cargando...</span>';

        try {
            const [meRes, histRes] = await Promise.all([
                fetch(`${VIP.config.API_URL}/api/referrals/me`, {
                    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
                }),
                fetch(`${VIP.config.API_URL}/api/referrals/history?limit=20`, {
                    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
                })
            ]);

            if (!meRes.ok) {
                if (histContainer) histContainer.innerHTML = '<span style="color:#ff4444;font-size:12px;">No se pudieron cargar tus datos de referidos. Reintentá.</span>';
                return;
            }
            const meData = await meRes.json();
            const me = meData.data;

            document.getElementById('myReferralCode').textContent = me.referralCode || '—';
            document.getElementById('myReferralLink').textContent = me.referralLink || '—';
            const activeCountEl = document.getElementById('referralActiveCount');
            if (activeCountEl) activeCountEl.textContent = me.activeReferred != null ? me.activeReferred : (me.totalReferred || 0);
            document.getElementById('referralHistoricalTotal').textContent =
                '$' + new Intl.NumberFormat('es-AR').format(Math.round(me.historicalTotalCredited || 0));
            document.getElementById('referralCurrentPeriod').textContent = me.currentPeriodLabel || me.currentPeriod || '—';

            VIP.state.referralData = me;

            try {
                const sumRes = await fetch(`${VIP.config.API_URL}/api/referrals/summary`, {
                    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
                });
                if (sumRes.ok) {
                    const sumData = await sumRes.json();
                    const sum = sumData.data;
                    document.getElementById('referralPendingAmount').textContent =
                        '$' + new Intl.NumberFormat('es-AR').format(Math.round(sum.pendingEstimatedAmount || 0));
                    document.getElementById('referralCreditDate').textContent =
                        sum.estimatedCreditDate || 'Inicio del próximo mes';
                    const lastPayoutEl = document.getElementById('referralLastPayoutAmount');
                    if (lastPayoutEl) {
                        if (sum.lastPayout && sum.lastPayout.amount > 0) {
                            lastPayoutEl.textContent = '$' + new Intl.NumberFormat('es-AR').format(Math.round(sum.lastPayout.amount));
                            lastPayoutEl.title = sum.lastPayout.periodLabel || sum.lastPayout.periodKey || '';
                        } else {
                            lastPayoutEl.textContent = '—';
                        }
                    }
                }
            } catch (e) { /* ignorar */ }

            const EMPTY_HISTORY_HTML = '<span style="color:#888;font-size:12px;">Todavía no tenés pagos por referidos.</span>';

            if (histRes.ok) {
                const histData = await histRes.json();
                const payouts  = histData.data?.payouts || [];
                if (payouts.length === 0) {
                    histContainer.innerHTML = EMPTY_HISTORY_HTML;
                } else {
                    const byPeriod = new Map();
                    for (const p of payouts) {
                        const key = p.periodKey || '?';
                        if (!byPeriod.has(key)) byPeriod.set(key, []);
                        byPeriod.get(key).push(p);
                    }

                    const statusBadgeHtml = (status) => {
                        if (status === 'paid')
                            return '<span style="background:rgba(0,255,136,0.12);border:1px solid rgba(0,255,136,0.4);color:#00ff88;font-size:10px;border-radius:4px;padding:2px 6px;">✅ Pagado</span>';
                        if (status === 'failed')
                            return '<span style="background:rgba(255,68,68,0.12);border:1px solid rgba(255,68,68,0.4);color:#ff4444;font-size:10px;border-radius:4px;padding:2px 6px;">❌ Fallido</span>';
                        if (status === 'cancelled')
                            return '<span style="background:rgba(136,136,136,0.12);border:1px solid rgba(136,136,136,0.4);color:#888;font-size:10px;border-radius:4px;padding:2px 6px;">🚫 Cancelado</span>';
                        return '<span style="background:rgba(247,147,30,0.12);border:1px solid rgba(247,147,30,0.4);color:#f7931e;font-size:10px;border-radius:4px;padding:2px 6px;">⏳ Pendiente</span>';
                    };

                    let html = '';
                    for (const [pk, periodPayouts] of byPeriod) {
                        const label    = periodPayouts[0].periodLabel || pk;
                        const paidTotal = periodPayouts
                            .filter(p => p.status === 'paid')
                            .reduce((s, p) => s + (p.totalCommissionAmount || 0), 0);
                        const hasMultiple = periodPayouts.length > 1;

                        html += `<div style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.05);">`;
                        html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">`;
                        html += `<span style="font-size:12px;color:#d4af37;font-weight:600;">📅 ${label}</span>`;
                        if (paidTotal > 0)
                            html += `<span style="font-size:12px;color:#00ff88;font-weight:bold;">$${new Intl.NumberFormat('es-AR').format(Math.round(paidTotal))}</span>`;
                        html += `</div>`;

                        for (const p of periodPayouts) {
                            const isDelta = p.isDelta || (p.payoutIndex || 1) > 1;
                            const amount  = p.totalCommissionAmount || 0;
                            html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;${hasMultiple ? 'padding-left:8px;' : ''}">`;
                            html += `<div style="display:flex;align-items:center;gap:6px;">`;
                            if (isDelta)
                                html += `<span style="background:rgba(212,175,55,0.12);border:1px solid rgba(212,175,55,0.35);color:#d4af37;font-size:10px;border-radius:4px;padding:1px 5px;">Δ delta</span>`;
                            html += `${statusBadgeHtml(p.status)}`;
                            html += `</div>`;
                            html += `<span style="font-size:13px;color:${p.status === 'paid' ? '#d4af37' : '#888'};font-weight:${p.status === 'paid' ? '600' : 'normal'};">$${new Intl.NumberFormat('es-AR').format(Math.round(amount))}</span>`;
                            html += `</div>`;
                        }
                        html += `</div>`;
                    }
                    histContainer.innerHTML = html;
                }
            } else {
                histContainer.innerHTML = EMPTY_HISTORY_HTML;
            }
        } catch (err) {
            console.error('[Referrals] Error cargando datos:', err);
            if (histContainer) histContainer.innerHTML = '<span style="color:#ff4444;font-size:12px;">No se pudieron cargar tus datos de referidos. Reintentá.</span>';
        }
    }

    function copyReferralCode() {
        const code = document.getElementById('myReferralCode').textContent;
        if (code && code !== '—') {
            navigator.clipboard.writeText(code).then(() => {
                showToast('✅ Código copiado', 'success');
            }).catch(() => { fallbackCopy(code); });
        }
    }

    function copyReferralLink() {
        const link = document.getElementById('myReferralLink').textContent;
        if (link && link !== '—') {
            navigator.clipboard.writeText(link).then(() => {
                showToast('✅ Link copiado', 'success');
            }).catch(() => { fallbackCopy(link); });
        }
    }

    // ---- Canal informativo (delegated from chat module) ----

    function loadCanalInformativoUrl() {
        return VIP.chat.loadCanalInformativoUrl();
    }

    // ---- PWA install ----

    async function installApp() {
        const ua        = navigator.userAgent;
        const isIOS     = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
        const isAndroid = /Android/.test(ua);
        const isWindows = /Windows/.test(ua);
        const isMac     = /Macintosh|MacIntel/.test(ua) && !isIOS;

        if (!window.deferredPrompt) {
            if (isIOS)          showInstallInstructions('ios');
            else if (isAndroid) showInstallInstructions('android');
            else if (isWindows) showInstallInstructions('windows');
            else if (isMac)     showInstallInstructions('mac');
            else                showInstallInstructions('generic');
            return;
        }

        window.deferredPrompt.prompt();
        const { outcome } = await window.deferredPrompt.userChoice;
        console.log('PWA: Resultado de la instalación:', outcome);

        if (outcome === 'accepted') {
            showToast('✅ Instalando app...', 'success');
            // Recordatorio de notificaciones para Android (flujo directo via deferredPrompt)
            setTimeout(() => {
                showInstallInstructions('android-notif');
            }, 2000);
        } else {
            showToast('❌ Instalación cancelada', 'error');
        }
        window.deferredPrompt = null;
    }

    function showInstallInstructions(platform) {
        const modal = document.createElement('div');
        modal.className = 'ios-install-modal';

        let title, steps, note;
        // Plataformas móviles: se muestra el aviso de notificaciones
        const isMobilePlatform = platform === 'ios' || platform === 'android' || platform === 'android-notif';

        // Pantalla dedicada de recordatorio de notificaciones post-instalación (Android nativo)
        if (platform === 'android-notif') {
            modal.innerHTML = `
                <div class="ios-install-content">
                    <h3>🔔 Un paso más</h3>
                    <div style="
                        background: rgba(255, 107, 53, 0.15);
                        border: 2px solid #ff6b35;
                        border-radius: 10px;
                        padding: 14px 16px;
                        text-align: left;
                    ">
                        <p style="margin: 0; color: #ff6b35; font-weight: bold; font-size: 15px;">
                            🔔 LO MÁS IMPORTANTE: PERMITIR NOTIFICACIONES
                        </p>
                        <p style="margin: 10px 0 0; color: #fff; font-size: 13px;">
                            Cuando abras la app instalada y te pida acceso,
                            <strong>aceptá y permitir notificaciones</strong>.<br>
                            Sin esto, <u>no te van a llegar los avisos importantes</u>.
                        </p>
                    </div>
                    <button onclick="this.closest('.ios-install-modal').remove()" class="btn btn-primary" style="margin-top:15px;">Entendido</button>
                </div>
            `;
            document.body.appendChild(modal);
            return;
        }

        if (platform === 'ios') {
            title = '📱 Instalar en iPhone / iPad';
            note  = '⚠️ <strong>Solo funciona desde Safari.</strong>';
            steps = [
                'Abrí esta página en <strong>Safari</strong> (no Chrome, no otro navegador)',
                'Tocá el botón <strong>Compartir</strong> <span style="font-size:18px">⬆️</span> en la barra inferior de Safari',
                'Deslizá hacia abajo y tocá <strong>"Agregar a pantalla de inicio"</strong>',
                'Presioná <strong>"Agregar"</strong>'
            ];
        } else if (platform === 'android') {
            title = '📱 Instalar en Android';
            note  = '⚠️ <strong>Solo funciona desde Google Chrome.</strong>';
            steps = [
                'Abrí esta página en <strong>Google Chrome</strong>',
                'Tocá el ícono <strong>⋮</strong> (tres puntos) en la esquina superior derecha',
                'Seleccioná <strong>"Agregar a pantalla de inicio"</strong> o <strong>"Instalar app"</strong>',
                'Presioná <strong>"Agregar"</strong> o <strong>"Instalar"</strong>'
            ];
        } else if (platform === 'windows') {
            title = '💻 Instalar en Windows (PC)';
            note  = '💡 Funciona en Chrome o Edge.';
            steps = [
                'Abrí esta página en <strong>Google Chrome</strong> o <strong>Microsoft Edge</strong>',
                'En Chrome: hacé clic en el ícono de instalación <strong>⊕</strong> en la barra de direcciones',
                'En Edge: hacé clic en el ícono <strong>⊕</strong> o el menú <strong>⋯</strong> → <strong>"Aplicaciones"</strong> → <strong>"Instalar este sitio como aplicación"</strong>',
                'Confirmá la instalación'
            ];
        } else if (platform === 'mac') {
            title = '💻 Instalar en Mac';
            note  = '💡 Funciona en Chrome o Safari.';
            steps = [
                'Abrí esta página en <strong>Google Chrome</strong> o <strong>Safari</strong>',
                'En Chrome: hacé clic en el ícono <strong>⊕</strong> en la barra de direcciones',
                'En Safari: usá <strong>Archivo → Agregar a Dock</strong> (macOS Sonoma o superior)',
                'Confirmá la instalación'
            ];
        } else {
            title = '📱 Instalar App';
            note  = '';
            steps = [
                'Abrí esta página en <strong>Chrome</strong> o <strong>Safari</strong>',
                'Buscá la opción <strong>"Agregar a pantalla de inicio"</strong> o <strong>"Instalar app"</strong> en el menú del navegador',
                'Confirmá la instalación'
            ];
        }

        // Aviso de notificaciones destacado para iOS y Android
        const notifWarning = isMobilePlatform ? `
            <div style="
                background: rgba(255, 107, 53, 0.15);
                border: 2px solid #ff6b35;
                border-radius: 10px;
                padding: 12px 15px;
                margin-top: 15px;
                text-align: left;
            ">
                <p style="margin: 0; color: #ff6b35; font-weight: bold; font-size: 14px;">
                    🔔 LO MÁS IMPORTANTE: PERMITIR NOTIFICACIONES
                </p>
                <p style="margin: 8px 0 0; color: #fff; font-size: 13px;">
                    Una vez instalada, cuando la app te pida acceso, <strong>aceptá y permitir notificaciones</strong>.
                    Sin esto, <u>no te van a llegar los avisos importantes</u>.
                </p>
            </div>` : '';

        modal.innerHTML = `
            <div class="ios-install-content">
                <h3>${title}</h3>
                ${note ? `<p style="color: #f7931e; margin-bottom: 12px;">${note}</p>` : ''}
                <ol>${steps.map(s => `<li>${s}</li>`).join('')}</ol>
                ${notifWarning}
                <button onclick="this.closest('.ios-install-modal').remove()" class="btn btn-primary" style="margin-top:15px;">Entendido</button>
            </div>
        `;
        document.body.appendChild(modal);
    }

    function isAppInstalled() {
        const standalone = window.matchMedia('(display-mode: standalone)').matches ||
                           window.navigator.standalone === true;
        if (!standalone) return false;
        // Also require notification permission to be granted
        const notifGranted = ('Notification' in window) && Notification.permission === 'granted';
        return notifGranted;
    }

    function isAppStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches ||
               window.navigator.standalone === true;
    }

    return {
        showModal,
        hideModal,
        showToast,
        copyText,
        copyToClipboard,
        fallbackCopy,
        showLoginScreen,
        showChatScreen,
        adjustLayout,
        syncBalance,
        showBalanceToast,
        updateBalanceDisplay,
        startBalancePolling,
        stopBalancePolling,
        sendWelcomeMessages,
        loadAndShowCBU,
        openReferralModal,
        loadReferralData,
        copyReferralCode,
        copyReferralLink,
        loadCanalInformativoUrl,
        installApp,
        showInstallInstructions,
        isAppInstalled,
        isAppStandalone
    };

})();

// Window aliases for onclick="..." in HTML
window.showModal             = VIP.ui.showModal;
window.hideModal             = VIP.ui.hideModal;
window.showToast             = VIP.ui.showToast;
window.copyText              = VIP.ui.copyText;
window.copyToClipboard       = VIP.ui.copyToClipboard;
window.copyReferralCode      = VIP.ui.copyReferralCode;
window.copyReferralLink      = VIP.ui.copyReferralLink;
window.installApp            = VIP.ui.installApp;
window.showInstallInstructions = VIP.ui.showInstallInstructions;

// ---- PWA install prompt event handlers (must be top-level) ----

window.deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
        console.log('PWA: ya en standalone, ignorando beforeinstallprompt');
        return;
    }
    window.deferredPrompt = e;
    const loginInstallBtn  = document.getElementById('installBtn');
    const headerInstallBtn = document.getElementById('headerInstallBtn');
    const appInstallBtn    = document.getElementById('appInstallBtn');
    if (loginInstallBtn)  { loginInstallBtn.style.display = 'flex'; loginInstallBtn.classList.remove('hidden'); }
    if (headerInstallBtn) { headerInstallBtn.style.display = 'flex'; headerInstallBtn.classList.remove('hidden'); }
    if (appInstallBtn)    { appInstallBtn.style.display = 'flex'; appInstallBtn.classList.add('show'); }
    console.log('PWA: beforeinstallprompt capturado, botones mostrados');
});

window.addEventListener('appinstalled', () => {
    console.log('PWA: App instalada exitosamente');
    const loginInstallBtn  = document.getElementById('installBtn');
    const headerInstallBtn = document.getElementById('headerInstallBtn');
    const appInstallBtn    = document.getElementById('appInstallBtn');
    if (loginInstallBtn)  { loginInstallBtn.style.display = 'none'; loginInstallBtn.classList.add('hidden'); }
    if (headerInstallBtn) { headerInstallBtn.style.display = 'none'; headerInstallBtn.classList.add('hidden'); }
    if (appInstallBtn)    { appInstallBtn.classList.add('hidden'); }
    window.deferredPrompt = null;
    VIP.ui.showToast('✅ App instalada exitosamente', 'success');
});

// Hide install buttons if already running as standalone
if (VIP.ui.isAppStandalone()) {
    const loginInstallBtn  = document.getElementById('installBtn');
    const headerInstallBtn = document.getElementById('headerInstallBtn');
    const appInstallBtn    = document.getElementById('appInstallBtn');
    if (loginInstallBtn)  { loginInstallBtn.style.display = 'none'; loginInstallBtn.classList.add('hidden'); }
    if (headerInstallBtn) { headerInstallBtn.style.display = 'none'; headerInstallBtn.classList.add('hidden'); }
    if (appInstallBtn)    { appInstallBtn.classList.add('hidden'); }
}

// Mobile drawer toggle
VIP.ui.toggleDrawer = function() {
  const drawer = document.getElementById('mobileDrawer');
  const overlay = document.getElementById('drawerOverlay');
  if (!drawer || !overlay) return;
  const isOpen = drawer.classList.contains('open');

  if (isOpen) {
    drawer.classList.remove('open');
    overlay.classList.remove('open');
  } else {
    const content = document.getElementById('drawerContent');
    content.innerHTML = '';

    const username = VIP.state.currentUser?.username || 'Usuario';

    const items = [
      { emoji: '👤', text: username, action: null, style: 'drawer-user' },
      { emoji: '🔥', text: 'Fueguito Diario', action: () => VIP.fire.showFireModal() },
      { emoji: '📅', text: 'Reembolso Diario', action: () => VIP.refunds.showRefundModal('daily') },
      { emoji: '📆', text: 'Reembolso Semanal', action: () => VIP.refunds.showRefundModal('weekly') },
      { emoji: '🗓️', text: 'Reembolso Mensual', action: () => VIP.refunds.showRefundModal('monthly') },
      { emoji: '🎰', text: 'Casino', action: () => VIP.ui.openPlatformModal() },
      { emoji: '📢', text: 'Canal Informativo', action: () => {
        const btn = document.getElementById('canalInformativoBtn');
        if (btn && btn.href && btn.href !== '#' && btn.href !== window.location.href) {
          window.open(btn.href, '_blank');
        } else {
          VIP.ui.showToast('Canal informativo no disponible', 'info');
        }
      }},
      { emoji: '🤝', text: 'Mis Referidos', action: () => VIP.ui.openReferralModal() },
      { emoji: '💬', text: 'Soporte WhatsApp', action: () => window.open('https://wa.link/metawin2026', '_blank') },
      { emoji: 'ℹ️', text: 'Información', action: () => VIP.ui.showModal('infoModal') },
      { emoji: '🔔', text: 'Notificaciones', action: () => VIP.notifications.requestNotificationPermission(), pwaOnly: true },
      { emoji: '📱', text: 'APP', action: () => VIP.ui.installApp(), hideStandalone: true },
      { emoji: '🔑', text: 'Cambiar contraseña', action: () => VIP.ui.showModal('settingsModal') },
    ];

    items.forEach(item => {
      if (item.pwaOnly && !VIP.ui.isAppInstalled()) return;
      if (item.hideStandalone && VIP.ui.isAppInstalled()) return;

      const btn = document.createElement('button');
      btn.className = 'drawer-item' + (item.style ? ' ' + item.style : '');
      btn.innerHTML = `<span class="drawer-item-emoji">${item.emoji}</span> ${item.text}`;

      if (item.action) {
        btn.addEventListener('click', () => {
          VIP.ui.toggleDrawer();
          setTimeout(item.action, 150);
        });
      }
      content.appendChild(btn);
    });

    drawer.classList.add('open');
    overlay.classList.add('open');
  }
};
window.toggleDrawer = VIP.ui.toggleDrawer;

// Platform modal — private state (no DOM exposure for sensitive data)
VIP.ui._platformPasswordVisible = false;

VIP.ui._copyUsernameToClipboard = function(username, onSuccess) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(username).then(onSuccess).catch(function() {
      VIP.ui.showToast('👤 Tu usuario: ' + username, 'info');
    });
  } else {
    VIP.ui.showToast('👤 Tu usuario: ' + username, 'info');
  }
};

VIP.ui.openPlatformModal = function() {
  const modal = document.getElementById('platformModal');
  if (!modal) return;
  const username = VIP.state.currentUser?.username || '';
  const userEl = document.getElementById('platformModalUser');
  if (userEl) userEl.textContent = username || 'Usuario';

  // Mostrar contraseña si está disponible en memoria de sesión (sin exponerla en el DOM)
  const pwd = VIP.state.sessionPassword || '';
  VIP.ui._platformPasswordVisible = false;
  const pwdEl = document.getElementById('platformModalPassword');
  const pwdInputSection = document.getElementById('platformPasswordInputSection');
  const pwdToggle = document.getElementById('platformPasswordToggle');
  if (pwdEl) {
    pwdEl.textContent = pwd ? '••••••••' : '—';
    if (pwdToggle) pwdToggle.textContent = '👁';
  }
  if (pwdInputSection) pwdInputSection.style.display = pwd ? 'none' : 'block';

  // Resetear feedback de copia
  const feedback = document.getElementById('platformCopyFeedback');
  if (feedback) feedback.style.display = 'none';

  modal.style.display = 'flex';

  // Auto-copiar usuario al abrir el modal
  if (username) {
    VIP.ui._copyUsernameToClipboard(username, function() {
      if (feedback) feedback.style.display = 'block';
      VIP.ui.showToast('✅ Usuario copiado: ' + username, 'success');
    });
  }
};

VIP.ui.closePlatformModal = function() {
  const modal = document.getElementById('platformModal');
  if (modal) modal.style.display = 'none';
};

VIP.ui.copyPlatformUsername = function() {
  const username = VIP.state.currentUser?.username || '';
  if (!username) return;
  const feedback = document.getElementById('platformCopyFeedback');
  VIP.ui._copyUsernameToClipboard(username, function() {
    if (feedback) feedback.style.display = 'block';
    VIP.ui.showToast('✅ Usuario copiado: ' + username, 'success');
  });
};

VIP.ui.goToPlatform = function() {
  window.open('https://www.jugaygana44.bet', '_blank');
  VIP.ui.closePlatformModal();
};

VIP.ui.showPlatformPasswordInfo = function() {
  VIP.ui.showToast('Tu contraseña es la misma que usás para entrar a VipCargas', 'info');
};
// Alias kept for backward compatibility with the onclick handler
VIP.ui.copyPlatformPassword = VIP.ui.showPlatformPasswordInfo;

VIP.ui.togglePlatformPasswordVisibility = function() {
  const pwdEl = document.getElementById('platformModalPassword');
  const toggle = document.getElementById('platformPasswordToggle');
  if (!pwdEl) return;
  const plain = VIP.state.sessionPassword || '';
  if (!plain) return;
  VIP.ui._platformPasswordVisible = !VIP.ui._platformPasswordVisible;
  if (VIP.ui._platformPasswordVisible) {
    pwdEl.textContent = plain;
    if (toggle) toggle.textContent = '🙈';
  } else {
    pwdEl.textContent = '••••••••';
    if (toggle) toggle.textContent = '👁';
  }
};

VIP.ui.savePlatformPassword = function() {
  const input = document.getElementById('platformPasswordManualInput');
  if (!input || !input.value.trim()) return;
  const pwd = input.value.trim();
  VIP.state.sessionPassword = pwd;
  VIP.ui._platformPasswordVisible = false;
  const pwdEl = document.getElementById('platformModalPassword');
  const pwdInputSection = document.getElementById('platformPasswordInputSection');
  const pwdToggle = document.getElementById('platformPasswordToggle');
  if (pwdEl) {
    pwdEl.textContent = '••••••••';
    if (pwdToggle) pwdToggle.textContent = '👁';
  }
  if (pwdInputSection) pwdInputSection.style.display = 'none';
  input.value = '';
  VIP.ui.showToast('✅ Contraseña guardada para esta sesión', 'success');
};

VIP.ui.showPlatformPasswordChange = function() {
  // Cerrar el modal de plataforma
  VIP.ui.closePlatformModal();
  // Asegurarse de que el cambio sea voluntario (no obligatorio)
  VIP.state.passwordChangePending = false;
  if (typeof window.setPasswordChangePending === 'function') {
    window.setPasswordChangePending(false);
  }
  // Preparar y abrir el modal de cambio de contraseña
  if (typeof VIP.auth.prepareChangePasswordModal === 'function') {
    VIP.auth.prepareChangePasswordModal();
  } else if (typeof window.prepareChangePasswordModal === 'function') {
    window.prepareChangePasswordModal();
  }
  const modal = document.getElementById('changePasswordModal');
  if (modal) modal.classList.remove('hidden');
};
