// ========================================
// AUTH - Authentication module
// ========================================

window.VIP = window.VIP || {};

VIP.auth = (function () {

    function escapeHtml(text) {
        if (!text && text !== 0) return '';
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    }

    async function checkUsernameAvailability(username) {
        const resultSpan = document.getElementById('usernameCheckResult');
        try {
            const response = await fetch(
                `${VIP.config.API_URL}/api/auth/check-username?username=${encodeURIComponent(username)}`
            );
            const data = await response.json();
            if (data.available) {
                resultSpan.textContent = '✅ Usuario disponible';
                resultSpan.style.color = '#00ff88';
            } else {
                resultSpan.textContent = '❌ ' + (data.message || 'Usuario no disponible');
                resultSpan.style.color = '#ff4444';
            }
        } catch (error) {
            resultSpan.textContent = '';
        }
    }

    // Estado temporal del registro OTP (compartido con app.js global via window)
    let _vipRegisterOtpPhone = null;

    async function handleRegister(e) {
        if (e) e.preventDefault();
        // El registro ahora usa flujo OTP: handleRegisterSendOtp y handleRegisterWithOtp
        // Esta función se mantiene por compatibilidad
    }

    async function handleRegisterSendOtp() {
        const username = document.getElementById('registerUsername').value.trim();
        const password = document.getElementById('registerPassword').value;
        const passwordConfirm = document.getElementById('registerPasswordConfirm').value;
        const phonePrefix = document.getElementById('registerPhonePrefix').value;
        const phoneNumber = document.getElementById('registerPhone').value.trim();
        const errorDiv = document.getElementById('registerError');

        errorDiv.classList.remove('show');

        if (password !== passwordConfirm) {
            errorDiv.textContent = 'Las contraseñas no coinciden';
            errorDiv.classList.add('show');
            return;
        }
        if (password.length < 6) {
            errorDiv.textContent = 'La contraseña debe tener al menos 6 caracteres';
            errorDiv.classList.add('show');
            return;
        }
        if (username.length < 3) {
            errorDiv.textContent = 'El usuario debe tener al menos 3 caracteres';
            errorDiv.classList.add('show');
            return;
        }
        if (!phoneNumber || phoneNumber.replace(/\D/g, '').length < 8) {
            errorDiv.textContent = 'Ingresá un número de teléfono válido (mínimo 8 dígitos)';
            errorDiv.classList.add('show');
            return;
        }

        const fullPhone = phonePrefix + phoneNumber.replace(/[\s\-().]/g, '');
        const btn = document.getElementById('registerSendOtpBtn');
        if (btn) { btn.textContent = 'Enviando...'; btn.disabled = true; }

        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/send-register-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: fullPhone, username })
            });
            const data = await response.json();

            if (response.ok && data.success) {
                _vipRegisterOtpPhone = fullPhone;
                // Sync con variable global si existe (app.js)
                if (typeof window !== 'undefined') window._registerOtpPhone = fullPhone;
                document.getElementById('registerStep1').style.display = 'none';
                document.getElementById('registerStep2').style.display = '';
                document.getElementById('registerOtpMsg').textContent = `✅ ${data.message} (${data.phone})`;
                document.getElementById('registerOtpCode').value = '';
                document.getElementById('registerOtpError').classList.remove('show');
                // Meta Pixel: el user mostro intencion de registrarse (envio
                // OTP). Se cuenta como Lead — usado en Meta Ads para
                // optimizar la pauta hacia "interesados que entregan datos".
                if (typeof window.metaPixelTrack === 'function') {
                    window.metaPixelTrack('Lead', { content_name: 'register_otp_sent' });
                }
            } else {
                errorDiv.textContent = data.error || 'Error al enviar el código SMS';
                errorDiv.classList.add('show');
            }
        } catch (error) {
            errorDiv.textContent = 'Error de conexión. Intenta más tarde.';
            errorDiv.classList.add('show');
        } finally {
            if (btn) { btn.textContent = '📱 Enviar código SMS'; btn.disabled = false; }
        }
    }

    async function handleRegisterWithOtp() {
        const username = document.getElementById('registerUsername').value.trim();
        const password = document.getElementById('registerPassword').value;
        const email = document.getElementById('registerEmail').value.trim();
        const referralCodeInput = document.getElementById('registerReferralCode');
        const referralCode = referralCodeInput ? referralCodeInput.value.trim().toUpperCase() : null;
        const otpCode = document.getElementById('registerOtpCode').value.trim();
        const errorDiv = document.getElementById('registerOtpError');
        const submitBtn = document.getElementById('registerSubmitBtn');

        errorDiv.classList.remove('show');

        if (!otpCode || otpCode.length < 6) {
            errorDiv.textContent = 'Ingresá el código de 6 dígitos';
            errorDiv.classList.add('show');
            return;
        }

        const phone = _vipRegisterOtpPhone || (typeof window !== 'undefined' ? window._registerOtpPhone : null);
        if (!phone) {
            errorDiv.textContent = 'Error: teléfono no encontrado. Volvé al paso anterior.';
            errorDiv.classList.add('show');
            return;
        }

        if (submitBtn) { submitBtn.textContent = 'Creando cuenta...'; submitBtn.disabled = true; }

        try {
            // Attribution de campaña: si el user vino por un link tipo
            // ?c=promo2k, lo guardamos en localStorage al cargar el home y
            // ahora lo mandamos al backend para atarlo al user. First-touch:
            // si ya hay un valor previo no lo sobreescribimos.
            let campaignCode = null;
            try {
                const stored = localStorage.getItem('campaignCode');
                if (stored && /^[a-z0-9_-]{2,60}$/.test(stored)) campaignCode = stored;
            } catch (_) {}

            const response = await fetch(`${VIP.config.API_URL}/api/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username,
                    password,
                    email: email || null,
                    phone,
                    referralCode: referralCode || undefined,
                    campaignCode: campaignCode || undefined,
                    otpCode
                })
            });
            const data = await response.json();

            if (response.ok) {
                _vipRegisterOtpPhone = null;
                if (typeof window !== 'undefined') window._registerOtpPhone = null;
                VIP.state.currentToken = data.token;
                VIP.state.currentUser = { ...data.user, id: data.user.id, userId: data.user.id };
                localStorage.setItem('userToken', VIP.state.currentToken);

                VIP.ui.hideModal('registerModal');
                document.getElementById('registerForm').reset();
                document.getElementById('usernameCheckResult').textContent = '';
                document.getElementById('registerStep1').style.display = '';
                document.getElementById('registerStep2').style.display = 'none';

                await initializeSession(true);
                console.log('[FCM] Registro exitoso, enviando token FCM...');
                await VIP.notifications.sendFcmTokenAfterLogin();
                VIP.ui.showToast('✅ ¡Cuenta creada exitosamente!', 'success');
                // Meta Pixel: conversion principal — creo cuenta. Es el
                // evento que Meta Ads usa para optimizar la pauta a
                // "registros completados". Manda value=0 currency=ARS
                // (la "compra" real es el bono $2k que disparamos despues).
                if (typeof window.metaPixelTrack === 'function') {
                    window.metaPixelTrack('CompleteRegistration', {
                        content_name: 'account_created',
                        currency: 'ARS',
                        value: 0
                    });
                }
            } else {
                errorDiv.textContent = data.error || 'Error al crear cuenta';
                errorDiv.classList.add('show');
            }
        } catch (error) {
            errorDiv.textContent = 'Error de conexión';
            errorDiv.classList.add('show');
        } finally {
            if (submitBtn) { submitBtn.textContent = '📝 Crear Cuenta'; submitBtn.disabled = false; }
        }
    }

    // Refunds-only login: solo username, sin contraseña.
    // ID propio del dispositivo, guardado en el navegador. Identifica esta
    // instalación para detectar multi-cuenta sin depender de la IP.
    function _getDeviceId() {
        try {
            var id = localStorage.getItem('vip_device_id');
            if (!id) {
                id = (window.crypto && crypto.randomUUID)
                    ? crypto.randomUUID()
                    : ('dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14));
                localStorage.setItem('vip_device_id', id);
            }
            return id;
        } catch (_) { return null; }
    }

    // Aviso en el login: si en este dispositivo ya se inició con un
    // usuario, lo muestra y precarga ese usuario en el campo.
    function _showDeviceLoginNotice() {
        try {
            var u = localStorage.getItem('vip_device_username');
            if (!u) return;
            var notice = document.getElementById('deviceLoginNotice');
            var span = document.getElementById('deviceLoginNoticeUser');
            var input = document.getElementById('username');
            if (span) span.textContent = u;
            if (notice) notice.style.display = 'block';
            if (input && !input.value) input.value = u;
        } catch (_) {}
    }

    async function handleLogin(e) {
        if (e) e.preventDefault();

        const usernameEl = document.getElementById('username');
        const username = (usernameEl?.value || '').trim();
        const errorDiv = document.getElementById('errorMessage');
        const loginBtn = document.querySelector('#loginForm button[type="submit"]');

        errorDiv.classList.remove('show');

        if (!username) {
            errorDiv.textContent = 'Ingresá tu usuario';
            errorDiv.classList.add('show');
            return;
        }

        if (loginBtn) { loginBtn.textContent = 'Ingresando...'; loginBtn.disabled = true; }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 25000);

            const response = await fetch(`${VIP.config.API_URL}/api/auth/login-username-only`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, deviceId: _getDeviceId() }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            let data = {};
            let rawText = '';
            try {
                rawText = await response.text();
                data = rawText ? JSON.parse(rawText) : {};
            } catch (_) { data = {}; }

            if (response.status === 404) {
                errorDiv.textContent = data.error || 'Usuario no disponible';
                errorDiv.classList.add('show');
                return;
            }
            // Bloqueo VIP: el backend responde 403 con code 'VIP_USER'.
            // Mostramos un overlay grande redirigiendo a VIPCARGAS y NO
            // continuamos con el login.
            if (response.status === 403 && data.code === 'VIP_USER') {
                if (typeof window.showVipBlockOverlay === 'function') {
                    window.showVipBlockOverlay(data);
                } else {
                    errorDiv.textContent = data.message || 'Página no disponible para usuarios VIP — usá VIPCARGAS.';
                    errorDiv.classList.add('show');
                }
                return;
            }
            // Bloqueo por multi-cuenta en el dispositivo: mensaje claro,
            // sin el prefijo "Error 403:".
            if (response.status === 403 && data.code === 'DEVICE_MISMATCH') {
                errorDiv.textContent = data.error || 'Cuenta bloqueada: iniciaste con otro usuario en este dispositivo.';
                errorDiv.classList.add('show');
                return;
            }
            if (!response.ok) {
                const detail = data.error
                    ? data.error
                    : (rawText ? rawText.slice(0, 120) : 'sin respuesta del servidor');
                errorDiv.textContent = `Error ${response.status}: ${detail}`;
                errorDiv.classList.add('show');
                return;
            }

            VIP.state.currentToken = data.token;
            VIP.state.currentUser = { ...data.user, id: data.user.id, userId: data.user.id };
            VIP.state.linePhone = data.linePhone || null;
            localStorage.setItem('userToken', VIP.state.currentToken);
            // Recordar el usuario de este dispositivo (para el aviso del login).
            try { localStorage.setItem('vip_device_username', (data.user && data.user.username) || username); } catch (_) {}

            // Si en el celular hay un FCM token de un user anterior (ej: el
            // dueño cambió de cuenta sin logout), reasignarlo al user
            // actual. El backend además limpia el token de otros users.
            try {
                if (VIP.notifications && typeof VIP.notifications.sendFcmTokenAfterLogin === 'function') {
                    VIP.notifications.sendFcmTokenAfterLogin();
                }
            } catch (_) { /* best-effort */ }

            renderRefundsHomeUI();

            VIP.ui.showChatScreen();
            try { window.renderOwnerLogoutSmallBtn(); } catch (_) {}
            VIP.refunds.loadRefundStatus();
            // Inicializar el sistema de opiniones (carga la review propia +
            // el feed publico al fondo del home).
            try { if (VIP.reviews && typeof VIP.reviews.init === 'function') VIP.reviews.init(); } catch (_) { /* ignore */ }
            // Resolver el nombre del equipo apenas entra. El login solo
            // devuelve linePhone — para el teamName completo (con prioridad
            // User.lineTeamName > UserLineLookup > prefix-config), llamamos
            // a /api/user-lines/me. Sin esto el header arranca vacío y
            // recién aparece tras un visibility-change.
            refreshLinePhone();
        } catch (error) {
            if (error.name === 'AbortError') {
                errorDiv.textContent = 'La conexión tardó demasiado. Intenta nuevamente.';
            } else {
                errorDiv.textContent = 'Error de conexión';
            }
            errorDiv.classList.add('show');
        } finally {
            if (loginBtn) {
                loginBtn.textContent = 'Ingresar';
                loginBtn.disabled = false;
            }
        }
    }

    // Renderiza el bloque "Bienvenido [user]" + "Número principal vigente"
    function renderRefundsHomeUI() {
        const user = VIP.state.currentUser || {};
        // El "Bienvenido <user>" del bloque grande se reemplazo por
        // "Reclama tu reembolso disponible". El username ahora va chico al
        // lado del boton de Salir.
        const welcomeEl = document.getElementById('refundsWelcomeUser');
        if (welcomeEl) welcomeEl.textContent = user.username || '';
        const logoutUserEl = document.getElementById('refundsLogoutUsername');
        if (logoutUserEl) logoutUserEl.textContent = user.username || '';

        const phoneEl = document.getElementById('userLinePhone');
        const phone = VIP.state.linePhone || null;

        const waIcon =
            '<svg viewBox="0 0 24 24" aria-hidden="true">' +
              '<path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>' +
            '</svg>';

        // Icono de Telegram (avioncito de papel). Se usa para el bloque
        // "Unite a la comunidad" — pedido del dueño 2026-05-13, migración
        // de canal de WhatsApp a Telegram. El waIcon de arriba sigue para
        // el botón "QUIERO CARGAR" que sí usa WhatsApp para hablar con el
        // operador de la línea.
        const tgIcon =
            '<svg viewBox="0 0 24 24" aria-hidden="true">' +
              '<path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/>' +
            '</svg>';

        // Siempre se renderiza el boton verde con icono + "QUIERO CARGAR". Si hay
        // numero configurado para el usuario, el href abre WhatsApp; si no, el
        // boton se renderiza sin link funcional pero mantiene el aspecto.
        if (phoneEl) {
            if (phone) {
                const waNumber = phone.replace(/[^\d+]/g, '').replace(/^\+/, '');
                const safePhone = phone
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
                phoneEl.innerHTML =
                    '<a href="https://wa.me/' + waNumber + '" target="_blank" rel="noopener noreferrer" ' +
                      'aria-label="Abrir WhatsApp con el número ' + safePhone + '">' +
                        waIcon +
                        '<span>CARGUE AQUÍ</span>' +
                    '</a>';
            } else {
                phoneEl.innerHTML =
                    '<a href="javascript:void(0)" role="button" aria-disabled="true" ' +
                      'aria-label="Linea de WhatsApp no configurada">' +
                        waIcon +
                        '<span>CARGUE AQUÍ</span>' +
                    '</a>';
            }
        }

        // Bloque "Unite a la comunidad". Mismo patron: si hay link, abre el link
        // (presumiblemente un wa.me/chat o link de comunidad WhatsApp); si no,
        // se renderiza el boton sin destino para mantener el aspecto.
        const communityEl = document.getElementById('userCommunityLink');
        const communityLink = VIP.state.communityLink || null;
        const communityLink2 = VIP.state.communityLink2 || null;
        const communityLabel = VIP.state.communityLabel || '';
        const communityLabel2 = VIP.state.communityLabel2 || '';
        // Si el equipo está excluido del sistema de códigos, sigue con
        // la presentación clásica de WhatsApp — ícono wa + label "Canal
        // de WhatsApp" — sin la migración a Telegram.
        const useWa = !!VIP.state.excludedFromCodes;
        const icon = useWa ? waIcon : tgIcon;
        const defaultLbl1 = useWa ? 'Canal de WhatsApp oficial' : 'Canal Telegram oficial';
        const defaultLbl2 = useWa ? 'Canal de WhatsApp oficial 2' : 'Canal Telegram oficial 2';
        const defaultLblTxt = useWa ? 'CANAL WHATSAPP' : 'CANAL TELEGRAM';
        const escAttr = (s) => String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        if (communityEl) {
            if (communityLink && communityLink2) {
                const safeLink = escAttr(communityLink);
                const safeLink2 = escAttr(communityLink2);
                const lbl1 = (communityLabel || defaultLbl1).toUpperCase();
                const lbl2 = (communityLabel2 || defaultLbl2).toUpperCase();
                communityEl.innerHTML =
                    '<a href="' + safeLink + '" target="_blank" rel="noopener noreferrer" ' +
                      'onclick="window.VIP&&VIP.communityClick&&VIP.communityClick(\'home_button\',\'' + safeLink + '\')" ' +
                      'aria-label="Abrir ' + escAttr(lbl1) + '">' +
                        icon +
                        '<span>' + escAttr(lbl1) + '</span>' +
                    '</a>' +
                    '<a href="' + safeLink2 + '" target="_blank" rel="noopener noreferrer" ' +
                      'onclick="window.VIP&&VIP.communityClick&&VIP.communityClick(\'home_button_2\',\'' + safeLink2 + '\')" ' +
                      'aria-label="Abrir ' + escAttr(lbl2) + '" ' +
                      'style="margin-top:6px;">' +
                        icon +
                        '<span>' + escAttr(lbl2) + '</span>' +
                    '</a>';
            } else if (communityLink) {
                const safeLink = escAttr(communityLink);
                const lblTxt = communityLabel ? communityLabel.toUpperCase() : defaultLblTxt;
                communityEl.innerHTML =
                    '<a href="' + safeLink + '" target="_blank" rel="noopener noreferrer" ' +
                      'onclick="window.VIP&&VIP.communityClick&&VIP.communityClick(\'home_button\',\'' + safeLink + '\')" ' +
                      'aria-label="Abrir ' + (useWa ? 'canal de WhatsApp' : 'canal de Telegram') + '">' +
                        icon +
                        '<span>' + escAttr(lblTxt) + '</span>' +
                    '</a>';
            } else {
                communityEl.innerHTML =
                    '<a href="javascript:void(0)" role="button" aria-disabled="true" ' +
                      'aria-label="' + (useWa ? 'Canal de WhatsApp' : 'Canal de Telegram') + ' no configurado">' +
                        icon +
                        '<span>' + defaultLblTxt + '</span>' +
                    '</a>';
            }
        }

        // Pintar el card del bono de bienvenida de inmediato (con texto por
        // defecto), asi el boton queda atado antes de que loadRefundStatus
        // termine el fetch del estado real.
        try {
            if (VIP.refunds && typeof VIP.refunds.renderWelcomeBonusCard === 'function') {
                VIP.refunds.renderWelcomeBonusCard();
            }
        } catch (_) { /* ignore */ }

        // Chequear si hay promo activa: si la hay, el card #userLinePhone
        // pasa a mostrar el cartel de RECLAMÁ con codigo y contador en vez
        // del boton QUIERO CARGAR.
        try { applyPromoAlertIfActive(); } catch (_) { /* ignore */ }
    }

    // ===== Promo temporal en boton QUIERO CARGAR =====
    let _promoTimerId = null;
    let _promoCountdownId = null;
    let _promoRefetchId = null;

    // Defensa-en-profundidad: trackeamos en localStorage que promos
    // ya tocó este user. Una vez tocada, no se vuelve a mostrar aunque
    // siga activa server-side. Clave por username + promo.id.
    function _promoUsedKey(promoId) {
        const u = (VIP.state.currentUser && VIP.state.currentUser.username) || '';
        return 'vipPromoUsed:' + u.toLowerCase() + ':' + promoId;
    }
    function _isPromoLocallyUsed(promoId) {
        try { return localStorage.getItem(_promoUsedKey(promoId)) === '1'; }
        catch (_) { return false; }
    }
    function _markPromoLocallyUsed(promoId) {
        try { localStorage.setItem(_promoUsedKey(promoId), '1'); } catch (_) {}
    }

    async function applyPromoAlertIfActive() {
        try {
            if (!VIP.state.currentToken) return;
            const r = await fetch(`${VIP.config.API_URL}/api/promo-alert/active`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (!r.ok) return;
            const data = await r.json();
            if (!data || !data.active) {
                // No hay promo o ya vencio: si teniamos overlay, restauramos
                // el boton normal re-renderizando el home.
                clearPromoTimers();
                return;
            }
            // Si este user ya tocó esta promo, no la mostramos (vuelve al
            // estado original con boton QUIERO CARGAR).
            if (data.id && _isPromoLocallyUsed(data.id)) {
                clearPromoTimers();
                return;
            }
            renderPromoOverlay(data);
        } catch (err) {
            console.warn('applyPromoAlertIfActive error:', err);
        }
    }

    function clearPromoTimers() {
        if (_promoTimerId) { clearTimeout(_promoTimerId); _promoTimerId = null; }
        if (_promoCountdownId) { clearInterval(_promoCountdownId); _promoCountdownId = null; }
    }

    function _waLinkForCharge(extraText) {
        const phone = (VIP.state.linePhone || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
        if (!phone) return null;
        const msg = encodeURIComponent(extraText || '');
        return 'https://wa.me/' + phone + (msg ? '?text=' + msg : '');
    }

    function renderPromoOverlay(promo) {
        const phoneEl = document.getElementById('userLinePhone');
        if (!phoneEl) return;
        clearPromoTimers();

        const expiresMs = new Date(promo.expiresAt).getTime();
        const remainingMs = expiresMs - Date.now();
        if (remainingMs <= 0) { applyPromoAlertIfActive(); return; }

        const safeMsg = String(promo.message || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeCode = String(promo.code || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // Mensaje de WhatsApp pre-cargado con el codigo. El user toca y
        // ya abre WA con el texto listo, solo le da Enviar.
        const waText = `Hola! Quiero usar el código ${promo.code} (${promo.message})`;
        const waLink = _waLinkForCharge(waText);

        const linkAttr = waLink
            ? 'href="' + waLink + '" target="_blank" rel="noopener noreferrer"'
            : 'href="javascript:void(0)" role="button" aria-disabled="true"';

        phoneEl.innerHTML =
            '<a ' + linkAttr + ' class="promo-cta" id="promoCtaAnchor" aria-label="Reclamar promo ' + safeCode + '">' +
                '<div class="promo-cta-flag">🎁 RECLAMÁ</div>' +
                '<div class="promo-cta-msg">' + safeMsg + '</div>' +
                '<div class="promo-cta-code">Código: <strong>' + safeCode + '</strong></div>' +
                '<div class="promo-cta-timer" id="promoCtaTimer">⏰ vence en —</div>' +
            '</a>';

        // Track click → server suma waClicks en el row de NotificationHistory
        // asociado a esta promo (si lo hay). Best-effort: si falla no
        // bloqueamos la apertura de WhatsApp.
        // Ademas: marcamos la promo como "usada" en localStorage y volvemos
        // al boton normal QUIERO CARGAR — el user ya la usó, no le seguimos
        // mostrando el cartel aunque la promo siga activa server-side.
        const ctaAnchor = document.getElementById('promoCtaAnchor');
        if (ctaAnchor) {
            ctaAnchor.addEventListener('click', () => {
                try {
                    fetch(`${VIP.config.API_URL}/api/promo-alert/track-click`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` },
                        keepalive: true
                    }).catch(() => {});
                } catch (_) {}
                if (promo && promo.id) {
                    _markPromoLocallyUsed(promo.id);
                }
                // Pequeño delay para que el wa.me alcance a abrirse antes
                // de que rerenderemos.
                setTimeout(() => {
                    clearPromoTimers();
                    renderRefundsHomeUI();
                }, 300);
            }, { once: false });
        }

        // Contador en vivo cada 1s (visualmente actualiza min/seg).
        const updateCountdown = () => {
            const left = expiresMs - Date.now();
            const t = document.getElementById('promoCtaTimer');
            if (!t) return;
            if (left <= 0) {
                t.textContent = '⏰ vencida';
                clearPromoTimers();
                // Re-render normal del home para volver a poner QUIERO CARGAR.
                setTimeout(() => renderRefundsHomeUI(), 250);
                return;
            }
            const totalSec = Math.floor(left / 1000);
            const h = Math.floor(totalSec / 3600);
            const m = Math.floor((totalSec % 3600) / 60);
            const s = totalSec % 60;
            let str;
            if (h > 0) str = h + 'h ' + String(m).padStart(2, '0') + 'm';
            else if (m > 0) str = m + 'm ' + String(s).padStart(2, '0') + 's';
            else str = s + 's';
            t.textContent = '⏰ vence en ' + str;
        };
        updateCountdown();
        _promoCountdownId = setInterval(updateCountdown, 1000);

        // Programar el re-render exacto al vencimiento.
        _promoTimerId = setTimeout(() => {
            clearPromoTimers();
            renderRefundsHomeUI();
        }, Math.min(remainingMs + 500, 2147483000));
    }

    // Polling defensivo cada 60s para recoger promos creadas mientras la
    // pagina esta abierta (sin recargar). Idle-friendly: solo si la
    // pestaña esta visible.
    if (!_promoRefetchId) {
        _promoRefetchId = setInterval(() => {
            if (document.visibilityState !== 'visible') return;
            applyPromoAlertIfActive();
        }, 60 * 1000);
    }

    // Polling de la línea vigente cada 5 minutos: si el admin cambia la
    // línea/equipo del user (xlsx upload, clear, reasignación), el user se
    // entera sin tener que recargar la página. Sólo si la pestaña está
    // visible y hay sesión.
    if (!window._linePollId) {
        window._linePollId = setInterval(() => {
            if (document.visibilityState !== 'visible') return;
            if (!VIP.state || !VIP.state.currentToken) return;
            try { refreshLinePhone(); } catch (_) {}
        }, 5 * 60 * 1000);
    }

    // Refrescar línea vigente + link de comunidad con el token actual (sirve tras reload).
    async function refreshLinePhone() {
        try {
            const r = await fetch(`${VIP.config.API_URL}/api/user-lines/me`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (r.ok) {
                const d = await r.json();
                const newPhone = d.phone || null;
                VIP.state.linePhone = newPhone;
                VIP.state.communityLink = d.communityLink || null;
                VIP.state.communityLabel = d.communityLabel || null;
                VIP.state.communityLink2 = d.communityLink2 || null;
                VIP.state.communityLabel2 = d.communityLabel2 || null;
                VIP.state.communityStatus = d.communityStatus || 'active';
                VIP.state.communityReplacementLink = d.communityReplacementLink || null;
                VIP.state.communityReplacementLabel = d.communityReplacementLabel || null;
                VIP.state.communityAlertForceUntilMs = d.communityAlertForceUntilMs || 0;
                VIP.state.communityForceBannerMsg = d.communityForceBannerMsg || null;
                VIP.state.joinedTelegram = !!d.joinedTelegram;
                VIP.state.excludedFromCodes = !!d.excludedFromCodes;
                VIP.state.showUnblockNotice = !!d.showUnblockNotice;
                try { renderTelegramQuickJoinBtn(); } catch (_) {}
                try { renderRedeemCodeVisibility(); } catch (_) {}
                try { renderUnblockNotice(); } catch (_) {}
                VIP.state.teamName = d.teamName || null;
                try { renderCommunityForceBanner(); } catch (_) {}
                renderRefundsHomeUI();
                renderTeamName();
                checkLineChange(newPhone);
                try { showCommunityJoinAlert(); } catch (_) {}
                try { showStartupAvisoOnce(); } catch (_) {}
            }
        } catch (_) { /* ignore */ }
    }

    // Muestra el nombre del equipo arriba a la izquierda del header. Lo
    // resuelve el backend a partir del prefijo del username (config en
    // admin > Numero principal) o de la asignación explícita por listado.
    // Si no hay teamName, oculta el span.
    //
    // Formato: el lineTeamName guardado puede ser "TIGER" o
    // "TIGER · TIGER 1" (cuando se importa con etiqueta de línea). Para
    // el display recortamos la parte después del " · " — al jugador le
    // alcanza con saber su equipo, la línea exacta es para soporte/admin.
    function renderTeamName() {
        const el = document.getElementById('teamName');
        if (!el) return;
        const raw = (VIP.state && VIP.state.teamName) || null;
        if (raw && String(raw).trim()) {
            const trimmed = String(raw).trim();
            const sepIdx = trimmed.indexOf(' · ');
            const display = sepIdx >= 0 ? trimmed.slice(0, sepIdx) : trimmed;
            el.textContent = display;
            el.style.display = '';
        } else {
            el.textContent = '';
            el.style.display = 'none';
        }
    }

    // Compara el número que devolvió el server con el que vimos por última
    // vez (localStorage). Si cambió, muestra el banner rojo grande para
    // que el usuario sepa que tiene que agendar el nuevo y borrar el viejo.
    // Track clicks en el link de comunidad. Fire-and-forget — no bloquea
    // la navegación al link. Backend agrega el click al CommunityLinkClick
    // y lo agrega por día/equipo para el panel admin.
    window.VIP = window.VIP || {};
    VIP.communityClick = function (source, link) {
        try {
            if (!VIP.state || !VIP.state.currentToken) return;
            fetch(`${VIP.config.API_URL}/api/community/link-click`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${VIP.state.currentToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ source: source || 'home_button', communityLink: link || VIP.state.communityLink || '' }),
                keepalive: true
            }).catch(() => {});
        } catch (_) {}
    };

    // Pinta/oculta el banner rojo "No te olvides de unirte" debajo del
    // bloque "Unite a la comunidad". Visible durante la ventana de 24hs
    // activada cuando admin manda push de comunidad por equipo (o desde
    // el toggle manual).
    // Botón "📲 Abrir canal de Telegram" debajo del input del código en
    // la home. Visible cuando hay un link de Telegram configurado Y el
    // user todavía no canjeó ningún código (joinedTelegram === false).
    // Una vez que canjea, el flag se setea en el backend → al refrescar
    // se oculta solo.
    function renderTelegramQuickJoinBtn() {
        const btn = document.getElementById('telegramQuickJoinBtn');
        if (!btn) return;
        const link = (VIP.state.communityLink || VIP.state.communityLink2 || '').trim();
        const alreadyIn = !!VIP.state.joinedTelegram;
        const excluded = !!VIP.state.excludedFromCodes;
        if (link && !alreadyIn && !excluded) {
            btn.href = link;
            btn.style.display = 'flex';
        } else {
            btn.style.display = 'none';
        }
    }
    // Exponemos al window para que el flow de canje pueda forzar el hide
    // inmediatamente al reclamar OK (sin esperar el próximo /me).
    window.renderTelegramQuickJoinBtn = renderTelegramQuickJoinBtn;

    // Si el equipo del user está marcado como excluido del sistema de
    // códigos (excludeFromCodes en el slot), ocultamos el card del código
    // completo + el banner verde de "código activo ahora" + el botón
    // celeste. Si está incluido, los volvemos a mostrar (toggle reversible
    // por si el admin lo cambia mientras el user está abierto).
    function renderRedeemCodeVisibility() {
        const excluded = !!VIP.state.excludedFromCodes;
        const card = document.getElementById('redeemCodeHomeCard');
        const banner = document.getElementById('redeemActiveBanner');
        const newsBanner = document.getElementById('telegramNewsBanner');
        if (card) card.style.setProperty('display', excluded ? 'none' : 'flex', 'important');
        if (banner && excluded) banner.style.display = 'none';
        if (newsBanner) newsBanner.style.display = excluded ? 'none' : '';
    }
    window.renderRedeemCodeVisibility = renderRedeemCodeVisibility;

    // Cartel "no cambies de sesión" — visible solo si el admin recién
    // desbloqueó/restringió al user. Modal grande estilo encuesta que el
    // user tiene que tocar "ENTENDIDO" para cerrar (POST al backend).
    function renderUnblockNotice() {
        const should = !!VIP.state.showUnblockNotice;
        const existing = document.getElementById('unblockNoticeOverlay');
        if (!should) { if (existing) existing.remove(); return; }
        // Si ya está mostrado, no spawneamos otro.
        if (existing) return;

        const overlay = document.createElement('div');
        overlay.id = 'unblockNoticeOverlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:100000;display:flex;align-items:center;justify-content:center;padding:18px;';
        overlay.innerHTML =
            '<div style="background:linear-gradient(180deg,#0a0a16 0%,#14142a 100%);border:2px solid #ffd700;border-radius:14px;padding:24px 22px;max-width:420px;width:100%;box-shadow:0 0 40px rgba(255,215,0,0.40);color:#fff;text-align:center;">' +
              '<div style="font-size:56px;margin-bottom:6px;line-height:1;">⚠️</div>' +
              '<div style="color:#ffd700;font-weight:900;font-size:18px;letter-spacing:0.5px;margin-bottom:6px;">AVISO IMPORTANTE</div>' +
              '<div style="color:#fff;font-size:14px;line-height:1.55;margin-bottom:14px;">Para no perder tus beneficios:</div>' +
              '<div style="background:rgba(255,215,0,0.08);border:1.5px solid rgba(255,215,0,0.45);border-radius:11px;padding:13px 14px;margin-bottom:14px;text-align:left;font-size:13px;line-height:1.55;">' +
                '<div style="margin-bottom:7px;"><strong style="color:#ffd700;">🚫 NO cambies de sesión</strong> en esta app.</div>' +
                '<div style="margin-bottom:7px;"><strong style="color:#ffd700;">🔔 Las notificaciones</strong>, los bonos y los códigos van sobre <strong style="color:#fff;">TU usuario</strong> — si entrás con otra cuenta desde este dispositivo, podés perder los regalos.</div>' +
                '<div><strong style="color:#ffd700;">📱 Una app, un usuario.</strong> Usá siempre el mismo.</div>' +
              '</div>' +
              '<button type="button" id="unblockNoticeOk" style="width:100%;background:linear-gradient(135deg,#ffd700 0%,#ff8800 100%);border:none;color:#000;padding:13px;border-radius:10px;font-weight:900;font-size:14px;letter-spacing:0.5px;cursor:pointer;box-shadow:0 4px 14px rgba(255,215,0,0.40);">✅ ENTENDIDO</button>' +
            '</div>';
        document.body.appendChild(overlay);
        document.getElementById('unblockNoticeOk').onclick = async () => {
            const token = (VIP.state && VIP.state.currentToken) || localStorage.getItem('userToken') || '';
            try {
                await fetch('/api/user/dismiss-unblock-notice', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token }
                });
            } catch (_) {}
            VIP.state.showUnblockNotice = false;
            overlay.remove();
        };
    }
    window.renderUnblockNotice = renderUnblockNotice;

    // Aviso de inicio "una app, un usuario" — se muestra UNA sola vez por
    // usuario a TODOS los que entran (no solo a los recién desbloqueados).
    // Mismo contenido que el modal de desbloqueo. Flag en localStorage por
    // username. Si el modal de desbloqueo ya va a aparecer, se omite (mismo
    // mensaje, no duplicar).
    function showStartupAvisoOnce() {
        const username = (VIP.state && VIP.state.currentUser && VIP.state.currentUser.username) || '';
        if (!username) return;
        if (VIP.state && VIP.state.showUnblockNotice) return;
        if (document.getElementById('unblockNoticeOverlay')) return;
        if (document.getElementById('startupAvisoOverlay')) return;
        const key = 'avisoImportanteSeen:' + username.toLowerCase();
        try { if (localStorage.getItem(key) === '1') return; } catch (_) {}

        const overlay = document.createElement('div');
        overlay.id = 'startupAvisoOverlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:100000;display:flex;align-items:center;justify-content:center;padding:18px;';
        overlay.innerHTML =
            '<div style="background:linear-gradient(180deg,#0a0a16 0%,#14142a 100%);border:2px solid #ffd700;border-radius:14px;padding:24px 22px;max-width:420px;width:100%;box-shadow:0 0 40px rgba(255,215,0,0.40);color:#fff;text-align:center;">' +
              '<div style="font-size:56px;margin-bottom:6px;line-height:1;">⚠️</div>' +
              '<div style="color:#ffd700;font-weight:900;font-size:18px;letter-spacing:0.5px;margin-bottom:6px;">AVISO IMPORTANTE</div>' +
              '<div style="color:#fff;font-size:14px;line-height:1.55;margin-bottom:14px;">Para no perder tus beneficios:</div>' +
              '<div style="background:rgba(255,215,0,0.08);border:1.5px solid rgba(255,215,0,0.45);border-radius:11px;padding:13px 14px;margin-bottom:14px;text-align:left;font-size:13px;line-height:1.55;">' +
                '<div style="margin-bottom:7px;"><strong style="color:#ffd700;">🚫 NO cambies de sesión</strong> en esta app.</div>' +
                '<div style="margin-bottom:7px;"><strong style="color:#ffd700;">🔔 Las notificaciones</strong>, los bonos y los códigos van sobre <strong style="color:#fff;">TU usuario</strong> — si entrás con otra cuenta desde este dispositivo, podés perder los regalos.</div>' +
                '<div><strong style="color:#ffd700;">📱 Una app, un usuario.</strong> Usá siempre el mismo.</div>' +
              '</div>' +
              '<button type="button" id="startupAvisoOk" style="width:100%;background:linear-gradient(135deg,#ffd700 0%,#ff8800 100%);border:none;color:#000;padding:13px;border-radius:10px;font-weight:900;font-size:14px;letter-spacing:0.5px;cursor:pointer;box-shadow:0 4px 14px rgba(255,215,0,0.40);">✅ ENTENDIDO</button>' +
            '</div>';
        document.body.appendChild(overlay);
        document.getElementById('startupAvisoOk').onclick = () => {
            try { localStorage.setItem(key, '1'); } catch (_) {}
            overlay.remove();
        };
    }
    window.showStartupAvisoOnce = showStartupAvisoOnce;

    function renderCommunityForceBanner() {
        const el = document.getElementById('communityForceReminderBanner');
        if (!el) return;
        const until = Number(VIP.state.communityAlertForceUntilMs || 0);
        const active = until > Date.now();
        if (active) {
            el.style.display = '';
            // Pintar mensaje custom si el admin lo dejó (al cambiar el link).
            // Estructura: <div título><div cuerpo>. Sólo reemplazamos el cuerpo.
            try {
                const custom = String(VIP.state.communityForceBannerMsg || '').trim();
                if (custom) {
                    const bodyDiv = el.querySelectorAll('div')[1];
                    if (bodyDiv) bodyDiv.textContent = custom;
                }
            } catch (_) {}
        } else {
            el.style.display = 'none';
        }
        try { console.log('[community-banner] active=' + active + ' until=' + (until ? new Date(until).toISOString() : 'null')); } catch (_) {}
    }

    // Re-check periódico cada 60s: si la ventana de 24hs venció, ocultar.
    // También fuerza re-fetch del flag cada 5 min por si admin lo activó
    // mientras el user estaba con la app abierta.
    setInterval(() => {
        try { renderCommunityForceBanner(); } catch (_) {}
    }, 60 * 1000);
    setInterval(() => {
        if (document.visibilityState === 'visible' && VIP.state && VIP.state.currentToken) {
            try { refreshLinePhone(); } catch (_) {}
        }
    }, 5 * 60 * 1000);

    // Alerta "revisá si estás unido a la comunidad". Se muestra al entrar
    // a la app. Anti-spam: 1 vez cada 5 días por usuario (localStorage).
    // Si la comunidad está marcada DOWN, se muestra siempre hasta que
    // toque el link de la nueva (variante "comunidad cambió").
    function showCommunityJoinAlert() {
        const link = VIP.state.communityLink;
        const status = VIP.state.communityStatus || 'active';
        const label = VIP.state.communityLabel || '';
        const replacementLink = VIP.state.communityReplacementLink;
        const replacementLabel = VIP.state.communityReplacementLabel || '';
        if (!link && !replacementLink) return;
        const username = (VIP.state.currentUser && VIP.state.currentUser.username) || '_anon';
        const isDown = status === 'down' && !!replacementLink;
        const lsKey = isDown
            ? ('commAlertDown:' + username + ':' + (replacementLink || ''))
            : ('commAlertSeen:' + username + ':' + (link || ''));
        // Si está active: respetar cooldown de 5 días entre mostradas,
        // PERO si el admin activó "force alert" via push de prefijo,
        // ignoramos el cooldown durante la ventana forzada.
        const forceUntil = Number(VIP.state.communityAlertForceUntilMs || 0);
        const forceActive = forceUntil > Date.now();
        if (!isDown && !forceActive) {
            try {
                const last = parseInt(localStorage.getItem(lsKey) || '0', 10);
                if (last && (Date.now() - last) < 5 * 24 * 3600 * 1000) return;
            } catch (_) {}
        } else if (forceActive && !isDown) {
            // Dentro de la ventana forzada, solo respetar dismiss explícito
            // hecho DENTRO de esa misma ventana (no el cooldown viejo).
            try {
                const dismissedAt = parseInt(localStorage.getItem(lsKey + ':force') || '0', 10);
                if (dismissedAt && dismissedAt > (forceUntil - 24 * 3600 * 1000)) return;
            } catch (_) {}
        } else {
            // Down: si ya tocaron el link nuevo, no mostramos más.
            try { if (localStorage.getItem(lsKey) === 'tapped') return; } catch (_) {}
        }
        // No duplicar si ya está en pantalla.
        if (document.getElementById('communityJoinAlert')) return;

        const overlay = document.createElement('div');
        overlay.id = 'communityJoinAlert';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:30000;display:flex;align-items:center;justify-content:center;padding:14px;';
        const tappedHref = isDown ? replacementLink : link;
        const titleTxt = isDown ? '⚠️ Nos mudamos a Telegram' : '🔔 Unite a nuestra nueva comunidad';
        const labelTxt = isDown ? (replacementLabel || 'el nuevo canal de Telegram') : (label || 'nuestro canal de Telegram');
        const bodyTxt = isDown
            ? 'Ya no usamos WhatsApp. Sumate al nuevo canal privado de Telegram para no perderte códigos, novedades y juegos de la semana.'
            : 'Unite a nuestra nueva comunidad en Telegram — ya no usamos WhatsApp. Ahí publicamos códigos, novedades y juegos de la semana.';

        function dismiss() {
            try {
                if (isDown) localStorage.setItem(lsKey, 'tapped');
                else if (forceActive) localStorage.setItem(lsKey + ':force', String(Date.now()));
                else localStorage.setItem(lsKey, String(Date.now()));
            } catch (_) {}
            overlay.remove();
        }
        overlay.onclick = (e) => { if (e.target === overlay) dismiss(); };
        overlay.innerHTML =
            '<div style="background:linear-gradient(180deg,#1a0033,#0a001a);border:3px solid ' + (isDown ? '#ff8080' : '#25d366') + ';border-radius:18px;padding:22px 18px;max-width:420px;width:100%;text-align:center;box-shadow:0 0 30px rgba(' + (isDown ? '255,128,128' : '37,211,102') + ',0.40);">' +
                '<div style="font-size:56px;line-height:1;margin-bottom:8px;">' + (isDown ? '⚠️' : '🔔') + '</div>' +
                '<div style="color:' + (isDown ? '#ff8080' : '#25d366') + ';font-weight:900;font-size:15px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;">' + titleTxt + '</div>' +
                '<div style="color:#fff;font-size:14px;line-height:1.5;margin-bottom:14px;">' + bodyTxt + '</div>' +
                '<a href="' + tappedHref + '" target="_blank" rel="noopener" id="commAlertJoinBtn" style="display:block;text-decoration:none;background:linear-gradient(135deg,#25d366,#128c7e);color:#fff;padding:14px;border-radius:11px;font-weight:900;font-size:14px;letter-spacing:0.5px;margin-bottom:8px;box-shadow:0 4px 14px rgba(37,211,102,0.35);">💬 ENTRAR A ' + (labelTxt || 'la comunidad').toUpperCase() + '</a>' +
                '<button type="button" id="commAlertCloseBtn" style="width:100%;background:transparent;color:#aaa;border:1px solid rgba(255,255,255,0.20);padding:9px;border-radius:9px;font-weight:700;font-size:12px;cursor:pointer;">Cerrar · ya estoy unido</button>' +
            '</div>';
        document.body.appendChild(overlay);
        // El botón "ENTRAR" abre el link y a la vez marca como visto.
        const joinBtn = document.getElementById('commAlertJoinBtn');
        if (joinBtn) joinBtn.addEventListener('click', () => {
            // Track click vía endpoint dedicado.
            try { VIP.communityClick(isDown ? 'replacement' : 'modal_join', tappedHref); } catch (_) {}
            dismiss();
        });
        const closeBtn = document.getElementById('commAlertCloseBtn');
        if (closeBtn) closeBtn.addEventListener('click', dismiss);
    }

    // En el primer login (no hay valor previo) NO mostramos el banner —
    // solo guardamos para futuras comparaciones.
    function checkLineChange(currentPhone) {
        const banner = document.getElementById('lineChangedAlert');
        if (!banner) return;
        if (!currentPhone) {
            banner.style.display = 'none';
            return;
        }
        // Clave por usuario para que el "último visto" sea per-cuenta
        const username = (VIP.state.currentUser && VIP.state.currentUser.username) || '_anon';
        const key = 'lastSeenLinePhone:' + username;
        let prev = null;
        try { prev = localStorage.getItem(key); } catch (_) { /* ignore */ }

        if (!prev) {
            // Primer login: no hay nada con qué comparar, solo guardamos.
            try { localStorage.setItem(key, currentPhone); } catch (_) {}
            banner.style.display = 'none';
            return;
        }
        if (prev !== currentPhone) {
            // ¡Cambió!
            banner.style.display = 'block';
        } else {
            banner.style.display = 'none';
        }
    }

    // Wire-up del botón "Entendido, ya lo agendé" del banner de cambio de línea.
    // Además del dismiss, abre WhatsApp directo al nuevo número con un mensaje
    // pre-cargado para confirmar que el usuario agendó el número nuevo.
    function wireLineChangedDismiss() {
        const btn = document.getElementById('lineChangedDismiss');
        if (!btn) return;
        btn.addEventListener('click', function () {
            const banner = document.getElementById('lineChangedAlert');
            if (banner) banner.style.display = 'none';

            const username = (VIP.state.currentUser && VIP.state.currentUser.username) || '_anon';
            const key = 'lastSeenLinePhone:' + username;
            const phone = VIP.state.linePhone;
            if (phone) {
                try { localStorage.setItem(key, phone); } catch (_) {}
            }

            // Derivar al nuevo WhatsApp con mensaje pre-cargado
            if (phone) {
                const waNumber = phone.replace(/[^\d+]/g, '').replace(/^\+/, '');
                const msg = encodeURIComponent(
                    'Hola! Soy ' + ((VIP.state.currentUser && VIP.state.currentUser.username) || '') +
                    '. Ya agendé el nuevo número.'
                );
                const url = 'https://wa.me/' + waNumber + '?text=' + msg;
                window.open(url, '_blank');
            }
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wireLineChangedDismiss);
    } else {
        wireLineChangedDismiss();
    }

    // ============================================================
    // LOGOUT DESHABILITADO PARA EL USUARIO FINAL.
    // ============================================================
    // El owner pidio: la gente NO puede salir de la app (perdian sesion
    // y no recibian notifs). Caminos disponibles para logout SOLO via
    // URL (admin/testing): ?logout=1 o #logout en la barra del browser.
    // El boton 🚪 visible y el long-press en el badge del username
    // (que disparaba el confirm "¿Cerrar sesión?") fueron desactivados.
    function wireLogoutButton() { /* deshabilitado a proposito */ }
    function wireDiscreteLogout() { /* deshabilitado a proposito */ }
    // Aseguramos que el boton 🚪 quede oculto si esta en el DOM.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            const btn = document.getElementById('logoutBtn');
            if (btn) btn.style.display = 'none';
        });
    } else {
        const btn = document.getElementById('logoutBtn');
        if (btn) btn.style.display = 'none';
    }

    // URL trigger ?logout=1 / #logout sigue DESHABILITADO para el público.
    // Pero existe un trigger gated solo-owner ?ownerLogout=<secret> que SI
    // ejecuta logout. Secret hardcodeado: solo el owner lo conoce, no es
    // adivinable. Si llegara a leakear, basta cambiar la constante y deploy.
    const OWNER_LOGOUT_SECRET = 'vipsalida-fabio-2026-x9k';
    const OWNER_MODE_FLAG_KEY = '__vipOwnerMode';
    function checkUrlLogoutTrigger() {
        try {
            const params = new URLSearchParams(window.location.search);
            const ownerFlag = params.get('ownerLogout');
            // ?ownerMode=<secret> → activa modo owner persistente en ESTE
            // dispositivo (localStorage flag). A partir de ahí aparece el
            // botoncito "salir" rojo en el header al lado del username.
            const ownerModeFlag = params.get('ownerMode');
            if (ownerModeFlag && ownerModeFlag === OWNER_LOGOUT_SECRET) {
                try { localStorage.setItem(OWNER_MODE_FLAG_KEY, '1'); } catch (_) {}
                params.delete('ownerMode');
                const newSearch = params.toString();
                const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '');
                history.replaceState(null, '', newUrl);
                try { window.renderOwnerLogoutSmallBtn && window.renderOwnerLogoutSmallBtn(); } catch (_) {}
            }
            if (ownerFlag && ownerFlag === OWNER_LOGOUT_SECRET) {
                try { localStorage.removeItem('userToken'); } catch (_) {}
                try { localStorage.removeItem('userId'); } catch (_) {}
                try { localStorage.removeItem('refreshToken'); } catch (_) {}
                try { VIP.state.currentToken = null; VIP.state.currentUser = null; } catch (_) {}
                params.delete('ownerLogout');
                const newSearch = params.toString();
                const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '');
                history.replaceState(null, '', newUrl);
                // Recargar para volver al login limpio.
                setTimeout(() => { location.reload(); }, 50);
            }
        } catch (_) {}
    }

    // Muestra/oculta el botoncito "salir" en el header. Solo visible si el
    // device tiene el flag de owner-mode guardado (activado vía
    // ?ownerMode=<secret>).
    window.renderOwnerLogoutSmallBtn = function renderOwnerLogoutSmallBtn() {
        try {
            const btn = document.getElementById('ownerLogoutSmallBtn');
            if (!btn) return;
            const isOwner = (function () { try { return localStorage.getItem(OWNER_MODE_FLAG_KEY) === '1'; } catch (_) { return false; } })();
            // El usuario de prueba "lalodj" también ve el botón salir, para
            // poder probar el anti multi-cuenta por dispositivo.
            const u = ((VIP.state && VIP.state.currentUser && VIP.state.currentUser.username) || '').toLowerCase();
            const isTester = (u === 'lalodj');
            btn.style.display = (isOwner || isTester) ? '' : 'none';
        } catch (_) {}
    };

    // Handler del botoncito: logout local (clear tokens + reload).
    window.ownerLogoutSmall = function ownerLogoutSmall() {
        try { localStorage.removeItem('userToken'); } catch (_) {}
        try { localStorage.removeItem('userId'); } catch (_) {}
        try { localStorage.removeItem('refreshToken'); } catch (_) {}
        try { VIP.state.currentToken = null; VIP.state.currentUser = null; } catch (_) {}
        setTimeout(() => { location.reload(); }, 30);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            wireDiscreteLogout();
            setTimeout(checkUrlLogoutTrigger, 50);
            setTimeout(() => { try { window.renderOwnerLogoutSmallBtn(); } catch (_) {} }, 80);
        });
    } else {
        wireDiscreteLogout();
        setTimeout(checkUrlLogoutTrigger, 50);
        setTimeout(() => { try { window.renderOwnerLogoutSmallBtn(); } catch (_) {} }, 80);
    }

    // Cuando la app vuelve al foreground (ej: el user tocó la notif push
    // "NUEVA LINEA"), refrescar la línea para detectar cambios y mostrar
    // el banner si corresponde, sin esperar a un refresh manual.
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && VIP.state.currentToken) {
            refreshLinePhone();
        }
    });

    async function verifyToken() {
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/verify`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });

            if (response.ok) {
                const data = await response.json();

                if (!data.user || !data.user.username) {
                    console.log('Token válido pero falta información de usuario, recargando...');
                    const userResponse = await fetch(`${VIP.config.API_URL}/api/users/me`, {
                        headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
                    });
                    if (userResponse.ok) {
                        const userData = await userResponse.json();
                        VIP.state.currentUser = {
                            ...userData,
                            id: userData.id || userData.userId,
                            userId: userData.userId || userData.id
                        };
                    } else {
                        VIP.state.currentUser = {
                            ...data.user,
                            id: data.user.id || data.user.userId,
                            userId: data.user.userId || data.user.id
                        };
                    }
                } else {
                    VIP.state.currentUser = {
                        ...data.user,
                        id: data.user.id || data.user.userId,
                        userId: data.user.userId || data.user.id
                    };
                }

                VIP.ui.showChatScreen();
                try { window.renderOwnerLogoutSmallBtn(); } catch (_) {}
                VIP.refunds.loadRefundStatus();
                try { if (VIP.reviews && typeof VIP.reviews.init === 'function') VIP.reviews.init(); } catch (_) { /* ignore */ }

                // Refunds-only: pintar bienvenida + refrescar línea vigente
                try { renderRefundsHomeUI(); } catch (_) { /* ignore */ }
                refreshLinePhone();
            } else if (response.status === 401 || response.status === 403) {
                // SOLO borramos el token si el server lo rechazo explicitamente
                // como invalido. Antes lo borrabamos en cualquier non-200, lo
                // que tiraba al login a users con server temporalmente caido o
                // 500 transitorio — y al re-loguear perdian el token FCM.
                localStorage.removeItem('userToken');
            } else {
                // 500/502/503 o similar: NO borramos el token. Mostramos el
                // chat screen igual con la sesion anterior y reintentamos
                // verificar despues. Asi el user no pierde notifs por un
                // hiccup temporal del server.
                console.warn('verifyToken: server respondio ' + response.status + ', mantengo sesion');
                try { VIP.ui.showChatScreen(); } catch (_) {}
                try { renderRefundsHomeUI(); } catch (_) {}
            }
        } catch (error) {
            // Network error / fetch fail: NO borrar el token. El user puede
            // estar offline. Mostramos chat screen con la cache para que
            // pueda usar la app y reintentamos despues.
            console.warn('verifyToken: error de red — mantengo sesion offline', error && error.message);
            try { VIP.ui.showChatScreen(); } catch (_) {}
            try { renderRefundsHomeUI(); } catch (_) {}
        }
    }

    function handleLogout() {
        // Avisar al backend para limpiar el token FCM de este dispositivo, así
        // las notificaciones del próximo user no se entregan a la sesión cerrada.
        // Best-effort: no bloqueamos el logout si la llamada falla (offline, etc.).
        try {
            const fcmToken = localStorage.getItem('fcmToken');
            const authToken = VIP.state.currentToken || localStorage.getItem('userToken');
            if (fcmToken) {
                const headers = { 'Content-Type': 'application/json' };
                if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
                fetch(VIP.config.API_URL + '/api/auth/logout', {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({ fcmToken: fcmToken }),
                    keepalive: true
                }).catch(function () { /* ignore */ });
            }
        } catch (e) { /* ignore */ }

        VIP.socket.stopMessagePolling();
        VIP.ui.stopBalancePolling();
        VIP.state.currentToken = null;
        VIP.state.currentUser = null;
        VIP.state.sessionPassword = '';
        localStorage.removeItem('userToken');
        // El fcmToken local también se borra para que la sesión siguiente
        // (otro usuario en el mismo dispositivo) registre uno fresco asociado
        // a su cuenta y no herede el del usuario anterior.
        localStorage.removeItem('fcmToken');
        localStorage.removeItem('fcmTokenContext');
        localStorage.removeItem('fcmTokenUserId');
        sessionStorage.removeItem('sessionPassword');

        // Limpiar TODAS las keys per-user del usuario que se está deslogueando
        // para evitar que un user B (logueado después en el mismo device) vea
        // estado del user A:
        //   - vipWelcomeBonusClaimed:* → si A reclamó el bono, B veía el card oculto.
        //   - vipAmtCache:*           → cache de saldo/reembolsos.
        //   - vipAppInstalled         → si A instaló, B veía "✅ App instalada"
        //                                aunque nunca instaló nada en su cuenta.
        try {
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k) continue;
                if (k.startsWith('vipWelcomeBonusClaimed:') ||
                    k.startsWith('vipAmtCache:') ||
                    k === 'vipAppInstalled' ||
                    k === 'vipGiveawayTotalCache') {
                    keysToRemove.push(k);
                }
            }
            for (const k of keysToRemove) localStorage.removeItem(k);
        } catch (_) { /* localStorage podría estar bloqueado */ }

        VIP.ui.showLoginScreen();
    }

    async function ensureUserLoaded(retries = 3) {
        if (VIP.state.currentUser && VIP.state.currentUser.id && VIP.state.currentUser.username) {
            console.log('✅ Usuario ya cargado completamente:', VIP.state.currentUser.username);
            return true;
        }

        console.log('🔄 Cargando usuario automáticamente...');

        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(`${VIP.config.API_URL}/api/users/me`, {
                    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
                });

                if (response.ok) {
                    const userData = await response.json();
                    if (userData && userData.username) {
                        VIP.state.currentUser = {
                            ...userData,
                            id: userData.id || userData._id,
                            userId: userData.id || userData._id
                        };
                        console.log('✅ Usuario cargado exitosamente:', VIP.state.currentUser.username);
                        return true;
                    }
                } else if (response.status === 404) {
                    console.log(`⏳ Intento ${i + 1}/${retries}: Usuario no encontrado, reintentando...`);
                    await new Promise(resolve => setTimeout(resolve, 500));
                } else {
                    console.error('Error cargando usuario:', response.status);
                }
            } catch (error) {
                console.error('Error en ensureUserLoaded:', error);
            }
        }

        console.error('❌ No se pudo cargar el usuario después de', retries, 'intentos');
        return false;
    }

    async function initializeSession(afterRegister = false) {
        console.log('🚀 Inicializando sesión...');

        const userLoaded = await ensureUserLoaded(afterRegister ? 5 : 3);

        if (!userLoaded) {
            console.warn('⚠️ No se pudo cargar el usuario completamente, pero continuando...');
        }

        // Server-side enforcement of mandatory password change.
        // If `/api/users/me` reported `mustChangePassword: true`, re-open the
        // mandatory change modal automatically. This handles the page-reload
        // bypass: the flag lives on the server and is detected here on every
        // session bootstrap.
        if (VIP.state.currentUser && VIP.state.currentUser.mustChangePassword === true) {
            VIP.state.passwordChangePending = true;
            try { prepareChangePasswordModal(); } catch (e) { /* DOM not ready yet */ }
            try { VIP.ui.showModal('changePasswordModal'); } catch (e) { /* ignore */ }
        }

        VIP.ui.showChatScreen();
        // Solo inicializar el socket para recibir push_notification en vivo.
        // Antes era startMessagePolling que llamaba a VIP.chat.loadMessages cada
        // 30s — el chat ya no existe en esta version, asi que nos ahorramos
        // ese fetch innecesario en cada user logueado.
        VIP.socket.initSocket();
        VIP.refunds.loadRefundStatus();
        VIP.ui.loadCanalInformativoUrl();

        // Prefetch oportunista de sorteos: ya que el user esta autenticado,
        // calentamos la cache para que cuando abra el modal sea instantaneo.
        // Se hace despues de un tickito para no bloquear el render principal.
        if (VIP.raffles && typeof VIP.raffles.prefetch === 'function') {
            setTimeout(() => { try { VIP.raffles.prefetch(); } catch (_) {} }, 1500);
        }

        return userLoaded;
    }

    function prepareChangePasswordModal() {
        const whatsappGroup = document.getElementById('changePasswordWhatsAppGroup');
        const whatsappInfo = document.getElementById('changePasswordWhatsAppInfo');
        const whatsappInput = document.getElementById('changePasswordWhatsApp');
        // Por requerimiento de Problema 2: el campo de teléfono se oculta SOLO si el usuario
        // ya tiene un teléfono verificado vía OTP. El campo `whatsapp` (no verificado) NO cuenta
        // como teléfono válido para saltarse la verificación, porque históricamente se guardó sin OTP.
        const verifiedPhone = VIP.state.currentUser
            && VIP.state.currentUser.phoneVerified === true
            && VIP.state.currentUser.phone
            ? VIP.state.currentUser.phone
            : null;

        if (whatsappGroup) {
            if (verifiedPhone) {
                whatsappGroup.style.display = 'none';
                if (whatsappInput) whatsappInput.removeAttribute('required');
            } else {
                whatsappGroup.style.display = '';
                if (whatsappInput) whatsappInput.setAttribute('required', '');
            }
        }
        if (whatsappInfo) {
            whatsappInfo.style.display = verifiedPhone ? 'block' : 'none';
            whatsappInfo.textContent = verifiedPhone ? `✅ Teléfono verificado: ${verifiedPhone}` : '';
        }

        // Reset del paso OTP: siempre arranca en paso 1 al abrir el modal.
        const otpStep = document.getElementById('changePasswordOtpStep');
        const form = document.getElementById('changePasswordForm');
        if (otpStep) otpStep.style.display = 'none';
        if (form) form.style.display = '';
        const otpCodeInput = document.getElementById('changePasswordOtpCode');
        if (otpCodeInput) otpCodeInput.value = '';
        const otpErr = document.getElementById('changePasswordOtpError');
        if (otpErr) { otpErr.textContent = ''; otpErr.classList.remove('show'); }
        _vipChangePwdPending = null;
        _stopChangePwdResendCooldown();

        // Actualizar título, subtítulo y botón de cierre según si el cambio es obligatorio
        const closeBtn = document.getElementById('changePasswordCloseBtn');
        const title = document.getElementById('changePasswordTitle');
        const subtitle = document.getElementById('changePasswordSubtitle');
        const currentPwdGroup = document.getElementById('currentPasswordGroup');
        const currentPwdInput = document.getElementById('currentPasswordInput');
        if (VIP.state.passwordChangePending) {
            if (closeBtn) closeBtn.style.display = 'none';
            if (title) title.textContent = '🔐 Cambio de Contraseña Obligatorio';
            if (subtitle) subtitle.innerHTML = 'Por seguridad, <strong>debés cambiar tu contraseña</strong> antes de continuar. No podés omitir este paso.';
            // En el flujo obligatorio el usuario fue importado/reseteado y no necesita
            // ingresar su contrasena actual.
            if (currentPwdGroup) currentPwdGroup.style.display = 'none';
            if (currentPwdInput) { currentPwdInput.value = ''; currentPwdInput.required = false; }
        } else {
            if (closeBtn) closeBtn.style.display = '';
            if (title) title.textContent = '🔐 Cambiar Contraseña';
            if (subtitle) subtitle.textContent = 'Ingresá tu nueva contraseña para actualizarla.';
            if (currentPwdGroup) currentPwdGroup.style.display = '';
            if (currentPwdInput) { currentPwdInput.value = ''; currentPwdInput.required = true; }
        }
    }

    // Estado pendiente del cambio de contraseña con OTP:
    // se guarda entre el paso 1 (datos) y el paso 2 (verificación OTP) para no perder
    // la nueva contraseña ni el teléfono mientras el usuario espera el SMS.
    let _vipChangePwdPending = null;
    let _vipChangePwdResendTimer = null;

    function _stopChangePwdResendCooldown() {
        if (_vipChangePwdResendTimer) {
            clearInterval(_vipChangePwdResendTimer);
            _vipChangePwdResendTimer = null;
        }
        const cooldownLabel = document.getElementById('changePasswordOtpResendCooldown');
        const resendBtn = document.getElementById('changePasswordOtpResendBtn');
        if (cooldownLabel) { cooldownLabel.style.display = 'none'; cooldownLabel.textContent = ''; }
        if (resendBtn) { resendBtn.style.display = ''; resendBtn.disabled = false; }
    }

    function _startChangePwdResendCooldown(seconds) {
        const cooldownLabel = document.getElementById('changePasswordOtpResendCooldown');
        const resendBtn = document.getElementById('changePasswordOtpResendBtn');
        let remaining = seconds;
        if (resendBtn) { resendBtn.style.display = 'none'; resendBtn.disabled = true; }
        if (cooldownLabel) {
            cooldownLabel.style.display = '';
            cooldownLabel.textContent = `Podés reenviar en ${remaining}s`;
        }
        if (_vipChangePwdResendTimer) clearInterval(_vipChangePwdResendTimer);
        _vipChangePwdResendTimer = setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
                _stopChangePwdResendCooldown();
            } else if (cooldownLabel) {
                cooldownLabel.textContent = `Podés reenviar en ${remaining}s`;
            }
        }, 1000);
    }

    async function handleChangePassword(e) {
        if (e) e.preventDefault();

        const currentPassword = document.getElementById('currentPasswordInput')?.value || '';
        const newPassword = document.getElementById('newPasswordInput').value;
        const confirmPassword = document.getElementById('confirmPasswordInput').value;
        const whatsappRaw = (document.getElementById('changePasswordWhatsApp')?.value || '').trim();
        const whatsappPrefix = (document.getElementById('changePasswordWhatsAppPrefix')?.value || '+54').trim();
        const errorDiv = document.getElementById('passwordError');

        // Si no es cambio obligatorio, exigir contrasena actual.
        if (!VIP.state.passwordChangePending && !currentPassword) {
            errorDiv.textContent = 'Ingresá tu contraseña actual';
            errorDiv.classList.add('show');
            return;
        }

        // Solo consideramos teléfono válido si está VERIFICADO vía OTP.
        const verifiedPhone = VIP.state.currentUser
            && VIP.state.currentUser.phoneVerified === true
            && VIP.state.currentUser.phone
            ? VIP.state.currentUser.phone
            : null;
        // Construir número completo solo si se ingresó uno nuevo
        const whatsappFull = whatsappRaw ? (whatsappPrefix + whatsappRaw.replace(/^0+/, '')) : '';

        errorDiv.textContent = '';
        errorDiv.classList.remove('show');

        if (newPassword !== confirmPassword) {
            errorDiv.textContent = 'Las contraseñas no coinciden';
            errorDiv.classList.add('show');
            return;
        }
        if (newPassword.length < 6) {
            errorDiv.textContent = 'La contraseña debe tener al menos 6 caracteres';
            errorDiv.classList.add('show');
            return;
        }

        const closeAllSessions = document.getElementById('closeAllSessions').checked;

        // CASO A: el usuario ya tiene un teléfono verificado y NO está cambiándolo.
        // No se requiere OTP. Solo se cambia la contraseña.
        if (verifiedPhone && !whatsappFull) {
            return _commitPasswordChange({
                currentPassword,
                newPassword,
                closeAllSessions,
                phone: null,
                otpCode: null,
                errorDiv
            });
        }

        // CASO B: se está agregando o cambiando teléfono → OTP obligatorio.
        if (!whatsappFull) {
            errorDiv.textContent = 'El número de WhatsApp es obligatorio (más de 10 dígitos con prefijo internacional)';
            errorDiv.classList.add('show');
            return;
        }
        const digits = whatsappFull.replace(/\D/g, '');
        if (digits.length <= 10) {
            errorDiv.textContent = 'El número de WhatsApp es obligatorio (más de 10 dígitos con prefijo internacional)';
            errorDiv.classList.add('show');
            return;
        }
        // Si el usuario solo está cambiando contraseña pero también escribió su mismo teléfono ya verificado,
        // tratar como CASO A (sin OTP).
        if (verifiedPhone && whatsappFull === verifiedPhone) {
            return _commitPasswordChange({
                currentPassword,
                newPassword,
                closeAllSessions,
                phone: null,
                otpCode: null,
                errorDiv
            });
        }

        // Pedir OTP al backend y mostrar paso 2.
        const submitBtn = document.getElementById('changePasswordSubmitBtn');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '📱 Enviando código...'; }
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/change-password/send-otp`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                },
                body: JSON.stringify({ phone: whatsappFull })
            });
            const data = await response.json();
            if (!response.ok) {
                errorDiv.textContent = data.error || 'No se pudo enviar el código SMS';
                errorDiv.classList.add('show');
                return;
            }
            // Guardar contexto pendiente y mostrar paso 2.
            _vipChangePwdPending = {
                currentPassword,
                newPassword,
                phone: whatsappFull,
                closeAllSessions
            };
            const form = document.getElementById('changePasswordForm');
            const otpStep = document.getElementById('changePasswordOtpStep');
            const otpMsg = document.getElementById('changePasswordOtpMsg');
            if (form) form.style.display = 'none';
            if (otpStep) otpStep.style.display = '';
            if (otpMsg) otpMsg.textContent = `Te enviamos un código SMS al ${data.phone || whatsappFull}. Ingresálo para confirmar el cambio.`;
            const otpErr = document.getElementById('changePasswordOtpError');
            if (otpErr) { otpErr.textContent = ''; otpErr.classList.remove('show'); }
            const otpCodeInput = document.getElementById('changePasswordOtpCode');
            if (otpCodeInput) { otpCodeInput.value = ''; setTimeout(() => otpCodeInput.focus(), 50); }
            _startChangePwdResendCooldown(60);
        } catch (err) {
            errorDiv.textContent = 'Error de conexión';
            errorDiv.classList.add('show');
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '💾 Guardar Cambios'; }
        }
    }

    async function _commitPasswordChange({ currentPassword, newPassword, closeAllSessions, phone, otpCode, errorDiv }) {
        try {
            const body = { newPassword, closeAllSessions };
            if (currentPassword) body.currentPassword = currentPassword;
            if (phone) {
                body.phone = phone;
                // Mantener `whatsapp` por compatibilidad con código existente.
                body.whatsapp = phone;
                body.otpCode = otpCode;
            }
            const response = await fetch(`${VIP.config.API_URL}/api/auth/change-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                },
                body: JSON.stringify(body)
            });
            const data = await response.json().catch(() => ({}));

            if (response.ok) {
                VIP.state.passwordChangePending = false;
                // Actualizar contraseña en memoria de sesión para el modal de plataforma
                VIP.state.sessionPassword = newPassword;
                // Reflejar el teléfono verificado en el estado local para no volver a pedirlo.
                if (data && data.phoneVerified && data.phone && VIP.state.currentUser) {
                    VIP.state.currentUser.phone = data.phone;
                    VIP.state.currentUser.phoneVerified = true;
                    VIP.state.currentUser.whatsapp = data.phone;
                }
                _vipChangePwdPending = null;
                _stopChangePwdResendCooldown();

                VIP.ui.hideModal('changePasswordModal');
                VIP.ui.showToast('✅ Contraseña guardada exitosamente', 'success');
                document.getElementById('newPasswordInput').value = '';
                document.getElementById('confirmPasswordInput').value = '';
                const wpInput = document.getElementById('changePasswordWhatsApp');
                if (wpInput) wpInput.value = '';
                const wpPrefix = document.getElementById('changePasswordWhatsAppPrefix');
                if (wpPrefix) wpPrefix.value = '+54';
                document.getElementById('closeAllSessions').checked = false;

                if (closeAllSessions) {
                    VIP.ui.showToast('🔒 Todas las sesiones han sido cerradas. Por favor, vuelve a iniciar sesión.', 'info');
                    setTimeout(() => {
                        localStorage.removeItem('userToken');
                        location.reload();
                    }, 2000);
                }
                return true;
            }

            const target = errorDiv || document.getElementById('changePasswordOtpError') || document.getElementById('passwordError');
            if (target) {
                target.textContent = (data && data.error) || 'Error al cambiar contraseña';
                target.classList.add('show');
            }
            return false;
        } catch (error) {
            const target = errorDiv || document.getElementById('changePasswordOtpError') || document.getElementById('passwordError');
            if (target) {
                target.textContent = 'Error de conexión';
                target.classList.add('show');
            }
            return false;
        }
    }

    async function handleChangePasswordOtpVerify() {
        const otpErr = document.getElementById('changePasswordOtpError');
        const verifyBtn = document.getElementById('changePasswordOtpVerifyBtn');
        if (otpErr) { otpErr.textContent = ''; otpErr.classList.remove('show'); }

        if (!_vipChangePwdPending) {
            if (otpErr) {
                otpErr.textContent = 'Sesión de verificación expirada. Volvé a iniciar el cambio.';
                otpErr.classList.add('show');
            }
            return;
        }
        const code = (document.getElementById('changePasswordOtpCode')?.value || '').trim();
        if (!code || code.length < 6) {
            if (otpErr) {
                otpErr.textContent = 'Ingresá el código de 6 dígitos';
                otpErr.classList.add('show');
            }
            return;
        }
        if (verifyBtn) { verifyBtn.disabled = true; verifyBtn.textContent = 'Verificando...'; }
        const ok = await _commitPasswordChange({
            currentPassword: _vipChangePwdPending.currentPassword,
            newPassword: _vipChangePwdPending.newPassword,
            closeAllSessions: _vipChangePwdPending.closeAllSessions,
            phone: _vipChangePwdPending.phone,
            otpCode: code,
            errorDiv: otpErr
        });
        if (verifyBtn) { verifyBtn.disabled = false; verifyBtn.textContent = '✅ Verificar y Guardar'; }
        // Si falló (p. ej. OTP incorrecto), el backend ya gestiona los 3 intentos vía OtpCode.
        // El usuario puede reintentar o pedir un nuevo código con el botón de reenvío.
        if (!ok) {
            const codeInput = document.getElementById('changePasswordOtpCode');
            if (codeInput) { codeInput.value = ''; codeInput.focus(); }
        }
    }

    async function handleChangePasswordOtpResend() {
        const otpErr = document.getElementById('changePasswordOtpError');
        if (!_vipChangePwdPending) {
            if (otpErr) {
                otpErr.textContent = 'Sesión de verificación expirada. Volvé a iniciar el cambio.';
                otpErr.classList.add('show');
            }
            return;
        }
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/change-password/send-otp`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                },
                body: JSON.stringify({ phone: _vipChangePwdPending.phone })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                if (otpErr) {
                    otpErr.textContent = (data && data.error) || 'No se pudo reenviar el código';
                    otpErr.classList.add('show');
                }
                return;
            }
            const otpMsg = document.getElementById('changePasswordOtpMsg');
            if (otpMsg) otpMsg.textContent = `Te reenviamos el código SMS al ${data.phone || _vipChangePwdPending.phone}.`;
            _startChangePwdResendCooldown(60);
        } catch (err) {
            if (otpErr) {
                otpErr.textContent = 'Error de conexión';
                otpErr.classList.add('show');
            }
        }
    }

    function handleChangePasswordOtpBack() {
        _vipChangePwdPending = null;
        _stopChangePwdResendCooldown();
        const otpStep = document.getElementById('changePasswordOtpStep');
        const form = document.getElementById('changePasswordForm');
        if (otpStep) otpStep.style.display = 'none';
        if (form) form.style.display = '';
        const otpErr = document.getElementById('changePasswordOtpError');
        if (otpErr) { otpErr.textContent = ''; otpErr.classList.remove('show'); }
    }

    // Estado temporal del reset OTP
    let _vipResetOtpPhone = null;
    let _vipResetToken = null;

    async function handleFindUserByPhone(e) {
        // ELIMINADO: Este endpoint permitía enumerar usuarios.
        // El reset de contraseña ahora usa flujo OTP seguro (anti-enumeration).
        if (e) e.preventDefault();
    }

    async function handleRequestPasswordReset() {
        const phonePrefix = document.getElementById('resetPhonePrefix').value;
        const phoneNumber = document.getElementById('resetPassPhone').value.trim();
        const resultDiv = document.getElementById('resetStep1Result');

        if (resultDiv) resultDiv.style.display = 'none';

        if (!phoneNumber || phoneNumber.replace(/\D/g, '').length < 8) {
            if (resultDiv) {
                resultDiv.textContent = 'Ingresá un número de teléfono válido (mínimo 8 dígitos)';
                resultDiv.style.background = 'rgba(255, 68, 68, 0.2)';
                resultDiv.style.color = '#ff4444';
                resultDiv.style.display = 'block';
            }
            return;
        }

        const fullPhone = phonePrefix + phoneNumber.replace(/[\s\-().]/g, '');
        _vipResetOtpPhone = fullPhone;

        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/request-password-reset`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: fullPhone })
            });
            const data = await response.json();

            document.getElementById('resetStep1').style.display = 'none';
            document.getElementById('resetStep2').style.display = '';
            document.getElementById('resetStep2Msg').textContent = data.message || 'Si este número está vinculado a una cuenta, recibirás un código SMS.';
            document.getElementById('resetOtpCode').value = '';
            const errDiv = document.getElementById('resetStep2Error');
            if (errDiv) errDiv.style.display = 'none';
        } catch (error) {
            if (resultDiv) {
                resultDiv.textContent = 'Error de conexión. Intenta más tarde.';
                resultDiv.style.background = 'rgba(255, 68, 68, 0.2)';
                resultDiv.style.color = '#ff4444';
                resultDiv.style.display = 'block';
            }
        }
    }

    async function handleVerifyResetOtp() {
        const code = document.getElementById('resetOtpCode').value.trim();
        const errDiv = document.getElementById('resetStep2Error');

        if (errDiv) errDiv.style.display = 'none';

        if (!code || code.length < 6) {
            if (errDiv) { errDiv.textContent = 'Ingresá el código de 6 dígitos'; errDiv.style.display = 'block'; }
            return;
        }

        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/verify-reset-otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: _vipResetOtpPhone, code })
            });
            const data = await response.json();

            if (response.ok && data.success) {
                _vipResetToken = data.resetToken;
                document.getElementById('resetStep2').style.display = 'none';
                document.getElementById('resetStep3').style.display = '';
                document.getElementById('resetStep3Username').textContent = `👤 Usuario: ${escapeHtml(data.username)}`;
                document.getElementById('resetPassNew').value = '';
                document.getElementById('resetPassConfirm').value = '';
                const errDiv3 = document.getElementById('resetStep3Error');
                if (errDiv3) errDiv3.style.display = 'none';
            } else {
                if (errDiv) { errDiv.textContent = data.error || 'Código incorrecto o expirado'; errDiv.style.display = 'block'; }
            }
        } catch (error) {
            if (errDiv) { errDiv.textContent = 'Error de conexión. Intenta más tarde.'; errDiv.style.display = 'block'; }
        }
    }

    async function handleResetPasswordByPhone(e) {
        // MANTENIDO por compatibilidad con HTML (resetPassForm) - redirige al nuevo flujo OTP
        if (e) e.preventDefault();
        // El nuevo flujo usa handleRequestPasswordReset, handleVerifyResetOtp, handleCompletePasswordReset
    }

    async function handleCompletePasswordReset() {
        const newPassword = document.getElementById('resetPassNew').value;
        const confirmPassword = document.getElementById('resetPassConfirm').value;
        const resultDiv = document.getElementById('resetPassResult');
        const errDiv = document.getElementById('resetStep3Error');

        if (errDiv) errDiv.style.display = 'none';
        if (resultDiv) resultDiv.style.display = 'none';

        if (newPassword.length < 6) {
            if (errDiv) { errDiv.textContent = 'La contraseña debe tener al menos 6 caracteres'; errDiv.style.display = 'block'; }
            return;
        }
        if (newPassword !== confirmPassword) {
            if (errDiv) { errDiv.textContent = 'Las contraseñas no coinciden'; errDiv.style.display = 'block'; }
            return;
        }

        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/complete-password-reset`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ resetToken: _vipResetToken, newPassword })
            });
            const data = await response.json();

            if (data.success) {
                _vipResetToken = null;
                _vipResetOtpPhone = null;
                if (resultDiv) {
                    resultDiv.innerHTML = `<p style="color: #00ff88; font-size: 16px; font-weight: bold; text-align:center;">✅ Contraseña cambiada exitosamente</p><p style="color: #888; font-size: 12px; text-align:center;">Ya puedes iniciar sesión con tu nueva contraseña</p>`;
                    resultDiv.style.background = 'rgba(0, 255, 136, 0.2)';
                    resultDiv.style.display = 'block';
                }
                document.getElementById('resetStep3').style.display = 'none';
            } else {
                if (errDiv) { errDiv.textContent = data.error || 'Error al cambiar contraseña'; errDiv.style.display = 'block'; }
            }
        } catch (error) {
            if (errDiv) { errDiv.textContent = 'Error de conexión. Intenta más tarde.'; errDiv.style.display = 'block'; }
        }
    }

    function switchLoginMode(mode) {
        window._loginMode = mode;
        const usernameGroup = document.getElementById('loginUsernameGroup');
        const phoneGroup = document.getElementById('loginPhoneGroup');
        const usernameBtn = document.getElementById('loginByUsernameBtn');
        const phoneBtn = document.getElementById('loginByPhoneBtn');
        const usernameInput = document.getElementById('username');
        const phoneLoginModeToggle = document.getElementById('phoneLoginModeToggle');
        const phoneOtpStep = document.getElementById('phoneOtpStep');
        // iOS Safari < 15.4 no soporta `:has()` y tira SyntaxError en querySelector — eso abortaba
        // el handler y dejaba el toggle "Celular" sin responder al tap. Resolvemos el grupo
        // navegando desde el input por id hasta su `.input-group` ancestro (compatible siempre).
        const passwordInputEl = document.getElementById('password');
        const passwordGroup = passwordInputEl ? passwordInputEl.closest('.input-group') : null;
        const submitBtn = document.querySelector('#loginForm button[type="submit"]');

        if (mode === 'phone') {
            if (usernameGroup) usernameGroup.classList.add('hidden');
            if (phoneGroup) phoneGroup.classList.remove('hidden');
            if (usernameInput) usernameInput.removeAttribute('required');
            if (usernameBtn) { usernameBtn.style.background = 'transparent'; usernameBtn.style.color = '#888'; usernameBtn.style.fontWeight = 'normal'; }
            if (phoneBtn) { phoneBtn.style.background = 'rgba(212,175,55,0.2)'; phoneBtn.style.color = '#d4af37'; phoneBtn.style.fontWeight = '600'; }
            if (phoneLoginModeToggle) phoneLoginModeToggle.classList.remove('hidden');
        } else {
            if (usernameGroup) usernameGroup.classList.remove('hidden');
            if (phoneGroup) phoneGroup.classList.add('hidden');
            if (usernameInput) usernameInput.setAttribute('required', '');
            if (usernameBtn) { usernameBtn.style.background = 'rgba(212,175,55,0.2)'; usernameBtn.style.color = '#d4af37'; usernameBtn.style.fontWeight = '600'; }
            if (phoneBtn) { phoneBtn.style.background = 'transparent'; phoneBtn.style.color = '#888'; phoneBtn.style.fontWeight = 'normal'; }
            if (phoneLoginModeToggle) phoneLoginModeToggle.classList.add('hidden');
            if (phoneOtpStep) phoneOtpStep.classList.add('hidden');
            // Reset phone login mode to password
            window._phoneLoginMode = 'password';
            if (passwordGroup) passwordGroup.style.display = '';
            if (submitBtn) submitBtn.textContent = 'Ingresar a la Sala';
            if (submitBtn) submitBtn.style.display = '';
        }
    }

    return {
        checkUsernameAvailability,
        handleRegister,
        handleRegisterSendOtp,
        handleRegisterWithOtp,
        handleLogin,
        verifyToken,
        handleLogout,
        ensureUserLoaded,
        initializeSession,
        handleChangePassword,
        handleChangePasswordOtpVerify,
        handleChangePasswordOtpResend,
        handleChangePasswordOtpBack,
        handleFindUserByPhone,
        handleResetPasswordByPhone,
        handleRequestPasswordReset,
        handleVerifyResetOtp,
        handleCompletePasswordReset,
        prepareChangePasswordModal,
        switchLoginMode,
        renderRefundsHomeUI,
        refreshLinePhone,
        applyPromoAlertIfActive
    };

})();

// Window aliases for any HTML onclick / external callers
window.applyPromoAlertIfActive = VIP.auth.applyPromoAlertIfActive;
window.checkUsernameAvailability = VIP.auth.checkUsernameAvailability;
window.handleRegisterSendOtp = VIP.auth.handleRegisterSendOtp;
window.handleRegisterWithOtp = VIP.auth.handleRegisterWithOtp;
window.handleRequestPasswordReset = VIP.auth.handleRequestPasswordReset;
window.handleVerifyResetOtp = VIP.auth.handleVerifyResetOtp;
window.handleCompletePasswordReset = VIP.auth.handleCompletePasswordReset;
window.switchLoginMode = VIP.auth.switchLoginMode;

// Phone login OTP mode functions (global scope for onclick handlers)
window._phoneLoginMode = 'password';
window._phoneOtpFullPhone = null;

window.switchPhoneLoginMode = function(mode) {
    window._phoneLoginMode = mode;
    // iOS Safari < 15.4 no soporta `:has()` — usar closest desde el input por id (ver fix en switchLoginMode).
    var passwordInputEl = document.getElementById('password');
    var passwordGroup = passwordInputEl ? passwordInputEl.closest('.input-group') : null;
    var submitBtn = document.querySelector('#loginForm button[type="submit"]');
    var otpStep = document.getElementById('phoneOtpStep');
    var passwordBtn = document.getElementById('phoneLoginByPassword');
    var otpBtn = document.getElementById('phoneLoginByOtp');

    if (mode === 'otp') {
        if (passwordGroup) passwordGroup.style.display = 'none';
        if (submitBtn) submitBtn.textContent = '📱 Enviar código SMS';
        if (otpStep) otpStep.classList.add('hidden');
        if (passwordBtn) { passwordBtn.style.background = 'transparent'; passwordBtn.style.color = '#888'; passwordBtn.style.fontWeight = 'normal'; }
        if (otpBtn) { otpBtn.style.background = 'rgba(212,175,55,0.2)'; otpBtn.style.color = '#d4af37'; otpBtn.style.fontWeight = '600'; }
    } else {
        if (passwordGroup) passwordGroup.style.display = '';
        if (submitBtn) submitBtn.textContent = 'Ingresar a la Sala';
        if (otpStep) otpStep.classList.add('hidden');
        if (passwordBtn) { passwordBtn.style.background = 'rgba(212,175,55,0.2)'; passwordBtn.style.color = '#d4af37'; passwordBtn.style.fontWeight = '600'; }
        if (otpBtn) { otpBtn.style.background = 'transparent'; otpBtn.style.color = '#888'; otpBtn.style.fontWeight = 'normal'; }
    }
};

window.handlePhoneOtpVerify = async function() {
    var code = document.getElementById('phoneOtpCode').value.trim();
    var errorDiv = document.getElementById('errorMessage');
    var verifyBtn = document.getElementById('phoneOtpVerifyBtn');

    if (!code || code.length < 6) {
        errorDiv.textContent = 'Ingresá el código de 6 dígitos';
        errorDiv.classList.add('show');
        return;
    }

    if (verifyBtn) { verifyBtn.textContent = 'Verificando...'; verifyBtn.disabled = true; }

    try {
        var response = await fetch((VIP.config.API_URL || '') + '/api/auth/login-otp-verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: window._phoneOtpFullPhone, code: code })
        });
        var data = await response.json();

        if (response.ok && data.token) {
            VIP.state.currentToken = data.token;
            VIP.state.currentUser = { ...data.user, id: data.user.id, userId: data.user.id };
            localStorage.setItem('userToken', VIP.state.currentToken);
            await VIP.auth.initializeSession(false);
            VIP.notifications.sendFcmTokenAfterLogin();
        } else {
            errorDiv.textContent = data.error || 'Código incorrecto o expirado';
            errorDiv.classList.add('show');
        }
    } catch (error) {
        errorDiv.textContent = 'Error de conexión';
        errorDiv.classList.add('show');
    } finally {
        if (verifyBtn) { verifyBtn.textContent = '✅ Verificar código'; verifyBtn.disabled = false; }
    }
};

// ============================================================
// Global fetch interceptor: detect server-side enforcement of
// mandatory password change (HTTP 403 with `code: MUST_CHANGE_PASSWORD`).
//
// This covers the "reload bypass" attack: even if the user reloads the page
// or tries to call any authenticated API directly, the server returns 403
// for non-allow-listed endpoints while `user.mustChangePassword === true`.
// We catch that response globally, flip the in-memory flag, and re-open
// the mandatory change modal.
// ============================================================
(function installMustChangePasswordInterceptor() {
    if (typeof window === 'undefined' || !window.fetch || window.__vipMustChangePasswordInterceptorInstalled) {
        return;
    }
    window.__vipMustChangePasswordInterceptorInstalled = true;

    const originalFetch = window.fetch.bind(window);

    window.fetch = async function (...args) {
        const response = await originalFetch(...args);
        try {
            if (response && response.status === 403) {
                // Clone so the original consumer can still read the body.
                const clone = response.clone();
                const contentType = clone.headers.get('content-type') || '';
                if (contentType.indexOf('application/json') !== -1) {
                    const body = await clone.json().catch(() => null);
                    if (body && body.code === 'MUST_CHANGE_PASSWORD') {
                        // Only re-prepare the modal the first time we see the
                        // server-side enforcement. Otherwise repeated background
                        // requests (balance polling, fire status, etc.) would
                        // keep resetting the OTP step while the user types it.
                        if (!VIP.state.passwordChangePending) {
                            VIP.state.passwordChangePending = true;
                            try {
                                if (VIP.auth && typeof VIP.auth.prepareChangePasswordModal === 'function') {
                                    VIP.auth.prepareChangePasswordModal();
                                }
                            } catch (e) { /* ignore */ }
                            try {
                                if (VIP.ui && typeof VIP.ui.showModal === 'function') {
                                    VIP.ui.showModal('changePasswordModal');
                                }
                            } catch (e) { /* ignore */ }
                        }
                    }
                }
            }
        } catch (e) {
            // Never let the interceptor break the original request flow.
        }
        return response;
    };
})();

// Helpers para el botón "Crea tu usuario" del login. Consulta a /api/teams/lookup
// con el nombre que escribe el usuario (ej: "atomic") y muestra los botones de
// WhatsApp línea principal + comunidad del equipo que matcheó.
// Cache del contacto de soporte (lazy-loaded). Lo cargamos al abrir el modal
// y al mostrar el chatScreen para evitar request inútil en backgrounds.
window._supportPhoneCache = null;
window._supportLabelCache = null;
window._supportTelegramCache = null;
window.loadSupportPhone = async function loadSupportPhone() {
    if (window._supportPhoneCache && window._supportTelegramCache) return window._supportPhoneCache;
    try {
        var resp = await fetch('/api/config/support-phone');
        var data = await resp.json().catch(function () { return {}; });
        if (data && data.phone)    window._supportPhoneCache    = String(data.phone).replace(/[^0-9]/g, '');
        if (data && data.label)    window._supportLabelCache    = data.label;
        if (data && data.telegram) window._supportTelegramCache = String(data.telegram).replace(/^@/, '');
    } catch (_) { /* fallback abajo */ }
    if (!window._supportPhoneCache)    window._supportPhoneCache    = '5491155176883';
    if (!window._supportLabelCache)    window._supportLabelCache    = 'Soporte';
    if (!window._supportTelegramCache) window._supportTelegramCache = 'VIP_SOPORTE';
    return window._supportPhoneCache;
};

window.applySupportPhoneToUI = async function applySupportPhoneToUI() {
    await window.loadSupportPhone();
    var phone = window._supportPhoneCache;
    var tgHandle = window._supportTelegramCache;
    var waMsg = encodeURIComponent('Hola, necesito ayuda con mi cuenta de Reembolsos.');
    var waUrl = phone ? ('https://wa.me/' + phone + '?text=' + waMsg) : '#';
    var tgUrl = tgHandle ? ('https://t.me/' + tgHandle) : '#';

    // Helper para asignar href si el elemento existe.
    function setHref(id, href) { var el = document.getElementById(id); if (el) el.href = href; }

    // 1) Barra top-center post-login (centrada, con label "Soporte").
    var topWrap = document.getElementById('supportTopWrap');
    setHref('supportTopBadge', waUrl);
    setHref('supportTopTgBadge', tgUrl);
    if (topWrap) {
        var chatScreen = document.getElementById('chatScreen');
        var loggedIn = chatScreen && !chatScreen.classList.contains('hidden');
        topWrap.style.display = loggedIn ? 'inline-flex' : 'none';
        // Botón de info importante: se muestra/oculta junto con la barra.
        var infoBtn = document.getElementById('infoImportantBtn');
        if (infoBtn) infoBtn.style.display = loggedIn ? 'inline-flex' : 'none';
        // Fondo negro detrás de la barra fija (misma visibilidad).
        var topBackdrop = document.getElementById('topFixedBackdrop');
        if (topBackdrop) topBackdrop.style.display = loggedIn ? 'block' : 'none';
    }
    // 2) Botones dentro del modal "Buscar usuario".
    setHref('createUserHelpSupportBtn',  waUrl);
    setHref('createUserHelpSupportTgBtn', tgUrl);
    // 3) Botones de soporte en el login (visible siempre).
    setHref('loginSupportWaBtn', waUrl);
    setHref('loginSupportTgBtn', tgUrl);
};

// Auto-cargar los hrefs de soporte del login apenas haya DOM.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
        try { window.applySupportPhoneToUI(); } catch (_) {}
        try { _showDeviceLoginNotice(); } catch (_) {}
    });
} else {
    try { window.applySupportPhoneToUI(); } catch (_) {}
    try { _showDeviceLoginNotice(); } catch (_) {}
}

window.showCreateUserHelp = function showCreateUserHelp() {
    try {
        if (window.VIP && VIP.ui && typeof VIP.ui.showModal === 'function') {
            VIP.ui.showModal('createUserHelpModal');
        } else if (typeof window.showModal === 'function') {
            window.showModal('createUserHelpModal');
        }
        window.resetCreateUserHelp();
        // Cargar soporte al abrir el modal (sino el botón queda con href="#")
        try { window.applySupportPhoneToUI(); } catch (_) {}
        setTimeout(function () {
            var inp = document.getElementById('createUserHelpTeamInput');
            if (inp) inp.focus();
        }, 80);
    } catch (e) { /* ignore */ }
};

window.resetCreateUserHelp = function resetCreateUserHelp() {
    try {
        var step1 = document.getElementById('createUserHelpStep1');
        var step2 = document.getElementById('createUserHelpStep2');
        var err = document.getElementById('createUserHelpError');
        var inp = document.getElementById('createUserHelpTeamInput');
        if (step1) step1.style.display = '';
        if (step2) step2.style.display = 'none';
        if (err) { err.textContent = ''; err.style.display = 'none'; }
        if (inp) inp.value = '';
    } catch (e) { /* ignore */ }
};

window.submitCreateUserHelp = async function submitCreateUserHelp() {
    var inp = document.getElementById('createUserHelpTeamInput');
    var err = document.getElementById('createUserHelpError');
    var btn = document.getElementById('createUserHelpSearchBtn');
    if (!inp) return;
    var q = (inp.value || '').trim();
    if (err) { err.textContent = ''; err.style.display = 'none'; }
    if (!q) {
        if (err) { err.textContent = 'Escribí el nombre de tu equipo.'; err.style.display = 'block'; }
        return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Buscando...'; }
    try {
        var resp = await fetch('/api/teams/lookup?q=' + encodeURIComponent(q));
        var data = await resp.json().catch(function () { return {}; });
        if (!resp.ok || !data || !data.linePhone) {
            if (err) {
                err.textContent = (data && data.error) || 'No encontramos tu equipo. Probá con el nombre completo.';
                err.style.display = 'block';
            }
            return;
        }
        var teamLabel = data.teamName || ('Prefijo ' + (data.prefix || '').toUpperCase());
        var phoneRaw = String(data.linePhone || '').replace(/[^0-9]/g, '');
        var waMsg = encodeURIComponent('Perdi mi usuario con ustedes, me lo podrian buscar y pasarmelo por favor para entrar a su pagina');
        var waUrl = phoneRaw ? ('https://wa.me/' + phoneRaw + '?text=' + waMsg) : '#';

        var nameEl = document.getElementById('createUserHelpTeamName');
        var lineBtn = document.getElementById('createUserHelpLineBtn');
        var commBtn = document.getElementById('createUserHelpCommunityBtn');
        var commBtn2 = document.getElementById('createUserHelpCommunityBtn2');
        if (nameEl) nameEl.textContent = teamLabel;
        if (lineBtn) lineBtn.href = waUrl;
        if (commBtn) {
            if (data.communityLink) {
                commBtn.href = data.communityLink;
                commBtn.textContent = '📣 ' + (data.communityLabel || 'Sumate al canal de Telegram');
                commBtn.style.display = '';
            } else {
                commBtn.style.display = 'none';
            }
        }
        if (commBtn2) {
            if (data.communityLink2) {
                commBtn2.href = data.communityLink2;
                commBtn2.textContent = '📣 ' + (data.communityLabel2 || 'Segundo canal de Telegram');
                commBtn2.style.display = '';
            } else {
                commBtn2.style.display = 'none';
            }
        }
        var step1 = document.getElementById('createUserHelpStep1');
        var step2 = document.getElementById('createUserHelpStep2');
        if (step1) step1.style.display = 'none';
        if (step2) step2.style.display = '';
    } catch (e) {
        if (err) {
            err.textContent = 'Error de conexión. Revisá tu internet e intentá de nuevo.';
            err.style.display = 'block';
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔎 Buscar mi equipo'; }
    }
};
