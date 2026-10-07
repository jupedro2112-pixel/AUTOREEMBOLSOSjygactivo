# Réplica — LOTES DE NOTIFICACIONES CON REGALO (código completo, para un repo que opera sobre JUGAYGANA)

Paquete para copiar y pegar el sistema de "🎁 Lote con regalo" de `AUTOREEMBOLSOSjygactivo`
(WORKLOG #149 base, #150 modal info, #164 ruleta/tope, #172 tope del % de lote, #173 bono
canjeado vence a 24 h + resumen por lote) en OTRO repo que también usa `jugaygana.js`.
Incluye **#177 (2026-10-03): fichas por tiempo con RECLAMO** (no se acredita a todos al enviar;
cada cliente toca "🎁 RECLAMAR" en la app y recién ahí se acreditan). Como el destino también es
JUGAYGANA, la acreditación de plata (`jugaygana.creditUserBalance`) se copia tal cual.

**El paquete se regenera solo:** `python3 docs/replicas/lotes-jugaygana/_extract.py` desde la raíz
del repo extrae el código ACTUAL por marcadores (el encabezado de cada archivo dice de qué commit
salió). Si en el futuro cambia el sistema de lotes, correrlo antes de mandar el paquete.

## ⚠️ OTRA PLATAFORMA — si el destino usa 1girox (giroxService) en vez de JUGAYGANA

El código del paquete es el real de JUGAYGANA. Para un repo girox sirve como referencia exacta de
QUÉ hacer, pero lo que toca PLATA se reescribe con lo que ese repo ya usa. Ojo: el sistema de lotes
NACIÓ en el repo girox PAUTANUEVA (#160/#169/#263 de aquel WORKLOG) y de ahí se portó acá (#149),
así que un repo girox puede tener ya una parte: **primero revisar qué existe y portar sólo lo que
falte** (#172 tope del %, #173 bono canjeado vence a 24 h + resumen, #177 fichas con RECLAMO).

| Pieza | ¿Depende de la plataforma? | Qué hacer en girox |
|-------|----------------------------|--------------------|
| `NotifBatch`, `PromoBonus`, audiencias, motor de envío, canje de código, franja horaria, `claimAuto/revert/settle` | No (Mongo puro) | copiar tal cual / completar lo que falte |
| `_creditNotifBatchGift` (fichas) | **SÍ**: `jugaygana.creditUserBalance` | usar el crédito de bono girox que ese repo ya tiene (con `rolloverX` real y reference idempotente). Con reference idempotente el reintento ante timeout ES seguro, a diferencia de acá |
| Hooks de las cargas (04): el % automático acredita con `jugaygana.creditUserBalance` | **SÍ** | en girox el % va como bonus de la MISMA carga (bonus_multiplier / bono con rollover), como ya lo hace su flujo de depósito; mantener el contrato reserva → crédito → settle / revert |
| `_alertMoneyAmbiguous` / `ambiguous:true` | **SÍ** (#151 es un problema de JUGAYGANA sin reference) | si girox confirma por reference, no hace falta la rama "ambiguo"; dejar sólo fallo limpio → revert |
| Tope del % de lote (01, `Config['hgcashAppBonus']`) | Parcial | usar la config del bono app que ese repo tenga (nombres de campos propios); si no tiene bono app, crear la config igual: es el tope del lote |
| `_rouletteHasAppInstalled`, `sendPushIfOffline`, `renderSystemCommand`, `_emitAdminOnlyChatNote` | No | adaptar nombres a los helpers que ya existan |
| Panel y PWA | No | copiar; cambiar textos "JUGAYGANA" y la moneda ($ → la del destino) |
| hgcash (hook 04.b) | Sólo si ese repo tiene auto-carga por banco | si no, sólo va el hook de la carga manual |

## Qué hace el sistema (para humanos)

Un agente manda una notificación (push + mensaje en el chat) a una AUDIENCIA (lista pegada de
usuarios / segmento inactivos–ex cargadores–activos con filtros / todos / código público) con un
REGALO:
- **% en la carga**, en dos modos: **⚡ automático** (el sistema lo suma solo en la carga manual
  sin bonus del agente o en la carga hgcash; "1ª carga" o "todas las cargas" hasta vencer; franja
  horaria diaria opcional en hora argentina) o **🧑‍💼 lo aplica el agente** (cartel verde en el chat
  + "Marcar usado"). El % respeta el tope del bono app (100% hasta $5.000, el excedente al 20%).
- **Fichas** fijas: se acreditan solas al enviar (topes anti-abuso: 3 créditos/24 h y $300k/7 d por
  usuario, alerta roja si se pasa). Sin reference idempotente en JUGAYGANA → ante fallo NO se
  reintenta solo (queda `creditError` para el agente).
- Entrega por **código** (sólo los del lote lo canjean desde el botón 🎁 de la PWA; una vez
  canjeado tenés `useHours` (24 h default) para usarlo) o por **tiempo** (bono activado a todos por
  N horas).
- **Fichas por tiempo con RECLAMO (#177, default):** al enviar no se acredita nada; el cliente ve
  un cartel "🎁 Tenés $X en fichas de regalo — RECLAMAR" en el inicio de la app y dentro del modal
  🎁; al tocarlo se reserva atómico y se acredita al instante (`GET /api/gift/pending`,
  `POST /api/gift/claim {batchId}`). Lo que no se reclama antes de la vigencia no se paga. El panel
  tiene un tilde "acreditar directo a todos" para el modo viejo, y el historial dice "N acreditados
  ($X) · N sin reclamar / no reclamaron (vencido)".
- Motor de envío **reanudable y multi-instancia** (claim atómico por destinatario, cron 45 s),
  historial "📤 Lotes enviados" con resumen por lote (canjearon / cargaron con el bono / activos /
  vencidos) y detalle por destinatario.
- El bono es un `PromoBonus` con `sourceRuleCode:'lote'`, `autoApply`, `applyScope`,
  `applyFromMin/ToMin`, `usesCount`. Nunca se suma a otro bono automático (bono app) ni al bonus
  que el agente pone a mano.

## Archivos del paquete (orden de pegado)

| # | Archivo | Va a | Notas |
|---|---------|------|-------|
| 1 | `models-NotifBatch.js` | `src/models/NotifBatch.js` | copiar entero |
| 2 | `models-PromoBonus.js` | `src/models/PromoBonus.js` | si el destino YA tiene PromoBonus, sumar los campos `sourceRuleCode, sourceRuleId, autoApply, applyScope, applyFromMin, applyToMin, usesCount, usesTotalBonus` y el índice `{username, status, expiresAt}` |
| 3 | `server-01-tope-lote.js` | server.js, zona de helpers (antes de las rutas) | `Config['hgcashAppBonus']` + `_loteBonusAmount` + `_loteCapTxt` + cache. Si el destino ya tiene el bono app (#164) sólo faltan `_loteBonusAmount`, `_loteCapTxt` y `_hgcashAppBonusCfgCache` |
| 4 | `server-02-promo-bonus-endpoints.js` | server.js, DESPUÉS de `const authMiddleware/adminMiddleware` | bono vigente del cliente + cartel del agente + marcar usado |
| 5 | `server-03-lotes-block.js` | server.js, DESPUÉS del anterior | el sistema completo (1.150 líneas) |
| 6 | `server-04-hooks-cargas.md` | DENTRO de `/api/admin/deposit` y de la auto-carga hgcash | leer y adaptar, no pegar suelto |
| 7 | `server-05-dependencias-helpers.js` | server.js | SÓLO los helpers que falten (ver abajo) |
| 8 | `panel-index.html.part` | `public/adminprivado2026/index.html` | 3 fragmentos: banner del chat, card del lote, historial |
| 9 | `panel-admin.js.part` | `public/adminprivado2026/admin.js` | funciones + 2 llamadas (al abrir chat / al abrir Notificaciones) |
| 10 | `pwa-index.html.part` | `public/index.html` | botón 🎁, card del bono, modal canjear/info, script |
| 11 | `pwa-ui.js.part` | `public/js/ui.js` + `app.js` + `socket.js` | funciones del modal + exports (incl. `syncBalance`) + listener + refresco al llegar un mensaje del sistema |
| 12 | `pwa-promobonus.js` | `public/js/promobonus.js` | card "tenés un bono vigente" + card/botón RECLAMAR de fichas (#177) |

## Dependencias que el bloque asume (verificar en el destino antes de pegar)

Del server (`server-03` las usa tal cual): `User`, `Message`, `Transaction`, `PromoBonus`,
`NotifBatch`, `getConfig(key, default)`, `io` (Socket.IO), `uuidv4`, `logger`, `jugaygana`
(`creditUserBalance(username, amount, jugayganaUserId)` que devuelve `{success, ambiguous, error,
data}` y `errToString`), `authMiddleware`, `adminMiddleware`, `authLimiter`, `_loteCapTxt`
(archivo 01), y los helpers del archivo 05: `sendPushIfOffline` (tiene que devolver
`{delivery}`), `renderSystemCommand`, `_alertMoneyAmbiguous`, `_emitAdminOnlyChatNote`,
`_rouletteHasAppInstalled`. Si el destino tiene equivalentes con otro nombre, renombrar las
llamadas en el bloque (no duplicar helpers). `req.user` tiene `{userId, username, role}`.

Del panel: `authFetch(path, opts)` (fetch con el token/cookie del panel), `showToast`,
`escHtml`, `fmtFechaHoraAR`. De la PWA: `showModal/hideModal`, `VIP.config.API_URL`,
`VIP.state.currentToken`, `VIP.ui.installApp`, el 🔔 de la barra (`giftInfoEnableNotifs` lo
dispara) y `/api/config/community` (URL del canal de Telegram para la vista ℹ️).

Mensajes `/sys_*` (editables desde COMANDOS): el bloque usa `/sys_deposit_bonus` en los hooks;
los textos del lote en sí van hardcodeados (mensaje del agente + línea "🎁 Tenés un …").

## Reglas de PLATA que NO se pueden perder al portar

1. `jugaygana.creditUserBalance` puede devolver `ambiguous:true` (HTML/timeout sin confirmar
   por saldo). En ese caso el bono queda CONSUMIDO (no se revierte) y se llama a
   `_alertMoneyAmbiguous` (nota 🛑 + Telegram). NUNCA reintentar.
2. Reserva atómica ANTES de acreditar: `claimAutoPromoPercent` (scope first → `active→used` en
   un `findOneAndUpdate`; scope all → `usesCount++`), después crédito, después `settle`; si el
   crédito FALLA limpio → `revert`. Lo mismo para el canje por código
   (`_tryClaimNotifBatchCode`: un canje por usuario, atómico en `NotifBatch.recipients`).
3. Una carga = como mucho UN bono automático: lote sólo si `!appBonus.applied` (hgcash) o
   `!bonusRequested` (manual). Si hay multicuenta confirmada por banco (#152), sin lote.
4. Multi-instancia: el motor de envío y el cron corren en cada instancia; la idempotencia está
   en los `updateOne` condicionales (`status:'pending'` → `'sent'`). No quitarlos.
5. Fuentes de Transaction que NO son plata del cliente: sumar `'notif_batch'` y
   `'notif_batch_auto'` a la lista de exclusión que el destino use para "cargas reales"
   (en este repo: `referralTierService.NON_BANK_SOURCES` y `bankCloseService.NON_BANK_DEPOSIT_SOURCES`).

## Trampas conocidas

- **TDZ en server.js:** `authMiddleware`/`adminMiddleware` son `const`; toda ruta `app.get/post`
  de los archivos 02 y 03 tiene que quedar DESPUÉS de esas definiciones o el server muere al
  arrancar (`node --check` NO lo detecta). Las funciones sí pueden ir antes (hoisting).
- **Hora argentina:** `_argMinuteOfDay` usa `America/Argentina/Buenos_Aires`; la franja incluye
  el minuto final (#172). No usar la hora del reloj del server.
- **Vencimiento lazy del PromoBonus:** se marca `expired` al consultarlo; el detalle del lote
  (`GET /api/admin/notif-batches/:id`) lo fuerza para contar "vencidos sin usar".
- **Cap 30% de lectura** en `_getActivePromoBonus`: los bonos de lote y ruleta están EXENTOS
  (`sourceRuleCode` lote/ruleta); si el destino no tiene ese cap, ignorar esa línea.
- **Front:** el panel usa `onclick` inline → los nombres `previewGiftBatch`, `sendGiftBatch`,
  `genGiftBatchCode`, `loadNotifBatches`, `toggleNotifBatchDetail`, `markChatPromoBonusUsed`
  tienen que quedar en `window`. Al tocar HTML+JS de la PWA juntos, bumpear `?v` y
  `CACHE_VERSION` del SW; en el panel, `CACHE_VERSION` de `admin-sw.js`.

## Prompt A — para un repo que también usa JUGAYGANA

```
Leé WORKLOG.md, docs/ARCHITECTURE.md y CLAUDE.md como siempre. Después leé ENTERO el paquete
de réplica que está en el repo gemelo clonado al lado (es código real, extraído tal cual):

  ~/Documents/AUTOREEMBOLSOSjygactivo/docs/replicas/lotes-jugaygana/README.md   ← primero
  ~/Documents/AUTOREEMBOLSOSjygactivo/docs/replicas/lotes-jugaygana/*            ← todos

Quiero implementar en ESTE repo el sistema completo de "🎁 Lote de notificaciones con regalo"
EXACTAMENTE como funciona allá (los dos repos operan sobre JUGAYGANA con jugaygana.js, así que
la plata va por jugaygana.creditUserBalance igual que en el paquete). Seguí el orden de la tabla
"Archivos del paquete":

1. Modelos NotifBatch y PromoBonus (si PromoBonus ya existe, sumar los campos que faltan).
2. server.js: helpers del tope (01), endpoints de PromoBonus (02) y el bloque completo de lotes
   (03). Antes de pegar, verificá la sección "Dependencias": si acá un helper tiene otro nombre
   (por ej. el que manda push, el que renderiza /sys_*, el que escribe notas internas en el chat,
   el que alerta plata ambigua), ADAPTÁ las llamadas del bloque a lo que ya existe; no dupliques
   helpers. Lo que no exista, copialo del archivo 05. Si acá no hay bono app (#164), igual pegá
   la config hgcashAppBonus y getHgcashAppBonusConfig del archivo 01: es el tope del % del lote.
3. Hooks (04): dentro de /api/admin/deposit (carga manual) y, si hay auto-carga hgcash, dentro
   de hgcashAutoCarga. Respetá el contrato: una carga = como mucho UN bono automático; reserva
   atómica → crédito → settle, revert sólo si el crédito falló LIMPIO, ambiguo = consumido +
   alerta, nunca reintentar. Si acá no existe la multicuenta por banco (#152), tratá
   _dupBank/_dupBankManual como null.
4. Panel admin (08, 09): banner del bono en el chat, card "🎁 Lote con regalo" y "📤 Lotes
   enviados" en la sección Notificaciones, funciones en admin.js, llamadas al abrir el chat y la
   sección. Mantené los nombres de funciones que usan los onclick inline.
5. PWA (10, 11, 12): botón 🎁 en la barra, modal "Regalos con código" (regalos para RECLAMAR con
   botón + canjear código + ℹ️ información con estado app/notifs y link a Telegram), card del bono
   vigente y card "RECLAMAR" de fichas en el home (promobonus.js), exports en VIP.ui (incluido
   syncBalance), listener en app.js y refresco en socket.js. Bumpeá ?v y CACHE_VERSION del SW de
   la PWA, y CACHE_VERSION de admin-sw.js.
6. Sumá 'notif_batch' y 'notif_batch_auto' a la lista de fuentes que acá excluyen "cargas
   reales" (referidos, cierre, analítica), si existe.

Reglas de ESTE repo que no se negocian: toda ruta nueva app.get/post DESPUÉS de
`const authMiddleware` (TDZ); `node --check` en cada archivo tocado; HTML del panel balanceado;
ninguna operación de plata contra JUGAYGANA se reenvía a ciegas (ambiguous = frenar + alertar).
Al terminar: WORKLOG (entrada nueva con qué se portó y qué se adaptó), docs/ARCHITECTURE.md
(modelos NotifBatch/PromoBonus, rutas, hook en las cargas, cron de 45 s, trampas), commit y
push. Listá al final qué helpers renombraste/adaptaste y qué quedó pendiente de probar en vivo.
```

## Prompt B — para un repo con 1girox

```
Leé WORKLOG.md, docs/ARCHITECTURE.md y CLAUDE.md como siempre. Después leé ENTERO el paquete
de réplica que está en el repo gemelo clonado al lado:

  /home/amnesia/Documents/AUTOREEMBOLSOSjygactivo/docs/replicas/lotes-jugaygana/README.md   ← primero, sobre todo "⚠️ OTRA PLATAFORMA"
  /home/amnesia/Documents/AUTOREEMBOLSOSjygactivo/docs/replicas/lotes-jugaygana/*            ← todos

IMPORTANTE — OTRA PLATAFORMA: el gemelo opera sobre JUGAYGANA (jugaygana.js,
creditUserBalance, ambiguous/_alertMoneyAmbiguous). ESTE repo opera sobre 1girox
(giroxService). El paquete es código real del gemelo y sirve como referencia exacta de QUÉ
hacer, pero todo lo que acredite PLATA (fichas del lote, % automático en la carga) lo tenés que
hacer con lo que ESTE repo ya usa para acreditar bonos en girox (con su rollover y su reference
idempotente). No copies nada que mencione jugaygana sin reemplazarlo por el equivalente girox.
La tabla "OTRA PLATAFORMA" del README dice pieza por pieza.

ANTES de pegar nada: revisá qué parte del sistema de lotes YA existe acá (el sistema nació en un
repo girox, así que puede haber NotifBatch, PromoBonus, el motor de envío, el canje por código y
el cartel verde). Listame qué hay y qué falta, y portá SOLO lo que falte. Lo que seguro es nuevo
respecto de la versión vieja: #172 (tope del % de lote = tope del bono app), #173 (bono canjeado
vence a `useHours` tras el canje + resumen por lote canjeó / cargó / venció) y #177 (fichas por
tiempo con RECLAMO: no se acredita al enviar, el cliente toca 🎁 RECLAMAR en la app y recién ahí
se acredita; GET /api/gift/pending + POST /api/gift/claim; card dorada en el home y en el modal
🎁; tilde "acreditar directo" en el panel; historial "N acreditados / sin reclamar / vencidos").

Quiero acá el mismo producto, con las mismas pantallas, reglas y endpoints. Seguí el orden de la
tabla "Archivos del paquete":

1. Modelos NotifBatch y PromoBonus (sumar los campos que falten: claimRequired, useHours,
   autoApply, applyScope, applyFromMin/ToMin, usesCount, usesTotalBonus, sourceRuleId…).
2. server.js: tope del % (01) con la config del bono app de ESTE repo; endpoints de PromoBonus
   (02) si faltan; bloque de lotes (03) completando lo que falte, con _creditNotifBatchGift y
   _notifBatchFichasAfterClaim reescritos sobre el crédito girox. Rutas DESPUÉS de
   `const authMiddleware`. Verificá "Dependencias": si un helper tiene otro nombre acá, adaptá;
   no dupliques.
3. Hooks (04) en la carga manual (y en la auto-carga por banco si acá existe): una carga = como
   mucho UN bono automático; reserva atómica → crédito → settle, revert si el crédito falló.
   Si acá no existe multicuenta por banco, tratá _dupBank/_dupBankManual como null.
4. Panel admin (08, 09): banner del bono en el chat, card "🎁 Lote con regalo" (con el bloque
   "💰 Fichas con RECLAMO" y el tilde directo), "📤 Lotes enviados" con el resumen por lote;
   funciones en admin.js y llamadas al abrir el chat y la sección. Mantené los nombres de los
   onclick inline. Cambiá textos "JUGAYGANA" por girox. Bumpeá CACHE_VERSION de admin-sw.js.
5. PWA (10, 11, 12): botón 🎁, modal "Regalos con código" (RECLAMAR con botón + canjear +
   ℹ️ información), card del bono vigente y card RECLAMAR en el home (promobonus.js), exports en
   VIP.ui (incluido syncBalance), listener en app.js y refresco en socket.js. Moneda del destino.
   Bumpeá ?v de los scripts y CACHE_VERSION del SW.
6. Sumá 'notif_batch' y 'notif_batch_auto' a la lista de fuentes que acá excluyen "cargas
   reales" (referidos, cierre, analítica), si existe.

Reglas de ESTE repo que no se negocian: toda ruta nueva app.get/post DESPUÉS de
`const authMiddleware` (TDZ); `node --check` en cada archivo tocado; HTML del panel y de la PWA
balanceados; la plata siempre con reserva atómica antes de acreditar y un solo bono automático
por carga. Al terminar: WORKLOG (entrada nueva con qué se portó y qué se adaptó a girox),
docs/ARCHITECTURE.md (modelos, rutas, hook en las cargas, cron de 45 s, trampas), commit y push.
Listá al final qué ya existía, qué portaste, qué adaptaste y qué queda para probar en vivo.
```

## Prueba en vivo sugerida (después del deploy del destino)

1. Lote POR TIEMPO +20% ⚡ automático "1ª carga" a una cuenta de prueba → cartel ⚡ en el chat
   → carga MANUAL sin bonus → carga + bono, mensaje al cliente con "🎁 Incluye tu regalo", nota
   interna "quedó USADO", cartel desaparece. Segunda carga → sin bono.
2. Ídem con carga hgcash real (si aplica).
3. Lote 100% con carga de $10.000 → bono $6.000 (tope $5.000 al 100% + $5.000 al 20%).
4. Franja 18:00–23:00 fuera de hora → carga sin bono y cartel sigue.
5. Lote "lo aplica el agente" → cartel verde + Marcar usado.
6. Lote CON CÓDIGO (lista) → el cliente canjea con 🎁 → "Válido hasta" = canje + 24 h; uno de
   afuera → "Este código no es para tu cuenta"; dejarlo vencer → el detalle del lote dice
   "venció sin usar".
7. Fichas: 3 créditos seguidos al mismo usuario en 24 h → el 4º no sale y hay alerta roja.
8. Fichas POR TIEMPO (#177): enviar $500 a una cuenta de prueba → NO se acredita; en la app aparece
   el cartel dorado "Tenés $500 en fichas de regalo — RECLAMAR" (home y modal 🎁) → tocar → "✅
   acreditado", saldo sube, nota interna en el chat; el historial del lote dice "1 acreditados ($500)
   · 0 sin reclamar". Dejar vencer otro → "no reclamó y venció (no se pagó)". Con el tilde "directo"
   se acredita a todos al enviar, como antes.
