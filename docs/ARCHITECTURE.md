# ARCHITECTURE — Cómo funciona VIPCARGASANTINO

> Mapa arquitectónico para entender el repo y modificarlo sin romper nada.
> **No reemplaza leer el código** del área puntual que vayas a tocar — es la verdad
> y este doc puede quedar viejo. Úsalo como mapa, no como especificación exacta.
> Si encontrás algo desactualizado acá, corregilo.

Índice:
1. Visión general del negocio
2. Modelos de datos y relaciones
3. Ciclo de request / autenticación / roles
4. Integración JUGAYGANA
5. Flujos principales (paso a paso, con punteros a archivos)
6. Convenciones importantes
7. Trampas / "no rompas esto"

---

## 1. Visión general del negocio

Sala de juegos para Argentina que es un **wrapper sobre JUGAYGANA** (plataforma de
juego externa, `admin.agentesadmin.bet`). El sistema VIPCARGAS:
- Capta jugadores y los crea en JUGAYGANA por API.
- Gestiona **cargas** (depósitos) y **retiros** vía transferencia/CBU.
- Da **reembolsos** sobre la pérdida (diario/semanal/mensual), **ruleta diaria**,
  **fueguito** (racha), **referidos** y **campañas/publicistas**.
- El "saldo real" del jugador vive en JUGAYGANA; VIPCARGAS guarda atribución, bonos,
  reclamos y un registro de transacciones.

La UX del cliente es una PWA (`public/`) con chat en vivo (Socket.IO) + push (FCM).
Los agentes/admin operan desde `public/adminprivado2026/`.

## 2. Modelos de datos y relaciones (`src/models/`)

Todos los modelos canónicos viven en `src/models/`. `config/database.js` los re-exporta
(NO los redefine, salvo ExternalUser y UserActivity que son exclusivos suyos).

- **User** (`User.js`) — jugadores y staff. Campos clave:
  - `id` (uuid string, NO el `_id` de Mongo — casi todo el código usa `id`), `username`
    (único, case-insensitive en queries), `password` (bcrypt), `role`, `balance`,
    `phone`, `phoneVerified`, `phoneVerificationPending`.
  - Roles: `user`, `admin`, `depositor`, `withdrawer`, `publisher_admin`.
  - JUGAYGANA: `jugayganaUserId` (ID numérico del proveedor — clave para operar sin
    depender del lookup), `jugayganaUsername`, `jugayganaSyncStatus`, `source`.
  - Atribución: `acquisitionCampaign` (= Campaign.code), `acquisitionSource`
    ('organic'|'manual'), `createdByEmployeeId/Username`, `acquiredAt`,
    `acquisitionInfluencer` (sub-etiqueta dentro del publicista; sólo se setea
    cuando un publisher_admin elige un influencer de la lista de su campaña).
  - publisher_admin: `publisherCampaignCode` (la Campaign que representa).
  - FCM: `fcmToken` (legacy/último) + `fcmTokens[]` (multi-dispositivo).
  - Referidos: `referralCode`, `referredByUserId`, `referralStatus`.
  - Otros: `mustChangePassword`, `loginWithoutPassword`, `notificationPlan`,
    `installBonusClaimed`, `withdrawalAccount`, `registrationIp/UserAgent` (anti-multicuenta).
- **Transaction** (`Transaction.js`) — registro PERMANENTE (sin TTL) de movimientos.
  `type` ('deposit'|'withdrawal'|'bonus'|'refund'|'transfer'|'referral_commission'|'fire_reward'),
  `amount`, `bonus`, `username`, `userId`, `timestamp`, `metadata` (ej:
  `metadata.source` = 'install_bonus'|'welcome_gift' para excluir regalos de los reportes
  de carga real). **Fuente de la analítica de clientes.**
- **Campaign** (`Campaign.js`) — publicista/pauta. `code` (inmutable, en la URL),
  `publisher`, `name`, comisión, `isActive`, creds JUGAYGANA del sub-agente
  (`jugayganaUsername`, `jugayganaPassword` con `select:false`, texto plano), y
  `influencers: [{ name, isActive }]` — lista fija (sub-atribución por influencer,
  sólo para desglosar la analítica del publicista; sin link ni creds propias).
- **CampaignClick** — clics de links de pauta (TTL 90 días).
- **InfluencerStory** (`InfluencerStory.js`) — una "historia"/placement de un
  influencer: `{ campaignCode, influencer, postedAt, cost, label }`. Unidad de
  seguimiento de costo/ROAS. La atribución de registros a cada historia es por
  VENTANA HORARIA (createdAt del usuario ∈ [postedAt, postedAt de la próxima)) y se
  calcula a demanda en `publisherAnalyticsService.getInfluencerStoryAnalysis` (no se
  persiste el vínculo). Solo admin general. Endpoints `/api/admin/influencer-stories`.
- **ChatStatus** (`ChatStatus.js`) — estado de la conversación (open/closed/payments),
  category (cargas/pagos), `lastMessageAt`, `assignedTo`. La lista de Chats del panel se
  arma desde acá. **Se crea recién cuando el usuario tiene actividad** (ingresa o manda
  mensaje), no al crear la cuenta — para no mostrar chats vacíos.
- **Message** (`Message.js`) — mensajes del chat. TTL **3 días** (sobre `timestamp`).
  `senderRole` define de qué lado aparece (user vs admin/system). `adminOnly:true` =
  sólo lo ven los admins en el chat. `metadata.kind` marca tipos (ej: 'welcome').
- **RefundClaim** — reclamos de reembolso (índice único por periodKey evita doble reclamo).
- **FireStreak** — racha de fueguito.
- **Referral***: `ReferralCommission` (cálculo mensual por referido), `ReferralPayout`
  (pago agregado, soporta pagos incrementales/delta), `ReferralEvent` (atribución).
- **Command** (`Command.js`) — comandos `/...` editables, incluidos los `/sys_*` que son
  los mensajes automáticos del sistema (editables desde el panel, `isSystem:true`).
- **PromoBonus / BonusStrategyConfig / StrategyEnrollment / NotificationRule /
  NotificationRuleSuggestion / NotificationHistory / EncuestaVote / EncuestaFire /
  InactividadFire / ScheduledNotif / NotifTemplate** — sistema de notificaciones y
  estrategias automáticas (ver notificationRulesService, encuestaService, inactividadService).
- **Config** (`Config.js`) — key/value para configuración (CBU, flags de migración, etc.).

## 3. Ciclo de request / autenticación / roles

- `authMiddleware` (server.js ~L1028): toma JWT del header `Authorization: Bearer` o de
  la cookie httpOnly `admin_api_session`. Valida firma, busca el User por `id`, chequea
  `isActive`/`isBlocked`/`tokenVersion` (revocación de sesión). Si `role==='publisher_admin'`
  aplica lockdown contra `PUBLISHER_ADMIN_ALLOWED_PATHS` (solo puede tocar su whitelist).
- Middlewares de rol: `adminMiddleware` (admin/depositor/withdrawer), `depositorMiddleware`
  (admin/depositor), `withdrawerMiddleware` (admin/withdrawer), `publisherAdminMiddleware`
  (solo publisher_admin). Para acciones sensibles (ej: push masivo) se chequea
  `req.user.role === 'admin'` explícito.
- Secrets (`JWT_SECRET`, etc.) se cargan de AWS SSM en el bootstrap async (final de
  server.js), NO al require. Por eso hay lazy getters en `src/middlewares/auth.js`.
- El panel admin funciona por cookie (no guarda JWT en localStorage). `GET /api/admin/me`
  valida la cookie y devuelve un token fresco para Socket.IO.

## 4. Integración JUGAYGANA

Tres clientes, cada uno con su sesión:
- `jugaygana.js` — principal (server.js lo usa). Funciones: `ensureSession`,
  `createPlatformUser`, `lookupUserOrError` (tri-estado found/not_found/error),
  `depositToUser`, `withdrawFromUser`, `creditUserBalance` (bonus, acepta
  `jugayganaUserId` para saltear el lookup), `changeUserPassword`, `getUserNet*`.
- `jugaygana-movements.js` — endpoint alterno (makeDeposit/Withdrawal/Bonus, getUserBalance).
- `src/services/jugayganaService.js` — refactor usado por referidos.
- `src/services/jugayganaPublisherSessions.js` — pool de sesiones por publicista (creds
  por Campaign) para crear usuarios bajo el sub-agente correcto.

**Comportamiento clave:** JUGAYGANA es flaky — devuelve HTML (Cloudflare/rate-limit) de
forma intermitente. Todos los clientes tienen auto-retry + detección de HTML + renovación
de sesión. Los montos van en **centavos** al API (`amount * 100`). Las fechas se calculan
en hora Argentina (ART, UTC-3). NUNCA asumir respuesta inmediata; reusar estos clientes.

## 5. Flujos principales

- **Registro**: `POST /api/auth/register` (con OTP de teléfono) o `register-quick` (link de
  pauta, sin SMS). Crea User local + sincroniza a JUGAYGANA en background. Atribuye campaña
  si vino `campaignCode`. NO crea ChatStatus (se crea al ingresar).
- **Login**: `POST /api/auth/login` (server.js ~L1926). Valida password (con fallback
  asd123 para importados), setea cookies admin si es rol staff, devuelve JWT 30d. Importa
  desde JUGAYGANA si el user existe allá pero no localmente. NO fuerza cambio de password
  por asd123 (removido).
- **Bienvenida**: al entrar al chat, el front llama `POST /api/messages/welcome` →
  crea 2 mensajes de SISTEMA (lado admin) + upsert de ChatStatus. Throttle 24h server-side.
  Editable via comando `/sys_welcome`.
- **Depósito (admin)**: `POST /api/admin/deposit` → `jugaygana.depositToUser` → si hay
  bonus, pausa 700ms + `creditUserBalance` (con `jugayganaUserId`). Mensaje al cliente
  refleja el resultado REAL (si el bonus falla, no lo menciona + alerta admin-only).
  Registra Transaction(s). Mensajes editables `/sys_deposit`, `/sys_deposit_bonus`,
  `/sys_reminder`, `/sys_install_app`.
- **Retiro**: admin (`/api/admin/withdrawal`) y self-service (`/api/withdrawal/request`,
  mueve el chat a "pagos", mensaje `/sys_withdrawal_request`).
- **Reembolsos**: `POST /api/refunds/claim/{daily|weekly|monthly}` — consulta la pérdida
  neta a JUGAYGANA (`getUserNet*`), valida con índice único por periodKey, acredita.
- **Referidos**: `/api/referrals/admin/preview|calculate|payout`. El cálculo
  (`referralCalculationService.calculateCommissionsForPeriod`) consulta revenue por referido
  a JUGAYGANA — se hace en PARALELO (batches de 5) para no timeoutear. Payout en
  `referralPayoutService` (soporta pagos incrementales/delta).
- **Publicistas / atribución**: publisher_admin crea usuarios → quedan atribuidos a su
  Campaign. Análisis en `src/services/publisherAnalyticsService.js` (segmentación churn,
  ranking, recuperación por push). Endpoints `/api/admin/publishers/*`.
- **Notificaciones**: `notificationService.sendNotificationToUsernames/AllUsers` (FCM).
  Motores automáticos por cron: `notificationRulesService`, `encuestaService`,
  `inactividadService`. Recuperación de inactivos: `/api/admin/recovery/*`.

## 6. Convenciones importantes

- **Mensajes automáticos al usuario** → usar `renderSystemCommand(name, fallback, vars)`
  (server.js, helper). Sembrar el comando en el array `systemCmds` de `initializeData()`.
  Convención de variables: montos en el template como `${amount}` y se reemplaza `{amount}`
  por el número (el `$` queda como signo de peso); texto como `{username}` sin `$`.
- **Identidad de usuario**: usar `user.id` (uuid), no `_id`. Queries de username
  case-insensitive con regex anclado + `escapeRegex`.
- **periodKey**: formato `YYYY-MM` para referidos/comisiones.
- **Migraciones one-shot**: patrón con flag en `Config` (`migration_xxx_done`) para correr
  una sola vez en el bootstrap.
- **Montos JUGAYGANA**: centavos (×100) al enviar; algunos campos vuelven en centavos.
- **Validación local**: sólo `node --check` (no hay node_modules en el entorno del owner).

## 7. Trampas / "no rompas esto"

- **DOS `connectDB`**: el real es `config/database.js`; `src/models/index.js` NO se usa
  desde server.js. No definir schemas en config/database.js.
- **Secrets por SSM**: no leer `process.env.JWT_SECRET` al require; usar lazy getters.
- **JUGAYGANA flaky**: manejar HTML/timeout; no interpretar timeout como "no existe"
  (`lookupUserOrError` ya distingue error de not_found — no lo rompas).
- **Message tiene TTL de 3 días**; Transaction NO. La analítica/histórico va sobre Transaction.
- **ChatStatus** se crea con actividad, no al crear el usuario (sino aparecen chats vacíos).
- **Atribución de publicista** se fija al crear/registrar, el login NO la cambia.
- **publisher_admin** tiene lockdown estricto — si agregás un endpoint que ese rol deba
  usar, agregalo a `PUBLISHER_ADMIN_ALLOWED_PATHS`.
- **Referido (`?ref=`)** tiene prioridad sobre la atribución de publicista en el front.
