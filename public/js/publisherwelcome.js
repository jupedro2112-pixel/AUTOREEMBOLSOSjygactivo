// =====================================================================
// PUBLISHER WELCOME — bienvenida en 2 pasos para visitantes que entran
// por un link de publicista.
//
// Cuándo se muestra:
//   - El visitante llegó por una vanity URL (/CODE o /publisher-slug) o por
//     ?p=CODE, y el server inyectó window.__VIP_CAMPAIGN_CODE__ o el JS de
//     campaign.js lo derivó.
//   - localStorage no tiene la flag de "ya lo vi en este dispositivo".
//
// Se muestra PRE-AUTH (apenas carga la página, antes de login/register).
// Una vez aceptado, se guarda en localStorage para no volver a aparecer en
// este dispositivo.
//
// Flujo:
//   Paso 1 (bienvenida con nombre del publicista) → [Siguiente]
//   Paso 2 (beneficios + checkbox obligatorio) → [Iniciar sesión]
//   Cierra el modal y el usuario sigue con su flujo normal (registro / login).
// =====================================================================
window.VIP = window.VIP || {};

VIP.publisherWelcome = (function () {

    const LS_FLAG = 'vip_publisherWelcomeSeen';
    const PLACEHOLDER_MARK = 'PLACEHOLDER';

    // Detecta el código de campaña presente en el dispositivo, en este orden:
    //   1. window.__VIP_CAMPAIGN_CODE__ (server-injected al servir el HTML)
    //   2. VIP.campaign.getActive() (campaign.js que ya lee URL + localStorage)
    // Devuelve string o null.
    function _detectCampaignCode() {
        try {
            const injected = window.__VIP_CAMPAIGN_CODE__;
            if (injected && typeof injected === 'string' && injected.indexOf(PLACEHOLDER_MARK) === -1) {
                return String(injected).toUpperCase().trim();
            }
        } catch (e) {}
        try {
            if (VIP.campaign && typeof VIP.campaign.getActive === 'function') {
                const att = VIP.campaign.getActive();
                if (att && att.code) return String(att.code).toUpperCase().trim();
            }
        } catch (e) {}
        return null;
    }

    function _alreadySeen() {
        try { return localStorage.getItem(LS_FLAG) === '1'; } catch (e) { return false; }
    }

    // Detecta si el visitante llegó por un link de referido (?ref=CODE en URL).
    // Si es así, el referido tiene PRIORIDAD sobre cualquier atribución de
    // publicista persistida en localStorage/cookie: el welcome no se muestra
    // y el login NO se customiza (registerBtn queda visible para que el
    // referido se pueda registrar).
    function _isReferralVisit() {
        try {
            const qs = window.location.search || '';
            return /[?&]ref=[^&]+/i.test(qs);
        } catch (e) {
            return false;
        }
    }

    function _markSeen() {
        try { localStorage.setItem(LS_FLAG, '1'); } catch (e) {}
    }

    function _open() {
        const modal = document.getElementById('publisherWelcomeModal');
        if (!modal) return;
        const s1 = document.getElementById('publisherWelcomeStep1');
        const s2 = document.getElementById('publisherWelcomeStep2');
        if (s1) s1.style.display = '';
        if (s2) s2.style.display = 'none';
        const chk = document.getElementById('publisherWelcomeAcceptCheck');
        const finishBtn = document.getElementById('publisherWelcomeFinishBtn');
        if (chk) chk.checked = false;
        if (finishBtn) {
            finishBtn.disabled = true;
            finishBtn.style.opacity = '0.5';
        }
        VIP.ui.showModal('publisherWelcomeModal');
    }

    function _goToStep2() {
        document.getElementById('publisherWelcomeStep1').style.display = 'none';
        document.getElementById('publisherWelcomeStep2').style.display = '';
    }

    function _goToStep1() {
        document.getElementById('publisherWelcomeStep1').style.display = '';
        document.getElementById('publisherWelcomeStep2').style.display = 'none';
    }

    function _onCheckChange() {
        const chk = document.getElementById('publisherWelcomeAcceptCheck');
        const btn = document.getElementById('publisherWelcomeFinishBtn');
        if (!chk || !btn) return;
        const ok = chk.checked === true;
        btn.disabled = !ok;
        btn.style.opacity = ok ? '1' : '0.5';
    }

    function _finish() {
        const chk = document.getElementById('publisherWelcomeAcceptCheck');
        if (!chk || !chk.checked) return;
        _markSeen();
        VIP.ui.hideModal('publisherWelcomeModal');
    }

    // Trigger principal. Se llama desde app.js al cargar la página, ANTES de
    // que el usuario se loguee/registre. Si corresponde, muestra el modal.
    // El modal es genérico — no muestra el nombre del publicista para no
    // exponer la atribución comercial al usuario final.
    function maybeShow() {
        // Si la URL trae ?ref=CODE, el visitante viene por referido — no le
        // mostramos el welcome del publicista aunque tenga atribución vieja
        // persistida. Ese visitante tiene que poder ver el flujo de registro
        // con código de referido normalmente.
        if (_isReferralVisit()) return;
        if (_alreadySeen()) return;
        const code = _detectCampaignCode();
        if (!code) return; // no vino por un link de publicista — no mostrar
        _open();
    }

    // Texto llamativo del botón de login cuando el visitante viene de publicista.
    // auth.js lo respeta en todos los puntos donde reescribe el textContent del
    // botón (estado idle / estado "Ingresando..." vuelve a este texto).
    const PUBLISHER_LOGIN_BTN_TEXT = '⚡ Entrá YA y enviá tu comprobante de carga';

    // Aplica las customizaciones del login screen para visitantes de publicista:
    //   - reemplaza el texto del botón submit y lo estiliza llamativamente
    //   - oculta el bloque "¿No tenés cuenta? / Registrarse"
    //   - setea window._isPublisherLink para que auth.js muestre el mensaje
    //     "completá los datos que te dieron por WhatsApp" cuando falten campos.
    // Idempotente: si se llama varias veces no duplica nada.
    function applyLoginCustomizations() {
        // Referido tiene prioridad: si vino por ?ref=CODE no le aplicamos nada,
        // sino se le ocultaría el botón Registrarse y no podría crear cuenta.
        if (_isReferralVisit()) return;
        const code = _detectCampaignCode();
        if (!code) return;

        window._isPublisherLink = true;
        // Exponer el texto para que auth.js lo use al restaurar el botón post-click.
        window._publisherLoginBtnText = PUBLISHER_LOGIN_BTN_TEXT;

        const loginBtn = document.querySelector('#loginForm button[type="submit"]');
        if (loginBtn) {
            loginBtn.textContent = PUBLISHER_LOGIN_BTN_TEXT;
            loginBtn.classList.add('publisher-cta');
        }

        // Ocultar el bloque "¿No tienes cuenta? — Registrarse". Este público ya
        // recibió usuario+contraseña por WhatsApp, no debería registrarse.
        const registerBtn = document.getElementById('registerBtn');
        if (registerBtn && registerBtn.parentElement) {
            registerBtn.parentElement.style.display = 'none';
        }
    }

    // Bind events. Se llama una sola vez desde app.js.
    function init() {
        const nextBtn = document.getElementById('publisherWelcomeNextBtn');
        const backBtn = document.getElementById('publisherWelcomeBackBtn');
        const finishBtn = document.getElementById('publisherWelcomeFinishBtn');
        const chk = document.getElementById('publisherWelcomeAcceptCheck');
        if (nextBtn) nextBtn.addEventListener('click', _goToStep2);
        if (backBtn) backBtn.addEventListener('click', _goToStep1);
        if (finishBtn) finishBtn.addEventListener('click', _finish);
        if (chk) chk.addEventListener('change', _onCheckChange);
    }

    return {
        init: init,
        maybeShow: maybeShow,
        applyLoginCustomizations: applyLoginCustomizations
    };
})();
