// =====================================================================
// BONIFICACIÓN VIGENTE
// Cartel en la home cuando el usuario tiene un bono de carga activo
// (lo activó una notificación de la automatización). Muestra el % y una
// cuenta regresiva; desaparece solo al vencer.
// =====================================================================
(function () {
    'use strict';
    window.VIP = window.VIP || {};

    let _bonus = null;
    let _tickId = null;
    let _gifts = []; // #177 regalos de fichas pendientes de RECLAMAR
    let _claiming = false;

    async function load() {
        if (!VIP.state || !VIP.state.currentToken) return;
        try {
            const r = await fetch(VIP.config.API_URL + '/api/promo-bonus/mine', {
                headers: { 'Authorization': 'Bearer ' + VIP.state.currentToken }
            });
            if (!r.ok) return;
            const d = await r.json();
            _bonus = (d && d.bonus) ? d.bonus : null;
            _render();
        } catch (e) { /* best-effort */ }
        loadGifts();
    }

    // ---- #177 Regalos de fichas con reclamo ----
    async function loadGifts() {
        if (!VIP.state || !VIP.state.currentToken) return;
        try {
            const r = await fetch(VIP.config.API_URL + '/api/gift/pending', {
                headers: { 'Authorization': 'Bearer ' + VIP.state.currentToken }
            });
            if (!r.ok) return;
            const d = await r.json();
            _gifts = (d && Array.isArray(d.gifts)) ? d.gifts : [];
        } catch (e) { return; }
        _renderGifts();
        renderPending('giftPendingBox');
    }

    function _money(n) { return '$' + Math.round(Number(n) || 0).toLocaleString('es-AR'); }
    function _esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function _hasta(d) {
        try { return new Date(d).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; }
    }

    function _giftHtml(g, compact) {
        return '<div data-gift="' + _esc(g.batchId) + '" style="' + (compact ? 'margin:0 0 10px;' : 'max-width:560px;margin:8px auto;') + 'background:linear-gradient(135deg,#3b2300,#7a4a00);border:2px solid #ffd700;border-radius:12px;padding:12px 14px;box-shadow:0 0 18px rgba(255,215,0,0.4);">'
            + '<div style="display:flex;align-items:center;gap:10px;">'
            + '<span style="font-size:30px;">🎁</span>'
            + '<div style="flex:1;min-width:0;">'
            + '<div style="color:#ffd700;font-weight:900;font-size:15px;">¡Tenés ' + _money(g.amount) + ' en fichas de regalo!</div>'
            + '<div style="color:#fff;font-size:11.5px;margin-top:2px;">Tocá RECLAMAR y se acreditan al instante en tu cuenta. Vence ' + _hasta(g.expiresAt) + '.</div>'
            + '</div>'
            + '<button onclick="VIP.promoBonus.claim(\'' + _esc(g.batchId) + '\', this)" style="background:linear-gradient(135deg,#ffd700,#f0a500);color:#1a0b2e;border:none;border-radius:10px;padding:10px 14px;font-weight:900;font-size:13px;cursor:pointer;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.35);">RECLAMAR</button>'
            + '</div>'
            + '<div class="gift-claim-msg" style="display:none;margin-top:8px;font-size:12.5px;font-weight:900;"></div>'
            + '</div>';
    }

    function _renderGifts() {
        const card = document.getElementById('giftClaimCard');
        if (!card) return;
        if (!_gifts.length) { card.style.display = 'none'; card.innerHTML = ''; return; }
        card.innerHTML = _gifts.map(function (g) { return _giftHtml(g, false); }).join('');
        card.style.display = '';
    }

    // Lista de pendientes dentro del modal 🎁 (o cualquier contenedor por id).
    function renderPending(containerId) {
        const box = document.getElementById(containerId);
        if (!box) return;
        if (!_gifts.length) { box.innerHTML = ''; return; }
        box.innerHTML = '<div style="color:#ffd700;font-weight:900;font-size:13px;margin:0 0 8px;">🎁 Regalos para reclamar</div>'
            + _gifts.map(function (g) { return _giftHtml(g, true); }).join('');
    }

    async function claim(batchId, btn) {
        if (_claiming || !VIP.state || !VIP.state.currentToken) return;
        _claiming = true;
        const cards = document.querySelectorAll('[data-gift="' + batchId + '"]');
        cards.forEach(function (c) { const b = c.querySelector('button'); if (b) { b.disabled = true; b.textContent = '...'; } });
        const say = function (txt, color) {
            cards.forEach(function (c) { const m = c.querySelector('.gift-claim-msg'); if (m) { m.style.display = ''; m.style.color = color; m.textContent = txt; } });
        };
        try {
            const r = await fetch(VIP.config.API_URL + '/api/gift/claim', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + VIP.state.currentToken },
                body: JSON.stringify({ batchId: batchId })
            });
            const d = await r.json().catch(function () { return {}; });
            if (r.ok && d && d.success) {
                say('✅ ' + (d.message || '¡Acreditado!'), '#8dffb0');
                try { if (VIP.ui && VIP.ui.syncBalance) VIP.ui.syncBalance(); } catch (_) {}
                setTimeout(function () { _gifts = _gifts.filter(function (g) { return g.batchId !== batchId; }); _renderGifts(); renderPending('giftPendingBox'); }, 2500);
            } else {
                say('❌ ' + ((d && d.error) || 'No se pudo reclamar. Probá de nuevo.'), '#ffb3b3');
                cards.forEach(function (c) { const b = c.querySelector('button'); if (b) { b.disabled = false; b.textContent = 'RECLAMAR'; } });
                // Si ya venció / ya lo reclamó, refrescar la lista real.
                if (r.status === 400 || r.status === 404) setTimeout(loadGifts, 2500);
            }
        } catch (e) {
            say('❌ Sin conexión. Probá de nuevo.', '#ffb3b3');
            cards.forEach(function (c) { const b = c.querySelector('button'); if (b) { b.disabled = false; b.textContent = 'RECLAMAR'; } });
        }
        _claiming = false;
    }

    function _fmtLeft(ms) {
        if (ms <= 0) return '0:00';
        const totalMin = Math.floor(ms / 60000);
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        const s = Math.floor((ms % 60000) / 1000);
        if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
        return m + ':' + String(s).padStart(2, '0');
    }

    function _render() {
        const card = document.getElementById('promoBonusCard');
        if (!card) return;
        if (_tickId) { clearInterval(_tickId); _tickId = null; }
        if (!_bonus) { card.style.display = 'none'; card.innerHTML = ''; return; }
        const exp = new Date(_bonus.expiresAt).getTime();
        const percent = Number(_bonus.percent) || 0;
        const paint = function () {
            const left = exp - Date.now();
            if (left <= 0) {
                _bonus = null;
                card.style.display = 'none';
                card.innerHTML = '';
                if (_tickId) { clearInterval(_tickId); _tickId = null; }
                return;
            }
            card.innerHTML = '<div style="max-width:560px;margin:8px auto;background:linear-gradient(135deg,#0f4c00,#1a8200);border:2px solid #ffd700;border-radius:12px;padding:11px 14px;box-shadow:0 0 16px rgba(255,215,0,0.35);">'
                + '<div style="display:flex;align-items:center;gap:10px;">'
                + '<span style="font-size:26px;">🎁</span>'
                + '<div style="flex:1;min-width:0;">'
                + '<div style="color:#ffd700;font-weight:900;font-size:14px;">¡Bonificación vigente: ' + percent + '% en tu carga!</div>'
                + '<div style="color:#fff;font-size:11.5px;margin-top:2px;">Cargá ahora y pedí tu bono al agente. Vence en <strong>' + _fmtLeft(left) + '</strong>.</div>'
                + '</div>'
                + '</div>'
                + '</div>';
            card.style.display = '';
        };
        paint();
        _tickId = setInterval(paint, 1000);
    }

    VIP.promoBonus = { load: load, loadGifts: loadGifts, renderPending: renderPending, claim: claim };

    document.addEventListener('DOMContentLoaded', function () {
        let tries = 0;
        const tick = function () {
            if (VIP.state && VIP.state.currentToken) {
                load();
            } else if (tries++ < 20) {
                setTimeout(tick, 1500);
            }
        };
        setTimeout(tick, 1000);
    });
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') load();
    });
    // Refresco cada 2 min por si entra un bono nuevo con la app abierta.
    setInterval(function () {
        if (document.visibilityState === 'visible' && VIP.state && VIP.state.currentToken) load();
    }, 120000);
})();
