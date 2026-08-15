# CLAUDE.md — Contexto del proyecto VIPCARGASANTINO

> ⚠️ **LEER PRIMERO (continuidad entre sesiones).** El owner trabaja en **Tails sin
> almacenamiento persistente**: al reiniciar la PC se borra TODO lo local y vuelve a
> clonar este repo desde GitHub. Por eso el contexto vive ACÁ (en el repo), no en la
> memoria local del asistente.
>
> **REGLA PERMANENTE (los 3 docs vivos):** tras cada cambio significativo (feature,
> fix importante, decisión de diseño) mantené actualizados:
>   1. `WORKLOG.md` — QUÉ se hizo y por qué (diario de sesiones, entrada numerada).
>   2. `docs/ARCHITECTURE.md` — CÓMO funciona (si el cambio altera un flujo, modelo,
>      endpoint o agrega una trampa nueva, reflejalo ahí; corregí lo que quede stale).
>   3. `CLAUDE.md` (este archivo) — solo si cambió algo del CONTEXTO de arranque
>      (estructura, gotchas de primer nivel, reglas de trabajo).
> Commiteá y pusheá a GitHub para que la próxima sesión pueda seguir donde se dejó.
> Esta regla aplica siempre, sin que el owner tenga que pedirlo cada vez. El objetivo:
> que una sesión nueva en Tails sepa TODO leyendo estos docs, sin re-analizar el repo.
>
> Al iniciar una sesión nueva: leé `WORKLOG.md` (estado actual) y `docs/ARCHITECTURE.md`
> (mapa completo de modelos, flujos, front y trampas — actualizado 2026-07-09 tras una
> lectura de punta a punta del repo). Antes de modificar un flujo central, leé además
> el código puntual del área. El código es la verdad; los docs son el mapa.

---

## Qué es

Backend de una **sala de juegos** (mercado argentino) que opera como wrapper sobre la
plataforma externa **JUGAYGANA** (`admin.agentesadmin.bet`). Capta usuarios, los crea
en JUGAYGANA por API, gestiona cargas/retiros vía CBU, reembolsos, ruleta, fueguito,
referidos y campañas/publicistas. UX en PWA con notificaciones push (FCM).

**Stack:** Node 20 · Express · MongoDB (Atlas) · Mongoose · Socket.IO (+ Redis adapter
para multi-instancia en AWS EB) · Firebase Admin (FCM) · AWS SNS (SMS OTP).
**Deploy — DOS entornos:**
- **AWS Elastic Beanstalk = PRODUCCIÓN** (vipcargas.com). Secrets por SSM (`SSM_PATH`).
- **Render = PRUEBAS** (`vipcargasantinobackupviejo.onrender.com`). Se prueba ahí y recién
  después va a EB. Sin `SSM_PATH` → los secrets salen de las env vars del dashboard de
  Render (ver `loadSecrets.js:19`). Plan gratis: la instancia se duerme sin uso (primera
  visita ~50 s) y corre en una sola instancia (Socket.IO sin Redis, avisa por log).

⚠️ Las vars que se leen al `require()` (**`PROXY_URL`, `PUBLIC_BASE_URL`**) NO pueden ir en
SSM: se leen ANTES del bootstrap async. En EB van como *environment properties*.

Git remote: `github.com/jupedro2112-pixel/VIPCARGASANTINOactivo` (el repo se renombró; el
nombre viejo `VIPCARGASANTINObackupviejo` sólo redirige). Git user: jupedro2112-pixel.

## Estructura

- `server.js` (~15.7k líneas) — entry point. ~180 rutas, authMiddleware inline (~L2477),
  Socket.IO (~L7325), motores cron por setInterval (~L14100+), bootstrap async con SSM
  (final del archivo). Comentario dice "en migración" pero en la práctica sigue
  creciendo acá. (Los números de línea derivan con cada cambio — usar grep.)
- `config/database.js` — el `connectDB` que server.js realmente usa (TTL de mensajes,
  proxy a /src/models). **OJO: hay DOS connectDB** (este y `src/models/index.js`); el
  segundo NO se usa desde server.js. No tocar schemas en config/database.js (sólo
  define ExternalUser y UserActivity; el resto es proxy a /src/models).
- `jugaygana.js` — cliente principal a JUGAYGANA (sesión auto-renovable, proxy opcional).
- `jugaygana-movements.js` — endpoint alterno (deposit/withdraw/balance).
- `src/services/jugayganaService.js` — cliente refactorizado (lo usa referidos).
- `src/services/jugayganaPublisherSessions.js` — pool de sesiones por publicista.
- `src/models/` — schemas Mongoose canónicos (fuente de verdad).
- `src/services/` — lógica (referidos, notificaciones, otp, metaCapi, fbAds, hgcash,
  comprobantes IA, analítica publicistas…).
- `public/` — PWA del cliente (namespace global `window.VIP`, SW único
  `firebase-messaging-sw.js`). `public/adminprivado2026/` — panel admin (~12k líneas
  de admin.js, cookie httpOnly, SW propio `admin-sw.js` con scope /adminprivado2026/).

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
- **Hay 4 clientes JUGAYGANA** con sesión propia cada uno: `jugaygana.js` (cargas/
  retiros/reembolsos, montos ×100 centavos), `jugaygana-movements.js` (balance +
  makeBonus; ⚠️ sus makeDeposit/makeWithdrawal NO multiplican ×100 — no usarlos para
  plata), `src/services/jugayganaService.js` (referidos/bonus/passwords) y
  `jugayganaPublisherSessions.js` (pool por publicista). Reusar el que use el flujo.
  ⚠️ Sus `.error` pueden venir como **objeto**: pasarlos SIEMPRE por `errToString()`
  (exportado por `jugaygana.js`) antes de concatenar/loguear, o sale `[object Object]`.
  Para decidir "existe / no existe" usar `lookupUserOrError` (tri-estado), nunca
  `getUserInfoByName` (colapsa "falló la API" con "no existe").
- **Bonos automáticos APAGADOS por flags** (owner 2026-06-24): `INACTIVIDAD_DISABLED`
  y `BONUS_STRATEGY_DISABLED` (server.js) + `CHARGE_BONUSES_DISABLED`
  (notificationRulesService) + bonos de encuesta con `bDays=[]`. Tope 30% en TODO lo
  automático (cap de lectura en `_getActivePromoBonus` incluido). **EXCEPCIÓN
  (owner 2026-08-15):** el bono automático de las cargas hgcash con app+notifs
  (100% primera carga / 20% hasta 31-08) — ver WORKLOG #110.
- **Multi-instancia (AWS EB):** los crons son `setInterval` en CADA instancia; su
  idempotencia depende de índices únicos (EncuestaFire.slotKey, InactividadFire.fireKey,
  HgcashCharge.chargeKey, DailyRouletteSpin userId+dateKey). No quitar esos índices.
- **Front frágil:** cientos de `onclick` inline dependen de funciones en `window.*`
  (no renombrar exports sin actualizar el HTML/strings). Tabla de usuarios del panel
  acoplada a `USERS_LIST_FIELDS` del backend (columna nueva ⇒ sumar campo al select).
  Los script/link de `public/index.html` llevan `?v=N`: al cambiar HTML y JS JUNTOS,
  bumpear `?v` y `CACHE_VERSION` del SW al mismo número (sin eso, una carga corre
  HTML nuevo + JS viejo cacheado). Detalle completo en `docs/ARCHITECTURE.md` §7.

## Flujo de trabajo del asistente

1. Leer `WORKLOG.md` al iniciar.
2. Hacer el cambio. Validar sintaxis (`node --check` en archivos tocados — no hay
   node_modules local, así que no se puede correr el server; sólo syntax check).
3. Actualizar `WORKLOG.md`.
4. Commitear y pushear a `main` cuando el owner lo pida (o si pidió "todo seguido").
