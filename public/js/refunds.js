// ========================================
// REFUNDS - Reembolsos module
// ========================================

window.VIP = window.VIP || {};

VIP.refunds = (function () {

    async function loadRefundStatus() {
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/refunds/status`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (response.ok) {
                VIP.state.refundStatus = await response.json();
                updateRefundButtons();
            }
        } catch (error) {
            console.error('Error cargando reembolsos:', error);
        }
    }

    function updateRefundButtons() {
        if (!VIP.state.refundStatus) return;
        updateRefundButton('daily', VIP.state.refundStatus.daily);
        updateRefundButton('weekly', VIP.state.refundStatus.weekly);
        updateRefundButton('monthly', VIP.state.refundStatus.monthly);
        updateRefundLabels();
    }

    // Actualiza los % visibles (tooltips de los botones del dashboard y los spans
    // del modal unificado) con el valor real configurado en el panel.
    function updateRefundLabels() {
        const s = VIP.state.refundStatus;
        if (!s) return;
        const tip = (id, label, t) => {
            const el = document.getElementById(id);
            if (el && s[t] && s[t].percentage != null) el.title = `${label} ${s[t].percentage}%`;
        };
        tip('dailyRefundBtn', 'Reembolso Diario', 'daily');
        tip('weeklyRefundBtn', 'Reembolso Semanal (Lun-Mar)', 'weekly');
        tip('monthlyRefundBtn', 'Reembolso Mensual (Desde día 7)', 'monthly');
        const pctSpan = (id, t) => {
            const el = document.getElementById(id);
            if (el && s[t] && s[t].percentage != null) el.textContent = s[t].percentage;
        };
        pctSpan('unifiedDailyPct', 'daily');
        pctSpan('unifiedWeeklyPct', 'weekly');
        pctSpan('unifiedMonthlyPct', 'monthly');
    }

    function updateRefundButton(type, data) {
        const btn    = document.getElementById(`${type}RefundBtn`);
        const amount = document.getElementById(`${type}RefundAmount`);
        const timer  = document.getElementById(`${type}RefundTimer`);

        amount.textContent = `$${data.potentialAmount.toLocaleString()}`;

        btn.disabled = false;
        btn.classList.remove('claimed');

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
        // Los porcentajes son configurables desde el panel; los tomamos del estado
        // (campo `percentage` que devuelve /api/refunds/status) en vez de hardcodear.
        const pctOf = (t) => {
            const p = VIP.state.refundStatus[t] && VIP.state.refundStatus[t].percentage;
            return (p !== undefined && p !== null) ? p : { daily: 20, weekly: 10, monthly: 5 }[t];
        };
        const titles = {
            daily:   `📅 Reembolso Diario (${pctOf('daily')}%)`,
            weekly:  `📆 Reembolso Semanal (${pctOf('weekly')}%)`,
            monthly: `🗓️ Reembolso Mensual (${pctOf('monthly')}%)`
        };
        const periodLabels = {
            daily:   '🎮 TU NETWIN DE AYER (pérdida real jugando)',
            weekly:  '🎮 TU NETWIN DE LA SEMANA PASADA (Lun-Dom)',
            monthly: '🎮 TU NETWIN DEL MES PASADO'
        };

        document.getElementById('refundModalTitle').textContent = titles[type];
        document.getElementById('refundMovementsTitle').textContent = periodLabels[type];

        const currentBalance = VIP.state.refundStatus.user?.currentBalance || 0;
        document.getElementById('refundCurrentBalance').textContent = `$${currentBalance.toLocaleString()}`;
        document.getElementById('refundPeriod').textContent = typeData.period || '-';
        document.getElementById('refundNetAmount').textContent = `$${(typeData.netAmount || 0).toLocaleString()}`;
        document.getElementById('refundAmount').textContent = `$${(typeData.potentialAmount || 0).toLocaleString()}`;

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
            const isClaimableDay = today >= 7;
            if (!isClaimableDay) {
                availabilityInfo.style.display = 'block';
                availabilityInfo.style.background = 'rgba(255,165,0,0.1)';
                availabilityInfo.style.border = '1px solid rgba(255,165,0,0.3)';
                availabilityInfo.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 20px;">ℹ️</span>
                        <div>
                            <p style="color: #ffa500; font-weight: bold; margin: 0; font-size: 12px;">Reembolso Mensual</p>
                            <p style="color: #ccc; margin: 0; font-size: 11px;">Solo reclamable <strong>después del día 7</strong> de cada mes</p>
                            <p style="color: #aaa; margin: 0; font-size: 10px;">Corresponde al mes anterior completo</p>
                        </div>
                    </div>
                `;
            }
        }

        const extraInfo = document.getElementById('refundExtraInfo');
        const claimBtn  = document.getElementById('claimRefundBtn');
        let isClaimed     = false;
        let timeRemaining = '';

        if (typeData.lastClaim) {
            const lastClaim = new Date(typeData.lastClaim);
            const now = new Date();

            if (type === 'daily') {
                const tomorrow = new Date(lastClaim);
                tomorrow.setDate(tomorrow.getDate() + 1);
                tomorrow.setHours(0, 0, 0, 0);
                if (now < tomorrow) {
                    isClaimed = true;
                    const diff = tomorrow - now;
                    const hours   = Math.floor(diff / (1000 * 60 * 60));
                    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                    timeRemaining = `${hours}h ${minutes}m`;
                }
            } else if (type === 'weekly') {
                const nextMonday = new Date(lastClaim);
                const daysUntilMonday = (8 - lastClaim.getDay()) % 7 || 7;
                nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
                nextMonday.setHours(0, 0, 0, 0);
                if (now < nextMonday) {
                    isClaimed = true;
                    const diff = nextMonday - now;
                    const days  = Math.floor(diff / (1000 * 60 * 60 * 24));
                    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                    timeRemaining = `${days}d ${hours}h`;
                }
            } else if (type === 'monthly') {
                const nextMonth = new Date(lastClaim.getFullYear(), lastClaim.getMonth() + 1, 7);
                nextMonth.setHours(0, 0, 0, 0);
                if (now < nextMonth) {
                    isClaimed = true;
                    const diff = nextMonth - now;
                    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
                    timeRemaining = `${days}d`;
                }
            }
        }

        if (typeData.potentialAmount <= 0) {
            extraInfo.innerHTML = '<span style="color: #ff8888;">⚠️ No tenés pérdida (NETWIN) en el período. El reembolso es sobre lo que perdiste jugando.</span>';
            claimBtn.disabled = true;
            claimBtn.textContent = '❌ Sin pérdida para reembolsar';
            claimBtn.style.background = 'linear-gradient(135deg, #666 0%, #444 100%)';
        } else if (isClaimed) {
            extraInfo.innerHTML = `<span style="color: #ffaa44;">⏳ Ya reclamaste este reembolso. Disponible en: <strong>${timeRemaining}</strong></span>`;
            claimBtn.disabled = true;
            claimBtn.textContent = `⏳ Disponible en ${timeRemaining}`;
            claimBtn.style.background = 'linear-gradient(135deg, #666 0%, #444 100%)';
        } else if (!typeData.canClaim) {
            extraInfo.innerHTML = '<span style="color: #ffaa44;">⏳ No puedes reclamar este reembolso en este momento.</span>';
            claimBtn.disabled = true;
            claimBtn.textContent = '⏳ No disponible';
            claimBtn.style.background = 'linear-gradient(135deg, #666 0%, #444 100%)';
        } else {
            extraInfo.innerHTML = '<span style="color: #00ff88;">✅ ¡Puedes reclamar este reembolso!</span>';
            claimBtn.disabled = false;
            claimBtn.textContent = '🎁 Reclamar Reembolso';
            claimBtn.style.background = '';
        }

        claimBtn.onclick = () => claimRefund(type);

        VIP.ui.showModal('refundModal');
    }

    async function claimRefund(type) {
        const claimBtn = document.getElementById('claimRefundBtn');
        if (claimBtn) {
            if (claimBtn.disabled) return;
            claimBtn.disabled = true;
            claimBtn.textContent = '⏳ Procesando...';
        }
        try {
            const metaEventId = VIP.pixel && VIP.pixel.enabled ? VIP.pixel.newEventId() : null;
            const response = await fetch(`${VIP.config.API_URL}/api/refunds/claim/${type}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${VIP.state.currentToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ metaEventId })
            });

            const data = await response.json();

            if (data.success) {
                VIP.ui.showToast(`✅ ${data.message}`, 'success');
                VIP.ui.hideModal('refundModal');
                loadRefundStatus();
                VIP.chat.sendSystemMessage(`🎁 Reembolso ${type} reclamado: $${data.amount.toLocaleString()}`);

                // Meta Pixel — RefundClaim (custom, deduplicado con CAPI).
                if (VIP.pixel) VIP.pixel.trackWithId(metaEventId, 'RefundClaim', {
                    value: data.amount,
                    currency: 'ARS',
                    content_name: `refund_${type}`
                });
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

    return {
        loadRefundStatus,
        updateRefundButtons,
        updateRefundButton,
        startCountdown,
        showRefundModal,
        claimRefund,
        showUnifiedRefundModal
    };

})();

// Window aliases
window.showRefundModal = VIP.refunds.showRefundModal;
window.claimRefund     = VIP.refunds.claimRefund;
