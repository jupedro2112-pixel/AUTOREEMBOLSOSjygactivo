// ========================================
// WITHDRAW - Retiro autogestionado del usuario
// ========================================
// Flujo: el usuario completa sus datos bancarios + monto. Si su teléfono no
// está verificado, se le exige verificación por SMS antes de retirar. Si ya lo
// tiene verificado, ese paso se saltea. El retiro real lo procesa el backend
// (POST /api/withdrawal/request) que descuenta el saldo en JugaYGana y manda
// un mensaje automático al chat para el agente.

window.VIP = window.VIP || {};

VIP.withdraw = (function () {

    let _balance = 0;
    let _otpPhone = null;        // teléfono al que se envió el OTP
    let _pendingWithdraw = null; // { titular, cbu, alias, amount, saveData }

    function _el(id) { return document.getElementById(id); }

    function _showError(id, msg) {
        const e = _el(id);
        if (e) { e.textContent = msg; e.classList.add('show'); }
    }

    function _clearError(id) {
        const e = _el(id);
        if (e) { e.textContent = ''; e.classList.remove('show'); }
    }

    // step: 'form' | 'otp-phone' | 'otp-code'
    function _showStep(step) {
        const form = _el('withdrawForm');
        const otpStep = _el('withdrawOtpStep');
        const phoneSub = _el('withdrawOtpPhoneSub');
        const codeSub = _el('withdrawOtpCodeSub');
        if (form) form.style.display = (step === 'form') ? '' : 'none';
        if (otpStep) otpStep.style.display = (step === 'otp-phone' || step === 'otp-code') ? '' : 'none';
        if (phoneSub) phoneSub.style.display = (step === 'otp-phone') ? '' : 'none';
        if (codeSub) codeSub.style.display = (step === 'otp-code') ? '' : 'none';
    }

    function _prefillOtpPhone(fullPhone) {
        if (!fullPhone) return;
        const select = _el('withdrawOtpPrefix');
        const input = _el('withdrawOtpPhone');
        if (!select || !input) return;
        const prefixes = Array.from(select.options)
            .map(o => o.value)
            .sort((a, b) => b.length - a.length); // más largo primero
        for (const p of prefixes) {
            if (fullPhone.startsWith(p)) {
                select.value = p;
                input.value = fullPhone.slice(p.length);
                return;
            }
        }
        input.value = fullPhone.replace(/^\+/, '');
    }

    async function openWithdrawModal() {
        _clearError('withdrawError');
        _clearError('withdrawOtpPhoneError');
        _clearError('withdrawOtpCodeError');
        _otpPhone = null;
        _pendingWithdraw = null;
        _showStep('form');
        const noBalance = _el('withdrawNoBalance');
        if (noBalance) noBalance.style.display = 'none';
        const balEl = _el('withdrawBalanceAmount');
        if (balEl) balEl.textContent = '...';

        VIP.ui.showModal('withdrawModal');
        await _loadAccountAndBalance();
    }

    async function _loadAccountAndBalance() {
        // 1. Datos bancarios guardados + estado del teléfono.
        try {
            const res = await fetch(`${VIP.config.API_URL}/api/withdrawal/account`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (res.ok) {
                const data = await res.json();
                const acc = data.account || {};
                if (acc.titular) _el('withdrawTitular').value = acc.titular;
                if (acc.cbu) _el('withdrawCbu').value = acc.cbu;
                if (acc.alias) _el('withdrawAlias').value = acc.alias;
                if (data.phone) _prefillOtpPhone(data.phone);
                // Mantener el estado local de verificación sincronizado.
                if (VIP.state.currentUser && typeof data.phoneVerified === 'boolean') {
                    VIP.state.currentUser.phoneVerified = data.phoneVerified;
                }
            }
        } catch (e) { /* no bloquea: el formulario sigue usable */ }

        // 2. Saldo en vivo (JugaYGana).
        try {
            const res = await fetch(`${VIP.config.API_URL}/api/balance/live`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (res.ok) {
                const data = await res.json();
                _balance = Number(data.balance) || 0;
            } else {
                _balance = Number(VIP.state.currentUser && VIP.state.currentUser.balance) || 0;
            }
        } catch (e) {
            _balance = Number(VIP.state.currentUser && VIP.state.currentUser.balance) || 0;
        }

        const balEl = _el('withdrawBalanceAmount');
        if (balEl) balEl.textContent = '$' + _balance.toLocaleString('es-AR');

        // Saldo por debajo del mínimo de retiro ($4.999) → bloquear el formulario y avisar.
        if (_balance < 4999) {
            const noBalance = _el('withdrawNoBalance');
            const form = _el('withdrawForm');
            if (noBalance) noBalance.style.display = '';
            if (form) form.style.display = 'none';
        }
    }

    async function handleWithdrawSubmit(e) {
        if (e) e.preventDefault();
        _clearError('withdrawError');

        const titular = (_el('withdrawTitular').value || '').trim();
        const cbu = (_el('withdrawCbu').value || '').trim();
        const alias = (_el('withdrawAlias').value || '').trim();
        const amount = Number(_el('withdrawAmount').value);
        const saveData = _el('withdrawSaveData').checked;

        if (!titular || !cbu || !alias) {
            _showError('withdrawError', 'Completá titular, CVU/CBU y alias.');
            return;
        }
        if (!amount || amount < 4999) {
            _showError('withdrawError', 'El monto mínimo de retiro es $4.999.');
            return;
        }
        if (amount > _balance) {
            _showError('withdrawError', `No podés retirar más que tu saldo disponible ($${_balance.toLocaleString('es-AR')}).`);
            return;
        }

        _pendingWithdraw = { titular, cbu, alias, amount, saveData };

        // Para retirar, la cuenta debe tener el teléfono verificado por SMS.
        // Si todavía no lo verificó, se abre el paso de verificación SMS antes
        // de procesar el retiro (el registro de inicio es sin SMS, opcional).
        const verified = VIP.state.currentUser && VIP.state.currentUser.phoneVerified === true;
        if (!verified) {
            _clearError('withdrawOtpPhoneError');
            _showStep('otp-phone');
            return;
        }

        await _doWithdraw();
    }

    async function sendWithdrawOtp() {
        _clearError('withdrawOtpPhoneError');
        const prefix = _el('withdrawOtpPrefix').value;
        const number = (_el('withdrawOtpPhone').value || '').trim();
        const btn = _el('withdrawOtpSendBtn');

        if (!number || number.replace(/\D/g, '').length < 7) {
            _showError('withdrawOtpPhoneError', 'Ingresá un número válido (mínimo 7 dígitos).');
            return;
        }
        const fullPhone = prefix + number.replace(/[\s\-().]/g, '').replace(/^0+/, '');

        if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }
        try {
            const res = await fetch(`${VIP.config.API_URL}/api/auth/verify-phone/send-otp`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                },
                body: JSON.stringify({ phone: fullPhone })
            });
            const data = await res.json().catch(() => ({}));

            if (res.ok && data.success) {
                _otpPhone = fullPhone;
                _el('withdrawOtpMsg').textContent = `✅ Te enviamos un código SMS al ${data.phone || fullPhone}.`;
                _el('withdrawOtpCode').value = '';
                _clearError('withdrawOtpCodeError');
                _showStep('otp-code');
                setTimeout(() => _el('withdrawOtpCode').focus(), 50);
            } else {
                _showError('withdrawOtpPhoneError', data.error || 'No se pudo enviar el SMS. Intentá de nuevo.');
            }
        } catch (err) {
            _showError('withdrawOtpPhoneError', 'Error de conexión.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '📱 Enviar código SMS'; }
        }
    }

    async function verifyWithdrawOtp() {
        _clearError('withdrawOtpCodeError');
        const code = (_el('withdrawOtpCode').value || '').trim();
        const btn = _el('withdrawOtpVerifyBtn');

        if (!code || code.length < 6) {
            _showError('withdrawOtpCodeError', 'Ingresá el código de 6 dígitos.');
            return;
        }
        if (!_otpPhone) {
            _showError('withdrawOtpCodeError', 'Volvé al paso anterior y reenviá el código.');
            return;
        }

        if (btn) { btn.disabled = true; btn.textContent = 'Verificando...'; }
        try {
            const res = await fetch(`${VIP.config.API_URL}/api/auth/verify-phone/confirm`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                },
                body: JSON.stringify({ phone: _otpPhone, otpCode: code })
            });
            const data = await res.json().catch(() => ({}));

            if (res.ok && data.success) {
                if (VIP.state.currentUser) {
                    VIP.state.currentUser.phone = _otpPhone;
                    VIP.state.currentUser.phoneVerified = true;
                    VIP.state.currentUser.phoneVerificationPending = false;
                }
                // Teléfono verificado → ejecutar el retiro.
                await _doWithdraw();
            } else {
                _showError('withdrawOtpCodeError', data.error || 'Código incorrecto o expirado.');
                if (btn) { btn.disabled = false; btn.textContent = '✅ Verificar y retirar'; }
            }
        } catch (err) {
            _showError('withdrawOtpCodeError', 'Error de conexión.');
            if (btn) { btn.disabled = false; btn.textContent = '✅ Verificar y retirar'; }
        }
    }

    async function _doWithdraw() {
        if (!_pendingWithdraw) return;

        const onOtpStep = _el('withdrawOtpStep') && _el('withdrawOtpStep').style.display !== 'none';
        const errorTarget = onOtpStep ? 'withdrawOtpCodeError' : 'withdrawError';
        const submitBtn = _el('withdrawSubmitBtn');
        const verifyBtn = _el('withdrawOtpVerifyBtn');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Procesando...'; }
        if (verifyBtn) { verifyBtn.disabled = true; verifyBtn.textContent = 'Procesando...'; }

        try {
            const metaEventId = (VIP.pixel && VIP.pixel.enabled) ? VIP.pixel.newEventId() : null;
            const res = await fetch(`${VIP.config.API_URL}/api/withdrawal/request`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${VIP.state.currentToken}`
                },
                body: JSON.stringify({
                    titular: _pendingWithdraw.titular,
                    cbu: _pendingWithdraw.cbu,
                    alias: _pendingWithdraw.alias,
                    amount: _pendingWithdraw.amount,
                    saveData: _pendingWithdraw.saveData,
                    metaEventId
                })
            });
            const data = await res.json().catch(() => ({}));

            if (res.ok && data.success) {
                if (VIP.pixel && metaEventId) {
                    VIP.pixel.trackWithId(metaEventId, 'WithdrawRequest', {
                        value: _pendingWithdraw.amount,
                        currency: 'ARS'
                    });
                }
                _pendingWithdraw = null;
                VIP.ui.hideModal('withdrawModal');
                VIP.ui.showToast('✅ ' + (data.message || 'Retiro solicitado correctamente'), 'success');
                setTimeout(() => VIP.chat.loadMessages(), 500);
                setTimeout(() => VIP.ui.syncBalance(), 1500);
                return;
            }

            if (data.code === 'PHONE_VERIFICATION_REQUIRED') {
                // No debería pasar (ya verificamos), pero por las dudas reabrimos el paso SMS.
                _showStep('otp-phone');
                _showError('withdrawOtpPhoneError', data.error || 'Verificá tu teléfono para poder retirar.');
            } else {
                _showError(errorTarget, data.error || 'No se pudo procesar el retiro.');
            }
        } catch (err) {
            _showError(errorTarget, 'Error de conexión.');
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '💸 Continuar'; }
            if (verifyBtn) { verifyBtn.disabled = false; verifyBtn.textContent = '✅ Verificar y retirar'; }
        }
    }

    function backToForm() {
        _clearError('withdrawOtpPhoneError');
        _showStep('form');
    }

    function backToPhone() {
        _clearError('withdrawOtpCodeError');
        _showStep('otp-phone');
    }

    return {
        openWithdrawModal,
        handleWithdrawSubmit,
        sendWithdrawOtp,
        verifyWithdrawOtp,
        backToForm,
        backToPhone
    };

})();

window.openWithdrawModal = VIP.withdraw.openWithdrawModal;
