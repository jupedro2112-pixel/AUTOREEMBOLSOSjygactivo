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

    function saveAttribution(attribution) {
        const record = {
            code: attribution.code,
            utm: attribution.utm || {},
            capturedAt: Date.now(),
            expiresAt: Date.now() + ATTRIBUTION_TTL_MS
        };
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(record)); } catch (e) { /* private mode */ }
        return record;
    }

    // Devuelve la atribución activa (no expirada) o null.
    function getActive() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            const record = JSON.parse(raw);
            if (!record || !record.code) return null;
            if (record.expiresAt && record.expiresAt < Date.now()) {
                localStorage.removeItem(STORAGE_KEY);
                return null;
            }
            return record;
        } catch (e) {
            return null;
        }
    }

    function clearAttribution() {
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    }

    // Extrae el código y los UTM de la URL actual. Acepta tanto `?p=` como
    // `?campaign=` por compatibilidad con sistemas que ya usen ese nombre.
    function readFromUrl() {
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

    // Limpia los query params relacionados con campaña/utm de la URL visible.
    // Usa history.replaceState para no recargar y no afectar al routing del SPA.
    function cleanUrl() {
        try {
            const url = new URL(window.location.href);
            ['p', 'campaign', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']
                .forEach(k => url.searchParams.delete(k));
            const newQs = url.searchParams.toString();
            const newPath = url.pathname + (newQs ? '?' + newQs : '') + url.hash;
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

    // Ejecutado al cargar la página: detecta el código en la URL (si lo hay),
    // guarda atribución, dispara track-click y limpia la URL.
    function bootstrap() {
        const fromUrl = readFromUrl();
        if (fromUrl) {
            saveAttribution(fromUrl);
            trackClick(fromUrl);
            cleanUrl();
        }
    }

    return {
        bootstrap,
        getActive,
        getVisitorId,
        clearAttribution,
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
