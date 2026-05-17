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
            const s2 = document.getElementById('registerStep2');
            if (s1) s1.style.display = '';
            if (s2) s2.style.display = 'none';
        }
    }

    // ---- Toast & copy ----

    function showToast(message, type = 'success', durationMs) {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        const ms = Number.isFinite(Number(durationMs)) ? Math.max(1000, Number(durationMs)) : 3000;
        setTimeout(() => toast.remove(), ms);
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
        document.getElementById('currentUser').textContent = VIP.state.currentUser?.username || 'Usuario';

        adjustLayout();
        syncBalance();
        startBalancePolling();
        // Backup phone chip: chequear estado y mostrar si todavía no lo dejó.
        try { setupBackupPhoneChip(); } catch (_) {}
        // Soporte: pintar el badge top-right con el número actual.
        try { if (typeof window.applySupportPhoneToUI === 'function') window.applySupportPhoneToUI(); } catch (_) {}
        // sendWelcomeMessages() removido — esta version no tiene chat,
        // los "mensajes de bienvenida" iban al chat in-app que sacamos.
    }

    // Tarjeta de teléfono de respaldo al pie del home. SIEMPRE visible: si
    // el user ya guardó un número, lo precarga en el input para que pueda
    // modificarlo desde el mismo lugar. Importante pero no obligatorio.
    let _backupPhoneInited = false;
    async function setupBackupPhoneChip() {
        const card   = document.getElementById('backupPhoneCard');
        const input  = document.getElementById('backupPhoneCardInput');
        const save   = document.getElementById('backupPhoneCardSave');
        const status = document.getElementById('backupPhoneCardStatus');
        if (!card || !input || !save) return;

        const showStatus = (text, kind) => {
            if (!status) return;
            status.textContent = text;
            status.className = 'backup-phone-card-status ' + (kind || '');
            status.hidden = false;
        };

        if (!_backupPhoneInited) {
            _backupPhoneInited = true;
            save.addEventListener('click', async () => {
                const val = (input.value || '').trim();
                const digits = val.replace(/\D/g, '');
                if (digits.length < 6) {
                    showStatus('Número muy corto. Ingresá al menos 6 dígitos.', 'error');
                    return;
                }
                save.disabled = true;
                save.textContent = '⏳';
                try {
                    const r = await fetch(`${VIP.config.API_URL}/api/user/backup-phone`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${VIP.state.currentToken}`
                        },
                        body: JSON.stringify({ phone: val })
                    });
                    const data = await r.json().catch(() => ({}));
                    if (!r.ok) {
                        showStatus(data.error || 'No se pudo guardar. Probá de nuevo.', 'error');
                        save.disabled = false;
                        save.textContent = 'Guardar';
                        return;
                    }
                    showStatus('✓ Número guardado. Gracias por confiar en nosotros.', 'ok');
                    save.disabled = false;
                    save.textContent = 'Actualizar';
                } catch (e) {
                    showStatus('Error de conexión. Probá de nuevo.', 'error');
                    save.disabled = false;
                    save.textContent = 'Guardar';
                }
            });
        }

        // Tarjeta SIEMPRE visible. Si ya guardó, precargamos el número y
        // cambiamos el botón a "Actualizar" para que pueda modificarlo.
        card.hidden = false;
        try {
            const r = await fetch(`${VIP.config.API_URL}/api/user/backup-phone`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (r.ok) {
                const d = await r.json();
                if (d.hasSubmitted && d.phone) {
                    input.value = d.phone;
                    save.textContent = 'Actualizar';
                    showStatus('✓ Tenés guardado este número. Si querés cambiarlo, editalo y tocá Actualizar.', 'ok');
                }
            }
        } catch (_) { /* si falla, igual la tarjeta queda visible para usar */ }
    }

    // ---- Layout ----

    function adjustLayout() {
        const header         = document.querySelector('.header');
        const promoBanner    = document.querySelector('.promo-banner');
        const chatSection    = document.querySelector('.chat-section');
        const inputContainer = document.querySelector('.chat-input-container');

        if (!header || !chatSection) return;

        const headerHeight = header.getBoundingClientRect().height;

        if (promoBanner) {
            const bannerComputed = window.getComputedStyle(promoBanner);
            if (bannerComputed.display !== 'none') {
                promoBanner.style.top = headerHeight + 'px';
                const bannerHeight = promoBanner.getBoundingClientRect().height;
                chatSection.style.marginTop = (headerHeight + bannerHeight) + 'px';
            } else {
                chatSection.style.marginTop = headerHeight + 'px';
            }
        } else {
            chatSection.style.marginTop = headerHeight + 'px';
        }

        if (inputContainer) {
            const inputHeight = inputContainer.getBoundingClientRect().height;
            chatSection.style.marginBottom = inputHeight + 'px';
        }
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
        // Layout v3 cambio el id a 'userBalanceAmount'. Mantenemos fallback a
        // 'userBalance' por compat con vistas viejas/modales que aun lo usen.
        const balanceElement = document.getElementById('userBalanceAmount') ||
                               document.getElementById('userBalance');
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
            const response = await fetch(`${VIP.config.API_URL}/api/cbu/request`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${VIP.state.currentToken}`,
                    'Content-Type': 'application/json'
                }
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

        // Si la app ya está instalada (standalone), no hacemos nada.
        const isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
                              window.navigator.standalone === true;
        if (isStandalone) {
            showToast('✅ Ya tenés la app instalada', 'success');
            return;
        }

        // En Android, esperar hasta 2.5s a que `beforeinstallprompt` se
        // dispare (Chrome lo emite asincrónico después de validar el
        // manifest + SW). Sin esto, un tap muy temprano caía siempre al
        // fallback de instrucciones manuales aunque el evento llegara
        // 800ms después.
        if (!window.deferredPrompt && isAndroid) {
            await new Promise((resolve) => {
                const t = setTimeout(resolve, 2500);
                window.addEventListener('pwa-prompt-ready', function once() {
                    window.removeEventListener('pwa-prompt-ready', once);
                    clearTimeout(t);
                    resolve();
                }, { once: true });
            });
        }

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
            // Detector post-install: si el user "aceptó" pero Chrome le ofreció
            // un atajo/widget en vez de WebAPK real (Moto Launcher 1x1, etc),
            // jamás vamos a ver el evento `appinstalled` y `isStandalone` va a
            // seguir false. A los 6s sin instalación real, mostramos el modal
            // con los pasos de limpieza (Configuración de Chrome → borrar datos
            // del sitio → reinstalar via menú ⋮). El timer se cancela si el
            // `appinstalled` real llega antes.
            let installFlowDone = false;
            const onAppInstalled = () => {
                installFlowDone = true;
                window.removeEventListener('appinstalled', onAppInstalled);
            };
            window.addEventListener('appinstalled', onAppInstalled);

            setTimeout(() => {
                showInstallInstructions('android-notif');
            }, 2000);

            setTimeout(() => {
                window.removeEventListener('appinstalled', onAppInstalled);
                const nowStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
                                       || window.navigator.standalone === true;
                if (installFlowDone || nowStandalone) return; // todo OK
                // Probable caso "shortcut/widget" — mostramos el rescate
                showInstallInstructions('android');
            }, 6000);
        } else {
            showToast('❌ Instalación cancelada', 'error');
        }
        window.deferredPrompt = null;
    }

    function showInstallInstructions(platform) {
        const modal = document.createElement('div');
        modal.className = 'ios-install-modal';
        // Cerrar al tocar el fondo (no el contenido).
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
        // Cerrar con tecla Escape.
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                modal.remove();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);

        let title, steps, note;
        // Plataformas móviles: se muestra el aviso de notificaciones
        const isMobilePlatform = platform === 'ios' || platform === 'android' || platform === 'android-notif';

        // Pantalla dedicada de recordatorio POST-INSTALACIÓN. Grande, claro,
        // con el hook del $5K — el user acaba de instalar la app y necesita
        // entender 2 cosas: ABRIR la app desde el ícono Y aceptar notifs.
        // Sin esto, no puede reclamar el bono.
        if (platform === 'android-notif') {
            modal.innerHTML = `
                <div class="ios-install-content" style="max-width:440px;background:linear-gradient(180deg,#1a0033,#0a001a);border:3px solid #ffd700;box-shadow:0 0 40px rgba(255,215,0,0.45);">
                    <button type="button" class="ios-install-close" aria-label="Cerrar" onclick="this.closest('.ios-install-modal').remove()">×</button>
                    <div style="text-align:center;font-size:58px;line-height:1;margin-bottom:6px;">🎁</div>
                    <h3 style="color:#ffd700;text-align:center;font-size:20px;letter-spacing:1px;margin:0 0 4px;">¡LA APP YA ESTÁ INSTALADA!</h3>
                    <p style="text-align:center;color:#fff;font-size:14.5px;line-height:1.5;margin:0 0 14px;">Falta poco para reclamar tu <strong style="color:#ffd700;font-size:18px;">$5.000 GRATIS</strong>.</p>

                    <!-- Paso 1: abrir desde el ícono -->
                    <div style="background:rgba(37,211,102,0.10);border:2px solid #25d366;border-radius:12px;padding:14px;margin-bottom:10px;text-align:left;">
                        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
                            <div style="flex-shrink:0;width:34px;height:34px;border-radius:50%;background:#25d366;color:#000;font-weight:900;display:flex;align-items:center;justify-content:center;font-size:18px;">1</div>
                            <strong style="color:#25d366;font-size:15px;">ABRÍ LA APP DESDE EL ÍCONO</strong>
                        </div>
                        <p style="margin:0 0 0 44px;color:#fff;font-size:13px;line-height:1.5;">Buscá el ícono <strong>nuevo</strong> que quedó en la pantalla de tu celular y abrilo desde ahí. <span style="color:#ffaa44;">NO la abras desde Chrome.</span></p>
                    </div>

                    <!-- Paso 2: aceptar notificaciones -->
                    <div style="background:rgba(0,212,255,0.10);border:2px solid #00d4ff;border-radius:12px;padding:14px;margin-bottom:14px;text-align:left;">
                        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
                            <div style="flex-shrink:0;width:34px;height:34px;border-radius:50%;background:#00d4ff;color:#000;font-weight:900;display:flex;align-items:center;justify-content:center;font-size:18px;">2</div>
                            <strong style="color:#00d4ff;font-size:15px;">ACTIVÁ LAS NOTIFICACIONES</strong>
                        </div>
                        <p style="margin:0 0 0 44px;color:#fff;font-size:13px;line-height:1.5;">Cuando entres a la app por primera vez te va a pedir permiso de notificaciones. Tocá <strong style="color:#00d4ff;">PERMITIR</strong>.</p>
                    </div>

                    <div style="background:linear-gradient(135deg,rgba(255,215,0,0.18),rgba(255,136,0,0.10));border:2px dashed #ffd700;border-radius:12px;padding:12px;text-align:center;margin-bottom:12px;">
                        <div style="color:#ffd700;font-weight:900;font-size:14px;letter-spacing:0.5px;">👇 Hechos los 2 pasos te aparece</div>
                        <div style="color:#fff;font-weight:900;font-size:18px;margin-top:3px;">🎁 RECLAMAR $5.000</div>
                    </div>

                    <button onclick="this.closest('.ios-install-modal').remove()" class="btn btn-primary" style="width:100%;background:linear-gradient(135deg,#ffd700,#ff8800);color:#000;font-weight:900;font-size:15px;letter-spacing:0.5px;padding:13px;border-radius:11px;border:none;cursor:pointer;box-shadow:0 4px 14px rgba(255,215,0,0.40);">ENTENDIDO, VOY A ABRIR LA APP</button>
                </div>
            `;
            document.body.appendChild(modal);
            return;
        }

        // ===== Caso especial iOS: modal completo y visual =====
        // Detectamos si esta en Safari o en otro navegador (Chrome iOS, etc),
        // y le damos a cada uno el flow correcto. Apple solo permite instalar
        // PWAs desde Safari → si esta en otro navegador, le damos primero
        // copia de URL + instrucciones para abrirla en Safari.
        if (platform === 'ios') {
            const ua2 = navigator.userAgent;
            const isSafariIOS = /^((?!chrome|crios|fxios|edgios|opios|gsa).)*safari/i.test(ua2);

            if (!isSafariIOS) {
                // Caso Chrome/Firefox/Edge en iPhone: NO se puede instalar.
                // Mostramos un modal con boton "Copiar URL" que le permite
                // pegar en Safari y desde ahi instalar.
                const pageUrl = window.location.href;
                const safeUrl = pageUrl.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                modal.innerHTML = `
                    <div class="ios-install-content" style="max-width:380px;">
                        <button type="button" class="ios-install-close" aria-label="Cerrar" onclick="this.closest('.ios-install-modal').remove()">×</button>
                        <h3 style="color:#ff6b35;margin-bottom:6px;">🦊 Estás en Chrome (o similar)</h3>
                        <p style="color:#fff;font-size:14px;line-height:1.45;margin:0 0 14px;">
                            Para instalar la app en iPhone <strong>solo funciona desde Safari</strong>.
                            Apple no permite instalar apps desde otros navegadores en iOS.
                        </p>
                        <div style="background:rgba(0,0,0,0.35);border:1px solid rgba(255,107,53,0.45);border-radius:10px;padding:12px;margin-bottom:14px;">
                            <p style="margin:0 0 8px;color:#ffd700;font-size:13px;font-weight:700;">📋 Cómo hacerlo:</p>
                            <ol style="margin:0;padding-left:22px;color:#eee;font-size:13px;line-height:1.6;">
                                <li>Tocá <strong>"Copiar enlace"</strong> abajo</li>
                                <li>Abrí <strong>Safari</strong> en tu iPhone (el ícono de la brújula azul)</li>
                                <li>Pegá el enlace en la barra de direcciones</li>
                                <li>Una vez abierto en Safari, vas a poder instalar</li>
                            </ol>
                        </div>
                        <button onclick="(function(b){
                            var t='${pageUrl.replace(/'/g, "\\'")}';
                            if(navigator.clipboard){navigator.clipboard.writeText(t).then(function(){b.textContent='✅ Enlace copiado';b.style.background='#25d366';},function(){b.textContent='❌ No se pudo copiar';});}
                            else{var i=document.createElement('input');i.value=t;document.body.appendChild(i);i.select();try{document.execCommand('copy');b.textContent='✅ Enlace copiado';b.style.background='#25d366';}catch(e){b.textContent='❌ No se pudo copiar';}document.body.removeChild(i);}
                        })(this);" class="btn btn-primary" style="width:100%;margin-bottom:8px;background:#1a73e8;font-weight:700;">
                            📋 Copiar enlace para abrir en Safari
                        </button>
                        <button onclick="this.closest('.ios-install-modal').remove()" class="btn btn-secondary" style="width:100%;">
                            Después
                        </button>
                    </div>
                `;
                document.body.appendChild(modal);
                return;
            }

            // Caso Safari iOS: modal visual completo con representacion del
            // boton Compartir y flechas guia.
            modal.innerHTML = `
                <div class="ios-install-content">
                    <button type="button" class="ios-install-close" aria-label="Cerrar" onclick="this.closest('.ios-install-modal').remove()">×</button>
                    <h3 style="margin-bottom:4px;">📱 Instalar en iPhone</h3>
                    <p style="color:#cfcfcf;font-size:13px;margin:0 0 12px;">3 pasos rápidos. Tarda 15 segundos.</p>

                    <!-- VIDEO TUTORIAL (YouTube Short, < 60s) -->
                    <div style="position:relative;margin:0 0 14px;background:#000;border:1px solid rgba(212,175,55,0.30);border-radius:10px;overflow:hidden;">
                        <div style="position:relative;padding-bottom:56.25%;height:0;">
                            <iframe src="https://www.youtube-nocookie.com/embed/7pfmzNlQlhw?rel=0&modestbranding=1"
                                    style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;"
                                    title="Cómo agregar a pantalla de inicio en iPhone"
                                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                                    referrerpolicy="strict-origin-when-cross-origin"
                                    allowfullscreen></iframe>
                        </div>
                        <div style="background:rgba(0,0,0,0.75);padding:6px 10px;font-size:11px;color:#cfcfcf;text-align:center;">▶️ Mirá el video o seguí los pasos abajo</div>
                    </div>

                    <!-- PASO 0: si no ves la barra de Safari -->
                    <div style="background:rgba(91,154,255,0.10);border:1px solid rgba(91,154,255,0.40);border-radius:12px;padding:12px;margin-bottom:10px;">
                        <p style="margin:0 0 8px;color:#5b9aff;font-weight:700;font-size:13px;">
                            ⚠ ANTES DE EMPEZAR
                        </p>
                        <p style="margin:0;color:#fff;font-size:12px;line-height:1.5;">
                            Si no ves los íconos abajo, primero tocá los <strong style="color:#5b9aff;">3 puntos «•••»</strong> que están <strong>abajo a la derecha</strong> de Safari para abrir el menú. Ahí dentro vas a encontrar el botón Compartir del paso 1.
                        </p>
                    </div>

                    <!-- PASO 1 -->
                    <div style="background:rgba(0,0,0,0.40);border:1px solid rgba(212,175,55,0.30);border-radius:12px;padding:14px;margin-bottom:10px;">
                        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                            <span style="background:#d4af37;color:#1a1a1a;font-weight:900;width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:13px;">1</span>
                            <strong style="color:#fff;font-size:14px;">Tocá el botón Compartir</strong>
                        </div>
                        <p style="margin:0 0 10px 34px;color:#bbb;font-size:12px;line-height:1.5;">
                            Está abajo de la pantalla, en el medio de la barra de Safari (o dentro del menú de los 3 puntos «•••»).
                        </p>
                        <div style="display:flex;align-items:center;justify-content:center;gap:14px;background:#0a0a0a;border-radius:10px;padding:14px;border:1px dashed rgba(255,255,255,0.15);">
                            <div style="position:relative;">
                                <svg width="44" height="56" viewBox="0 0 44 56" style="display:block;">
                                    <rect x="6" y="14" width="32" height="36" rx="4" fill="#3478f6" stroke="#5b9aff" stroke-width="1.5"/>
                                    <line x1="22" y1="22" x2="22" y2="42" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>
                                    <polyline points="14,30 22,22 30,30" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                <div style="font-size:10px;color:#5b9aff;text-align:center;margin-top:2px;font-weight:700;">Compartir</div>
                            </div>
                            <span style="font-size:32px;color:#ff6b35;animation: arrowBounce 1s infinite;">←</span>
                            <span style="color:#ff6b35;font-weight:700;font-size:13px;">Tocá acá</span>
                        </div>
                    </div>

                    <!-- PASO 2 -->
                    <div style="background:rgba(0,0,0,0.40);border:1px solid rgba(212,175,55,0.30);border-radius:12px;padding:14px;margin-bottom:10px;">
                        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                            <span style="background:#d4af37;color:#1a1a1a;font-weight:900;width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:13px;">2</span>
                            <strong style="color:#fff;font-size:14px;">Buscá "Agregar a pantalla de inicio"</strong>
                        </div>
                        <p style="margin:0 0 10px 34px;color:#bbb;font-size:12px;line-height:1.5;">
                            Aparece un menú. Deslizá hacia abajo y tocá:
                        </p>
                        <div style="background:#1c1c1c;border-radius:8px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between;border:1px solid rgba(255,255,255,0.12);">
                            <span style="color:#fff;font-size:13px;">Agregar a pantalla de inicio</span>
                            <span style="color:#5b9aff;font-size:18px;">⊕</span>
                        </div>
                    </div>

                    <!-- PASO 3 -->
                    <div style="background:rgba(0,0,0,0.40);border:1px solid rgba(212,175,55,0.30);border-radius:12px;padding:14px;margin-bottom:14px;">
                        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                            <span style="background:#d4af37;color:#1a1a1a;font-weight:900;width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:13px;">3</span>
                            <strong style="color:#fff;font-size:14px;">Tocá "Agregar"</strong>
                        </div>
                        <p style="margin:0 0 0 34px;color:#bbb;font-size:12px;line-height:1.5;">
                            Arriba a la derecha. Listo, ya tenés el ícono en tu pantalla.
                        </p>
                    </div>

                    <!-- IMPORTANTE notifs -->
                    <div style="background:rgba(255,107,53,0.15);border:2px solid #ff6b35;border-radius:10px;padding:12px;margin-bottom:14px;">
                        <p style="margin:0 0 6px;color:#ff6b35;font-weight:800;font-size:13px;">
                            ⚠️ DESPUÉS DE INSTALAR
                        </p>
                        <p style="margin:0;color:#fff;font-size:12px;line-height:1.5;">
                            Abrí la app desde el ícono que quedó en tu pantalla y <strong>aceptá las notificaciones</strong>. Sin eso no podés desbloquear el bono de $5.000.
                        </p>
                    </div>

                    <button onclick="this.closest('.ios-install-modal').remove()" class="btn btn-primary" style="width:100%;font-weight:700;">
                        ✅ Entendido, lo voy a hacer
                    </button>
                </div>
            `;
            document.body.appendChild(modal);
            return;
        }

        if (platform === 'android') {
            title = '📱 Instalar en Android';
            note  = '⚠️ <strong>Si abriste el link desde WhatsApp/Instagram/Facebook, primero copialo y pegalo en Chrome</strong> — desde el navegador interno de esas apps no se puede instalar.<br><br>🛟 <strong>¿Te aparece un widget 1×1 en vez de instalarse?</strong> Es porque Chrome ya recuerda que dismisseaste el cartel antes. Andá a <strong>Configuración de Chrome → Configuración del sitio → Almacenamiento</strong>, buscá esta página y tocá <strong>Borrar datos</strong>. Después volvé acá y probá de nuevo desde el menú ⋮ → "Instalar app".';
            steps = [
                'Abrí esta página en <strong>Google Chrome</strong> (NO en el navegador de WhatsApp/Instagram/Facebook)',
                'Tocá el botón <strong>⋮</strong> (tres puntos) que está <strong>arriba a la derecha</strong> de Chrome',
                'En el menú que se abre, tocá <strong>"Instalar app"</strong>. Si solo te aparece <strong>"Agregar a pantalla principal"</strong> con un widget chico de 1×1, NO lo aceptes — eso no es la app real. Cerrá ese cartel y seguí con los pasos del cuadrito naranja de arriba.',
                'Confirmá tocando <strong>"Instalar"</strong>',
                'Te queda un ícono nuevo en el cajón de apps — abrila desde ahí, NO desde Chrome',
                'Cuando entres por primera vez te pide permiso de notificaciones → tocá <strong>PERMITIR</strong>'
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
                <button type="button" class="ios-install-close" aria-label="Cerrar" onclick="this.closest('.ios-install-modal').remove()">×</button>
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

// CRITICAL: NO sobreescribir window.deferredPrompt si ya está seteado.
// El script inline del <head> de index.html puede haber capturado el
// evento `beforeinstallprompt` antes de que este script (deferred)
// corra. Si lo seteamos a null acá, perdemos el prompt para siempre y
// el botón Instalar cae al fallback de instrucciones manuales en Android.
window.deferredPrompt = window.deferredPrompt || null;

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
    // Guardamos un flag para que, cuando el usuario vuelva a la web (no standalone),
    // sepamos que ya instalo la app y mostremos 'Ingresa desde la app' en lugar de
    // las instrucciones de instalacion.
    try { localStorage.setItem('vipAppInstalled', '1'); } catch (_) {}
    // NO ocultamos el boton "📱 APP" del header (appInstallBtn): asi si el
    // user desinstala la app y reinstala desde otro browser, sigue teniendo
    // acceso al boton para abrir las instrucciones. Solo escondemos los
    // botones del login/header secundario.
    const loginInstallBtn  = document.getElementById('installBtn');
    const headerInstallBtn = document.getElementById('headerInstallBtn');
    if (loginInstallBtn)  { loginInstallBtn.style.display = 'none'; loginInstallBtn.classList.add('hidden'); }
    if (headerInstallBtn) { headerInstallBtn.style.display = 'none'; headerInstallBtn.classList.add('hidden'); }
    window.deferredPrompt = null;
    // Mostrar el modal POST-INSTALL grande con los 2 pasos restantes
    // (abrir desde el ícono + activar notificaciones) y el hook $5K.
    // Defer un toque para no pisar al toast del Chrome nativo de "App
    // agregada al inicio".
    setTimeout(() => {
        try { VIP.ui.showInstallInstructions('android-notif'); }
        catch (_) {}
    }, 1500);
});

// Hide install buttons if already running as standalone
if (VIP.ui.isAppStandalone()) {
    // Si ya esta corriendo como standalone significa que ya esta instalada,
    // marcamos el flag (cubre el caso de instalaciones previas a este codigo).
    try { localStorage.setItem('vipAppInstalled', '1'); } catch (_) {}
    const loginInstallBtn  = document.getElementById('installBtn');
    const headerInstallBtn = document.getElementById('headerInstallBtn');
    const appInstallBtn    = document.getElementById('appInstallBtn');
    if (loginInstallBtn)  { loginInstallBtn.style.display = 'none'; loginInstallBtn.classList.add('hidden'); }
    if (headerInstallBtn) { headerInstallBtn.style.display = 'none'; headerInstallBtn.classList.add('hidden'); }
    if (appInstallBtn)    { appInstallBtn.classList.add('hidden'); }
}

// Card compacto del bono $5.000 con stepper de 3 pasos.
// Estados:
//   - !installed                -> "Instalá la app" (paso 1 activo, btn=INSTALAR)
//   - installed && !inApp       -> "Abrí desde el ícono" (paso 2 activo)
//   - inApp && !notifOk         -> auto-prompt notifs (paso 3 activo)
//   - inApp && notifOk          -> "RECLAMAR $5.000" (todos done, btn verde)
// El render se ejecuta al cargar, cada vez que la app vuelve al foreground
// (visibilitychange) y cuando llega el evento appinstalled.
(function setupInstallHeroCard() {
    const card = document.getElementById('installHeroCard');
    if (!card) return;

    const isInApp     = () => VIP.ui.isAppStandalone();
    const isInstalled = () => (typeof VIP.ui.isAppInstalled === 'function') ? VIP.ui.isAppInstalled() : VIP.ui.isAppStandalone();
    const isNotifOk   = () => (typeof Notification !== 'undefined' && Notification.permission === 'granted');

    function setStep(stepEl, badgeEl, state, badgeChar) {
        if (!stepEl || !badgeEl) return;
        stepEl.classList.remove('done', 'active');
        if (state === 'done') {
            stepEl.classList.add('done');
            badgeEl.textContent = '✓';
        } else if (state === 'active') {
            stepEl.classList.add('active');
            badgeEl.textContent = badgeChar;
        } else {
            badgeEl.textContent = badgeChar;
        }
    }

    // Dismiss persistente del card (X de cierre). Por username; si reinstala
    // la app y entra de nuevo, vuelve a verlo (a menos que ya esté reclamado).
    function _heroDismissKey() {
        try {
            const u = (VIP.state && VIP.state.currentUser && VIP.state.currentUser.username) || '_anon';
            return 'installHeroDismissed:' + u;
        } catch (_) { return 'installHeroDismissed:_anon'; }
    }
    function _isHeroDismissed() {
        try { return localStorage.getItem(_heroDismissKey()) === '1'; } catch (_) { return false; }
    }

    function renderHero() {
        if (!card) return;
        const installed = isInstalled();
        const inApp     = isInApp();
        const notifOk   = isNotifOk();

        // Si ya reclamó el bono, ocultar definitivamente.
        try {
            if (VIP.refunds && typeof VIP.refunds._isLocallyMarkedClaimed === 'function' && VIP.refunds._isLocallyMarkedClaimed()) {
                card.hidden = true;
                return;
            }
        } catch (_) {}

        // Si el user lo cerró con la X, respetar el dismiss.
        if (_isHeroDismissed()) {
            card.hidden = true;
            return;
        }

        card.hidden = false;

        const step1State = installed ? 'done' : 'active';
        const step2State = installed ? (inApp ? 'done' : 'active') : 'pending';
        const step3State = (installed && inApp) ? (notifOk ? 'done' : 'active') : 'pending';
        setStep(document.getElementById('heroStep1'), document.getElementById('heroStep1Badge'), step1State, '1');
        setStep(document.getElementById('heroStep2'), document.getElementById('heroStep2Badge'), step2State, '2');
        setStep(document.getElementById('heroStep3'), document.getElementById('heroStep3Badge'), step3State, '3');

        const sub     = document.getElementById('installHeroSub');
        const nextEl  = document.getElementById('installHeroNext');
        const btn     = document.getElementById('installHeroBtn');

        if (!installed) {
            if (sub) sub.textContent = 'Tarda 30 segundos. Tocá el botón para empezar.';
            if (nextEl) { nextEl.style.display = 'none'; nextEl.textContent = ''; }
            if (btn) { btn.textContent = '📲 INSTALAR APP'; btn.classList.remove('is-claim'); btn.disabled = false; }
        } else if (!inApp) {
            if (sub) sub.textContent = 'La app ya está en tu celular. Ahora abrila desde el ícono.';
            if (nextEl) { nextEl.style.display = ''; nextEl.textContent = '➡ PRÓXIMO PASO: ABRIR LA APP DEL INICIO'; }
            if (btn) { btn.textContent = '📱 ABRIR DESDE EL ÍCONO'; btn.classList.remove('is-claim'); btn.disabled = false; }
        } else if (!notifOk) {
            if (sub) sub.textContent = 'Aceptá las notificaciones para acreditarte el bono.';
            if (nextEl) { nextEl.style.display = ''; nextEl.textContent = '➡ PRÓXIMO PASO: ACEPTAR NOTIFICACIONES'; }
            if (btn) { btn.textContent = '🔔 ACTIVAR NOTIFICACIONES'; btn.classList.remove('is-claim'); btn.disabled = false; }
        } else {
            if (sub) sub.textContent = '🎉 ¡Listo! Reclamá tu bono de bienvenida.';
            if (nextEl) { nextEl.style.display = 'none'; }
            if (btn) { btn.textContent = '🎁 RECLAMAR $5.000'; btn.classList.add('is-claim'); btn.disabled = false; }
        }
    }

    // Auto-prompt de notificaciones cuando entra a la app (standalone) y
    // todavía no aceptó. Una sola vez por sesión para no ser invasivo.
    let _notifAutoPromptDone = false;
    function maybeAutoPromptNotifs() {
        if (_notifAutoPromptDone) return;
        if (typeof Notification === 'undefined') return;
        if (!isInApp()) return;
        if (Notification.permission !== 'default') return; // ya granted o denied
        _notifAutoPromptDone = true;
        setTimeout(() => {
            try {
                Notification.requestPermission().then((perm) => {
                    if (perm === 'granted' && VIP.ui && typeof VIP.ui.showToast === 'function') {
                        VIP.ui.showToast('✅ Notificaciones activadas. Ya podés reclamar tu bono.', 'success');
                    }
                    renderHero();
                }).catch(() => {});
            } catch (_) {}
        }, 700);
    }

    // Click del botón único: dispatch según el estado actual.
    const btn = document.getElementById('installHeroBtn');
    if (btn) {
        btn.addEventListener('click', () => {
            const installed = isInstalled();
            const inApp     = isInApp();
            const notifOk   = isNotifOk();
            if (!installed) {
                try { if (typeof VIP.ui.installApp === 'function') VIP.ui.installApp(); } catch (e) {}
                return;
            }
            if (!inApp) {
                if (VIP.ui && typeof VIP.ui.showToast === 'function') {
                    VIP.ui.showToast('📱 Abrí la app desde el ícono que quedó en tu pantalla', 'info', 5000);
                }
                return;
            }
            if (!notifOk) {
                if (typeof Notification === 'undefined') {
                    if (VIP.ui && typeof VIP.ui.showToast === 'function') VIP.ui.showToast('Tu navegador no soporta notificaciones.', 'error');
                    return;
                }
                Notification.requestPermission().then((perm) => {
                    if (perm === 'granted' && VIP.ui && typeof VIP.ui.showToast === 'function') {
                        VIP.ui.showToast('✅ Notificaciones activadas. Tocá RECLAMAR.', 'success');
                    }
                    renderHero();
                }).catch(() => {});
                return;
            }
            // Todos los pasos hechos: reclamar bono.
            try {
                if (VIP.refunds && typeof VIP.refunds.handleWelcomeBonusClick === 'function') {
                    VIP.refunds.handleWelcomeBonusClick();
                }
            } catch (e) { console.warn('claim error:', e); }
        });
    }

    // Eventos que pueden cambiar el estado.
    window.addEventListener('appinstalled', () => { renderHero(); });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            renderHero();
            maybeAutoPromptNotifs();
        }
    });
    // Cuando la app vuelve a foreground el media query también puede cambiar.
    if (window.matchMedia) {
        try {
            window.matchMedia('(display-mode: standalone)').addEventListener('change', () => renderHero());
        } catch (_) {}
    }

    // Primer render + auto-prompt si corresponde.
    renderHero();
    maybeAutoPromptNotifs();

    // Exponer global para que otros módulos puedan refrescar.
    window.renderInstallHeroCard = renderHero;

    // Handler de la X de cierre.
    window.dismissInstallHero = function dismissInstallHero(e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        try { localStorage.setItem(_heroDismissKey(), '1'); } catch (_) {}
        if (card) card.hidden = true;
    };
})();

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
  VIP.ui.showToast('Tu contraseña es la misma que usás para entrar a Reembolsos', 'info');
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
