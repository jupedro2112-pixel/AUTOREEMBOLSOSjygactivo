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
        // Diario, semanal y mensual — los tres con el % del RANGO del mes
        // (bronce/plata/oro). El diario volvió el 2026-08-14.
        updateRefundButton('daily', VIP.state.refundStatus.daily);
        updateRefundButton('weekly', VIP.state.refundStatus.weekly);
        updateRefundButton('monthly', VIP.state.refundStatus.monthly);
        updateRefundLabels();
        renderTier();
    }

    // Actualiza los % visibles (tooltips de los botones del dashboard y los spans
    // del modal unificado) con el % real del rango que devuelve el server.
    function updateRefundLabels() {
        const s = VIP.state.refundStatus;
        if (!s) return;
        const tip = (id, label, t) => {
            const el = document.getElementById(id);
            if (el && s[t] && s[t].percentage != null) el.title = `${label} ${s[t].percentage}%`;
        };
        tip('dailyRefundBtn', 'Reembolso Diario (pérdida de ayer)', 'daily');
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

    // Pinta el rango del mes (badge del dashboard + panel del modal unificado).
    function renderTier() {
        const t = VIP.state.refundStatus && VIP.state.refundStatus.tier;
        if (!t || !t.key) return;
        const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');

        const badge = document.getElementById('dashTierBadge');
        if (badge) {
            badge.style.display = '';
            badge.textContent = `TU RANGO: ${t.emoji || ''} ${(t.label || t.key).toUpperCase()} · ${t.percentage}%`;
        }

        const panel = document.getElementById('unifiedTierPanel');
        if (panel) {
            const tiers = t.tiers || {};
            const row = (tt, active) => tt ? `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;border-radius:6px;${active ? 'background:rgba(212,175,55,.18);border:1px solid rgba(212,175,55,.6);' : 'opacity:.75;'}">
                    <span style="font-size:12px;color:#fff;">${tt.emoji} ${tt.label}</span>
                    <span style="font-size:11px;color:#aaa;">${tt.upTo ? 'hasta ' + money(tt.upTo) : 'más de ' + money((tiers.plata && tiers.plata.upTo) || 0)}</span>
                    <span style="font-size:12px;font-weight:900;color:#ffd700;">${tt.percent}%</span>
                </div>` : '';
            const next = t.nextTier ? `
                <p style="font-size:11px;color:#00ff88;text-align:center;margin:6px 0 0;">
                    Te faltan <strong>${money(t.nextTier.missing)}</strong> de juego este mes para subir a ${t.nextTier.emoji} ${t.nextTier.label} (${t.nextTier.percent}%)
                </p>` : `
                <p style="font-size:11px;color:#ffd700;text-align:center;margin:6px 0 0;">¡Estás en el rango máximo! 🏆</p>`;
            panel.style.display = 'block';
            panel.innerHTML = `
                <div style="background:linear-gradient(135deg,#2d0052,#1a0033);border:1px solid #d4af37;border-radius:10px;padding:10px;margin-bottom:4px;">
                    <p style="text-align:center;font-size:13px;font-weight:900;color:#ffd700;margin:0 0 2px;">TU RANGO DEL MES: ${t.emoji} ${(t.label || '').toUpperCase()} — ${t.percentage}%</p>
                    <p style="text-align:center;font-size:10.5px;color:#aaa;margin:0 0 8px;">Se calcula con tu pérdida (NETWIN) del mes: ${money(t.monthNetLoss)}</p>
                    <div style="display:flex;flex-direction:column;gap:4px;">
                        ${row(tiers.bronce, t.key === 'bronce')}
                        ${row(tiers.plata, t.key === 'plata')}
                        ${row(tiers.oro, t.key === 'oro')}
                    </div>
                    ${next}
                    <p style="font-size:10px;color:#888;text-align:center;margin:6px 0 0;line-height:1.4;">El reembolso mensual usa el rango del mes que se reembolsa (el mes pasado); el semanal, el del mes de esa semana.</p>
                </div>`;
        }
    }

    function updateRefundButton(type, data) {
        const btn    = document.getElementById(`${type}RefundBtn`);
        const amount = document.getElementById(`${type}RefundAmount`);
        const timer  = document.getElementById(`${type}RefundTimer`);
        if (!btn || !amount || !timer || !data) return;

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
        // Diario, semanal y mensual (el diario volvió el 2026-08-14).
        if (type !== 'daily' && type !== 'weekly' && type !== 'monthly') return;

        if (!VIP.state.refundStatus) {
            VIP.ui.showToast('Cargando información de reembolsos...', 'info');
            await loadRefundStatus();
            if (!VIP.state.refundStatus) {
                VIP.ui.showToast('Error: No se pudo cargar la información de reembolsos. Intenta recargar la página.', 'error');
                return;
            }
        }

        const typeData = VIP.state.refundStatus[type];
        // El % viene del RANGO del mes (bronce/plata/oro) que calcula el server y
        // devuelve /api/refunds/status en `percentage`. Fallback = 3% (bronce).
        const pctOf = (t) => {
            const p = VIP.state.refundStatus[t] && VIP.state.refundStatus[t].percentage;
            return (p !== undefined && p !== null) ? p : 3;
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
                // La ventana del diario se reabre a las 00:00 del día siguiente.
                const tomorrow = new Date(lastClaim);
                tomorrow.setDate(tomorrow.getDate() + 1);
                tomorrow.setHours(0, 0, 0, 0);
                if (now < tomorrow) {
                    isClaimed = true;
                    const diff = tomorrow - now;
                    const hours = Math.floor(diff / (1000 * 60 * 60));
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

    // ────────────────────────────────────────────────────────────────────
    // MI MES — se abre tocando la card de USUARIO del dashboard.
    // Explica en un solo lugar: qué rango tiene, por qué, cuánto le falta para
    // subir, y cuánto tiene disponible AHORA en cada uno de los 3 reembolsos.
    // Todos los datos salen de GET /api/refunds/status (ya cacheado en
    // VIP.state.refundStatus); si no está cargado, se pide antes de abrir.
    // ────────────────────────────────────────────────────────────────────
    async function showMyMonthModal() {
        VIP.ui.showModal('myMonthModal');

        const body = document.getElementById('myMonthBody');
        const userEl = document.getElementById('myMonthUser');

        if (!VIP.state.refundStatus) {
            if (body) body.innerHTML = '<p style="text-align:center;color:#aaa;font-size:13px;padding:20px 0;">Cargando tu información...</p>';
            await loadRefundStatus();
        }

        const s = VIP.state.refundStatus;
        if (!s || !body) {
            if (body) body.innerHTML = '<p style="text-align:center;color:#ff8888;font-size:13px;padding:20px 0;">No pudimos cargar tus datos. Probá de nuevo en un momento.</p>';
            return;
        }

        const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
        const t = s.tier || {};
        const tiers = t.tiers || {};

        if (userEl) userEl.textContent = (s.user && s.user.username) ? '@' + s.user.username : '';

        // Fila de la tabla de rangos; la del rango actual va resaltada.
        const tierRow = (tt, active) => tt ? `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:6px 9px;border-radius:7px;${active ? 'background:rgba(212,175,55,.2);border:1px solid rgba(212,175,55,.7);' : 'opacity:.7;'}">
                <span style="font-size:12px;color:#fff;white-space:nowrap;">${tt.emoji} ${tt.label}${active ? ' <span style="color:#00ff88;font-size:9px;font-weight:900;">◄ VOS</span>' : ''}</span>
                <span style="font-size:10.5px;color:#aaa;text-align:right;">${tt.upTo ? 'hasta ' + money(tt.upTo) : 'más de ' + money((tiers.plata && tiers.plata.upTo) || 0)}</span>
                <span style="font-size:13px;font-weight:900;color:#ffd700;">${tt.percent}%</span>
            </div>` : '';

        // Tarjeta por tipo de reembolso, con su monto disponible y su período.
        const refundRow = (icon, nombre, cuando, data, color) => {
            if (!data) return '';
            const monto = Number(data.potentialAmount) || 0;
            const perdida = Number(data.netAmount) || 0;
            const pct = data.percentage != null ? data.percentage : (t.percentage || 0);
            const listo = data.canClaim && monto > 0;
            return `
            <div style="background:rgba(255,255,255,.05);border-left:3px solid ${color};border-radius:8px;padding:9px 11px;margin-bottom:7px;">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                    <span style="font-size:12.5px;font-weight:900;color:#fff;">${icon} ${nombre}</span>
                    <span style="font-size:15px;font-weight:900;color:${monto > 0 ? '#00ff88' : '#888'};">${money(monto)}</span>
                </div>
                <div style="font-size:10px;color:#aaa;margin-top:3px;line-height:1.45;">
                    ${cuando}<br>
                    Perdiste ${money(perdida)} → te vuelve el <strong style="color:#ffd700;">${pct}%</strong>
                </div>
                ${listo
                    ? '<div style="font-size:10px;color:#00ff88;font-weight:800;margin-top:4px;">✓ Listo para reclamar</div>'
                    : (monto <= 0
                        ? '<div style="font-size:10px;color:#888;margin-top:4px;">Sin pérdida en el período</div>'
                        : '<div style="font-size:10px;color:#ffaa44;margin-top:4px;">Todavía no disponible</div>')}
            </div>`;
        };

        const falta = t.nextTier
            ? `<p style="font-size:11.5px;color:#00ff88;text-align:center;margin:8px 0 0;line-height:1.5;">
                   Te faltan <strong>${money(t.nextTier.missing)}</strong> de pérdida este mes
                   para subir a ${t.nextTier.emoji} ${t.nextTier.label} y cobrar <strong>${t.nextTier.percent}%</strong>
               </p>`
            : `<p style="font-size:11.5px;color:#ffd700;text-align:center;margin:8px 0 0;">¡Estás en el rango máximo! 🏆</p>`;

        body.innerHTML = `
            <div style="background:linear-gradient(135deg,#2d0052,#1a0033);border:1px solid #d4af37;border-radius:12px;padding:12px;margin-bottom:12px;">
                <p style="text-align:center;font-size:10px;color:#aaa;margin:0 0 2px;letter-spacing:.5px;">TU RANGO DE ESTE MES</p>
                <p style="text-align:center;font-size:19px;font-weight:900;color:#ffd700;margin:0 0 2px;">${t.emoji || ''} ${(t.label || '').toUpperCase()}</p>
                <p style="text-align:center;font-size:13px;color:#fff;margin:0 0 8px;">Te reembolsan el <strong style="color:#00ff88;">${t.percentage || 0}%</strong> de lo que perdés</p>
                <p style="text-align:center;font-size:10.5px;color:#aaa;margin:0 0 9px;line-height:1.5;">
                    Tu rango sale de tu pérdida real (NETWIN) del mes:<br>
                    <strong style="color:#fff;">${money(t.monthNetLoss)}</strong>
                </p>
                <div style="display:flex;flex-direction:column;gap:5px;">
                    ${tierRow(tiers.bronce, t.key === 'bronce')}
                    ${tierRow(tiers.plata, t.key === 'plata')}
                    ${tierRow(tiers.oro, t.key === 'oro')}
                </div>
                ${falta}
            </div>

            <p style="font-size:11px;color:#ffd700;font-weight:900;margin:0 0 7px;letter-spacing:.4px;">TUS REEMBOLSOS AHORA</p>
            ${refundRow('📅', 'Diario', 'Por lo que perdiste AYER · se reclama todos los días', s.daily, '#1a9c5b')}
            ${refundRow('📆', 'Semanal', 'Por la semana pasada · se reclama lunes y martes', s.weekly, '#9d4edd')}
            ${refundRow('🗓️', 'Mensual', 'Por el mes pasado · se reclama desde el día 7', s.monthly, '#ff6b6b')}

            <div style="background:rgba(100,149,237,.1);border:1px solid rgba(100,149,237,.3);border-radius:8px;padding:9px 11px;margin-top:10px;">
                <p style="font-size:10.5px;color:#ccc;margin:0;line-height:1.6;">
                    💡 Los tres reembolsos son <strong>independientes</strong>: podés cobrar los tres.
                    Se calculan sobre tu <strong>NETWIN</strong> (lo que realmente perdiste jugando:
                    apostado − ganado), <u>no</u> sobre lo que cargaste.
                    Cuanto más jugás en el mes, más alto tu rango y mayor el % que te vuelve.
                </p>
            </div>

            <button onclick="VIP.ui.hideModal('myMonthModal');VIP.refunds.showUnifiedRefundModal();"
                    class="btn btn-primary" style="width:100%;margin-top:11px;font-size:14px;padding:12px;">
                🎁 Ir a reclamar mis reembolsos
            </button>`;
    }

    return {
        loadRefundStatus,
        updateRefundButtons,
        updateRefundButton,
        startCountdown,
        showRefundModal,
        claimRefund,
        showUnifiedRefundModal,
        showMyMonthModal
    };

})();

// Window aliases
window.showRefundModal = VIP.refunds.showRefundModal;
window.claimRefund     = VIP.refunds.claimRefund;
