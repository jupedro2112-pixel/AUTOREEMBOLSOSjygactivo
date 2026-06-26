// =====================================================================
// RESEÑAS / OPINIONES
// - Widget público en la pantalla de registro/login (prueba social).
// - Card + modal de envío dentro de la app (1 reseña por usuario).
// Las reseñas nacen pendientes; recién aparecen en el registro cuando
// un admin las aprueba desde el panel.
// =====================================================================
(function () {
    'use strict';
    window.VIP = window.VIP || {};

    function _esc(s) {
        const d = document.createElement('div');
        d.textContent = String(s == null ? '' : s);
        return d.innerHTML;
    }
    function _starsHtml(n, size) {
        const v = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
        let h = '';
        for (let i = 1; i <= 5; i++) {
            h += '<span style="color:' + (i <= v ? '#ffd700' : '#555') + ';font-size:' + (size || 14) + 'px;">★</span>';
        }
        return h;
    }

    // ---------- Widget público en la pantalla de registro ----------
    async function initLogin() {
        const box = document.getElementById('loginReviewsWidget');
        if (!box) return;
        try {
            const r = await fetch(VIP.config.API_URL + '/api/reviews/public?limit=12');
            if (!r.ok) return;
            const d = await r.json();
            if (!d || !d.total) { box.style.display = 'none'; return; }
            _renderLoginWidget(box, d);
        } catch (e) { /* best-effort */ }
    }

    function _renderLoginWidget(box, d) {
        const avg = Number(d.avgStars || 0);
        const total = Number(d.total || 0);
        const withText = (d.items || []).filter(function (it) {
            const c = (it.comment || '').trim();
            return c && !/^[1-5] estrellas$/.test(c);
        }).slice(0, 6);
        let html = '';
        html += '<div style="background:linear-gradient(135deg,rgba(212,175,55,0.10),rgba(106,13,173,0.10));border:1px solid rgba(212,175,55,0.35);border-radius:12px;padding:13px;margin-top:14px;text-align:left;">';
        html += '  <div style="text-align:center;margin-bottom:8px;">';
        html += '    <div style="letter-spacing:2px;">' + _starsHtml(avg, 18) + '</div>';
        html += '    <div style="color:#ffd700;font-weight:900;font-size:15px;margin-top:2px;">' + avg.toFixed(1) + ' / 5</div>';
        html += '    <div style="color:#b0b0b0;font-size:11px;">' + total + ' opinión' + (total === 1 ? '' : 'es') + ' de nuestros jugadores</div>';
        html += '  </div>';
        if (withText.length > 0) {
            html += '  <div style="display:flex;flex-direction:column;gap:6px;max-height:210px;overflow-y:auto;-webkit-overflow-scrolling:touch;">';
            for (const it of withText) {
                html += '<div style="background:rgba(0,0,0,0.30);border-radius:8px;padding:7px 9px;">';
                html += '<div style="font-size:11px;">' + _starsHtml(it.stars, 11) + ' <span style="color:#888;font-size:10px;margin-left:4px;">' + _esc(it.maskedUsername || '***') + '</span></div>';
                html += '<div style="color:#ddd;font-size:11.5px;line-height:1.4;margin-top:2px;">"' + _esc(it.comment) + '"</div>';
                html += '</div>';
            }
            html += '  </div>';
        }
        html += '</div>';
        box.innerHTML = html;
        box.style.display = '';
    }

    // ---------- Card + modal de envío (in-app, logueado) ----------
    let _myReview = null;
    let _selectedStars = 5;

    async function initApp() {
        const card = document.getElementById('reviewHomeCard');
        if (!card || !VIP.state || !VIP.state.currentToken) return;
        try {
            const r = await fetch(VIP.config.API_URL + '/api/reviews/mine', {
                headers: { 'Authorization': 'Bearer ' + VIP.state.currentToken }
            });
            if (!r.ok) return;
            const d = await r.json();
            _myReview = d && d.review ? d.review : null;
            _renderHomeCard();
        } catch (e) { /* best-effort */ }
    }

    function _renderHomeCard() {
        const card = document.getElementById('reviewHomeCard');
        if (!card) return;
        if (_myReview) {
            card.innerHTML = '<div style="max-width:560px;margin:8px auto;background:rgba(0,0,0,0.35);border:1px solid rgba(212,175,55,0.25);border-radius:10px;padding:8px 12px;display:flex;align-items:center;gap:8px;font-size:12px;">'
                + '<span>' + _starsHtml(_myReview.stars, 13) + '</span>'
                + '<span style="color:#ccc;flex:1;">Gracias por tu opinión 💛</span>'
                + '</div>';
            card.style.display = '';
            return;
        }
        card.innerHTML = '<div onclick="VIP.reviews.openModal()" style="cursor:pointer;max-width:560px;margin:8px auto;background:linear-gradient(135deg,#4a0080,#7c00cc);border:1px solid #d4af37;border-radius:10px;padding:9px 12px;display:flex;align-items:center;gap:8px;font-size:12.5px;">'
            + '<span style="font-size:17px;">⭐</span>'
            + '<span style="color:#fff;font-weight:700;flex:1;">¿Cómo la estás pasando? <span style="color:#ffd700;">Dejanos tu opinión</span></span>'
            + '<span style="background:#ffd700;color:#000;font-weight:900;padding:3px 9px;border-radius:6px;font-size:11px;">OPINAR</span>'
            + '</div>';
        card.style.display = '';
    }

    // ---------- Sección de reseñas dentro del modal de Información ----------
    async function renderInfoSection() {
        const box = document.getElementById('infoReviewsSection');
        if (!box) return;
        box.innerHTML = '<div style="text-align:center;color:#888;font-size:12px;padding:12px;">Cargando opiniones…</div>';

        let pub = null;
        try {
            const r = await fetch(VIP.config.API_URL + '/api/reviews/public?limit=12');
            if (r.ok) pub = await r.json();
        } catch (e) { /* best-effort */ }

        if (_myReview === null && VIP.state && VIP.state.currentToken) {
            try {
                const r2 = await fetch(VIP.config.API_URL + '/api/reviews/mine', {
                    headers: { 'Authorization': 'Bearer ' + VIP.state.currentToken }
                });
                if (r2.ok) { const d2 = await r2.json(); _myReview = d2 && d2.review ? d2.review : null; }
            } catch (e) { /* best-effort */ }
        }

        const avg = Number((pub && pub.avgStars) || 0);
        const total = Number((pub && pub.total) || 0);
        const withText = ((pub && pub.items) || []).filter(function (it) {
            const c = (it.comment || '').trim();
            return c && !/^[1-5] estrellas$/.test(c);
        }).slice(0, 6);

        let html = '<div style="margin-top:8px;border-top:1px solid rgba(212,175,55,0.3);padding-top:14px;">';
        html += '<h3 style="color:#ffd700;text-align:center;font-size:14px;font-weight:900;margin:0 0 8px;">⭐ Opiniones de nuestros jugadores</h3>';
        if (total > 0) {
            html += '<div style="text-align:center;margin-bottom:8px;">';
            html += '<div style="letter-spacing:2px;">' + _starsHtml(avg, 18) + '</div>';
            html += '<div style="color:#ffd700;font-weight:900;font-size:15px;">' + avg.toFixed(1) + ' / 5</div>';
            html += '<div style="color:#b0b0b0;font-size:11px;">' + total + ' opinión' + (total === 1 ? '' : 'es') + '</div>';
            html += '</div>';
        }
        if (withText.length > 0) {
            html += '<div style="display:flex;flex-direction:column;gap:6px;max-height:170px;overflow-y:auto;-webkit-overflow-scrolling:touch;margin-bottom:10px;">';
            for (const it of withText) {
                html += '<div style="background:rgba(0,0,0,0.30);border-radius:8px;padding:7px 9px;">';
                html += '<div style="font-size:11px;">' + _starsHtml(it.stars, 11) + ' <span style="color:#888;font-size:10px;margin-left:4px;">' + _esc(it.maskedUsername || '***') + '</span></div>';
                html += '<div style="color:#ddd;font-size:11.5px;line-height:1.4;margin-top:2px;">"' + _esc(it.comment) + '"</div>';
                html += '</div>';
            }
            html += '</div>';
        } else {
            html += '<div style="text-align:center;color:#999;font-size:11.5px;margin-bottom:10px;">Todavía no hay opiniones. ¡Sé el primero!</div>';
        }
        if (_myReview) {
            html += '<div style="text-align:center;background:rgba(0,0,0,0.35);border:1px solid rgba(212,175,55,0.25);border-radius:10px;padding:9px;font-size:12px;color:#ccc;">'
                + _starsHtml(_myReview.stars, 14) + '<div style="margin-top:3px;">Gracias por tu opinión 💛</div></div>';
        } else {
            html += '<button onclick="VIP.reviews.openModal()" style="width:100%;background:linear-gradient(135deg,#ffd700,#f7931e);color:#000;border:none;padding:11px;border-radius:11px;font-weight:900;font-size:13px;cursor:pointer;">⭐ Dejá tu opinión</button>';
        }
        html += '</div>';
        box.innerHTML = html;
    }

    // ---------- Reseñas dentro del pantallazo de pauta (adServiceModal) ----------

    function openModal() {
        closeModal();
        _selectedStars = 5;
        const ov = document.createElement('div');
        ov.id = 'reviewModalOverlay';
        ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:26000;display:flex;align-items:center;justify-content:center;padding:14px;';
        ov.onclick = function (e) { if (e.target === ov) closeModal(); };
        ov.innerHTML = '<div style="background:linear-gradient(135deg,#1a0033,#0a0015);border:2px solid #d4af37;border-radius:16px;padding:20px 18px;max-width:420px;width:100%;color:#fff;box-sizing:border-box;">'
            + '<h2 style="color:#ffd700;text-align:center;margin:0 0 4px;font-size:18px;font-weight:900;">⭐ Tu opinión</h2>'
            + '<p style="color:#bbb;text-align:center;font-size:12px;margin:0 0 14px;">Contanos cómo la estás pasando. Se envía una sola vez.</p>'
            + '<div id="reviewModalStars" style="text-align:center;font-size:38px;letter-spacing:6px;margin-bottom:10px;"></div>'
            + '<textarea id="reviewModalComment" maxlength="100" placeholder="Escribí tu comentario (opcional)" style="width:100%;box-sizing:border-box;background:rgba(0,0,0,0.45);border:1px solid rgba(212,175,55,0.4);color:#fff;border-radius:9px;padding:10px;font-size:13px;min-height:70px;resize:vertical;"></textarea>'
            + '<div id="reviewModalMsg" style="font-size:12px;text-align:center;min-height:16px;margin:8px 0;"></div>'
            + '<button id="reviewModalSubmit" onclick="VIP.reviews.submit()" style="width:100%;background:linear-gradient(135deg,#ffd700,#f7931e);color:#000;border:none;padding:13px;border-radius:11px;font-weight:900;font-size:14px;cursor:pointer;">📨 Enviar opinión</button>'
            + '<button onclick="VIP.reviews.closeModal()" style="width:100%;margin-top:8px;background:transparent;color:#aaa;border:1px solid rgba(255,255,255,0.2);padding:10px;border-radius:9px;font-weight:700;font-size:12px;cursor:pointer;">Cerrar</button>'
            + '</div>';
        document.body.appendChild(ov);
        _paintModalStars();
    }

    function closeModal() {
        const ov = document.getElementById('reviewModalOverlay');
        if (ov) ov.remove();
    }

    function _paintModalStars() {
        const el = document.getElementById('reviewModalStars');
        if (!el) return;
        let h = '';
        for (let i = 1; i <= 5; i++) {
            h += '<span onclick="VIP.reviews.setStars(' + i + ')" style="cursor:pointer;color:' + (i <= _selectedStars ? '#ffd700' : '#555') + ';">★</span>';
        }
        el.innerHTML = h;
    }

    function setStars(n) {
        _selectedStars = Math.max(1, Math.min(5, Number(n) || 5));
        _paintModalStars();
    }

    async function submit() {
        const btn = document.getElementById('reviewModalSubmit');
        const msg = document.getElementById('reviewModalMsg');
        const ta = document.getElementById('reviewModalComment');
        if (!_selectedStars) { if (msg) { msg.style.color = '#ff6b6b'; msg.textContent = 'Elegí las estrellas'; } return; }
        let comment = ((ta && ta.value) || '').trim().slice(0, 100);
        if (!comment) comment = _selectedStars + ' estrellas';
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Enviando…'; }
        try {
            const r = await fetch(VIP.config.API_URL + '/api/reviews', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + VIP.state.currentToken, 'Content-Type': 'application/json' },
                body: JSON.stringify({ stars: _selectedStars, comment: comment })
            });
            const d = await r.json();
            if (!r.ok) {
                if (d && d.alreadyReviewed) {
                    _myReview = { stars: _selectedStars, comment: comment };
                    if (msg) { msg.style.color = '#ffd700'; msg.textContent = 'Ya habías opinado. ¡Gracias!'; }
                    setTimeout(function () { closeModal(); _renderHomeCard(); renderInfoSection(); }, 1400);
                    return;
                }
                if (msg) { msg.style.color = '#ff8080'; msg.textContent = (d && d.error) || 'Error'; }
                if (btn) { btn.disabled = false; btn.textContent = '📨 Enviar opinión'; }
                return;
            }
            _myReview = { stars: _selectedStars, comment: comment };
            if (msg) { msg.style.color = '#66ff66'; msg.textContent = '✅ ¡Gracias! Tu opinión quedó enviada.'; }
            if (VIP.ui && VIP.ui.showToast) VIP.ui.showToast('✅ ¡Gracias por tu opinión!', 'success');
            setTimeout(function () { closeModal(); _renderHomeCard(); renderInfoSection(); }, 1600);
        } catch (e) {
            if (msg) { msg.style.color = '#ff8080'; msg.textContent = 'Error de conexión'; }
            if (btn) { btn.disabled = false; btn.textContent = '📨 Enviar opinión'; }
        }
    }

    VIP.reviews = { initLogin: initLogin, initApp: initApp, openModal: openModal, closeModal: closeModal, setStars: setStars, submit: submit, renderInfoSection: renderInfoSection };

    document.addEventListener('DOMContentLoaded', function () {
        initLogin();
        let tries = 0;
        const tick = function () {
            if (VIP.state && VIP.state.currentToken) {
                initApp();
            } else if (tries++ < 20) {
                setTimeout(tick, 1500);
            }
        };
        setTimeout(tick, 1000);
    });
})();
