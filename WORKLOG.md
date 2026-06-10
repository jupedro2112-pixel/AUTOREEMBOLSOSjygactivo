# WORKLOG — Estado vivo del proyecto

> Se actualiza tras cada cambio significativo (ver regla en `CLAUDE.md`). El detalle
> commit por commit está en `git log --oneline`. Esto captura decisiones, umbrales de
> negocio y pendientes que NO se ven leyendo el código.
>
> **Última actualización: 2026-06-08**

## Sesión 2026-06-10

### 23. Renombrar influencer (con migración de usuarios) + borrar campaña definitivamente
- **Pedido:** poder corregir el nombre de un influencer cargado mal, y poder
  borrar campañas/publicistas definitivamente (además de desactivar, que ya existía).
- **Renombrar influencer:**
  - La analítica por influencer se calcula EN VIVO desde `User.acquisitionInfluencer`,
    así que renombrar SIN migrar los usuarios partiría las stats. Por eso el rename
    arrastra los usuarios del nombre viejo al nuevo.
  - **Front (editor de campaña):** botón ✏️ por influencer → `prompt` de nuevo nombre;
    queda pendiente con indicador "✎ antes: X" y se aplica al **Guardar**. Al cargar
    la campaña se taguea `orig` (nombre original) para detectar renombrados.
  - **Back (`PUT /api/admin/campaigns/:code`):** acepta `renames: [{from,to}]` y hace
    `User.updateMany({acquisitionCampaign, acquisitionInfluencer: /^from$/i}, {to})`
    antes de reemplazar la lista. Devuelve `renamedUsers` (se muestra en el toast).
- **Borrar campaña definitivamente** (lo que faltaba; el "DELETE" viejo era soft =
  isActive:false, igual que "Desactivar"):
  - **Back:** nuevo `DELETE /api/admin/campaigns/:code/permanent` (solo admin general):
    `Campaign.deleteOne` + `InfluencerStory.deleteMany` de esa campaña + invalida la
    sesión del pool. Los usuarios captados se CONSERVAN (quedan sin ref al publicista).
    Devuelve `attributedUsers`/`storiesDeleted`.
  - **Front:** botón "🗑️ Borrar definitivamente" en cada card de campaña, con doble
    confirmación. "Desactivar" (soft) se mantiene como estaba.
- **Pendiente/ofrecido:** las "Cuentas Publicistas" (publisher_admin) ya tienen
  activar/desactivar; si se quiere borrado definitivo de esas cuentas, se agrega aparte.
- **Validado:** `node --check` OK. El back necesita redeploy; el front, recargar el panel.

### 22. Fix 429 con MUCHOS admins a la vez (cupo por admin + no recargar fuera de Chats)
- **Síntoma:** con varios agentes trabajando en simultáneo, aparecía de nuevo
  "Demasiadas solicitudes" (429); ej: un admin en la sección Demoras veía
  "Error cargando closed" mientras otro agente contestaba en Chats.
- **Causa 1 (de fondo):** `generalLimiter` (300 req/min) estaba keyeado por **IP**.
  Varios agentes detrás de la misma IP (oficina/NAT) **comparten el cupo** → se
  429-ean entre todos. El fix anterior (#19) bajó el volumen por-admin pero no
  resuelve el pool compartido por IP con N admins.
- **Causa 2 (desperdicio):** estando en otra sección (Demoras, etc.), el panel
  igual recargaba la lista de conversaciones en background por cada mensaje de
  otros agentes (vía `scheduleConversationsRefresh` disparado por sockets).
- **Fix server (`server.js`):** `generalLimiter` ahora usa `keyGenerator` por
  **cookie de sesión** (`admin_api_session`) → cada admin logueado tiene su PROPIO
  cupo de 300/min, sin importar la IP compartida. Los clientes de la PWA (auth por
  header Bearer, sin esa cookie) siguen limitados por IP. `validate:
  { keyGeneratorIpFallback:false }` para no chocar con la validación IPv6 de la lib.
- **Fix cliente (`admin.js`):** `scheduleConversationsRefresh` corta temprano si la
  sección Chats no está activa (no recarga conversaciones cuando no las estás
  viendo). Al volver a Chats, `switchSection('chats')` recarga la lista una vez.
- **Validado:** `node --check` OK. El fix del cupo por admin requiere redeploy del
  server; el del cliente, recargar el panel.

### 21. Hora de envío visible en los mensajes automáticos (naranja) del chat admin
- **Pedido:** los mensajes automáticos del sistema (naranjas) no mostraban la hora;
  el owner quiere verla para corroborar demoras / horario de envío.
- **Causa:** `createMessageElement` (panel) renderizaba `type==='system'` sin la
  línea `.message-time` (a diferencia de los mensajes normales). En tiempo real,
  `addMessageToChat` los pintaba como burbuja normal (inconsistente).
- **Fix (solo `adminprivado2026/`):** la rama de sistema de `createMessageElement`
  ahora incluye `formatDateTime(timestamp)` (mismo formato "Hoy HH:mm" que el resto);
  `addMessageToChat` delega en `createMessageElement` para `type==='system'` →
  historial y tiempo real quedan idénticos (naranja + hora). CSS menor en `admin.css`.

### 20. Control de demoras de respuesta en chats (SLA de atención)
- **Pedido:** poder controlar cuánto tarda la atención. Si un cliente manda un
  mensaje y se tarda > umbral (default 2 min) en responderle, que quede registrado
  en algún lado con los minutos de demora y el mensaje que esperó.
- **Decisión clave por el TTL:** `Message` se borra a los 3 días, así que el reporte
  NO puede apoyarse en el historial de mensajes. Se creó una colección PERMANENTE
  nueva `ChatDelay` (sin TTL, como Transaction) que guarda un SNAPSHOT del texto.
- **Decisiones de negocio (confirmadas con el owner):** umbral CONFIGURABLE desde el
  panel (default 2 min, en Config `chatDelayThresholdSeconds`) · registrar demoras
  respondidas Y mostrar las "sin responder" · los comandos (/cbu, etc.) cuentan como
  respuesta. Ampliación de exactitud: cargas/retiros/bonus/CBU también cuentan como
  respuesta (atender al cliente sin escribir igual frena el reloj).
- **Modelo del "reloj":** vive en `ChatStatus` (`pendingSince`/`pendingPreview`/
  `pendingType`), en MongoDB → multi-instancia sin estado en memoria.
  - Cliente escribe → si no hay reloj corriendo, se setea `pendingSince` (se mide
    desde el PRIMER mensaje sin responder, no el último).
  - Agente responde (mensaje/comando/carga/retiro/bonus/CBU) → `delayClockResolve`
    limpia el reloj de forma ATÓMICA (findOneAndUpdate con doc previo, sin doble
    conteo si responden dos agentes a la vez) y registra `ChatDelay` si superó el umbral.
  - Chat cerrado con espera en curso → se registra como `unanswered`.
  - Helpers `delayClockOnUserMessage`/`delayClockResolve`/`delayClockClear` van todos
    envueltos en try/catch: una falla acá NUNCA rompe la entrega del mensaje.
- **Enganches:** socket `send_message` (user/agent/comando), HTTP `/api/messages/send`
  (idem), `chats/:userId/close` y `close-chat`, y los endpoints `deposit`/`withdrawal`/
  `bonus`/`send-cbu`. Los mensajes automáticos del sistema (bienvenida, etc.) NO cuentan
  (se crean por otro camino).
- **Endpoints (solo admin general, role==='admin'):**
  - `GET /api/admin/chat-delays?from&to&agent&status&minDelay&page` → `{ thresholdSeconds,
    waiting[] (esperando ahora, en vivo desde ChatStatus, solo status:open), delays[]
    (historial paginado), summary, pagination }`.
  - `POST /api/admin/chat-delays/config` `{ thresholdSeconds }` (10s–24h).
- **Panel:** sección nueva "⏱️ Demoras" (sidebar, oculta salvo admin general). Tarjetas
  de resumen (esperando ahora / cantidad / promedio / peor / sin responder), tabla
  "Esperando ahora", historial con filtros (fecha/estado/agente/demora mín.) + paginación,
  input de umbral en minutos, badge en el nav. Click en una fila abre el chat del cliente.
  Reusa clases existentes (sin CSS nuevo).
- **Sin migración:** colección nueva + campos opcionales nuevos en ChatStatus. Los chats
  abiertos viejos no tienen `pendingSince` hasta el próximo mensaje del cliente (correcto).
- **Validado:** `node --check` OK en server.js, admin.js y los modelos. (No se puede
  correr el server en Tails; sólo syntax check.)

## Sesión 2026-06-08

### 19. Fix 429 "Demasiadas solicitudes" en chats del admin con muchos chats activos
- **Síntoma:** con muchos chats activos, el panel admin tiraba "Demasiadas
  solicitudes. Intenta más tarde." (429) al cargar la lista de chats y al
  enviar mensajes; partes del panel dejaban de funcionar.
- **Causa raíz (confirmada, no corazonada):** el admin está en la sala `admins`
  y el backend hace `notifyAdmins('new_message', …)` por CADA mensaje del
  sistema entero (todos los usuarios, incl. automáticos de Fueguito/reembolso/
  depósito/bono). En el cliente, cada evento de socket disparaba requests SIN
  throttle:
  - mensaje de chat fuera del tab actual → `updateConversationInList` →
    `loadConversations(true)` = **4 requests** (reload forzado que saltea cache
    + 3 prefetch).
  - mensaje del chat seleccionado → `markMessagesAsRead` → `loadStats()` = 2 req.
  Con más chats activos = más throughput de mensajes en TODO el sistema = el
  panel se autobombardeaba hasta agotar el límite global de **300 req/min por
  IP** (`server.js:84`, `app.use('/api/', generalLimiter)`) → 429 en todo.
- **Fix (100% cliente, `public/adminprivado2026/admin.js`):** se eliminó la
  amplificación sin tocar el límite del server (subirlo habría enmascarado el bug):
  - `scheduleConversationsRefresh()`: throttle con **leading edge** — si hace
    >=4s que no hubo recarga refresca al instante (cero lag en uso normal);
    solo bajo ráfaga se limita a 1 cada 4s con recarga trailing (sin starvation).
    Ruteados a él: `updateConversationInList`, handler `chat_updated` (path no
    listado) y `conversation_updated`. Los chats que YA están en la lista se
    actualizan instantáneo en memoria (sin pasar por acá).
  - `loadConversations(force, {prefetch})`: en refrescos de fondo se omite el
    prefetch de mensajes (los 3 fetch extra).
  - `loadStatsThrottled()`: `loadStats()` a **máx 1 cada 5s** en los paths
    disparados por mensajes (`markMessagesAsRead`, handler `messages_read`).
    La insignia de no leídos ya se actualiza optimista + por evento `stats` del
    socket, así que no se pierde exactitud visible.
- **Qué NO cambió:** los updates en vivo de chats que YA están en la lista
  siguen instantáneos (path en memoria, sin HTTP). Solo chats nuevos/no listados
  esperan el refresh coalescido (≤4s). Recargas de baja frecuencia
  (`chat_closed`, `chat_moved`, `reconnect`) quedaron inmediatas.
- **Validado:** `node --check` OK. Sin cambios de backend ni de modelo.

## Sesión 2026-06-06

### 18. Ver usuarios por influencer + reasignar influencer (corregir errores del agente)
- **Caso:** a veces el agente crea un usuario y le asigna el influencer equivocado;
  se dan cuenta después al hacer el conteo (no en el momento, por eso no borran el
  usuario). Querían poder ver los usuarios de cada influencer y reasignarlos.
- **Clave de diseño:** la analítica por influencer/historia se calcula EN VIVO desde
  `User.acquisitionInfluencer`. Con sólo cambiar ese campo, las cargas/retiros/
  conteos del usuario se mueven solos al influencer correcto (no hay contadores
  denormalizados que arreglar).
- **Backend:**
  - `publisherAnalyticsService.getInfluencerUsers(campaign, influencer, page)`:
    lista paginada (20/pág) de los usuarios de ese influencer con sus stats
    (cargas/retiros/neto) + la lista de influencers de la campaña (para el desplegable).
  - `GET /api/admin/influencer-users?campaign=&influencer=&page=`.
  - `POST /api/admin/users/:userId/change-influencer` body `{influencer}`: valida
    que el nuevo influencer exista en la campaña del usuario (vacío = quitar),
    setea `acquisitionInfluencer`. **Sólo admin general** (role==='admin').
- **Frontend (pestaña "Por influencer"):** botón **👥 Usuarios** por fila → modal con
  la lista (username, registrado, cargas, retiros, neto) + **✏️ Cambiar** por fila →
  modal con desplegable de influencers de la campaña (+ "Sin influencer"). Al guardar,
  recarga la lista y refresca el breakdown. Botones de la tabla pasados a índice
  (`openInfluencerStoriesIdx`/`openInfluencerUsersIdx`) para no romper con nombres
  que tengan comillas.

### 17. Formato de fecha unificado a DD/MM/YYYY en todo el panel admin
- Helpers canónicos nuevos en `admin.js`: `fmtFechaAR(d)` → **DD/MM/YYYY** y
  `fmtFechaHoraAR(d)` → **DD/MM/YYYY HH:mm** (ambos en hora ART, día/mes con 2
  dígitos, año con 4). Expuestos en `window`.
- `formatDate`/`formatTime`/`formatDateTime` y los helpers locales `fmtDate` y
  `_centDate` ahora enrutan a los canónicos. Se reemplazaron ~15 usos sueltos que
  mostraban año de 2 dígitos (DD/MM/YY) o sin padding (6/6/2026).
- Las etiquetas relativas "Hoy/Ayer" del chat y los separadores por día de semana
  se mantienen (no son formato de fecha numérica).
- Sólo afecta el panel `adminprivado2026`. La PWA del cliente (`public/js`) no se tocó.

### 16. Performance: paginación server-side en Transacciones y Usuarios
- **Problema:** el panel se trababa al entrar a Transacciones (traía TODO desde el
  inicio de los tiempos, sin límite, y renderizaba todas las filas) y a Usuarios
  (traía TODOS los usuarios y filtraba/renderizaba en el navegador).
- **Transacciones** (`GET /api/admin/transactions`):
  - Ahora pagina (`page`, `limit` default 50). El **resumen de tarjetas** se calcula
    por AGGREGATION sobre el rango (fecha+usuario, TODOS los tipos) → sigue mostrando
    el desglose completo aunque haya un filtro de tipo activo. La **tabla** se filtra
    por tipo+fecha+usuario en el BACKEND (antes el tipo se filtraba en el cliente).
  - Se agregó `referrals` al resumen (antes la tarjeta "Referidos" quedaba en $0).
  - Front: default **HOY** la primera vez que se entra (flag `window._txDefaultsSet`);
    el filtro de tipo recarga server-side; controles de paginación bajo la tabla.
- **Usuarios** (`GET /api/admin/users`):
  - Ahora pagina (`page`, `limit` default 20) + **búsqueda server-side** (`search`)
    sobre username/email/phone/id/accountNumber (mismo criterio que el filtro
    client-side viejo). `allUsersCache` ahora guarda sólo la página actual.
  - Front: el buscador (debounced 300ms) recarga desde el backend; controles de
    paginación bajo la tabla. Columna "ID Cuenta" ahora usa `accountNumber`.
- **Sin cambios de modelo** (los índices de Transaction/User ya cubrían timestamp/
  type/username/role). **No rompe nada**: todas las acciones que recargaban listas
  siguen llamando `loadUsers()`/`loadTransactions()` (vuelven a página 1).
- **Pendiente (otros puntos pesados detectados, NO tocados):** `GET /api/admin/all-chats`
  trae TODOS los mensajes+usuarios+chatStatus; `/api/admin/campaigns` sin límite.
  Optimizar si el owner lo pide.

## Sesión 2026-06-05

### 15. Seguimiento de HISTORIAS por influencer (costo / ROAS por publicación)
- **Caso:** el influencer cobra POR HISTORIA (arranca ~20hs). El owner quiere
  cargar el precio de cada historia y ver cuántos registros/cargas trajo, CPA,
  ROAS, y si conviene repetir; comparar historia 1 vs 2, etc. Solo admin general.
- **Modelo nuevo `InfluencerStory`** (`src/models/InfluencerStory.js`): `{ campaignCode,
  influencer, postedAt (fecha+hora), cost, label }`. Registrado en `src/models/index.js`
  y requerido en server.js. Colección nueva, sin migración.
- **Atribución por VENTANA HORARIA** (no se persiste el vínculo, se calcula a
  demanda): las historias se ordenan por `postedAt` asc y cada una se queda con
  los usuarios (acquisitionCampaign+acquisitionInfluencer) cuyo `createdAt` cae en
  [postedAt_i, postedAt_{i+1}). La última agarra todo hasta ahora. Los usuarios
  creados ANTES de la 1ra historia van a un bucket `before` aparte.
- **Métricas por historia** (`publisherAnalyticsService.getInfluencerStoryAnalysis`):
  registros, clientes (cargaron ≥1), cargas (BRUTO lifetime de la cohorte, sin
  regalos), retiros, neto, FTD; CPA = costo/registros (y costo/cliente), ROAS =
  neto/costo (y bruto/costo). Devuelve filas por historia numeradas + `before` + totales.
- **Umbrales de "rentable" en el FRONT** (ajustables en vivo, no recalcula): ROAS
  objetivo (default 1) Ó CPA objetivo (default $10.000). Verdict 🟢/🔴 por historia.
  - Nota: la cohorte usa cargas LIFETIME, así que el ROAS de una historia sube con
    el tiempo (una historia puede volverse rentable más adelante).
- **Endpoints** (admin): `GET /api/admin/influencer-stories?campaign=&influencer=`
  (lista + métricas), `POST` (crear), `PUT /:id`, `DELETE /:id`.
  `getInfluencerBreakdown` ahora devuelve `campaignCode` por fila (la UI lo necesita).
- **UI:** en la pestaña "Por influencer" del análisis, botón **📖 Historias** por
  fila → modal `influencerStoriesModal`: form de carga (fecha + hora default 20:00 +
  costo + nota), inputs de umbral ROAS/CPA en vivo, tabla de historias (#1, #2…)
  con CPA/ROAS/veredicto + editar/borrar, fila TOTAL y "Antes de la 1ª historia".
  La hora se manda como instante absoluto (ISO) construido en la TZ del navegador.

### 14. Sub-atribución por INFLUENCER dentro de un publicista
- **Caso:** un publicista trabaja con varios influencers y quiere medir cuál
  rinde, sin crear una cuenta/campaña por cada uno. Solución: el influencer es una
  **sub-etiqueta** del publicista (lista fija gestionada), sólo para analítica.
  NO tiene link propio ni creds JUGAYGANA (decisión acordada con el owner).
- **Modelo:**
  - `Campaign.influencers: [{ name, isActive }]` — lista fija por campaña,
    gestionada por el admin general. `name` único case-insensitive (se dedup al
    normalizar en el backend).
  - `User.acquisitionInfluencer` (string, indexado) — guarda el NOMBRE del
    influencer elegido al crear el usuario (lista gestionada → sin typos).
- **Flujo:** el publisher_admin, al crear un usuario, elige un influencer de un
  desplegable. Si la campaña tiene influencers activos → **obligatorio**; si no
  tiene ninguno → el selector se oculta y crea sin influencer (idéntico a antes).
- **Backend:**
  - Helper `normalizeInfluencers(raw)` (server.js) — valida/dedup el array;
    usado por POST y PUT `/api/admin/campaigns` (PUT reemplaza la lista entera).
  - `create-user` valida el influencer contra la lista activa (match
    case-insensitive, guarda el nombre canónico) y lo setea en `acquisitionInfluencer`.
  - `GET /api/admin/publisher-admin/influencers` — lista activa para el desplegable.
  - `GET /api/admin/publisher-admin/users` ahora devuelve `acquisitionInfluencer`
    + acepta `?influencer=` para filtrar.
  - `publisherAnalyticsService.getInfluencerBreakdown(publisher)` — agrupa los
    usuarios del publicista por `acquisitionInfluencer` (bucket "Sin influencer"
    para los no asignados) y calcula las mismas métricas que el análisis general.
    Endpoint `GET /api/admin/publishers/:publisher/influencers`.
- **Frontend (adminprivado2026):**
  - Modal de campaña ("Publicidad"): editor de influencers (input + Agregar →
    chips con toggle activo y borrar). Se manda el array completo al guardar.
  - Panel publisher_admin: desplegable de influencer en crear-usuario + badge
    🎬 en "Mis usuarios".
  - Modal "Dashboard Publicistas": nueva pestaña **🎬 Por influencer** (tabla con
    clientes/cargas/neto/ticket/retención por influencer; se trae a demanda).
- **Nota / pendiente:** si renombrás un influencer, los usuarios viejos quedan con
  el nombre anterior (no hay migración de rename). Agregar si el owner lo pide.

## Features grandes construidas (sesión 2026-05-27 / 28)

### 1. Rol `publisher_admin` + atribución por publicista
- Cuenta dedicada por publicista, atada a una Campaign (`User.publisherCampaignCode`).
  Panel limitado: sólo crea usuarios + ve sus stats. No carga/retira/chatea.
- Usuarios creados quedan atribuidos: `acquisitionCampaign`, `acquisitionSource:'manual'`,
  `createdByEmployeeId/Username`.
- Lockdown en authMiddleware via `PUBLISHER_ADMIN_ALLOWED_PATHS`.
- Panel: sección "Cuentas Publicistas" (CRUD) + "Dashboard Publicistas" (totales).

### 2. Credenciales JUGAYGANA por publicista
- Campaign puede tener `jugayganaUsername` + `jugayganaPassword` (sub-agente). Si están,
  los usuarios que crea su publisher_admin se crean bajo esa cuenta JUGAYGANA (separa la
  venta/comisión). Pool: `src/services/jugayganaPublisherSessions.js`.
- **DECISIÓN:** password en TEXTO PLANO (campo `select:false`), SIN encriptación. Se
  quitó la master key `JUGAYGANA_CREDS_KEY` porque complicaba al owner. Trade-off aceptado.
- Cargas/retiros siguen por la cuenta master (tiene permiso sobre todos los subs).

### 3. Welcome de bienvenida por link de publicista
- Modal pre-auth de 2 pasos (explicación + beneficios + checkbox obligatorio → "Iniciar
  sesión"). Sólo si el visitante llegó por vanity URL (`/CODE` o `/publisher-slug`) o
  `?p=CODE`. localStorage evita repetir. `public/js/publisherwelcome.js`.
- Vanity URL matchea por código O por slug del publisher name.
- **Link genérico `/BIENVENIDO`**: el owner creó una Campaign "BIENVENIDO" y comparte ese
  link a todos los publicistas. Funciona porque la atribución la fija el publisher_admin
  al crear la cuenta (el login NO cambia atribución).
- Login customizado para visitantes de publicista: botón "⚡ Entrá YA y enviá tu
  comprobante", oculta "Registrarse", error pide credenciales de WhatsApp si faltan.
- Referido (`?ref=`) tiene PRIORIDAD: si viene por referido, no se aplica welcome/lockdown
  del publicista (sino no podría registrarse).

### 4. Fixes JUGAYGANA / depósitos
- `lookupUserOrError`: cualquier no-2xx (incl. 4xx) = error, no "not_found" → evita
  CREATEUSER sobre usuarios existentes ("user already existing").
- deposit/withdraw: si CREATEUSER dice "already existing", re-busca en vez de fallar.
- Mensajes "IP bloqueada" → "JUGAYGANA temporalmente no disponible (HTML/Cloudflare)".
- **Bug bonus**: `creditUserBalance` no reintentaba → a veces el bonus no entraba (la carga
  sí). Fix: 3 reintentos + pausa 700ms entre carga y bonus + usar `jugayganaUserId` guardado
  (evita el lookup que fallaba por paginación/sub-agente). Mensaje al cliente refleja
  outcome real; si falla, alerta admin-only en chat + toast al agente.

### 5. mustChangePassword por "asd123": REMOVIDO
- Usuarios con la contraseña default de JUGAYGANA ya NO son forzados a cambiarla.
  Migración one-shot limpió el backlog. Se mantiene el force SÓLO en reset manual de admin.

### 6. Mensajes automáticos como mensajes de ADMIN + editables
- Bienvenida server-side (`POST /api/messages/welcome`) como mensaje de sistema (antes
  salía del lado del usuario). Throttle 24h server-side.
- ChatStatus se crea recién cuando el usuario INGRESA o manda mensaje (no al crear la
  cuenta) → no más chats vacíos. Migración one-shot purgó los vacíos.
- Helper `renderSystemCommand(name, fallback, vars)`. Comandos `/sys_*` editables sembrados:
  deposit, deposit_bonus, bonus, withdrawal, reminder, install_app, welcome, cbu,
  withdrawal_request, install_bonus.

### 7. Fix referidos preview/calcular
- Daba "JSON.parse: unexpected character" = timeout (N llamadas secuenciales a JUGAYGANA,
  1 por referido). Fix: pre-fetch en paralelo (concurrencia 5). Frontend muestra mensaje
  claro si hay timeout.

### 8. Analítica de clientes por publicista (`src/services/publisherAnalyticsService.js`)
- Segmenta por última carga (Transaction): Activo ≤7d · En riesgo 8-21d · Perdido +21d ·
  Nunca cargó · Nuevo ≤7d.
- **UMBRALES ACORDADOS:** ticket alto = promedio ≥ $30.000; fiel = ≥5 cargas.
- Score 0-100 = 40% retención + 30% conversión a carga + 30% fuerza de ticket.
- Endpoints: `GET /api/admin/publishers/ranking`, `/:publisher/analysis`,
  `POST /:publisher/recover` (push a un segmento, solo admin general).
- Panel "Dashboard Publicistas": ranking con score + modal de análisis con segmentos +
  botón "Recuperar" (push FCM a en-riesgo/perdidos).

### 9. Análisis DIARIO por publicista (FTD / ROAS / recargas mismo día)
- `getDailyBreakdown(publisher, from, to)` en publisherAnalyticsService. Por día ART:
  - **FTD** (primera carga histórica de cada cliente): count + monto → para ROAS diario.
  - Total de cargas: count + monto.
  - **Clientes nuevos que recargaron el MISMO día** (ej: cargó 15hs y volvió 20hs):
    count de clientes + count de recargas (2da en adelante) + monto de recargas.
- Endpoint `GET /api/admin/publishers/:publisher/daily?from=&to=` (default últimos 30 días).

### 13. Fix lookup demasiado estricto ("API respondió sin formato esperado")
- En commit 596bf0f endurecí lookupUserOrError: si la respuesta era 2xx + JSON
  pero SIN array `users`/`data` → devolvía error directo. Eso rompía el caso
  legítimo donde JUGAYGANA responde algo tipo `{success:true}` SIN el campo
  `users` cuando la búsqueda no encuentra match.
- Fix: si 2xx + JSON sin array → asumir lista VACÍA → not_found. El caller
  (deposit/withdraw) tiene su propio recovery (CREATEUSER + manejo de
  "already existing"). Mantengo el rechazo a 4xx/5xx y a HTML — esos sí eran
  el bug original que quería evitar. Agregado log con preview de la respuesta
  cuando se cae a este caso, para investigar si pasa seguido.
- También se acepta ahora `data.result[]` además de `users[]`/`data[]`.

### 12. Fix bug "cambié creds JUGAYGANA pero los usuarios siguen yendo al sub-agente viejo"
- Causa: el pool de sesiones JUGAYGANA por publicista (`jugayganaPublisherSessions.js`)
  cachea las sesiones en memoria por 20 min. En deploys multi-instancia (AWS EB
  con auto-scaling), la invalidación tras editar la campaña corría solo en la
  instancia que recibió el PUT — las otras instancias seguían reusando la sesión
  vieja (token del sub-agente anterior) hasta que expirara.
- Fix: en `_ensureSession`, antes de reutilizar la sesión cacheada, cargamos las
  creds actuales de la DB y comparamos `credsSignature` (sha1 sobre user|pass)
  contra la firma que se guardó al loguear. Si cambiaron → descartar la sesión
  y re-loguear con las nuevas. MongoDB es la fuente de verdad compartida entre
  todas las instancias. Costo: 1 query chica por createUser.

### 11. Publisher_admin: buscador + paginación + cambiar contraseña
- Reemplazada la sección "Últimos usuarios creados" por "📋 Mis usuarios" con:
  - Buscador (substring case-insensitive sobre username, Enter o botón Buscar).
  - Tabla paginada: **10 usuarios por página**, orden por createdAt desc (más
    recientes primero), controles Anterior / Página X de N / Siguiente.
  - Botón 🔑 Cambiar contraseña por fila (sólo de usuarios que ÉL creó).
- Endpoints nuevos:
  - `GET /api/admin/publisher-admin/users?page=&search=` (10 por página, sort
    desc, filtra por createdByEmployeeId=mi.id + acquisitionSource=manual).
  - `POST /api/admin/publisher-admin/users/:userId/change-password` con doble
    check de seguridad (target.createdByEmployeeId === mi.id Y role==='user'),
    bumpea tokenVersion (invalida sesiones del cliente), sincroniza la nueva
    contraseña a JUGAYGANA en background vía syncPasswordToJugaygana.
- Refresh automático de la lista tras crear un usuario.

### 10. "Cliente" = sólo los que cargaron + modal de análisis en 3 pestañas
- **DECISIÓN:** un "cliente" ahora es SÓLO quien cargó al menos 1 vez. Los que nunca
  cargaron NO cuentan como clientes (antes "CLIENTES 11" con 5 sin cargar; ahora "6").
  El métrico expone `clients` (depositores), `registered` (todos), `neverDeposited`.
  conversionRate = clients/registered (registrado→cliente).
- Modal de análisis reorganizado en 3 pestañas (más claro/elegante):
  - **✨ Usuarios nuevos**: FTD diario (count+monto para ROAS) + nuevos que recargaron mismo día.
  - **💰 Cargas totales**: total cargado/retirado/neto + tabla diaria de cargas + 💎 ticket alto + 👑 fieles.
  - **🔄 Retención**: activos/en riesgo/perdidos + botón Recuperar (push). Los "nunca cargaron"
    aparecen sólo como nota ("X registrados sin cargar"), no como clientes.
- Ranking: columna Clientes = depositores (muestra "+N sin cargar" en gris).

## Pendientes / ideas mencionadas (NO hechas)
- Mensaje de fueguito editable: hoy se arma del lado del cliente (fire.js →
  sendSystemMessage). Requiere mover la generación al backend.
- Push de recuperación AUTOMÁTICO (cron que detecte clientes que pasan a "en riesgo").
- Gráfico de evolución mes a mes por publicista.
- Bases de referidos MUY grandes: el preview podría seguir acercándose al timeout → subir
  idle timeout del ALB (config AWS) o calcular por referidor específico (ya soportado via
  `referrerUserId`).
- Mensajes operativos NO editables a propósito (alerta bonus fallido, error sync password,
  "comando no encontrado", "chat movido a pagos", "chat cerrado", "contraseña cambiada por
  admin"). Pasar a editables si el owner lo pide.

## Notas operativas
- Reiniciar el server tras deploy → corren las migraciones de startup y se siembran los
  comandos `/sys_*`.
- No hay `node_modules` en el entorno local del owner (Tails) → sólo se puede validar con
  `node --check` (syntax), no correr el server.
