// ========================================
// NOTIFICATIONS - Push / browser notifications module
// ========================================

window.VIP = window.VIP || {};

VIP.notifications = (function () {

    // ---- Service Worker (no-op; registration handled in index.html) ----

    async function registerUserServiceWorker() {
        // No-op: registration is done in index.html inline script
    }

    // ---- Browser notification permission ----

    function requestNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().then(permission => {
            });
        }
    }

    function showBrowserNotification(title, body, icon = '/favicon.ico') {
        if ('Notification' in window && Notification.permission === 'granted') {
            try {
                const notification = new Notification(title, {
                    body: body,
                    icon: icon,
                    badge: icon,
                    tag: 'new-message',
                    requireInteraction: false,
                    silent: false
                });
                notification.onclick = () => { window.focus(); notification.close(); };
                setTimeout(() => notification.close(), 5000);
            } catch (e) {
            }
        }
    }

    // ---- Audio notification ----

    function initNotificationSound() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) {
                VIP.state.notificationAudioContext = new AudioContext();
            }
        } catch (e) {
        }
    }

    function playNotificationSound() {
        if (!VIP.state.notificationAudioContext) {
            initNotificationSound();
        }
        try {
            if (VIP.state.notificationAudioContext) {
                const oscillator = VIP.state.notificationAudioContext.createOscillator();
                const gainNode   = VIP.state.notificationAudioContext.createGain();

                oscillator.connect(gainNode);
                gainNode.connect(VIP.state.notificationAudioContext.destination);

                oscillator.frequency.value = 600;
                oscillator.type = 'sine';

                gainNode.gain.setValueAtTime(0.3, VIP.state.notificationAudioContext.currentTime);
                gainNode.gain.exponentialRampToValueAtTime(0.01, VIP.state.notificationAudioContext.currentTime + 0.4);

                oscillator.start(VIP.state.notificationAudioContext.currentTime);
                oscillator.stop(VIP.state.notificationAudioContext.currentTime + 0.4);
            }
        } catch (e) {
        }
    }

    // ---- FCM token registration ----
    // This delegates to the unified window.sendFcmTokenAfterLogin defined in
    // index.html (which handles dedup, retry, and rotation). If that hasn't
    // loaded yet, fall back to a simple one-shot attempt.
    async function sendFcmTokenAfterLogin() {
        // window.sendFcmTokenAfterLogin is set by index.html inline script
        // and is the canonical implementation with dedup/retry/rotation.
        if (typeof window.sendFcmTokenAfterLogin === 'function' &&
            window.sendFcmTokenAfterLogin !== sendFcmTokenAfterLogin) {
            return window.sendFcmTokenAfterLogin();
        }

        // Fallback: simple one-shot if inline script hasn't loaded yet
        const fcmToken  = localStorage.getItem('fcmToken');
        const authToken = localStorage.getItem('userToken');


        if (fcmToken && authToken) {
            try {
                const response = await fetch(`${VIP.config.API_URL}/api/notifications/register-token`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + authToken
                    },
                    body: JSON.stringify({ fcmToken: fcmToken })
                });

                const data = await response.json();
                if (data.success) {
                } else {
                }
            } catch (error) {
            }
        }
    }

    return {
        registerUserServiceWorker,
        requestNotificationPermission,
        showBrowserNotification,
        initNotificationSound,
        playNotificationSound,
        sendFcmTokenAfterLogin
    };

})();

// Window alias so index.html inline script can still call registerUserServiceWorker()
window.registerUserServiceWorker = VIP.notifications.registerUserServiceWorker;
// sendFcmTokenAfterLogin may be overridden by index.html inline script (intentional)
window.sendFcmTokenAfterLogin    = VIP.notifications.sendFcmTokenAfterLogin;
