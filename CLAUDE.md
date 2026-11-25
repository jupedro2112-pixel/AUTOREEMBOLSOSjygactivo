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

Git remote de ESTE clon: `github.com/jupedro2112-pixel/AUTOREEMBOLSOSjygactivo` (gemelo de
vipcargas para autoreembolsos.com; el hermano vive en `VIPCARGASANTINOactivo`, ex
`VIPCARGASANTINObackupviejo`). Confirmar con `git remote -v`. Git user: jupedro2112-pixel.

> **MUDANZA a jugaygana.io (#197, 2026-11-18) — IMPLEMENTADA usuario por usuario, APAGADA por defecto.** Las dos plataformas
> conviven: `User.platform` (`'jugaygana'` | `'partner'`) dice cuál usa cada usuario y **`src/services/platform.js` (`plat` en
> server.js)** rutea. La mudanza de un usuario (retiro total en la vieja → carga en jugaygana.io, tope $200.000) se dispara al abrir la
> app o cargar, y se controla desde el panel **🚚 Mudanza** (solo admin general). Con el modo en "Apagada" nada cambia. Detalle en
> `docs/ARCHITECTURE.md` §10 y WORKLOG #197; la API en `docs/1girox/` (lo medido en jugaygana.io: `CONOCIMIENTO-EN-PRODUCCION.md` §15).
> La app CREA al jugador en jugaygana.io al mudarlo, con la **key del equipo** que le toca por el inicio de su username (sin
> coincidencia → key general); `User.partnerTeam` lo deja fijo y `plat.keyResolver` firma todo lo suyo con esa key.
> Al terminar la mudanza se **cierra la cuenta vieja** de JUGAYGANA con una clave al azar que no se guarda (#198,
> `plat.lockOldAccount`): nada que necesite la clave del JUGADOR en la vieja puede asumir que un usuario `partner` la tiene.
> Las API keys NO van en ningún archivo del repo: se cargan desde el panel.

## Estructura

- `docs/1girox/` — documentación y código de referencia de la Partner API (1girox / jugaygana.io).
  No lo importa nadie; es el mapa de la mudanza (ver la nota de arriba).
- `src/services/finproService.js` — cliente de Finpro, el SEGUNDO banco con API (#202; hgcash es el primero). Detalle en `docs/ARCHITECTURE.md` §11.
- `src/services/platform.js` — fachada de plataforma + motor de mudanza (#197). `src/services/giroxService.js` — cliente de la
  Partner API (jugaygana.io). `src/models/PlatformMigration.js` — libro de la mudanza.
- `server.js` (~23k líneas) — entry point. ~180 rutas, authMiddleware inline (~L2477),
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
- `src/models/` — schemas Mongoose canónicos (fuente de verdad). Banco: BankMovement,
  BankSweep (bajadas), DailyClose (cierre), CashierSnapshot (saldo cajero JUGAYGANA).
- `src/services/` — lógica (referidos, notificaciones, otp, metaCapi, fbAds, hgcash,
  comprobantes IA, analítica publicistas…).
- `public/` — PWA del cliente (namespace global `window.VIP`, SW único
  `firebase-messaging-sw.js`). `public/adminprivado2026/` — panel admin (~12k líneas
  de admin.js, cookie httpOnly, SW propio `admin-sw.js` con scope /adminprivado2026/).

## Cosas que NO hay que romper (gotchas)

- **Página del casino (#193):** se cambia en COMANDOS → `/sys_casino_url` (solo admin general; vacío = jugaygana44.bet). La PWA la pide en
  `GET /api/config/casino-url`. JUGAYGANA no tiene login automático al casino: solo cambia el link. Usar `getCasinoPlayUrl()`, nunca el
  dominio fijo. Test: `node scripts/test-casino-url.js`.

- **Plata SIEMPRE por `plat.*` (#197):** `plat.depositToUser / withdrawFromUser / creditUserBalance / makeBonus /
  getUserBalance(WithRetry) / getUserNetwinForDateRange` (misma firma que los clientes viejos + `opts` al final). No llamar a
  `jugaygana.depositToUser` ni a `girox.*` directo desde un flujo: se le manda plata a la plataforma equivocada. Si el flujo tiene un
  id natural, pasar `opts.reference` estable (`vip-<flujo>-<id>`); devolución o comisión → `ignoreGlobalRollover:true`. Un resultado
  `code:'migrating'` = la cuenta se está mudando: no se movió nada, tratarlo como fallo común. Para validar un retiro usar
  `plat.withdrawable(saldo)`, no `saldo.balance`; si el saldo viene con `migrating:true` es "reintentá en un minuto", nunca "saldo
  insuficiente" (#201). El candado `User.platformMigrating` solo se suelta donde no hay plata en tránsito (ver ARCHITECTURE §10.3b).
  Test: `node scripts/test-platform-migration.js`.
- **Rollover por tipo de regalo (#205):** todo regalo/bono nuevo pasa `opts.rolloverFlow` (`refund`/`fire`/`roulette`/`bonoAuto`/`bonoManual`,
  o uno nuevo sumado a `GIFT_ROLLOVER_FLOWS` en server.js) a `plat.creditUserBalance/makeBonus`; el owner lo prende/apaga en COMANDOS.
  Sin flujo cae al rollover global. Plata del cliente (devolución, comisión) sigue con `ignoreGlobalRollover:true`.
- **Regalo a un jugador con bono activo = UNIFICAR (#222, réplica #236–#239 de CARGASGIROXactivo; solo jugaygana.io):** con rollover > 0,
  `girox.creditGift` otorga un bono por `bonus_locked + regalo` (`result.mergedOld` / `mergedTotal`); modo en
  `Config['bonusRolloverGlobal'].fallback` (`merge` | `deposit` | `bonus0`, COMANDOS → Rollover de regalos y bonos). **Nunca usar
  `mergedTotal` como monto del regalo** en la contabilidad local. Todo regalo nuevo guarda `..._giftMeta(result)` (o `_giftMetaFields`
  dentro de su `metadata`) y manda `opts.description` empezando por el TIPO en mayúsculas (`REEMBOLSO…`, `REGALO — …`, `BONO…`,
  `COMISIÓN…`, `DEVOLUCIÓN…`): ese texto solo viaja a jugaygana.io. Quien escriba `bonusRolloverGlobal` conserva `fallback`.
  Detalle en `docs/ARCHITECTURE.md` §10.3e. Test: `node scripts/test-gift-fallback.js`.
- **Corte fijo 1-ene-2027 (#204):** desde esa fecha un usuario mudado NO suma lo jugado en la JUGAYGANA vieja (reembolsos / referidos):
  `OLD_NETWIN_CUTOFF_MS` en `platform.js`, hardcodeado a pedido del owner ("irremovible"). No convertirlo en config ni moverlo sin que lo pida.
- **JWT_SECRET y otros secrets** se cargan desde AWS SSM en el bootstrap async, NO al
  `require()`. Por eso hay lazy getters en `src/middlewares/auth.js` y rutas.
- **JUGAYGANA es flaky** (Cloudflare → responde HTML). Hay auto-retry + manejo de HTML
  en los clientes. No asumir respuestas inmediatas; reusar los clientes existentes.
- **Registro con SMS obligatorio (#166):** `/api/auth/register` exige phone+otpCode; un celular
  = una cuenta (`phoneKey`). `register-quick` está cerrado (410). No reabrir "sin SMS" sin el owner.
- **Roles:** `user`, `admin` (todo), `depositor` (solo cargas), `withdrawer` (solo
  retiros), `publisher_admin` (solo crea usuarios de su publicista — lockdown via
  `PUBLISHER_ADMIN_ALLOWED_PATHS`).
- **Auth:** JWT por header Authorization O por cookie httpOnly `admin_api_session`
  (el panel admin usa cookie).
- **Credenciales hgcash (#181):** el token de API y el secreto del webhook pueden venir del
  PANEL (Banco automático → "🔐 Cuenta hgcash conectada", cifrados con `JWT_SECRET` en
  `Config['hgcashCredentials']`) y MANDAN sobre `HGCASH_API_TOKEN`/`HGCASH_WEBHOOK_SECRET` de
  SSM. Toda llamada a hgcash usa `hgcashPay.getToken()`, nunca `process.env` directo; el
  webhook valida con `_hgcashWebhookSecrets()` (panel y/o SSM). Destinos del reenvío de
  webhooks también desde el panel (`Config['hgcashFanout']`).
- **Cuentas hgcash (hasta 3, #194 — réplica #223/#223b de CARGASGIROXactivo):** hasta 3 cuentas cargadas desde el
  panel (cifradas en `Config['hgcashAccounts']` con clave derivada de JWT_SECRET; panel > SSM; lo de una sola cuenta de antes se
  migra solo a `a1`) y UNA activa que se rota con el botón "USAR ESTA" (card "🏦 Cuentas hgcash" de la sección **🏛️ Bancos — Configuración** del panel, #195, debajo de Comandos, solo admin general; también la barra de 🏦 Banco;
  la pueden tocar admin/depositor/withdrawer). La activa paga y es lo que ve el cliente (al activar se reescribe `Config['cbu']`);
  **las cargas entran por TODAS** (el webhook acepta cualquiera de los secretos y etiqueta `BankMovement.accountKey`) salvo que el
  panel diga "solo la en uso" o pause una cuenta (`incomingMode` / `incomingEnabled` → `_hgAccountReceives`; lo pausado queda en la bandeja,
  no se carga solo — todo matcheo automático nuevo tiene que respetar `_hgMovementAutoOff(m)`). Un pago recuerda su cuenta
  (`hgAccountKey`): toda consulta nueva a hgcash sobre un pago existente tiene que pasar `_hgTokenFor(x.hgAccountKey)`, y todo
  flujo nuevo que pague tiene que guardar `hgAccountKey: _hgActiveKey`. No volver a leer `process.env.HGCASH_API_TOKEN` directo:
  usar `hgcashPay.getToken()` / `_hgcashWebhookSecretEntries()`.
- **Dos bancos con API: hgcash y Finpro (#202, réplica #217–#220 de CARGASGIROXactivo + hasta 3 cuentas Finpro):** tres llaves en
  **🏛️ Bancos — Configuración → 🏦 Bancos automáticos**: por dónde ENTRAN las cargas (`hgcash.enabled` / `Config['finpro'].enabled`), por dónde
  SALEN los retiros (`getBankProvider()`) y qué cuenta VE el cliente (`getBankShown()`: solo ese banco reescribe `Config['cbu']`). Las cuentas
  Finpro (`Config['finproAccounts']`, cifradas, panel > SSM) funcionan como las de hgcash: una EN USO, las otras de respaldo. Reglas: un pago
  existente se consulta con **`_fpCtxFor(p.fpAccountKey)`**, nunca con la cuenta en uso; todo flujo nuevo que pague por Finpro guarda
  `fpAccountKey`; `_hgMovementAutoOff(m)` ya cubre los dos bancos (seguir usándolo); un `BankMovement` sin `provider` es de hgcash; nunca se
  reenvía un lote de Finpro sin respuesta (se consulta con `_finproSyncPayout`); un texto nuevo sobre una carga usa `_bankLabel(m.provider)`.
  Las credenciales NO van en el repo. Tests: `node scripts/test-finpro-accounts.js` y `node scripts/test-finpro-webhook.js`.
- **Retiro "VERIFICANDO" (#221):** un envío a hgcash sin respuesta clara deja el retiro `failed` + `hgSendUnknown` + `verifyUntil` (3 min):
  el pago pudo haber salido. Toda ruta que pague, marque pagado, rechace o descarte un `PendingPayout` llama a `_payoutVerifyBlock(payout)`
  primero. El cartel del chat (`?status=chat`) muestra también EN PROCESO y FALLADO: no volver a esconderlos.
- **Salientes del banco SIEMPRE vinculados (#220):** una salida que el banco informa sin vínculo a un retiro o bajada (`outKind:'unknown'`)
  dispara `_alertUnknownOutbound` (Telegram + "POSIBLE PAGO DOBLE" en el chat). Todo flujo nuevo que saque plata del banco tiene que mandar
  su `externalID` / dejar `payoutId` o `sweepId`, o va a alertar en falso. Un pago confirmado por Finpro manda `maybeSendFinproReceipt`
  (comprobante en texto con COELSA, `/sys_payout_receipt_finpro`).
- **Pagos de retiros: candado anti pago doble (#219, incidente 2026-11-20 de $2,4M):** la idempotencia del banco solo vale dentro de UNA
  cuenta. Todo camino que mande un retiro llama a `_payoutResendGuard(...)` antes de reclamarlo, `_payoutNoteSend(...)` justo antes del POST
  al banco y `_payoutNoteResult(...)` con la respuesta. En hgcash el token va EXPLÍCITO (`createCashOut({ token })`, cuenta fijada al empezar
  el pedido), nunca el global de "la cuenta en uso". No aflojar la espera de 2 minutos ni dar por "rechazado" un envío sin respuesta clara.
  Test: `node scripts/test-payout-guard.js`.
- **De qué cuenta sale un retiro (#223):** lo decide `_payoutPickSource` (elegida para ese retiro > `Config['payoutSource']`:
  en uso / fija / la de más saldo) y queda en `req._paySrc`; los dos caminos de pago usan ESA cuenta, no "la que está en uso".
  Un token de hgcash puede ver varias cuentas: la de un perfil la resuelve `_hgPickApiAccount` (fijada a mano > CBU > titular);
  nunca volver a tomar "la primera de la lista". Detalle en `docs/ARCHITECTURE.md` §11.4b. Test: `node scripts/test-payout-source.js`.
- **Rotación automática de cuentas (#207):** `_bankRotationTick` puede cambiar SOLA la cuenta en uso (y, entre bancos, `bankShown` /
  `bankProvider`). Nada debe asumir que la cuenta en uso es la misma que hace un rato: seguir usando `hgAccountKey` / `fpAccountKey` del pago.
  Un banco o cuenta nuevos se suman a `_rotSlots()` / `_rotProbe` / `_rotSlotBlocked`. Test: `node scripts/test-bank-rotation.js`.
- **Config sensible desde el panel:** sección "🔐 Config privada" (clave propia hasheada
  en `Config['privateconfigpass']`; hoy: IA de comprobantes en `Config['aiconfig']`,
  prioridad panel > env/SSM > default; SMS Masivo usa esa misma clave). Para una
  config nueva que el owner quiera editar sin SSM, sumarla AHÍ (endpoints
  `/api/admin/private-config/*`).
- **Auditoría de atención (#132):** cada mensaje del cliente pasa por reglas
  (`_auditRulesOnUserMessage`) y cada conversación quieta por la IA (`_auditConversation`);
  resultados en `ChatAudit`, panel 🕵️ Auditoría y Telegram. Un hook nuevo de "mensaje del
  cliente" o de "carga/pago acreditado" tiene que respetar esos puntos de enganche.
- **PLATA y reintentos (incidente #151):** ninguna operación de plata contra JUGAYGANA
  se reenvía a ciegas. `creditUserBalance/depositToUser/withdrawFromUser` verifican por
  saldo ante HTML/timeout y devuelven `ambiguous:true` si no pueden confirmar; todo
  caller nuevo tiene que tratar `ambiguous` como "frenar + `_alertMoneyAmbiguous`",
  nunca como "reintentar" ni "liberar la reserva".
- **Bonos automáticos en la carga (#149):** una carga (manual sin bonus o hgcash)
  puede sumar el % de un "Lote con regalo" vía `claimAutoPromoPercent` (reserva
  atómica en PromoBonus). Un flujo de carga nuevo tiene que llamarlo y hacer
  settle/revert; nunca sumar dos bonos automáticos entre sí.
- **Bandeja del banco / cierre diario (#155):** una transferencia hgcash = UNA acreditación.
  Toda carga que venga del banco tiene que dejar el vínculo en las dos direcciones
  (`BankMovement.transactionId`+`chargeSource` y `Transaction.metadata.movementId`), y la
  carga asignada desde la bandeja va SIEMPRE por `hgcashAutoCarga({assign})`. Si no, el
  cierre diario (`src/services/bankCloseService.js`, Telegram 00:05 ART) lo marca.
- **Anti-multicuenta por BANCO (#152):** el titular de origen del movimiento hgcash
  (`BankMovement.fromKey`) es la identidad real. Un flujo de bono automático nuevo
  ligado a una carga tiene que respetar `_findBankMultiAccount` /
  `_bankMultiAccountForUser` (si hay dup → sin bono automático, la carga entra igual).
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
- **% de referidos por NIVEL (#171):** la tasa de un referidor NO es fija: sale de
  `referralTierService.resolveReferralRate(user)` (override > niveles por referidos activos >
  % plano). Todo cálculo/copy nuevo que muestre o pague comisión usa ESE resolver, no
  `getReferralRateForUser` (sync, sólo conoce el % plano). Nada de premios en plata por
  cantidad de referidos: se estafaban con cuentas falsas (owner 2026-09-29).
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

- **Lotes y Cronograma (#190):** el POST `/api/admin/notif-batches` es un wrapper de
  `_createNotifBatchFromBody(body, user)`; cualquier validación/efecto nuevo del lote va en esa
  función (así lo heredan las campañas programadas). Las rutas del cronograma son
  `/api/admin/cronograma*` porque `/api/admin/campaigns` YA es de publicistas: no reusar ese path.
  El compositor push (`/api/notifications/send-batch`) es un wrapper de `sendBatchPush` en
  `notificationRoutes.js` (misma regla: lo nuevo del envío va en la función).

- **TDZ en server.js (incidente #133):** `authMiddleware`, `adminMiddleware`, etc. son
  `const` definidos en ~L3270-3400. **Toda ruta `app.get/post(...)` que los use tiene que
  estar DESPUÉS de esa línea** (las funciones sí pueden ir antes: hoisting). Si no, el
  server muere al arrancar con "Cannot access 'X' before initialization" y `node --check`
  NO lo avisa. Ante una ruta nueva, ubicarla cerca de rutas existentes similares.

## Flujo de trabajo del asistente

1. Leer `WORKLOG.md` al iniciar.
2. Hacer el cambio. Validar sintaxis (`node --check` en archivos tocados — no hay
   node_modules local, así que no se puede correr el server; sólo syntax check).
3. Actualizar `WORKLOG.md`.
4. Commitear y pushear a `main` cuando el owner lo pida (o si pidió "todo seguido").

## Reglas permanentes del owner (valen en TODOS sus repos)

- **AUDITAR ANTES DE REPLICAR (owner, 2026-11-25):** cuando un cambio se va a replicar a los demás repos con subagentes,
  ANTES se lanza un subagente auditor independiente que revise errores al detalle y en profundidad sobre lo implementado en el
  repo de origen (se le da el diff y el código, no la conclusión). Recién con sus hallazgos corregidos se replica — y conviene
  hacerlo también antes de decirle al owner que despliegue. Motivo: un subagente que replicaba encontró un error ya desplegado
  (una `function` nueva con el mismo nombre que otra existente, que la pisaba por hoisting). Chequeo mínimo propio antes de cerrar
  un cambio en `server.js`: buscar declaraciones `function` duplicadas
  (`grep -oE '^(async )?function [A-Za-z0-9_$]+' server.js | awk '{print $NF}' | sort | uniq -d` tiene que salir vacío);
  ni `node --check` ni los tests lo avisan.
- **El "reembolso en vivo" (cashback acumulativo) NO se usa (owner, 2026-11-25):** está apagado en todas las apps y no se va a
  usar. No plantear riesgos, pendientes ni trabajo sobre ese flujo salvo que el owner lo pida.
