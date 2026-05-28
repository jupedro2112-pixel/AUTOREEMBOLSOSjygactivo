# CLAUDE.md — Contexto del proyecto VIPCARGASANTINO

> ⚠️ **LEER PRIMERO (continuidad entre sesiones).** El owner trabaja en **Tails sin
> almacenamiento persistente**: al reiniciar la PC se borra TODO lo local y vuelve a
> clonar este repo desde GitHub. Por eso el contexto vive ACÁ (en el repo), no en la
> memoria local del asistente.
>
> **REGLA PERMANENTE:** Mantené y ACTUALIZÁ `WORKLOG.md` (en la raíz del repo) tras
> cada cambio significativo (feature, fix importante, decisión de diseño). Commiteá
> y pusheá a GitHub para que la próxima sesión pueda seguir donde se dejó. Esta regla
> aplica siempre, sin que el owner tenga que pedirlo cada vez.
>
> Al iniciar una sesión nueva: leé `WORKLOG.md` (estado actual) y, antes de modificar
> un flujo central, leé `docs/ARCHITECTURE.md` (mapa de modelos, flujos y trampas) +
> el código puntual del área. El código es la verdad; los docs son el mapa.

---

## Qué es

Backend de una **sala de juegos** (mercado argentino) que opera como wrapper sobre la
plataforma externa **JUGAYGANA** (`admin.agentesadmin.bet`). Capta usuarios, los crea
en JUGAYGANA por API, gestiona cargas/retiros vía CBU, reembolsos, ruleta, fueguito,
referidos y campañas/publicistas. UX en PWA con notificaciones push (FCM).

**Stack:** Node 20 · Express · MongoDB (Atlas) · Mongoose · Socket.IO (+ Redis adapter
para multi-instancia en AWS EB) · Firebase Admin (FCM) · AWS SNS (SMS OTP).
Deploy: AWS Elastic Beanstalk. Dominio público: vipcargas.com. Git user: jupedro2112-pixel.

## Estructura

- `server.js` (~11k líneas) — entry point. ~180 rutas, authMiddleware inline (~L1028),
  Socket.IO (~L5600), bootstrap async con SSM (final del archivo). Comentario dice
  "en migración" pero en la práctica sigue creciendo acá.
- `config/database.js` — el `connectDB` que server.js realmente usa (TTL de mensajes,
  proxy a /src/models). **OJO: hay DOS connectDB** (este y `src/models/index.js`); el
  segundo NO se usa desde server.js. No tocar schemas en config/database.js (sólo
  define ExternalUser y UserActivity; el resto es proxy a /src/models).
- `jugaygana.js` — cliente principal a JUGAYGANA (sesión auto-renovable, proxy opcional).
- `jugaygana-movements.js` — endpoint alterno (deposit/withdraw/balance).
- `src/services/jugayganaService.js` — cliente refactorizado (lo usa referidos).
- `src/services/jugayganaPublisherSessions.js` — pool de sesiones por publicista.
- `src/models/` — schemas Mongoose canónicos (fuente de verdad).
- `src/services/` — lógica (referidos, notificaciones, otp, metaCapi, fbAds, analítica publicistas…).
- `public/` — PWA del cliente. `public/adminprivado2026/` — panel admin (cookie httpOnly).

## Cosas que NO hay que romper (gotchas)

- **JWT_SECRET y otros secrets** se cargan desde AWS SSM en el bootstrap async, NO al
  `require()`. Por eso hay lazy getters en `src/middlewares/auth.js` y rutas.
- **JUGAYGANA es flaky** (Cloudflare → responde HTML). Hay auto-retry + manejo de HTML
  en los clientes. No asumir respuestas inmediatas; reusar los clientes existentes.
- **Roles:** `user`, `admin` (todo), `depositor` (solo cargas), `withdrawer` (solo
  retiros), `publisher_admin` (solo crea usuarios de su publicista — lockdown via
  `PUBLISHER_ADMIN_ALLOWED_PATHS`).
- **Auth:** JWT por header Authorization O por cookie httpOnly `admin_api_session`
  (el panel admin usa cookie).
- **Mensajes automáticos al usuario** son editables desde la sección COMANDOS
  (comandos `/sys_*`). Usar el helper `renderSystemCommand(name, fallback, vars)` para
  cualquier mensaje automático nuevo.
- **Transaction** (cargas/retiros) es permanente (sin TTL). **Message** tiene TTL de 3
  días. La analítica de clientes se basa en Transaction.

## Flujo de trabajo del asistente

1. Leer `WORKLOG.md` al iniciar.
2. Hacer el cambio. Validar sintaxis (`node --check` en archivos tocados — no hay
   node_modules local, así que no se puede correr el server; sólo syntax check).
3. Actualizar `WORKLOG.md`.
4. Commitear y pushear a `main` cuando el owner lo pida (o si pidió "todo seguido").
