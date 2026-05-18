// ============================================
// FIREBASE CLOUD MESSAGING + CACHE SERVICE WORKER
// SW único para notificaciones push Y caché PWA.
// Versión: 2.3.0
// ============================================
// ROOT CAUSE FIX: antes existían dos SWs (firebase-messaging-sw.js y
// user-sw.js) compitiendo en el mismo scope (/). Eso provocaba que el
// token FCM apuntara a un SW pero las notificaciones llegaran al otro,
// invalidando todos los envíos. Ahora este es el único SW activo.
// ============================================
// PWA WEBAPK FIX: Chrome Android exige que el SW responda (con
// event.respondWith) a la navegación hacia start_url para generar un
// WebAPK real. Si el SW ignora navigation requests (return sin llamar
// respondWith), Chrome no lo considera capaz de controlar start_url y
// sólo ofrece un acceso directo/shortcut en lugar de instalar la app
// como WebAPK. Se usa redirect:'manual' para que las redirecciones de
// Cloudflare Challenge sean seguidas por el navegador de forma nativa
// (opaqueredirect), sin que el SW actúe como proxy cross-origin.
// ============================================

// SDK Firebase self-hosted (mismo origen). Antes se importaba desde gstatic,
// pero en redes flaky ese host puede fallar y romper el SW entero. Sirviendo
// los scripts del propio dominio garantizamos que el SW siempre instale.
// Fallback a gstatic si el archivo local no estuviera disponible.
try {
  importScripts('/lib/firebase/9.1.2/firebase-app-compat.js');
  importScripts('/lib/firebase/9.1.2/firebase-messaging-compat.js');
} catch (localImportErr) {
  console.warn('[FCM-SW] No se pudo importar Firebase SDK local, cayendo a gstatic:', localImportErr && localImportErr.message);
  importScripts('https://www.gstatic.com/firebasejs/9.1.2/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/9.1.2/firebase-messaging-compat.js');
}

// ============================================
// CONFIGURACIÓN DE CACHÉ
// ============================================
const CACHE_VERSION = 'v43';
const CACHE_NAME = 'sala-juegos-fcm-' + CACHE_VERSION;

const PRECACHE_URLS = [
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png'
];

// Determina si un asset (no navegación) debe usar network-first.
// NOTA: Las navigation requests (modo 'navigate') se excluyen antes de
// llegar aquí, por lo que NO es necesario listar '/' ni '/index.html'.
function isNetworkFirst(url) {
  return (
    url.includes('/app.js') ||
    url.includes('/manifest.json')
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

// ============================================
// CONFIGURACIÓN DE FIREBASE
// ============================================
const firebaseConfig = {
  apiKey: "AIzaSyAjZuVIxNY-SrnihkyNVupZ8AhXX6qxAxY",
  authDomain: "saladejuegos-673fa.firebaseapp.com",
  projectId: "saladejuegos-673fa",
  storageBucket: "saladejuegos-673fa.firebasestorage.app",
  messagingSenderId: "553123191180",
  appId: "1:553123191180:web:277eb460ef78dab8525ea9",
  measurementId: "G-3ZJRT0NCTE"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

console.log('[FCM-SW] Firebase Messaging Service Worker v4 iniciado');

// ============================================
// NOTIFICACIONES EN BACKGROUND (FCM SDK)
// ============================================
messaging.onBackgroundMessage(function(payload) {
  console.log('[FCM-SW] Notificación en background:', payload);

  const notif = payload.notification || {};
  const webNotif = (payload.webpush && payload.webpush.notification) || {};

  const title = notif.title || webNotif.title || 'Sala de Juegos';
  const body  = notif.body  || webNotif.body  || 'Tienes un mensaje del soporte';
  const icon  = notif.icon  || webNotif.icon  || '/icons/icon-192x192.png';
  const badge = notif.badge || webNotif.badge || '/icons/icon-72x72.png';
  const tag   = (payload.data && payload.data.tag) || 'chat-message';

  // Confirmación de entrega: si el envío vino con batchId+userId, avisar al
  // backend que el push llegó realmente (cubre el falso "enviado" cuando
  // FCM acepta el mensaje pero la subscription estaba muerta).
  const _data = payload.data || {};
  if (_data.batchId && _data.userId) {
    fetch('/api/notifications/confirm-delivery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: _data.batchId, userId: _data.userId }),
      keepalive: true
    }).catch(function (err) {
      console.warn('[FCM-SW] confirm-delivery falló:', err && err.message);
    });
  }

  const options = {
    body,
    icon,
    badge,
    tag,
    requireInteraction: false,
    data: _data,
    actions: [
      { action: 'open',  title: 'Abrir chat' },
      { action: 'close', title: 'Cerrar'     }
    ],
    vibrate: [200, 100, 200]
  };

  return self.registration.showNotification(title, options);
});

// ============================================
// CLICK EN NOTIFICACIÓN
// ============================================
self.addEventListener('notificationclick', function(event) {
  console.log('[FCM-SW] Click en notificación:', event.action);

  event.notification.close();

  if (event.action === 'close') return;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(clientList) {
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow('/');
        }
      })
  );
});

// ============================================
// INSTALACIÓN
// ============================================
self.addEventListener('install', function(event) {
  console.log('[FCM-SW] Instalando', CACHE_VERSION);

  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        return cache.addAll(PRECACHE_URLS);
      })
      .catch(function(err) {
        console.log('[FCM-SW] Error al pre-cachear:', err);
      })
  );

  self.skipWaiting();
});

// ============================================
// ACTIVACIÓN
// ============================================
self.addEventListener('activate', function(event) {
  console.log('[FCM-SW] Activado', CACHE_VERSION);

  // IMPORTANT: clients.claim() must be inside event.waitUntil so that
  // navigator.serviceWorker.ready only resolves AFTER the SW is actually
  // controlling the page. If claim() is called outside waitUntil, the
  // ready promise may resolve before navigator.serviceWorker.controller
  // is set, causing getToken() to fail in standalone/PWA mode because
  // FCM internally checks the controller state.
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.map(function(name) {
          if (name !== CACHE_NAME) {
            console.log('[FCM-SW] Eliminando caché antiguo:', name);
            return caches.delete(name);
          }
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ============================================
// FETCH (ESTRATEGIA DE CACHÉ)
// ============================================
self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;

  const url = event.request.url;

  // PWA WEBAPK FIX: responder a navigation requests con fetch de red
  // (sin caché). Esto es imprescindible para que Chrome Android verifique
  // que el SW controla start_url y genere un WebAPK real en lugar de un
  // acceso directo. redirect:'manual' devuelve opaqueredirect para
  // redirecciones cross-origin (p. ej. Cloudflare Challenge), que Chrome
  // sigue de forma nativa sin que el SW actúe como proxy.
  if (event.request.mode === 'navigate') {
    console.log('[FCM-SW] Navigation request - respondiendo con red (sin caché):', url);
    event.respondWith(
      fetch(event.request, { redirect: 'manual' })
        .catch(function() {
          console.log('[FCM-SW] Red no disponible para navegación:', url);
          return new Response('Sin conexión - por favor verificá tu internet.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        })
    );
    return;
  }

  // Excluir URLs de Cloudflare, cdn-cgi y cualquier dominio de seguridad.
  if (isCloudflareOrSecurityUrl(url)) {
    console.log('[FCM-SW] URL de seguridad excluida del caché:', url);
    return;
  }

  // Excluir API y sockets: siempre van a red.
  if (url.includes('/api/') || url.includes('/socket.io/')) return;

  if (isNetworkFirst(url)) {
    // Network-first: siempre intenta red para que los deploys sean inmediatos.
    console.log('[FCM-SW] Network-first para:', url);
    event.respondWith(
      fetch(event.request)
        .then(function(response) {
          if (response && response.status === 200 && response.type === 'basic') {
            var toCache = response.clone();
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(event.request, toCache);
            });
          }
          return response;
        })
        .catch(function() {
          console.log('[FCM-SW] Red no disponible, buscando en caché:', url);
          return caches.match(event.request);
        })
    );
  } else {
    // Cache-first para assets estáticos estables (iconos, fuentes, etc.)
    event.respondWith(
      caches.match(event.request)
        .then(function(cached) {
          if (cached) {
            console.log('[FCM-SW] Cache hit para:', url);
            return cached;
          }
          console.log('[FCM-SW] Cache miss - red para:', url);
          return fetch(event.request).then(function(response) {
            if (response && response.status === 200 && response.type === 'basic') {
              var toCache = response.clone();
              caches.open(CACHE_NAME).then(function(cache) {
                cache.put(event.request, toCache);
              });
            }
            return response;
          });
        })
        .catch(function() {
          return undefined;
        })
    );
  }
});

// ============================================
// MENSAJES DESDE LA APP
// ============================================
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
