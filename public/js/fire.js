// ========================================
// FIRE - Fueguito (racha diaria) module
// ========================================

window.VIP = window.VIP || {};

VIP.fire = (function () {

    async function loadFireStatus() {
        try {
            const response = await fetch(`${VIP.config.API_URL}/api/fire/status`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (response.ok) {
                VIP.state.fireStatus = await response.json();
                updateFireButton();
            }
        } catch (error) {
            console.error('Error cargando fueguito:', error);
        }
    }

    function updateFireButton() {
        if (!VIP.state.fireStatus) return;

        const btn    = document.getElementById('fireBtn');
        const streak = document.getElementById('fireStreak');
        if (!btn || !streak) return;

        streak.textContent = VIP.state.fireStatus.streak || 0;

        if (VIP.state.fireStatus.canClaim) {
            btn.style.animation = 'fire-pulse 1s ease infinite';
            btn.style.opacity   = '1';
        } else {
            btn.style.animation = 'none';
            btn.style.opacity   = '0.7';
        }
    }

    async function showFireModal() {
        // Siempre refrescar el estado al abrir: así se reflejan premios que el
        // servidor ya expiró/consumió (efectivo del mismo día, 100% próxima carga
        // aplicado por un operador) y no queda un botón de reclamo "viejo" por
        // estado cacheado en memoria.
        await loadFireStatus();
        if (!VIP.state.fireStatus) {
            VIP.ui.showToast('Error cargando datos del fueguito', 'error');
            return;
        }

        const streak = VIP.state.fireStatus.streak || 0;
        document.getElementById('fireStreakModal').textContent = streak;
        document.getElementById('fireLastClaim').textContent = VIP.state.fireStatus.lastClaim
            ? new Date(VIP.state.fireStatus.lastClaim).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })
            : 'Nunca';

        // Req 2: Progreso visual hasta 100 días
        const maxDays = 100;
        const progressPercent = Math.min((streak / maxDays) * 100, 100);
        document.getElementById('fireProgressBar').style.width = progressPercent + '%';
        document.getElementById('fireProgressBar').textContent = Math.round(progressPercent) + '%';
        document.getElementById('fireProgressText').textContent = `${Math.min(streak, maxDays)}/${maxDays} días`;

        const claimBtn  = document.getElementById('claimFireBtn');
        const condition = document.getElementById('fireCondition');

        if (VIP.state.fireCountdownInterval) {
            clearInterval(VIP.state.fireCountdownInterval);
        }

        const activityConditionEl = document.getElementById('fireActivityCondition');
        if (activityConditionEl) {
            activityConditionEl.innerHTML = '📋 <strong>Condición:</strong> Para acceder a las recompensas Fueguito diario necesitás tener movimientos de cargas durante el mes.';
        }

        const pendingBonusEl = document.getElementById('firePendingBonus');
        if (pendingBonusEl) {
            if (VIP.state.fireStatus.pendingNextLoadBonus) {
                pendingBonusEl.style.display = 'block';
                pendingBonusEl.innerHTML = '🎉 <strong style="color:#d4af37;">Tenés un 30% en tu próxima carga disponible!</strong> Avisale a un operador cuando quieras usarlo.';
            } else {
                pendingBonusEl.style.display = 'none';
            }
        }

        // Mostrar botón de reclamo de premio en efectivo si hay uno pendiente
        let claimRewardBtn = document.getElementById('claimFireRewardBtn');
        const pendingCash = VIP.state.fireStatus.pendingCashReward || 0;
        const pendingCashEl = document.getElementById('firePendingCashReward');
        if (pendingCashEl) {
            if (pendingCash > 0) {
                pendingCashEl.style.display = 'block';
                pendingCashEl.innerHTML = `
                    <strong style="color:#ffd700;">🏆 ¡Tenés $${pendingCash.toLocaleString('es-AR')} para reclamar!</strong><br>
                    <span style="font-size:12px;color:#ccc;">Premio de tu racha Fueguito día ${VIP.state.fireStatus.pendingCashRewardDay}</span><br>
                    <button id="claimFireRewardBtn" onclick="VIP.fire.claimFireReward()" style="margin-top:8px;background:linear-gradient(135deg,#d4af37,#ffd700);color:#000;border:none;padding:10px 20px;border-radius:20px;font-weight:900;font-size:14px;cursor:pointer;">💰 Reclamar $${pendingCash.toLocaleString('es-AR')}</button>
                `;
            } else {
                pendingCashEl.style.display = 'none';
            }
        }

        const milestonesEl = document.getElementById('fireMilestonesMenu');
        if (milestonesEl && VIP.state.fireStatus.milestones) {
            milestonesEl.innerHTML = VIP.state.fireStatus.milestones.map(m => {
                let statusIcon, statusLabel, statusClass;
                if (m.status === 'completed') {
                    statusIcon = '✅'; statusLabel = 'Completado'; statusClass = 'milestone-done';
                } else if (m.status === 'next') {
                    statusIcon = '🔓'; statusLabel = '¡Próximo!'; statusClass = 'milestone-next';
                } else {
                    statusIcon = '🔒'; statusLabel = 'Bloqueado'; statusClass = 'milestone-locked';
                }
                let rewardText;
                if (m.type === 'next_load_bonus') {
                    rewardText = '30% en próxima carga';
                } else {
                    rewardText = m.reward ? `$${m.reward.toLocaleString('es-AR')}` : '-';
                }
                const depositNote = m.hasDepositRequirement
                    ? ' <span style="font-size:10px;color:#ff8c00;">(requiere actividad del mes)</span>'
                    : '';
                return `<div class="milestone-item ${statusClass}" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;margin:4px 0;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);">
                    <span>${statusIcon} <strong>Día ${m.day}</strong>: ${rewardText}${depositNote}</span>
                    <span style="font-size:11px;color:#aaa;">${statusLabel}</span>
                </div>`;
            }).join('');
        }

        if (VIP.state.fireStatus.canClaim) {
            claimBtn.disabled = false;
            claimBtn.textContent = '🔥 Reclamar Fueguito';
            claimBtn.style.background = 'linear-gradient(135deg, #ff4500 0%, #ff6347 100%)';
            condition.innerHTML = '✅ <strong style="color: #00ff88;">Podés reclamar tu fueguito hoy!</strong>';
        } else {
            claimBtn.disabled = true;
            claimBtn.textContent = '⏳ Ya reclamado';
            claimBtn.style.background = '#666';
            startFireCountdown();
        }

        VIP.ui.showModal('fireModal');
    }

    function startFireCountdown() {
        if (VIP.state.fireCountdownInterval) {
            clearInterval(VIP.state.fireCountdownInterval);
        }

        const argentinaMidnight = getArgentinaMidnight();

        function updateCountdown() {
            const current = getArgentinaDate();
            const diff    = argentinaMidnight - current.getTime();

            if (diff <= 0) {
                loadFireStatus();
                if (VIP.state.fireCountdownInterval) {
                    clearInterval(VIP.state.fireCountdownInterval);
                }
                return;
            }

            const hours   = Math.floor(diff / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((diff % (1000 * 60)) / 1000);

            const condition = document.getElementById('fireCondition');
            if (condition && VIP.state.fireStatus && !VIP.state.fireStatus.canClaim) {
                condition.innerHTML = '⏳ Próximo fueguito disponible en: <strong style="color: #ff4500;">' +
                    String(hours).padStart(2, '0') + ':' +
                    String(minutes).padStart(2, '0') + ':' +
                    String(seconds).padStart(2, '0') + '</strong>';
            }
        }

        updateCountdown();
        VIP.state.fireCountdownInterval = setInterval(updateCountdown, 1000);
    }

    async function claimFire() {
        const claimBtn = document.getElementById('claimFireBtn');

        if (claimBtn) { claimBtn.disabled = true; claimBtn.textContent = 'Procesando...'; }

        try {
            const response = await fetch(`${VIP.config.API_URL}/api/fire/claim`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });

            const data = await response.json();

            if (response.ok && data.success) {
                VIP.ui.showToast(`🔥 ${data.message}`, 'success');

                VIP.state.fireStatus.canClaim   = false;
                VIP.state.fireStatus.lastClaim  = new Date().toISOString();
                VIP.state.fireStatus.streak     = data.streak;
                if (data.pendingNextLoadBonus !== undefined) {
                    VIP.state.fireStatus.pendingNextLoadBonus = data.pendingNextLoadBonus;
                }
                if (data.pendingCashReward !== undefined) {
                    VIP.state.fireStatus.pendingCashReward    = data.pendingCashReward;
                    VIP.state.fireStatus.pendingCashRewardDay = data.pendingCashRewardDay;
                }

                startFireCountdown();
                updateFireButton();

                if (data.rewardType === 'cash_pending') {
                    VIP.chat.sendSystemMessage(`🏆 ¡Fueguito día ${data.streak}! Tenés $${data.reward.toLocaleString('es-AR')} para reclamar en el recuadro de Fueguito.`);
                } else if (data.rewardType === 'next_load_bonus') {
                    VIP.chat.sendSystemMessage(`🎉 ¡Recompensa Fueguito día 15! Tenés 30% en tu próxima carga. Avisale a un operador cuando quieras usarlo.`);
                } else {
                    VIP.chat.sendSystemMessage(`🔥 Día ${data.streak} de racha Fueguito!`);
                }

                setTimeout(() => { VIP.ui.hideModal('fireModal'); }, 1500);
            } else {
                VIP.ui.showToast(data.error || data.message || 'Error', 'error');
                if (claimBtn) { claimBtn.disabled = false; claimBtn.textContent = '🔥 Reclamar Fueguito'; }
            }
        } catch (error) {
            console.error('Error reclamando fueguito:', error);
            VIP.ui.showToast('Error de conexión', 'error');
            if (claimBtn) { claimBtn.disabled = false; claimBtn.textContent = '🔥 Reclamar Fueguito'; }
        }
    }

    async function claimFireReward() {
        const btn = document.getElementById('claimFireRewardBtn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Cargando...'; }

        try {
            const response = await fetch(`${VIP.config.API_URL}/api/fire/claim-reward`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });

            const data = await response.json();

            if (response.ok && data.success) {
                VIP.ui.showToast(`🎉 ${data.message}`, 'success');
                VIP.state.fireStatus.pendingCashReward    = 0;
                VIP.state.fireStatus.pendingCashRewardDay = 0;
                VIP.chat.sendSystemMessage(`🎉 ¡Fueguito! ${data.message}`);
                // Recargar el modal para reflejar el cambio
                await loadFireStatus();
                setTimeout(() => { VIP.ui.hideModal('fireModal'); }, 1500);
            } else {
                const errMsg = data.error || 'Error al reclamar recompensa';
                VIP.ui.showToast('⚠️ ' + errMsg, 'error');
                if (btn) { btn.disabled = false; btn.textContent = `💰 Reclamar`; }
            }
        } catch (error) {
            console.error('Error reclamando recompensa fueguito:', error);
            VIP.ui.showToast('Error de conexión', 'error');
            if (btn) { btn.disabled = false; btn.textContent = `💰 Reclamar`; }
        }
    }

    return {
        loadFireStatus,
        updateFireButton,
        showFireModal,
        startFireCountdown,
        claimFire,
        claimFireReward
    };

})();

// Window aliases
window.showFireModal = VIP.fire.showFireModal;
window.claimFire     = VIP.fire.claimFire;
