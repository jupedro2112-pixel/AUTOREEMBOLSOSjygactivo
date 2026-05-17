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

        // Register modal
        const registerBtn = document.getElementById('registerBtn');
        if (registerBtn) registerBtn.addEventListener('click', () => VIP.ui.showModal('registerModal'));
        const closeRegisterModal = document.getElementById('closeRegisterModal');
        if (closeRegisterModal) closeRegisterModal.addEventListener('click', () => VIP.ui.hideModal('registerModal'));
        const registerForm = document.getElementById('registerForm');
        if (registerForm) registerForm.addEventListener('submit', VIP.auth.handleRegister);

        // Refund buttons
        const dailyRefundBtn = document.getElementById('dailyRefundBtn');
        if (dailyRefundBtn) dailyRefundBtn.addEventListener('click', () => VIP.refunds.showRefundModal('daily'));
        const weeklyRefundBtn = document.getElementById('weeklyRefundBtn');
        if (weeklyRefundBtn) weeklyRefundBtn.addEventListener('click', () => VIP.refunds.showRefundModal('weekly'));
        const monthlyRefundBtn = document.getElementById('monthlyRefundBtn');
        if (monthlyRefundBtn) monthlyRefundBtn.addEventListener('click', () => VIP.refunds.showRefundModal('monthly'));
        const closeRefundModal = document.getElementById('closeRefundModal');
        if (closeRefundModal) closeRefundModal.addEventListener('click', () => VIP.ui.hideModal('refundModal'));

        // Referrals
        const referralBtn = document.getElementById('referralBtn');
        if (referralBtn) referralBtn.addEventListener('click', () => VIP.ui.openReferralModal());

        // Settings
        const settingsBtn = document.getElementById('settingsBtn');
        if (settingsBtn) settingsBtn.addEventListener('click', () => VIP.ui.showModal('settingsModal'));
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
