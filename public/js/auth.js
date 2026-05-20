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

    async function handleRegister(e) {
        if (e) e.preventDefault();
        return handleRegisterDirect();
    }

    // Muestra (una sola vez, al primer ingreso) el modal que ofrece verificar
    // el teléfono por SMS. Es 100% opcional: solo busca empujar a asegurar la
    // cuenta. No se muestra si el teléfono ya está verificado.
    function maybeOfferSmsVerification(user) {
        if (!user) return;
        if (user.role && user.role !== 'user') return;
        if (user.phoneVerified === true) return;
        if (user.firstLogin !== true) return;
        const key = 'vip_smsOfferShown_' + String(user.username || '').toLowerCase();
        try {
            if (localStorage.getItem(key)) return;
            localStorage.setItem(key, '1');
        } catch (e) { /* localStorage no disponible: igual ofrecemos una vez */ }
        setTimeout(function () {
            try { VIP.ui.showModal('smsOfferModal'); } catch (e) { /* noop */ }
        }, 1200);
    }

    // Muestra/oculta el cartel de atención del home. Visible para todo usuario
    // con el teléfono sin verificar — el retiro exige verificación por SMS.
    function refreshVerifyPhoneBanner() {
        const banner = document.getElementById('verifyPhoneBanner');
        if (!banner) return;
        const user = VIP.state.currentUser;
        const needsVerify = user && (!user.role || user.role === 'user') && user.phoneVerified !== true;
        banner.style.display = needsVerify ? '' : 'none';
    }

    // Registro directo: solo usuario + contraseña, sin SMS. Si hay una pauta
    // activa, también manda campaignCode/utm para conservar la atribución.
    async function handleRegisterDirect() {
        const username = document.getElementById('registerUsername').value.trim();
        const password = document.getElementById('registerPassword').value;
        const passwordConfirm = document.getElementById('registerPasswordConfirm').value;
        const emailInput = document.getElementById('registerEmail');
        const email = emailInput ? emailInput.value.trim() : '';
        const referralInput = document.getElementById('registerReferralCode');
        const errorDiv = document.getElementById('registerError');
        const btn = document.getElementById('registerSendOtpBtn');

        errorDiv.classList.remove('show');

        if (username.length < 3) {
            errorDiv.textContent = 'El usuario debe tener al menos 3 caracteres';
            errorDiv.classList.add('show');
            return;
        }
        if (password.length < 6) {
            errorDiv.textContent = 'La contraseña debe tener al menos 6 caracteres';
            errorDiv.classList.add('show');
            return;
        }
        if (password !== passwordConfirm) {
            errorDiv.textContent = 'Las contraseñas no coinciden';
            errorDiv.classList.add('show');
            return;
        }

        const attribution = VIP.campaign ? VIP.campaign.getActive() : null;
        // El código de referido solo cuenta si NO vino por una pauta: en el
        // flujo de pauta la campaña es la atribución relevante.
        const referralCode = (!attribution && referralInput)
            ? referralInput.value.trim().toUpperCase()
            : null;

        if (btn) { btn.textContent = 'Creando cuenta...'; btn.disabled = true; }

        try {
            const metaEventId = VIP.pixel && VIP.pixel.enabled ? VIP.pixel.newEventId() : null;
            const response = await fetch(`${VIP.config.API_URL}/api/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username,
                    password,
                    email: email || null,
                    referralCode: referralCode || undefined,
                    metaEventId,
                    campaignCode: attribution ? attribution.code : undefined,
                    utm: attribution ? attribution.utm : undefined,
                    fbc: (VIP.campaign && VIP.campaign.getFbc()) || undefined,
                    fbp: (VIP.campaign && VIP.campaign.getFbp()) || undefined,
                    landingUrl: (VIP.campaign && VIP.campaign.getLandingUrl()) || undefined
                })
            });
            const data = await response.json();

            if (response.ok) {
                VIP.state.currentToken = data.token;
                VIP.state.currentUser = { ...data.user, id: data.user.id, userId: data.user.id };
                localStorage.setItem('userToken', VIP.state.currentToken);

                VIP.ui.hideModal('registerModal');
                const form = document.getElementById('registerForm');
                if (form) form.reset();
                const checkResult = document.getElementById('usernameCheckResult');
                if (checkResult) checkResult.textContent = '';

                await initializeSession(true);
                console.log('[FCM] Registro exitoso, enviando token FCM...');
                await VIP.notifications.sendFcmTokenAfterLogin();

                // Meta Pixel — CompleteRegistration (conversión clave, deduplicada con CAPI).
                if (VIP.pixel) VIP.pixel.trackWithId(metaEventId, 'CompleteRegistration', Object.assign(
                    { content_name: 'signup', status: true, referred: Boolean(referralCode) },
                    VIP.campaign ? VIP.campaign.getActiveCustomData() : {}
                ));

                VIP.ui.showToast('✅ ¡Cuenta creada exitosamente!', 'success');
                maybeOfferSmsVerification(data.user);
            } else {
                errorDiv.textContent = data.error || 'Error al crear cuenta';
                errorDiv.classList.add('show');
            }
        } catch (error) {
            errorDiv.textContent = 'Error de conexión. Intenta más tarde.';
            errorDiv.classList.add('show');
        } finally {
            if (btn) { btn.textContent = '📝 Crear Cuenta'; btn.disabled = false; }
        }
    }

    async function handleLogin(e) {
        e.preventDefault();

        const loginMode = window._loginMode || 'username';
        const username = loginMode === 'username' ? document.getElementById('username').value : null;
        const phonePrefix = loginMode === 'phone' ? (document.getElementById('loginPhonePrefix')?.value || '+54') : null;
        const phoneNumber = loginMode === 'phone' ? document.getElementById('loginPhone')?.value?.trim() : null;
        const phone = loginMode === 'phone' ? (phonePrefix + (phoneNumber || '').replace(/\D/g, '')) : null;
        const password = document.getElementById('password').value;
        const usernameLoginMode = window._usernameLoginMode || 'password';
        const temporaryCode = (loginMode === 'username' && usernameLoginMode === 'temporal')
            ? (document.getElementById('temporalCode')?.value || '').trim()
            : null;
        const errorDiv = document.getElementById('errorMessage');
        const loginBtn = document.querySelector('#loginForm button[type="submit"]');

        if (loginMode === 'phone' && (!phoneNumber || phoneNumber.replace(/\D/g, '').length < 7)) {
            errorDiv.textContent = 'Ingresá un número de celular válido';
            errorDiv.classList.add('show');
            return;
        }

        if (loginMode === 'username' && !username) {
            errorDiv.textContent = 'Ingresá tu usuario';
            errorDiv.classList.add('show');
            return;
        }

        if (loginMode === 'username' && usernameLoginMode === 'temporal' && (!temporaryCode || temporaryCode.length < 6)) {
            errorDiv.textContent = 'Ingresá el código temporal de 6 dígitos';
            errorDiv.classList.add('show');
            return;
        }

        if (loginBtn) { loginBtn.textContent = 'Ingresando...'; loginBtn.disabled = true; }
        errorDiv.classList.remove('show');

        const loginTimeout = setTimeout(() => {
            errorDiv.textContent = 'Tiempo de espera agotado. Intenta nuevamente.';
            errorDiv.classList.add('show');
            if (loginBtn) { loginBtn.textContent = 'Ingresar a la Sala'; loginBtn.disabled = false; }
        }, 15000);

        try {
            // OTP login flow for phone mode
            if (loginMode === 'phone' && window._phoneLoginMode === 'otp') {
                const response = await fetch(`${VIP.config.API_URL}/api/auth/login-otp-request`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone })
                });
                const data = await response.json();
                if (response.ok && data.success) {
                    window._phoneOtpFullPhone = phone;
                    document.getElementById('phoneOtpMsg').textContent = `✅ ${data.message}`;
                    document.getElementById('phoneOtpStep').classList.remove('hidden');
                    document.getElementById('phoneOtpCode').value = '';
                    if (loginBtn) loginBtn.style.display = 'none';
                } else {
                    errorDiv.textContent = data.error || 'Error al enviar código';
                    errorDiv.classList.add('show');
                }
                clearTimeout(loginTimeout);
                if (loginBtn) { loginBtn.textContent = '📱 Enviar código SMS'; loginBtn.disabled = false; }
                return;
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            const metaEventId = VIP.pixel && VIP.pixel.enabled ? VIP.pixel.newEventId() : null;
            let loginPayload;
            if (loginMode === 'phone') {
                loginPayload = { phone, password, metaEventId };
            } else if (usernameLoginMode === 'temporal') {
                loginPayload = { username, temporaryCode, metaEventId };
            } else {
                loginPayload = { username, password, metaEventId };
            }

            // Atribución last-touch: si el visitante volvió por un nuevo
            // anuncio, mandamos fbc/fbp/landingUrl para que el server
            // actualice los campos del User y futuras conversiones (Purchase,
            // etc.) se atribuyan al click más reciente.
            if (VIP.campaign) {
                loginPayload.fbc = VIP.campaign.getFbc() || undefined;
                loginPayload.fbp = VIP.campaign.getFbp() || undefined;
                loginPayload.landingUrl = VIP.campaign.getLandingUrl() || undefined;
            }

            const response = await fetch(`${VIP.config.API_URL}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(loginPayload),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            clearTimeout(loginTimeout);

            const data = await response.json();

            if (response.ok) {
                VIP.state.currentToken = data.token;
                VIP.state.currentUser = { ...data.user, id: data.user.id, userId: data.user.id };
                localStorage.setItem('userToken', VIP.state.currentToken);

                // Meta Pixel — Login (custom, deduplicado con CAPI). Sólo si es usuario final.
                if (VIP.pixel && data.user && data.user.role === 'user') {
                    VIP.pixel.trackWithId(metaEventId, 'Login', { content_name: 'login' });
                }

                // Guardar contraseña en memoria de sesión para mostrarla en el modal de plataforma
                VIP.state.sessionPassword = password;

                // Guardar token de JUGAYGANA en sessionStorage (expira al cerrar el navegador)
                if (data.jugayganaToken) {
                    VIP.state.jugayganaToken = data.jugayganaToken;
                    sessionStorage.setItem('jugayganaToken', data.jugayganaToken);
                } else {
                    VIP.state.jugayganaToken = null;
                    sessionStorage.removeItem('jugayganaToken');
                }

                try {
                    await initializeSession(false);
                } catch (initError) {
                    console.error('Error inicializando sesión:', initError);
                }

                if (data.user.needsPasswordChange || data.user.mustChangePassword === true) {
                    VIP.state.passwordChangePending = true;
                    prepareChangePasswordModal();
                    VIP.ui.showModal('changePasswordModal');
                } else {
                    // Primer ingreso sin teléfono verificado: ofrecer el SMS.
                    maybeOfferSmsVerification(data.user);
                }

                VIP.notifications.requestNotificationPermission();
                VIP.notifications.sendFcmTokenAfterLogin();
            } else {
                errorDiv.textContent = data.error || 'Error de autenticación';
                errorDiv.classList.add('show');
            }
        } catch (error) {
            clearTimeout(loginTimeout);
            if (error.name === 'AbortError') {
                errorDiv.textContent = 'La conexión tardó demasiado. Intenta nuevamente.';
            } else {
                errorDiv.textContent = 'Error de conexión';
            }
            errorDiv.classList.add('show');
        } finally {
            if (loginBtn) {
                loginBtn.textContent = window._phoneLoginMode === 'otp' && loginMode === 'phone' ? '📱 Enviar código SMS' : 'Ingresar a la Sala';
                loginBtn.disabled = false;
            }
        }
    }

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
                VIP.socket.startMessagePolling();
                VIP.refunds.loadRefundStatus();
                VIP.fire.loadFireStatus();

                // Server-side enforcement: if the user must change their
                // password (flag persisted in DB), re-open the mandatory
                // change modal even after a page reload.
                if (VIP.state.currentUser && VIP.state.currentUser.mustChangePassword === true) {
                    VIP.state.passwordChangePending = true;
                    try { prepareChangePasswordModal(); } catch (e) { /* DOM not ready */ }
                    try { VIP.ui.showModal('changePasswordModal'); } catch (e) { /* ignore */ }
                }

                VIP.notifications.requestNotificationPermission();
                VIP.notifications.sendFcmTokenAfterLogin().catch(function (e) {
                    console.warn('[FCM] Error al re-sincronizar token en verifyToken:', e);
                });
            } else {
                localStorage.removeItem('userToken');
            }
        } catch (error) {
            console.error('Error verificando token:', error);
            localStorage.removeItem('userToken');
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
        VIP.socket.startMessagePolling();
        VIP.refunds.loadRefundStatus();
        VIP.fire.loadFireStatus();
        VIP.ui.loadCanalInformativoUrl();
        refreshVerifyPhoneBanner();
        if (VIP.appTest && VIP.appTest.maybeShowAppCheck) VIP.appTest.maybeShowAppCheck();
        if (VIP.appTest && VIP.appTest.maybeRunNotifTest) VIP.appTest.maybeRunNotifTest();

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

        // Campo "contraseña actual": se pide solo en el cambio voluntario con
        // teléfono ya verificado (caso sin OTP). En el cambio obligatorio de
        // primer ingreso o en el alta de teléfono (con OTP) no se pide.
        const currentPwGroup = document.getElementById('currentPasswordGroup');
        const currentPwInput = document.getElementById('currentPasswordInput');
        const needCurrentPw = !VIP.state.passwordChangePending && !!verifiedPhone;
        if (currentPwGroup) currentPwGroup.style.display = needCurrentPw ? '' : 'none';
        if (currentPwInput) {
            currentPwInput.value = '';
            if (needCurrentPw) currentPwInput.setAttribute('required', '');
            else currentPwInput.removeAttribute('required');
        }

        // Reset del paso OTP: siempre arranca en paso 1 al abrir el modal.
        const otpStep = document.getElementById('changePasswordOtpStep');
        const form = document.getElementById('changePasswordForm');
        const temporalResult = document.getElementById('changePasswordTemporalResult');
        if (otpStep) otpStep.style.display = 'none';
        if (form) form.style.display = '';
        if (temporalResult) temporalResult.style.display = 'none';
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
        if (VIP.state.passwordChangePending) {
            if (closeBtn) closeBtn.style.display = 'none';
            if (title) title.textContent = '🔐 Cambio de Contraseña Obligatorio';
            if (subtitle) subtitle.innerHTML = 'Por seguridad, <strong>debés cambiar tu contraseña</strong> antes de continuar. No podés omitir este paso.';
        } else {
            if (closeBtn) closeBtn.style.display = '';
            if (title) title.textContent = '🔐 Cambiar Contraseña';
            if (subtitle) subtitle.textContent = 'Ingresá tu nueva contraseña para actualizarla.';
        }
    }

    // Estado pendiente del cambio de contraseña con OTP:
    // se guarda entre el paso 1 (datos) y el paso 2 (verificación OTP) para no perder
    // la nueva contraseña ni el teléfono mientras el usuario espera el SMS.
    let _vipChangePwdPending = null;
    let _vipChangePwdResendTimer = null;
    // Recuerda si la entrada temporal pidió cerrar todas las sesiones, para
    // forzar un re-login al cerrar el panel de resultado.
    let _temporalCloseAllSessions = false;

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

        const newPassword = document.getElementById('newPasswordInput').value;
        const confirmPassword = document.getElementById('confirmPasswordInput').value;
        const whatsappRaw = (document.getElementById('changePasswordWhatsApp')?.value || '').trim();
        const whatsappPrefix = (document.getElementById('changePasswordWhatsAppPrefix')?.value || '+54').trim();
        const errorDiv = document.getElementById('passwordError');

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

        // Cambio voluntario con teléfono ya verificado → se exige la contraseña actual.
        const currentPassword = (document.getElementById('currentPasswordInput')?.value || '');
        if (verifiedPhone && !VIP.state.passwordChangePending && !currentPassword) {
            errorDiv.textContent = 'Ingresá tu contraseña actual';
            errorDiv.classList.add('show');
            return;
        }

        const closeAllSessions = document.getElementById('closeAllSessions').checked;

        // CASO A: el usuario ya tiene un teléfono verificado y NO está cambiándolo.
        // No se requiere OTP. Solo se cambia la contraseña.
        if (verifiedPhone && !whatsappFull) {
            return _commitPasswordChange({
                newPassword,
                closeAllSessions,
                phone: null,
                otpCode: null,
                currentPassword,
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
                newPassword,
                closeAllSessions,
                phone: null,
                otpCode: null,
                currentPassword,
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

            // Guardar contexto pendiente SIEMPRE: aunque el envío del SMS falle,
            // necesitamos newPassword + phone para que la "entrada temporal" funcione.
            _vipChangePwdPending = {
                newPassword,
                phone: whatsappFull,
                closeAllSessions
            };
            const form = document.getElementById('changePasswordForm');
            const otpStep = document.getElementById('changePasswordOtpStep');
            const otpMsg = document.getElementById('changePasswordOtpMsg');
            if (form) form.style.display = 'none';
            if (otpStep) otpStep.style.display = '';
            const otpErr = document.getElementById('changePasswordOtpError');
            if (otpErr) { otpErr.textContent = ''; otpErr.classList.remove('show'); }
            const otpCodeInput = document.getElementById('changePasswordOtpCode');
            if (otpCodeInput) { otpCodeInput.value = ''; }

            if (!response.ok) {
                // El SMS no se pudo enviar. Mostramos el paso OTP igual: el usuario
                // puede reintentar el envío o entrar de forma temporal.
                if (otpMsg) {
                    otpMsg.style.color = '#ff6b6b';
                    otpMsg.textContent = (data.error || 'No pudimos enviar el SMS.') +
                        ' Reintentá el envío o entrá de forma temporal abajo.';
                }
                _stopChangePwdResendCooldown();
            } else {
                if (otpMsg) {
                    otpMsg.style.color = '#00ff88';
                    otpMsg.textContent = `Te enviamos un código SMS al ${data.phone || whatsappFull}. Ingresálo para confirmar el cambio.`;
                }
                if (otpCodeInput) setTimeout(() => otpCodeInput.focus(), 50);
                _startChangePwdResendCooldown(60);
            }
        } catch (err) {
            errorDiv.textContent = 'Error de conexión';
            errorDiv.classList.add('show');
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '💾 Guardar Cambios'; }
        }
    }

    async function _commitPasswordChange({ newPassword, closeAllSessions, phone, otpCode, currentPassword, errorDiv }) {
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

    // Entrada temporal: cuando el SMS no llega o el OTP falla, el usuario cambia
    // la contraseña SIN verificar el teléfono. Queda con verificación pendiente
    // y deberá verificar por SMS antes de poder retirar.
    async function handleChangePasswordTemporalEntry() {
        const otpErr = document.getElementById('changePasswordOtpError');
        if (otpErr) { otpErr.textContent = ''; otpErr.classList.remove('show'); }

        if (!_vipChangePwdPending) {
            if (otpErr) {
                otpErr.textContent = 'Sesión de cambio expirada. Volvé a iniciar el cambio.';
                otpErr.classList.add('show');
            }
            return;
        }

        const btn = document.getElementById('changePasswordTemporalBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Procesando...'; }
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/change-password/pending`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                },
                body: JSON.stringify({
                    newPassword: _vipChangePwdPending.newPassword,
                    phone: _vipChangePwdPending.phone,
                    whatsapp: _vipChangePwdPending.phone,
                    closeAllSessions: _vipChangePwdPending.closeAllSessions
                })
            });
            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                if (otpErr) {
                    otpErr.textContent = (data && data.error) || 'No se pudo completar la entrada temporal';
                    otpErr.classList.add('show');
                }
                return;
            }

            // Éxito: el usuario sale del modo obligatorio pero queda con
            // verificación de teléfono pendiente.
            VIP.state.passwordChangePending = false;
            if (typeof window.setPasswordChangePending === 'function') {
                window.setPasswordChangePending(false);
            }
            VIP.state.sessionPassword = _vipChangePwdPending.newPassword;
            if (VIP.state.currentUser) {
                VIP.state.currentUser.phone = _vipChangePwdPending.phone;
                VIP.state.currentUser.phoneVerified = false;
                VIP.state.currentUser.phoneVerificationPending = true;
            }
            _temporalCloseAllSessions = !!_vipChangePwdPending.closeAllSessions;
            _vipChangePwdPending = null;
            _stopChangePwdResendCooldown();

            // Mostrar el panel de resultado con el código temporal.
            const form = document.getElementById('changePasswordForm');
            const otpStep = document.getElementById('changePasswordOtpStep');
            const result = document.getElementById('changePasswordTemporalResult');
            const codeEl = document.getElementById('changePasswordTemporalCode');
            if (form) form.style.display = 'none';
            if (otpStep) otpStep.style.display = 'none';
            if (codeEl) codeEl.textContent = data.pendingAccessCode || '——————';
            if (result) result.style.display = '';

            const np = document.getElementById('newPasswordInput');
            if (np) np.value = '';
            const cp = document.getElementById('confirmPasswordInput');
            if (cp) cp.value = '';
        } catch (err) {
            if (otpErr) {
                otpErr.textContent = 'Error de conexión';
                otpErr.classList.add('show');
            }
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '📲 Entrar de forma temporal'; }
        }
    }

    // Cierra el panel de resultado de la entrada temporal.
    function finishTemporalEntry() {
        const result = document.getElementById('changePasswordTemporalResult');
        if (result) result.style.display = 'none';
        VIP.state.passwordChangePending = false;
        VIP.ui.hideModal('changePasswordModal');
        if (_temporalCloseAllSessions) {
            _temporalCloseAllSessions = false;
            VIP.ui.showToast('🔒 Sesiones cerradas. Volvé a iniciar sesión.', 'info');
            setTimeout(() => {
                localStorage.removeItem('userToken');
                location.reload();
            }, 1800);
        } else {
            VIP.ui.showToast('⏳ Modo temporal activo. Verificá tu teléfono para poder retirar.', 'info');
        }
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
        const usernameLoginModeToggle = document.getElementById('usernameLoginModeToggle');
        const temporalCodeGroup = document.getElementById('temporalCodeGroup');

        if (mode === 'phone') {
            if (usernameGroup) usernameGroup.classList.add('hidden');
            if (phoneGroup) phoneGroup.classList.remove('hidden');
            if (usernameInput) usernameInput.removeAttribute('required');
            if (usernameBtn) { usernameBtn.style.background = 'transparent'; usernameBtn.style.color = '#888'; usernameBtn.style.fontWeight = 'normal'; }
            if (phoneBtn) { phoneBtn.style.background = 'rgba(212,175,55,0.2)'; phoneBtn.style.color = '#d4af37'; phoneBtn.style.fontWeight = '600'; }
            if (phoneLoginModeToggle) phoneLoginModeToggle.classList.remove('hidden');
            // Modo celular: ocultar el sub-toggle de código temporal (es solo del modo usuario).
            if (usernameLoginModeToggle) usernameLoginModeToggle.classList.add('hidden');
            if (temporalCodeGroup) temporalCodeGroup.classList.add('hidden');
            window._usernameLoginMode = 'password';
            if (passwordGroup) passwordGroup.style.display = '';
            if (passwordInputEl) passwordInputEl.setAttribute('required', '');
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
            // Modo usuario: mostrar el sub-toggle y resetearlo a "Contraseña".
            if (usernameLoginModeToggle) usernameLoginModeToggle.classList.remove('hidden');
            if (temporalCodeGroup) temporalCodeGroup.classList.add('hidden');
            window._usernameLoginMode = 'password';
            if (passwordInputEl) passwordInputEl.setAttribute('required', '');
            const upwBtn = document.getElementById('usernameLoginByPassword');
            const utmpBtn = document.getElementById('usernameLoginByTemporal');
            if (upwBtn) { upwBtn.style.background = 'rgba(212,175,55,0.2)'; upwBtn.style.color = '#d4af37'; upwBtn.style.fontWeight = '600'; }
            if (utmpBtn) { utmpBtn.style.background = 'transparent'; utmpBtn.style.color = '#888'; utmpBtn.style.fontWeight = 'normal'; }
        }
    }

    // ============================================
    // MODO DEL MODAL DE REGISTRO
    // ============================================
    // El registro es siempre solo usuario + contraseña (sin SMS). Si VIP.campaign
    // tiene una atribución de pauta activa, además se muestra el banner y se
    // oculta el código de referido (la campaña es la atribución relevante).
    function applyRegisterModalMode() {
        const banner = document.getElementById('campaignAttributionBanner');
        const referralGroup = document.getElementById('registerReferralGroup');
        const referralInput = document.getElementById('registerReferralCode');
        const sendBtn = document.getElementById('registerSendOtpBtn');
        if (!sendBtn) return;

        const attribution = VIP.campaign && VIP.campaign.getActive();

        if (banner) banner.style.display = attribution ? '' : 'none';
        if (attribution) {
            if (referralGroup) referralGroup.style.display = 'none';
            if (referralInput) referralInput.value = '';
        } else {
            if (referralGroup) referralGroup.style.display = '';
        }
        sendBtn.textContent = '📝 Crear Cuenta';
        sendBtn.onclick = handleRegisterDirect;

        // El usuario de registro arranca siempre con "VIP"; el cliente completa.
        const ru = document.getElementById('registerUsername');
        if (ru && !ru.value.trim()) ru.value = 'VIP';
    }

    // ============================================
    // VERIFICACIÓN DE TELÉFONO (opcional, post-registro)
    // ============================================
    async function handleVerifyPhoneSend() {
        const prefix = document.getElementById('verifyPhonePrefix').value;
        const number = document.getElementById('verifyPhoneInput').value.trim();
        const errorDiv = document.getElementById('verifyPhoneError');
        const btn = document.getElementById('verifyPhoneSendBtn');

        errorDiv.classList.remove('show');

        if (!number || number.replace(/\D/g, '').length < 7) {
            errorDiv.textContent = 'Ingresá un número válido (mínimo 7 dígitos)';
            errorDiv.classList.add('show');
            return;
        }

        const fullPhone = prefix + number.replace(/[\s\-().]/g, '');
        if (btn) { btn.textContent = 'Enviando...'; btn.disabled = true; }

        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/verify-phone/send-otp`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                },
                body: JSON.stringify({ phone: fullPhone })
            });
            const data = await response.json();

            if (response.ok && data.success) {
                window._verifyPhoneFullPhone = fullPhone;
                document.getElementById('verifyPhoneStep1').style.display = 'none';
                document.getElementById('verifyPhoneStep2').style.display = '';
                document.getElementById('verifyPhoneOtpMsg').textContent = `✅ Código enviado a ${data.phone}`;
                document.getElementById('verifyPhoneOtpCode').value = '';
                document.getElementById('verifyPhoneOtpError').classList.remove('show');
            } else {
                errorDiv.textContent = data.error || 'Error al enviar el código SMS';
                errorDiv.classList.add('show');
            }
        } catch (error) {
            errorDiv.textContent = 'Error de conexión';
            errorDiv.classList.add('show');
        } finally {
            if (btn) { btn.textContent = '📱 Enviar código SMS'; btn.disabled = false; }
        }
    }

    async function handleVerifyPhoneConfirm() {
        const otpCode = document.getElementById('verifyPhoneOtpCode').value.trim();
        const errorDiv = document.getElementById('verifyPhoneOtpError');
        const btn = document.getElementById('verifyPhoneConfirmBtn');
        const phone = window._verifyPhoneFullPhone;

        errorDiv.classList.remove('show');

        if (!otpCode || otpCode.length < 6) {
            errorDiv.textContent = 'Ingresá el código de 6 dígitos';
            errorDiv.classList.add('show');
            return;
        }
        if (!phone) {
            errorDiv.textContent = 'Volvé al paso anterior';
            errorDiv.classList.add('show');
            return;
        }

        if (btn) { btn.textContent = 'Verificando...'; btn.disabled = true; }

        try {
            const response = await fetch(`${VIP.config.API_URL}/api/auth/verify-phone/confirm`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                },
                body: JSON.stringify({ phone, otpCode })
            });
            const data = await response.json();

            if (response.ok && data.success) {
                // Reflejar en estado local sin recargar.
                if (VIP.state.currentUser) {
                    VIP.state.currentUser.phone = phone;
                    VIP.state.currentUser.phoneVerified = true;
                    VIP.state.currentUser.phoneVerificationPending = false;
                }
                window._verifyPhoneFullPhone = null;
                VIP.ui.hideModal('verifyPhoneModal');
                VIP.ui.showToast('✅ Teléfono verificado. Ya podés retirar.', 'success');
                refreshVerifyPhoneBanner();
                // Reset form para próxima apertura
                document.getElementById('verifyPhoneStep1').style.display = '';
                document.getElementById('verifyPhoneStep2').style.display = 'none';
                document.getElementById('verifyPhoneInput').value = '';
            } else {
                errorDiv.textContent = data.error || 'Código incorrecto o expirado';
                errorDiv.classList.add('show');
            }
        } catch (error) {
            errorDiv.textContent = 'Error de conexión';
            errorDiv.classList.add('show');
        } finally {
            if (btn) { btn.textContent = '✅ Verificar'; btn.disabled = false; }
        }
    }

    return {
        checkUsernameAvailability,
        handleRegister,
        handleRegisterDirect,
        maybeOfferSmsVerification,
        refreshVerifyPhoneBanner,
        applyRegisterModalMode,
        handleVerifyPhoneSend,
        handleVerifyPhoneConfirm,
        handleLogin,
        verifyToken,
        handleLogout,
        ensureUserLoaded,
        initializeSession,
        handleChangePassword,
        handleChangePasswordOtpVerify,
        handleChangePasswordOtpResend,
        handleChangePasswordOtpBack,
        handleChangePasswordTemporalEntry,
        finishTemporalEntry,
        handleFindUserByPhone,
        handleResetPasswordByPhone,
        handleRequestPasswordReset,
        handleVerifyResetOtp,
        handleCompletePasswordReset,
        prepareChangePasswordModal,
        switchLoginMode
    };

})();

// Window aliases for any HTML onclick / external callers
window.checkUsernameAvailability = VIP.auth.checkUsernameAvailability;
window.handleRequestPasswordReset = VIP.auth.handleRequestPasswordReset;
window.handleVerifyResetOtp = VIP.auth.handleVerifyResetOtp;
window.handleCompletePasswordReset = VIP.auth.handleCompletePasswordReset;
window.switchLoginMode = VIP.auth.switchLoginMode;

// Phone login OTP mode functions (global scope for onclick handlers)
window._phoneLoginMode = 'password';
window._phoneOtpFullPhone = null;

// Sub-modo del login por usuario: 'password' o 'temporal' (código de acceso temporal).
window._usernameLoginMode = 'password';

window.switchUsernameLoginMode = function(mode) {
    window._usernameLoginMode = mode;
    var passwordInputEl = document.getElementById('password');
    var passwordGroup = passwordInputEl ? passwordInputEl.closest('.input-group') : null;
    var temporalGroup = document.getElementById('temporalCodeGroup');
    var passwordBtn = document.getElementById('usernameLoginByPassword');
    var temporalBtn = document.getElementById('usernameLoginByTemporal');

    if (mode === 'temporal') {
        if (passwordGroup) passwordGroup.style.display = 'none';
        if (passwordInputEl) passwordInputEl.removeAttribute('required');
        if (temporalGroup) temporalGroup.classList.remove('hidden');
        if (passwordBtn) { passwordBtn.style.background = 'transparent'; passwordBtn.style.color = '#888'; passwordBtn.style.fontWeight = 'normal'; }
        if (temporalBtn) { temporalBtn.style.background = 'rgba(212,175,55,0.2)'; temporalBtn.style.color = '#d4af37'; temporalBtn.style.fontWeight = '600'; }
    } else {
        if (passwordGroup) passwordGroup.style.display = '';
        if (passwordInputEl) passwordInputEl.setAttribute('required', '');
        if (temporalGroup) temporalGroup.classList.add('hidden');
        if (passwordBtn) { passwordBtn.style.background = 'rgba(212,175,55,0.2)'; passwordBtn.style.color = '#d4af37'; passwordBtn.style.fontWeight = '600'; }
        if (temporalBtn) { temporalBtn.style.background = 'transparent'; temporalBtn.style.color = '#888'; temporalBtn.style.fontWeight = 'normal'; }
    }
};

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
                                    // Cerrar la encuesta de notificaciones si quedó
                                    // abierta: en modo obligatorio no tiene botón de
                                    // cerrar y taparía el modal de cambio de clave.
                                    if (typeof VIP.ui.hideModal === 'function') {
                                        VIP.ui.hideModal('notifSurveyModal');
                                    }
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
