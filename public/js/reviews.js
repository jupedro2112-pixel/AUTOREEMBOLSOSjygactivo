/**
 * VIP.reviews — sistema de opiniones del usuario.
 *
 * Card arriba: 5 estrellas + textarea max 100 chars + boton enviar.
 * Bloque al fondo: promedio de la casa + porcentajes bueno/regular/malo
 * + lista chica encuadrada con username enmascarado al 80%.
 */
window.VIP = window.VIP || {};
VIP.reviews = (function () {
    'use strict';

    // Default: 5 estrellas pre-seleccionadas. El user ajusta hacia abajo si
    // quiere puntuarnos menos — antes arrancaba en 0 y el primer click pintaba
    // 1 sola, lo que hacía que mucha gente se quedara puntuando bajo sin querer.
    let _selectedStars = 5;
    let _myReviewLoaded = false;
    let _feedPollId = null;
    // Comentario por defecto: matchea con las estrellas que el user tocó.
    // 5 estrellas → "5 estrellas", 4 → "4 estrellas", etc. Si todavía no
    // tocó ninguna, default "5 estrellas". Apenas el user hace focus en el
    // textarea, se limpia para que arranque con sus propias palabras.
    function _defaultCommentForStars(n) {
        const v = Math.max(1, Math.min(5, Number(n) || 5));
        return v + ' estrellas';
    }
    function _isDefaultComment(s) {
        return /^[1-5] estrellas$/.test(String(s || '').trim());
    }

    function _q(id) { return document.getElementById(id); }

    // ---------- Card del form (arriba del user line) ----------
    function _paintStarsRow(value) {
        const stars = document.querySelectorAll('#reviewStarsRow .review-star');
        stars.forEach(st => {
            const v = Number(st.getAttribute('data-v'));
            st.classList.toggle('active', v <= value);
            st.classList.remove('hover');
        });
    }
    function _hoverStarsRow(value) {
        const stars = document.querySelectorAll('#reviewStarsRow .review-star');
        stars.forEach(st => {
            const v = Number(st.getAttribute('data-v'));
            st.classList.toggle('hover', v <= value);
        });
    }

    function _wireFormOnce() {
        if (_wireFormOnce._wired) return;
        _wireFormOnce._wired = true;

        const ta = _q('reviewCommentInput');
        const cnt = _q('reviewCharCount');

        const stars = document.querySelectorAll('#reviewStarsRow .review-star');
        stars.forEach(st => {
            st.addEventListener('click', () => {
                _selectedStars = Number(st.getAttribute('data-v'));
                _paintStarsRow(_selectedStars);
                // Si el comentario es vacío o aún tiene el default ("N
                // estrellas"), lo actualizamos para que matchee la cantidad
                // que tocó el user. Si ya escribió algo propio, no tocamos.
                if (ta && (ta.value === '' || _isDefaultComment(ta.value))) {
                    ta.value = _defaultCommentForStars(_selectedStars);
                    if (cnt) cnt.textContent = String(ta.value.length);
                }
            });
            st.addEventListener('mouseenter', () => {
                _hoverStarsRow(Number(st.getAttribute('data-v')));
            });
            st.addEventListener('mouseleave', () => {
                _hoverStarsRow(0);
                _paintStarsRow(_selectedStars);
            });
        });

        // Default inicial "5 estrellas". Apenas el user hace focus para
        // escribir, se limpia para que arranque con sus palabras.
        if (ta && !ta.value) {
            ta.value = _defaultCommentForStars(5);
            if (cnt) cnt.textContent = String(ta.value.length);
        }
        // Pintar las 5 estrellas como pre-seleccionadas. El user puede
        // clickear una más baja para ajustar — no tiene que clickear desde 0.
        _paintStarsRow(_selectedStars);
        if (ta) {
            ta.addEventListener('focus', () => {
                if (_isDefaultComment(ta.value)) {
                    ta.value = '';
                    if (cnt) cnt.textContent = '0';
                }
            }, { once: false });
        }
        if (ta && cnt) {
            ta.addEventListener('input', () => {
                cnt.textContent = String(ta.value.length);
            });
        }

        // Toggle "Agregar número": esconde el botón y muestra el input. Una vez
        // expandido queda así (no ofrece volver a colapsar — feature mínima).
        const phoneToggle = _q('reviewPhoneToggle');
        const phoneRow = _q('reviewPhoneRow');
        if (phoneToggle && phoneRow) {
            phoneToggle.addEventListener('click', () => {
                phoneRow.hidden = false;
                phoneToggle.style.display = 'none';
                const inp = _q('reviewPhoneInput');
                if (inp) inp.focus();
            });
        }

        const btn = _q('reviewSubmitBtn');
        if (btn) btn.addEventListener('click', submitReview);
    }

    let _userVoted = false;

    function _hideFormCard() {
        const card = _q('reviewFormCard');
        if (card) card.style.display = 'none';
        _userVoted = true;
        _refreshMiniSummary();
    }

    function _renderMiniStars(avg) {
        const a = Math.max(0, Math.min(5, Number(avg) || 0));
        const full = Math.floor(a);
        const frac = a - full;
        // 4.5 → 4 estrellas llenas + 1 media. 4.8 → 5 llenas (round-up).
        // 4.1 → 4 llenas (sin media). Umbral medio: [0.25, 0.75).
        const roundUp = frac >= 0.75;
        const half = !roundUp && frac >= 0.25;
        const totalFull = roundUp ? full + 1 : full;
        let html = '';
        for (let i = 1; i <= 5; i++) {
            if (i <= totalFull) html += '★';
            else if (i === totalFull + 1 && half) html += '<span class="half">★</span>';
            else html += '<span class="empty">★</span>';
        }
        return html;
    }

    // Si el user ya votó, pintamos el mini resumen arriba con el agregado
    // (avg + cantidad). Tomamos los datos del último _renderFeed para no
    // repegar; si todavía no llamamos al feed, lo dejamos en 0 hasta que
    // venga la respuesta.
    function _refreshMiniSummary(feedData) {
        const card = _q('reviewMiniSummary');
        if (!card) return;
        if (!_userVoted) {
            card.hidden = true;
            return;
        }
        const data = feedData || _LAST_FEED_DATA;
        if (!data || !data.total) {
            // Igual mostramos el card vacío — el user ya votó pero la primera
            // pasada del feed puede tardar un toque.
            card.hidden = false;
            return;
        }
        const total = Number(data.total || 0);
        const avg = Number(data.avgStars || 0);
        const stars = _q('reviewMiniStars');
        const num = _q('reviewMiniNum');
        const count = _q('reviewMiniCount');
        if (stars) stars.innerHTML = _renderMiniStars(avg);
        if (num) num.textContent = avg.toFixed(1) + ' / 5';
        if (count) count.textContent = total + ' opinion' + (total === 1 ? '' : 'es');
        card.hidden = false;
    }

    let _LAST_FEED_DATA = null;

    async function loadMyReview() {
        if (!VIP.state || !VIP.state.currentToken) return;
        try {
            const r = await fetch(`${VIP.config.API_URL}/api/reviews/mine`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (!r.ok) return;
            const data = await r.json();
            // 1 opinión por user: si ya votó, ocultar el form para siempre.
            if (data && data.review) {
                _hideFormCard();
            }
            _myReviewLoaded = true;
        } catch (_) { /* ignore */ }
    }

    async function submitReview() {
        const msg = _q('reviewSubmitMsg');
        const btn = _q('reviewSubmitBtn');
        if (!_selectedStars || _selectedStars < 1 || _selectedStars > 5) {
            // Forzar elección de estrellas: shake animation + scroll + msg en rojo.
            const row = _q('reviewStarsRow');
            if (row) {
                row.classList.remove('invalid');
                // Reflow para reiniciar la animación si ya estaba aplicada.
                void row.offsetWidth;
                row.classList.add('invalid');
                try { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
                setTimeout(() => row.classList.remove('invalid'), 1200);
            }
            if (msg) { msg.style.color = '#ff6b6b'; msg.textContent = '⚠️ Elegí primero las estrellas — ¿cuánto nos puntuás de 1 a 5?'; }
            return;
        }
        const ta = _q('reviewCommentInput');
        let comment = ((ta && ta.value) || '').trim().slice(0, 100);
        // Si dejó el campo vacío (no escribió o borró todo), enviamos
        // "{N} estrellas" matcheando las que tocó. Default 5 si no tocó.
        if (!comment) comment = _defaultCommentForStars(_selectedStars || 5);
        const phoneInp = _q('reviewPhoneInput');
        const phoneRow = _q('reviewPhoneRow');
        const phoneVisible = phoneRow && !phoneRow.hidden;
        const contactPhone = (phoneVisible && phoneInp) ? (phoneInp.value || '').trim() : '';
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Enviando…'; }
        if (msg) { msg.style.color = '#aaa'; msg.textContent = '⏳ Enviando…'; }
        try {
            const r = await fetch(`${VIP.config.API_URL}/api/reviews`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${VIP.state.currentToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ stars: _selectedStars, comment, contactPhone })
            });
            const data = await r.json();
            if (!r.ok) {
                // Si ya votó (caso de tab vieja o doble-submit), ocultar form igual.
                if (data && data.alreadyReviewed) {
                    if (msg) { msg.style.color = '#ffd700'; msg.textContent = 'Ya habías enviado tu opinión. ¡Gracias!'; }
                    setTimeout(_hideFormCard, 1500);
                    loadFeed();
                    return;
                }
                if (msg) { msg.style.color = '#ff8080'; msg.textContent = '❌ ' + (data.error || 'Error'); }
                if (btn) { btn.disabled = false; btn.textContent = '📨 Enviar opinión'; }
                return;
            }
            if (msg) { msg.style.color = '#66ff66'; msg.textContent = '✅ ¡Gracias! Tu opinión nos ayuda a mejorar.'; }
            // Cierra el form después de un momento — solo se vota una vez.
            setTimeout(_hideFormCard, 1800);
            loadFeed();
        } catch (e) {
            if (msg) { msg.style.color = '#ff8080'; msg.textContent = '❌ Error de conexión'; }
            if (btn) { btn.disabled = false; btn.textContent = '📨 Enviar opinión'; }
        }
    }

    // ---------- Feed (al fondo) ----------
    function _renderStars(n) {
        const v = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
        let html = '';
        for (let i = 1; i <= 5; i++) {
            html += i <= v ? '★' : '<span class="empty">★</span>';
        }
        return html;
    }
    function _renderAvgStars(avg) {
        const a = Math.max(0, Math.min(5, Number(avg) || 0));
        const full = Math.floor(a);
        const frac = a - full;
        // Misma logica que mini-stars: 4.5 → 4 llenas + 1 media (la quinta
        // queda partida al 50% en dorado). 4.8 redondea para arriba; 4.1 deja
        // la quinta vacía.
        const roundUp = frac >= 0.75;
        const half = !roundUp && frac >= 0.25;
        const totalFull = roundUp ? full + 1 : full;
        let html = '';
        for (let i = 1; i <= 5; i++) {
            if (i <= totalFull) html += '<span class="filled">★</span>';
            else if (i === totalFull + 1 && half) html += '<span class="half">★</span>';
            else html += '<span class="empty">★</span>';
        }
        return html;
    }
    function _esc(s) {
        return String(s || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function _whenStr(d) {
        if (!d) return '';
        try {
            const dt = new Date(d);
            return dt.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
        } catch (_) { return ''; }
    }

    // Cache simple en sessionStorage para no repegar al backend cada vez
    // que el user abre la app. TTL corto para que no se desactualice mucho.
    const _FEED_CACHE_KEY = 'vipReviewsFeedCache:v1';
    const _FEED_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos
    function _readFeedCache() {
        try {
            const raw = sessionStorage.getItem(_FEED_CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || !parsed.ts || (Date.now() - parsed.ts) > _FEED_CACHE_TTL_MS) return null;
            return parsed.data;
        } catch (_) { return null; }
    }
    function _writeFeedCache(data) {
        try {
            sessionStorage.setItem(_FEED_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
        } catch (_) {}
    }

    let _feedFetching = false;
    async function loadFeed(force) {
        if (!VIP.state || !VIP.state.currentToken) return;
        if (_feedFetching) return;
        // Cache hit: pintamos de inmediato sin pegarle al backend.
        if (!force) {
            const cached = _readFeedCache();
            if (cached) {
                _renderFeed(cached);
                return;
            }
        }
        _feedFetching = true;
        try {
            const r = await fetch(`${VIP.config.API_URL}/api/reviews/feed?limit=60`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (!r.ok) return;
            const data = await r.json();
            _writeFeedCache(data);
            _renderFeed(data);
        } catch (_) { /* ignore */ } finally {
            _feedFetching = false;
        }
    }

    function _renderFeed(data) {
        _LAST_FEED_DATA = data;
        // Si el user ya votó, refrescamos el mini-resumen de arriba con el
        // último agregado (avg + total). Es el chiquito en la línea del user.
        _refreshMiniSummary(data);
        const summary = _q('reviewsFeedSummary');
        const list = _q('reviewsFeedList');
        const card = _q('reviewsFeedCard');
        if (!summary || !list || !card) return;

        const total = Number(data.total || 0);
        if (total === 0) {
            summary.innerHTML =
                '<div style="color:#aaa;font-size:12px;line-height:1.5;">Todavía no hay opiniones. Sé el primero arriba ☝</div>';
            list.innerHTML = '';
            return;
        }
        const avg = Number(data.avgStars || 0);
        const counts = data.counts || {};
        const bueno = Number(counts.bueno || 0);
        const regular = Number(counts.regular || 0);
        const malo = Number(counts.malo || 0);
        const pct = (n) => total > 0 ? ((n / total) * 100).toFixed(0) + '%' : '0%';

        summary.innerHTML =
            '<div class="avg-stars">' + _renderAvgStars(avg) + '</div>' +
            '<div class="avg-num">' + avg.toFixed(1) + ' / 5 · ' + total + ' opinion' + (total === 1 ? '' : 'es') + '</div>' +
            '<div class="pct-row">' +
                '<span class="pct-good">😊 ' + pct(bueno) + ' BUENO</span>' +
                '<span class="pct-reg">😐 ' + pct(regular) + ' REGULAR</span>' +
                '<span class="pct-bad">😟 ' + pct(malo) + ' MALO</span>' +
            '</div>';

        const items = Array.isArray(data.items) ? data.items : [];
        if (items.length === 0) {
            list.innerHTML = '<div style="color:#aaa;font-size:11.5px;text-align:center;padding:6px;">Sin comentarios públicos.</div>';
            return;
        }
        // Separar: arriba van los reviews con texto REAL (no default), y
        // abajo, en bloque aparte y más chico, los que dejaron solo estrellas.
        const withComment = [];
        const starsOnly   = [];
        for (const it of items) {
            const c = (it.comment || '').trim();
            if (c && !_isDefaultComment(c)) withComment.push(it);
            else starsOnly.push(it);
        }

        // Chunk en columnas (en desktop arma N columnas, en mobile apila).
        const PER_COL = 12;
        const renderItem = (it) => {
            const stars = _renderStars(it.stars);
            const rawComment = it.comment || '';
            // Reviews sin comentario muestran "{N} estrellas" matcheando el
            // puntaje del review (5 → "5 estrellas", 4 → "4 estrellas", etc.).
            const comment = _esc(rawComment || _defaultCommentForStars(it.stars));
            // tooltip nativo con el comentario completo + fecha (para hover desktop)
            const when = _whenStr(it.updatedAt);
            const tipParts = [];
            if (rawComment) tipParts.push(rawComment);
            tipParts.push((it.maskedUsername || '***') + (when ? ' · ' + when : ''));
            const title = _esc(tipParts.join(' — '));
            return '<div class="review-item" title="' + title + '">' +
                '<div class="item-stars">' + stars + '</div>' +
                '<div class="item-body">' +
                  '<div class="item-comment">' + comment + '</div>' +
                  '<div class="item-meta">' + _esc(it.maskedUsername || '***') + '</div>' +
                '</div>' +
            '</div>';
        };
        // Item compacto para el bloque "solo estrellas" (más chico, en grid).
        const renderStarsOnly = (it) => {
            const stars = _renderStars(it.stars);
            return '<div class="review-item-mini" title="' + _esc(it.maskedUsername || '***') + '">' +
                '<span class="mini-stars">' + stars + '</span>' +
                '<span class="mini-user">' + _esc(it.maskedUsername || '***') + '</span>' +
            '</div>';
        };

        let html = '';
        if (withComment.length > 0) {
            const cols = [];
            for (let i = 0; i < withComment.length; i += PER_COL) {
                const slice = withComment.slice(i, i + PER_COL);
                cols.push('<div class="reviews-col">' + slice.map(renderItem).join('') + '</div>');
            }
            html += cols.join('');
        } else {
            html += '<div style="color:#aaa;font-size:11.5px;text-align:center;padding:6px;">Todavía nadie escribió un comentario con texto.</div>';
        }
        if (starsOnly.length > 0) {
            // Count real desde el server (data.starsOnlyTotal). Si no vino,
            // fallback al length local del feed actual (legacy).
            const starsOnlyCount = (data && Number.isFinite(data.starsOnlyTotal))
                ? data.starsOnlyTotal
                : starsOnly.length;
            html += '<div class="reviews-stars-only-divider">⭐ Solo estrellas (' + starsOnlyCount.toLocaleString('es-AR') + ')</div>';
            html += '<div class="reviews-stars-only-grid">' + starsOnly.map(renderStarsOnly).join('') + '</div>';
        }
        list.innerHTML = html;
        _wireFeedClickToExpand(list);
    }

    // Click → expand/collapse del review-item para ver el comentario completo
    // sin tener que pasar el mouse por encima (en mobile no hay hover). Bind
    // delegado para que sirva con cualquier re-render del feed.
    let _feedExpandWired = false;
    function _wireFeedClickToExpand(list) {
        if (_feedExpandWired || !list) return;
        _feedExpandWired = true;
        list.addEventListener('click', (e) => {
            const item = e.target && e.target.closest && e.target.closest('.review-item');
            if (!item || !list.contains(item)) return;
            item.classList.toggle('expanded');
        });
    }

    let _feedObserver = null;
    let _visibilityListenerWired = false;

    function _setupLazyFeedObserver() {
        const card = _q('reviewsFeedCard');
        if (!card || !('IntersectionObserver' in window)) {
            // Fallback: si no soporta IO, cargar directo (pero sin polling).
            loadFeed();
            return;
        }
        if (_feedObserver) _feedObserver.disconnect();
        _feedObserver = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (e.isIntersecting) {
                    loadFeed();
                    _feedObserver.disconnect();
                    _feedObserver = null;
                    break;
                }
            }
        }, { rootMargin: '200px 0px' }); // pre-carga 200px antes de entrar al viewport
        _feedObserver.observe(card);
    }

    function _wireVisibilityRefreshOnce() {
        if (_visibilityListenerWired) return;
        _visibilityListenerWired = true;
        let _lastFetchAt = 0;
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            // Solo si pasaron al menos 5 min desde la última pegada, refrescamos.
            if (Date.now() - _lastFetchAt < _FEED_CACHE_TTL_MS) return;
            _lastFetchAt = Date.now();
            // Force=true: ignora la cache (que justamente está vencida).
            loadFeed(true);
        });
    }

    function init() {
        _wireFormOnce();
        loadMyReview();
        // Lazy load del feed: solo cuando el card entra al viewport.
        // Pintamos cache en cuanto está disponible para no dejar el bloque vacío.
        const cached = _readFeedCache();
        if (cached) _renderFeed(cached);
        _setupLazyFeedObserver();
        _wireVisibilityRefreshOnce();
        // Limpiamos polling viejo si existía de una sesión previa.
        if (_feedPollId) { clearInterval(_feedPollId); _feedPollId = null; }
    }

    return { init, loadMyReview, loadFeed, submitReview };
})();
