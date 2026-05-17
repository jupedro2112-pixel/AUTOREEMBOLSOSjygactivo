// =====================================================================
// RAFFLES — Sorteos pagos + gratis (cliente)
// =====================================================================
// Sorteos PAGOS: 4 niveles ($2M/$1M/$500k/$100k). Comprás números con tu
// saldo. Podés ELEGIR los números que quieras del grid 1-100. Si ganás, el
// premio se acredita automáticamente.
// Sorteos GRATIS: 4 niveles para clientes activos. Auto-participación: si
// tuviste cargas suficientes en los últimos 30 días, el sistema te asigna
// un número automáticamente cuando abrís el modal. 1 número por persona.
// =====================================================================
window.VIP = window.VIP || {};

VIP.raffles = (function () {
    // _data se mantiene entre aperturas: la primera vez que el user abre el
    // modal, hay un fetch (~200-500ms). En las aperturas siguientes mostramos
    // instantaneo lo que tenemos y refresheamos en background. Despues de
    // cerrar y abrir el modal, NO hay flash de "Cargando…".
    let _data = null;
    let _dataFetchedAt = 0;
    const _DATA_FRESHNESS_MS = 30 * 1000; // 30s = render directo, mas viejo refresca y muestra
    let _refreshTimer = null;
    let _buying = false;
    let _claiming = false;
    let _picker = null; // { raffleId, picked: Set<number> }
    let _inflightFetch = null;

    async function _fetchActive() {
        // Coalesce: si ya hay un fetch en vuelo, devolvemos esa promesa para
        // no duplicar trabajo cuando _render se dispara varias veces seguidas.
        if (_inflightFetch) return _inflightFetch;
        _inflightFetch = (async () => {
            try {
                const r = await fetch(`${VIP.config.API_URL}/api/raffles/active`, {
                    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
                });
                if (!r.ok) return null;
                return await r.json();
            } catch (e) {
                console.error('raffles fetch error:', e);
                return null;
            } finally {
                // Liberamos el slot en el siguiente tick para que callers que
                // esperaban la misma promesa terminen de leerla antes.
                setTimeout(() => { _inflightFetch = null; }, 0);
            }
        })();
        return _inflightFetch;
    }

    function _esc(s) {
        const div = document.createElement('div');
        div.textContent = String(s == null ? '' : s);
        return div.innerHTML;
    }

    function _fmt(n) {
        return Number(n || 0).toLocaleString('es-AR');
    }

    // Tapamos el 80% inicial del username del ganador en la vista pública,
    // dejando los últimos chars visibles. Privacidad: cualquiera ve "Ganó
    // @****dj" sin poder identificar al user completo. Mínimo 2 chars
    // visibles para que el ganador real se reconozca.
    function _maskUsername(u) {
        const s = String(u || '').trim();
        if (!s) return '—';
        const len = s.length;
        const mask = Math.max(1, Math.floor(len * 0.8));
        const visible = Math.max(2, len - mask);
        const visibleStart = len - visible;
        return '*'.repeat(visibleStart) + s.slice(visibleStart);
    }

    function _formatNumbers(nums) {
        if (!nums || !nums.length) return '';
        const sorted = nums.slice().sort((a, b) => a - b);
        return sorted.map(n => '#' + n).join(', ');
    }

    // "Faltan X días/horas para el sorteo". Si la fecha ya paso, dice
    // "El sorteo es HOY" (lunes mismo) o "Sorteado".
    function _countdownText(drawDateStr) {
        if (!drawDateStr) return 'Esperando fecha';
        const ms = new Date(drawDateStr).getTime() - Date.now();
        if (!Number.isFinite(ms)) return 'Esperando fecha';
        if (ms <= 0) return 'Sorteándose ahora · revisá en un rato';
        const days = Math.floor(ms / (24 * 3600 * 1000));
        const hours = Math.floor((ms % (24 * 3600 * 1000)) / (3600 * 1000));
        if (days >= 1) return 'Faltan ' + days + (days === 1 ? ' día' : ' días') + (hours > 0 ? ' y ' + hours + 'h' : '');
        if (hours >= 1) return 'Faltan ' + hours + 'h';
        const mins = Math.max(1, Math.floor(ms / 60000));
        return 'Faltan ' + mins + ' min';
    }

    // Bloque "PENDIENTE de sorteo" para sorteos cerrados (cupo lleno).
    // Mas visible que el aviso chiquito anterior — la gente ve que ya
    // estan en carrera y cuando se sortea.
    function _renderPendingBlock(r, accentColor, totalParticipantsLabel) {
        const drawStr = r.drawDate
            ? new Date(r.drawDate).toLocaleString('es-AR', { weekday:'long', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })
            : '—';
        const countdown = _countdownText(r.drawDate);
        let html = '';
        html += '<div style="background:linear-gradient(135deg,rgba(255,170,102,0.10),rgba(255,170,102,0.04));border:2px solid #ffaa66;border-radius:10px;padding:12px;text-align:center;">';
        html += '  <div style="display:inline-block;background:#ffaa66;color:#000;font-weight:900;font-size:10px;letter-spacing:2px;padding:3px 10px;border-radius:12px;margin-bottom:6px;">⏳ COMPLETADO · PENDIENTE</div>';
        html += '  <div style="color:#fff;font-size:13px;font-weight:800;line-height:1.4;margin-bottom:4px;">Cupo lleno. Estás en carrera 🎯</div>';
        html += '  <div style="color:#ffaa66;font-size:12px;font-weight:800;letter-spacing:0.5px;margin-bottom:6px;">' + countdown + '</div>';
        html += '  <div style="color:#ddd;font-size:11px;line-height:1.5;">📅 ' + drawStr + '<br>1° premio Lotería Nocturna' + (totalParticipantsLabel ? ' · ' + totalParticipantsLabel : '') + '</div>';
        html += '</div>';
        return html;
    }

    // Banner unificado de "FELICITACIONES" para sorteos ganados en las
    // ultimas 24h. Si el premio ya fue acreditado automaticamente, mostramos
    // un mensaje celebratorio sin boton. Si todavia hay que reclamar, el
    // boton dispara claimPrize().
    function _renderRecentWinsBanner(recentWins) {
        if (!recentWins || !recentWins.length) return '';
        let html = '<div style="background:linear-gradient(135deg,#0f4c00,#1a8200,#ffd700);background-size:200% 200%;border:3px solid #ffd700;border-radius:16px;padding:18px;margin-bottom:14px;box-shadow:0 0 20px rgba(255,215,0,0.40);position:relative;overflow:hidden;">';
        html += '<div style="position:absolute;top:-10px;right:-10px;font-size:80px;opacity:0.10;">🏆</div>';
        html += '<div style="color:#ffd700;font-weight:900;font-size:14px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px;text-shadow:0 1px 2px rgba(0,0,0,0.50);">🎉 ¡FELICITACIONES, GANASTE!</div>';
        html += '<div style="color:#fff;font-size:11.5px;margin-bottom:10px;line-height:1.5;font-weight:600;">Esto se queda visible por <strong style="color:#ffd700;">24 horas</strong> para que lo veas con tranquilidad 💫</div>';
        for (const c of recentWins) {
            const credited = !!c.prizeClaimedAt;
            const needsClaim = !credited && c.prizeClaimable;
            html += '<div style="background:rgba(0,0,0,0.50);border-radius:10px;padding:12px;margin-top:10px;border:1px solid rgba(255,215,0,0.40);">';
            html += '<div style="color:#fff;font-weight:900;font-size:15px;margin-bottom:6px;">' + (c.emoji || '🏆') + ' ' + _esc(c.name) + '</div>';
            html += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;">';
            html += '<div style="background:rgba(255,215,0,0.15);border:1px solid rgba(255,215,0,0.40);border-radius:8px;padding:8px 12px;flex:1;min-width:120px;text-align:center;">';
            html += '<div style="color:#ffd700;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;">Número ganador</div>';
            html += '<div style="color:#fff;font-size:24px;font-weight:900;line-height:1.2;">#' + c.winningTicketNumber + '</div>';
            html += '</div>';
            html += '<div style="background:rgba(102,255,102,0.10);border:1px solid rgba(102,255,102,0.40);border-radius:8px;padding:8px 12px;flex:1;min-width:120px;text-align:center;">';
            html += '<div style="color:#66ff66;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;">Premio</div>';
            html += '<div style="color:#fff;font-size:20px;font-weight:900;line-height:1.2;">$' + _fmt(c.prizeValueARS) + '</div>';
            html += '</div></div>';
            if (credited) {
                html += '<div style="background:rgba(102,255,102,0.20);border:1px solid #66ff66;border-radius:8px;padding:10px;text-align:center;">';
                html += '<div style="color:#66ff66;font-size:13px;font-weight:900;">✅ Premio acreditado a tu saldo</div>';
                html += '<div style="color:#bbe6bb;font-size:11px;margin-top:2px;">Ya está disponible para jugar — ¡buena suerte! 🎰</div>';
                html += '</div>';
            } else if (needsClaim) {
                html += '<button type="button" data-raffle-action="claim" data-raffle-id="' + _esc(c.id) + '" style="width:100%;background:linear-gradient(135deg,#ffd700,#f7931e);color:#000;border:none;padding:13px;border-radius:10px;font-weight:900;font-size:15px;cursor:pointer;letter-spacing:1px;box-shadow:0 4px 10px rgba(255,215,0,0.30);">🎁 RECLAMAR $' + _fmt(c.prizeValueARS) + '</button>';
                html += '<div style="color:#ffe699;font-size:10px;text-align:center;margin-top:6px;">⚠️ La acreditación automática falló — tocá el botón para acreditar manualmente.</div>';
            } else {
                html += '<div style="background:rgba(255,170,102,0.15);border:1px solid rgba(255,170,102,0.40);border-radius:8px;padding:10px;text-align:center;">';
                html += '<div style="color:#ffaa66;font-size:12px;font-weight:700;">⏳ Estamos acreditando tu premio…</div>';
                html += '</div>';
            }
            // Countdown: si ya cobro, ventana de 30 min con timer en mm:ss.
            // Si no cobro, sigue mostrando ~Xh restantes como antes.
            if (credited && typeof c.secondsRemaining === 'number' && c.secondsRemaining > 0) {
                const expiresAt = new Date(Date.now() + c.secondsRemaining * 1000).getTime();
                html += '<div data-claim-countdown="' + expiresAt + '" style="color:#ffe699;font-size:11px;text-align:center;margin-top:8px;font-weight:700;">⏱ Esta felicitación queda <span class="claim-countdown-text">30:00</span> más</div>';
            } else if (c.hoursRemaining > 0) {
                html += '<div style="color:#aaa;font-size:10px;text-align:center;margin-top:6px;font-style:italic;">Esta felicitación se oculta en ~' + c.hoursRemaining + ' h</div>';
            }
            html += '</div>';
        }
        html += '</div>';
        return html;
    }

    // Banner legacy "Reclamable" — para casos donde recentWins no aplica
    // (sorteo viejo > 24h con auto-credit fallido). Mantenemos compat.
    function _renderClaimableBanner(claimable, recentWinIds) {
        if (!claimable || !claimable.length) return '';
        const skip = new Set(recentWinIds || []);
        const rest = claimable.filter(c => !skip.has(c.id));
        if (rest.length === 0) return '';
        let html = '<div style="background:linear-gradient(135deg,#0f4c00,#1a8200);border:2px solid #66ff66;border-radius:12px;padding:14px;margin-bottom:14px;">';
        html += '<div style="color:#66ff66;font-weight:900;font-size:13px;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">🏆 Premio sin reclamar</div>';
        html += '<div style="color:#bbe6bb;font-size:11px;margin-bottom:8px;line-height:1.4;">Tenés un premio anterior que aún no se acreditó. Tocá el botón para acreditarlo a tu saldo.</div>';
        for (const c of rest) {
            html += '<div style="background:rgba(0,0,0,0.30);border-radius:8px;padding:10px;margin-top:8px;">';
            html += '<div style="color:#fff;font-weight:800;font-size:14px;margin-bottom:4px;">' + (c.emoji || '🏆') + ' ' + _esc(c.name) + '</div>';
            html += '<div style="color:#ddd;font-size:12px;margin-bottom:8px;">Número ganador: <strong>#' + c.winningTicketNumber + '</strong> · Premio: <strong>$' + _fmt(c.prizeValueARS) + '</strong></div>';
            html += '<button type="button" data-raffle-action="claim" data-raffle-id="' + _esc(c.id) + '" style="width:100%;background:#ffd700;color:#000;border:none;padding:11px;border-radius:8px;font-weight:900;font-size:14px;cursor:pointer;letter-spacing:1px;">🎁 RECLAMAR $' + _fmt(c.prizeValueARS) + '</button>';
            html += '</div>';
        }
        html += '</div>';
        return html;
    }

    function _renderAutoEnrolledBanner(autoEnrolled) {
        if (!autoEnrolled || !autoEnrolled.length) return '';
        let html = '<div style="background:linear-gradient(135deg,#1a3d6e,#2a5a8a);border:2px solid #4dabff;border-radius:12px;padding:12px;margin-bottom:14px;">';
        html += '<div style="color:#4dabff;font-weight:900;font-size:12px;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">🎉 Te anotamos en sorteos gratis</div>';
        html += '<div style="color:#dde9f0;font-size:12px;line-height:1.5;">Por tus cargas de este mes te tocan estos números <strong>gratis</strong>:</div>';
        html += '<ul style="margin:6px 0 0;padding-left:18px;color:#fff;font-size:12.5px;line-height:1.8;">';
        for (const e of autoEnrolled) {
            html += '<li>' + (e.emoji || '🎁') + ' <strong>' + _esc(e.raffleName) + '</strong> — número <strong>#' + e.ticketNumber + '</strong> (premio $' + _fmt(e.prizeValueARS) + ')</li>';
        }
        html += '</ul></div>';
        return html;
    }

    function _renderPaidCard(r, balance) {
        const sold = r.cuposSold || 0;
        const total = r.totalTickets || 0;
        const remaining = r.cuposRemaining;
        const fillPct = total ? Math.round((sold / total) * 100) : 0;
        const myNums = r.myTicketNumbers || [];
        const closed = r.status !== 'active';
        const drawn = r.status === 'drawn';
        const canAfford = balance >= (r.entryCost || 0);

        let html = '<div style="background:rgba(255,255,255,0.04);border:1px solid rgba(212,175,55,0.30);border-radius:10px;padding:9px 11px;margin-bottom:7px;">';
        html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">';
        html += '<div style="font-size:24px;line-height:1;">' + (r.emoji || '🎁') + '</div>';
        html += '<div style="flex:1;min-width:0;">';
        html += '<div style="color:#ffd700;font-size:13px;font-weight:900;line-height:1.2;">' + _esc(r.name) + '</div>';
        html += '<div style="color:#bbb;font-size:10.5px;line-height:1.3;"><strong style="color:#fff;">$' + _fmt(r.prizeValueARS) + '</strong> · ' + total + '×$' + _fmt(r.entryCost) + '</div>';
        html += '</div></div>';

        html += '<div style="height:5px;background:rgba(0,0,0,0.30);border-radius:3px;overflow:hidden;margin:5px 0 3px;">';
        html += '<div style="height:100%;width:' + fillPct + '%;background:linear-gradient(90deg,#d4af37,#ffd700);"></div></div>';
        html += '<div style="display:flex;justify-content:space-between;font-size:10px;color:#999;margin-bottom:6px;">';
        html += '<span>' + sold + '/' + total + ' (' + fillPct + '%)</span>';
        html += '<span>' + remaining + ' disp.</span></div>';

        if (myNums.length > 0) {
            html += '<div style="background:rgba(212,175,55,0.10);border:1px solid rgba(212,175,55,0.30);border-radius:6px;padding:6px 8px;margin-bottom:6px;">';
            html += '<span style="color:#ffd700;font-size:10px;font-weight:800;">TUS NÚMEROS (' + myNums.length + '): </span>';
            html += '<span style="color:#fff;font-size:12px;font-weight:700;word-break:break-word;">' + _esc(_formatNumbers(myNums)) + '</span></div>';
        }

        if (drawn) {
            const youWon = r.iAmWinner;
            html += '<div style="background:' + (youWon ? 'rgba(102,255,102,0.10)' : 'rgba(255,107,53,0.10)') + ';border-radius:6px;padding:7px 9px;font-size:11.5px;line-height:1.35;color:#ddd;">';
            html += youWon
                ? '🏆 <strong style="color:#66ff66;">¡Ganaste!</strong> #' + r.winningTicketNumber + '. ' + (r.prizeClaimedAt ? 'Acreditado.' : 'Tocá Reclamar arriba.')
                : '🎲 #' + r.winningTicketNumber + ' — @' + _esc(r.winnerUsername || '');
            html += '</div>';
        } else if (closed) {
            const myCount = myNums.length;
            const partLabel = myCount > 0 ? 'Tenés ' + myCount + (myCount === 1 ? ' número en juego' : ' números en juego') : (sold + ' jugadores anotados');
            html += _renderPendingBlock(r, '#ffaa66', partLabel);
        } else {
            html += '<button type="button" data-raffle-action="open-picker" data-raffle-id="' + _esc(r.id) + '" ' + (canAfford ? '' : 'disabled') + ' style="width:100%;background:' + (canAfford ? 'linear-gradient(135deg,#d4af37,#f7931e)' : 'rgba(120,120,120,0.40)') + ';color:#000;border:none;padding:8px;border-radius:7px;font-weight:900;font-size:12px;cursor:' + (canAfford ? 'pointer' : 'not-allowed') + ';letter-spacing:0.5px;">' + (canAfford ? '🎫 ELEGIR NÚMEROS' : '🔒 SIN SALDO') + '</button>';
        }

        html += '</div>';
        return html;
    }

    function _renderFreeCard(r) {
        const sold = r.cuposSold || 0;
        const total = r.totalTickets || 0;
        const remaining = r.cuposRemaining;
        const fillPct = total ? Math.round((sold / total) * 100) : 0;
        const myNums = r.myTicketNumbers || [];
        const closed = r.status !== 'active';
        const drawn = r.status === 'drawn';
        const enrolled = myNums.length > 0;

        let html = '<div style="background:rgba(77,171,255,0.06);border:1px solid rgba(77,171,255,0.40);border-radius:10px;padding:9px 11px;margin-bottom:7px;">';
        html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">';
        html += '<div style="font-size:24px;line-height:1;">' + (r.emoji || '🎁') + '</div>';
        html += '<div style="flex:1;min-width:0;">';
        html += '<div style="color:#4dabff;font-size:13px;font-weight:900;line-height:1.2;">' + _esc(r.name) + '</div>';
        const _byNetLoss = Number(r.minNetLossARS || 0) > 0;
        if (_byNetLoss) {
            html += '<div style="color:#bbb;font-size:10.5px;line-height:1.3;"><strong style="color:#fff;">$' + _fmt(r.prizeValueARS) + '</strong> · perdiste ≥ <strong style="color:#ffaa66;">$' + _fmt(r.minNetLossARS) + '</strong></div>';
        } else {
            html += '<div style="color:#bbb;font-size:10.5px;line-height:1.3;"><strong style="color:#fff;">$' + _fmt(r.prizeValueARS) + '</strong> · cargaste ≥ <strong style="color:#4dabff;">$' + _fmt(r.minCargasARS) + '</strong></div>';
        }
        html += '</div></div>';

        html += '<div style="height:5px;background:rgba(0,0,0,0.30);border-radius:3px;overflow:hidden;margin:5px 0 3px;">';
        html += '<div style="height:100%;width:' + fillPct + '%;background:linear-gradient(90deg,#4dabff,#79c2ff);"></div></div>';
        html += '<div style="display:flex;justify-content:space-between;font-size:10px;color:#999;margin-bottom:6px;">';
        html += '<span>' + sold + '/' + total + ' (' + fillPct + '%)</span>';
        html += '<span>' + remaining + ' lugares</span></div>';

        // Caja "estás anotado" compacta.
        if (enrolled) {
            html += '<div style="background:rgba(77,171,255,0.15);border:1px solid #4dabff;border-radius:6px;padding:6px 8px;text-align:center;margin-bottom:6px;">';
            html += '<span style="color:#4dabff;font-size:10px;font-weight:800;letter-spacing:1px;">✅ ANOTADO · </span>';
            html += '<span style="color:#fff;font-size:14px;font-weight:900;">#' + myNums[0] + '</span>';
            html += '</div>';
        }

        if (drawn) {
            html += '<div style="background:rgba(0,0,0,0.30);border-radius:6px;padding:7px 9px;font-size:11.5px;color:#aaa;">🎲 #' + r.winningTicketNumber + ' — @' + _esc(r.winnerUsername || '') + '</div>';
        } else if (closed) {
            const partLabel = enrolled ? 'Tu #' + myNums[0] + ' está en carrera' : (sold + ' personas en carrera');
            html += _renderPendingBlock(r, '#4dabff', partLabel);
        } else if (!enrolled) {
            // El boton "ELEGIR" se muestra SIEMPRE — el server valida el
            // threshold de cargas en /buy y rechaza con un error claro si
            // el user no llego. Antes el front gateaba el boton, lo que
            // confundia a los users que pensaban "no me deja elegir el
            // numero" cuando en realidad les faltaban cargas. Mostrar el
            // boton + aviso lateral es mas transparente.
            // Si el sorteo está por NETWIN, miramos perdida neta (cargas −
            // retiros). Si está por CARGAS legacy, miramos solo cargas.
            const useNetLoss = Number(r.minNetLossARS || 0) > 0;
            const threshold = useNetLoss ? Number(r.minNetLossARS || 0) : Number(r.minCargasARS || 0);
            const have = useNetLoss
                ? ((_data && Number(_data.weeklyNetLoss)) || 0)
                : ((_data && Number(_data.weeklyDeposits)) || 0);
            const reached = threshold > 0 ? have >= threshold : true;
            const shortfall = Math.max(0, threshold - have);
            if (reached) {
                html += '<div style="background:rgba(102,255,102,0.08);border:1px dashed rgba(102,255,102,0.40);border-radius:6px;padding:8px;margin:6px 0 8px;font-size:11px;color:#ddd;line-height:1.5;">';
                if (useNetLoss) {
                    html += '✅ <strong style="color:#66ff66;">¡Tenés número!</strong> Perdiste <strong style="color:#fff;">$' + _fmt(have) + '</strong> esta semana. Tocá <strong>"Elegir mi número"</strong> y reclamá tu cupo (1 por persona). Aunque después ganes, el número queda para vos.';
                } else {
                    html += '✅ <strong style="color:#66ff66;">¡Calificás!</strong> Llegaste al mínimo de cargas. Tocá <strong>"Elegir mi número"</strong> y reservá tu cupo (1 por persona).';
                }
                html += '</div>';
            } else {
                html += '<div style="background:rgba(255,170,102,0.10);border:1px solid rgba(255,170,102,0.30);border-radius:6px;padding:8px;margin:6px 0 8px;font-size:11px;color:#ffaa66;line-height:1.5;">';
                if (useNetLoss) {
                    html += '⚠️ <strong>Te faltan $' + _fmt(shortfall) + '</strong> de pérdida neta esta semana (lun-dom).<br>';
                    html += '<span style="color:#ddd;">Llevás perdidos <strong style="color:#fff;">$' + _fmt(have) + '</strong> de $' + _fmt(threshold) + '. Si seguís jugando y perdés, te toca número.</span>';
                } else {
                    html += '⚠️ <strong>Te faltan $' + _fmt(shortfall) + '</strong> de cargas esta semana (lun-dom).<br>';
                    html += '<span style="color:#ddd;">Llevás <strong style="color:#fff;">$' + _fmt(have) + '</strong> de $' + _fmt(threshold) + '. Podés intentar elegir, pero el sistema rechaza si no llegaste.</span>';
                }
                html += '</div>';
            }
            const ctaBg = reached
                ? 'linear-gradient(135deg,#66ff66,#4dabff)'
                : 'linear-gradient(135deg,#888,#aaa)';
            html += '<button type="button" data-raffle-action="open-picker" data-raffle-id="' + _esc(r.id) + '" style="width:100%;background:' + ctaBg + ';color:#000;border:none;padding:11px;border-radius:8px;font-weight:900;font-size:13px;cursor:pointer;letter-spacing:0.5px;">🎁 ELEGIR MI NÚMERO (GRATIS)</button>';
        }

        html += '</div>';
        return html;
    }

    // Renderiza el bloque "RESULTADOS" arriba del modal — listado general,
    // compacto, con TODOS los sorteos sorteados. El dueño pidio "uno general
    // con todos los sorteos" en lugar del antiguo collapsable de 2+expandir.
    // Cada linea muestra: emoji · nombre · #ganador · ganador con username
    // tapado al 80%. Si el caller GANO, ve su nombre completo + boton claim.
    function _renderDrawnSummary(drawnList) {
        // Pedido del dueño 2026-05-13: NO mostrar el listado público de
        // ganadores de la semana. Sólo dejamos las filas donde el usuario
        // que está mirando es el ganador (para que pueda reclamar).
        const myList = (drawnList || []).filter(r => r.iAmWinner);
        if (myList.length === 0) return '';

        let html = '<div style="background:rgba(102,255,102,0.06);border:1px solid rgba(102,255,102,0.30);border-radius:10px;padding:10px 12px;margin-bottom:14px;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
        html += '<div style="color:#66ff66;font-size:10.5px;font-weight:800;letter-spacing:2px;text-transform:uppercase;">🏆 ' + (myList.length === 1 ? 'Ganaste un sorteo' : 'Ganaste ' + myList.length + ' sorteos') + '</div>';
        html += '</div>';
        for (const r of myList) html += _renderDrawnLine(r);
        html += '</div>';
        return html;
    }

    // Linea compacta para sorteos ya sorteados. Para el publico general
    // mostramos el ganador con username tapado al 80% inicial — el dueño
    // quiere social proof "ganó alguien" sin exponer al user completo. Si
    // VOS sos el ganador, ves tu nombre completo + boton de reclamo.
    function _renderDrawnLine(r) {
        const youWon = !!r.iAmWinner;
        const credited = !!r.prizeClaimedAt;
        const claimable = !!r.prizeClaimable;
        const accent = youWon ? '#66ff66' : '#888';
        const bg = youWon ? 'rgba(102,255,102,0.08)' : 'rgba(255,255,255,0.03)';
        let right;
        if (youWon && claimable && !credited) {
            const _waHref = _winnerAgentHref(r.winningTicketNumber, r.name);
            right = '<a href="' + _waHref + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="display:inline-block;text-decoration:none;background:linear-gradient(135deg,#25d366,#128c7e);color:#fff;padding:5px 10px;border-radius:6px;font-weight:900;font-size:11px;letter-spacing:0.5px;">💬 RECLAMAR POR WA · #' + (r.winningTicketNumber || '?') + '</a>';
        } else if (youWon && credited) {
            right = '<span style="color:#66ff66;font-size:11px;font-weight:800;">✅ Acreditado</span>';
        } else if (youWon) {
            right = '<span style="color:#ffaa66;font-size:11px;font-weight:800;">⏳ Acreditando…</span>';
        } else if (r.winnerUsername) {
            // Tapamos 80% inicial del nombre. Ej: "lalodj" -> "****dj"
            right = '<span style="color:#aaa;font-size:11px;">🏆 @' + _esc(_maskUsername(r.winnerUsername)) + '</span>';
        } else {
            right = '<span style="color:#888;font-size:11px;">sin ganador</span>';
        }
        const label = youWon ? '🏆 GANASTE' : ('#' + (r.winningTicketNumber || '?'));
        return '<div style="background:' + bg + ';border:1px solid ' + accent + ';border-radius:8px;padding:7px 10px;margin-bottom:6px;display:flex;align-items:center;gap:8px;font-size:12px;">' +
            '<span style="font-size:14px;flex-shrink:0;">' + (r.emoji || '🎁') + '</span>' +
            '<span style="color:' + accent + ';font-weight:900;letter-spacing:0.5px;flex-shrink:0;">' + label + '</span>' +
            '<span style="color:#fff;font-weight:700;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + _esc(r.name) + '</span>' +
            right +
            '</div>';
    }

    // Hero card del RELAMPAGO. Va arriba de todo con gradiente electrico
    // y mensaje "ENTRA Y MIRÁ". Si el user ya esta inscripto, muestra su
    // numero asignado en lugar del CTA.
    function _renderLightningHero(r, balance) {
        const sold = r.cuposSold || 0;
        const total = r.totalTickets || 0;
        const fillPct = total ? Math.round((sold / total) * 100) : 0;
        const myNums = r.myTicketNumbers || [];
        const enrolled = myNums.length > 0;
        const closed = r.status !== 'active';
        const drawn = r.status === 'drawn';
        const entryCost = Number(r.entryCost) || 0;
        const isPaid = entryCost > 0;
        const canAfford = !isPaid || (Number(balance) || 0) >= entryCost;
        // Detectamos si el user esta anotado en OTRO relampago (active+closed).
        // Regla: 1 cupo por persona en TODOS los relampagos abiertos. Si esta
        // anotado en otro, no puede anotarse en este -> se muestra
        // "NO DISPONIBLE" en lugar del boton ELEGIR.
        let enrolledOther = null;
        if (!enrolled && !drawn && _data && _data.raffles) {
            for (const x of _data.raffles) {
                if (x.raffleType !== 'relampago') continue;
                if (x.id === r.id) continue;
                if (x.status !== 'active' && x.status !== 'closed') continue;
                if (x.myTicketNumbers && x.myTicketNumbers.length > 0) {
                    enrolledOther = x;
                    break;
                }
            }
        }

        let html = '<div style="background:linear-gradient(135deg,#001a40 0%,#003f7a 35%,#ffeb3b 100%);background-size:200% 200%;border:3px solid #ffeb3b;border-radius:18px;padding:18px 16px;margin-bottom:18px;box-shadow:0 0 30px rgba(255,235,59,0.40),0 4px 24px rgba(0,150,255,0.30);position:relative;overflow:hidden;">';
        html += '<div style="position:absolute;top:-15px;right:-15px;font-size:120px;opacity:0.10;line-height:1;">⚡</div>';
        const exclusive = !!r.requiresPaidTicket;
        const minCharges = Number(r.requiresMinChargesLastWeek) || 0;
        html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">';
        html += '<span style="background:#ffeb3b;color:#001a40;padding:3px 9px;border-radius:6px;font-size:10px;font-weight:900;letter-spacing:2px;">⚡ RELÁMPAGO' + (isPaid ? ' PAGO' : '') + '</span>';
        html += '<span style="color:#fff;font-size:10px;font-weight:800;letter-spacing:1px;">' + (isPaid ? '$' + _fmt(entryCost) + ' POR NÚMERO · 1 POR PERSONA' : 'GRATIS · 1 POR PERSONA') + '</span>';
        if (exclusive) {
            html += '<span style="background:rgba(255,107,107,0.30);color:#fff;padding:3px 8px;border-radius:6px;font-size:10px;font-weight:900;letter-spacing:1px;border:1px solid #ff8080;">SOLO CON PAGO PREVIO</span>';
        }
        if (minCharges > 0) {
            html += '<span style="background:rgba(102,255,102,0.20);color:#aaffaa;padding:3px 8px;border-radius:6px;font-size:10px;font-weight:900;letter-spacing:1px;border:1px solid #66ff66;">' + minCharges + '+ CARGAS ÚLT. SEMANA</span>';
        }
        html += '</div>';
        html += '<div style="color:#fff;font-size:24px;font-weight:900;line-height:1.1;text-shadow:0 2px 6px rgba(0,0,0,0.50);margin-bottom:8px;">Premio $' + _fmt(r.prizeValueARS) + '</div>';
        let subtext;
        if (minCharges > 0) {
            subtext = '🎯 Exclusivo para jugadores con <strong>' + minCharges + '+ cargas reales</strong> en los últimos 7 días · ' + total + ' lugares';
        } else if (exclusive) {
            subtext = '🎫 Exclusivo para clientes con al menos 1 número en sorteos pagos · ' + total + ' lugares';
        } else {
            subtext = '¡Entrá y mirá! Inscripción gratuita · 1 cupo por persona · ' + total + ' lugares';
        }
        html += '<div style="color:#fff;font-size:12.5px;line-height:1.4;margin-bottom:10px;font-weight:600;">' + subtext + '</div>';

        // Barra de progreso
        html += '<div style="height:10px;background:rgba(0,0,0,0.40);border-radius:5px;overflow:hidden;margin:8px 0 4px;">';
        html += '<div style="height:100%;width:' + fillPct + '%;background:linear-gradient(90deg,#ffeb3b,#fff);box-shadow:0 0 10px rgba(255,235,59,0.80);"></div></div>';
        html += '<div style="display:flex;justify-content:space-between;font-size:11px;color:#fff;margin-bottom:10px;font-weight:700;">';
        html += '<span>' + sold + '/' + total + ' anotados (' + fillPct + '%)</span>';
        html += '<span>Sorteo el lunes</span></div>';

        if (drawn) {
            const youWon = !!r.iAmWinner;
            html += '<div style="background:rgba(0,0,0,0.45);border-radius:10px;padding:10px;font-size:12px;color:#fff;text-align:center;font-weight:700;margin-bottom:10px;">' +
                (youWon ? '🏆 ¡GANASTE EL RELÁMPAGO! Número #' + r.winningTicketNumber : '🎲 Sorteado · ganó @' + _esc(r.winnerUsername || '') + ' con #' + r.winningTicketNumber) +
                '</div>';
        } else if (enrolled && closed) {
            html += '<div style="background:rgba(255,235,59,0.20);border:2px solid #ffeb3b;border-radius:10px;padding:11px;text-align:center;margin-bottom:10px;">';
            html += '<div style="color:#ffeb3b;font-size:11px;font-weight:900;letter-spacing:1.5px;margin-bottom:3px;">✅ ESTÁS ANOTADO · CUPO LLENO</div>';
            html += '<div style="color:#fff;font-size:22px;font-weight:900;text-shadow:0 1px 2px rgba(0,0,0,0.60);">Número #' + myNums[0] + '</div>';
            html += '</div>';
            html += _renderLightningEligibilityStatus();
            html += _renderLightningClaimWarning();
        } else if (enrolled) {
            html += '<div style="background:rgba(255,235,59,0.20);border:2px solid #ffeb3b;border-radius:10px;padding:11px;text-align:center;margin-bottom:10px;">';
            html += '<div style="color:#ffeb3b;font-size:11px;font-weight:900;letter-spacing:1.5px;margin-bottom:3px;">✅ ESTÁS ANOTADO</div>';
            html += '<div style="color:#fff;font-size:22px;font-weight:900;text-shadow:0 1px 2px rgba(0,0,0,0.60);">Número #' + myNums[0] + '</div>';
            html += '</div>';
            html += _renderLightningEligibilityStatus();
            html += _renderLightningClaimWarning();
        } else if (closed) {
            html += '<div style="background:rgba(0,0,0,0.45);border-radius:10px;padding:11px;text-align:center;margin-bottom:10px;">';
            html += '<div style="color:#fff;font-size:14px;font-weight:900;margin-bottom:6px;">⏳ SORTEO LLENO · esperá el próximo</div>';
            html += '<div style="color:#ffeb3b;font-size:11.5px;font-weight:700;line-height:1.45;">Si abrimos otro relámpago, vas a poder anotarte ahí.</div>';
            html += '</div>';
        } else if (enrolledOther) {
            // El user esta anotado en OTRO relampago abierto. NO puede entrar
            // a este. Mostramos un aviso "NO DISPONIBLE" claro con el numero
            // que ya tiene en el otro sorteo, en lugar de un boton roto.
            html += '<div style="background:rgba(120,120,120,0.30);border:2px dashed rgba(255,255,255,0.40);border-radius:10px;padding:13px;text-align:center;margin-bottom:10px;">';
            html += '<div style="color:#aaa;font-size:14px;font-weight:900;letter-spacing:1px;margin-bottom:5px;">🔒 NO DISPONIBLE</div>';
            html += '<div style="color:#fff;font-size:12.5px;line-height:1.5;font-weight:700;">Ya estás anotado en <strong style="color:#ffeb3b;">' + _esc(enrolledOther.name || 'otro RELÁMPAGO') + '</strong> con número <strong style="color:#ffeb3b;">#' + (enrolledOther.myTicketNumbers && enrolledOther.myTicketNumbers[0]) + '</strong>.</div>';
            html += '<div style="color:#aaa;font-size:11px;margin-top:6px;line-height:1.4;">Solo se permite <strong>1 número por persona</strong> en sorteos relámpago. Cuando se sortee tu sorteo actual, vas a poder anotarte en uno nuevo.</div>';
            html += '</div>';
            html += _renderLightningEligibilityStatus();
            html += _renderLightningClaimWarning();
        } else if (isPaid && !canAfford) {
            html += _renderLightningCargarBtn();
        } else {
            const btnLabel = isPaid
                ? '⚡ ELEGIR MI NÚMERO ($' + _fmt(entryCost) + ')'
                : '⚡ ELEGIR MI NÚMERO GRATIS';
            html += '<button type="button" data-raffle-action="open-picker" data-raffle-id="' + _esc(r.id) + '" style="width:100%;background:linear-gradient(135deg,#ffeb3b,#ffd700);color:#001a40;border:none;padding:14px;border-radius:10px;font-weight:900;font-size:15px;cursor:pointer;letter-spacing:1.5px;text-shadow:none;box-shadow:0 4px 12px rgba(255,235,59,0.40);margin-bottom:10px;">' + btnLabel + '</button>';
            html += _renderLightningEligibilityStatus();
            html += _renderLightningClaimWarning();
        }
        // SIEMPRE mostramos el wa.link (excepto cuando ya se mostro como CTA
        // principal en el caso pago-sin-saldo). El owner pidio que el atajo a
        // WhatsApp este cerca en CADA sorteo, en cualquier estado, para que
        // la gente pueda cargar/preguntar de un toque.
        if (!(isPaid && !canAfford && !enrolled && !closed && !drawn)) {
            html += _renderLightningCargarBtn('💬 QUIERO JUGAR', 'Cargá tu plata · WhatsApp directo a tu línea');
        }
        html += '</div>';
        return html;
    }

    // Aviso "para reclamar necesitas actividad". Va en el hero del relampago
    // tanto en activo (antes de anotarse) como en cerrado (despues que se
    // llena el cupo). El owner pidio que esto se vea muy claro.
    // Mini-card de un relampago "secundario" (cerrado o sorteado) donde el
    // user esta anotado. Va debajo del hero principal — el hero domina visual
    // y el mini-card solo recuerda al user su numero + estado del sorteo
    // anterior. Asi cuando se llena el N°1 y largo el N°2, el N°2 es el
    // grande y el N°1 queda como recordatorio compacto del numero del user.
    function _renderLightningMini(r) {
        const myNums = r.myTicketNumbers || [];
        const myNum = myNums[0];
        const isDrawn = r.status === 'drawn';
        const youWon = isDrawn && r.iAmWinner;
        const otherWon = isDrawn && !r.iAmWinner;
        let line, color, bg, border;
        if (youWon) {
            line = '🏆 ¡GANASTE! · Número #' + r.winningTicketNumber + ' · Premio $' + _fmt(r.prizeValueARS);
            color = '#ffd700'; bg = 'rgba(255,215,0,0.10)'; border = '#ffd700';
        } else if (otherWon) {
            line = '🎲 Sorteado · ganó @' + _esc(r.winnerUsername || '') + ' con #' + r.winningTicketNumber;
            color = '#aaa'; bg = 'rgba(255,255,255,0.04)'; border = 'rgba(255,255,255,0.20)';
        } else if (r.status === 'closed') {
            line = '⏳ Tu número #' + (myNum != null ? myNum : '—') + ' · cupo lleno · esperando sorteo del lunes';
            color = '#ffeb3b'; bg = 'rgba(255,235,59,0.08)'; border = 'rgba(255,235,59,0.40)';
        } else {
            line = 'Tu número #' + (myNum != null ? myNum : '—');
            color = '#fff'; bg = 'rgba(255,255,255,0.04)'; border = 'rgba(255,255,255,0.20)';
        }
        return '<div data-raffle-action="open-picker" data-raffle-id="' + _esc(r.id) + '" style="cursor:pointer;display:flex;align-items:center;gap:10px;background:' + bg + ';border:1px solid ' + border + ';border-radius:8px;padding:9px 11px;margin-bottom:10px;font-size:11.5px;line-height:1.4;">' +
            '<span style="font-size:18px;line-height:1;">⚡</span>' +
            '<div style="flex:1;min-width:0;">' +
                '<div style="color:#888;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;margin-bottom:2px;">' + _esc(r.name || 'RELÁMPAGO') + '</div>' +
                '<div style="color:' + color + ';font-weight:700;">' + line + '</div>' +
            '</div>' +
        '</div>';
    }

    // Estado de elegibilidad del USER actual: cuantas cargas tiene vs el
    // minimo (5). Va arriba del warning generico para que el user vea SU
    // numero personal. Lee de _data.lightningCargasCount (cargas totales
    // hasta ahora — cuando se sortea, el server filtra por timestamp<drawnAt
    // pero hasta el draw, contamos todas).
    function _renderLightningEligibilityStatus() {
        if (!_data || _data.lightningCargasCount == null) return '';
        const have = Number(_data.lightningCargasCount) || 0;
        const need = Number(_data.lightningCargasRequired) || 5;
        const ok = have >= need;
        const missing = Math.max(0, need - have);
        if (ok) {
            return '<div style="background:rgba(102,255,102,0.12);border:2px solid #66ff66;border-radius:10px;padding:11px;margin-top:8px;font-size:12.5px;color:#fff;text-align:center;font-weight:800;line-height:1.45;">' +
                '<div style="color:#66ff66;font-size:14px;font-weight:900;margin-bottom:3px;">✅ Cumplís con ' + have + ' cargas</div>' +
                '<div>Vas a poder reclamar el premio si ganás.</div>' +
            '</div>';
        }
        return '<div style="background:rgba(255,170,102,0.15);border:2px solid #ffaa66;border-radius:10px;padding:11px;margin-top:8px;font-size:12.5px;color:#fff;text-align:center;font-weight:800;line-height:1.45;">' +
            '<div style="color:#ffaa66;font-size:14px;font-weight:900;margin-bottom:3px;">⚠️ Tenés ' + have + ' de ' + need + ' cargas</div>' +
            '<div>Te ' + (missing === 1 ? 'falta' : 'faltan') + ' <strong style="color:#ffd700;">' + missing + '</strong> ' + (missing === 1 ? 'carga' : 'cargas') + ' ANTES del sorteo para poder reclamar.</div>' +
        '</div>';
    }

    function _renderLightningClaimWarning() {
        return '<div style="background:rgba(255,170,102,0.12);border:2px dashed #ffaa66;border-radius:10px;padding:11px;margin-top:8px;font-size:11.5px;line-height:1.6;color:#fff;font-weight:700;">' +
            '<div style="color:#ffaa66;font-size:11px;font-weight:900;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;text-align:center;">⚠️ Cómo funciona el RELÁMPAGO</div>' +
            '<div style="margin-bottom:3px;">📅 <strong style="color:#ffd700;">Sorteo el LUNES</strong> en la Lotería Nacional Nocturna.</div>' +
            '<div style="margin-bottom:3px;">🎯 Hasta <strong style="color:#ffd700;">3 sorteos RELÁMPAGO por ciclo</strong> (cuando se llena uno, abrimos el siguiente).</div>' +
            '<div style="margin-bottom:3px;">💰 Para reclamar el premio: <strong style="color:#ffd700;">5 cargas reales VIGENTES ANTES del sorteo</strong>. Las cargas DESPUÉS del sorteo <strong style="color:#ff8080;">NO cuentan</strong>.</div>' +
            '<div>👥 <strong>EXCLUSIVO para clientes activos.</strong> Sin actividad no se acredita el premio.</div>' +
        '</div>';
    }

    // Boton verde wa.link que abre WhatsApp. Reusa la linea principal del
    // user (VIP.state.linePhone) — si no hay, fallback al wa.link de soporte.
    // El label/subtitle son customizables: por default dice QUIERO CARGAR
    // (caso "sin saldo en pago"). En cerrado se usa "CARGÁ ACÁ" para empujar
    // a tener actividad antes del sorteo.
    function _renderLightningCargarBtn(label, subtitle) {
        const linePhone = (VIP && VIP.state && VIP.state.linePhone) || '';
        const waNum = String(linePhone).replace(/[^\d+]/g, '').replace(/^\+/, '');
        const href = waNum ? 'https://wa.me/' + waNum : 'https://wa.link/metawin2026';
        const lbl = label || '💬 QUIERO CARGAR';
        const sub = subtitle || 'No tenés saldo suficiente';
        return '<a href="' + href + '" target="_blank" rel="noopener noreferrer" style="display:block;width:100%;background:linear-gradient(135deg,#0f4c00,#1a8200);color:#fff;text-decoration:none;text-align:center;border:2px solid #66ff66;padding:13px;border-radius:10px;font-weight:900;font-size:14.5px;letter-spacing:1px;box-shadow:0 4px 12px rgba(102,255,102,0.30);box-sizing:border-box;">' +
            '<div style="font-size:12px;font-weight:700;color:#aaffaa;margin-bottom:3px;">' + sub + '</div>' +
            '<div>' + lbl + '</div>' +
        '</a>';
    }

    function _render() {
        const modal = document.getElementById('rafflesModal');
        const body = document.getElementById('rafflesModalBody');
        if (!modal || !body) return;
        if (!_data) {
            body.innerHTML = '<div style="text-align:center;color:#aaa;padding:40px 0;">Cargando...</div>';
            return;
        }
        const balance = Number(_data.balance || 0);
        const allRaffles = (_data.raffles || []).filter(r => r.status !== 'archived' && r.status !== 'cancelled');
        // Separamos sorteados vs activos/cerrados-en-espera. Los drawn van al
        // final como linea compacta para no opacar los vivos. El relampago va
        // separado en hero arriba de todo.
        const drawn = allRaffles.filter(r => r.status === 'drawn');
        const liveRaffles = allRaffles.filter(r => r.status !== 'drawn');
        // Multi-relampago: cuando hay auto-respawn, puede haber el N°1 cerrado
        // (esperando draw) + N°2 activo (donde anotarse). Priorizamos el ACTIVO
        // mas reciente como hero principal y los demas van como mini-cards
        // debajo (para que el user que esta anotado en el N°1 siga viendo su
        // numero, pero el N°2 sea el dominante).
        const allLightnings = allRaffles.filter(r => r.raffleType === 'relampago');
        const stOrder = { active: 0, closed: 1, drawn: 2, archived: 3, cancelled: 4 };
        allLightnings.sort((a, b) => {
            const sa = stOrder[a.status] != null ? stOrder[a.status] : 9;
            const sb = stOrder[b.status] != null ? stOrder[b.status] : 9;
            if (sa !== sb) return sa - sb;
            // Dentro del mismo status, mas reciente primero (instanceNumber desc).
            return (b.instanceNumber || 0) - (a.instanceNumber || 0);
        });
        const heroLightning = allLightnings[0] || null;
        const otherLightnings = allLightnings.slice(1);
        // Resultados UNIFICADOS: incluye relámpago + pagos + gratis sorteados
        // — el dueño quiere "todo unificado y prolijo con sus ganadores" arriba
        // de los sorteos vigentes.
        const allDrawn = drawn.slice().sort((a, b) => new Date(b.drawnAt || 0) - new Date(a.drawnAt || 0));
        const paid = liveRaffles.filter(r => !r.isFree && r.raffleType !== 'relampago');
        const free = liveRaffles.filter(r => r.isFree && r.raffleType !== 'relampago');

        let html = '';
        const recentWins = _data.recentWins || [];
        html += _renderRecentWinsBanner(recentWins);
        html += _renderClaimableBanner(_data.claimable || [], recentWins.map(w => w.id));
        html += _renderAutoEnrolledBanner(_data.autoEnrolled || []);

        // === RESULTADOS UNIFICADOS (compacto, arriba de todo) ===
        // Listado mini con los 3 tipos (relámpago + pagos + gratis). Cada
        // línea: emoji + nombre + #ganador + @ganador (tapado 80%). Si VOS
        // sos el ganador, ves tu nombre completo + estado del reclamo.
        if (allDrawn.length > 0) {
            html += _renderDrawnSummary(allDrawn);
        }

        // HERO RELAMPAGO oculto por pedido del dueño 2026-05-12. Los
        // resultados de relámpagos ya sorteados siguen apareciendo en el
        // bloque unificado "Sorteos resueltos" arriba — los ganadores
        // pueden reclamar desde ahí. Para usuarios ya inscriptos en un
        // relámpago activo, mostramos solo la mini-card (no el hero
        // gigante) para que sigan viendo su número.
        for (const ol of allLightnings) {
            const myNums = ol.myTicketNumbers || [];
            if (myNums.length === 0 && !ol.iAmWinner) continue; // solo enrollados/ganadores
            html += _renderLightningMini(ol);
        }

        // Header compacto con saldo + refrescar.
        html += '<div style="display:flex;justify-content:space-between;align-items:center;background:rgba(212,175,55,0.08);border:1px solid rgba(212,175,55,0.25);border-radius:10px;padding:9px 13px;margin-bottom:12px;gap:10px;">';
        html += '<div><div style="color:#aaa;font-size:10px;font-weight:700;letter-spacing:1.2px;">SALDO</div><div style="color:#ffd700;font-size:19px;font-weight:900;line-height:1.1;">$' + _fmt(balance) + '</div></div>';
        html += '<button type="button" data-raffle-action="refresh" id="rafflesRefreshBtn" style="background:rgba(0,212,255,0.10);color:#00d4ff;border:1px solid rgba(0,212,255,0.40);padding:7px 11px;border-radius:7px;font-weight:800;font-size:11px;cursor:pointer;letter-spacing:0.4px;flex-shrink:0;" title="Forzar actualización">🔄</button>';
        html += '</div>';

        // Separamos GRATIS (por cargas) y NETWIN (por pérdida neta) en
        // 2 SECCIONES con headers propios — pedido del dueño 2026-05-12.
        // El user lo ve como "elegí cómo entrar" más claro.
        const freeCargas = free.filter(r => Number(r.minNetLossARS || 0) === 0);
        const freeNetwin = free.filter(r => Number(r.minNetLossARS || 0) > 0);
        const sortByPrize = (a, b) => Number(b.prizeValueARS||0) - Number(a.prizeValueARS||0);
        freeCargas.sort(sortByPrize);
        freeNetwin.sort(sortByPrize);

        // === SECCIÓN 1 · SORTEOS GRATIS (por cargas) ===
        if (freeCargas.length > 0) {
            const _myCargas = (_data && Number(_data.weeklyDeposits)) || 0;
            html += '<div style="margin:14px 0 6px;display:flex;align-items:center;gap:8px;">';
            html += '<div style="flex:1;height:2px;background:linear-gradient(90deg,transparent,#4dabff);"></div>';
            html += '<h3 style="margin:0;color:#4dabff;font-size:13px;font-weight:900;letter-spacing:2px;">🎁 SORTEOS GRATIS</h3>';
            html += '<div style="flex:1;height:2px;background:linear-gradient(90deg,#4dabff,transparent);"></div></div>';
            html += '<div style="text-align:center;margin-bottom:8px;">';
            html += '<span style="background:rgba(102,255,102,0.10);border:1px solid rgba(102,255,102,0.30);border-radius:14px;padding:3px 10px;color:#aaffaa;font-weight:700;font-size:10.5px;">🟢 Cargaste esta semana: $' + _fmt(_myCargas) + '</span>';
            html += '</div>';
            for (const r of freeCargas) html += _renderFreeCard(r);
        }

        // === SECCIÓN 2 · SORTEOS NETWIN (por pérdida neta) ===
        if (freeNetwin.length > 0) {
            const _myNet = (_data && Number(_data.weeklyNetLoss)) || 0;
            html += '<div style="margin:20px 0 6px;display:flex;align-items:center;gap:8px;">';
            html += '<div style="flex:1;height:2px;background:linear-gradient(90deg,transparent,#ffaa66);"></div>';
            html += '<h3 style="margin:0;color:#ffaa66;font-size:13px;font-weight:900;letter-spacing:2px;">🟠 SORTEOS NETWIN</h3>';
            html += '<div style="flex:1;height:2px;background:linear-gradient(90deg,#ffaa66,transparent);"></div></div>';
            html += '<div style="text-align:center;margin-bottom:8px;">';
            html += '<span style="background:rgba(255,170,102,0.10);border:1px solid rgba(255,170,102,0.30);border-radius:14px;padding:3px 10px;color:#ffd0a0;font-weight:700;font-size:10.5px;">🟠 Pérdida neta esta semana: $' + _fmt(_myNet) + '</span>';
            html += '</div>';
            for (const r of freeNetwin) html += _renderFreeCard(r);
        }

        // === PAGOS === sin explainer arriba (la info ya esta en las cards)
        if (paid.length > 0) {
            html += '<div style="margin:18px 0 8px;display:flex;align-items:center;gap:8px;">';
            html += '<div style="flex:1;height:2px;background:linear-gradient(90deg,transparent,#d4af37);"></div>';
            html += '<h3 style="margin:0;color:#ffd700;font-size:13px;font-weight:900;letter-spacing:2px;">💰 SORTEOS PAGOS</h3>';
            html += '<div style="flex:1;height:2px;background:linear-gradient(90deg,#d4af37,transparent);"></div></div>';
            for (const r of paid) html += _renderPaidCard(r, balance);
        }

        if (paid.length === 0 && free.length === 0 && allDrawn.length === 0 && !heroLightning) {
            html += '<div style="text-align:center;color:#aaa;padding:30px 0;">No hay sorteos disponibles en este momento.</div>';
        } else if (paid.length === 0 && free.length === 0 && !heroLightning) {
            // Hay drawn pero no hay activos: mensaje claro de "vuelve pronto"
            html += '<div style="text-align:center;color:#aaa;padding:18px 0;font-size:12px;">Los próximos sorteos arrancan en breve. Volvé en unos minutos 🎲</div>';
        }

        body.innerHTML = html;
    }

    // Listener delegado: en lugar de inline onclick="" (que se rompe cuando
    // el id contiene comillas o caracteres reservados), interceptamos clicks
    // sobre [data-raffle-action] y disparamos la accion correspondiente.
    // Esto se monta UNA sola vez la primera vez que se abre el modal.
    let _delegationMounted = false;
    function _mountDelegation() {
        if (_delegationMounted) return;
        _delegationMounted = true;
        document.body.addEventListener('click', function (ev) {
            const btn = ev.target.closest && ev.target.closest('[data-raffle-action]');
            if (!btn) return;
            if (btn.disabled) return;
            const action = btn.getAttribute('data-raffle-action');
            const id = btn.getAttribute('data-raffle-id') || '';
            if (action === 'open-picker') return openPicker(id);
            if (action === 'close-picker') return closePicker();
            if (action === 'pick-random') return pickRandom();
            if (action === 'clear-pick') return clearPick();
            if (action === 'confirm-buy') return confirmPickerBuy();
            if (action === 'claim') return claimPrize(id);
            if (action === 'toggle-pick') {
                const n = parseInt(btn.getAttribute('data-num'), 10);
                if (Number.isFinite(n)) togglePick(n);
                return;
            }
            if (action === 'close-bought') {
                const m = document.getElementById('rafflesBoughtModal');
                if (m) m.style.display = 'none';
                return;
            }
            // toggle-drawn: legacy — el bloque ahora muestra todos los
            // sorteados siempre. Se deja el no-op para no romper si quedó
            // algún botón viejo en cache.
            if (action === 'toggle-drawn') return;
            if (action === 'refresh') {
                // Forzar refetch saltando cualquier cache. Mostramos feedback
                // visual cambiando el texto del boton mientras esta en vuelo.
                const refreshBtn = document.getElementById('rafflesRefreshBtn');
                if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = '⏳ Buscando...'; }
                _fetchActive().then(d => {
                    if (d) { _data = d; _dataFetchedAt = Date.now(); _render(); }
                    if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '🔄 Refrescar'; }
                });
                return;
            }
        }, false);
    }

    // Swipe-down-to-close: gesto comun en iOS. Solo dispara si el user
    // arrastra >120px hacia abajo Y el modal estaba scrolleado al tope (asi
    // el scroll normal del contenido no se confunde con cerrar). Idempotente:
    // si ya tiene listener, no se duplica.
    function _attachSwipeToClose(modalEl, closeFn) {
        if (!modalEl || modalEl.__swipeAttached) return;
        modalEl.__swipeAttached = true;
        let startY = null;
        let startScroll = 0;
        modalEl.addEventListener('touchstart', function (e) {
            if (!e.touches || e.touches.length !== 1) { startY = null; return; }
            startY = e.touches[0].clientY;
            startScroll = modalEl.scrollTop || 0;
        }, { passive: true });
        modalEl.addEventListener('touchend', function (e) {
            if (startY == null) return;
            const t = (e.changedTouches && e.changedTouches[0]) || null;
            const endY = t ? t.clientY : startY;
            const dy = endY - startY;
            startY = null;
            // Solo cerrar si swipe down >120px y el modal estaba arriba del
            // todo (no si el user estaba scrolleando hacia abajo dentro).
            if (dy > 120 && startScroll <= 5) {
                try { closeFn(); } catch (_) {}
            }
        });
    }

    async function open() {
        const modal = document.getElementById('rafflesModal');
        if (!modal) return;
        _mountDelegation();
        modal.style.display = 'flex';
        _attachSwipeToClose(modal, close);

        // Render INSTANTANEO: si ya tenemos data en cache, la mostramos
        // mientras pedimos la fresca en background. El user no ve flash
        // de "Cargando…" en aperturas posteriores. Tampoco prefetchamos
        // inutilmente si la data es muy reciente.
        const haveCache = !!_data;
        const isFresh = haveCache && (Date.now() - _dataFetchedAt) < _DATA_FRESHNESS_MS;
        _render();

        if (!haveCache) {
            // Primera vez: hacemos fetch y bloqueamos al loader.
            const data = await _fetchActive();
            if (data) { _data = data; _dataFetchedAt = Date.now(); _render(); }
        } else if (!isFresh) {
            // Cache vieja (>30s): refresh en background sin bloquear UI.
            _fetchActive().then(d => {
                if (d && modal.style.display === 'flex') {
                    _data = d;
                    _dataFetchedAt = Date.now();
                    _render();
                }
            });
        }
        // Si isFresh: ya tenemos data nueva, no pedimos nada extra.

        if (_refreshTimer) clearInterval(_refreshTimer);
        // Auto-refresh cada 20s mientras el modal este visible. Antes era
        // 30s pero el dueno noto que a veces los sorteos nuevos tardaban
        // demasiado en aparecer — bajar a 20s mejora la sensacion de
        // "se actualiza solo" sin sumar carga al server (cache 60s).
        _refreshTimer = setInterval(async () => {
            if (modal.style.display !== 'flex') return;
            const d = await _fetchActive();
            if (d) { _data = d; _dataFetchedAt = Date.now(); _render(); }
        }, 20000);
    }

    // Prefetch oportunista: cuando arranca la app y el user esta autenticado,
    // disparamos un fetch tibio en background para que la primera apertura
    // del modal ya tenga data. No bloquea nada, no muestra UI.
    function prefetch() {
        if (_data) return; // ya tenemos
        if (!VIP || !VIP.state || !VIP.state.currentToken) return;
        _fetchActive().then(d => {
            if (d) { _data = d; _dataFetchedAt = Date.now(); }
        });
    }

    function close() {
        const modal = document.getElementById('rafflesModal');
        if (modal) modal.style.display = 'none';
        if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
        // Mantenemos _data en memoria para que la PROXIMA apertura sea
        // instantanea. Solo limpiamos el picker y la cache se mantiene fresca
        // por _DATA_FRESHNESS_MS antes de re-fetch.
        _picker = null;
        const pm = document.getElementById('rafflesPickerModal');
        if (pm) pm.style.display = 'none';
    }

    // ====== PICKER (sub-modal) ======
    function _renderPicker() {
        if (!_picker) return;
        const r = (_data && _data.raffles || []).find(x => x.id === _picker.raffleId);
        if (!r) return;
        const taken = new Set((r.claimedNumbers || []).map(n => Number(n)));
        const myNums = new Set((r.myTicketNumbers || []).map(n => Number(n)));
        const total = r.totalTickets || 100;
        const isLightning = r.raffleType === 'relampago';
        // Sorteos gratis (free_p100/p500/p1m/p2m) tambien son 1 cupo max y
        // entryCost=0 — comparten el flow del lightning excepto por el copy.
        const isFreeWeekly = !isLightning && r.isFree;
        const isOneCupo = isLightning || isFreeWeekly;
        const cost = _picker.picked.size * (r.entryCost || 0);

        // RELAMPAGO + FREE usan la MISMA UI que los pagos (mismo color dorado,
        // mismo texto base) pero con costo $0 visible. El dueno quiere que la
        // gente se familiarice con el flujo de "elegir y comprar" gratis antes
        // de animarse a uno pago. La unica diferencia es la nota de
        // "1 numero por persona" abajo.
        let html = '';
        // Boton X grande con safe-area-inset-top para no quedar tapado por
        // el notch del iPhone. Tap area 44x44 (HIG). Background semitransparente
        // para que se vea siempre, incluso sobre el grid de numeros.
        html += '<button type="button" data-raffle-action="close-picker" style="position:absolute;top:max(8px,env(safe-area-inset-top));right:8px;background:rgba(0,0,0,0.55);border:1px solid rgba(255,255,255,0.20);color:#fff;font-size:22px;cursor:pointer;line-height:1;width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;z-index:5;">✕</button>';
        html += '<h3 style="color:#ffd700;margin:0 0 4px;font-size:18px;padding-right:52px;">' + (r.emoji || '🎁') + ' ' + _esc(r.name) + '</h3>';
        html += '<div style="color:#aaa;font-size:11px;margin-bottom:8px;">Premio $' + _fmt(r.prizeValueARS) + ' · <strong style="color:' + (isOneCupo ? '#66ff66' : '#ffd700') + ';">$' + _fmt(r.entryCost) + '</strong> por número' + (isOneCupo ? ' · 1 por persona' : '') + '</div>';
        html += '<div style="background:rgba(212,175,55,0.10);border:1px solid rgba(212,175,55,0.30);border-radius:8px;padding:8px 10px;font-size:11.5px;color:#ddd;margin-bottom:10px;line-height:1.4;">';
        html += '🎯 Tocá ' + (isOneCupo ? '<strong>el número</strong> que quieras' : 'los números que querés') + ' (<strong style="color:#66ff66;">verde</strong> = libres, <strong style="color:#ff6b6b;">rojo</strong> = tomados, <strong style="color:#ffd700;">dorado</strong> = el que vas a comprar).' + (isOneCupo ? '' : ' Hasta 50 por compra.');
        html += '</div>';

        // Grid 10x10
        html += '<div style="display:grid;grid-template-columns:repeat(10,1fr);gap:4px;margin-bottom:10px;">';
        for (let n = 1; n <= total; n++) {
            const isTaken = taken.has(n);
            const isMine = myNums.has(n);
            const isPicked = _picker.picked.has(n);
            let bg, color, cursor;
            if (isMine) { bg = 'rgba(102,255,102,0.40)'; color = '#fff'; cursor = 'not-allowed'; }
            else if (isTaken) { bg = 'rgba(255,107,107,0.30)'; color = '#888'; cursor = 'not-allowed'; }
            else if (isPicked) { bg = 'linear-gradient(135deg,#ffd700,#f7931e)'; color = '#000'; cursor = 'pointer'; }
            else { bg = 'rgba(102,255,102,0.10)'; color = '#cfe9cf'; cursor = 'pointer'; }
            const dataAttrs = (!isTaken && !isMine) ? 'data-raffle-action="toggle-pick" data-num="' + n + '"' : '';
            const tdec = (isTaken || isMine) ? 'text-decoration:line-through;' : '';
            html += '<button type="button" ' + dataAttrs + ' style="background:' + bg + ';color:' + color + ';border:none;padding:6px 0;border-radius:4px;font-size:12px;font-weight:700;cursor:' + cursor + ';' + tdec + '">' + n + '</button>';
        }
        html += '</div>';

        // Resumen + acciones
        const pickedArr = Array.from(_picker.picked).sort((a, b) => a - b);
        html += '<div style="background:rgba(0,0,0,0.30);border-radius:8px;padding:10px;margin-bottom:8px;">';
        html += '<div style="color:#aaa;font-size:11px;font-weight:700;margin-bottom:4px;">SELECCIÓN (' + pickedArr.length + ')</div>';
        html += '<div style="color:' + (isOneCupo ? '#ffeb3b' : '#ffd700') + ';font-size:14px;font-weight:900;word-break:break-word;">' + (pickedArr.length ? pickedArr.map(n => '#' + n).join(', ') : '— ninguno —') + '</div>';
        if (!isOneCupo) {
            html += '<div style="color:#fff;font-size:13px;font-weight:700;margin-top:6px;">Total: <strong style="color:#ffd700;">$' + _fmt(cost) + '</strong></div>';
        }
        html += '</div>';

        html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
        if (!isOneCupo) {
            html += '<button type="button" data-raffle-action="pick-random" style="flex:1;min-width:100px;background:rgba(255,255,255,0.06);color:#fff;border:1px solid rgba(255,255,255,0.20);padding:10px;border-radius:8px;font-weight:700;font-size:12px;cursor:pointer;">🎲 Aleatorio (5)</button>';
        }
        html += '<button type="button" data-raffle-action="clear-pick" style="background:rgba(255,107,107,0.10);color:#ff6b6b;border:1px solid rgba(255,107,107,0.30);padding:10px 14px;border-radius:8px;font-weight:700;font-size:12px;cursor:pointer;">Limpiar</button>';
        const ctaText = isOneCupo
            ? (isLightning ? '⚡ INSCRIBIRME GRATIS' : '🎁 INSCRIBIRME GRATIS') + (pickedArr.length ? ' (#' + pickedArr[0] + ')' : '')
            : '🎫 COMPRAR ' + pickedArr.length + ' POR $' + _fmt(cost);
        const ctaBg = isOneCupo
            ? (pickedArr.length ? 'linear-gradient(135deg,#ffeb3b,#ffd700)' : 'rgba(120,120,120,0.40)')
            : (pickedArr.length ? 'linear-gradient(135deg,#d4af37,#f7931e)' : 'rgba(120,120,120,0.40)');
        html += '<button type="button" id="raffle_pick_buy" data-raffle-action="confirm-buy" ' + (pickedArr.length === 0 ? 'disabled' : '') + ' style="flex:2;min-width:160px;background:' + ctaBg + ';color:#000;border:none;padding:10px;border-radius:8px;font-weight:900;font-size:13px;cursor:' + (pickedArr.length ? 'pointer' : 'not-allowed') + ';letter-spacing:0.5px;">' + ctaText + '</button>';
        html += '</div>';

        // Boton "VOLVER" al pie. Siempre accesible — la X de arriba a veces queda
        // tapada por el notch del iPhone y este boton es el escape natural.
        html += '<button type="button" data-raffle-action="close-picker" style="margin-top:14px;width:100%;background:rgba(255,255,255,0.06);color:#fff;border:1px solid rgba(255,255,255,0.25);padding:13px;border-radius:10px;font-weight:800;font-size:13.5px;cursor:pointer;letter-spacing:0.5px;">← VOLVER</button>';

        const pickerBody = document.getElementById('rafflesPickerBody');
        if (pickerBody) pickerBody.innerHTML = html;
    }

    function openPicker(raffleId) {
        const r = (_data && _data.raffles || []).find(x => x.id === raffleId);
        if (!r) return;
        // Todos los sorteos usan picker ahora (paid, relampago y free clasicos).
        // El owner pidio que la gente elija su numero en TODOS los sorteos
        // gratis para hacer la UX consistente y mantener el FOMO de ver el
        // cupo llenarse en tiempo real.
        _picker = { raffleId, picked: new Set() };
        let modal = document.getElementById('rafflesPickerModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'rafflesPickerModal';
            modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:30000;align-items:flex-start;justify-content:center;padding:8px;overflow-y:auto;';
            modal.onclick = function (e) { if (e.target === modal) closePicker(); };
            modal.innerHTML = '<div style="background:linear-gradient(135deg,#1a0033,#2d0052);border:2px solid #d4af37;border-radius:14px;max-width:520px;width:100%;margin:8px auto;padding:18px 14px 16px;position:relative;"><div id="rafflesPickerBody"></div></div>';
            document.body.appendChild(modal);
        }
        modal.style.display = 'flex';
        _attachSwipeToClose(modal, closePicker);
        _renderPicker();
    }

    function closePicker() {
        const modal = document.getElementById('rafflesPickerModal');
        if (modal) modal.style.display = 'none';
        _picker = null;
    }

    function togglePick(n) {
        if (!_picker) return;
        const r = (_data && _data.raffles || []).find(x => x.id === _picker.raffleId);
        // Lightning + free clasicos = 1 cupo max. Solo paid permite multi-pick.
        const isOneCupo = r && (r.raffleType === 'relampago' || r.isFree);
        if (_picker.picked.has(n)) _picker.picked.delete(n);
        else {
            if (isOneCupo) {
                // Solo 1 cupo: si toca otro numero, reemplaza la seleccion.
                _picker.picked.clear();
                _picker.picked.add(n);
            } else {
                if (_picker.picked.size >= 50) {
                    VIP.ui.showToast('⚠️ Tope 50 números por compra', 'warning');
                    return;
                }
                _picker.picked.add(n);
            }
        }
        _renderPicker();
    }

    function pickRandom() {
        if (!_picker) return;
        const r = (_data && _data.raffles || []).find(x => x.id === _picker.raffleId);
        if (!r) return;
        const taken = new Set((r.claimedNumbers || []).map(n => Number(n)));
        const mine = new Set((r.myTicketNumbers || []).map(n => Number(n)));
        const total = r.totalTickets || 100;
        const available = [];
        for (let n = 1; n <= total; n++) if (!taken.has(n) && !mine.has(n) && !_picker.picked.has(n)) available.push(n);
        // Mezclar y tomar 5 (o lo que quede).
        for (let i = available.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [available[i], available[j]] = [available[j], available[i]];
        }
        const want = Math.min(5, available.length, 50 - _picker.picked.size);
        for (let i = 0; i < want; i++) _picker.picked.add(available[i]);
        _renderPicker();
    }

    function clearPick() {
        if (!_picker) return;
        _picker.picked.clear();
        _renderPicker();
    }

    // Modal de confirmacion in-page (en lugar de confirm() nativo, que en
    // algunos WebViews / PWAs no se muestra). Devuelve una promesa con true
    // si el user confirma, false si cancela.
    function _showCustomConfirm(html) {
        return new Promise((resolve) => {
            let modal = document.getElementById('rafflesConfirmModal');
            if (modal) modal.remove();
            modal = document.createElement('div');
            modal.id = 'rafflesConfirmModal';
            modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:40000;display:flex;align-items:center;justify-content:center;padding:14px;';
            modal.innerHTML = '<div style="background:linear-gradient(135deg,#1a0033,#2d0052);border:2px solid #d4af37;border-radius:14px;max-width:420px;width:100%;padding:18px 16px;text-align:center;">' + html +
                '<div style="display:flex;gap:8px;margin-top:14px;">' +
                '<button type="button" id="raffleConfirmNo" style="flex:1;background:rgba(255,255,255,0.06);color:#fff;border:1px solid rgba(255,255,255,0.20);padding:11px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;">Cancelar</button>' +
                '<button type="button" id="raffleConfirmYes" style="flex:2;background:linear-gradient(135deg,#d4af37,#f7931e);color:#000;border:none;padding:11px;border-radius:8px;font-weight:900;font-size:13px;cursor:pointer;letter-spacing:0.5px;">CONFIRMAR</button>' +
                '</div></div>';
            document.body.appendChild(modal);
            const cleanup = (val) => { try { modal.remove(); } catch (_) {} resolve(val); };
            modal.querySelector('#raffleConfirmYes').onclick = () => cleanup(true);
            modal.querySelector('#raffleConfirmNo').onclick = () => cleanup(false);
            modal.onclick = (e) => { if (e.target === modal) cleanup(false); };
        });
    }

    async function confirmPickerBuy() {
        if (!_picker || _buying) return;
        const arr = Array.from(_picker.picked).sort((a, b) => a - b);
        if (arr.length === 0) return;
        const r = (_data && _data.raffles || []).find(x => x.id === _picker.raffleId);
        if (!r) return;
        const cost = arr.length * (r.entryCost || 0);

        const confirmHtml =
            '<div style="font-size:38px;margin-bottom:6px;">🎫</div>' +
            '<div style="color:#ffd700;font-size:14px;font-weight:900;letter-spacing:1px;margin-bottom:8px;">CONFIRMAR COMPRA</div>' +
            '<div style="color:#fff;font-size:12.5px;line-height:1.6;margin-bottom:8px;">' +
                '<div>' + _esc(r.name) + '</div>' +
                '<div style="color:#d4af37;font-size:13px;font-weight:700;margin-top:4px;">' + arr.length + ' número' + (arr.length > 1 ? 's' : '') + '</div>' +
                '<div style="color:#fff;font-size:11px;margin-top:4px;word-break:break-word;">' + arr.map(n => '#' + n).join(', ') + '</div>' +
            '</div>' +
            '<div style="background:rgba(212,175,55,0.10);border:1px solid rgba(212,175,55,0.30);border-radius:8px;padding:10px;font-size:12px;color:#fff;">' +
                'Se descontarán <strong style="color:#ffd700;font-size:14px;">$' + _fmt(cost) + '</strong> de tu saldo en JUGAYGANA' +
            '</div>';
        const ok = await _showCustomConfirm(confirmHtml);
        if (!ok) return;

        _buying = true;
        const btn = document.getElementById('raffle_pick_buy');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Procesando…'; }
        try {
            const resp = await fetch(`${VIP.config.API_URL}/api/raffles/${_picker.raffleId}/buy`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ pickedNumbers: arr, quantity: arr.length })
            });
            const data = await resp.json().catch(() => ({}));
            if (resp.ok && data && data.success) {
                _showBoughtModal(data.ticketNumbers || arr, r);
                closePicker();
                const d = await _fetchActive();
                if (d) { _data = d; _render(); }
            } else {
                const msg = (data && data.error) || ('No se pudo comprar (HTTP ' + resp.status + ')');
                if (data && data.takenNumber) {
                    VIP.ui.showToast('⚠️ El número #' + data.takenNumber + ' lo tomó otro. Probá con otro.', 'error');
                    const d = await _fetchActive();
                    if (d) { _data = d; _render(); _renderPicker(); }
                } else if (resp.status === 503 && data.retry) {
                    VIP.ui.showToast('⏳ ' + msg, 'warning');
                } else {
                    VIP.ui.showToast('⚠️ ' + msg, 'error');
                }
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = '🎫 COMPRAR ' + arr.length + ' POR $' + _fmt(cost);
                }
            }
        } catch (e) {
            console.error('confirmPickerBuy error:', e);
            VIP.ui.showToast('Error de conexión: ' + (e && e.message ? e.message : 'reintentá'), 'error');
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🎫 COMPRAR ' + arr.length + ' POR $' + _fmt(cost);
            }
        } finally {
            _buying = false;
        }
    }

    function _showBoughtModal(numbers, raffle) {
        const arr = numbers.slice().sort((a, b) => a - b);
        let modal = document.getElementById('rafflesBoughtModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'rafflesBoughtModal';
            modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.95);z-index:35000;align-items:center;justify-content:center;padding:14px;';
            modal.onclick = function (e) { if (e.target === modal) modal.style.display = 'none'; };
            modal.innerHTML = '<div style="background:linear-gradient(135deg,#0f4c00,#1a8200);border:3px solid #66ff66;border-radius:18px;max-width:440px;width:100%;padding:24px 20px;text-align:center;"><div id="rafflesBoughtBody"></div></div>';
            document.body.appendChild(modal);
        }
        const body = document.getElementById('rafflesBoughtBody');
        const isLightning = raffle && raffle.raffleType === 'relampago';
        const isFreeWeekly = raffle && !isLightning && raffle.isFree;
        const isOneCupo = isLightning || isFreeWeekly;
        if (body) {
            const numStr = arr.length === 1
                ? '<div style="font-size:64px;font-weight:900;color:#ffd700;margin:14px 0;line-height:1;">#' + arr[0] + '</div>'
                : '<div style="font-size:18px;font-weight:900;color:#ffd700;margin:14px 0;word-break:break-word;line-height:1.5;">' + arr.map(n => '#' + n).join(' · ') + '</div>';
            // Para gratis (lightning + free) mostramos un mensaje educativo:
            // "asi de facil es participar — los pagos funcionan igual". El owner
            // quiere usar los gratis como onboarding al sistema de sorteos pagos.
            const headerLabel = isOneCupo ? '¡Inscripción confirmada!' : '¡Compra confirmada!';
            const intro = isOneCupo
                ? 'Tu número en <strong>' + _esc(raffle.name) + '</strong>:'
                : 'Tu/s número/s para <strong>' + _esc(raffle.name) + '</strong>:';
            const tutorialMsg = isOneCupo
                ? '<div style="background:rgba(255,215,0,0.15);border:1px dashed #ffd700;border-radius:10px;padding:11px;margin-bottom:14px;color:#fff;font-size:12.5px;line-height:1.5;">' +
                    '<div style="color:#ffd700;font-weight:900;font-size:13px;margin-bottom:4px;">💡 ¡Así de fácil es participar!</div>' +
                    'Los <strong style="color:#ffd700;">sorteos pagos</strong> funcionan igual: elegís tu número del 1 al 100, lo pagás con tu saldo y si sale, <strong>cobrás el premio en el acto</strong> en tu cuenta.' +
                  '</div>'
                : '<div style="color:#dde9d4;font-size:12px;line-height:1.5;margin-bottom:14px;">Sorteo el lunes en la Lotería Nacional Nocturna. Si tu número gana, te <strong>acreditamos el premio automáticamente</strong> a tu saldo.</div>';
            body.innerHTML = '<div style="font-size:48px;margin-bottom:8px;">' + (isLightning ? '⚡' : (isFreeWeekly ? '🎁' : '🎫')) + '</div>' +
                '<div style="color:#66ff66;font-size:14px;font-weight:900;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;">' + headerLabel + '</div>' +
                '<div style="color:#fff;font-size:13px;margin-bottom:6px;">' + intro + '</div>' +
                numStr +
                tutorialMsg +
                '<button type="button" data-raffle-action="close-bought" style="width:100%;background:#ffd700;color:#000;border:none;padding:12px;border-radius:10px;font-weight:900;font-size:14px;cursor:pointer;letter-spacing:1px;">' + (isOneCupo ? '🎫 VER SORTEOS PAGOS' : '¡PERFECTO!') + '</button>';
        }
        modal.style.display = 'flex';
    }

    async function claimPrize(raffleId) {
        if (_claiming) return;
        const ok = await _showCustomConfirm(
            '<div style="font-size:38px;margin-bottom:6px;">🏆</div>' +
            '<div style="color:#ffd700;font-size:14px;font-weight:900;letter-spacing:1px;margin-bottom:8px;">RECLAMAR PREMIO</div>' +
            '<div style="color:#fff;font-size:12.5px;line-height:1.6;">¿Acreditar el premio a tu saldo de JUGAYGANA?</div>'
        );
        if (!ok) return;
        _claiming = true;
        try {
            const resp = await fetch(`${VIP.config.API_URL}/api/raffles/${raffleId}/claim-prize`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            const data = await resp.json();
            if (data && data.success) {
                VIP.ui.showToast('🏆 ' + (data.message || 'Premio acreditado'), 'success');
                const d = await _fetchActive();
                if (d) { _data = d; _render(); }
            } else {
                VIP.ui.showToast('⚠️ ' + ((data && data.error) || 'No se pudo acreditar'), 'error');
            }
        } catch (e) {
            console.error('claimPrize error:', e);
            VIP.ui.showToast('Error de conexión', 'error');
        } finally {
            _claiming = false;
        }
    }

    // ============================================================
    // Banner de ganador reciente en el home (fuera del modal)
    // ============================================================
    // Pinta en #raffleWinnerHomeBanner el ganador mas reciente de las
    // ultimas 6h. Si el user actual es el ganador, mostramos un banner
    // personalizado de "FELICITACIONES" con CTA para abrir el modal y
    // reclamar (si auto-credit fallo). Si el ganador es otro, mostramos
    // un banner mas chico con "ultimo ganador: @user $X" para social proof.
    async function loadHomeWinnerBanner() {
        const container = document.getElementById('raffleWinnerHomeBanner');
        if (!container) return;
        let winners = [], lightning = null, homeBalance = null;
        try {
            const r = await fetch(VIP.config.API_URL + '/api/raffles/recent-winners?hours=6', {
                headers: { 'Authorization': 'Bearer ' + VIP.state.currentToken }
            });
            if (r.ok) {
                const j = await r.json();
                winners = (j && j.winners) || [];
                lightning = j && j.lightning;
                homeBalance = j && (j.balance != null ? j.balance : null);
            }
        } catch (e) { /* fallback al CTA default */ }

        // Decidimos que mostrar (ordenado por prioridad):
        //   1. Si gane algo en las ultimas 6h -> banner FELICITACIONES
        //   2. Si hay sorteo RELAMPAGO activo -> hero electrico
        //   3. Si gano otra persona en 6h -> banner social proof
        //   4. Default -> CTA verde "SORTEOS SEMANALES PARA CLIENTES Y PAGOS"
        const myWin = winners.find(w => w.isMe);
        let html;
        if (myWin) {
            html = _renderHomeWinnerMine(myWin);
        } else if (lightning) {
            // Cartel verde EXPANDIDO: dentro tiene el card del relampago como
            // seccion. Asi el user ve ambos en el mismo bloque y el verde
            // sigue siendo el unico punto de entrada al modal de sorteos.
            html = _renderHomeGreenWithLightning(lightning, homeBalance);
        } else if (winners.length > 0) {
            html = _renderHomeWinnerOthers(winners[0]);
        } else {
            html = _renderHomeDefaultCta();
        }
        container.innerHTML = html;
        container.style.display = 'block';
    }

    // CTA por defecto cuando no hay ganador reciente ni relampago activo.
    // Mismo gradient verde dorado que el felicitaciones para que sea el
    // foco visual del home. Todo el card es clickeable -> abre el modal.
    function _renderHomeDefaultCta() {
        return '<div onclick="VIP.raffles && VIP.raffles.open()" style="cursor:pointer;background:linear-gradient(135deg,#0f4c00,#1a8200,#ffd700);background-size:200% 200%;border:3px solid #ffd700;border-radius:14px;padding:14px;margin:10px auto;max-width:560px;box-shadow:0 0 24px rgba(255,215,0,0.40);position:relative;overflow:hidden;">' +
            '<div style="position:absolute;top:-12px;right:-12px;font-size:90px;opacity:0.10;">🎁</div>' +
            '<div style="color:#ffd700;font-weight:900;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;text-shadow:0 1px 2px rgba(0,0,0,0.50);">🎁 SORTEOS SEMANALES GRATIS POR CARGAS Y POR NETWIN — ¡PARTICIPÁ!</div>' +
            '<div style="color:#fff;font-size:11.5px;font-weight:600;margin:4px 0 10px;line-height:1.4;text-shadow:0 1px 2px rgba(0,0,0,0.40);opacity:0.92;">Sortea lunes nocturna · Lotería Nacional</div>' +
            '<div style="background:rgba(255,215,0,0.20);border:2px solid #ffd700;border-radius:10px;padding:11px;text-align:center;color:#fff;font-weight:900;font-size:14px;letter-spacing:1px;text-shadow:0 1px 2px rgba(0,0,0,0.50);">👉 ENTRÁ ACÁ</div>' +
            '</div>';
    }

    // Variante del cartel verde que tiene EMBEBIDO el card del relampago como
    // seccion. Se usa cuando hay un relampago activo: el user ve los premios
    // semanales arriba, el card del relampago en el medio (clickeable
    // independientemente al picker), y el CTA "VER TODOS" abajo abre el modal.
    function _renderHomeGreenWithLightning(lightning, balance) {
        return '<div style="background:linear-gradient(135deg,#0f4c00,#1a8200,#ffd700);background-size:200% 200%;border:3px solid #ffd700;border-radius:14px;padding:14px;margin:10px auto;max-width:560px;box-shadow:0 0 24px rgba(255,215,0,0.40);position:relative;overflow:hidden;">' +
            '<div style="position:absolute;top:-12px;right:-12px;font-size:90px;opacity:0.10;pointer-events:none;">🎁</div>' +
            '<div style="color:#ffd700;font-weight:900;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;text-shadow:0 1px 2px rgba(0,0,0,0.50);">🎁 SORTEOS SEMANALES GRATIS POR CARGAS Y POR NETWIN — ¡PARTICIPÁ!</div>' +
            '<div style="color:#fff;font-size:11.5px;font-weight:600;margin:4px 0 10px;line-height:1.4;text-shadow:0 1px 2px rgba(0,0,0,0.40);opacity:0.92;">Sortea lunes nocturna · Lotería Nacional</div>' +
            _renderHomeLightningEmbedded(lightning, balance) +
            '<div onclick="VIP.raffles && VIP.raffles.open()" style="cursor:pointer;background:rgba(255,215,0,0.20);border:2px solid #ffd700;border-radius:10px;padding:11px;text-align:center;color:#fff;font-weight:900;font-size:14px;letter-spacing:1px;text-shadow:0 1px 2px rgba(0,0,0,0.50);margin-top:10px;">👉 VER TODOS LOS SORTEOS</div>' +
        '</div>';
    }

    // Card del relampago EMBEBIDO dentro del verde. Sin margenes ni max-width
    // (queda al ancho del padre verde). Click directo al picker / wa.link.
    function _renderHomeLightningEmbedded(l, balance) {
        const sold = l.cuposSold || 0;
        const total = l.totalTickets || 0;
        const fillPct = total ? Math.round((sold / total) * 100) : 0;
        const enrolled = l.myTicket != null;
        const entryCost = Number(l.entryCost) || 0;
        const isPaid = entryCost > 0 && !l.isFree;
        const canAfford = !isPaid || (Number(balance) || 0) >= entryCost;
        const linePhone = (VIP && VIP.state && VIP.state.linePhone) || '';
        const waNum = String(linePhone).replace(/[^\d+]/g, '').replace(/^\+/, '');
        const cargarHref = waNum ? 'https://wa.me/' + waNum : 'https://wa.link/metawin2026';
        const showCargar = isPaid && !canAfford && l.status === 'active' && !enrolled;
        // Si el user esta anotado en OTRO relampago (server lo manda en
        // myEnrolledOther), avisamos NO DISPONIBLE en lugar del CTA.
        const otherEnrolled = l.myEnrolledOther || null;
        const blockedByOther = !enrolled && !!otherEnrolled && l.status === 'active';
        const clickAction = blockedByOther
            ? "event.stopPropagation();VIP.raffles && VIP.raffles.open()"
            : (showCargar
                ? "event.stopPropagation();window.open(" + JSON.stringify(cargarHref) + ",'_blank')"
                : ((l.status === 'active' && !enrolled)
                    ? 'event.stopPropagation();VIP.raffles && VIP.raffles.openAndPickRaffle(' + JSON.stringify(l.id) + ')'
                    : 'event.stopPropagation();VIP.raffles && VIP.raffles.open()'));
        const badgeTxt = isPaid
            ? ('$' + _fmt(entryCost) + ' POR NÚMERO · 1 POR PERSONA')
            : 'SIN CARGO · MÁXIMO 1 POR PERSONA';
        const ctaLabel = isPaid
            ? '⚡ ELEGIR MI NÚMERO ($' + _fmt(entryCost) + ')'
            : '⚡ ELEGIR MI NÚMERO GRATIS';
        return '<div onclick="' + clickAction + '" style="cursor:pointer;background:rgba(0,30,80,0.85);border:2px solid #ffeb3b;border-radius:10px;padding:11px;margin:0;box-shadow:0 0 12px rgba(255,235,59,0.30);position:relative;overflow:hidden;">' +
            '<div style="position:absolute;top:-10px;right:-10px;font-size:70px;opacity:0.12;line-height:1;pointer-events:none;">⚡</div>' +
            '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap;">' +
                '<span style="background:#ffeb3b;color:#001a40;padding:2px 8px;border-radius:5px;font-size:9.5px;font-weight:900;letter-spacing:1.5px;">⚡ RELÁMPAGO' + (isPaid ? ' PAGO' : '') + '</span>' +
                '<span style="color:#fff;font-size:9.5px;font-weight:800;letter-spacing:1px;">' + badgeTxt + '</span>' +
            '</div>' +
            '<div style="color:#fff;font-size:18px;font-weight:900;line-height:1.1;text-shadow:0 2px 4px rgba(0,0,0,0.50);margin:3px 0 6px;">Premio $' + _fmt(l.prizeValueARS) + '</div>' +
            (enrolled
                ? '<div style="background:rgba(255,235,59,0.20);border:1.5px solid #ffeb3b;border-radius:7px;padding:7px;text-align:center;color:#fff;font-size:12px;font-weight:900;text-shadow:0 1px 2px rgba(0,0,0,0.60);">✅ Estás anotado · Número #' + l.myTicket + '</div>'
                : (blockedByOther
                    ? '<div style="background:rgba(120,120,120,0.30);border:2px dashed rgba(255,255,255,0.40);border-radius:7px;padding:9px;text-align:center;">' +
                        '<div style="color:#aaa;font-size:11px;font-weight:900;letter-spacing:1px;margin-bottom:3px;">🔒 NO DISPONIBLE</div>' +
                        '<div style="color:#fff;font-size:10.5px;font-weight:700;line-height:1.4;">Ya estás anotado en <strong style="color:#ffeb3b;">' + _esc(otherEnrolled.raffleName || 'otro RELÁMPAGO') + '</strong> con #<strong style="color:#ffeb3b;">' + (otherEnrolled.ticketNumber != null ? otherEnrolled.ticketNumber : '—') + '</strong></div>' +
                      '</div>'
                    : (l.status !== 'active'
                        ? '<div style="background:rgba(0,0,0,0.45);border-radius:7px;padding:8px;text-align:center;">' +
                            '<div style="color:#fff;font-size:12px;font-weight:900;margin-bottom:3px;">⏳ SORTEO LLENO</div>' +
                            '<div style="color:#ffeb3b;font-size:10px;font-weight:700;line-height:1.4;">Si abrimos otro relámpago, vas a poder anotarte.</div>' +
                          '</div>'
                        : '<div style="height:7px;background:rgba(0,0,0,0.40);border-radius:4px;overflow:hidden;margin:3px 0;">' +
                            '<div style="height:100%;width:' + fillPct + '%;background:linear-gradient(90deg,#ffeb3b,#fff);box-shadow:0 0 10px rgba(255,235,59,0.80);"></div></div>' +
                          '<div style="display:flex;justify-content:space-between;font-size:10.5px;color:#fff;font-weight:700;margin-bottom:5px;">' +
                            '<span>' + sold + '/' + total + ' anotados</span>' +
                            '<span>' + (showCargar ? '💬 CARGÁ Y ENTRÁ' : '👉 ENTRÁ Y ELEGÍ') + '</span>' +
                          '</div>' +
                          (showCargar
                            ? '<div style="background:linear-gradient(135deg,#0f4c00,#1a8200);color:#fff;border:2px solid #66ff66;border-radius:7px;padding:8px;text-align:center;font-weight:900;font-size:12px;letter-spacing:1px;margin-top:3px;box-shadow:0 2px 6px rgba(102,255,102,0.40);">' +
                                '<div style="font-size:9.5px;color:#aaffaa;font-weight:700;margin-bottom:2px;">No tenés saldo suficiente</div>' +
                                '<div>💬 QUIERO CARGAR</div>' +
                              '</div>'
                            : '<div style="background:#ffeb3b;color:#001a40;border-radius:7px;padding:8px;text-align:center;font-weight:900;font-size:12px;letter-spacing:1px;margin-top:3px;box-shadow:0 2px 6px rgba(255,235,59,0.40);">' + ctaLabel + '</div>')
                      )
                  )
            ) +
        '</div>';
    }

    // Hero del RELAMPAGO en el HOME (no en el modal). Mas pequenio y
    // clickeable -> abre el modal donde la card grande tiene mas detalle.
    function _renderHomeLightningHero(l, balance) {
        const sold = l.cuposSold || 0;
        const total = l.totalTickets || 0;
        const fillPct = total ? Math.round((sold / total) * 100) : 0;
        const enrolled = l.myTicket != null;
        const entryCost = Number(l.entryCost) || 0;
        const isPaid = entryCost > 0 && !l.isFree;
        const canAfford = !isPaid || (Number(balance) || 0) >= entryCost;
        // Si es PAGO y no alcanza el saldo, el card NO abre el picker:
        // redirige al WhatsApp de carga (igual que el card del modal).
        const linePhone = (VIP && VIP.state && VIP.state.linePhone) || '';
        const waNum = String(linePhone).replace(/[^\d+]/g, '').replace(/^\+/, '');
        const cargarHref = waNum ? 'https://wa.me/' + waNum : 'https://wa.link/metawin2026';
        const showCargar = isPaid && !canAfford && l.status === 'active' && !enrolled;
        // El click abre el picker DIRECTO sobre este sorteo en vez del modal
        // generico (que mostraba todos los demas sorteos y mareaba al user).
        // openAndPickRaffle hace open() para cargar data + openPicker(id) para
        // saltar derecho al grid 1-100. Si esta cerrado/sorteado, solo abre
        // el modal (no hay picker que mostrar).
        const clickAction = showCargar
            ? "window.open(" + JSON.stringify(cargarHref) + ",'_blank')"
            : ((l.status === 'active' && !enrolled)
                ? 'VIP.raffles && VIP.raffles.openAndPickRaffle(' + JSON.stringify(l.id) + ')'
                : 'VIP.raffles && VIP.raffles.open()');
        const badgeTxt = isPaid
            ? ('$' + _fmt(entryCost) + ' POR NÚMERO · MÁXIMO 1 POR PERSONA')
            : 'SIN CARGO · MÁXIMO 1 POR PERSONA';
        const ctaLabel = isPaid
            ? '⚡ ELEGIR MI NÚMERO ($' + _fmt(entryCost) + ')'
            : '⚡ ELEGIR MI NÚMERO GRATIS';
        return '<div onclick="' + clickAction + '" style="cursor:pointer;background:linear-gradient(135deg,#001a40 0%,#003f7a 35%,#ffeb3b 100%);background-size:200% 200%;border:3px solid #ffeb3b;border-radius:14px;padding:14px;margin:10px auto;max-width:560px;box-shadow:0 0 24px rgba(255,235,59,0.50),0 4px 18px rgba(0,150,255,0.30);position:relative;overflow:hidden;">' +
            '<div style="position:absolute;top:-12px;right:-12px;font-size:90px;opacity:0.10;line-height:1;">⚡</div>' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;">' +
                '<span style="background:#ffeb3b;color:#001a40;padding:3px 9px;border-radius:6px;font-size:10px;font-weight:900;letter-spacing:2px;">⚡ RELÁMPAGO' + (isPaid ? ' PAGO' : '') + '</span>' +
                '<span style="color:#fff;font-size:10px;font-weight:800;letter-spacing:1px;">' + badgeTxt + '</span>' +
            '</div>' +
            '<div style="color:#fff;font-size:20px;font-weight:900;line-height:1.1;text-shadow:0 2px 6px rgba(0,0,0,0.50);margin:4px 0 6px;">Premio $' + _fmt(l.prizeValueARS) + '</div>' +
            (enrolled
                ? '<div style="background:rgba(255,235,59,0.20);border:2px solid #ffeb3b;border-radius:8px;padding:8px;text-align:center;color:#fff;font-size:13px;font-weight:900;text-shadow:0 1px 2px rgba(0,0,0,0.60);">✅ Estás anotado · Número #' + l.myTicket + '</div>'
                : (l.status !== 'active'
                    ? '<div style="background:rgba(0,0,0,0.45);border-radius:8px;padding:9px;text-align:center;">' +
                        '<div style="color:#fff;font-size:13px;font-weight:900;margin-bottom:4px;">⏳ SORTEO LLENO</div>' +
                        '<div style="color:#ffeb3b;font-size:10.5px;font-weight:700;line-height:1.4;">Para el próximo: necesitás al menos 1 número en sorteos pagos.</div>' +
                      '</div>'
                    : '<div style="height:8px;background:rgba(0,0,0,0.40);border-radius:4px;overflow:hidden;margin:4px 0;">' +
                        '<div style="height:100%;width:' + fillPct + '%;background:linear-gradient(90deg,#ffeb3b,#fff);box-shadow:0 0 10px rgba(255,235,59,0.80);"></div></div>' +
                      '<div style="display:flex;justify-content:space-between;font-size:11px;color:#fff;font-weight:700;margin-bottom:6px;">' +
                        '<span>' + sold + '/' + total + ' anotados</span>' +
                        '<span>' + (showCargar ? '💬 CARGÁ Y ENTRÁ' : '👉 ENTRÁ Y ELEGÍ TU NÚMERO') + '</span>' +
                      '</div>' +
                      (showCargar
                        ? '<div style="background:linear-gradient(135deg,#0f4c00,#1a8200);color:#fff;border:2px solid #66ff66;border-radius:8px;padding:9px;text-align:center;font-weight:900;font-size:13px;letter-spacing:1px;margin-top:4px;box-shadow:0 2px 8px rgba(102,255,102,0.40);">' +
                            '<div style="font-size:10.5px;color:#aaffaa;font-weight:700;margin-bottom:2px;">No tenés saldo suficiente</div>' +
                            '<div>💬 QUIERO CARGAR</div>' +
                          '</div>'
                        : '<div style="background:#ffeb3b;color:#001a40;border-radius:8px;padding:9px;text-align:center;font-weight:900;font-size:13px;letter-spacing:1px;margin-top:4px;box-shadow:0 2px 8px rgba(255,235,59,0.40);">' + ctaLabel + '</div>')
                  )
            ) +
        '</div>';
    }

    // wa.link del agente para reclamar el premio. Texto prefilled: "Gané el
    // sorteo semanal con mi número #N". El número va del winningTicketNumber.
    // Toma el teléfono soporte de VIP.state.linePhone (mismo helper que el
    // banner relámpago). Fallback: wa.link/metawin2026.
    function _winnerAgentHref(ticketN, raffleName) {
        const linePhone = (VIP && VIP.state && VIP.state.linePhone) || '';
        const waNum = String(linePhone).replace(/[^\d+]/g, '').replace(/^\+/, '');
        const msg = 'Gané el sorteo semanal con mi número #' + (ticketN || '') + (raffleName ? ' (' + raffleName + ')' : '');
        const text = encodeURIComponent(msg);
        if (waNum) return 'https://wa.me/' + waNum + '?text=' + text;
        return 'https://wa.link/metawin2026?text=' + text;
    }

    function _renderHomeWinnerMine(w) {
        const credited = !!w.prizeClaimedAt;
        const forfeited = !!w.prizeForfeitedAt;
        const needsClaim = !credited && !forfeited && w.prizeClaimable;
        const ago = w.minutesAgo < 60 ? (w.minutesAgo + ' min') : (w.hoursAgo + ' h');
        const waHref = _winnerAgentHref(w.winningTicketNumber, w.name);
        let body;
        if (forfeited) {
            // Premio anulado por no cumplir requisitos (5 cargas vigentes
            // mínimo, decisión del dueño). El user ve el motivo y se entera
            // qué tiene que hacer para la próxima.
            const reasonClean = (w.prizeForfeitedReason || '').includes('carga')
                ? 'No cumpliste con el mínimo de 5 cargas vigentes'
                : 'No cumpliste con los requisitos del sorteo';
            body = '<div style="background:rgba(255,68,68,0.18);border:1px solid #ff8080;border-radius:8px;padding:10px;font-size:12px;color:#fff;text-align:center;line-height:1.5;">' +
                   '<div style="color:#ff8080;font-weight:900;font-size:13px;margin-bottom:4px;">❌ PREMIO ANULADO</div>' +
                   '<div style="color:#ffd0d0;font-size:11.5px;">' + reasonClean + '</div>' +
                   '<div style="color:#ddd;font-size:10.5px;margin-top:4px;">Para próximos sorteos cargá 5 veces o más durante la semana.</div>' +
                   '</div>';
        } else if (credited) {
            body = '<div style="background:rgba(102,255,102,0.18);border:1px solid #66ff66;border-radius:8px;padding:8px 10px;font-size:12px;color:#fff;text-align:center;font-weight:800;">✅ Premio acreditado a tu saldo · hace ' + ago + '</div>';
        } else if (needsClaim) {
            // CTA principal: WhatsApp al agente con texto prefilled
            // "Gané el sorteo semanal con mi número #N".
            body = '<a href="' + waHref + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="display:block;text-decoration:none;width:100%;background:linear-gradient(135deg,#25d366,#128c7e);color:#fff;text-align:center;padding:12px;border-radius:9px;font-weight:900;font-size:14px;letter-spacing:0.5px;box-shadow:0 3px 12px rgba(37,211,102,0.45);">' +
                    '💬 RECLAMAR POR WHATSAPP — número #' + (w.winningTicketNumber || '?') +
                '</a>' +
                '<div style="background:rgba(255,170,102,0.12);border:1px dashed rgba(255,170,102,0.55);border-radius:8px;padding:7px 9px;margin-top:7px;font-size:11px;color:#ffd0a0;line-height:1.4;text-align:center;">' +
                    '⚠️ Necesitás <strong style="color:#ffd700;">5 cargas vigentes</strong> para que te acreditemos el premio. El agente las verifica.' +
                '</div>';
        } else {
            // Mensaje genérico (CTA participativo) — antes decía "Confirmá
            // con el agente" lo cual era confuso. Decisión dueño 2026-05-12:
            // que invite a seguir participando.
            body = '<div style="background:rgba(77,171,255,0.15);border:1px solid #4dabff;border-radius:8px;padding:9px 11px;font-size:12.5px;color:#fff;text-align:center;font-weight:800;line-height:1.4;">🎁 SORTEOS SEMANALES GRATIS<br><span style="color:#4dabff;">POR CARGAS Y POR NETWIN</span><br><span style="color:#ffd700;font-size:13px;">¡PARTICIPÁ!</span></div>';
        }
        // Countdown post-cobro: 30 min con timer mm:ss desde que cobro.
        let timer = '';
        if (credited && typeof w.secondsRemaining === 'number' && w.secondsRemaining > 0) {
            const expiresAt = Date.now() + w.secondsRemaining * 1000;
            timer = '<div data-claim-countdown="' + expiresAt + '" style="color:#fff;font-size:11px;text-align:center;margin-top:8px;font-weight:700;text-shadow:0 1px 2px rgba(0,0,0,0.50);">⏱ Esta felicitación queda <span class="claim-countdown-text">30:00</span> más</div>';
        }
        // Si el premio fue anulado, mostramos el banner con look apagado/
        // rojo en vez del verde dorado celebratorio. El user no debe
        // sentir que "ganó" cuando el premio fue anulado.
        if (forfeited) {
            return '<div onclick="VIP.raffles && VIP.raffles.open()" style="cursor:pointer;background:linear-gradient(135deg,#2a0010,#0a0005);border:2px solid #ff8080;border-radius:14px;padding:14px;margin:10px auto;max-width:560px;box-shadow:0 4px 16px rgba(255,68,68,0.30);position:relative;overflow:hidden;">' +
                '<div style="position:absolute;top:-12px;right:-12px;font-size:90px;opacity:0.10;">🎲</div>' +
                '<div style="color:#ff8080;font-weight:900;font-size:13px;letter-spacing:2px;text-transform:uppercase;text-shadow:0 1px 2px rgba(0,0,0,0.50);">🎲 Salió tu número</div>' +
                '<div style="color:#fff;font-size:16px;font-weight:900;margin:4px 0 8px;">' + (w.emoji || '🎲') + ' ' + _esc(w.name) + ' — $' + _fmt(w.prizeValueARS) + '</div>' +
                body +
                '<div style="text-align:center;margin-top:8px;color:#aaa;font-size:11px;font-weight:700;letter-spacing:0.5px;">👉 Tocá para ver todos los sorteos</div>' +
                '</div>';
        }
        // El banner abre el modal de sorteos al tocarlo (en cualquier parte que
        // no sea el CTA de WA o el countdown). Antes no tenía onclick y el user
        // quedaba bloqueado mirando "FELICITACIONES" sin poder abrir el menú
        // de sorteos para ver los demás pendientes — reportado 2026-05-12.
        return '<div onclick="VIP.raffles && VIP.raffles.open()" style="cursor:pointer;background:linear-gradient(135deg,#0f4c00,#1a8200,#ffd700);background-size:200% 200%;border:3px solid #ffd700;border-radius:14px;padding:14px;margin:10px auto;max-width:560px;box-shadow:0 0 24px rgba(255,215,0,0.50);position:relative;overflow:hidden;">' +
            '<div style="position:absolute;top:-12px;right:-12px;font-size:90px;opacity:0.10;">🏆</div>' +
            '<div style="color:#ffd700;font-weight:900;font-size:14px;letter-spacing:2px;text-transform:uppercase;text-shadow:0 1px 2px rgba(0,0,0,0.50);">🎉 ¡FELICITACIONES, GANASTE!</div>' +
            '<div style="color:#fff;font-size:18px;font-weight:900;margin:4px 0 8px;">' + (w.emoji || '🏆') + ' ' + _esc(w.name) + ' — $' + _fmt(w.prizeValueARS) + '</div>' +
            body +
            timer +
            '<div style="text-align:center;margin-top:8px;color:#ffd700;font-size:11px;font-weight:800;letter-spacing:0.5px;opacity:0.85;">👉 Tocá para ver todos los sorteos</div>' +
            '</div>';
    }

    function _renderHomeWinnerOthers(w) {
        const ago = w.minutesAgo < 60 ? (w.minutesAgo + ' min') : (w.hoursAgo + ' h');
        return '<div onclick="VIP.raffles && VIP.raffles.open()" style="cursor:pointer;background:linear-gradient(135deg,#1a0033 0%,#2d0052 50%,#1a0033 100%);border:1px solid #d4af37;border-radius:12px;padding:10px 14px;margin:10px auto;max-width:560px;box-shadow:0 2px 12px rgba(212,175,55,0.20);display:flex;align-items:center;gap:10px;">' +
            '<div style="font-size:28px;flex-shrink:0;">🏆</div>' +
            '<div style="flex:1;min-width:0;">' +
                '<div style="color:#d4af37;font-size:10px;text-transform:uppercase;letter-spacing:1.5px;font-weight:800;">Último ganador · hace ' + ago + '</div>' +
                '<div style="color:#fff;font-size:13px;font-weight:800;line-height:1.3;margin-top:2px;"><span style="color:#ffd700;">@' + _esc(w.winnerUsername || '') + '</span> se llevó <span style="color:#66ff66;">$' + _fmt(w.prizeValueARS) + '</span></div>' +
                '<div style="color:#aaa;font-size:10.5px;margin-top:1px;">' + (w.emoji || '🏆') + ' ' + _esc(w.name) + ' · ¡vos podés ser el próximo!</div>' +
            '</div>' +
            '<div style="color:#d4af37;font-size:18px;flex-shrink:0;">›</div>' +
            '</div>';
    }

    // Ticker global que actualiza todos los countdown post-cobro cada segundo.
    // Cada elemento marcado con data-claim-countdown="<expiresAtMs>" muestra
    // mm:ss restantes y se auto-oculta cuando llega a 0 (recargamos el banner
    // para que el server confirme que ya paso). Lo arrancamos una sola vez.
    if (!window.__VIP_CLAIM_TICKER_STARTED) {
        window.__VIP_CLAIM_TICKER_STARTED = true;
        setInterval(function () {
            const els = document.querySelectorAll('[data-claim-countdown]');
            if (els.length === 0) return;
            const now = Date.now();
            let expiredAny = false;
            els.forEach(function (el) {
                const expiresAt = parseInt(el.getAttribute('data-claim-countdown'), 10);
                if (!Number.isFinite(expiresAt)) return;
                const remMs = expiresAt - now;
                const span = el.querySelector('.claim-countdown-text');
                if (!span) return;
                if (remMs <= 0) {
                    span.textContent = '0:00';
                    el.style.opacity = '0.5';
                    expiredAny = true;
                    return;
                }
                const totalSec = Math.floor(remMs / 1000);
                const m = Math.floor(totalSec / 60);
                const s = totalSec % 60;
                span.textContent = m + ':' + (s < 10 ? '0' + s : s);
            });
            // Si algun countdown llego a 0, refrescamos el banner del home
            // (el server ya no lo va a devolver -> desaparece).
            if (expiredAny && VIP.raffles && typeof VIP.raffles.loadHomeWinnerBanner === 'function') {
                VIP.raffles.loadHomeWinnerBanner();
            }
        }, 1000);
    }

    // Helper para el banner del home: abre el modal Y el picker del sorteo
    // especifico en una sola accion. Asi el user que toca el banner del
    // relampago en el home cae directo sobre el grid 1-100 de ese sorteo,
    // sin tener que pasar por el modal generico ni buscarlo.
    async function openAndPickRaffle(raffleId) {
        await open();
        // Verificamos que el sorteo este en _data antes de abrir el picker
        // (el await de open() garantiza que _data este populado en el primer
        // load). Si no esta, fallback al modal generico.
        const r = (_data && _data.raffles || []).find(x => x.id === raffleId);
        if (r && r.status === 'active') {
            openPicker(raffleId);
        }
    }

    // refresh(): forzar refetch de raffles y re-render del modal. Lo usa
    // el handler de push (cuando llega un sorteo nuevo) y el visibility
    // change para que el user vea el estado actualizado sin tener que
    // cerrar y abrir la app.
    async function refresh() {
        try {
            const d = await _fetchActive();
            if (d) {
                _data = d;
                // Solo re-render si el modal está abierto — si no, basta
                // con que la data quede fresca para el próximo open().
                const m = document.getElementById('rafflesModal');
                if (m && m.style.display !== 'none') _render();
            }
        } catch (e) { /* best-effort */ }
    }
    return { open, close, prefetch, openPicker, openAndPickRaffle, closePicker, togglePick, pickRandom, clearPick, confirmPickerBuy, claimPrize, loadHomeWinnerBanner, refresh };
})();
