# WORKLOG — Estado vivo del proyecto

> Se actualiza tras cada cambio significativo (ver regla en `CLAUDE.md`). El detalle
> commit por commit está en `git log --oneline`. Esto captura decisiones, umbrales de
> negocio y pendientes que NO se ven leyendo el código.
>
> **Última actualización: 2026-06-19**

## Sesión 2026-06-19

### 49. Oferta "100% recuperación" post-carga + etiqueta "NO Comunidad" + fix SLA auto-carga + fix UI pestañas
- **Mensaje de recuperación tras carga:** después de una carga (manual `/api/admin/deposit` o automática
  `hgcashAutoCarga`) se envía un mensaje ofreciendo el 100% de recuperación para que entre a la Comunidad.
  Editable desde COMANDOS: **`/sys_recover_100`** (si se vacía, no se envía). Helper `maybeSendRecoveryMessage(user)`.
  - **Anti-spam:** NO se envía si el cliente tiene la etiqueta `comunidad` (ya está) o `no comunidad` (ya dijo que no).
    En ese caso solo recibe el mensaje normal de depósito.
- **Etiqueta predefinida "NO Comunidad":** botón rápido **"+ NO Comunidad"** al lado de "+ Comunidad" en el chat,
  para marcar a quien no quiere entrar y dejar de ofrecerle. Chip gris en la lista (vs verde de 'comunidad').
- **Fix SLA (Demoras):** cuando un comprobante se auto-cargaba, el chat quedaba como "sin respuesta" con demoras
  largas (la carga es automática, no la tomaba como respuesta). Ahora `hgcashAutoCarga` llama a `delayClockResolve`
  (responded:true, via:'auto_carga') al acreditar → frena el reloj. La carga manual ya lo hacía (L6205).
- **Fix UI pestañas de Chats:** con 4 pestañas (Abiertos/Comunidad/Cerrados/Pagos) la última quedaba tapada y no se
  podía scrollear. CSS `.tabs` ahora tiene `overflow-x:auto` y `.tab-btn` `flex:0 0 auto` + `white-space:nowrap`
  (cada pestaña a su ancho, la fila scrollea horizontalmente).
- **Validado:** `node --check` OK (server.js, admin.js).

### 48. Botón "Descartar" para limpiar pagos pendientes viejos (sin avisar ni devolver)
- **Caso:** quedaron `PendingPayout` viejos en `pending_review` (de cuando el pago automático no andaba y se
  dio la orden de NO marcarlos). Ya se pagaron en su momento y el cliente siguió jugando. No sirve "Pagar con
  otro banco" (avisaría al cliente) ni "Rechazar" (devolvería fichas que no corresponden).
- **Solución:** botón **🗑️ Descartar** en el banner del retiro, **solo visible para el admin general**. Endpoint
  `POST /api/admin/payouts/:id/dismiss` (withdrawerMiddleware + check `role==='admin'`): marca el payout
  `cancelled` con `paidVia:'dismissed'`, `chipsReturned:false` y nota de auditoría. **NO** devuelve fichas, **NO**
  llama a hgcash, **NO** envía ningún mensaje al cliente. Reclamo atómico desde `pending_review`/`failed`.
- **Uso:** abrir el chat de cada cliente afectado → el banner del retiro muestra "🗑️ Descartar" (solo admin) →
  confirma → el cartel desaparece sin avisar nada. Es para limpieza puntual de pagos viejos ya resueltos.
- **Validado:** `node --check` OK (server.js, admin.js).

### 47. Sección de chat "Comunidad" + rol "comunidad" + etiquetas en la lista de chats
- **Rol nuevo `comunidad`:** clon de `depositor` (mismas funciones: cargas, bonus, fire-bonus) + ve la sección
  Comunidad − NO ve Pagos. Agregado a: enum `User.role`, `ADMIN_ROLES`, `adminMiddleware`, `depositorMiddleware`
  (NO `withdrawerMiddleware`), `validRoles` (x3: crear/editar usuarios), `isAgent` (User.js), y al `<select>` de crear
  admin (index.html). Labels y detección de "rol admin" en el panel (`getMessageType`, `isAdminUser`, `getRoleLabel`).
- **Sección "Comunidad":** nuevo valor `status:'comunidad'` en `ChatStatus`. Pestaña al lado de Abiertos, visible solo
  para `admin` y `comunidad` (`setupRoleBasedUI`). Endpoint `POST /api/admin/send-to-community` (clon de send-to-payments):
  setea `status:'comunidad'`, manda mensaje editable `/sys_community` al cliente, emite `chat_moved → to:'comunidad'`.
  Botón "Derivar a Comunidad" (verde) en Abiertos para admin/depositor/comunidad; en la pestaña Comunidad el botón
  pasa a "Enviar a Abiertos" (sendToOpen).
- **Visibilidad backend** (`GET /api/admin/conversations`): depositor bloqueado de `payments` Y `comunidad`;
  comunidad bloqueado de `payments`; withdrawer solo `payments`. El pipeline ya soporta cualquier status.
- **Alerta visible:** al derivar a Comunidad, el agente comunidad (y admin) recibe sonido + toast + notificación del
  navegador + **badge rojo con contador en la pestaña Comunidad** (se limpia al entrar a la pestaña). Helpers
  `bumpComunidadAlert`/`renderComunidadBadge`/`clearComunidadAlert`. La alerta NO molesta a depositor/withdrawer.
- **Bloqueo de re-derivación:** si el cliente YA tiene la etiqueta `comunidad`, `send-to-community` devuelve 400 (decisión:
  la etiqueta se pone SOLO a mano con "+Comunidad"; derivar NO la agrega).
- **Etiquetas en la lista de chats (#6):** `GET /api/admin/conversations` ahora proyecta `tags`; `renderConversations`
  pinta los chips de etiqueta en cada tarjeta (verde si es 'comunidad', dorado el resto) — sin entrar al chat.
- **Mensaje editable `/sys_community`:** sembrado en `systemCmds` (si se vacía, no se envía, vía renderSystemCommand).
- **Sin romper nada:** un chat en Comunidad NO se reabre solo cuando el cliente escribe (el reopen solo aplica a `closed`);
  `send-to-open` lo devuelve bien a Abiertos. SLA: los chats de comunidad se tratan como cola 'cargas' y NO aparecen en
  "esperando ahora" (no se agregó al `$in`), sin romper el tracking existente.
- **Validado:** `node --check` OK (server.js, ChatStatus.js, User.js, admin.js).
- **Pendiente tuyo:** crear una cuenta con rol "Admin Comunidad" desde el panel; redeploy del back (siembra `/sys_community`
  y activa el endpoint); recargar el panel.



### 44. Movimientos hgcash: mostrar CBU origen + destino + usuario del pago
- **Pedido:** en la tabla de "Movimientos del banco" (sección Comandos/Config), al hacer un pago
  saliente sólo se veía el CBU de origen. Se quería ver origen Y destino, y a qué usuario se le pagó.
- **Back (`GET /api/admin/hgcash/movements`):** los `BankMovement` salientes (`direction:'Outbound'`)
  se enriquecen con el `PendingPayout` correspondiente (match por `externalId == payout.id` o por
  `hgTransactionId`) → se adjunta `payoutUsername` y, si faltan, `toCBU`/`toName` desde el payout.
- **Front (`loadHgcashMovements` + tabla en index.html):** nuevas columnas **Destino** y **CBU destino**;
  la columna **Usuario** ahora usa `matchedUsername` (cargas entrantes) o `payoutUsername` (pagos salientes).
  Tabla pasó de 8 a 10 columnas (colspans y min-width actualizados).

### 43. Comandos vacíos = NO enviar ese mensaje automático
- **Pedido:** hoy los comandos `/sys_*` (mensajes automáticos) sólo se podían editar; ahora, si se
  deja el comando VACÍO desde el panel, ese mensaje no debe enviarse.
- **Antes:** `renderSystemCommand` con respuesta vacía → caía al **fallback hardcodeado** (lo opuesto a lo pedido).
- **Ahora:** `renderSystemCommand(name, fallback, vars)` devuelve **`null`** si el comando EXISTE (activo)
  pero su `response` está vacío → el caller no crea ni emite el mensaje. Si el comando NO existe (instalación
  nueva pre-seed) sigue usando el fallback. Helper gemelo `resolveSysContent(cmd, fallback)` para los flujos
  que hacían `Command.findOne` directo.
- **Cubre:** `/sys_deposit`, `/sys_deposit_bonus`, `/sys_reminder`, `/sys_install_app`, `/sys_withdrawal`,
  `/sys_bonus`, `/sys_cbu` (omite el descriptivo, igual manda el CBU para copiar), `/sys_welcome`,
  `/sys_withdrawal_request` (igual mueve el chat a Pagos), `/sys_install_bonus`, `/sys_payout_paid`, y la
  carga automática hgcash (`/sys_deposit`). El CRUD ya guardaba `response: ''` sin problema.
- **Nota:** desactivar el toggle (isActive:false) sigue cayendo al fallback; lo que apaga el envío es DEJARLO VACÍO.

### 42. Mensaje "pago enviado" automático en el pago por API (hgcash) — editable /sys_payout_paid
- **Pedido:** que el pago automático por hgcash mande el mensaje de "pago enviado" (hoy se mandaba a mano con `/5`).
- **Cómo:** nuevo comando del sistema **`/sys_payout_paid`** (sembrado en `systemCmds`, editable desde Comandos).
  `notifyPayoutPaid` ahora renderiza ese comando (var `${amount}`); si se vacía, no envía nada.
- **Se dispara en:** webhook hgcash `DONE` (`handlePayoutStatusWebhook`), el caso en que el cash-out vuelve
  `DONE` en el acto desde `POST /payouts/:id/pay` (antes NO avisaba), y "Pagar con otro banco" (#41).
- **Migrá tu texto de `/5` a `/sys_payout_paid`** una vez (copiá el contenido en Comandos).

### 41. Rechazar pago = devolver fichas + botón "Pagar con otro banco"
- **Pedido:** al RECHAZAR un pago desde el panel, devolver al cliente las fichas que se le habían
  descontado (el self-retiro ya descuenta en JUGAYGANA). Y, como a veces se paga desde otro banco,
  agregar esa opción aparte (sin devolver fichas).
- **`POST /payouts/:id/cancel` (Rechazar):** reclamo atómico `pending_review|failed → cancelled` (anti doble
  devolución), luego re-acredita el monto en JUGAYGANA (`jugaygana.depositToUser` con `jugayganaUserId`),
  registra `Transaction` (`metadata.source:'payout_refund'`), emite `balance_updated` y nota admin-only. Si la
  devolución falla, deja nota "devolvé el saldo a mano" (no re-intenta para no duplicar). Devuelve `chipsReturned`.
- **`POST /payouts/:id/pay-other-bank` (NUEVO):** marca `paid` con `paidVia:'other_bank'`, SIN tocar hgcash y
  SIN devolver fichas; manda el aviso `/sys_payout_paid`. Botón "🏦 Pagar con otro banco" en el banner del chat.
- **Modelo `PendingPayout`:** nuevos campos `paidVia` ('hgcash'|'other_bank'), `chipsReturned` (bool), `refundTxId`.
- **Panel:** banner de pago ahora tiene 3 acciones: **💸 Pagar** (auto hgcash) · **🏦 Pagar con otro banco** ·
  **↩️ Rechazar (devolver fichas)**. Confirmaciones y toasts actualizados.

### 40. Etiqueta rápida "Comunidad" (1 clic) en el chat del panel
- Botón **"+ Comunidad"** al lado de "Agregar" en la barra de etiquetas del chat → `quickAddChatTag('Comunidad')`
  (carga el input y reusa `addChatTag`). Se normaliza a minúsculas en el back (queda `comunidad`), como el resto.

### 45. Devolución de fichas (#41) NO cuenta como ingreso/carga en reportes
- La devolución por retiro rechazado registra `Transaction type:'deposit'` con `metadata.source:'payout_refund'`
  (para auditoría). Para que esa plata —que nunca entró— no infle los reportes, se excluye `payout_refund` de:
  `publisherAnalyticsService` (agregado a `GIFT_SOURCES`), **Central → Ingresos** (`/api/admin/central/ingresos`)
  y **Estadísticas** (`/api/admin/datos`). El resto de queries de depósitos (reembolsos/fueguito) no se tocó.

### 46. Devolución de fichas dividida: bonus de la última carga vuelve como BONUS
- **Pedido:** al devolver las fichas (rechazo de pago), si la ÚLTIMA carga del cliente incluyó bonus,
  devolver esa porción como BONUS y el resto como fichas comunes.
- **Regla (acordada):** `bonusPart = min(bonus_de_la_última_carga, monto_retiro)` (capeado), `chipsPart = resto`.
  La parte fichas va por `jugaygana.depositToUser`; la parte bonus por `jugaygana.creditUserBalance`
  (mismo camino que un bonus normal → mantiene tratamiento de bonus en JUGAYGANA).
- **Seguridad del monto:** el TOTAL siempre = monto del retiro (no devuelve de más ni de menos).
  Dato del bonus: `Transaction.bonus` de la última `Transaction type:'deposit'` (refleja lo realmente acreditado).
- **Falla parcial (2 llamadas a JUGAYGANA):** cada parte con sus reintentos; si una falla, NO se reintenta a
  ciegas (no duplica) y queda **nota interna admin-only** detallando qué falta devolver a mano. `chipsReturned`
  sólo queda `true` si entraron AMBAS partes.
- **Reportes:** ambas partes se registran como `Transaction type:'deposit'` con `metadata.source:'payout_refund'`
  (+ `refundKind:'bonus'|'chips'`), así siguen excluidas de Ingresos/Estadísticas/analítica (#45).
- **Nota interna al agente:** en éxito detalla el split ("$X como BONUS + $Y en fichas"); en parcial, qué faltó.

- **Validado:** `node --check` OK (server.js, admin.js, PendingPayout.js, publisherAnalyticsService.js).
- **Para activar el pago automático real seguís necesitando `HGCASH_API_TOKEN` en SSM (sin cambios).**
- **Acordate de migrar el texto de tu comando `/5` a `/sys_payout_paid` desde Comandos.**

## Sesión 2026-06-17

### 38. Pago AUTOMÁTICO de retiros (cash-out hgcash), confirmado por el agente
- **Pedido:** que el retiro se pague automático al CBU del cliente, pero SIEMPRE verificado y
  confirmado antes por un agente. El agente confirma → se paga solo.
- **Flujo:** el self-retiro (ya descuenta JUGAYGANA) ahora crea un `PendingPayout` (status
  `pending_review`) con monto + titular + CBU/alias. En el chat del cliente aparece un banner
  "💸 RETIRO PENDIENTE: $X · titular · CBU/alias" con botones **Pagar** / **Rechazar**. Al confirmar:
  resuelve el CBU/CVU de 22 díg. (si vino alias, lo busca con `/alias-lookup`), llama a hgcash
  `POST /transactions` (cash-out) con `externalID = payout.id` (idempotencia) y `webhookUrl`. Estado:
  `paying` → webhook `DONE` → `paid` + aviso al cliente; `ERROR/CANCELLED` → `failed` + aviso admin.
- **Componentes:** `src/services/hgcashService.js` (createCashOut + lookupAlias, axios + Bearer
  `HGCASH_API_TOKEN`), `src/models/PendingPayout.js`, endpoints `GET /api/admin/payouts`,
  `POST /api/admin/payouts/:id/pay`, `/cancel` (withdrawerMiddleware), rama TRANSACTION_REQUEST en
  el webhook `/api/hgcash/webhook` (`handlePayoutStatusWebhook`), auto-captura del `accountId` desde
  los movimientos. Banner + funciones `payPayout`/`cancelPayout` en el panel.
- **Para activar:** cargar `HGCASH_API_TOKEN` (token `cash_...` del dashboard hgcash) en SSM. Sin él,
  el botón avisa "pago automático no configurado, pagá manual" (dormido, no rompe nada). El accountId
  se auto-captura del primer movimiento entrante (o se setea en config).
- **Seguridad:** el AGENTE es el filtro (verifica y confirma cada pago); reclamo atómico
  pending_review→paying (no doble pago); idempotencia por externalID. El saldo en JUGAYGANA ya se
  descontó en el self-retiro.
- **Validado:** `node --check` OK (server.js, hgcashService.js, PendingPayout.js, admin.js).

### 37. hgcash: match por N° de transacción == coelsa (funciona con CUALQUIER banco)
- **Problema:** comprobantes de otros bancos (ej. BNA) no auto-cargaban. Causa: muchos comprobantes
  muestran el DESTINATARIO pero NO el nombre del que ENVÍA → el match por "nombre de origen" fallaba.
  Además la cuenta destino real ("LA DELFI S.R.L." / alias URBANATRADE) no coincidía con la config vieja.
- **Hallazgo clave:** el comprobante trae "Número de transacción" y el movimiento del banco trae el
  MISMO valor en `coelsaCode` (ej. `3D5W612E6Z8WR04Q2GXYWR`). Es un match DEFINITIVO.
- **Fix:** nuevo `_comprobanteMatchesMovement(comprobante, movement, cfg)` con 2 criterios (además del
  monto): (1) **N° de transacción del comprobante == coelsaCode/externalID del movimiento** (definitivo,
  no necesita el nombre del remitente ni la config de cuenta → sirve para cualquier banco); (2) fallback
  por **nombre de origen + destino consistente** (el destino se valida contra el `toName`/`toCBU` REAL del
  movimiento, no contra la config → funciona con cualquier cuenta hgcash). Ambos matchers (desde
  comprobante y desde movimiento) usan este helper. Se quitó la dependencia de la config `accountName`.
- **Limitación:** si un comprobante NO muestra ni el N° de transacción ni el nombre del remitente, queda
  manual (no hay clave común confiable). Cubre la gran mayoría de transferencias por CBU/CVU (traen coelsa).
- **Validado:** `node --check` OK. Para probar: transferencia NUEVA + comprobante (la vieja $174.000 que
  quedó pendiente, cargala manual: reenviar el comprobante lo detecta como duplicado, correctamente).

### 36. Causa raíz de "auto-carga falla pero manual funciona": el lookup flaky
- **Diagnóstico:** el error "JUGAYGANA está respondiendo intermitente — el usuario existe pero no
  podemos confirmarlo" sale en `jugaygana.js:843-850`, en el **lookup** (ShowUsers) que `depositToUser`
  hace ANTES del DepositMoney. O sea: el depósito NUNCA se intentó → reintentar es seguro para ese caso.
  La carga manual usaba el mismo camino; funcionó por timing (JUGAYGANA es intermitente).
- **Fix de raíz:** `depositToUser(username, amount, description, jugayganaUserId=null)` ahora acepta el
  ID guardado y, si está, **saltea el lookup** y va derecho al DepositMoney (igual que ya hacía
  `creditUserBalance`). Auto-carga (hgcash) y carga manual (`/api/admin/deposit`) ahora pasan
  `user.jugayganaUserId` → muchísimas menos fallas por el lookup. Backward-compatible: si no hay ID,
  cae al lookup de siempre.
- **Sobre el re-envío del comprobante:** la dedup (hash de imagen) lo detecta como "ya usado" — eso es
  CORRECTO (anti-fraude). Por eso reenviar NO reintenta. La recuperación ante fallo es **carga manual**
  (que consume el movimiento, #35). Se ajustó el mensaje de fallo para indicar carga manual (sin sugerir
  reenviar el comprobante).
- **Validado:** `node --check` OK (server.js, jugaygana.js).

### 35. hgcash: carga manual consume el movimiento (anti doble-carga si JUGAYGANA falló)
- **Pedido:** si JUGAYGANA falla la auto-carga, el operador carga manual a ese usuario; al hacerlo,
  esa transferencia/foto debe quedar marcada como CARGADA, para que cuando JUGAYGANA se recupere NO
  se auto-cargue de nuevo (evitar doble carga).
- **Cómo:**
  - En `hgcashAutoCarga` ahora se registra en el movimiento `matchedUserId/Username/ComprobanteId`
    apenas matchea (antes solo en éxito/sombra) → el fallo recuerda a quién era.
  - Nuevo `hgcashConsumeOnManualDeposit(userId, username, amount)`: busca un movimiento matcheado a
    ese usuario, en `pending`/`error`, con el MISMO monto; lo marca atómicamente `manual_charged` +
    marca el comprobante `autoCharged`. Enganchado en `POST /api/admin/deposit` (carga manual del
    operador), fire-and-forget.
  - Estado nuevo `manual_charged` en BankMovement y Comprobante; badge en el panel ("Cargado manual ✓").
- **Resultado:** carga manual del mismo monto al mismo usuario → la transferencia hgcash queda
  consumida → la foto no vuelve a auto-cargar. (Requiere monto igual; si el operador carga otro monto,
  no consume — es a propósito, para no marcar mal.)
- **Validado:** `node --check` OK.

### 34. hgcash: fallo de auto-carga REINTENTABLE (no queda trabado en error)
- **Síntoma:** si JUGAYGANA falla al auto-cargar, el movimiento quedaba en `error` para siempre →
  reenviar el comprobante real no podía reintentar (el matcher solo mira `pending`).
- **Aclaración importante:** el matcheo NO usa la hora impresa en el comprobante (sólo monto + nombre
  de origen + cuándo llegó al sistema). El error fue 100% de JUGAYGANA, no del horario.
- **Fix:** helper `hgcashHandleChargeFailure` — ante un fallo de carga cuenta el intento
  (`BankMovement.chargeAttempts`) y, si no superó el tope (`HGCASH_MAX_CHARGE_ATTEMPTS=3`), devuelve el
  movimiento a `pending` (reintentable con el próximo comprobante) y el comprobante a `pending`. Pasado
  el tope → `error` (carga manual). Bandera `charged`: si la excepción ocurre DESPUÉS de acreditar
  (paso local posterior), NO se reintenta (evita doble carga).
- Movimientos viejos ya en `error` (pre-fix) no se auto-recuperan → cargar manual.
- **Validado:** `node --check` OK.

### 33. Dedup de comprobantes robusto: hash de imagen (re-envío detectado 100%)
- **Síntoma:** un comprobante reenviado al día siguiente NO se detectó como duplicado.
- **Causas:** (1) la huella de dedup dependía del N° de operación leído por la IA, y la lectura
  OCR puede VARIAR entre envíos (especialmente códigos largos tipo UUID) → huella distinta → no
  matchea; (2) posible base de datos distinta entre entornos (Render de prueba vs producción).
  **No hay TTL en `Comprobante`** — la verificación NO expira (es permanente).
- **Fix:** nuevo campo `Comprobante.imageHash` (SHA-256 de la imagen base64). El chequeo de
  duplicado ahora busca por **imageHash O dedupeKey** (`$or`), y se hace ANTES de la rama "sin N°
  de operación". Así, reenviar **la misma imagen** se detecta como duplicado al 100%, sin depender
  del OCR. (Sólo para imágenes `data:` base64 — capturas; para URLs https queda null.)
- Si no hay ni dedupeKey ni imageHash → status `no_key` + aviso "verificá a mano".
- **Nota auto-carga (confirmado):** el matcheo desde el comprobante usa `windowMinutes` (default 60):
  si la transferencia (movimiento del banco) tiene más de 60 min, NO matchea → no se auto-carga →
  queda para verificación manual del agente. Configurable.
- **Validado:** `node --check` OK.

## Sesión 2026-06-16

### 30. Fixes hgcash tras prueba real (matcheo por nombre + falso-duplicado + diagnóstico 403)
- **Contexto:** al probar, el comprobante se detectaba pero no cargaba. Los logs de webhook de
  hgcash + el payload real revelaron 3 cosas:
  1. **Webhook 403:** el webhook apuntaba a `vipcargas.com` (producción EB detrás de **Cloudflare**),
     que bloquea el POST del banco antes de llegar a Node. Además el código nuevo estaba en **Render**
     (otra URL). **Redis NO interviene.** → Para probar en Render: apuntar el webhook a la URL de Render
     + setear `HGCASH_WEBHOOK_SECRET`/`ANTHROPIC_API_KEY` en Environment de Render. En EB/producción:
     volver a vipcargas.com + cargar secrets en SSM + **regla WAF "Skip" en Cloudflare para
     `/api/hgcash/webhook`** (si no, 403).
  2. **El payload real de hgcash NO trae CBUs** (solo `fromName`/`toName`/`amount`/`status:"done"`/
     `externalID`/`id`/`direction`). El match por CBU jamás podía funcionar.
  3. **Falso "duplicado":** sin N° de operación, la IA usaba el CBU como N° → el CBU se repite → falsos
     duplicados.
- **Fixes (código):**
  - Dedup: el prompt de la IA aclara que `numero_operacion` NO es el CBU; la huella **ignora** un N° que
    sea un CBU (== CBU origen/destino o ≥18 díg.) y usa fallback `monto|nombre_origen|cbu|fecha`.
  - Matchers hgcash reescritos: match por **monto + NOMBRE de origen + ventana** con **guard de
    ambigüedad** (>1 candidato = no carga, manual) y sólo si el movimiento está **acreditado**
    (`status:"done"`, configurable). Destino confirmado por **nombre de cuenta** (o CBU si está).
    Helpers `_normName`/`_nameMatch`/`_statusAccredited`/`_comprobanteToOurBank`.
  - Config `hgcash`: nuevos `accountName` (toName de tu cuenta, para confirmar destino sin CBU) y
    `acceptStatuses` (default `['done']`). Panel: campo "Nombre de tu cuenta hgcash"; CBU pasa a opcional.
- **Validado:** `node --check` OK. Recomendado: probar en **modo sombra** hasta validar matches, después auto.

### 31. hgcash: match aunque el comprobante no muestre destino + logs de diagnóstico
- **Síntoma (prueba en Render):** webhook llega OK (HTTP 200), el movimiento se guarda pero queda
  "Pendiente" (sin match) → no carga. Causa probable: los comprobantes no traían datos de DESTINO
  (o fueron procesados por código viejo), y el match exigía confirmar el destino.
- **Fix:** nuevo helper `_destOkOrUnknown` — el match acepta cuando el destino confirma nuestra cuenta
  **o cuando el comprobante no muestra destino** (el webhook de hgcash ya prueba que la plata entró a
  NUESTRA cuenta; con monto + nombre de origen + ventana + guard de ambigüedad el riesgo es mínimo).
  Aplicado en ambos matchers. El comprobante-side ya no mal-etiqueta `toApiBank` cuando el destino es
  desconocido.
- **Logs nuevos** `[hgcash] movimiento SIN match...` / `comprobante SIN movimiento aún...` con resumen
  de candidatos (montos/nombres) para diagnosticar en los logs de Render.
- **Nota de entorno:** se prueba en Render (`vipcargasantino.onrender.com`), HTTPS válido y sin
  Cloudflare. La URL cruda de EB daba "fetch failed" (sin HTTPS en el 443). Producción seguirá en
  vipcargas.com + regla WAF "Skip" en Cloudflare.
- **Validado:** `node --check` OK.

### 32. hgcash: el COMPROBANTE es el disparador (no la transferencia sola)
- **Problema reportado:** tras una carga automática, una transferencia nueva cargaba **sin que el
  cliente mande comprobante** — el webhook agarraba un comprobante **viejo/sobrante** (mismo monto+
  nombre, dentro de los 60 min) y cargaba. Riesgo: cargar contra el comprobante de otro momento/usuario.
- **Fix:** el matcheo DESDE el comprobante (`hgcashMatchFromComprobante`) sigue con ventana completa
  (`windowMinutes`, default 60) y es el **disparador principal**. El matcheo DESDE la transferencia
  (`hgcashMatchFromMovement`) pasa a ser solo **red de seguridad** para el caso raro en que el
  comprobante llega segundos ANTES que el webhook: usa una ventana CORTA `raceWindowMinutes`
  (default 10, configurable, máx 120). Así una transferencia nueva NO carga contra comprobantes viejos.
- En la práctica el webhook llega antes que el comprobante (el cliente transfiere → saca captura →
  manda), así que el camino normal es el del comprobante. La carga ocurre cuando el cliente manda el
  comprobante y hay una transferencia pendiente que coincide.
- **Validado:** `node --check` OK.


### 29. Carga AUTOMÁTICA por banco con API (hgcash / Urbana) — NUEVO
- **Caso:** un banco (hgcash) tiene API; cuando un cliente transfiere a ese CBU y manda
  el comprobante, que la carga se haga sola. El otro banco (sin API) sigue manual.
- **API hgcash** (https://docs.hg.cash): webhook `account-movement` (push) firmado con
  HMAC-SHA256 en header `X-HG-Webhook-Signature: sha256=<hex>` sobre el body crudo, secreto
  configurable en el dashboard. Base URL `https://hg.cash/api/v1`, auth `Bearer cash_...`
  (sólo para consultas; el webhook no necesita token). Campos del movimiento: direction
  (Inbound/Outbound), amount, currency, fromCBU/fromCUIT/fromName, toCBU, coelsaCode, date, id.
- **Decisiones (owner):** matcheo por **monto + CBU origen + ventana 60 min**; arranca
  **apagado** y en **modo sombra** (detecta y avisa al admin SIN cargar) hasta habilitar auto.
- **Cómo funciona:**
  - Webhook `POST /api/hgcash/webhook` (sin authMiddleware): valida firma HMAC sobre el body
    crudo (se agregó `verify` en express.json → `req.rawBody`), guarda el movimiento en la
    colección nueva **`BankMovement`** (dedupe por `movementId`), responde 2xx rápido y matchea
    en segundo plano.
  - **Matcheo en cualquier orden:** desde el movimiento (`hgcashMatchFromMovement`) busca el
    comprobante; desde el comprobante (`hgcashMatchFromComprobante`, enganchado en
    `analyzeComprobanteFromMessage`) busca el movimiento. Match exacto = monto en centavos
    igual + `fromCBU`==`cbu_origen` (normalizado a dígitos, ≥18) + dentro de la ventana.
  - **Anti-doble-carga:** se reclama atómicamente el movimiento (pending→claiming) Y el
    comprobante antes de cargar.
  - **Carga (`hgcashAutoCarga`):** modo sombra → mensaje adminOnly "MATCH listo para cargar".
    Modo auto → `jugaygana.depositToUser` + Transaction (metadata.source 'auto_hgcash') +
    mensaje al cliente (/sys_deposit) + emit balance + aviso admin. Si falla, queda manual.
- **Config** en `Config['hgcash']` `{ enabled, cbu, accountId, mode, windowMinutes, currency }`.
  Endpoints admin (solo admin general): `GET/POST /api/admin/hgcash/config`,
  `GET /api/admin/hgcash/movements`. Panel: card "🏦 Banco automático (hgcash)" en la sección
  "Comandos y Configuración CBU" (CBU + modo sombra/auto + ventana + activar; muestra estado de
  firma/IA y la URL del webhook) + **tabla de movimientos del banco** (filtro por estado +
  paginación + badge de estado de match: pendiente/match-sombra/cargado/error) — solo admin general.
- **Para activarlo:** (1) en el dashboard de hgcash: setear webhook URL
  `https://vipcargas.com/api/hgcash/webhook` + generar secreto de firma; (2) cargar
  `HGCASH_WEBHOOK_SECRET` en SSM; (3) en el panel: cargar el CBU de hgcash + activar (arranca
  en sombra) → pasar a auto cuando confíe. Requiere también la IA de comprobantes activa
  (`ANTHROPIC_API_KEY`) porque el matcheo usa el comprobante. **Apagado por defecto: no carga
  nada hasta habilitarlo.**
- **Limitación:** sólo auto-carga si el comprobante muestra un CBU de origen legible (22 díg.).
  Si sólo muestra alias → queda manual (aviso al operador). Movimientos sin comprobante que
  matchee quedan `pending` para reconciliación manual.
- **Validado:** `node --check` OK (server.js, admin.js, modelos). Back necesita redeploy.

### 28. Lectura del CBU/titular de DESTINO en el comprobante (IA)
- La IA del comprobante ahora también extrae `cbu_destino`/`titular_destino` (campos
  `destCbu`/`destHolder` en Comprobante). Necesario para distinguir banco con API vs sin API
  en la carga automática (#28). Cambio aditivo, sin romper lo existente.

### 27. Registro de comprobantes con IA (anti-reutilización/estafa) — NUEVO
- **Caso:** clientes que reusan un comprobante ya usado por otro usuario (el user1
  pasa comprobante y carga; user2 —sin relación aparente— pide cargar con el MISMO
  comprobante). Se quería detectarlo automáticamente.
- **Cómo funciona:** cuando un cliente manda una IMAGEN por el chat, en segundo plano
  (fire-and-forget, cero impacto en la velocidad del chat) se manda a **Claude vision**
  que decide si es comprobante y extrae datos (N° operación, monto, CBU/alias origen,
  banco, fecha). Se guarda en la colección nueva **`Comprobante`** (permanente, sin TTL)
  y se busca duplicado por **huella** (`dedupeKey` = N° operación normalizado; si no hay,
  combo monto|cbu|fecha).
  - Duplicado de OTRO usuario → mensaje **adminOnly** en el chat: `🚨 COMPROBANTE YA
    UTILIZADO POR: @usuario …`. Duplicado del mismo cliente → aviso más suave.
  - No duplicado → aviso adminOnly `✅ Comprobante verificado — no es duplicado`.
  - No es comprobante (captura de error, foto cualquiera) → se registra liviano, SIN avisar.
  - Sin N° de operación legible → aviso "verificá a mano".
- **Modelo de IA:** `claude-haiku-4-5` (default, ~US$0,003 por comprobante). Configurable
  con env `COMPROBANTE_AI_MODEL`. Cliente vía **axios** (mismo patrón que JUGAYGANA, sin
  sumar dependencias nuevas).
- **Activación:** lee `ANTHROPIC_API_KEY` desde `process.env` (cargada por SSM en el
  bootstrap, igual que JWT_SECRET). **Si la key NO está, queda DORMIDO** (no analiza, no
  crea registros, no rompe nada). → Para activarlo: cargar `ANTHROPIC_API_KEY` en el
  SSM_PATH (AWS Parameter Store) y redeploy/restart.
- **Archivos:** `src/models/Comprobante.js` (nuevo), `src/services/comprobanteAiService.js`
  (nuevo), enganches en server.js (helper `analyzeComprobanteFromMessage` + 2 hooks: socket
  `send_message` y HTTP `/api/messages/send`, sólo `senderRole==='user'` && `type==='image'`).
- **Alcance:** sólo cubre imágenes que pasan por el chat de la app. Si el comprobante llega
  por otro canal (WhatsApp directo) no se ve. Pendiente ofrecido: verificación del lado del
  operador en el panel (subir imagen antes de cargar) — NO hecho aún (el owner eligió "solo chat").
- **Validado:** `node --check` OK. Back necesita redeploy + cargar la API key en SSM.

### 26. Etiquetas + notas internas en usuarios (panel admin)
- **Pedido:** poder etiquetar/anotar clientes (ej: `comprobante-duplicado`, `sospechoso`,
  `confiable`, `VIP`), filtrar usuarios por etiqueta y mandar difusiones push por etiqueta.
- **Modelo (`User`):** `tags: [String]` (indexado), `adminNotes` (texto), `tagHistory`
  (auditoría liviana: quién agregó/quitó qué y cuándo). Las etiquetas se normalizan en el
  backend (minúsculas, trim, espacios colapsados, máx 40 chars) para que guardado y filtro coincidan.
- **Backend (server.js):** filtro `?tag=` en `GET /api/admin/users`; `GET /api/admin/tags`
  (lista de etiquetas en uso); `POST /api/admin/users/:userId/tags` (action add|remove,
  atómico con `$addToSet`/`$pull`); `POST /api/admin/users/:userId/notes`. Helper `normalizeTag`.
  `GET /api/users/:userId` ya devuelve tags+adminNotes (full user). Todos con `adminMiddleware`.
- **Difusión por etiqueta (`notificationRoutes.js`):** `POST /api/notifications/send-to-tag`
  → resuelve usernames por etiqueta y reusa `sendNotificationToUsernames`. **Solo admin
  general** (chequeo `req.user.role==='admin'`, no cajeros).
- **Panel (`adminprivado2026`):** barra de etiquetas + nota en el chat del usuario (chips
  con quitar, input con autocompletado, textarea de nota); chips de etiqueta bajo el nombre
  en la tabla de Usuarios; filtro por etiqueta en la sección Usuarios; card "📣 Difusión por
  etiqueta" en Notificaciones. Reusa `authFetch`/`escapeHtml`.
- **Validado:** `node --check` OK (server.js, admin.js, notificationRoutes.js, User.js).
  Back necesita redeploy; front, recargar el panel.

### 25. Fix bug Fueguito: el "100% próxima carga" (día 15) nunca se limpiaba
- **Bug:** el flag `pendingNextLoadBonus` se ponía en `true` al llegar al día 15 pero NUNCA
  se volvía a poner en `false` en ningún lado → el cartel "🎁 Tenés un 100% en tu próxima
  carga" quedaba visible para siempre y era un **bono 100% infinito** explotable (el cliente
  podía pedirlo a un operador en cada carga). (Reportado como "aparece para reclamar el bono"
  estando en día 26; por la captura era el premio del día 15, no el de día 20.)
- **Fix (ambas cosas, como pidió el owner):**
  - **Auto-limpieza:** en `POST /api/admin/deposit`, si la carga incluyó un bonus que se
    acreditó OK, se limpia el flag de forma atómica (`FireStreak.updateOne({userId, pendingNextLoadBonus:true},{false})`).
  - **Botón manual:** `GET /api/users/:userId` ahora expone `fireNextLoadBonus` para el panel;
    nuevo `POST /api/admin/users/:userId/fire-next-load-bonus/apply` (depositorMiddleware) lo
    marca como aplicado. En el chat del panel aparece un cartel "🔥 FUEGUITO: 100% próxima carga"
    con botón "✓ Marcar aplicado".
  - **Front cliente:** `showFireModal` ahora SIEMPRE refresca el estado al abrir (antes usaba
    estado cacheado → podía mostrar un botón de reclamo viejo de un premio ya expirado/consumido).
- **Nota:** el premio en efectivo (días 10/20/30) ya auto-expira el mismo día (sin cambios).
- **Validado:** `node --check` OK (server.js, admin.js, fire.js). Back redeploy; front recargar.

## Sesión 2026-06-10

### 24. Segundos en mensajes del chat + separar Demoras por cola (cargas/pagos)
- **Segundos en el chat:** los timestamps de los mensajes (enviados/recibidos/
  sistema) ahora muestran HH:mm:ss. Se creó `formatChatTime` (con segundos) y se usa
  SOLO en los 3 puntos de render de mensajes (`addMessageToChat`,
  `createMessageElement` regular + sistema). `formatDateTime` (sin segundos) se
  mantiene en la tabla de Transacciones.
- **Demoras separadas por cola cargas/pagos:** pagos tolera demoras largas
  esperadas (~30 min para pagar), cargas no debería pasar de 2 min. Ahora:
  - `ChatDelay.category` ('cargas'|'pagos'). La cola se deriva al resolver el reloj:
    `status==='payments' || category==='pagos'` → pagos. Los cierres resuelven la
    demora ANTES de poner status:'closed' (sino se perdía la cola real).
  - **Umbrales separados y configurables:** `chatDelayThresholdSeconds` (cargas,
    default 2 min) y `chatDelayThresholdPagosSeconds` (pagos, default 30 min). Cada
    demora se registra solo si supera el umbral de SU cola.
  - **Endpoint:** GET acepta `?category=`; "esperando ahora" ahora incluye chats
    open Y payments y compara cada uno contra su umbral; devuelve ambos umbrales.
    POST config acepta ambos.
  - **Panel:** dos inputs de umbral (Cargas/Pagos), filtro de Cola (Todas/Cargas/
    Pagos), columna "Cola" con badge en ambas tablas. Hint muestra los dos umbrales.
  - Nota: registros viejos de ChatDelay (pre-cambio) no tienen `category`.
- **Validado:** `node --check` OK. Back necesita redeploy; front, recargar el panel.

### 24c. Tracking de demoras fire-and-forget (cero impacto en velocidad del chat)
- Las llamadas al tracking en los caminos de mensaje en TIEMPO REAL (socket
  `send_message` normal + comando, HTTP `/api/messages/send` + comando) pasaron de
  `await` a **fire-and-forget** (`.catch(()=>{})`): corren en segundo plano y NO
  frenan la entrega del mensaje. La latencia de enviar/recibir vuelve a ser idéntica
  a antes de la feature (el único `await` pre-emit que queda es el `lastMessageAt` de
  ChatStatus, que ya existía).
- Siguen `await` solo donde NO importa la latencia de chat: CBU/cerrar chat (botón)
  y carga/retiro/bonus (que ya esperan a JUGAYGANA segundos).
- Los helpers ya capturan sus errores internamente; el `.catch` es defensa extra.

### 24b. Ajuste de la cola: señales más fuertes + registros viejos no mienten
- **Problema reportado:** un chat que estaba en pagos aparecía como "Cargas". Causa:
  esos registros eran ANTERIORES al deploy del cambio (sin campo `category`), y el
  badge los mostraba como "Cargas" por default.
- **Fix UI:** registros sin `category` ahora muestran "—" (no "Cargas").
- **Mejora de precisión (back):** `delayClockResolve` acepta `queueHint`. Lógica final
  (confirmada con el flujo del owner): **gana "pagos" si hay CUALQUIER señal de pagos** →
  `queue = (queueHint==='pagos' || deriveChatQueue(cs)==='pagos') ? 'pagos' : 'cargas'`.
  Señales de pagos: chat en `status:'payments'` (pestaña Pagos), operación de retiro,
  o agente `withdrawer`. Señales de cargas (depositor / carga / bonus / CBU) caen a
  cargas por defecto. Helper `roleQueueHint(role)`.
- **Flujo real del owner:** cargas las contesta un admin `depositor` en chat abierto;
  el chat pasa a Pagos cuando el cliente toca "Retirar" (auto) o el depositor toca
  "Enviar a pagos" → `status:'payments'`; ahí se manda el comprobante y se cierra.
  Con la regla "pagos gana", todo lo que pasa en la sección Pagos queda etiquetado pagos.

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
