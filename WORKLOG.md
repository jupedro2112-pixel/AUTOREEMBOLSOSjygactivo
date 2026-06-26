# WORKLOG — Estado vivo del proyecto

> Se actualiza tras cada cambio significativo (ver regla en `CLAUDE.md`). El detalle
> commit por commit está en `git log --oneline`. Esto captura decisiones, umbrales de
> negocio y pendientes que NO se ven leyendo el código.
>
> **Última actualización: 2026-06-26**

## Sesión 2026-06-26

### 80. Seguridad — Batch A: cierre de escaladas de privilegio + huecos de plata (sin romper flujos legítimos)
- **Pedido del owner:** mejorar la seguridad en general sin romper nada. Se auditó todo (auth, inyección, endpoints públicos/webhooks, config/secrets) con agentes de solo-lectura y se verificó cada hallazgo a mano antes de tocar.
- **Patrón raíz detectado:** `adminMiddleware` deja pasar 4 roles (admin/depositor/withdrawer/comunidad); varios endpoints sensibles se olvidaron de re-chequear `role==='admin'`.
- **Arreglos aplicados (todos verificados como SEGUROS: el front legítimo no usa los 3 primeros, o el cambio solo restringe a quien no debería):**
  - **`/api/movements/deposit` (CRÍTICO):** solo tenía `authMiddleware` → cualquier usuario se autocargaba fichas reales (`jugaygana.depositToUser`) sin pago. El front NO lo usa (ruta legacy). Se gateó con `depositorMiddleware` + validación estricta de monto.
  - **`PUT /api/admin/config/cbu` (CRÍTICO):** sin recheck → un cajero podía cambiar el CBU adonde va la plata de los depósitos. El panel usa `/api/admin/cbu` (otro endpoint), no este. Se agregó guard `role==='admin'`.
  - **`/api/admin/users/:id/reset-password` (CRÍTICO):** sin recheck → un cajero podía resetear la clave del admin general (takeover total). El panel usa `/api/admin/change-password`. Se agregó guard `role==='admin'`.
  - **Degradación de rol no cortaba la sesión (ALTO):** `PUT /api/users/:id` cambia `role` (ya solo admin) pero NO subía `tokenVersion` → admin degradado seguía con poderes hasta vencer el token (30–90d). Ahora hace `$inc tokenVersion` cuando cambia el rol.
  - **`pendingAccessCode` (MEDIO):** código de acceso de 6 díg. generado con `Math.random()` (predecible) → cambiado a `crypto.randomInt`.
  - **Validación de monto débil (MEDIO):** `amount` string/NaN evadía el guard en `movements/deposit`, `admin/deposit`, `admin/withdrawal` → ahora `Number.isFinite(Number(amount))`.
  - **Webhook hgcash fail-open (CRÍTICO condicional):** si faltaba `HGCASH_WEBHOOK_SECRET` procesaba SIN validar firma. Ahora **fail-closed en producción** (rechaza con 503 + `logger.error`). ⚠️ **ACCIÓN OWNER ANTES DE DEPLOYAR:** confirmar que `HGCASH_WEBHOOK_SECRET` esté cargado en SSM, si no los webhooks de pago dejarían de procesarse.
  - **Endurecimiento CSP:** agregado `object-src 'none'`.
- **Decisión owner (NO restringido):** comandos `/sys_*`, `login-without-password`, `verify-phone` y `canal-url` siguen accesibles a cajeros (los usan en su laburo) — riesgo aceptado a cambio de no cambiarles el flujo.
- **NO aplicado (riesgo de romper):** `hpp` (aplastaría arrays legítimos en el body JSON: influencers, premios fueguito, acceptStatuses, pasos, usernames). Deuda pendiente RIESGOSA: reemplazar `xss-clean` (deprecado), quitar `'unsafe-inline'` de la CSP (requiere nonces, index.html con mucho JS inline), rate-limiters a Redis (multi-instancia → SMS spam), password mínimo >6.
- **Validado:** `node --check` OK en server.js. Sin migraciones. Back necesita redeploy (CONFIRMAR el secret de hgcash en SSM primero).

### 79. Optimización VISUAL + limpieza de código muerto (PWA cliente + panel admin) — SIN cambios de comportamiento
- **Pedido del owner:** optimizar vipcargas, arreglar bugs visuales y limpiar código de más, **garantizando que no se rompa ni se pierda ninguna funcionalidad**. Alcance: ambas superficies; profundidad: solo seguro (bugs visuales + limpieza). Se auditó todo el front con agentes de solo-lectura y se verificó cada hallazgo a mano antes de tocar.
- **Bugs visuales arreglados (cliente):**
  - **Ruleta:** los 3 selectores `#rouletteWinnersList .winner-row, ...` en `index.html` estaban mal agrupados (la coma dejaba el modificador `:last-child`/`.is-me` pegado solo al modal) → en el home TODAS las filas salían con fondo dorado de "ganaste vos" y sin separadores. Corregido (cada selector lleva su propio modificador).
  - **Botón notificaciones:** los estados `.active`/`.blocked`/`.compact` apuntaban a `.header-right` (estructura vieja); el botón vive en `.tb-right`. Se reanclaron en el `<style>` inline del toolbar (`.header-toolbar .notification-btn.active/.blocked`) → ahora cambia de color (verde activo / gris bloqueado) en la PWA instalada.
  - **Botón "Instalar app":** heredaba un glow verde pulsante de `.app-install-btn` sobre el botón violeta del toolbar → incoherente. Se neutralizó (`animation/box-shadow/text-shadow: none`) scopeado al toolbar; `.app-install-btn.show` (visibilidad) intacto.
  - **Toasts:** `z-index` 10000 → 26000 (`base.css`) para que no queden detrás de los modales de ruleta (25500)/plataforma (20000).
- **Bugs visuales arreglados (admin):**
  - **12 íconos en blanco** (`icon-edit/trash/gift/star/image/info/list/mobile/undo/balance/exclamation/spinner`): se usaban en el markup pero no tenían `content` en `admin.css`. Agregados los emoji.
  - **Sección Comandos** sin estilo de tarjeta: el JS renderiza `.command-card/.command-info/.command-response` pero el CSS solo tenía `.command-item` (viejo). Renombrado a `.command-card` + agregados `.command-info`/`.command-response`.
- **Limpieza de código muerto (verificada: 0 referencias en HTML/JS/onclick/window.\*):**
  - `header.css`: **−384 líneas**. Bloques de features muertas tras el rediseño del header: drawer móvil completo, promo-banner, fueguito viejo (`.fire-btn`/`fire-pulse`), `platform-section`/`jugaygana-btn`/`plataforma-btn`, `info-btn`/`support-btn`/`header-left`/`header-center`/`user-action-btns`. Se PRESERVÓ todo lo vivo: `.header` (el header actual es `class="header header-toolbar"`), `.header-right`, `#notificationBtn`/`#appInstallBtn` (media queries de visibilidad), `.app-install-btn`, `.refund-btn`, `golden-shimmer` y el `@media (max-width:768px)`.
  - `admin.js`: 6 funciones nunca llamadas (`verifyDatabaseAccess`, `exportDatabaseCSV`, `handleCommandKeydown`, `prefetchFrequentConversations`, `renderMessagesUltraFast`, `smsValidarTelefono`) + `escapeHtml` definido DOS veces (se borró la copia muerta de L4452; gana la de L8182 por hoisting) + bloque CSS de la sección database vieja + `@keyframes spin`/`icon-download` duplicados en `admin.css`.
  - Cliente: 2 stubs vacíos (`handleFindUserByPhone`, `handleResetPasswordByPhone` + exports) y 4 funciones huérfanas (`toggleDrawer` con DOM ya inexistente, `openWinners`, `renderAdSection`, `showPlatformPasswordInfo`/`copyPlatformPassword`) + limpieza de sus listas de export. Se PRESERVARON `copyText` y `showInstallInstructions` (vivas).
  - **94 `console.log` de debug** eliminados (cliente + admin). Se conservaron TODOS los `console.error`/`console.warn` (manejo de errores). Detección previa confirmó 0 casos de `console.log` como cuerpo de `if` sin llaves y 0 multilínea → borrado seguro de sentencias puras.
- **NO tocado a propósito (riesgo/valor):**
  - `responsive.css`: ~29 reglas muertas (mismos elementos inexistentes) PERO dispersas dentro de 20 media queries y una agrupada con una clase viva (`.user-name`). Son no-op (ajustan en breakpoints elementos que no existen) → se dejaron para no arriesgar romper la estructura de los `@media` por limpiar bytes muertos.
  - **A1 — sidebar del admin inaccesible en celular** (no hay botón ☰ que agregue `.sidebar.open`): bug funcional real en móvil, pero el owner pidió dejarlo por ahora.
  - `checkUsernameAvailability` (cliente): el chequeo de "usuario disponible" en el registro existe pero nunca se dispara → es una MEJORA pendiente (reconectarlo), no código muerto; se dejó intacto.
  - `syncPayout` (admin): función del botón "Sincronizar pago colgado" (banner revertido en #66); se dejó por ser útil e inofensiva.
- **Validado:** `node --check` OK en los 10 JS tocados; llaves balanceadas en `base.css`/`header.css`/`admin.css`. Net **−835 líneas** (46 ins / 881 del). Back NO necesita redeploy de lógica; es front → recargar la PWA y el panel (subir `CACHE_VERSION` del SW si se quiere forzar). Sin migraciones.

## Sesión 2026-06-25

### 78. JUGAYGANA lento → "Error de conexión": timeout corto + retry + mensaje claro
- **Causa (logs):** `ShowUsers timeout of 20000ms` 117× → al chequear saldo, JUGAYGANA tardaba 20s y colgaba al
  cliente → "Error de conexión" con el server arriba.
- **Fix:**
  - `lookupUserOrError` (ShowUsers) ahora usa **timeout 12s por-llamada** (antes el global de 20s). Es una LECTURA,
    debe fallar rápido. NO toca el global de login/createUser (que siguen en 20s).
  - El **retiro** (`/api/withdrawal/request`) ahora chequea saldo con `getUserBalanceWithRetry` (2 intentos) en vez
    de `getUserBalance` simple → el reintento entra la mayoría de las veces (JUGAYGANA es flaky).
  - Mensaje claro al cliente si falla: "La plataforma está demorada, esperá unos segundos" (HTTP 503), en vez de
    colgar y mostrar "Error de conexión".
- **No tocado:** los endpoints de DISPLAY de saldo (6436/6455/6919) — ya se benefician del timeout 12s; agregar
  retry ahí duplicaría la espera sin necesidad.
- **Validado:** `node --check` OK (server.js, jugaygana.js).

### 77. 2do bug igual al del retiro: install-bonus/claim `amountFmt is not defined` (376×) + análisis logs
- **Re-análisis de logs a fondo (a pedido del owner):** los 500 "Error del servidor" tenían DOS causas de código
  (mismo patrón: copiar la respuesta de un handler a otro y dejar una variable de otro scope):
  - `withdrawal/request: result is not defined` → **341×** (ya arreglado en #75).
  - `install-bonus/claim: amountFmt is not defined` → **376×** (ARREGLADO acá: usaba `amountFmt`, variable del
    handler de retiro; el correcto es `INSTALL_BONUS_AMOUNT`). El bono ES idempotente (reserva atómica antes de
    acreditar) → los 376 NO dieron bono doble; el usuario recibía el bono pero veía "error" → confusión, no pérdida.
- **"Error de conexión" random SIN deploy (lo aclaró el owner):** NO son reinicios (45 deploys ≈ 48 arranques, casi
  todos deploy). Es **JUGAYGANA lento**: `ShowUsers timeout of 20000ms` **117×** (~10/día) + `unable to verify the
  first certificate` (intermitente). Cuando una acción chequea saldo y JUGAYGANA tarda, el pedido se cuelga y el
  cliente corta → "Error de conexión" con el server arriba. PENDIENTE: bajar timeout + mensaje claro (a definir).
- **Validado:** `node --check` OK (server.js).

### 76. "Error de conexión" intermitente → diagnóstico por logs + graceful shutdown
- **Diagnóstico (logs EB Jun 14–25):** el server reinició **~48 veces en 11 días**. SIN crashes de código (0
  uncaughtException, sin stack traces), SIN errores de SMS/SNS. nginx: solo 6× 502 (durante reinicios). El
  `eb-engine.log` muestra muchísima actividad de deploy. Un deploy falló (Jun 23 19:48, `web.service exit-code 1`).
- **Causa:** los reinicios eran casi todos **deploys** (semana muy pesada de cambios). Como NO había **graceful
  shutdown**, EB mataba el proceso de golpe → los pedidos EN CURSO se cortaban → cliente veía "Error de conexión".
  No es bug de código ni de SMS.
- **Fix (código):** se agregó **apagado ordenado** en server.js (SIGTERM/SIGINT → `io.close()` + `server.close()`
  drena pedidos en curso, salida forzada a los 25s). Reduce muchísimo los "Error de conexión" en cada deploy.
- **Pendiente (config, lo hace el owner en consola EB):** activar **deploys rolling** (una instancia a la vez) para
  cero downtime. Y evitar deploys innecesarios. (Opción futura: reintento suave en el front para send-otp.)
- **Validado:** `node --check` OK (server.js).

### 75. FIX CRÍTICO retiro: 500 "Error del servidor" tras crear el pedido → solicitudes duplicadas + teléfono PY/AR
- **Incidente (moi1/moi2):** al solicitar retiro salía "Error del servidor" PERO la solicitud entraba (se creaba el
  PendingPayout + se mandaba "Recibimos tu solicitud"). El cliente reintentaba y se duplicaban las solicitudes
  (visto: el mismo $37.000 4 veces).
- **Causa (regresión #68):** la respuesta de `/api/withdrawal/request` todavía referenciaba `result.data` (el viejo
  `withdrawFromUser` que se eliminó al pasar a descontar-al-confirmar). `result` quedó undefined → ReferenceError →
  500, PERO DESPUÉS de crear el PendingPayout y mandar el mensaje. `node --check` no lo agarra (es runtime).
- **Fix:** se sacó la referencia a `result.data` de la respuesta. Además, **dedup**: si ya hay un retiro
  `pending_review` del MISMO monto creado hace <10 min, no se crea otro (devuelve éxito idempotente).
- **FIX teléfono PY/AR (mejora del #74):** `normalizePhoneKey` ahora saca el código de país + el "0" inicial
  (trunk PY/AR) + el "9" de móvil AR → el mismo número con 0 de Paraguay o 9 de Argentina cae en la MISMA clave
  (antes "últimos 10" no normalizaba el 0 → se colaba). Se actualizó también el chequeo de `verify-phone/send-otp`
  (faltaba, seguía por string exacto). Migración one-shot V2 (`migration_backfill_phonekey_v2_done`) que recalcula
  phoneKey de TODOS los verificados con la lógica nueva. Probado: PY con/sin 0 y AR con/sin 9 → misma clave.
- **PENDIENTE (#2 del owner):** "Error de conexión" intermitente al verificar teléfono / otras opciones → es un
  TIMEOUT (no un 500), probable lentitud de SMS (AWS SNS) o carga del server. Necesita logs para diagnosticar.
- **Validado:** `node --check` OK (server.js, security.js). Back necesita redeploy (corre la migración V2).

## Sesión 2026-06-24

### 74. Anti-multicuenta: email único + teléfono único robusto (clave normalizada)
- **Problema:** se creaban muchas cuentas con el MISMO email o el MISMO teléfono. Causa: (1) NUNCA se chequeaba
  email duplicado (ni en `register` ni en `register-quick`); (2) el SMS dejó de ser obligatorio al registrarse
  (commit "registro sin SMS") → el teléfono se verifica recién al retirar; y (3) el chequeo de teléfono era por
  STRING EXACTO → el mismo número en otro formato (+54.., 011.., con/sin 9) se colaba.
- **Decisión owner:** el registro queda SIN teléfono (se verifica al retirar, como ahora), PERO un número ya
  verificado por otro usuario NO se puede volver a verificar (números únicos por usuario) + bloquear emails duplicados.
- **Fix:**
  - **`phoneKey`** (nuevo campo en User): clave normalizada del teléfono = solo dígitos, últimos 10 (helper
    `normalizePhoneKey` en `security.js`). El MISMO número en distinto formato → misma clave.
  - Los 4 puntos que verifican teléfono (`register`, `change-password`, `change-password/pending`,
    `verify-phone/confirm`) ahora chequean unicidad por `phoneKey` (no por string exacto) y setean `phoneKey` al verificar.
  - **Email único:** `register` y `register-quick` ahora rechazan si el email (case-insensitive) ya está en otra
    cuenta. Solo valida si el cliente cargó email (es opcional). NO rompe las cuentas existentes que ya compartan email.
  - **Migración one-shot** `migration_backfill_phonekey_done`: rellena `phoneKey` en los usuarios con teléfono ya
    verificado, para que el chequeo funcione contra los existentes.
- **No tocado:** los lookups de login-por-teléfono / reset siguen por `phone` exacto (no son unicidad, y cambiarlos
  arriesgaba romper el login).
- **Validado:** `node --check` OK (server.js, User.js, security.js). Back necesita redeploy (corre la migración).

### 73. Reembolsos: ahora sobre el NETWIN/GGR REAL (no sobre cargas − retiros)
- **Hallazgo:** los reembolsos (diario/semanal/mensual) se calculaban sobre `cargas − retiros` (flujo de caja),
  NO sobre la pérdida real de juego. Pagaban de más (contaban como "pérdida" plata que el cliente tenía en saldo).
  Había un comentario "consultar NETWIN (misma fuente que referidos)" pero NUNCA se conectó: el `jugayganaUserId`
  se usaba solo para validar que la cuenta esté vinculada, y el cálculo seguía siendo depósitos − retiros locales.
- **Fix:** se conectó `referralRevenueService.getUserNetwinForDateRange(username, jgId, fromDate, toDate, label)`
  (ya existía, construida para reembolsos: consulta `royalty-statistics` de JUGAYGANA por rango de fechas y devuelve
  `totalGgr` = apostado − ganado). Ahora `netLoss = max(0, totalGgr)` = **pérdida REAL del juego** en el período.
  - **Status** (`/api/refunds/status`): 3 llamadas netwin en paralelo (daily/weekly/monthly). Si una falla → ese
    netLoss = 0 (no preview de más).
  - **Claims** (`/api/refunds/claim/{daily|weekly|monthly}`): usan netwin; si JUGAYGANA no responde → NO reembolsa
    (mensaje "no pudimos calcular tu pérdida, probá más tarde"), no paga a ciegas.
- **% sin cambios** (20/10/5 editables). El reembolso = % × netwin real.
- **Pendiente conocido (no pedido):** los períodos semanal y mensual se pueden SOLAPAR (semana pasada dentro del
  mes pasado) → doble reembolso (10%+5%) en esa franja. Se mencionó al owner; no se tocó.
- **Nota de carga:** el status ahora hace 3 consultas a JUGAYGANA (antes eran aggregates locales). El front NO
  pollea el status en loop (solo al abrir / tras reclamar / al vencer el contador), así que la carga es ocasional.
- **Validado:** `node --check` OK (server.js). Back necesita redeploy.

### 72. Premios del Fueguito EDITABLES desde el panel (Config['fireMilestones'])
- **Pedido:** poder armar/cambiar los premios del fueguito (días + montos + requisitos) sin tocar código.
- **Backend:** `FIRE_MILESTONES` pasó a ser editable: `getFireMilestones()` lee `Config['fireMilestones']`
  (normaliza/clampea/ordena/dedup por día; todos type:'cash'); si no hay config usa `FIRE_MILESTONES_DEFAULT`
  (10/20/30 días = $10k/$50k/$200k). Los 3 endpoints (status, claim, claim-reward) ahora hacen
  `await getFireMilestones()`. `nextReward` calculado del próximo hito (no hardcodeado).
  - Endpoints admin (solo admin general): `GET/POST /api/admin/fire-milestones`.
- **Panel:** card "🔥 Premios del Fueguito" en COMANDOS (al lado de reembolsos): tabla editable con día, premio $,
  requisito de carga $, en N días, descripción; botones agregar/quitar fila + guardar. `loadFireMilestones`/
  `addFireMilestoneRow`/`saveFireMilestones` en admin.js.
- **Nota:** todos los premios son EFECTIVO (se sacaron los bonos en #71). Requisito 0 = sin requisito de carga.
- **Validado:** `node --check` OK (server.js, admin.js). Back necesita redeploy; panel, recargar.

### 71. Se SACARON todos los bonos automáticos (queda el 100% recuperación Comunidad) + ruleta solo activos
- **Decisión owner:** sacar TODOS los bonos automáticos. Se mantiene SOLO la oferta `/sys_recover_100` (100% de
  recuperación de Comunidad, post-carga). Se mantienen también: premios en efectivo del fueguito (día 10/20/30),
  reembolsos, bono por instalar app.
- **Apagados (kill switches en código, reversibles poniendo el flag en false):**
  - **Estrategia por voto:** `BONUS_STRATEGY_DISABLED = true`.
  - **Inactividad** (bono % + regalo ticket alto): `INACTIVIDAD_DISABLED = true` (early-return en `_runInactividadTick`).
  - **Bonos % de reglas de notificación:** `CHARGE_BONUSES_DISABLED = true` en `notificationRulesService.activateChargeBonuses`
    (las notis de enganche siguen saliendo, pero ya NO crean PromoBonus). La estrategia por voto también lo usaba → doble apagado.
  - **Fueguito día 15** (bono en próxima carga): hito SACADO de `FIRE_MILESTONES` (quedan solo los de efectivo).
    La migración #70 (`migration_clear_fire_nextload_done`) ya limpia los `pendingNextLoadBonus` que quedaron.
  - (encuesta ya estaba apagada desde #57).
- **Ruleta diaria — solo CLIENTES ACTIVOS:** activo = MÁS DE 10 cargas reales (deposits, sin regalos/devoluciones)
  en los últimos 30 días (`_rouletteIsActiveClient`, const `ROULETTE_MIN_CARGAS_30D=10`). El status devuelve
  `eligible=appOk && active` (la card se oculta si no califica) + `needsActive`; el spin bloquea con 403 si no es activo.
  Fail-open ante error de DB (no castiga por un fallo de lectura).
- **Resultado:** ningún motor crea PromoBonus automático. Lo único que "regala" automático es la oferta de Comunidad.
- **Validado:** `node --check` OK (server.js, notificationRulesService.js). Back necesita redeploy.

### 70. El "bono 100% a clientes activos" era el FUEGUITO (hito día 15) → bajado a 30%
- **Diagnóstico:** el owner reportaba bonos del 100% a clientes ACTIVOS. Verificado que NINGÚN motor de bonos los
  crea (inactividad/notificaciones/estrategia/encuesta TODOS capean a ≤30%). El 100% salía del **FUEGUITO**: el hito
  `day:15` (`FIRE_MILESTONES`) era `type:'next_load_bonus'` = "100% en próxima carga", que ganan los clientes que
  mantienen la racha 15 días (activos). El sistema marca `pendingNextLoadBonus` y el agente aplica el 100% a mano.
- **Cambio (decisión owner):** el hito día 15 baja de **100% → 30%**. Es solo texto (el flag es booleano; el agente
  aplica el % manualmente): se cambió el `desc` del milestone, el mensaje de claim (server.js), el banner + confirm
  del agente (admin.js) y los textos del cliente (fire.js). El `/sys_recover_100` (oferta de "100% de recuperación"
  post-carga) es OTRA cosa, no se tocó (es editable desde COMANDOS).
- **Limpieza de pendientes:** migración one-shot `migration_clear_fire_nextload_done` que pone `pendingNextLoadBonus:
  false` a TODOS los que lo tenían pendiente → no se les aplica el 100% viejo. Corre una vez en el próximo deploy.
- **Validado:** `node --check` OK (server.js, admin.js, fire.js). Back necesita redeploy; panel/cliente, recargar.

### 69. FIX "Limpiar pagos viejos": ahora incluye pending_review y descarta TODOS
- **Problema:** el botón "🧹 Limpiar pagos viejos colgados" solo tocaba `paying`/`failed` y NO los `pending_review`,
  que son justo los que aparecen en el banner del chat → "no funciona". Además dejaba sin tocar los PENDING/sin-tx.
- **Fix:** `POST /api/admin/payouts/cleanup-old` ahora barre **pending_review + paying + failed** más viejos que
  `hours` (default 2, `0` = todos) y los **DESCARTA** (`cancelled`/dismissed) — salvo los que tienen transacción
  hgcash confirmada DONE, que quedan `paid` (silencioso). NO mueve plata ni devuelve fichas. El botón refresca el
  banner del chat abierto y avisa el resumen. Script `hgcash-cleanup-old-payouts.js` actualizado igual.
- **Validado:** `node --check` OK (server.js, admin.js, script). Back necesita redeploy; panel, recargar.

### 68. REDISEÑO retiros: descontar fichas al CONFIRMAR el pago (no al solicitar)
- **Problema:** el self-retiro descontaba las fichas al SOLICITAR; al rechazar había que DEVOLVERLAS con la lógica
  bonus/comunes, que fallaba seguido (devolvía mal / acuñaba saldo).
- **Nuevo flujo (decidido con el owner):**
  - **Solicitar (`/api/withdrawal/request`):** ya NO descuenta nada. Crea el `PendingPayout` con `deductAtPay:true`
    (chequea saldo solo como validación de UX). El saldo del cliente NO baja todavía.
  - **Confirmar (`/api/admin/payouts/:id/pay`):** helper nuevo `_deductChipsAtConfirm` descuenta las fichas AHORA
    (lee saldo → `withdrawFromUser` → verifica anti-fantasma que el saldo bajó). Solo si el descuento se CONFIRMA
    sigue el cash-out. Registra la `Transaction` de retiro recién acá.
    - **Saldo insuficiente (se jugó las fichas):** NO se paga; se marca `cancelled`, se manda mensaje EDITABLE al
      cliente (`/sys_withdrawal_insufficient`, vars `${amount}`/`${balance}`) y se CIERRA el chat (si el cliente
      escribe se reabre en "Abiertos"; si pide otro retiro va a Pagos). Helper `_notifyInsufficientAndCloseChat`.
    - **Pago hgcash falla DESPUÉS de descontar:** NO se devuelven fichas; nota interna "las fichas YA se descontaron
      ($X), pagá manual / reintentá". Igual en el webhook de error (`handlePayoutStatusWebhook`) si `deductAtPay+confirmado`.
  - **Rechazar (`/cancel`) con flujo nuevo:** si todavía no se descontó → NO devuelve nada (se acabó el bug). Si ya
    se había descontado (debitConfirmed===true, ej. cash-out falló) → devuelve el monto COMPLETO como fichas
    (devolución SIMPLE, sin split bonus/comunes).
  - **Pagar con otro banco (`/pay-other-bank`) con flujo nuevo:** también descuenta al confirmar antes de marcar pagado.
- **Compatibilidad:** los pagos VIEJOS (creados antes, con fichas ya descontadas) tienen `deductAtPay` falsy →
  mantienen el comportamiento previo (pagar = solo cash-out; rechazar = lógica vieja con split). No se re-descuentan.
- **Modelo:** `PendingPayout.deductAtPay` (Boolean, default false). Comando sembrado `/sys_withdrawal_insufficient`.
- **Panel:** `payPayout`/`payOtherBank` manejan la respuesta `{insufficient:true}` (toast claro + ocultan banner).
- **Validado:** `node --check` OK (server.js, PendingPayout.js, admin.js). Back necesita redeploy; panel, recargar.

## Sesión 2026-06-23

### 67. Botón "Limpiar pagos viejos colgados" en el panel (sin terminal) + script
- **Pedido:** el owner no maneja terminal → necesita limpiar los pagos viejos colgados con un clic.
- **Endpoint `POST /api/admin/payouts/cleanup-old`** (solo admin general): resuelve los PendingPayout viejos
  (paying/failed más viejos que `hours`, default 2h, máx 500): consulta hgcash y marca DONE→`paid` (SILENCIOSO,
  no re-avisa ni re-paga), ERROR/CANCELLED→`cancelled`. Los que siguen realmente pendientes (o sin token/tx) NO se
  tocan (se reportan en `pendingLeft`). NUNCA mueve plata.
- **Panel:** botón **"🧹 Limpiar pagos viejos colgados"** en el header de Movimientos hgcash (sección Comandos,
  admin general). Confirmación + toast con el resumen (pagados/descartados/pendientes). Función `cleanupOldPayouts()`.
- **Script equivalente** (para terminal): `scripts/hgcash-cleanup-old-payouts.js` (dry-run por defecto, `--apply`,
  `--no-verify`, `--hours=N`).
- **Validado:** `node --check` OK (server.js, admin.js). Back necesita redeploy; panel, recargar.

### 66. FIX URGENTE regresión de pagos: el banner resucitaba pagos viejos + pago no se confirmaba solo
- **Incidente:** tras #65, el banner de pago del chat pasó a mostrar pagos `paying`/`failed` (no solo
  `pending_review`). Resultado: aparecían pagos VIEJOS colgados (ej. "PAGO EN PROCESO $29.000") en el chat de un
  cliente, en cascada (al resolver uno aparecía otro viejo). Además el botón **"Reintentar pago"** en `failed`
  podía **RE-PAGAR un retiro viejo** (pérdida de plata). Y los pagos nuevos no se confirmaban solos: quedaban
  `paying` (el webhook de hgcash no llega — probable Cloudflare) y había que tocar "Sincronizar" a mano.
- **Fix:**
  - **Banner revertido a SOLO `pending_review`** (`loadPayoutBanner`): se quitó la rama paying/failed con los
    botones Sincronizar/Reintentar. El banner vuelve a mostrar únicamente el retiro actual a verificar, como antes.
    Elimina el riesgo de re-pago y la cascada de pagos viejos.
  - **Poller `_pollPayingPayouts` (server.js):** cada 45s (1er run a los 90s) consulta el estado real en hgcash
    (`getTransactionStatus`) de los pagos `paying` RECIENTES (últimas 2h) y, si están DONE, los confirma vía
    `handlePayoutStatusWebhook` (marca pagado + avisa + manda comprobante, TODO idempotente). Así los pagos se
    confirman SOLOS aunque no llegue el webhook, sin resucitar pagos viejos (>2h no se tocan).
  - **Re-chequeo rápido:** el endpoint `/payouts/:id/pay`, si el cash-out queda `paying`, dispara un poll a los 7s
    → el pago se confirma casi al instante sin esperar el poller.
- **OJO (acción del owner):** revisar si algún cliente recibió **doble pago** por el botón "Reintentar" (movimientos
  hgcash salientes duplicados al mismo CBU). "Sincronizar" NO movía plata (solo estado); "Reintentar" sí.
- **Causa de fondo (pendiente):** el webhook de estado de pago (`/api/hgcash/webhook` topic TRANSACTION_REQUEST) no
  llega → regla WAF "Skip" en Cloudflare para esa ruta. El poller es el respaldo mientras tanto.
- **Validado:** `node --check` OK (server.js, admin.js). Back necesita redeploy; panel, recargar.

### 65. Panel hgcash en TIEMPO REAL: saldo en vivo + actualización por socket + destrabe de pagos
- **Pedido (paso 3):** control de transacciones hgcash en tiempo real dentro de VipCargas, para que el agente no
  entre más a hg.cash.
- **Saldo en vivo:** endpoint `GET /api/admin/hgcash/balance` (solo admin general, cache 15s) que usa `GET /accounts`
  de hgcash (`balance`/`netBalance`/`status`). Widget "💰 Saldo hgcash" arriba de la tabla de movimientos +
  `loadHgcashBalance()`.
- **Tiempo real:** `_emitHgcashUpdate()` (server) emite `notifyAdmins('hgcash_movement')` cuando entra un movimiento
  nuevo (webhook) o se concreta una auto-carga. El panel escucha `socket.on('hgcash_movement')` → `hgcashLiveRefresh()`
  (throttle 2.5s, solo si el panel está visible; refresca movimientos página 1 + saldo). Además auto-refresco cada 25s
  mientras el panel está abierto (`startHgcashLive`), sin resetear la vista si el agente paginó (`window._hgcashPage`).
- **Destrabe de pagos colgados:** `GET /transaction/{id}/status` (hgcash) vía `hgcashPay.getTransactionStatus`.
  Endpoint `POST /api/admin/payouts/:id/sync` (withdrawer) que consulta el estado real y REUSA
  `handlePayoutStatusWebhook` para mapear (DONE→paid+aviso+comprobante; ERROR/CANCELLED→failed). En el panel, el banner
  de pago del chat ahora también muestra pagos `paying`/`failed` con botones **🔄 Sincronizar estado** (+ Reintentar/
  Otro banco/Rechazar/Descartar según estado). Función `syncPayout()`.
- **Sin romper nada:** el flujo `pending_review` del banner queda igual; solo se agrega la rama paying/failed. El saldo
  cachea 15s. Endpoints admin-only.
- **Validado:** `node --check` OK (server.js, hgcashService.js, admin.js). Back necesita redeploy; panel, recargar.
- **Limitación conocida (API hgcash):** NO hay listado de movimientos ENTRANTES por API (solo webhook) → la
  reconciliación de cargas depende de la confiabilidad del webhook (regla WAF "Skip" en Cloudflare para
  `/api/hgcash/webhook`). El saldo y los pagos salientes sí se consultan por API.

### 64. Comprobante de pago enviado COMO FOTO (rasterizado del PDF) + link al PDF oficial
- **Pedido:** que el comprobante (#63) le llegue al cliente como **foto** en el chat, no solo como link.
- **Cómo:** se baja el PDF (`hgcashPay.fetchReceiptPdf`), se **rasteriza la 1ª página a PNG** y se manda como
  mensaje `type:'image'` (data URL base64). Después se manda el **link al PDF oficial** (#63) como segundo mensaje.
  Si la foto no se puede generar, se manda solo el link (fallback).
- **Dependencia (OPCIONAL, sin riesgo de romper el deploy):** `mupdf@^1.27.0` — WebAssembly, **sin binarios nativos**.
  - Va en `optionalDependencies` → si fallara la instalación en EB, `npm ci` NO se cae (lo saltea).
  - `src/services/pdfImageService.js`: `pdfBufferToPng(buffer)` carga mupdf **lazy** con `import()` dinámico (mupdf es
    ESM) dentro de try/catch; ante cualquier error devuelve `null` → el caller manda el link. Nunca tira.
  - Probado localmente: PDF real → PNG válido; buffer inválido → null (fallback) sin romper. `npm ci --dry-run` OK
    (lockfile en sync). `node_modules` queda gitignoreado.
- **`server.js` `maybeSendPayoutReceipt`:** intenta foto (cap 4MB) y siempre manda el link; `data:image/png;base64`
  se renderiza en el chat del cliente (`public/js/chat.js` ya soporta imágenes data URL).
- **Validado:** `node --check` OK (server.js, pdfImageService.js, hgcashService.js). Back necesita redeploy
  (corre `npm ci` → instala mupdf).

### 63. Comprobante PDF automático al pagar un retiro (API hgcash)
- **Pedido:** cuando se confirma un pago (cash-out hgcash), mandarle al cliente el **comprobante PDF** automáticamente.
- **API:** `GET /transactions/{txId}/receipt` → `{ signedUrl }` (PDF, **vence en 1h**). El `{txId}` es el id de la
  TRANSACCIÓN real (≠ id del REQUEST que devuelve `POST /transactions`). Se resuelve con
  `GET /transaction-requests/{reqId}/transaction-id` → `{ transactionId }`, o viene en el webhook `transaction_associated`.
- **Implementación:**
  - `src/services/hgcashService.js`: nuevas `getTransactionIdForRequest(reqId)` y `getReceiptUrl(txId)`.
  - `PendingPayout`: nuevos `hgTxId` (id de transacción real) y `receiptSentAt` (idempotencia). Aclarado que
    `hgTransactionId` guarda el id del REQUEST.
  - `server.js`:
    - `handlePayoutStatusWebhook`: captura `p.transactionId` → `hgTxId`; en `DONE` dispara `maybeSendPayoutReceipt`.
    - `resolvePayoutTxId(payout)`: devuelve `hgTxId` o lo pide a la API con el reqId y lo cachea.
    - `maybeSendPayoutReceipt(payout)`: resuelve el txId (3 reintentos x4s por si tarda en asociarse), reclama
      atómico `receiptSentAt` (no duplica entre webhook DONE + pago inmediato) y manda al cliente un mensaje con un
      **link PERMANENTE nuestro** `/api/payout-receipt/:id`.
    - Endpoint PÚBLICO `GET /api/payout-receipt/:payoutId` (sin auth, clave = payout.id UUID): en cada visita resuelve
      un **signedUrl fresco** de hgcash y redirige (302). Así el link nunca queda vencido (la URL firmada dura 1h).
    - También se dispara en el camino DONE-inmediato del endpoint `POST /api/admin/payouts/:id/pay`.
  - El link se auto-linkea en el chat del cliente (`public/js/chat.js`). Pago por "otro banco" NO manda PDF (no hay
    transacción hgcash).
- **Validado:** `node --check` OK (server.js, hgcashService.js, PendingPayout.js). Back necesita redeploy.
- **PENDIENTE (paso 3):** panel hgcash en tiempo real (saldo en vivo `GET /accounts` + entrantes/salientes en vivo por
  socket + badge de estados + destrabe de pagos colgados `GET /transaction/{id}/status`).

### 62. FIX CRÍTICO doble/triple carga hgcash: 1 transferencia se acreditaba 2-3 veces
- **Incidente (VipAnto591):** un comprobante de $35.000 generó **3 cargas** (1 manual del agente + 2 automáticas).
  Confirmado en JUGAYGANA (depósitos 13:13:57 manual, 13:16:59 auto, 13:17:51 auto). **No es aislado:** el barrido
  de logs (6 días) mostró ~99 pares sospechosos y al menos otro caso DURO (VipBelen037, $30.000 cargado 3 veces).
- **Causa raíz (2 fallas que se combinan):**
  1. **El claim atómico protege documentos, no la plata real.** El movimiento se reclama por `movementId` y el
     comprobante por su `id`. Eso evita cargar 2 veces el MISMO documento, pero NO la misma TRANSFERENCIA cuando hay
     (a) **varios `BankMovement` de una sola transferencia** (hgcash reenvía con otro `id`, mismo `coelsaCode` — el
     webhook dedupea solo por `movementId`), y/o (b) **varios `Comprobante` matcheables** del mismo recibo (un
     comprobante duplicado igual se guardaba con `bankMatchStatus:'none'` → seguía siendo candidato). Cada movimiento
     agarra un comprobante distinto → ambos cargan, sin disparar el guard de ambigüedad.
  2. **La carga manual antes de que llegue el movimiento no protegía.** `hgcashConsumeOnManualDeposit` sólo mira
     movimientos que YA existen. Cuando el agente carga a mano y el aviso del banco llega después, se auto-carga igual.
- **Fix (idempotencia anclada en `coelsaCode` = el "DNI" único de cada transferencia + red de seguridad):**
  - **Modelo nuevo `HgcashCharge`** (`src/models/HgcashCharge.js`): índice ÚNICO en `chargeKey`. Candado atómico entre
    instancias (AWS EB multi-instancia).
  - **`hgcashAutoCarga` (server.js):** antes de acreditar reclama `chargeKey = coelsaCode || externalId`. Si ya existe
    (11000) → **NO recarga**, marca el movimiento `duplicate` y avisa. Una transferencia = una carga. Si la carga falla
    en JUGAYGANA, el candado se BORRA (deleteOne) para permitir reintento legítimo.
  - **Red de seguridad (mismo `hgcashAutoCarga`):** si ya hubo una carga del MISMO monto a ese usuario hace pocos
    minutos (config `duplicateGuardMinutes`, default 8), **no carga sola → `needs_review`** + aviso "verificá si son 2
    transferencias reales y cargá a mano". Cubre el caso manual-y-después-webhook (VipAnto591) y duplicados sin coelsa.
  - **Comprobantes `duplicate` excluidos de candidatos** en `hgcashMatchFromMovement` (`status: { $ne:'duplicate' }`).
  - **`hgcashConsumeOnManualDeposit`** ahora también consume movimientos `needs_review` (al cargar a mano se limpian).
  - **Estados nuevos** `duplicate` y `needs_review` en `BankMovement.matchStatus` y `Comprobante.bankMatchStatus`;
    badges + filtros en el panel (`admin.js`/`index.html`).
- **Para el agente:** en el 95% NADA cambia (carga automática igual). Sólo aparece un aviso nuevo "⚠️ POSIBLE
  DUPLICADO — revisá y cargá a mano" cuando hay monto repetido en ventana corta. La atribución del usuario sale del
  chat; un movimiento frenado se limpia solo si el agente carga a mano ese monto.
- **Reporte de afectados (one-shot, SOLO LECTURA):** `scripts/hgcash-duplicates-report.js` — agrupa `BankMovement`
  por `coelsaCode` y lista DEFINITIVOS (mismo coelsa cargado 2+ veces, con sobrante total a descontar) vs PROBABLES
  (mismo usuario+monto en ventana, a revisar). Correr: `node scripts/hgcash-duplicates-report.js`.
- **Mitigación inmediata recomendada:** poner hgcash en modo SOMBRA desde el panel hasta desplegar este fix.
- **Validado:** `node --check` OK (server.js, HgcashCharge.js, BankMovement.js, Comprobante.js, admin.js, script).
  Back necesita redeploy; panel, recargar.
- **PENDIENTE (próximos pasos pactados):** (2) comprobante PDF automático al pagar un retiro (API hgcash
  `GET /transactions/{id}/receipt`); (3) panel hgcash en tiempo real (saldo en vivo `GET /accounts` + entrantes/
  salientes en vivo por socket + destrabe de pagos colgados `GET /transaction/{id}/status`). NOTA: la API hgcash NO
  tiene listado de movimientos entrantes (sólo webhook) → la confiabilidad del webhook (regla WAF "Skip" en Cloudflare)
  es clave. Opción de fondo a evaluar: `checkouts` (links de cobro por cliente) eliminaría el matcheo de comprobantes.

### 61. FIX CRÍTICO retiro fantasma: el rechazo dejaba de acuñar saldo que el cliente nunca tuvo
- **Incidente:** un cliente pidió pago automático de $565.000 (lo tenía, se le pagó). Después solicitó
  $200.000 y $92.000 **sin tener fondos** (saldo real $991). Esos retiros igual generaron `PendingPayout`,
  y al darles **"Rechazar"** se le **devolvieron** $200.000 y $92.000 en fichas (DEPOSIT en JUGAYGANA) que
  hubo que sacar a mano. Capturas: JUGAYGANA mostraba DEPOSIT 200k/92k (la devolución) + WITHDRAW 200k/92k
  (la corrección manual), saldo siempre 991 → **no hubo descuento original**.
- **Causa raíz:** tras el pago grande, el saldo del listado **ShowUsers** de JUGAYGANA quedó **desactualizado
  (alto)**. Entonces (1) el chequeo de saldo de `/api/withdrawal/request` pasó con el saldo viejo, y (2)
  `jugaygana.withdrawFromUser` devolvió **falso éxito** (`WithdrawMoney` no chequea saldo; éxito = `success`
  o `transfer_id`) sin descontar nada. Se creó el `PendingPayout` **sin descuento real**. El **cancel
  re-acreditaba el monto completo a ciegas** (`depositToUser`), confiando en "el self-retiro ya descontó" →
  acuñaba fichas.
- **Fix (defensa en ambas puntas + flag de revisión; decisión owner: permitir pero marcar, no bloquear):**
  - **Al solicitar (`/api/withdrawal/request`):** tras `withdrawFromUser`, se relee el saldo
    (`getUserBalanceWithRetry`) y se exige que haya **bajado al menos el monto** (`debitConfirmed`). Se guardan
    `balanceBefore/balanceAfter/debitConfirmed` en el `PendingPayout`. Si no se confirma, **igual se crea** el
    pago pero queda marcado y se deja **nota interna** al agente ("verificá el saldo real antes de pagar; si
    rechazás, no se devuelven fichas solas").
  - **Al rechazar (`/api/admin/payouts/:id/cancel`):** si `debitConfirmed===false` → **NO devuelve fichas**;
    cancela y deja nota para devolver a mano si corresponde (`skippedRefund:true`). Pagos viejos
    (`debitConfirmed` null/undefined) **siguen con el comportamiento previo** (compatibilidad).
  - **Modelo `PendingPayout`:** nuevos campos `balanceBefore`, `balanceAfter`, `debitConfirmed` (default null).
  - **Panel (`adminprivado2026`):** el banner del retiro se pinta **rojo** + cartel "⚠️ Descuento NO confirmado"
    cuando `debitConfirmed===false`; el `confirm()` y el toast del rechazo aclaran que puede no devolver fichas.
- **Nota:** sólo cambia el camino de **rechazo** ante descuento no confirmado; **pagar** un retiro flageado no
  se bloquea (el agente verifica el saldo real). El riesgo de falso flag (lectura lenta) sólo cuesta que, si se
  rechaza ese retiro, la devolución se haga a mano.
- **Validado:** `node --check` OK (server.js, PendingPayout.js, admin.js). Back necesita redeploy; panel, recargar.

## Sesión 2026-06-22

### 60. Estrategia por voto reactivada (≤30%) + regalo ticket alto $3.000 + tablero de reactivación
- **Estrategia por voto (BonusStrategyConfig):** reactivada (estaba apagada en #57). Ahora **escalonada y
  capeada a 30%** (defaults 15% → 30%) y vigencia ≤2h. `BONUS_STRATEGY_DISABLED=false`; validación del POST
  `_step` capea percent ≤30 y duración ≤120min; el GET clampea para mostrar (por si quedó un singleton viejo
  50/100); modelo `BonusStrategyConfig` con `stepSchema` max 30 y defaults 15/30. El runtime ya estaba protegido
  por el cap de `activateChargeBonuses` (#58).
- **Regalo de reactivación TICKET ALTO ($3.000):** nuevo, dentro de `inactividadService`. Para clientes de
  ticket alto (ticket promedio ≥ `minTicketARS`, default $30.000) que dejaron de cargar ≥ `dias` (default 14):
  un **regalo de monto fijo ≤$3.000**, **máximo 1 vez por mes** (fireKey con mes ART), vigencia configurable
  (default 48h, máx 7d). Se entrega por **push** ("reclamá con soporte") y se registra como `PromoBonus`
  (`sourceRuleCode:'regalo_ticket_alto'`, `montoFijoARS`, percent 0). Si un cliente califica para el regalo,
  ese tick recibe el regalo en lugar del bono %. La agregación de inactividad ahora trae también total+cantidad
  de cargas (para el ticket promedio). Config en `inactividadConfig.regaloTicketAlto` (defaults + caps en
  `mergeInactividadConfig`, tope `REGALO_TA_MAX_ARS=3000`). Apagado por defecto.
- **Banner de bono:** `_getActivePromoBonus` ahora filtra `percent > 0` → los regalos (percent 0) no aparecen
  como "0%" en el banner de "% en la carga"; se entregan por push/soporte y se trackean aparte.
- **Tablero de seguimiento de reactivación:** nuevo `GET /api/admin/reactivacion/stats?days=` (solo admin
  general) que agrega TODOS los `PromoBonus` por `sourceRuleCode` y por día: **enviados** (creados),
  **reclamados** (status used), tasa de reclamo, activos, e **ingreso** (cargaMonto de los reclamados). En el
  panel, sección **Inactivos** → card "📊 Seguimiento de estrategias de reactivación" (tarjetas + tabla por
  estrategia + serie por día). Los regalos se reclaman con soporte (no se marcan used solos) → para esos se
  mira "Enviados". La sección Inactivos ahora también tiene la card "💎 Regalo para clientes de ticket alto"
  para activar/configurar; el input de % de la escalera y la vigencia se capean en la UI (30% / 2h).
- **Validado:** `node --check` OK (server.js, inactividadService.js, BonusStrategyConfig.js, admin.js).
  Back necesita redeploy.

### 59. Analítica de historias de influencer: conversión, retención y ranking por score combinado
- **Pedido:** análisis más detallado de historias por influencer — conversión por historia, retención por
  historia, y un **ranking de influencers** (mejor→peor) según retención de clientes fieles, ticket promedio,
  ROAS promedio y costo por click. Clave: una historia de un influencer puede ser rentable y otra del MISMO
  influencer no, así que se necesita ver historia por historia + el influencer agregado + el ranking.
- **Backend (`publisherAnalyticsService.js`):**
  - `getInfluencerStoryAnalysis` enriquecido: por historia (y en totales) ahora calcula **conversión**
    (registros→clientes), **clientes fieles** (≥5 cargas, count + %), **clientes activos** (cargaron ≤7d,
    count + %), **ticket promedio**, **clicks** y **CPC** (costo/clicks). Trackea la última carga por usuario.
  - Clicks: `CampaignClick` es por campaña (no por influencer) y TTL 90d → se atribuyen por ventana horaria
    igual que los usuarios; en historias de +90d puede no haber dato. Aclarado en la UI.
  - Nuevo `getInfluencerStoriesRanking(campaignCode)` + helper `_influencerScore(totals)`: score 0-100
    **combinado balanceado** (decisión owner): ROAS 35% + retención de fieles 30% + ticket 20% + CPC 15%.
    Normaliza cada métrica con topes fijos (`INF_ROAS_CAP=2`, `INF_TICKET_CAP=50000`, `INF_CPC_CAP=2000`);
    CPC sin clicks → neutro 0.5 (no castiga historias viejas). Ordena por score desc (desempate por neto).
- **Endpoint:** `GET /api/admin/influencer-stories/ranking?campaign=CODE` (adminMiddleware).
- **Panel (`adminprivado2026`):**
  - Tabla de historias (modal 📖 Historias) ampliada con columnas Conv. / Fieles / Activos / Ticket / CPC,
    en filas, "antes de la 1ª historia" y total.
  - Pestaña "🎬 Por influencer" → botón **"🏆 Ranking por historias"** que abre `influencerRankingModal`:
    tabla **ordenable** por cualquier columna (score, ROAS, fieles, activos, ticket, CPC, conversión, clientes,
    neto, #historias), con medallas 🥇🥈🥉 y el desglose del score. Funciones `openInfluencerRanking`/
    `rankSortBy`/`renderInfluencerRankingTable`/`closeInfluencerRankingModal`.
- **Validado:** `node --check` OK (server.js, publisherAnalyticsService.js, admin.js). Back necesita redeploy.

## Sesión 2026-06-21

### 58. Reembolsos vueltos a 20/10/5 (editables) + tope global 30% en TODO bono + limpieza de bonos viejos
- **Reembolsos:** el owner pidió **volver a 20% diario / 10% semanal / 5% mensual** (revierte el 8/3/3 de la #56),
  PERO manteniendo la edición desde el panel. Solo se cambió `REFUND_PCT_DEFAULTS` a `{20,10,5}` en server.js
  (+ fallback en refunds.js y placeholders del HTML). El mecanismo de Config `refundPercents` + card del panel
  (solo admin general) queda igual: si el owner nunca toca el panel, rige 20/10/5.
- **Tope global de bono 30%/2h:** `notificationRulesService.activateChargeBonuses` (el 3er punto que crea
  PromoBonus, usado por reglas de notificación con chargeBonus) ahora clampea `percent ≤30` y `durationMinutes ≤120`.
  Con esto, los TRES puntos que crean bonos quedan capeados: inactividad (≤30/2h), encuesta (bono apagado),
  activateChargeBonuses (≤30/2h). No queda ningún motor que pueda dar >30%.
- **Limpieza de bonos viejos (one-shot):** migración en `initializeData` (flag `migration_clear_old_promobonus_done`)
  que VENCE todos los `PromoBonus` activos al arrancar. Como todos los PromoBonus son automáticos (los bonos
  manuales del agente van directo a JUGAYGANA), esto deja la pizarra limpia: se sacan los 50%/100% viejos de
  encuesta/estrategia y el motor capeado de inactividad los repuebla. Corre UNA sola vez; los bonos nuevos no se tocan.
- **Reactivación de gente:** el motor de Inactividad ES la herramienta de reactivación (push + bono al que no
  carga hace ≥7d), ya capeado a 30%/2h. No se agregó otro motor: el tope 30% aplica a cualquier bono automático.
- **Validado:** `node --check` OK (server.js, notificationRulesService.js, refunds.js). Back necesita redeploy.

### 57. Estrategia de bonos reordenada: bono SOLO a inactivos (no carga ≥7d), ≤30% y ≤2h
- **Pedido del owner:** hoy se da mucho bono automático a gente ACTIVA y los bonos duran "miles de minutos"
  (caso visto: 50% · vence en 3774 min · "regla inactividad"). Querían: gente ACTIVA (cargó hace <7d) NO recibe
  bono automático, solo notificaciones de enganche según su plan; gente INACTIVA (no carga hace ≥7d) sí, pero
  bono **≤30%** y reclamable **≤2h** (después desaparece el botón solo).
- **Decisiones (vía preguntas):** escalera **7d → 30%** y **14d → 30%** (sin regalo); **apagar** los bonos de
  los motores que apuntan a gente activa (encuesta + estrategia por voto).
- **Motor de inactividad (`src/services/inactividadService.js`) — reescrito:**
  - Segmenta por **última CARGA real** (Transaction type:'deposit', excluye regalos/devoluciones), NO por último
    ingreso (`lastLogin`) como antes. Inactivo = su última carga fue hace ≥ `minDias`. Una sola agregación.
  - **Topes duros en código:** bono `MAX_BONUS_PERCENT=30`, vigencia `MAX_VIGENCIA_HORAS=2` (clampea aunque la
    config diga más). `fireKey` ahora usa el día de la última carga (si vuelve a cargar y se ausenta, reinicia).
  - Recibe el modelo `Transaction` (server.js `_runInactividadTick` lo pasa). Mensajes cambiados a "hace X días
    que no cargás… dura 2 horas".
- **Defaults/caps de config (`server.js`):** `INACTIVIDAD_DEFAULTS` ahora 7d/14d a 30% y `bonoVigenciaHoras:2`.
  `mergeInactividadConfig` clampea `percent ≤30` y `bonoVigenciaHoras ≤2` (constantes `REFUND_INACT_MAX_PCT=30`,
  `REFUND_INACT_MAX_VIG_HORAS=2`). La card de stats de Inactivos ahora cuenta por **última carga** (coherente).
- **Apagados (bonos a gente activa):**
  - **Encuesta (`encuestaService.cohortWeek`):** se quitaron los slots de BONO (`bDays = []`). La encuesta ahora
    manda SOLO incentivos de enganche ("jugá, divertite, estamos cargando"). Reversible: volver a `bonusDays(bonoN)`.
  - **Estrategia de bonos por voto (`_runBonusStrategy`):** neutralizada con `BONUS_STRATEGY_DISABLED=true`
    (early-return). El panel/endpoints quedan; no dispara bonos.
- **Las "notificaciones normales por plan"** (reglas PLAN-ACTIVO/NORMAL/SUAVE en notificationRulesService) ya eran
  `bonus:none` (puro enganche) → se mantienen como están. No hay otro motor automático de bono.
- **OJO (config existente):** los topes (30%/2h) se aplican solos al leer la config aunque en producción haya
  quedado la vieja (50%/72h). Pero los **pasos** guardados (ej. si había un 3er paso de regalo $5.000 a 30d) se
  conservan hasta que el owner entre a la sección **Inactivos** y guarde, o se fuerce. Los bonos YA creados
  (ej. el de 50%/63h) siguen vigentes hasta vencer/usarse — los NUEVOS ya salen capeados.
- **Validado:** `node --check` OK (server.js, inactividadService.js, encuestaService.js). Back necesita redeploy.

### 56. Reembolsos: bajados a 8/3/3 + porcentajes EDITABLES desde el panel (solo admin general)
- **Pedido:** bajar los reembolsos (eran 20% diario / 10% semanal / 5% mensual) a **8% diario, 3% semanal,
  3% mensual**, y poder cambiarlos fácil desde el panel sin tocar código (solo el admin general).
- **Backend (`server.js`):** los % dejan de estar hardcodeados. Nuevo `Config['refundPercents']` con helper
  `getRefundPercents()` (defaults `{daily:8, weekly:3, monthly:3}`, clamp 0-100). Lo usan `/api/refunds/status`
  y los 3 claims (`/api/refunds/claim/{daily|weekly|monthly}`) → el monto y el campo `percentage` salen del
  config. Nuevos endpoints **`GET/POST /api/admin/refund-percents`** (authMiddleware+adminMiddleware **+ check
  explícito `role==='admin'`** → SOLO admin general; depositor/withdrawer/comunidad reciben 403).
- **Cliente (`public/js/refunds.js` + `index.html`):** los % del modal salen ahora de `status.percentage`
  (no hardcodeados). Se sacaron los "20%/10%/5%" estáticos de los tooltips y los botones del modal unificado
  ahora tienen `<span id="unified*Pct">` que `updateRefundLabels()` actualiza con el valor real.
- **Panel (`adminprivado2026`):** nueva card "🎁 Porcentajes de reembolso" en COMANDOS (se oculta si no sos
  admin general, igual que la card de hgcash). Funciones `loadRefundPercents()`/`saveRefundPercents()`.
- **Nota:** al estar en Config, el valor sobrevive a redeploys. Si nunca se setea, usa los defaults 8/3/3.
- **Validado:** `node --check` OK (server.js, admin.js, refunds.js). Back necesita redeploy; front, recargar.

### 55. FIX Comunidad: re-aviso cuando un cliente derivado vuelve a escribir
- **Síntoma:** al derivar a alguien a Comunidad llega el aviso + badge, pero si el agente lo atiende una vez y
  pasa a "Abiertos", cuando ese cliente responde NO vuelve a avisar → el chat se pierde y se generan demoras
  en Comunidad porque el agente está respondiendo en "Abiertos".
- **Fix backend (`server.js`):** nuevo helper `maybeNotifyComunidadActivity(userId, username)` — cuando un
  cliente cuyo `ChatStatus.status==='comunidad'` manda un mensaje (rama HTTP `/api/messages/send` y socket
  `send_message`), emite `notifyAdmins('comunidad_activity', {userId, username})`. Fire-and-forget, no frena
  la entrega del mensaje.
- **Fix panel (`admin.js`):** nuevo handler `socket.on('comunidad_activity')` → si el agente (admin/comunidad)
  NO está en la pestaña Comunidad, re-avisa (badge + sonido + toast). `bumpComunidadAlert(userId, kind)` ahora
  cuenta **chats distintos** (Set `_comunidadSeenUsers`, no infla con un cliente que escribe mucho) y tiene
  **throttle de 3s** en el aviso sonoro. La derivación pasa `(userId,'derive')`; la re-actividad `(userId,'activity')`.
  Al entrar a la pestaña Comunidad se limpia el set.
- **Validado:** `node --check` OK (server.js, admin.js). Back necesita redeploy; front, recargar el panel.

## Sesión 2026-06-20

### 54. FIX rol comunidad: se deslogueaba al dar F5 / recargar la página
- **Síntoma:** el Admin Comunidad perdía la sesión al refrescar (F5) o reiniciar la página y tenía que
  loguearse de nuevo. Con admin/depositor/withdrawer/publisher_admin NO pasaba (quedaban logueados).
- **Causa raíz:** la persistencia de sesión del panel va por la cookie httpOnly `admin_api_session`. Había
  DOS listas de roles que omitían `comunidad`:
  1. **Login** (server.js L3128 normal y L3870 por OTP): la cookie solo se seteaba para
     `['admin','depositor','withdrawer','publisher_admin']` → comunidad nunca recibía la cookie.
  2. **`GET /api/admin/me`** (L3299, el endpoint que rehidrata la sesión al cargar la página): rechazaba a
     `comunidad` (403) aunque tuviera cookie → logout igual.
- **Fix:** se agregó `'comunidad'` a las 3 listas (login, login-OTP, /api/admin/me). Ahora recibe la cookie
  al loguearse y `/api/admin/me` la acepta → la sesión sobrevive al F5 como el resto de los roles admin.
- **Validado:** `node --check` OK (server.js). Back necesita redeploy.

### 53. FIX pago automático hgcash: 403 "No tienes acceso a esta cuenta" al cambiar de cuenta/token
- **Síntoma:** tras cambiar de cuenta hgcash (token nuevo en `HGCASH_API_TOKEN`), el pago directo
  automático (cash-out) fallaba con `HTTP 403 {"error":"No tienes acceso a esta cuenta"}`.
- **Causa raíz:** el cash-out manda el `accountId` de NUESTRA cuenta a debitar, que vivía cacheado en
  `Config['hgcash'].accountId`. Ese valor era de la cuenta VIEJA y el token nuevo no tiene acceso a ella.
  Trampa que dejaba clavado: (1) `ensureHgcashAccountIdSaved` solo guardaba `if (!cfg.accountId)` → NUNCA
  sobreescribía el viejo, aunque entraran movimientos de la cuenta nueva; (2) el panel NO tiene campo para
  editar/limpiar el `accountId` (solo accountName/cbu/mode/window/enabled) → no se podía corregir desde la UI;
  (3) `resolveHgcashAccountId` priorizaba `cfg.accountId` (viejo) sobre los movimientos recientes.
- **Fix (fuente de verdad = el token):** se usa el endpoint `GET /accounts` de hgcash (lista las cuentas a
  las que el TOKEN actual tiene acceso) para resolver el `accountId`. Así, al cambiar de cuenta/token, se
  actualiza solo y nunca más salta el 403.
  - `src/services/hgcashService.js`: nueva función `getAccounts()` (GET /accounts, Bearer del token).
  - `server.js` `resolveHgcashAccountId({force})`: 1) pregunta a la API y elige la cuenta por moneda
    (`cfg.currency`, default ARS) + estado "Operativa", y la cachea en config; 2) fallback al `accountId`
    cacheado; 3) fallback al último `BankMovement`. `force:true` ignora el cache (para reintentar tras 403).
  - `server.js` `POST /api/admin/payouts/:id/pay`: auto-recuperación — si el cash-out devuelve **403**,
    fuerza re-resolver el accountId desde la API y reintenta UNA vez con la cuenta correcta. El `externalID`
    es el mismo (= payout.id) → idempotente, no paga dos veces aunque el primer intento hubiera entrado.
- **Nota:** no requiere acción manual del owner — con el token nuevo en SSM, el accountId correcto se
  resuelve solo en el próximo pago. (Opcional pendiente: exponer el accountId en el panel para visibilidad.)
- **Validado:** `node --check` OK (server.js, hgcashService.js). Back necesita redeploy.

## Sesión 2026-06-19

### 52. FIX CRÍTICO rol comunidad: faltaba en enum Message.senderRole (rompía responder/cerrar/etc.)
- **Síntoma:** el Admin Comunidad no podía responder mensajes ni operar; error "Validación: `comunidad` is not a
  valid enum value for path `senderRole`" y toasts "[object Object]".
- **Causa raíz:** `Message.senderRole` tenía enum `['user','admin','depositor','withdrawer','system']` SIN `comunidad`.
  Los mensajes se guardan con `senderRole: req.user.role` / `socket.role` (server.js L5340, L7157, L11337), así que
  cualquier acción del comunidad que cree un mensaje (responder por socket/HTTP, cerrar chat) fallaba la validación.
- **Fix:** agregado `'comunidad'` al enum `Message.senderRole`.
- **Auditoría completa (pedida por el owner):** se revisaron TODOS los enums de TODOS los modelos. Los únicos campos
  de ROL son `User.role` (ya con comunidad), `Message.senderRole` (corregido) y `Message.receiverRole`
  (`['user','admin']`: comunidad nunca es receptor → ok). `Transaction.adminRole` no tiene enum. Los 3 únicos
  guardados dinámicos de rol (L5340/L7157/L11337) quedan cubiertos. Verificado a mano cada acción del comunidad
  (responder socket/HTTP, depósito, bonus, cargar saldo/info, cargar mensajes, CBU, cerrar chat, derivar) → todas OK.
- **Validado:** `node --check` OK (server.js, Message.js).

### 51. FIX devolución de bonus suelto + retiro mínimo $4.999
- **Bug (devolución como fichas en vez de bonus):** si el cliente tenía un BONUS SUELTO (botón Bonus / fueguito,
  `type:'bonus'`) y lo quiso retirar, al rechazar volvía como fichas normales. Causa: la detección solo miraba la
  última CARGA (`type:'deposit'` con campo `bonus>0`); un bonus suelto es `type:'bonus'` y además se guarda **sin
  `userId`** (solo `username`).
  - **Fix:** la detección del "último crédito" ahora considera `type` ∈ `['deposit','bonus']` y busca por
    `userId` **O** `username`. Si el último crédito es `type:'bonus'` → todo ese monto es bonus; si es carga con
    bonus → el campo `bonus`. Capeado al monto del retiro. (server.js, endpoint `payouts/:id/cancel`.)
- **Retiro mínimo $4.999:** no se puede solicitar un retiro menor a $4.999.
  - Backend: `/api/withdrawal/request` y `/api/movements/withdraw` ahora exigen `>= 4999`.
  - Frontend (`withdraw.js` + `index.html`): validación del form a $4.999, `min` del input, y el cartel de saldo
    bajo ahora dice "El retiro mínimo es de $4.999". (La carga manual del agente NO tiene este límite.)
- **Nota:** el cliente del caso reportado ya recibió la devolución vieja (como fichas); el fix aplica de acá en más.
- **Validado:** `node --check` OK (server.js, withdraw.js).

### 50. FIX rol comunidad: "Error cargando mensajes" / no veía chats
- **Síntoma:** el Admin Comunidad veía la LISTA de chats pero al abrir uno daba "Error cargando mensajes" (cruz roja)
  y el tiempo real no funcionaba.
- **Causa:** varios chequeos de rol en server.js usaban el array literal `['admin','depositor','withdrawer']` SIN
  `comunidad` → 403 en cargar mensajes y al traer info del usuario, y el socket no lo trataba como agente.
- **Fix:** se reemplazaron TODAS las ocurrencias de `['admin','depositor','withdrawer']` por
  `['admin','depositor','withdrawer','comunidad']` en server.js. Cubre: `GET /api/messages/:userId` (L5171),
  `POST /api/messages/send` (L5326), `GET /api/users/:userId` (info del chat), cookie de panel, protección de
  borrado de admins, conteo de admins, y los 4 handlers de Socket.IO (authenticate/join_admin_room/join_chat_room/
  send_message). Ninguno da acceso a Pagos (eso sigue gateado por withdrawerMiddleware / checks de 'payments').
- **Validado:** `node --check` OK (server.js).

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
