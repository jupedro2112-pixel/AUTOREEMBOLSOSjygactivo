// ========================================
// APP - Main entry point
// Wires up all VIP modules and event listeners.
// Load order in HTML must be:
//   config.js → notifications.js → ui.js → chat.js →
//   socket.js → auth.js → refunds.js → fire.js → app.js
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    if (VIP.state.currentToken) {
        VIP.auth.verifyToken();
    }
    setupEventListeners();

    // Auto-fill referral code from URL ?ref=CODE
    const urlParams = new URLSearchParams(window.location.search);
    const refCode   = urlParams.get('ref');
    if (refCode) {
        const refInput = document.getElementById('registerReferralCode');
        if (refInput) refInput.value = refCode.toUpperCase();
        const registerBtn = document.getElementById('registerBtn');
        if (registerBtn) {
            registerBtn.style.background = 'linear-gradient(135deg, #d4af37 0%, #b8860b 100%)';
            registerBtn.textContent = '🤝 Registrarse con código de referido';
        }
    }

    // Auto-abrir el modal de registro cuando el visitante llega por un link
    // de publicista (?p=CODE) y no tiene sesión iniciada. La idea es bajar
    // al máximo la fricción entre el clic del anuncio y el signup.
    if (VIP.campaign && VIP.campaign.wasFreshlyCaptured() && !VIP.state.currentToken) {
        // Pequeño defer para que el DOM termine de pintar y la animación del
        // modal se vea fluida en mobile.
        setTimeout(() => {
            try {
                if (VIP.auth && VIP.auth.applyRegisterModalMode) VIP.auth.applyRegisterModalMode();
                VIP.ui.showModal('registerModal');
            } catch (e) {
                console.warn('[campaign] no se pudo auto-abrir el modal de registro:', e && e.message);
            }
        }, 250);
    }

    VIP.notifications.registerUserServiceWorker();

    VIP.ui.adjustLayout();
});

window.addEventListener('load', VIP.ui.adjustLayout);
window.addEventListener('resize', VIP.ui.adjustLayout);
window.addEventListener('orientationchange', () => setTimeout(VIP.ui.adjustLayout, 150));

// Escape key: close lightbox (if no mandatory password change pending)
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
        if (VIP.state.passwordChangePending) {
            e.preventDefault();
            return;
        }
        const lightbox = document.getElementById('lightbox');
        if (lightbox && lightbox.classList.contains('active')) {
            lightbox.classList.remove('active');
            document.body.style.overflow = '';
        }
    }
});

function setupEventListeners() {
    try {
        // ⚠️ CRÍTICO: registrar el submit handler de cambio de contraseña PRIMERO.
        // Si cualquier listener posterior fallara, este flujo (OTP de cambio obligatorio)
        // igual queda cubierto y no se cae al submit nativo del browser.
        const changePasswordForm = document.getElementById('changePasswordForm');
        if (changePasswordForm) changePasswordForm.addEventListener('submit', VIP.auth.handleChangePassword);
        // Cambio de contraseña — paso 2 (verificación OTP del nuevo teléfono).
        const cpOtpVerifyBtn = document.getElementById('changePasswordOtpVerifyBtn');
        const cpOtpResendBtn = document.getElementById('changePasswordOtpResendBtn');
        const cpOtpBackBtn = document.getElementById('changePasswordOtpBackBtn');
        if (cpOtpVerifyBtn) cpOtpVerifyBtn.addEventListener('click', VIP.auth.handleChangePasswordOtpVerify);
        if (cpOtpResendBtn) cpOtpResendBtn.addEventListener('click', VIP.auth.handleChangePasswordOtpResend);
        if (cpOtpBackBtn) cpOtpBackBtn.addEventListener('click', VIP.auth.handleChangePasswordOtpBack);

        // Login / logout
        const loginForm = document.getElementById('loginForm');
        if (loginForm) loginForm.addEventListener('submit', VIP.auth.handleLogin);
        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) logoutBtn.addEventListener('click', VIP.auth.handleLogout);
        const helpBtn = document.getElementById('helpBtn');
        if (helpBtn) helpBtn.addEventListener('click', () => {
            window.open('https://wa.link/metawin2026', '_blank');
        });
        const installBtn = document.getElementById('installBtn');
        if (installBtn) installBtn.addEventListener('click', VIP.ui.installApp);

        const headerInstallBtn = document.getElementById('headerInstallBtn');
        if (headerInstallBtn) headerInstallBtn.addEventListener('click', VIP.ui.installApp);

        const appInstallBtn = document.getElementById('appInstallBtn');
        if (appInstallBtn) appInstallBtn.addEventListener('click', VIP.ui.installApp);

        // Register modal — antes de abrir, adaptar el form al modo "registro rápido"
        // si hay una atribución de pauta activa (link ?p=CODE capturado).
        const registerBtn = document.getElementById('registerBtn');
        if (registerBtn) registerBtn.addEventListener('click', () => {
            if (VIP.auth && VIP.auth.applyRegisterModalMode) VIP.auth.applyRegisterModalMode();
            VIP.ui.showModal('registerModal');
        });
        const closeRegisterModal = document.getElementById('closeRegisterModal');
        if (closeRegisterModal) closeRegisterModal.addEventListener('click', () => VIP.ui.hideModal('registerModal'));
        const registerForm = document.getElementById('registerForm');
        if (registerForm) registerForm.addEventListener('submit', VIP.auth.handleRegister);

        // Chat send
        const sendBtn = document.getElementById('sendBtn');
        if (sendBtn) sendBtn.addEventListener('click', VIP.chat.sendMessage);

        const messageInput = document.getElementById('messageInput');
        if (messageInput) {
            messageInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    VIP.chat.sendMessage();
                }
            });

            // Typing indicator
            let typingTimeout;
            messageInput.addEventListener('input', function () {
                if (VIP.state.socket) {
                    VIP.state.socket.emit('typing', { isTyping: true });
                    clearTimeout(typingTimeout);
                    typingTimeout = setTimeout(() => {
                        VIP.state.socket.emit('stop_typing', {});
                    }, 2000);
                }
            });

            messageInput.addEventListener('paste', VIP.chat.handlePaste);

            // Auto-resize textarea
            messageInput.addEventListener('input', function () {
                this.style.height = 'auto';
                this.style.height = Math.min(this.scrollHeight, 100) + 'px';
            });
        }

        // File attach & paste
        const attachBtn = document.getElementById('attachBtn');
        if (attachBtn) attachBtn.addEventListener('click', () => {
            const fi = document.getElementById('fileInput');
            if (fi) fi.click();
        });
        const fileInput = document.getElementById('fileInput');
        if (fileInput) fileInput.addEventListener('change', VIP.chat.handleFileSelect);

        // Refund buttons
        const dailyRefundBtn = document.getElementById('dailyRefundBtn');
        if (dailyRefundBtn) dailyRefundBtn.addEventListener('click', () => VIP.refunds.showRefundModal('daily'));
        const weeklyRefundBtn = document.getElementById('weeklyRefundBtn');
        if (weeklyRefundBtn) weeklyRefundBtn.addEventListener('click', () => VIP.refunds.showRefundModal('weekly'));
        const monthlyRefundBtn = document.getElementById('monthlyRefundBtn');
        if (monthlyRefundBtn) monthlyRefundBtn.addEventListener('click', () => VIP.refunds.showRefundModal('monthly'));
        const closeRefundModal = document.getElementById('closeRefundModal');
        if (closeRefundModal) closeRefundModal.addEventListener('click', () => VIP.ui.hideModal('refundModal'));

        // Fire (Fueguito)
        const fireBtn = document.getElementById('fireBtn');
        if (fireBtn) {
            fireBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('🔥 Fueguito clickeado');
                VIP.fire.showFireModal();
            });
        }
        const closeFireModal = document.getElementById('closeFireModal');
        if (closeFireModal) closeFireModal.addEventListener('click', () => VIP.ui.hideModal('fireModal'));
        const claimFireBtn = document.getElementById('claimFireBtn');
        if (claimFireBtn) claimFireBtn.addEventListener('click', VIP.fire.claimFire);

        // Referrals
        const referralBtn = document.getElementById('referralBtn');
        if (referralBtn) referralBtn.addEventListener('click', () => VIP.ui.openReferralModal());

        // Info modal
        const infoBtn = document.getElementById('infoBtn');
        if (infoBtn) infoBtn.addEventListener('click', () => {
            VIP.ui.showModal('infoModal');
            if (VIP.appTest && typeof VIP.appTest.renderDiagnostics === 'function') VIP.appTest.renderDiagnostics();
            if (VIP.reviews && typeof VIP.reviews.renderInfoSection === 'function') VIP.reviews.renderInfoSection();
        });
        const closeInfoModal = document.getElementById('closeInfoModal');
        if (closeInfoModal) closeInfoModal.addEventListener('click', () => VIP.ui.hideModal('infoModal'));

        // CBU
        const cbuChatBtn = document.getElementById('cbuChatBtn');
        if (cbuChatBtn) cbuChatBtn.addEventListener('click', VIP.ui.loadAndShowCBU);

        // Retiro autogestionado
        const withdrawChatBtn = document.getElementById('withdrawChatBtn');
        if (withdrawChatBtn) withdrawChatBtn.addEventListener('click', VIP.withdraw.openWithdrawModal);
        const withdrawForm = document.getElementById('withdrawForm');
        if (withdrawForm) withdrawForm.addEventListener('submit', VIP.withdraw.handleWithdrawSubmit);
        const withdrawCancelBtn = document.getElementById('withdrawCancelBtn');
        if (withdrawCancelBtn) withdrawCancelBtn.addEventListener('click', () => VIP.ui.hideModal('withdrawModal'));
        const withdrawCloseBtn = document.getElementById('withdrawCloseBtn');
        if (withdrawCloseBtn) withdrawCloseBtn.addEventListener('click', () => VIP.ui.hideModal('withdrawModal'));
        const withdrawOtpSendBtn = document.getElementById('withdrawOtpSendBtn');
        if (withdrawOtpSendBtn) withdrawOtpSendBtn.addEventListener('click', VIP.withdraw.sendWithdrawOtp);
        const withdrawOtpVerifyBtn = document.getElementById('withdrawOtpVerifyBtn');
        if (withdrawOtpVerifyBtn) withdrawOtpVerifyBtn.addEventListener('click', VIP.withdraw.verifyWithdrawOtp);
        const withdrawOtpBackBtn = document.getElementById('withdrawOtpBackBtn');
        if (withdrawOtpBackBtn) withdrawOtpBackBtn.addEventListener('click', VIP.withdraw.backToForm);
        const withdrawOtpCodeBackBtn = document.getElementById('withdrawOtpCodeBackBtn');
        if (withdrawOtpCodeBackBtn) withdrawOtpCodeBackBtn.addEventListener('click', VIP.withdraw.backToPhone);

        // Bono por instalar la app
        const installBonusClaimBtn = document.getElementById('installBonusClaimBtn');
        if (installBonusClaimBtn) installBonusClaimBtn.addEventListener('click', VIP.installBonus.claim);

        // Encuesta de plan de notificaciones
        document.querySelectorAll('.notif-plan-card').forEach(card => {
            card.addEventListener('click', () => VIP.notifSurvey.select(card.dataset.plan));
        });
        const notifSurveyCloseBtn = document.getElementById('notifSurveyCloseBtn');
        if (notifSurveyCloseBtn) notifSurveyCloseBtn.addEventListener('click', VIP.notifSurvey.close);
        const openNotifPlanBtn = document.getElementById('openNotifPlanBtn');
        if (openNotifPlanBtn) openNotifPlanBtn.addEventListener('click', VIP.notifSurvey.openEditable);

        // Cambio de contraseña — entrada temporal (fallback cuando el SMS no llega)
        const cpTemporalBtn = document.getElementById('changePasswordTemporalBtn');
        if (cpTemporalBtn) cpTemporalBtn.addEventListener('click', VIP.auth.handleChangePasswordTemporalEntry);
        const cpTemporalOkBtn = document.getElementById('changePasswordTemporalOkBtn');
        if (cpTemporalOkBtn) cpTemporalOkBtn.addEventListener('click', VIP.auth.finishTemporalEntry);

        // Settings — antes de abrir mostramos/escondemos el bloque de
        // "verificación pendiente" según el estado del user actual.
        const settingsBtn = document.getElementById('settingsBtn');
        if (settingsBtn) settingsBtn.addEventListener('click', () => {
            const pendingBlock = document.getElementById('verifyPhonePendingBlock');
            const isPending = VIP.state.currentUser && VIP.state.currentUser.phoneVerificationPending === true;
            if (pendingBlock) pendingBlock.style.display = isPending ? '' : 'none';
            VIP.ui.showModal('settingsModal');
        });

        // Botón "🔓 Verificar teléfono" dentro del modal de settings: abre el modal de verify-phone.
        const openVerifyPhoneBtn = document.getElementById('openVerifyPhoneBtn');
        if (openVerifyPhoneBtn) openVerifyPhoneBtn.addEventListener('click', () => {
            VIP.ui.hideModal('settingsModal');
            // Reset state cada vez que se abre
            document.getElementById('verifyPhoneStep1').style.display = '';
            document.getElementById('verifyPhoneStep2').style.display = 'none';
            document.getElementById('verifyPhoneInput').value = '';
            document.getElementById('verifyPhoneError').classList.remove('show');
            VIP.ui.showModal('verifyPhoneModal');
        });

        // Submit handlers del modal verify-phone
        const verifyPhoneSendBtn = document.getElementById('verifyPhoneSendBtn');
        if (verifyPhoneSendBtn) verifyPhoneSendBtn.addEventListener('click', VIP.auth.handleVerifyPhoneSend);
        const verifyPhoneConfirmBtn = document.getElementById('verifyPhoneConfirmBtn');
        if (verifyPhoneConfirmBtn) verifyPhoneConfirmBtn.addEventListener('click', VIP.auth.handleVerifyPhoneConfirm);
        const closeSettingsModal = document.getElementById('closeSettingsModal');
        if (closeSettingsModal) closeSettingsModal.addEventListener('click', () => VIP.ui.hideModal('settingsModal'));
        const changePasswordSettingsBtn = document.getElementById('changePasswordSettingsBtn');
        if (changePasswordSettingsBtn) changePasswordSettingsBtn.addEventListener('click', () => {
            VIP.ui.hideModal('settingsModal');
            VIP.state.passwordChangePending = false;
            if (typeof VIP.auth.prepareChangePasswordModal === 'function') {
                VIP.auth.prepareChangePasswordModal();
            }
            VIP.ui.showModal('changePasswordModal');
        });

        // Nota: findUserForm y resetPassForm ya no existen en el HTML. findUserBtn
        // sí existe pero usa un `onclick` inline que abre directamente resetPassModal
        // (flujo de recuperación por SMS: handleRequestPasswordReset / handleVerifyResetOtp /
        // handleCompletePasswordReset, todos cableados vía onclick inline en index.html).
        // Por eso no registramos ningún addEventListener para estos IDs aquí.
    } catch (err) {
        console.error('[setupEventListeners] Error al registrar listeners (app parcialmente funcional):', err);
    }
}
