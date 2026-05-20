// ========================================
// CAMPAIGN — Detección y atribución de links de pauta
// ----------------------------------------
// Cuando un visitante llega con `?p=CODE` (y opcionalmente parámetros UTM):
//   1. Captura el código y los UTM de la URL.
//   2. Guarda la atribución en localStorage con expiración de 60 días.
//   3. Genera un visitorId estable (UUID en localStorage, dura indefinido).
//   4. Reporta el clic a POST /api/campaigns/track-click.
//   5. Limpia los query params de la URL visible (sin recargar) para que el
//      usuario no comparta el link con su atribución.
//
// El registro rápido (sin SMS) sólo está habilitado cuando hay una atribución
// activa — el código sirve también como prueba de que el visitante vino de
// un canal autorizado.
// ========================================

window.VIP = window.VIP || {};

VIP.campaign = (function () {
    const STORAGE_KEY = 'vipCampaignAttribution';
    const VISITOR_KEY = 'vipVisitorId';
    const ATTRIBUTION_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 días

    // Copia en memoria de la atribución capturada en esta sesión. Es el
    // respaldo cuando localStorage está bloqueado (modo privado/incógnito):
    // garantiza que un visitante que llegó por un link de pauta NUNCA caiga
    // al flujo de registro con SMS por no poder leer/escribir localStorage.
    let _memAttribution = null;

    function uuid() {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
        const buf = new Uint8Array(16);
        (window.crypto || window.msCrypto).getRandomValues(buf);
        buf[6] = (buf[6] & 0x0f) | 0x40;
        buf[8] = (buf[8] & 0x3f) | 0x80;
        const hex = Array.from(buf).map((b) => b.toString(16).padStart(2, '0'));
        return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
    }

    function getVisitorId() {
        let id = localStorage.getItem(VISITOR_KEY);
        if (!id) {
            id = uuid();
            try { localStorage.setItem(VISITOR_KEY, id); } catch (e) { /* private mode */ }
        }
        return id;
    }

    // ── Meta Ads: identificadores de clic (_fbc) y navegador (_fbp) ─────────
    // El _fbc ata una conversión al clic en el anuncio. El Pixel lo crea solo
    // cuando hay ?fbclid= en la URL, pero puede no alcanzar a hacerlo (timing
    // de fbevents.js, bloqueadores). Acá lo aseguramos: si la cookie _fbc no
    // existe y hay un fbclid en la URL, la construimos con el formato oficial
    // `fb.1.<timestamp_ms>.<fbclid>` y la seteamos — así también el Pixel del
    // navegador la reusa. Persistimos ambos valores en localStorage para que
    // sobrevivan al limpiado de la URL y al flujo de registro.
    const FBC_KEY = 'vipFbc';
    const FBP_KEY = 'vipFbp';
    const LANDING_URL_KEY = 'vipLandingUrl';

    function readCookie(name) {
        const escaped = name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1');
        const m = document.cookie.match('(?:^|; )' + escaped + '=([^;]*)');
        return m ? decodeURIComponent(m[1]) : null;
    }

    function setCookie(name, value, maxAgeSeconds) {
        try {
            document.cookie = name + '=' + encodeURIComponent(value) +
                '; path=/; max-age=' + maxAgeSeconds + '; SameSite=Lax';
        } catch (e) { /* ignore */ }
    }

    function lsGet(key) {
        try { return localStorage.getItem(key); } catch (e) { return null; }
    }
    function lsSet(key, value) {
        try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
    }

    // Captura _fbc / _fbp al cargar la página. Debe correr ANTES de cleanUrl().
    function captureFbCookies() {
        // _fbp: lo crea el Pixel; sólo lo replicamos a localStorage si existe.
        const fbpCookie = readCookie('_fbp');
        if (fbpCookie) lsSet(FBP_KEY, fbpCookie);

        // _fbc: usar la cookie si ya existe; si no, construirla desde ?fbclid=.
        let fbc = readCookie('_fbc');
        if (!fbc) {
            try {
                const fbclid = new URLSearchParams(window.location.search).get('fbclid');
                if (fbclid) {
                    fbc = 'fb.1.' + Date.now() + '.' + fbclid;
                    // 1 año (brief de atribución fb-ads): la cookie sobrevive
                    // visitas largas; Meta usa hasta 90 días para reportar.
                    setCookie('_fbc', fbc, 365 * 24 * 60 * 60);
                }
            } catch (e) { /* ignore */ }
        }
        if (fbc) lsSet(FBC_KEY, fbc);
    }

    // Getter: cookie viva primero, localStorage como fallback (sobrevive al
    // limpiado de la URL y a navegaciones dentro de la sesión).
    function getFbc() {
        return readCookie('_fbc') || lsGet(FBC_KEY) || null;
    }
    function getFbp() {
        return readCookie('_fbp') || lsGet(FBP_KEY) || null;
    }

    // ── Landing URL ─────────────────────────────────────────────────────────
    // URL completa con la que el usuario aterrizó, con TODA la query string
    // original (fbclid, utm_*, p=). El sistema fb-ads la parsea para atribuir
    // la conversión al anuncio específico. Persistimos en localStorage sólo
    // si la visita trae alguna señal de atribución; así no guardamos cualquier
    // URL random ajena a una pauta.
    let _landingUrl = null;

    function captureLandingUrl() {
        try {
            const stored = lsGet(LANDING_URL_KEY);
            if (stored) { _landingUrl = stored; return; }
        } catch (e) { /* private mode */ }

        const qs = window.location.search || '';
        const hasFbclid = qs.indexOf('fbclid=') !== -1;
        const hasPautaParam = qs.indexOf('p=') !== -1 || qs.indexOf('campaign=') !== -1;
        const fromVanity = window.__VIP_CAMPAIGN_CODE__
            && typeof window.__VIP_CAMPAIGN_CODE__ === 'string'
            && window.__VIP_CAMPAIGN_CODE__.indexOf('PLACEHOLDER') === -1;
        if (hasFbclid || hasPautaParam || fromVanity) {
            _landingUrl = window.location.href;
            lsSet(LANDING_URL_KEY, _landingUrl);
        }
    }

    function getLandingUrl() {
        return _landingUrl || null;
    }

    function saveAttribution(attribution) {
        const record = {
            code: attribution.code,
            utm: attribution.utm || {},
            capturedAt: Date.now(),
            expiresAt: Date.now() + ATTRIBUTION_TTL_MS
        };
        // Copia en memoria SIEMPRE — sobrevive aunque localStorage falle.
        _memAttribution = record;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(record)); } catch (e) { /* private mode */ }
        return record;
    }

    // Devuelve la atribución activa (no expirada) o null.
    // Resuelve en 3 capas para que un visitante de pauta NUNCA caiga al flujo
    // de registro con SMS por un fallo de almacenamiento:
    //   1) localStorage (persistente entre cargas).
    //   2) copia en memoria (cubre modo privado / localStorage bloqueado).
    //   3) re-derivar de la URL / del código de campaña inyectado por el server.
    function getActive() {
        // Capa 1 — localStorage.
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const record = JSON.parse(raw);
                if (record && record.code) {
                    if (record.expiresAt && record.expiresAt < Date.now()) {
                        try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
                    } else {
                        return record;
                    }
                }
            }
        } catch (e) { /* localStorage no disponible (modo privado) */ }

        // Capa 2 — copia en memoria de esta sesión.
        if (_memAttribution && (!_memAttribution.expiresAt || _memAttribution.expiresAt >= Date.now())) {
            return _memAttribution;
        }

        // Capa 3 — re-derivar de la URL / window.__VIP_CAMPAIGN_CODE__.
        const fromUrl = readFromUrl();
        if (fromUrl && fromUrl.code) {
            return {
                code: fromUrl.code,
                utm: fromUrl.utm || {},
                capturedAt: Date.now(),
                expiresAt: Date.now() + ATTRIBUTION_TTL_MS
            };
        }
        return null;
    }

    function clearAttribution() {
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    }

    // Extrae el código de la URL actual. Prioridades:
    //   1. window.__VIP_CAMPAIGN_CODE__: inyectado por el server cuando el
    //      visitante entra por una vanity URL tipo /CODIGO (formato moderno).
    //   2. ?p=CODE o ?campaign=CODE: formato legacy compatible con links
    //      antiguos que ya estén en circulación.
    function readFromUrl() {
        // Modo 1: vanity URL (path), inyectado server-side.
        const fromServer = window.__VIP_CAMPAIGN_CODE__;
        if (fromServer && typeof fromServer === 'string' && fromServer.indexOf('PLACEHOLDER') === -1) {
            const code = String(fromServer).toUpperCase().trim();
            if (/^[A-Z0-9_-]{3,40}$/.test(code)) {
                // En el modo vanity no hay UTMs en la URL — el publicista los
                // puede agregar igual con ?utm_source=... si querés (los leemos abajo).
                const params = new URLSearchParams(window.location.search);
                return {
                    code,
                    utm: {
                        source: params.get('utm_source') || null,
                        medium: params.get('utm_medium') || null,
                        campaign: params.get('utm_campaign') || null,
                        content: params.get('utm_content') || null,
                        term: params.get('utm_term') || null
                    }
                };
            }
        }
        // Modo 2: legacy query param.
        const params = new URLSearchParams(window.location.search);
        const rawCode = params.get('p') || params.get('campaign');
        if (!rawCode) return null;
        const code = String(rawCode).toUpperCase().trim();
        if (!/^[A-Z0-9_-]{3,40}$/.test(code)) return null;
        return {
            code,
            utm: {
                source: params.get('utm_source') || null,
                medium: params.get('utm_medium') || null,
                campaign: params.get('utm_campaign') || null,
                content: params.get('utm_content') || null,
                term: params.get('utm_term') || null
            }
        };
    }

    // Limpia los query params relacionados con campaña/utm de la URL visible
    // y, si el path era una vanity URL (/CODIGO), lo reemplaza por /.
    // Usa history.replaceState para no recargar y no afectar al routing del SPA.
    function cleanUrl() {
        try {
            const url = new URL(window.location.href);
            ['p', 'campaign', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']
                .forEach(k => url.searchParams.delete(k));
            // Si el path es una vanity URL (no es la home), normalizar a '/'.
            // Detectamos vanity por el hecho de que window.__VIP_CAMPAIGN_CODE__
            // viene seteado y el path coincide en mayúsculas con ese código.
            const injected = window.__VIP_CAMPAIGN_CODE__;
            let newPathname = url.pathname;
            if (injected && typeof injected === 'string' && injected.indexOf('PLACEHOLDER') === -1) {
                const pathSegment = url.pathname.replace(/^\//, '').toUpperCase();
                if (pathSegment === injected.toUpperCase()) {
                    newPathname = '/';
                }
            }
            const newQs = url.searchParams.toString();
            const newPath = newPathname + (newQs ? '?' + newQs : '') + url.hash;
            window.history.replaceState({}, '', newPath);
        } catch (e) { /* ignore */ }
    }

    async function trackClick(attribution) {
        try {
            await fetch(`${VIP.config.API_URL}/api/campaigns/track-click`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    code: attribution.code,
                    visitorId: getVisitorId(),
                    utm: attribution.utm || {}
                }),
                keepalive: true
            });
        } catch (e) {
            // No es crítico — la atribución ya quedó en localStorage.
            console.warn('[campaign] track-click falló:', e && e.message);
        }
    }

    // True sólo en la carga en la que se capturó el código directamente
    // desde la URL (no se persiste entre páginas/reloads). Sirve para que
    // app.js decida si abrir el modal de registro automáticamente al
    // visitante que viene de un anuncio.
    let _wasFreshlyCaptured = false;

    // Ejecutado al cargar la página: detecta el código en la URL (si lo hay),
    // guarda atribución, dispara track-click y limpia la URL.
    function bootstrap() {
        // Capturar fbc/fbp + landingUrl ANTES de readFromUrl/cleanUrl para no
        // perder el fbclid ni los UTMs originales de la query string.
        captureFbCookies();
        captureLandingUrl();
        const fromUrl = readFromUrl();
        if (fromUrl) {
            saveAttribution(fromUrl);
            trackClick(fromUrl);
            cleanUrl();
            _wasFreshlyCaptured = true;
        }
    }

    function wasFreshlyCaptured() {
        return _wasFreshlyCaptured;
    }

    return {
        bootstrap,
        getActive,
        getVisitorId,
        getFbc,
        getFbp,
        getLandingUrl,
        clearAttribution,
        wasFreshlyCaptured,
        // Útil para Meta Pixel custom_data:
        getActiveCustomData: function () {
            const a = getActive();
            if (!a) return {};
            return {
                campaign_code: a.code,
                utm_source: a.utm?.source || null,
                utm_campaign: a.utm?.campaign || null,
                utm_medium: a.utm?.medium || null
            };
        }
    };
})();

// Auto-bootstrap: ejecutar tan pronto como posible para capturar atribución
// antes de cualquier otra interacción.
VIP.campaign.bootstrap();
