// ========================================
// META PIXEL — Browser-side tracker
// ----------------------------------------
// Wrapper sobre fbq que:
//   1. No hace nada si window.__META_PIXEL_ID__ está vacío (entornos dev / sin pixel).
//   2. Genera event_id (UUID) por evento para deduplicar con CAPI server-side.
//   3. Expone newEventId() para que otros módulos compartan el mismo ID con el
//      server (lo envían en el body como `metaEventId` y el server lo reusa al
//      llamar a Conversions API → Meta deduplica por event_id).
//
// El snippet oficial de Meta se carga inline en index.html para que fbq exista
// antes de que se carguen los módulos. Este archivo sólo agrega la capa VIP.
// ========================================

window.VIP = window.VIP || {};

VIP.pixel = (function () {
    const PIXEL_ID = window.__META_PIXEL_ID__ || '';
    const ENABLED = Boolean(PIXEL_ID && typeof window.fbq === 'function');

    function newEventId() {
        // crypto.randomUUID() disponible en navegadores modernos (HTTPS / localhost).
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }
        // Fallback: UUID v4 manual con getRandomValues
        const buf = new Uint8Array(16);
        (window.crypto || window.msCrypto).getRandomValues(buf);
        buf[6] = (buf[6] & 0x0f) | 0x40;
        buf[8] = (buf[8] & 0x3f) | 0x80;
        const hex = Array.from(buf).map((b) => b.toString(16).padStart(2, '0'));
        return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
    }

    // Eventos estándar definidos por Meta (case-sensitive). Cualquier otro nombre
    // se enviará vía trackCustom.
    const STANDARD_EVENTS = new Set([
        'PageView', 'ViewContent', 'Search', 'AddToCart', 'AddToWishlist',
        'InitiateCheckout', 'AddPaymentInfo', 'Purchase', 'Lead',
        'CompleteRegistration', 'Contact', 'CustomizeProduct', 'Donate',
        'FindLocation', 'Schedule', 'StartTrial', 'SubmitApplication', 'Subscribe'
    ]);

    function track(eventName, params, options) {
        if (!ENABLED) return null;
        try {
            const opts = options || {};
            const eventId = opts.eventId || newEventId();
            const fbqOptions = { eventID: eventId };
            const payload = params || {};

            if (STANDARD_EVENTS.has(eventName)) {
                window.fbq('track', eventName, payload, fbqOptions);
            } else {
                window.fbq('trackCustom', eventName, payload, fbqOptions);
            }
            return eventId;
        } catch (err) {
            console.warn('[MetaPixel] track failed:', err && err.message);
            return null;
        }
    }

    // Reporta un evento usando un event_id previamente generado (para mantener
    // coherencia con la llamada server-side que ya disparó CAPI con ese mismo ID).
    function trackWithId(eventId, eventName, params) {
        return track(eventName, params, { eventId });
    }

    function pageView() {
        return track('PageView');
    }

    return {
        enabled: ENABLED,
        pixelId: PIXEL_ID,
        newEventId,
        track,
        trackWithId,
        pageView
    };
})();
