
/**
 * Service Worker para Admin Panel - Sala de Juegos
 * Maneja notificaciones push y caché de la app
 *
 * IMPORTANTE: Incrementar CACHE_VERSION en cada deploy para forzar
 * la invalidación del caché en dispositivos con la app instalada.
 */

// Bump this version with every deploy so the admin PWA always loads fresh code.
const CACHE_VERSION = 'v7';
const CACHE_NAME = 'admin-sala-' + CACHE_VERSION;

// Only pre-cache stable assets (icons rarely change).
const PRECACHE_URLS = [
    '/icons/icon-192x192.png',
    '/icons/icon-512x512.png'
];

// Main admin files that must always be fetched fresh from the network after a
// redeploy so admins never run stale admin.js code.
function isNetworkFirst(url) {
    return (
        url.includes('/adminprivado2026/') ||
        url.includes('admin.js') ||
        url.includes('admin.css') ||
        url.includes('manifest.json')
    );
}

// Verifica si una URL pertenece a Cloudflare u otros dominios de seguridad
// que NUNCA deben pasar por el caché del SW.
function isCloudflareOrSecurityUrl(url) {
    try {
        const parsed = new URL(url);
        return (
            parsed.hostname === 'challenges.cloudflare.com' ||
            parsed.hostname.endsWith('.cloudflare.com') ||
            parsed.pathname.startsWith('/cdn-cgi/')
        );
    } catch (e) {
        return false;
    }
}

// Instalación del Service Worker
self.addEventListener('install', (event) => {
    console.log('[SW-Admin] Instalando Service Worker', CACHE_VERSION);
    
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW-Admin] Pre-cacheando recursos estables');
                return cache.addAll(PRECACHE_URLS);
            })
            .catch((err) => {
                console.log('[SW-Admin] Error al pre-cachear:', err);
            })
    );
    
    self.skipWaiting();
});

// Activación del Service Worker
self.addEventListener('activate', (event) => {
    console.log('[SW-Admin] Service Worker activado', CACHE_VERSION);
    
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[SW-Admin] Eliminando cache antiguo:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    
    self.clients.claim();
});

// Interceptar fetch requests
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') {
        return;
    }

    const url = event.request.url;

    // CLOUDFLARE FIX: nunca interceptar navigation requests.
    // Igual que en firebase-messaging-sw.js: si el SW intercepta una
    // navegación y Cloudflare redirige a challenges.cloudflare.com,
    // el challenge falla porque la respuesta se sirve en el contexto URL
    // incorrecto. Dejando pasar las navegaciones, el challenge se resuelve
    // correctamente y la pantalla de "red incompatible" desaparece.
    if (event.request.mode === 'navigate') {
        console.log('[SW-Admin] Navigation request - pasando al navegador nativo:', url);
        return;
    }

    // Excluir URLs de Cloudflare y seguridad.
    if (isCloudflareOrSecurityUrl(url)) {
        console.log('[SW-Admin] URL de seguridad excluida del caché:', url);
        return;
    }

    if (url.includes('/api/') || 
        url.includes('/socket.io/')) {
        return;
    }

    if (isNetworkFirst(url)) {
        // Network-first: always try network so deploys are immediately visible.
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    if (response && response.status === 200 && response.type === 'basic') {
                        // Only cache same-origin ('basic') responses.
                        // Opaque cross-origin responses are excluded intentionally
                        // to avoid caching errors or security issues.
                        const responseToCache = response.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, responseToCache);
                        });
                    }
                    return response;
                })
                .catch(() => {
                    console.log('[SW-Admin] Red no disponible, buscando en caché:', url);
                    return caches.match(event.request);
                })
        );
    } else {
        // Cache-first for icons and other stable assets.
        event.respondWith(
            caches.match(event.request)
                .then((response) => {
                    if (response) {
                        return response;
                    }
                    return fetch(event.request)
                        .then((networkResponse) => {
                            if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                                return networkResponse;
                            }
                            const responseToCache = networkResponse.clone();
                            caches.open(CACHE_NAME)
                                .then((cache) => {
                                    cache.put(event.request, responseToCache);
                                });
                            return networkResponse;
                        });
                })
                .catch(() => undefined)
        );
    }
});

// NOTA: NO registramos un handler 'push' manual. La app admin usa Firebase
// Cloud Messaging SDK, que registra su propio handler interno para mostrar
// la notificación en background. Tener ambos handlers causaba conflicto
// (a veces se mostraban dos notificaciones, otras ninguna). El SDK basta.

// Manejar click en notificación
self.addEventListener('notificationclick', (event) => {
    console.log('[SW-Admin] Click en notificación:', event);
    
    event.notification.close();
    
    const notificationData = event.notification.data;
    let url = '/adminprivado2026/';
    
    if (notificationData && notificationData.url) {
        url = notificationData.url;
    }
    
    if (event.action === 'close') {
        return;
    }
    
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((clientList) => {
                for (const client of clientList) {
                    if (client.url.includes('/adminprivado2026/') && 'focus' in client) {
                        return client.focus();
                    }
                }
                if (clients.openWindow) {
                    return clients.openWindow(url);
                }
            })
    );
});

// Escuchar mensajes desde la app
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    // NOTA: el handler SHOW_NOTIFICATION fue removido junto con el handler
    // 'push' manual. La app admin no postMessage-ea al SW para mostrar
    // notificaciones; usa el SDK FCM (background) o muestra UI in-app
    // (foreground). Este listener solo gestiona SKIP_WAITING.
});

console.log('[SW-Admin] Service Worker cargado', CACHE_VERSION);

