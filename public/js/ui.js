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

        // Encuesta de notificaciones: aparece una sola vez para que el
        // usuario elija su grupo (suave / normal / activo / solo reembolsos).
        if (VIP.notifSurvey && typeof VIP.notifSurvey.maybeShow === 'function') {
            VIP.notifSurvey.maybeShow();
        }
        // NOTA: el welcome del publicista NO se muestra acá. Se muestra
        // pre-auth desde app.js al cargar la página si el visitante llegó
        // por una vanity URL / ?p=CODE. Ver public/js/publisherwelcome.js.
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
    }

    function startBalancePolling() {
        if (VIP.state.balanceCheckInterval) {
            clearInterval(VIP.state.balanceCheckInterval);
        }
        // 90s (antes 30s): cada poll es una llamada a JUGAYGANA vía proxy en el
        // server; con cientos de clientes online el poll de 30s saturaba el
        // camino al proveedor (incidente 2026-08-25). Las cargas igual actualizan
        // el saldo AL INSTANTE por socket (balance_updated) — el poll es respaldo.
        // Con la pestaña oculta no se pollea (patrón de la ruleta, #90).
        VIP.state.balanceCheckInterval = setInterval(() => {
            if (!document.hidden) syncBalance();
        }, 90000);
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
            return;
        }

        // La bienvenida ahora la genera el BACKEND como mensaje de sistema
        // (lado admin), no el cliente. Antes se mandaba con el token del
        // usuario vía sendSystemMessage → quedaba registrada con
        // senderRole='user' y aparecía como si la hubiera escrito el propio
        // usuario. El endpoint /api/messages/welcome la crea con
        // senderRole='admin' y tiene su propio throttle de 24h server-side.
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/messages/welcome`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                }
            });
            if (response.ok) {
                // Refrescar el chat para mostrar los mensajes recién creados.
                setTimeout(() => { try { VIP.chat.loadMessages(); } catch (e) {} }, 300);
                localStorage.setItem(welcomeKey, Date.now().toString());
            }
        } catch (error) {
        }
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

    // ---- Regalo por código (#149: lotes con regalo) ----
    function openGiftCodeModal() {
        const r = document.getElementById('giftCodeResult'); if (r) r.innerHTML = '';
        const i = document.getElementById('giftCodeInput'); if (i) i.value = '';
        showModal('giftCodeModal');
        giftCodeShowView('claim');
    }
    // #150: dos vistas separadas — canjear / información (de dónde salen los
    // códigos + Telegram + estado de app y notificaciones con botones para resolverlo).
    function giftCodeShowView(view) {
        const claim = document.getElementById('giftCodeBody');
        const info = document.getElementById('giftInfoBody');
        const tC = document.getElementById('giftTabClaim');
        const tI = document.getElementById('giftTabInfo');
        const on = (btn, color) => { if (!btn) return; btn.style.background = color + '33'; btn.style.opacity = '1'; };
        const off = (btn) => { if (!btn) return; btn.style.background = 'transparent'; btn.style.opacity = '.6'; };
        if (view === 'info') {
            if (claim) claim.classList.add('hidden');
            if (info) info.classList.remove('hidden');
            off(tC); on(tI, '#53bdeb');
            _renderGiftInfo();
        } else {
            if (info) info.classList.add('hidden');
            if (claim) claim.classList.remove('hidden');
            on(tC, '#d4af37'); off(tI);
            setTimeout(() => { const i = document.getElementById('giftCodeInput'); if (i) i.focus(); }, 150);
        }
    }
    async function _renderGiftInfo() {
        // Telegram: misma URL que la tarjeta de comunidad (canal del equipo del cliente).
        const tg = document.getElementById('giftInfoTelegramBtn');
        if (tg) {
            const ch = document.getElementById('communityChannelBtn');
            let url = (ch && ch.href && ch.href !== '#' && !/#$/.test(ch.href)) ? ch.href : '';
            if (!url) {
                try {
                    const resp = await fetch(`${VIP.config.API_URL}/api/config/community`, { headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` } });
                    if (resp.ok) { const d = await resp.json(); url = (d && d.channelUrl) || ''; }
                } catch (_) {}
            }
            if (url) { tg.href = url; tg.style.display = 'flex'; } else { tg.style.display = 'none'; }
        }
        // Estado real: app instalada (standalone) y permiso de notificaciones.
        const okChip = '<span style="color:#25d366;">✅ Sí</span>';
        const appOk = isAppStandalone();
        const notifOk = ('Notification' in window) && Notification.permission === 'granted';
        const appEl = document.getElementById('giftInfoAppState');
        const notEl = document.getElementById('giftInfoNotifState');
        if (appEl) appEl.innerHTML = appOk ? okChip :
            '<button onclick="VIP.ui.installApp()" style="background:rgba(255,80,80,.15);color:#ffb3b3;border:1px solid rgba(255,80,80,.45);border-radius:8px;padding:5px 10px;font-weight:900;font-size:12px;cursor:pointer;">❌ No — Instalar</button>';
        if (notEl) notEl.innerHTML = notifOk ? okChip :
            '<button onclick="VIP.ui.giftInfoEnableNotifs()" style="background:rgba(255,80,80,.15);color:#ffb3b3;border:1px solid rgba(255,80,80,.45);border-radius:8px;padding:5px 10px;font-weight:900;font-size:12px;cursor:pointer;">❌ No — Activar</button>';
    }
    function giftInfoEnableNotifs() {
        // Reusa el flujo del 🔔 de la barra (pide permiso + registra el token FCM).
        const bell = document.getElementById('notificationBtn');
        if (bell) bell.click();
        else if (VIP.notifications && VIP.notifications.requestNotificationPermission) VIP.notifications.requestNotificationPermission();
        setTimeout(_renderGiftInfo, 2500);
    }
    async function claimGiftCode() {
        const input = document.getElementById('giftCodeInput');
        const out = document.getElementById('giftCodeResult');
        const btn = document.getElementById('giftCodeBtnSend');
        const code = ((input && input.value) || '').trim().toUpperCase();
        if (!code) { if (out) out.innerHTML = '<span style="color:#ffaa44;">Escribí el código.</span>'; return; }
        if (btn) btn.disabled = true;
        if (out) out.innerHTML = '<span style="color:#aaa;">Verificando…</span>';
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/gift-code/claim`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${VIP.state.currentToken}` },
                body: JSON.stringify({ code })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.success) {
                if (out) out.innerHTML = '<div style="background:rgba(255,80,80,.12);border:1px solid rgba(255,80,80,.4);border-radius:10px;padding:10px;color:#ffb3b3;">' + escapeHtml(data.error || 'No se pudo canjear el código.') + '</div>';
                return;
            }
            const ok = data.status === 'credited'
                ? '💰 ¡Listo! Tu regalo ya está <strong>acreditado en tu cuenta</strong>.'
                : '🎁 ¡Código válido! ' + escapeHtml(data.message || 'Tu bono quedó activado.');
            if (out) out.innerHTML = '<div style="background:rgba(37,211,102,.12);border:1px solid rgba(37,211,102,.45);border-radius:10px;padding:10px;color:#9ff5c0;">' + ok + '</div>';
            if (input) input.value = '';
            if (data.status === 'credited') { try { if (typeof loadBalance === 'function') loadBalance(); } catch (_) {} }
            try { if (VIP.chat && VIP.chat.loadMessages) VIP.chat.loadMessages(); } catch (_) {}
        } catch (e) {
            if (out) out.innerHTML = '<span style="color:#ffb3b3;">Error de conexión. Probá de nuevo.</span>';
        } finally {
            if (btn) btn.disabled = false;
        }
    }
    function escapeHtml(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    // ---- Referrals (#168: tablero vivo, premios por cantidad, popup y card del home) ----
    function _esc(v) { const d = document.createElement('div'); d.textContent = String(v == null ? '' : v); return d.innerHTML; }
    let _refData = null;
    let _refLoadedAt = 0;
    const _refMoney = (n) => '$' + new Intl.NumberFormat('es-AR').format(Math.round(Number(n) || 0));
    function _refPct(rate) { return (Math.round((Number(rate) || 0.07) * 1000) / 10) + '%'; }
    function _refAgo(d) {
        if (!d) return '';
        const ms = Date.now() - new Date(d).getTime();
        const dias = Math.floor(ms / 86400000);
        if (dias <= 0) return 'hoy';
        if (dias === 1) return 'hace 1 día';
        if (dias < 30) return 'hace ' + dias + ' días';
        const m = Math.floor(dias / 30);
        return m === 1 ? 'hace 1 mes' : 'hace ' + m + ' meses';
    }

    async function fetchReferralDashboard(force) {
        if (!force && _refData && Date.now() - _refLoadedAt < 60000) return _refData;
        const r = await fetch(`${VIP.config.API_URL}/api/referrals/dashboard`, { headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` } });
        if (!r.ok) throw new Error('dashboard ' + r.status);
        const d = await r.json();
        _refData = d; _refLoadedAt = Date.now();
        VIP.state.referralData = d;
        document.querySelectorAll('.referralRatePct').forEach(el => { el.textContent = _refPct(d.rate); });
        return d;
    }

    async function openReferralModal() {
        showModal('referralModal');
        await loadReferralData(true);
    }

    async function loadReferralData(force) {
        const c = document.getElementById('referralContent');
        if (c && !_refData) c.innerHTML = '<span style="color:#888;font-size:12px;">Cargando tus referidos…</span>';
        try {
            const d = await fetchReferralDashboard(force);
            renderReferralModal(d);
            renderReferralHomeCard(d);
        } catch (err) {
            console.error('[Referrals] Error cargando datos:', err);
            if (c) c.innerHTML = '<span style="color:#ff4444;font-size:12px;">No se pudieron cargar tus datos de referidos. Reintentá.</span>';
        }
    }

    function _refTierHtml(t, ms) {
        const on = t.unlocked;
        const claimed = t.claimed && t.claimStatus !== 'failed';
        let foot;
        if (claimed) foot = '<span class="ref-pill" style="background:rgba(0,255,136,.15);color:#00ff88;border:1px solid rgba(0,255,136,.5);">✅ Cobrado</span>';
        else if (t.claimable) foot = '<button onclick="VIP.ui.claimReferralMilestone(' + t.count + ')" style="background:linear-gradient(135deg,#ffd700,#f7931e);color:#000;border:none;border-radius:8px;padding:6px 10px;font-weight:900;font-size:10.5px;cursor:pointer;">🎁 Cobrar ahora</button>';
        else if (on) foot = '<span class="ref-pill" style="background:rgba(255,215,0,.12);color:#ffd700;border:1px solid rgba(255,215,0,.5);">🔓 Desbloqueado · se cobra desde el día ' + ms.payDay + '</span>';
        else foot = '<span class="ref-pill" style="background:rgba(255,255,255,.06);color:#999;border:1px solid rgba(255,255,255,.15);">🔒 Por alcanzar</span>';
        return '<div style="flex:1;min-width:96px;text-align:center;padding:9px 6px;border-radius:10px;background:' + (on ? 'rgba(255,215,0,.08)' : 'rgba(255,255,255,.03)') + ';border:1px solid ' + (on ? 'rgba(255,215,0,.55)' : 'rgba(255,255,255,.12)') + ';">' +
            '<div style="font-size:24px;line-height:1;">' + (claimed ? '🏆' : (on ? '🎁' : '🎁')) + '</div>' +
            '<div style="font-size:11px;font-weight:900;color:#fff;margin-top:4px;">' + t.count + ' REFERIDOS</div>' +
            '<div style="font-size:15px;font-weight:900;color:#ffd700;">' + _refMoney(t.amountARS) + '</div>' +
            '<div style="font-size:9.5px;color:#aaa;margin-bottom:6px;">extra</div>' + foot + '</div>';
    }

    function renderReferralModal(d) {
        const c = document.getElementById('referralContent');
        if (!c || !d) return;
        const t = d.totals || {}, ms = d.milestones || {}, per = d.period || {};
        const pct = _refPct(d.rate);
        const tiers = ms.tiers || [];
        const maxCount = ms.maxCount || (tiers.length ? tiers[tiers.length - 1].count : 10);
        const prog = Math.min(100, Math.round((ms.qualified || 0) / Math.max(1, maxCount) * 100));
        const netInfoId = 'refNetInfo';
        let html = '';
        // Link (solo el link: más directo que el código)
        html += '<div style="background:rgba(255,255,255,.05);border:1px solid #d4af37;border-radius:12px;padding:12px;margin-bottom:12px;">' +
            '<span style="color:#b0b0b0;font-size:10.5px;text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:5px;">Tu link de referido</span>' +
            '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
            '<span id="myReferralLink" style="font-size:12px;color:#00ff88;word-break:break-all;flex:1;min-width:0;">' + _esc(d.referralLink || '—') + '</span>' +
            '<button onclick="VIP.ui.copyReferralLink()" style="background:rgba(0,255,136,.1);border:1px solid #00ff88;color:#00ff88;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">📋 Copiar</button>' +
            '</div>' +
            '<button onclick="VIP.ui.shareReferralLink()" style="width:100%;margin-top:9px;background:linear-gradient(135deg,#ffd700,#f7931e);color:#000;border:none;border-radius:10px;padding:10px;font-weight:900;font-size:13px;cursor:pointer;">🔗 INVITAR A TUS AMIGOS</button>' +
            '<div style="font-size:10px;color:#888;margin-top:6px;text-align:center;">Tu amigo entra por el link, se registra y queda vinculado a vos para siempre. Código: <b style="color:#d4af37;letter-spacing:1px;">' + _esc(d.referralCode || '') + '</b></div>' +
            '</div>';
        // Tiles
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">' +
            '<div class="ref-modal-tile" style="border-color:rgba(0,255,136,.35);"><span class="v" style="color:#00ff88;">👥 ' + (t.active || 0) + '</span><span class="l">Referidos activos<br><span style="color:#777;">(los que cargaron)</span></span></div>' +
            '<div class="ref-modal-tile" style="border-color:rgba(255,215,0,.45);"><span class="v" style="color:#ffd700;">💰 ' + _refMoney(t.commissionMonth) + '</span><span class="l">Tu comisión acumulada<br><span style="color:#777;">(' + pct + ' de la pérdida neta de este mes)</span></span></div>' +
            '<div class="ref-modal-tile" style="border-color:rgba(255,80,80,.4);cursor:pointer;" onclick="VIP.ui.toggleReferralNetLossInfo()"><span class="v" style="color:#ff6b6b;">📉 ' + _refMoney(t.netLossMonth) + '</span><span class="l">Pérdida neta de tus referidos<br><span style="color:#ff9a9a;">ℹ️ tocá: es un monto variable</span></span></div>' +
            '<div class="ref-modal-tile" style="border-color:rgba(0,170,255,.4);"><span class="v" style="color:#4fc3ff;">📊 ' + _refMoney(t.totalCharged) + '</span><span class="l">Total cargado por<br>tus referidos</span></div>' +
            '</div>';
        html += '<div id="' + netInfoId + '" style="display:none;background:rgba(255,80,80,.08);border:1px solid rgba(255,80,80,.4);border-radius:10px;padding:10px;margin-bottom:10px;font-size:11.5px;line-height:1.55;color:#eee;">' +
            '<b style="color:#ff9a9a;">¿Por qué cambia este número?</b> La pérdida neta es lo que tus referidos apostaron menos lo que ganaron, sumado en el mes. Si un referido gana, su pérdida neta BAJA (y tu comisión también); si pierde, SUBE. Por eso puede subir o bajar día a día. Lo que cobrás se calcula con el número final del mes, el primer día hábil del mes siguiente.' +
            (t.netwinPartial ? '<br><span style="color:#ffb347;">⚠️ Ahora mismo no pudimos leer la actividad de algún referido (la plataforma está demorada): el total puede estar incompleto por unos minutos.</span>' : '') + '</div>';
        html += '<div style="background:rgba(255,255,255,.03);border-radius:10px;padding:9px 11px;margin-bottom:12px;font-size:11.5px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
            '<span style="color:#b0b0b0;">Período actual: <b style="color:#fff;">' + _esc(per.label || per.key || '—') + '</b></span>' +
            '<span style="color:#b0b0b0;">Próxima acreditación: <b style="color:#fff;">' + _esc(per.nextCredit || '—') + '</b></span></div>';
        // Tabla de referidos
        const rows = d.referrals || [];
        html += '<div style="background:rgba(255,255,255,.03);border:1px solid rgba(212,175,55,.35);border-radius:12px;padding:10px;margin-bottom:12px;">' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><span style="font-size:13px;font-weight:900;color:#ffd700;">👥 MIS REFERIDOS (' + rows.length + ')</span></div>';
        if (!rows.length) {
            html += '<div style="color:#888;font-size:12px;padding:8px 0;">Todavía no tenés referidos. Compartí tu link y empezá a cobrar.</div>';
        } else {
            html += '<div style="overflow-x:auto;"><table class="ref-table"><thead><tr><th>Usuario</th><th>Estado</th><th style="text-align:right;">Cargado</th><th style="text-align:right;">Pérdida neta</th><th style="text-align:right;">Tu ' + pct + '</th></tr></thead><tbody>';
            rows.forEach(r => {
                const st = r.active ? '<span class="ref-pill" style="background:rgba(0,255,136,.15);color:#00ff88;">Activo</span>' : '<span class="ref-pill" style="background:rgba(255,80,80,.15);color:#ff8080;">Sin carga</span>';
                const net = r.netLossMonth === null ? '<span style="color:#777;">…</span>' : _refMoney(Math.max(0, r.netLossMonth));
                const com = r.commissionMonth === null ? '<span style="color:#777;">…</span>' : '<b style="color:#00ff88;">' + _refMoney(r.commissionMonth) + '</b>';
                html += '<tr><td><b style="color:#fff;">' + _esc(r.username) + '</b><br><span style="color:#888;font-size:9.5px;">Se registró ' + _refAgo(r.registeredAt) + (r.qualified ? ' · ✔ cuenta para premios' : '') + '</span></td>' +
                    '<td>' + st + '</td><td style="text-align:right;">' + _refMoney(r.totalCharged) + '</td><td style="text-align:right;color:#ff9a9a;">' + net + '</td><td style="text-align:right;">' + com + '</td></tr>';
            });
            html += '</tbody></table></div>';
        }
        html += '</div>';
        // Progreso / premios
        if (ms.enabled !== false && tiers.length) {
            html += '<div style="background:linear-gradient(135deg,#2d0052,#1a0033);border:1.5px solid #ffd700;border-radius:12px;padding:12px;margin-bottom:12px;">' +
                '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;"><span style="font-size:13px;font-weight:900;color:#ffd700;">🎁 PROGRESO DE TUS REFERIDOS</span><span style="font-size:12px;color:#fff;font-weight:900;">' + (ms.qualified || 0) + ' / ' + maxCount + ' <span style="font-size:9.5px;color:#aaa;font-weight:400;">referidos que cargaron</span></span></div>' +
                '<div style="font-size:10.5px;color:#bbb;margin:2px 0 6px;">Invitá más amigos y desbloqueá premios EXTRA (aparte de tu ' + pct + '). Cuenta cada referido que cargó al menos <b style="color:#fff;">' + _refMoney(ms.minChargedARS) + '</b>. Cada premio se cobra una sola vez, en fichas, sin condiciones' + (ms.payDay > 0 ? ', a partir del día <b style="color:#fff;">' + ms.payDay + '</b> de cada mes' : '') + '.</div>' +
                '<div class="dash-ref-bar" style="height:11px;"><div class="dash-ref-fill" style="width:' + prog + '%;"></div></div>' +
                '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">' + tiers.map(x => _refTierHtml(x, ms)).join('') + '</div>' +
                (t.historicalMilestones > 0 ? '<div style="font-size:10.5px;color:#00ff88;margin-top:8px;text-align:center;">Ya cobraste ' + _refMoney(t.historicalMilestones) + ' en premios por referidos 🏆</div>' : '') +
                '</div>';
        }
        html += '<div style="font-size:10.5px;color:#888;text-align:center;line-height:1.5;">Total cobrado en comisiones: <b style="color:#d4af37;">' + _refMoney(t.historicalCommission) + '</b>. La comisión del mes se calcula sobre la pérdida neta final y se acredita sola el primer día hábil del mes siguiente. Sin límite de referidos ni de ganancia.</div>';
        c.innerHTML = html;
    }

    function toggleReferralNetLossInfo() {
        const el = document.getElementById('refNetInfo');
        if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
    }

    // Card del home: progreso hacia el próximo premio + INVITAR AHORA.
    function renderReferralHomeCard(d) {
        const c = document.getElementById('referralHomeCard');
        if (!c) return;
        if (!d) { c.style.display = 'none'; return; }
        const ms = d.milestones || {}, tiers = ms.tiers || [];
        const maxCount = ms.maxCount || (tiers.length ? tiers[tiers.length - 1].count : 10);
        const prog = Math.min(100, Math.round((ms.qualified || 0) / Math.max(1, maxCount) * 100));
        const steps = tiers.slice(0, 4).map(t => '<div class="dash-ref-step' + (t.unlocked ? ' on' : '') + '"><b>' + (t.claimed ? '🏆' : (t.unlocked ? '🎁' : '🎁')) + '</b>' + t.count + ' amigos<br>' + _refMoney(t.amountARS) + '</div>').join('');
        const claimable = tiers.find(t => t.claimable);
        c.innerHTML = '<div class="dash-ref">' +
            '<div class="dash-ref-head"><span style="font-size:18px;">👥</span><span class="dash-ref-title">INVITÁ A TUS AMIGOS · cobrá el ' + _refPct(d.rate) + '</span><button class="dash-ref-cta" onclick="VIP.ui.openReferralModal()">VER PREMIOS ›</button></div>' +
            (ms.enabled !== false && tiers.length ? ('<div class="dash-ref-bar"><div class="dash-ref-fill" style="width:' + prog + '%;"></div></div>' +
            '<div style="display:flex;justify-content:space-between;font-size:9.5px;color:#bbb;margin-bottom:4px;"><span>' + (ms.qualified || 0) + ' / ' + maxCount + ' referidos que cargaron</span><span style="color:#ffd700;">' + (claimable ? '🎁 ¡Tenés un premio para cobrar!' : (ms.nextTier ? 'Te faltan ' + Math.max(0, ms.nextTier.count - (ms.qualified || 0)) + ' para ' + _refMoney(ms.nextTier.amountARS) : '¡Máximo alcanzado!')) + '</span></div>' +
            '<div class="dash-ref-steps">' + steps + '</div>') : '') +
            '<button class="dash-ref-invite" onclick="VIP.ui.shareReferralLink()">🔗 INVITAR AHORA</button>' +
            '</div>';
        c.style.display = '';
        try { adjustLayout(); } catch (_) {}
    }
    async function loadReferralHomeCard() {
        if (!VIP.state || !VIP.state.currentToken) return;
        const u = VIP.state.currentUser;
        if (u && u.role && u.role !== 'user') return;
        try { renderReferralHomeCard(await fetchReferralDashboard(false)); } catch (_) {}
    }

    // Popup promocional: una vez por apertura de la app (sessionStorage), solo clientes.
    // Si hay otro modal abierto (cambio de clave, bienvenida, instalación…) espera a que se
    // cierre (reintenta hasta ~2 min) y recién ahí marca "mostrado".
    let _refPromoTimer = null;
    const REF_PROMO_COOLDOWN_MS = 30 * 60 * 1000; // "cada vez que abren la app": si pasaron 30 min, otra vez
    function maybeShowReferralPromo() {
        const u = VIP.state.currentUser;
        if (!u || (u.role && u.role !== 'user')) { console.info('[ref-promo] no se muestra: cuenta de staff o usuario no cargado'); return; }
        // localStorage con cooldown (no sessionStorage: iOS/Chrome restauran la pestaña y el
        // "una vez por apertura" no se disparaba nunca más). ?refpromo=1 fuerza mostrarlo.
        const force = /[?&]refpromo=1/.test(location.search || '');
        try {
            const last = Number(localStorage.getItem('vip_refPromoAt') || 0);
            if (!force && last && Date.now() - last < REF_PROMO_COOLDOWN_MS) { console.info('[ref-promo] ya mostrado hace ' + Math.round((Date.now() - last) / 60000) + ' min'); return; }
        } catch (_) {}
        if (_refPromoTimer) return;
        let tries = 0;
        const attempt = async () => {
            _refPromoTimer = null;
            tries++;
            const cur = VIP.state.currentUser;
            if (!cur || !VIP.state.currentToken) return;
            if (cur.mustChangePassword === true || VIP.state.passwordChangePending) { if (tries < 24) _refPromoTimer = setTimeout(attempt, 5000); return; }
            const open = Array.from(document.querySelectorAll('.modal')).find(m => !m.classList.contains('hidden') && m.id !== 'referralPromoModal');
            if (open) { console.info('[ref-promo] espera: modal abierto ' + open.id); if (tries < 24) _refPromoTimer = setTimeout(attempt, 5000); return; }
            try {
                const d = await fetchReferralDashboard(false);
                const ex = document.getElementById('referralPromoExtra');
                const ms = d.milestones || {};
                if (ex && ms.enabled !== false && ms.tiers && ms.tiers.length) ex.textContent = '+ premios extra: ' + ms.tiers.map(t => t.count + ' amigos = ' + _refMoney(t.amountARS)).join(' · ');
            } catch (_) {}
            try { localStorage.setItem('vip_refPromoAt', String(Date.now())); } catch (_) {}
            console.info('[ref-promo] mostrando');
            showModal('referralPromoModal');
        };
        _refPromoTimer = setTimeout(attempt, 1800);
    }

    async function shareReferralLink() {
        let link = (_refData && _refData.referralLink) || null;
        if (!link) { try { link = (await fetchReferralDashboard(false)).referralLink; } catch (_) {} }
        if (!link) { showToast('No pudimos generar tu link. Probá de nuevo.', 'error'); return; }
        const pct = _refPct(_refData && _refData.rate);
        const text = '🎰 Sumate a la sala con mi link y jugá con reembolsos todos los días. Yo cobro el ' + pct + ' de tu actividad, vos jugás igual 😉\n' + link;
        if (navigator.share) {
            try { await navigator.share({ title: 'Invitación', text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
        }
        try { await navigator.clipboard.writeText(text); showToast('✅ Link copiado. Pegalo en WhatsApp o Telegram.', 'success'); }
        catch (_) { fallbackCopy(link); }
    }
    function copyReferralLink() {
        const link = (_refData && _refData.referralLink) || (document.getElementById('myReferralLink') || {}).textContent || '';
        if (link && link !== '—') navigator.clipboard.writeText(link).then(() => showToast('✅ Link copiado', 'success')).catch(() => fallbackCopy(link));
    }
    function copyReferralCode() { copyReferralLink(); } // legacy: el código ya no se muestra suelto

    async function claimReferralMilestone(count) {
        try {
            const r = await fetch(`${VIP.config.API_URL}/api/referrals/milestones/claim`, {
                method: 'POST', headers: { 'Authorization': `Bearer ${VIP.state.currentToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ count })
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) { showToast(d.error || 'No se pudo cobrar el premio', d.verify ? 'info' : 'error'); await loadReferralData(true); return; }
            showToast('🏆 ¡Cobraste ' + _refMoney(d.amountARS) + ' por tus ' + d.count + ' referidos! Ya está en tu saldo.', 'success');
            try { if (VIP.ui && VIP.ui.syncBalance) VIP.ui.syncBalance(); } catch (_) {}
            await loadReferralData(true);
        } catch (_) { showToast('Error de conexión', 'error'); }
    }

    // ---- Canal informativo (delegated from chat module) ----

    function loadCanalInformativoUrl() {
        return VIP.chat.loadCanalInformativoUrl();
    }

    // ---- Canales de Telegram del dashboard (canal + soporte) ----
    // Las URLs salen de la DB (Config `communityConfig`), editables en el panel
    // → COMANDOS. Antes esto vivía como script inline en index.html con un
    // polling de 1 s × 25 esperando el token: si el login tardaba más, el bloque
    // no aparecía nunca. Ahora se llama desde initializeSession, cuando la
    // sesión YA está lista.
    async function loadCommunityLinks() {
        const sec = document.getElementById('communitySection');
        const ch  = document.getElementById('communityChannelBtn');
        const sup = document.getElementById('communitySupportBtn');
        if (!sec) return;
        try {
            const resp = await fetch(`${VIP.config.API_URL}/api/config/community`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (!resp.ok) return;
            const d = await resp.json();
            let any = false;
            // Cada tarjeta se muestra sólo si su URL está cargada; si no hay
            // ninguna, la sección entera queda oculta (no deja huecos raros).
            if (ch) {
                if (d && d.channelUrl) { ch.href = d.channelUrl; ch.style.display = ''; any = true; }
                else { ch.style.display = 'none'; }
            }
            if (sup) {
                if (d && d.supportUrl) { sup.href = d.supportUrl; sup.style.display = ''; any = true; }
                else { sup.style.display = 'none'; }
            }
            sec.style.display = any ? '' : 'none';
        } catch (e) {
            // Sin conexión: dejamos la sección como está (oculta por defecto).
        }
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

    // Traspaso de sesión a la PWA instalada (problema exclusivo de iOS).
    //
    // En Android la app instalada comparte `localStorage` con el navegador y
    // arranca ya logueada. En iOS la web app de la pantalla de inicio corre en
    // su PROPIO contenedor de almacenamiento: no hereda la sesión de Safari y
    // abre pidiendo login.
    //
    // Antes de que el usuario agregue la app a inicio le pedimos al backend un
    // token de un solo uso y lo dejamos en el `start_url` del manifest. iOS
    // congela ese start_url dentro del acceso directo, así que al abrir la app
    // por primera vez se canjea (VIP.auth.consumeAutologinFromUrl) y la sesión
    // queda armada ADENTRO del contenedor de la app.
    //
    // Best-effort: si algo falla, la instalación sigue igual y el usuario
    // simplemente tendrá que loguearse una vez (el comportamiento de hoy).
    async function primePwaSessionHandoff() {
        if (!VIP.state.currentToken) return false; // sin sesión no hay nada que traspasar
        const link = document.querySelector('link[rel="manifest"]');
        if (!link) return false;
        try {
            const resp = await fetch(`${VIP.config.API_URL}/api/auth/pwa-session-token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                }
            });
            if (!resp.ok) return false;
            const data = await resp.json();
            if (!data || !data.token) return false;
            // Cambiar el href hace que el navegador vuelva a leer el manifest;
            // el server responde el mismo JSON pero con start_url personalizado.
            link.setAttribute('href', '/manifest.json?al=' + encodeURIComponent(data.token));
            return true;
        } catch (e) {
            return false;
        }
    }

    function showInstallInstructions(platform) {
        // Se dispara acá porque es donde el usuario YA mostró intención de
        // instalar: pedirlo antes generaría tokens para gente que sólo ve el
        // botón. No se espera (`await`) a propósito: el usuario todavía tiene
        // que abrir el menú Compartir, que da tiempo de sobra.
        if (platform === 'ios') primePwaSessionHandoff();

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
        openGiftCodeModal,
        claimGiftCode,
        giftCodeShowView,
        giftInfoEnableNotifs,
        loadReferralData,
        copyReferralCode,
        copyReferralLink,
        loadReferralHomeCard,
        maybeShowReferralPromo,
        shareReferralLink,
        claimReferralMilestone,
        toggleReferralNetLossInfo,
        fetchReferralDashboard,
        loadCanalInformativoUrl,
        loadCommunityLinks,
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
        return;
    }
    window.deferredPrompt = e;
    const loginInstallBtn  = document.getElementById('installBtn');
    const headerInstallBtn = document.getElementById('headerInstallBtn');
    const appInstallBtn    = document.getElementById('appInstallBtn');
    if (loginInstallBtn)  { loginInstallBtn.style.display = 'flex'; loginInstallBtn.classList.remove('hidden'); }
    if (headerInstallBtn) { headerInstallBtn.style.display = 'flex'; headerInstallBtn.classList.remove('hidden'); }
    if (appInstallBtn)    { appInstallBtn.style.display = 'flex'; appInstallBtn.classList.add('show'); }
});

window.addEventListener('appinstalled', () => {
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
  // Preparar y abrir el modal de cambio de contraseña
  if (typeof VIP.auth.prepareChangePasswordModal === 'function') {
    VIP.auth.prepareChangePasswordModal();
  } else if (typeof window.prepareChangePasswordModal === 'function') {
    window.prepareChangePasswordModal();
  }
  const modal = document.getElementById('changePasswordModal');
  if (modal) modal.classList.remove('hidden');
};
