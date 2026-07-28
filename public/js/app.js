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

    // Welcome del publicista: se muestra PRE-AUTH si el visitante llegó por
    // una vanity URL (/CODE o /publisher-slug) o ?p=CODE. localStorage guarda
    // si ya lo vio para no repetir en este dispositivo.
    if (VIP.publisherWelcome && typeof VIP.publisherWelcome.maybeShow === 'function') {
        // Pequeño delay para que campaign.js termine de inicializar y exponer
        // VIP.campaign.getActive() — ese es el fallback cuando no hay
        // window.__VIP_CAMPAIGN_CODE__ inyectado (caso ?p=CODE).
        setTimeout(() => {
            VIP.publisherWelcome.maybeShow();
            // Personaliza el login screen para visitantes de publicista:
            // botón llamativo "Entrá YA..." + oculta Registrarse. Se aplica
            // SIEMPRE que haya atribución activa, no sólo la primera visita
            // (un visitante que ya vio el welcome igual debe ver el login
            // personalizado al volver al sitio).
            if (typeof VIP.publisherWelcome.applyLoginCustomizations === 'function') {
                VIP.publisherWelcome.applyLoginCustomizations();
            }
        }, 100);
    }

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

    // NOTA: el viejo adServiceModal ("Información del Servicio") se auto-abría
    // acá para visitantes con atribución de publicidad. Ahora el welcome de 2
    // pasos (VIP.publisherWelcome.maybeShow, disparado más arriba) cubre el
    // mismo propósito con flujo obligatorio. El adServiceModal queda en el
    // HTML por si se invoca manualmente en algún flujo, pero ya no se dispara
    // automáticamente — evita el race condition donde el cliente veía ambos
    // modales en secuencia.

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
        // Soporte del login: dos botones (WhatsApp y Telegram). Cada uno trae
        // la config del server y abre el canal correspondiente.
        async function _vipFetchSoporte() {
            try {
                const r = await fetch(VIP.config.API_URL + '/api/config/soporte-vip');
                return r.ok ? await r.json() : null;
            } catch (e) { return null; }
        }
        const helpWhatsappBtn = document.getElementById('helpWhatsappBtn');
        if (helpWhatsappBtn) helpWhatsappBtn.addEventListener('click', async () => {
            const d = await _vipFetchSoporte();
            const url = (d && d.whatsapp && d.whatsapp.url) ? d.whatsapp.url : 'https://wa.link/metawin2026';
            window.open(url, '_blank');
        });
        const helpTelegramBtn = document.getElementById('helpTelegramBtn');
        if (helpTelegramBtn) helpTelegramBtn.addEventListener('click', async () => {
            const d = await _vipFetchSoporte();
            const url = (d && d.telegram && d.telegram.url) ? d.telegram.url : '';
            if (url) {
                window.open(url, '_blank');
            } else {
                VIP.ui.showToast('Soporte de Telegram no disponible por ahora', 'info');
            }
        });

        // ===== Login: botones Reseñas / Regalos + ticker en vivo de reclamos =====
        const _vipEsc = (s) => {
            const d = document.createElement('div');
            d.textContent = String(s == null ? '' : s);
            return d.innerHTML;
        };
        const _vipFmtMoney = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
        const _vipRefundLabel = { daily: 'diario', weekly: 'semanal', monthly: 'mensual' };
        function _vipClaimText(it) {
            const name = it.name || '***';
            if (it.kind === 'ruleta') return '🎰 ' + name + ' ganó ' + _vipFmtMoney(it.amount) + ' en la ruleta diaria';
            if (it.kind === 'bono') return '🎁 ' + name + ' reclamó un regalo de ' + _vipFmtMoney(it.amount);
            return '💸 ' + name + ' reclamó ' + _vipFmtMoney(it.amount) + ' de reembolso ' + (_vipRefundLabel[it.refundType] || '');
        }

        let _vipClaims = [];
        let _vipClaimIdx = 0;
        let _vipClaimTimer = null;
        let _vipClaimFetchTimer = null;
        async function _vipFetchClaims() {
            try {
                const r = await fetch(VIP.config.API_URL + '/api/claims-feed');
                if (!r.ok) return;
                const d = await r.json();
                if (d && Array.isArray(d.items) && d.items.length) _vipClaims = d.items;
            } catch (e) { /* best-effort */ }
        }
        function _vipTickStep() {
            // El ticker es solo de la pantalla de login: una vez que el usuario
            // entró, se cortan los intervalos para no seguir consultando
            // /api/claims-feed en vano.
            if (VIP.state && VIP.state.currentToken) {
                if (_vipClaimTimer) clearInterval(_vipClaimTimer);
                if (_vipClaimFetchTimer) clearInterval(_vipClaimFetchTimer);
                return;
            }
            const ticker = document.getElementById('loginClaimsTicker');
            const txt = document.getElementById('loginClaimsText');
            if (!ticker || !txt || !_vipClaims.length) return;
            txt.style.opacity = '0';
            setTimeout(() => {
                _vipClaimIdx = (_vipClaimIdx + 1) % _vipClaims.length;
                txt.textContent = _vipClaimText(_vipClaims[_vipClaimIdx]);
                txt.style.opacity = '1';
            }, 260);
        }
        (async function _vipStartTicker() {
            await _vipFetchClaims();
            if (!_vipClaims.length) return;
            const ticker = document.getElementById('loginClaimsTicker');
            const txt = document.getElementById('loginClaimsText');
            if (ticker && txt) {
                ticker.style.display = 'flex';
                txt.textContent = _vipClaimText(_vipClaims[0]);
                txt.style.opacity = '1';
            }
            if (_vipClaimTimer) clearInterval(_vipClaimTimer);
            _vipClaimTimer = setInterval(_vipTickStep, 3600);
            if (_vipClaimFetchTimer) clearInterval(_vipClaimFetchTimer);
            _vipClaimFetchTimer = setInterval(_vipFetchClaims, 45000);
        })();

        function _vipStars(n) {
            const v = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
            let h = '';
            for (let i = 1; i <= 5; i++) h += '<span style="color:' + (i <= v ? '#ffd700' : '#555') + ';">★</span>';
            return h;
        }
        const loginReviewsBtn = document.getElementById('loginReviewsBtn');
        if (loginReviewsBtn) loginReviewsBtn.addEventListener('click', async () => {
            const title = document.getElementById('loginFeedTitle');
            const sub = document.getElementById('loginFeedSubtitle');
            const body = document.getElementById('loginFeedBody');
            if (title) title.textContent = '⭐ Opiniones de jugadores';
            if (sub) sub.textContent = '';
            if (body) body.innerHTML = '<div style="text-align:center;color:#888;padding:24px;">Cargando…</div>';
            VIP.ui.showModal('loginFeedModal');
            try {
                const r = await fetch(VIP.config.API_URL + '/api/reviews/public?limit=40');
                const d = r.ok ? await r.json() : null;
                if (!d || !d.items || !d.items.length) {
                    if (body) body.innerHTML = '<div style="text-align:center;color:#888;padding:24px;">Todavía no hay opiniones publicadas.</div>';
                    return;
                }
                if (sub) sub.textContent = Number(d.avgStars || 0).toFixed(1) + ' / 5 · ' + d.total + ' opiniones';
                let h = '';
                d.items.forEach((it) => {
                    h += '<div style="background:rgba(0,0,0,0.30);border-radius:9px;padding:9px 11px;margin-bottom:8px;">';
                    h += '<div style="font-size:12px;">' + _vipStars(it.stars) + ' <span style="color:#888;font-size:10px;margin-left:5px;">' + _vipEsc(it.maskedUsername || '***') + '</span></div>';
                    const c = (it.comment || '').trim();
                    if (c) h += '<div style="color:#ddd;font-size:12px;line-height:1.45;margin-top:3px;">"' + _vipEsc(c) + '"</div>';
                    h += '</div>';
                });
                if (body) body.innerHTML = h;
            } catch (e) {
                if (body) body.innerHTML = '<div style="text-align:center;color:#888;padding:24px;">No se pudieron cargar las opiniones.</div>';
            }
        });
        const loginGiftsBtn = document.getElementById('loginGiftsBtn');
        if (loginGiftsBtn) loginGiftsBtn.addEventListener('click', async () => {
            const title = document.getElementById('loginFeedTitle');
            const sub = document.getElementById('loginFeedSubtitle');
            const body = document.getElementById('loginFeedBody');
            if (title) title.textContent = '🎁 Regalos en tiempo real';
            if (sub) sub.textContent = 'Lo que está reclamando la gente ahora';
            if (body) body.innerHTML = '<div style="text-align:center;color:#888;padding:24px;">Cargando…</div>';
            VIP.ui.showModal('loginFeedModal');
            await _vipFetchClaims();
            if (!_vipClaims.length) {
                if (body) body.innerHTML = '<div style="text-align:center;color:#888;padding:24px;">Sin movimientos por ahora.</div>';
                return;
            }
            let h = '';
            _vipClaims.forEach((it) => {
                h += '<div style="background:rgba(0,0,0,0.30);border-radius:9px;padding:9px 11px;margin-bottom:7px;font-size:12.5px;color:#eee;">' + _vipEsc(_vipClaimText(it)) + '</div>';
            });
            if (body) body.innerHTML = h;
        });

        // Panel del home colapsable: "subir" el menú (ruleta, reembolsos,
        // saldo, retirar) para agrandar el chat, y bajarlo para ver todo.
        const homePanel = document.getElementById('homePanel');
        const homePanelToggle = document.getElementById('homePanelToggle');
        if (homePanel && homePanelToggle) {
            const hptLabel = homePanelToggle.querySelector('.hpt-label');
            const hptChevron = homePanelToggle.querySelector('.hpt-chevron');
            const applyHomePanel = (collapsed, animate) => {
                if (collapsed) {
                    if (animate) {
                        homePanel.style.maxHeight = homePanel.scrollHeight + 'px';
                        void homePanel.offsetHeight; // fuerza reflow para animar
                        homePanel.style.maxHeight = '0px';
                    } else {
                        homePanel.style.maxHeight = '0px';
                    }
                    homePanel.classList.add('collapsed');
                    homePanelToggle.setAttribute('aria-expanded', 'false');
                    if (hptLabel) hptLabel.textContent = 'Ver menú';
                    if (hptChevron) hptChevron.textContent = '▼';
                } else {
                    homePanel.classList.remove('collapsed');
                    if (animate) {
                        homePanel.style.maxHeight = homePanel.scrollHeight + 'px';
                        setTimeout(() => {
                            if (!homePanel.classList.contains('collapsed')) homePanel.style.maxHeight = 'none';
                        }, 320);
                    } else {
                        homePanel.style.maxHeight = 'none';
                    }
                    homePanelToggle.setAttribute('aria-expanded', 'true');
                    if (hptLabel) hptLabel.textContent = 'Ocultar menú';
                    if (hptChevron) hptChevron.textContent = '▲';
                }
            };
            homePanelToggle.addEventListener('click', () => {
                const willCollapse = !homePanel.classList.contains('collapsed');
                applyHomePanel(willCollapse, true);
                setTimeout(() => {
                    if (VIP.chat && VIP.chat.scrollToBottom) VIP.chat.scrollToBottom();
                }, 340);
            });
            // Siempre arranca abierto en cada ingreso: si el usuario lo quiere
            // cerrar, lo cierra él. No se recuerda el estado entre sesiones.
            applyHomePanel(false, false);
        }

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

        // Refund buttons (el diario fue eliminado 2026-07-28 — rangos 🥉🥈🥇)
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

        // Publisher welcome — bind de los botones del modal de bienvenida de 2 pasos
        if (VIP.publisherWelcome && typeof VIP.publisherWelcome.init === 'function') {
            VIP.publisherWelcome.init();
        }

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

        // Modal de oferta de verificación SMS (se muestra al primer ingreso).
        const smsOfferVerifyBtn = document.getElementById('smsOfferVerifyBtn');
        if (smsOfferVerifyBtn) smsOfferVerifyBtn.addEventListener('click', () => {
            VIP.ui.hideModal('smsOfferModal');
            const s1 = document.getElementById('verifyPhoneStep1');
            const s2 = document.getElementById('verifyPhoneStep2');
            const input = document.getElementById('verifyPhoneInput');
            const err = document.getElementById('verifyPhoneError');
            if (s1) s1.style.display = '';
            if (s2) s2.style.display = 'none';
            if (input) input.value = '';
            if (err) err.classList.remove('show');
            VIP.ui.showModal('verifyPhoneModal');
        });
        const smsOfferSkipBtn = document.getElementById('smsOfferSkipBtn');
        if (smsOfferSkipBtn) smsOfferSkipBtn.addEventListener('click', () => VIP.ui.hideModal('smsOfferModal'));

        // Modal de verificación de app + notificaciones (se abre al entrar).
        const appCheckCloseBtn = document.getElementById('appCheckCloseBtn');
        if (appCheckCloseBtn) appCheckCloseBtn.addEventListener('click', () => VIP.ui.hideModal('appCheckModal'));

        // Cartel de atención del home (cuenta sin teléfono verificado): abre verify-phone.
        const verifyPhoneBannerBtn = document.getElementById('verifyPhoneBannerBtn');
        if (verifyPhoneBannerBtn) verifyPhoneBannerBtn.addEventListener('click', () => {
            const s1 = document.getElementById('verifyPhoneStep1');
            const s2 = document.getElementById('verifyPhoneStep2');
            const input = document.getElementById('verifyPhoneInput');
            const err = document.getElementById('verifyPhoneError');
            if (s1) s1.style.display = '';
            if (s2) s2.style.display = 'none';
            if (input) input.value = '';
            if (err) err.classList.remove('show');
            VIP.ui.showModal('verifyPhoneModal');
        });
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
