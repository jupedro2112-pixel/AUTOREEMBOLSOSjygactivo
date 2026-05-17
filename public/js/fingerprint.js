// VIP.fingerprint — huella estable del dispositivo del navegador.
// Se usa para anti-fraude del welcome bonus ($5.000): si dos cuentas
// distintas reclaman desde el mismo dispositivo (mismo celular, aunque
// hayan borrado caché y creado cuenta nueva en JUGAYGANA), el server lo
// detecta cruzando la huella contra los claims previos y marca la
// cuenta como fraudBlocked.
//
// Señales: userAgent + idioma + zona horaria + dimensiones de pantalla +
// hardware concurrency + canvas hash + WebGL renderer.
// Hash final: SHA-256 (hex). Es razonablemente estable salvo factory
// reset, cambio de OS major, o spoofing intencional.
(function () {
    'use strict';
    window.VIP = window.VIP || {};
    if (window.VIP.fingerprint) return; // ya inicializado

    let _cache = null; // hash cacheado para esta sesión — evita recalcular

    // Hash SHA-256 → hex string. Usa SubtleCrypto (soportado en todos los
    // navegadores modernos sobre HTTPS). Sin fallback: si falla, devolvemos
    // null y el server no aplica el chequeo.
    async function _sha256Hex(s) {
        if (!window.crypto || !window.crypto.subtle || !TextEncoder) return null;
        const buf = new TextEncoder().encode(String(s));
        const hashBuf = await window.crypto.subtle.digest('SHA-256', buf);
        const bytes = new Uint8Array(hashBuf);
        let hex = '';
        for (let i = 0; i < bytes.length; i++) {
            hex += bytes[i].toString(16).padStart(2, '0');
        }
        return hex;
    }

    // Canvas hash: dibuja texto + formas con curvas y devuelve un hash de
    // los pixeles. Es uno de los signals más usados — la representación
    // varía por GPU + drivers + OS, así que cambia entre dispositivos pero
    // es estable en el mismo.
    function _canvasHash() {
        try {
            const cv = document.createElement('canvas');
            cv.width = 220;
            cv.height = 60;
            const ctx = cv.getContext('2d');
            if (!ctx) return '';
            ctx.textBaseline = 'top';
            ctx.font = '14px Arial';
            ctx.fillStyle = '#f60';
            ctx.fillRect(125, 1, 62, 20);
            ctx.fillStyle = '#069';
            ctx.fillText('PRUEBA-FP-2026', 2, 15);
            ctx.fillStyle = 'rgba(102,204,0,0.75)';
            ctx.fillText('PRUEBA-FP-2026', 4, 17);
            ctx.beginPath();
            ctx.arc(50, 30, 12, 0, Math.PI * 2, true);
            ctx.closePath();
            ctx.fill();
            return cv.toDataURL();
        } catch (_) { return ''; }
    }

    // WebGL renderer (GPU + driver) — otro signal estable por hardware.
    function _webglInfo() {
        try {
            const cv = document.createElement('canvas');
            const gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
            if (!gl) return '';
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            if (!ext) return '';
            const vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || '';
            const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '';
            return vendor + '|' + renderer;
        } catch (_) { return ''; }
    }

    // Devuelve el hash SHA-256 (hex) del dispositivo. Cacheado por sesión.
    // Si el navegador no soporta SubtleCrypto, devuelve null.
    async function getFingerprint() {
        if (_cache) return _cache;
        try {
            const parts = [
                navigator.userAgent || '',
                navigator.language || '',
                (navigator.languages && navigator.languages.join(',')) || '',
                navigator.platform || '',
                String(navigator.hardwareConcurrency || 0),
                String(navigator.maxTouchPoints || 0),
                String((screen && screen.width) || 0) + 'x' + String((screen && screen.height) || 0),
                String((screen && screen.colorDepth) || 0),
                String((window.devicePixelRatio) || 1),
                (Intl && Intl.DateTimeFormat && Intl.DateTimeFormat().resolvedOptions().timeZone) || '',
                _webglInfo(),
                _canvasHash()
            ];
            const raw = parts.join('|');
            const hash = await _sha256Hex(raw);
            if (hash) _cache = hash;
            return hash;
        } catch (e) {
            return null;
        }
    }

    window.VIP.fingerprint = {
        get: getFingerprint
    };
})();
