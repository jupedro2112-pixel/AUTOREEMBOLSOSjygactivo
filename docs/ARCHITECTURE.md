# ARCHITECTURE — Cómo funciona VIPCARGASANTINO

> Mapa arquitectónico para entender el repo y modificarlo sin romper nada.
> **No reemplaza leer el código** del área puntual que vayas a tocar — el código es la
> verdad y este doc puede quedar viejo. Si encontrás algo desactualizado acá, corregilo
> (regla permanente en CLAUDE.md: este doc se actualiza junto con WORKLOG.md).
>
> Última actualización integral: **2026-07-09** (lectura de punta a punta de todo el
> repo: server.js completo, clientes JUGAYGANA, 28 modelos, servicios, PWA y panel).
> Los números de línea derivan con cada cambio — usalos como referencia aproximada y
> confirmá con grep.

Índice:
1. Visión general del negocio
2. Modelos de datos y relaciones
3. Ciclo de request / autenticación / roles
4. Integración JUGAYGANA (4 clientes)
5. Flujos principales (paso a paso)
6. Front-end: PWA cliente y panel admin
7. Motores automáticos / crons
8. Convenciones importantes
9. Trampas / "no rompas esto"

---

## 1. Visión general del negocio

Sala de juegos para Argentina que es un **wrapper sobre JUGAYGANA** (plataforma de
juego externa, `admin.agentesadmin.bet`; la web del jugador es `jugaygana44.bet`).
El sistema VIPCARGAS:
- Capta jugadores (pauta/publicistas/referidos/orgánico) y los crea en JUGAYGANA por API.
- Gestiona **cargas** (manuales por agente, o AUTOMÁTICAS vía banco hgcash + IA de
  comprobantes) y **retiros** (self-service con confirmación de agente y pago
  automático por hgcash).
- Da **reembolsos** sobre la pérdida real/NETWIN (**diario, semanal y mensual**, los
  tres con el % del **rango** 🥉🥈🥇 según la pérdida del mes; el diario se eliminó el
  2026-07-28 y se restauró el 2026-08-14), **ruleta diaria**,
  **fueguito** (racha), **bono instalación** (cupón 100% próxima carga; antes $5.000),
  **referidos** (7% del owner-revenue) y **campañas/publicistas** con sub-atribución
  por influencer.
- El "saldo real" del jugador vive en JUGAYGANA; VIPCARGAS guarda atribución, bonos,
  reclamos y el registro permanente de transacciones.

UX del cliente: PWA (`public/`) con chat en vivo (Socket.IO) + push (FCM). En este
repo (gemelo de vipcargas, dominio autoreembolsos.com) la app instalada se llama
**AUTOREEMBOLSOS** (manifest + `apple-mobile-web-app-title`, #124); los textos de
marketing internos siguen diciendo VIPCARGAS. Los
agentes operan desde `public/adminprivado2026/`. Deploy: AWS Elastic Beanstalk
(posible multi-instancia → Redis para socket.io adapter, rate-limits y locks).
Secrets desde AWS SSM cargados async en el bootstrap (final de server.js).

## 2. Modelos de datos y relaciones (`src/models/`)

Todos los modelos canónicos viven en `src/models/`. `config/database.js` los
re-exporta (NO los redefine, salvo **ExternalUser** y **UserActivity** que son
exclusivos suyos) y es el `connectDB` REAL que usa server.js (TTL de mensajes con
autorreparación de índice). `src/models/index.js` tiene OTRO connectDB con las
migraciones de índices de referidos — **NO se usa desde server.js** (solo exporta
modelos); sus migraciones corren únicamente si algo llamara a ese connectDB.

### Núcleo
- **User** — jugadores y staff. Claves: `id` (uuid string — casi todo el código usa
  `id`, NO `_id`), `username` + **`usernameLower`** (copia indexada para búsquedas
  case-insensitive; la mantiene un pre-save + backfill en cada arranque — ver
  `findUserByUsernameCI`), `password` (bcrypt vía pre-save), `role`, `phone` +
  **`phoneKey`** (clave normalizada para unicidad — quita país/0/9 AR), `phoneVerified`,
  `phoneVerificationPending` (bloquea SOLO retiros), `mustChangePassword` (bloquea casi
  todo vía authMiddleware), `tokenVersion` (revocación de sesiones), `isBlocked`/
  `blockReason`. JUGAYGANA: `jugayganaUserId` (numérico — clave para operar sin lookup),
  `jugayganaSyncStatus`, `source`. FCM: `fcmToken` legacy + `fcmTokens[]`
  (multi-dispositivo, `context:'standalone'` = PWA instalada). Atribución:
  `acquisitionCampaign/Source/Influencer/Utm`, `createdByEmployeeId`. Referidos:
  `referralCode`, `referredByUserId`. Meta: `metaFbc/metaFbp/landingUrl`.
  Anti-multicuenta: `registrationIp/UserAgent`. Panel: `tags[]`, `adminNotes`,
  `tagHistory`. Otros: `installBonusClaimed` + cupón `installBonus100Pending/
  GrantedAt/UsedAt/UsedBy` (100% próxima carga por instalar la app), `notificationPlan`,
  `notifMonthlyCounts`, `loginWithoutPassword`, `withdrawalAccount`, `pendingAccessCode`.
- **Transaction** — registro PERMANENTE (sin TTL). `type`: deposit|withdrawal|bonus|
  refund|transfer|referral_commission|fire_reward. `metadata.source` distingue regalos
  ('install_bonus','welcome_gift') y devoluciones ('payout_refund') que se EXCLUYEN de
  los reportes de carga real. **Fuente de toda la analítica.**
- **Message** — chat. **TTL 3 días** (índice sobre `timestamp`, autorreparado en
  connectDB). `senderRole` define el lado; `adminOnly:true` = solo lo ven admins;
  `metadata.kind:'welcome'` = throttle de bienvenida.
- **ChatStatus** — estado de conversación (open/closed/payments/comunidad + category
  cargas/pagos). Se crea recién con ACTIVIDAD del usuario (welcome o primer mensaje),
  no al crear la cuenta. Lleva el reloj SLA (`pendingSince/Preview/Type`).
- **ChatDelay** — snapshot permanente de demoras de atención que superaron el umbral
  (sobrevive al TTL de Message). Umbrales: cargas 2min / pagos 30min (configurables).

### Plata / banco automático (hgcash)
- **BankMovement** — cada movimiento que hgcash notifica por webhook. `matchStatus`:
  pending→claiming→shadow_matched|auto_charged|manual_charged|needs_review|duplicate|
  error|ignored. Dedupe por `movementId` único.
- **Comprobante** — cada imagen que la IA (Claude vision, `claude-opus-5` con salida
  estructurada json_schema desde #126; configurable desde el panel → "🔐 Config
  privada" = `Config['aiconfig']`, prioridad panel > env > default, #128) clasificó como
  comprobante. `dedupeKey` (N° operación normalizado, descartando CBU/CUIT/alias/pedazos
  de CBU/etiqueta sospechosa → `operationNumberRejected`; fallback
  `monto|origen|cbu|fecha|hora` que EXIGE fecha) + `imageHash` (SHA-256) para detectar
  reutilización. Aviso de duplicado en 3 niveles (imagen / N° / solo datos = "posible").
  `bankMatchStatus` para la auto-carga.
- **HgcashCharge** — candado de idempotencia de la carga automática: índice único por
  `chargeKey` (coelsaCode) — la MISMA transferencia se acredita UNA sola vez entre
  instancias. Si la carga falla en JUGAYGANA, el registro se BORRA para permitir retry.
- **PendingPayout** — retiro self-service pendiente de que un agente confirme.
  `deductAtPay:true` (flujo actual) = las fichas se descuentan AL CONFIRMAR, no al
  solicitar. `debitConfirmed` = verificación anti-retiro-fantasma (el saldo tiene que
  haber bajado de verdad). `status`: pending_review→paying→paid|failed|cancelled.

### Captación / marketing
- **Campaign** — publicista/pauta. `code` inmutable (va en la URL). Creds JUGAYGANA
  opcionales del sub-agente (`jugayganaPassword` con `select:false`, texto plano) +
  `influencers[]` (lista fija para sub-atribución analítica).
- **CampaignClick** (TTL 90 días), **InfluencerStory** (placement con costo; la
  atribución de registros es por VENTANA HORARIA calculada a demanda en
  publisherAnalyticsService).
- **Referral**: ReferralEvent (atribución, 1 por referido), ReferralCommission
  (cálculo por período `YYYY-MM`, con liquidación INCREMENTAL/delta —
  `settledOwnerRevenue`), ReferralPayout (pagos, soporta múltiples por período).

### Notificaciones / retención
- **NotificationRule** (+ Suggestion con approval-gate 48h, + NotificationHistory con
  tracking de ROI), **NotifTemplate** (tipos: invitacion|regalo|reembolso — bono_50/100
  ELIMINADOS), **ScheduledNotif** (once/daily/weekly, worker cada 60s), **PromoBonus**
  (bono de carga vigente ≤30%, 1 sola carga, cap de LECTURA a 30% en
  `_getActivePromoBonus`), **BonusStrategyConfig** + **StrategyEnrollment** (estrategia
  por voto de encuesta — APAGADA), **EncuestaVote/EncuestaFire** (motor encuesta —
  bonos apagados), **InactividadFire** (motor inactivos — APAGADO).
- **DailyRouletteSpin** — 1 giro/día (índices únicos userId+dateKey y
  username+dateKey). Auto-crédito en JUGAYGANA; `credit_failed` → retry desde panel.
- **Review** (1 por user, moderada), **OtpCode** (TTL 5 min, hash bcrypt, 3 intentos),
  **FbAdsWebhookQueue** (cola de reintentos al sistema externo fb-ads),
  **RefundClaim** (índice único userId+type+periodKey contra doble cobro),
  **FireStreak** (racha fueguito + premios pendientes), **Config** (key/value: cbu,
  hgcash, refundTiers (rangos 🥉🥈🥇; refundPercents quedó huérfana en DB),
  fireMilestones, flags de migración one-shot, etc.),
  **Command** (comandos `/...` y mensajes automáticos `/sys_*`, `isSystem:true`).

## 3. Ciclo de request / autenticación / roles

- `authMiddleware` (server.js ~L2477): JWT del header `Authorization: Bearer` o de la
  cookie httpOnly `admin_api_session` (el panel usa cookie). Valida firma HS256, busca
  el User por `id` con select mínimo (`AUTH_USER_FIELDS` — ⚠️ si un chequeo nuevo
  necesita otro campo, sumarlo ahí), chequea isActive/isBlocked/`tokenVersion`.
  publisher_admin: lockdown contra `PUBLISHER_ADMIN_ALLOWED_PATHS`. mustChangePassword:
  solo deja pasar `MUST_CHANGE_PASSWORD_ALLOWED_PATHS` (admins se auto-limpian).
- Middlewares de rol: `adminMiddleware` (admin/depositor/withdrawer/comunidad),
  `depositorMiddleware` (admin/depositor/comunidad), `withdrawerMiddleware`
  (admin/withdrawer), `publisherAdminMiddleware`. Acciones sensibles re-chequean
  `req.user.role === 'admin'` explícito (patrón obligatorio — ver #80).
- **`src/middlewares/auth.js` es OTRO sistema de auth** (access 15m + refresh 7d,
  blacklist EN MEMORIA no compartida entre instancias) usado SOLO por las rutas de
  referidos. Lazy getters de JWT_SECRET (SSM carga después del require).
- Secrets: `loadSecretsFromSSM()` en el bootstrap async → NUNCA leer secrets al
  require; leerlos en runtime.
- Cookies admin: `admin_session` (Path=/adminprivado2026) + `admin_api_session`
  (Path=/api), 8h, SameSite=Strict. `GET /api/admin/me` revalida la cookie contra DB
  y devuelve un token fresco para Socket.IO.
- Rate limiting: `generalLimiter` 300/min (keyed por cookie de sesión admin o IP; en
  memoria), `authLimiter` 10/min y `sensitiveLimiter` 10/15min (Redis compartido con
  fallback a memoria — `RedisBackedRateStore`), `smsIpLimiter`/`bulkSmsIpLimiter`/
  `registerIpLimiter` (Redis INCR+EXPIRE con fallback).
- Socket.IO (~L7325): `authenticate` revalida contra DB (isActive/isBlocked/
  tokenVersion). Rooms: `admins`, `user_<id>`, `chat_<id>`. Maps `connectedUsers`/
  `connectedAdmins`. Entrega con ack-timeout 3s → fallback push FCM (socket fantasma).

## 4. Integración JUGAYGANA (4 clientes, cada uno con SU sesión)

| Cliente | Usa | Para qué |
|---|---|---|
| `jugaygana.js` (raíz) | server.js | **Cargas/retiros/bonos/reembolsos.** `ensureSession` (mutex+retry), `lookupUserOrError` (tri-estado found/not_found/error — NO interpretar timeout como "no existe"), `depositToUser`/`withdrawFromUser` (con recovery CREATEUSER si not_found), `creditUserBalance` (bonus, 3 intentos, acepta `jugayganaUserId` para saltear el lookup), `syncUserToPlatform`, `changeUserPassword`, `getUserNet*`, rangos de fecha ART. **Montos ×100 (centavos).** |
| `jugaygana-movements.js` (raíz) | server.js | `getUserBalance(WithRetry)` y `makeBonus` (delega en el anterior). ⚠️ Sus `makeDeposit`/`makeWithdrawal` mandan el monto SIN ×100 y con recovery inferior — **no usarlos para mover plata** (hoy no los usa ningún flujo de plata). |
| `src/services/jugayganaService.js` | referidos, passwords, platform-login | `bonus()` (DepositMoney+childid — NO CREDITBALANCE, regresión PR#189/190), `changeUserPasswordAsAdmin`, `loginAsUser`, `getUserInfo`. |
| `src/services/jugayganaPublisherSessions.js` | publisher_admin create-user | Pool de sesiones por Campaign (creds propias del sub-agente). Firma sha1 de creds → re-login si cambian en DB. |

Además `src/services/referralRevenueService.js` consulta `royalty-statistics`
(**header `X-Token`**, no Bearer) con **`child_user_id` OBLIGATORIO** (sin él devuelve
el agregado GLOBAL del agente → números inflados). Es la fuente del NETWIN de
reembolsos Y del revenue de referidos. `jugayganaUserLinkService.resolveJugayganaUserId`
hace backfill al vuelo del id faltante.

**Comportamiento clave:** JUGAYGANA es flaky — responde HTML (Cloudflare) de forma
intermitente. Todos los clientes tienen auto-retry + detección de HTML + renovación de
sesión. Montos en **centavos** (×100) al API. Fechas en hora Argentina (ART, UTC-3).
NUNCA asumir respuesta inmediata; reusar estos clientes.

## 5. Flujos principales

- **Registro**: `POST /api/auth/register` (user+pass; OTP solo si manda teléfono) o
  `register-quick` (link de pauta con campaignCode válido, sin SMS,
  phoneVerificationPending=true → no puede retirar hasta verificar). Crea en JUGAYGANA
  PRIMERO; guarda atribución, fbc/fbp, registrationIp. Crea ChatStatus solo el flujo
  público (los usuarios creados por admin/publisher NO — evita chats vacíos).
  - `syncUserToPlatform` usa el lookup TRI-ESTADO y devuelve
    `{success, alreadyExists?, jugayganaUserId, jugayganaUsername}` o
    `{success:false, error:<STRING>, code, transient}`. `code` ∈ `LOOKUP_UNAVAILABLE` ·
    `EXISTS_UNCONFIRMED` · `PLATFORM_UNAVAILABLE` · `CREATE_FAILED`; `transient:true`
    = caída de la plataforma, NO culpa del nombre elegido (el front muestra el mensaje
    tal cual, sin el prefijo "No se pudo crear el usuario en JUGAYGANA:").
  - Si CREATEUSER responde "already existing", se re-busca (3× cada 1,5 s) y se VINCULA
    la cuenta existente en vez de fallar — misma red de seguridad que
    `depositToUser`/`withdrawFromUser`.
  - ⚠️ **Vincular una cuenta preexistente de JUGAYGANA es potestad del ADMIN.** El
    registro PÚBLICO (`/api/auth/register` y `register-quick`) rechaza con 400
    `USERNAME_TAKEN` cuando `syncUserToPlatform` devuelve `alreadyExists`: ahí el
    username es la única prueba de identidad, así que vincular permitiría quedarse con
    la cuenta y el saldo de otro. Las altas por admin (`POST /api/users` y
    `POST /api/admin/users`) SÍ vinculan — ya validan que el username no exista local.
- **Link de autologin** (alta por agente / migración): `POST /api/admin/users/:id/autologin-link`
  (admin general, nunca sobre staff) genera un token de **un solo uso** con TTL
  `AUTOLOGIN_TTL_HOURS` (72 h) y devuelve `<PUBLIC_BASE_URL>/?al=<token>`.
  ⚠️ El dominio sale de `PUBLIC_BASE_URL` y NO del host del request: el panel se
  sirve desde `ADMIN_HOST` (otro dominio), y como `localStorage` es por ORIGEN,
  un link con el dominio del panel dejaba al usuario logueado en el lugar
  equivocado. Sin `PUBLIC_BASE_URL` seteada, cae al host del request; en la DB va solo
  el SHA-256 (`autologinTokenHash`). Setea `mustChangePassword:true`. El canje es
  `POST /api/auth/autologin` — **POST y no GET porque la vista previa de WhatsApp
  quemaría el token**; el un-solo-uso se garantiza con reserva atómica
  (`findOneAndUpdate` con `autologinUsedAt:null` en el filtro). En la PWA lo consume
  `VIP.auth.consumeAutologinFromUrl()` (auth.js), llamado desde `app.js` ANTES de
  `verifyToken`; limpia el token de la URL con `replaceState` antes de canjearlo.
- **Traspaso de sesión a la PWA instalada (solo iOS)**: en iOS la web app de la pantalla de
  inicio tiene su PROPIO storage, separado de Safari → no hereda `userToken` y abre pidiendo
  login (en Android/escritorio sí lo hereda: mismo origen). Fix: `POST /api/auth/pwa-session-token`
  (autenticado, TTL 30 min, NO toca `mustChangePassword`) + `GET /manifest.json?al=TOKEN`
  (ruta ANTES de `express.static`, devuelve el manifest con `start_url: "/?al=TOKEN"`;
  `id`/`scope` intactos o el navegador lo tomaría como otra app). Lo dispara
  `primePwaSessionHandoff()` en ui.js al mostrar las instrucciones de iOS.
  ⚠️ **El `start_url` se abre en CADA arranque de la app**, así que del 2º en adelante el
  token ya está usado: `_runAutologin` falla en SILENCIO cuando ya hay sesión (si avisara,
  el usuario vería un error cada vez que abre la app).
- **Login**: `POST /api/auth/login` (~L3341). `findUserByUsernameCI` con
  `critical:true` (fallback regex SIEMPRE disponible — nadie queda afuera). Importa de
  JUGAYGANA si no existe local, **validando la contraseña contra la plataforma**
  (`jugayganaService.loginAsUser`) y guardando ESA contraseña — nunca una fija. Si la
  plataforma no responde (`transient`), devuelve 503 `PLATFORM_UNAVAILABLE`, NO
  "credenciales inválidas". ⚠️ El atajo histórico que aceptaba `asd123` fue eliminado
  (2026-08-13); pero las cuentas que creamos NOSOTROS en JUGAYGANA todavía nacen allá con
  `asd123`, así que para ésas esa contraseña sigue siendo válida en la plataforma. Soporta login por teléfono, OTP y `temporaryCode`.
  Roles staff reciben las cookies admin. JWT 30d (registro: 90d).
- **Pauta / vanity URL**: `GET /:code` matchea Campaign.code exacto (DB directa) o slug
  del publisher (cache 30s). Setea cookie httpOnly `vip_campaign` (60 días) → el server
  reinyecta el código en CADA carga SPA (`renderIndexHtml`) para que "registro sin SMS"
  sea determinístico (las webviews de Meta rompen localStorage).
- **Bienvenida**: `POST /api/messages/welcome` — mensajes de SISTEMA + upsert de
  ChatStatus. Throttle 24h server-side. Guard `_isStaleClientWelcome` descarta
  bienvenidas-fantasma de PWA cacheadas viejas.
- **Chat**: HTTP `POST /api/messages/send` + socket `send_message` (misma lógica
  duplicada: validaciones, comandos `/`, SLA, comprobantes). Imagen de cliente →
  `analyzeComprobanteFromMessage` (IA, fire-and-forget) → aviso adminOnly
  (duplicado/verificado/manual) → `hgcashMatchFromComprobante`.
- **Carga manual**: `POST /api/admin/deposit` → `jugaygana.depositToUser` (+bonus
  separado tras pausa 700ms; el mensaje al cliente refleja el resultado REAL; si el
  bonus falla → alerta adminOnly). Consume PromoBonus vigente y movimiento hgcash
  pendiente del mismo monto (`hgcashConsumeOnManualDeposit`). Mensajes `/sys_deposit*`,
  `/sys_reminder`, `/sys_install_app`, `/sys_recover_100`.
- **AUTO-CARGA hgcash** (`POST /api/hgcash/webhook`, firma HMAC sobre rawBody,
  fail-closed en prod): guarda BankMovement → matching contra Comprobantes por
  monto + (N° operación==coelsa/externalID, o nombre de origen + destino consistente)
  dentro de una ventana (60min desde comprobante / 10min desde movimiento). Ambigüedad
  → NO carga. ⚠️ **Si el comprobante muestra un CBU destino, ese CBU tiene que ser
  el nuestro** (`ownCbus` = hgcash.cbu + Config.cbu.number + toCBU del movimiento,
  comparación por sufijo ≥6 dígitos; si muestra ALIAS se compara con
  `Config.cbu.alias`): el titular NO alcanza porque es el mismo en
  todos los proyectos → comprobante a otro CBU queda `bankMatchStatus:'other_cbu'`
  con nota ⛔ al agente y nunca se auto-carga (#125). `hgcashAutoCarga`: claims atómicos de movimiento y comprobante → modo
  sombra o real → **mínimo $1.500** (menor → needs_review + aviso; era $2.000 hasta
  2026-08-19) → candado
  HgcashCharge por coelsa → guard anti-duplicado (misma carga <8min → needs_review, salvo
  que la carga anterior esté ligada a OTRA transferencia — #131) →
  lectura del saldo PREVIO (sólo si el 20% está en juego) →
  `depositToUser` → Transaction + mensaje + SLA. Fallo → reintentable hasta 3 veces.
  **Bono automático app+notifs** (`_hgcashApplyAppBonus`): 100% primera carga /
  20% todas (config panel, hasta 31/08). ⚠️ Desde 2026-08-19 el 20% NO se da si el
  cliente tenía **más de $500 de saldo ANTES de la carga**
  (`HGCASH_APP_BONUS_SKIP_BALANCE_ARS`; se le avisa con
  `/sys_deposit_no_bonus_saldo`, editable — vaciarlo lo apaga; si la lectura de
  saldo falla, el bono sale igual, fail-open). El 100% NO tiene esta condición.
  **Fan-out** (#94): reenvía el webhook crudo+firma a autoreembolsos.com
  (`HGCASH_FANOUT_URL`, 'off' para apagar). ⚠️ **Guard anti-bucle** (#117,
  incidente 2026-08-20): NO se reenvía si el webhook ya trae `X-Forwarded-By`
  (es un reenvío del hermano) ni si el destino es nuestro PROPIO dominio
  (`PUBLIC_BASE_URL`/host del request) — sin ese guard, este código corriendo
  EN autoreembolsos.com se reenviaba a sí mismo en bucle infinito hasta
  tumbar el entorno (504 en todo).
- **Retiro self-service**: `POST /api/withdrawal/request` — exige phoneVerified, lock
  anti-doble, chequeo de saldo (UX), dedup 10min → crea PendingPayout
  (`deductAtPay:true`, SIN descontar) → mueve el chat a Pagos. El AGENTE confirma:
  `POST /api/admin/payouts/:id/pay` → `_deductChipsAtConfirm` (saldo CON retry
  3× —#124; si JUGAYGANA no responde el payout queda `failed` sin descontar y se
  re-paga desde el panel— → withdraw → verificación anti-fantasma de que bajó) → cash-out hgcash (externalID=payout.id =
  idempotencia; retry con accountId fresco ante 403) → webhook/poller confirma DONE →
  aviso `/sys_payout_paid` + comprobante PDF (foto vía mupdf + link permanente
  `/api/payout-receipt/:id`). Rechazo (`/cancel`): si NO se descontó → nada que
  devolver; si se descontó → devolución (split bonus/fichas para pagos legacy).
  `pay-other-bank` = pago manual (descuenta igual). Poller `_pollPayingPayouts` cada
  45s (últimas 2h) cubre webhooks perdidos.
- **Reembolsos** (rangos desde 2026-07-28 #97; el DIARIO volvió el 2026-08-14 #102):
  **DIARIO, semanal y mensual**, los tres con el MISMO % de rango.
  `POST /api/refunds/claim/{daily|weekly|monthly}` — lock Redis, ventanas de
  `models/refunds.js` (diario: uno por día; semanal: lunes/martes; mensual: desde
  día 7). ⚠️ **Las ventanas se evalúan en día ARGENTINO** (`_artParts` en
  models/refunds.js), NO con `getDay()`/`getDate()`: el server corre en UTC y ART
  es UTC−3, así que el día del proceso arranca a las 21:00 de acá — con el reloj
  del server, el martes 22:30 (último día válido del semanal) quedaba afuera.
  Las 3 funciones `canClaim*` reciben el **período** que se va a reembolsar y
  consultan el `periodKey` exacto, así la puerta de UX coincide 1:1 con el candado
  del índice único. NETWIN real de
  `referralRevenueService.getUserNetwinForDateRange`. El **% sale del RANGO** del
  cliente (`Config['refundTiers']`, editable panel→COMANDOS, solo admin general;
  defaults: 🥉 bronce hasta $30.000 = 3%, 🥈 plata hasta $100.000 = 5%, 🥇 oro = 10%),
  calculado sobre la pérdida NETWIN mensual: el MENSUAL usa el netwin del propio mes
  reembolsado; el SEMANAL usa el mes al que pertenece el LUNES de la semana (mes en
  curso a hoy, o el mes anterior completo si la semana arrancó allá — decidir por el
  domingo era un bug de arranque de mes); el DIARIO usa el mes al que pertenece AYER
  (sólo difiere el día 1, donde ayer cayó en el mes anterior → ese mes completo).
  ⚠️ **Los tres SE SOLAPAN a propósito** (decisión del owner 2026-08-14): ayer también
  cae dentro de la semana y del mes reembolsados, y NO se descuentan entre sí.
  `GET /api/refunds/status` devuelve además `tier` (rango en vivo del mes en curso +
  nextTier + tabla) y los 3 períodos con su `potentialAmount`/`percentage`/`period`.
  Guard `refundAmount <= 0` ANTES de reservar (no quemar el período por $0).
  **El RefundClaim se CREA antes de acreditar** (el índice único `userId+type+periodKey`
  es el candado atómico contra doble cobro; si el crédito falla se borra la reserva;
  ver #96). RefundClaim guarda `tier`. Config admin: `GET/POST /api/admin/refund-tiers`
  (reemplazó a refund-percents).
- **Referidos**: preview/calculate (delta incremental sobre ledger de payouts) /
  payout (acredita con `jugayganaService.bonus`). Ver §4 y gotchas.
- **Ruleta diaria**: requiere PWA instalada (token FCM standalone). El gate de
  "cliente activo" (>10 cargas reales/30d, #71) está **APAGADO** desde 2026-08-20
  (`ROULETTE_ACTIVE_GATE_DISABLED=true`, owner: para TODOS los que tengan la app).
  Pick ponderado + **budget pacing** (distribuye el presupuesto diario por hora
  ART; si excede → fuerza SIN PREMIO; el total del día nunca supera el tope).
  ⚠️ **Fail-closed desde 2026-08-20:** sin tope activo (checkbox apagado o $0) o
  ante error de DB en el pacing → TODOS los giros salen SIN PREMIO (con la ruleta
  abierta a toda la base, un descuido de config no puede regalar sin límite).
  Auto-crédito.
- **Fueguito**: reclamo diario sin requisitos; premios de hitos (editables en panel,
  Config['fireMilestones']) exigen actividad de cargas y expiran el mismo día.
- **Bono instalación** (desde 2026-07-28 = **cupón 100% EXTRA en la próxima carga**,
  ya NO acredita $5.000): exige standalone real (token FCM), teléfono verificado,
  anti-multicuenta por token FCM compartido. La reserva atómica del claim setea
  `installBonusClaimed` + `installBonus100Pending/GrantedAt` en un solo update (sin
  plata → sin rollback). El AGENTE lo ve como banner verde en el chat del panel
  (patrón fueguito), aplica el +100% a mano en el modal de carga y lo marca usado con
  `POST /api/admin/users/:id/install-bonus-100/apply` (update atómico con guard).
  Mensaje `/sys_install_bonus_100`. Reporte: sección "Bono App (100%)" del panel
  (`/api/admin/central/welcome-bonus` distingue legacy $5.000 vs cupón).
- **SLA demoras**: reloj en ChatStatus (`delayClockOnUserMessage`/`delayClockResolve`);
  responder (mensaje/comando/carga/retiro/CBU) o cerrar lo resuelve; sobre-umbral →
  ChatDelay. Reporte `GET /api/admin/chat-delays` (solo admin).

## 6. Front-end: PWA cliente y panel admin

### PWA (`public/`)
- Namespace global `window.VIP` (`VIP.config`/`VIP.state` en config.js; módulos IIFE:
  auth, socket, chat, ui, refunds, fire, roulette, reviews, promobonus, notifications,
  withdraw, installbonus, notifsurvey, publisherwelcome, campaign, meta-pixel, apptest,
  app). El orden real de carga está en index.html (el comentario de app.js está viejo).
- **SW único**: `firebase-messaging-sw.js` (CACHE_VERSION v53) — FCM + caché:
  `/js/` y `/css/` stale-while-revalidate (deploy llega en la SIGUIENTE carga sin
  bumpear versión), `/app.js` y manifest network-first, API/socket nunca. `user-sw.js`
  es un stub de auto-desregistro (no volver a registrarlo).
  ⚠️ **Los script/link de index.html llevan `?v=N`** (desde v51): sin la query, un
  deploy que cambia HTML y JS JUNTOS corre UNA carga con HTML nuevo + JS viejo del
  caché SWR (TypeError si el HTML cambió el DOM — casi pasó con el botón del
  reembolso diario). Al cambiar HTML+JS juntos: bumpear `?v` y CACHE_VERSION al
  mismo número. Cambios de JS solo (sin DOM nuevo) siguen sin necesitar bump.
- **Dashboard del cliente** (bloque `.home-dash` de index.html, CSS inline ~L534-660):
  la card `.dash-user` es CLICKEABLE → `VIP.refunds.showMyMonthModal()` abre
  `#myMonthModal` ("MI MES": rango, % , pérdida del mes, tabla 🥉🥈🥇, cuánto falta para
  subir y una tarjeta por cada uno de los 3 reembolsos). El chip dorado "VER MI MES ›"
  está para que se note que se puede tocar. Los 3 botones de reembolso viven en
  `.dash-refunds-sticky` (FUERA de `#homePanel`, así ocultar el menú no los esconde).
- **EQUIPOS por prefijo de usuario** (`Config['teams']`, panel→COMANDOS): el proyecto lo
  operan varios equipos y cada cliente se asigna al suyo por el **INICIO de su username**
  (`resolveTeamForUsername` en server.js; gana el prefijo MÁS LARGO, case-insensitive).
  Se calcula al vuelo — NO hay campo en User. Cada equipo tiene su **Telegram** (el canal
  que ve dentro de la app) y su **WhatsApp** (el del cartel de acceso en el login).
  ⚠️ **El SOPORTE NO se divide por equipo**: `communityConfig.supportUrl` es único para
  todos. `GET /api/config/team?username=` es **público** (lo usa el login sin sesión) y
  sólo compara prefijos contra la config: no toca la base ni revela si el usuario existe.
- **Tarjetas de Telegram** (`#communitySection`): el canal sale del equipo del usuario
  (fallback: general de `teams` → `communityConfig.channelUrl`); el soporte, siempre de
  `communityConfig.supportUrl`. Las URLs salen de
  `Config['communityConfig']` (`channelUrl`/`supportUrl`), editables en el panel →
  COMANDOS; cada tarjeta se muestra sólo si su URL está cargada. Las pinta
  `VIP.ui.loadCommunityLinks()` desde `initializeSession` (antes era un script inline
  con polling de 25 s que se rendía si el login tardaba).
  ⚠️ **El CANAL se configura en UN SOLO lugar**: la card "👥 Equipos" del panel
  (uno por equipo + el general). El botón 📢 de la barra superior
  (`GET /api/config/canal-url`) resuelve con el MISMO criterio desde 2026-08-14.
  `Config['canalInformativoUrl']` y `communityConfig.channelUrl` quedaron como
  fallback legacy y ya NO se editan desde el panel; el único campo que sigue ahí
  es el **soporte**, que es general para todos los equipos.
- **FCM**: todo el manejo real (getToken 3 tiers, refresh, register-token) está en el
  INLINE de index.html; `window.sendFcmTokenAfterLogin` del inline pisa a propósito la
  de notifications.js. Firebase config duplicada en index.html Y en el SW (cambiar
  ambas). iOS: push solo en PWA instalada.
- SPA sin router: `#loginScreen`/`#chatScreen` + modales. Estado de login en globals
  `window._loginMode` etc. Interceptor global de fetch (auth.js) reabre el modal
  obligatorio ante 403 MUST_CHANGE_PASSWORD.
- Server-side rendering mínimo: `renderIndexHtml` reemplaza placeholders
  (`__META_PIXEL_ID_PLACEHOLDER__`, `__VIP_PUBLIC_BASE_URL_PLACEHOLDER__`,
  `__VIP_CAMPAIGN_CODE_PLACEHOLDER__`) con cache en memoria por proceso.
- Duplicados front/back a mantener sincronizados: mínimo retiro $4.999, URL
  jugaygana44.bet, copys de rangos de reembolso (3/5/10% y umbrales en infoModal/
  adServiceModal/welcome — el badge y el panel del modal unificado sí son dinámicos).

### Panel admin (`public/adminprivado2026/`)
- `admin.js` (~12k líneas), auth mixta: login → Bearer en memoria + cookies httpOnly;
  `checkAdminSession()` (`GET /api/admin/me`) restaura sesión al recargar.
- Roles: admin ve todo; depositor (abiertos/cerrados); withdrawer (solo Pagos);
  comunidad (abiertos/cerrados/comunidad); **publisher_admin tiene vista propia**
  (`#publisherAdminSection`, early-return en setupRoleBasedUI, funciones `pa*`).
- Chat: `renderConversations` con coalescing rAF + delegación de eventos (#91);
  `selectConversation` → `loadUserInfo` → banners (bloqueo, fraude/multicuenta,
  fueguito 30%, tags/notas, payout pendiente con botones pay/other-bank/cancel/
  dismiss/sync, promo bonus). Races protegidas por `activeConversationId` +
  AbortController — **no romper ese patrón**.
- `admin-sw.js` (v24, scope /adminprivado2026/): network-first no-store para el shell.
- Servido por handlers propios con cache en memoria (`readFileCached`) + ADMIN_HOST
  check opcional; el catch-all bloquea todo otro path bajo /adminprivado2026/.
- **"🔐 Config privada"** (#128): sector solo admin general con clave PROPIA (hash bcrypt
  en `Config['privateconfigpass']`, definida desde el panel la primera vez; olvido =
  borrar ese doc en Atlas). Cada escritura manda la clave (`/api/admin/private-config/*`,
  `sensitiveLimiter`). Hoy contiene la config de la IA de comprobantes; es el lugar para
  futuras configs sensibles sin pasar por SSM. **SMS Masivo usa esta misma clave** (#129;
  `SMS_MASIVO_PASSWORD` de SSM solo es fallback mientras no haya clave definida) y la
  exige del lado server en `bulk-sms` y `bulk-sms/preview` (#130).
- Secciones "Automatización" y "Estrategia de bonos" están marcadas "No se usa" en el
  sidebar pero siguen funcionales (candidatas a limpieza con el owner).
- La sección "Base de Datos" fue ELIMINADA por completo (2026-07-09): era inalcanzable.

## 7. Motores automáticos / crons (todos `setInterval` en server.js — corren en CADA instancia)

| Motor | Frecuencia | Estado | Idempotencia |
|---|---|---|---|
| `_runNotifRulesEvaluator` (reglas push) | 5 min | activo (reglas refund/tier inertes: PlayerStats no portado) | lastFiredAt + ventana |
| `_runEncuestaTick` | 5 min | pushes sí, **bonos apagados** (`bDays=[]`) | EncuestaFire.slotKey único |
| `_runInactividadTick` | 6 h | **APAGADO** (`INACTIVIDAD_DISABLED=true`) | InactividadFire.fireKey único |
| `_runBonusStrategy` | 10 min | **APAGADO** (`BONUS_STRATEGY_DISABLED=true`) | step en StrategyEnrollment |
| `_runDueSchedules` (ScheduledNotif) | 60 s | activo | lastRunAt |
| `_pollPayingPayouts` | 45 s | activo (confirma pagos si el webhook no llegó) | handlePayoutStatusWebhook idempotente |
| `_runFcmPrune` | 24 h | activo | flag anti-overlap en memoria |
| `fbAdsWebhook.startWorker` | 5 min | activo | nextRetryAt |
| Limpieza mensajes >3d | 6 h | activo (red de seguridad del TTL) | deleteMany |

Migraciones one-shot: patrón flag en Config (`migration_*_done`) en `initializeData()`.
El backfill de `usernameLower` corre en CADA arranque (idempotente) y setea
`_usernameLowerReady`.

## 8. Convenciones importantes

- **Mensajes automáticos al usuario** → `renderSystemCommand(name, fallback, vars)` y
  sembrar el comando en `systemCmds` de `initializeData()`. Respuesta VACÍA en el panel
  = "no enviar" (null). Variables: montos como `${amount}` en el template y se
  reemplaza `{amount}` (el `$` queda como signo); texto como `{username}` sin `$`.
- **Identidad**: `user.id` (uuid), no `_id`. Username case-insensitive →
  `findUserByUsernameCI` (indexado + fallback), NUNCA regex nuevo.
- **periodKey**: `YYYY-MM` (referidos); RefundClaim usa `weekly:YYYY-MM-DD` /
  `monthly:YYYY-MM` (`daily:YYYY-MM-DD` solo en filas históricas — el diario se
  eliminó 2026-07-28).
- **Montos JUGAYGANA**: centavos (×100) al enviar; balances vuelven /100.
- **Todo lo fire-and-forget** (tracking, comprobantes, fanout, SLA) va en try/catch y
  JAMÁS frena la respuesta al cliente — mantener ese patrón.
- **Crédito de plata al cliente = RESERVAR ATÓMICO ANTES de acreditar** (nunca acreditar
  y limpiar el flag después → TOCTOU/doble cobro). Patrón: `findOneAndUpdate` con guard
  del flag (ruleta, bono instalación, fueguito claim-reward) o `create` con índice único
  (reembolsos). Si el crédito falla, revertir la reserva. Ver #96.
- **Endpoints muertos**: se eliminan con comentario-lápida y rollback `git revert`.
- **Validación local**: sólo `node --check` (no hay node_modules en Tails).

## 9. Trampas / "no rompas esto"

- **DOS `connectDB`**: el real es `config/database.js`; el de `src/models/index.js` NO
  se usa. No definir schemas en config/database.js.
- **Secrets por SSM**: no leer `process.env.X` al require; lazy getters.
- **JUGAYGANA flaky**: manejar HTML/timeout; `lookupUserOrError` distingue error de
  not_found — un timeout NO es "no existe" (dispararía CREATEUSER duplicado).
  ⚠️ `getUserInfoByName` es el wrapper de 2 estados (user|null) que COLAPSA
  error+not_found: no usarlo para decidir si crear algo. Usar `lookupUserOrError`.
- **Los `.error` de JUGAYGANA pueden ser OBJETOS**, no strings. Todo `.error` que
  devuelvan estos clientes debe pasar por `errToString()` (exportado por
  `jugaygana.js`); concatenar el objeto directo imprime `[object Object]` y tapa el
  error real, tanto en pantalla como en los logs y en `User.jugayganaSyncError`.
- **`jugaygana-movements.js`**: makeDeposit/makeWithdrawal NO multiplican ×100 — no
  usarlos para plata (ver §4).
- **Message TTL 3 días; Transaction permanente.** Snapshot en ChatDelay por eso.
- **ChatStatus se crea con actividad**, no al crear el usuario.
- **Atribución de publicista** se fija al registrar; el login NO la cambia. El referido
  (`?ref=`) tiene prioridad sobre publicista en el front.
- **publisher_admin**: endpoint nuevo para ese rol ⇒ sumarlo a
  `PUBLISHER_ADMIN_ALLOWED_PATHS`.
- **`adminMiddleware` deja pasar 4 roles** — todo endpoint sensible re-chequea
  `role==='admin'` explícito (patrón #80; los CRÍTICOS ya están cerrados).
- **Tope 30% en bonos automáticos** (owner 2026-07-08): cap de lectura en
  `_getActivePromoBonus`, validaciones ≤30 en configs, plantillas bono_50/100
  eliminadas + guard en `_runStrategyLaunch`. Los botones manuales +50/+100 del modal
  de depósito QUEDAN (herramienta del agente).
- **Multi-instancia**: crons corren en cada instancia — la idempotencia vive en los
  índices únicos (slotKey, fireKey, chargeKey, userId+dateKey). No dropearlos. La
  blacklist JWT de src/middlewares/auth.js y `generalLimiter` son por-instancia.
- **USERS_LIST_FIELDS** (`GET /api/admin/users`) y la proyección de
  `AUTH_USER_FIELDS` (authMiddleware): campo nuevo consumido ⇒ sumarlo al select.
- **onclick inline** en panel y PWA dependen de `window.*` — no renombrar exports sin
  actualizar los strings. En `renderUsers` las comillas SIMPLES del onclick con JSON
  son a propósito.
- **CACHE de assets por proceso** (`readFileCached`, `_indexHtmlBase`,
  `_adminHtmlRendered`): index.html/admin.js/css se leen 1 vez por proceso — cambios
  llegan con el redeploy (que reinicia). No agregar contenido dinámico por-request al
  HTML sin pasar por `renderIndexHtml`.
- **Firebase config duplicada** (index.html + firebase-messaging-sw.js) y VAPID key en
  el inline: cambiar en ambos lados.
- **`X-Token` en royalty-statistics** y **`child_user_id` obligatorio** — cambiarlos
  rompe referidos Y reembolsos.
- **`_communityRecommendCard` (roulette.js)**: feature pedida por el owner que nunca
  se conectó — lee `VIP.state.communityLink*` que nadie setea (el wiring real de
  comunidad es `loadCommunity()` inline → `/api/config/community`). Es MEJORA
  PENDIENTE (reconectar seteando VIP.state desde loadCommunity), no código muerto.
- **`checkUsernameAvailability` (PWA)**: existe pero no se dispara — mejora pendiente.
- **vercel.json es un artefacto** de un deploy anterior; el deploy real es AWS EB.
- **Env DB_PASSWORD ya no se usa** (sección Base de Datos eliminada 2026-07-09).
