# Plan de mudanza: JUGAYGANA → jugaygana.io (Partner API)

> **Actualización 2026-11-18 (#197):** el owner eligió una mudanza **usuario por usuario con traslado automático de saldo** (tope
> $200.000), no el corte de una sola vez que describe este plan. Lo implementado está en `docs/ARCHITECTURE.md` §10 y WORKLOG #197;
> este documento queda como inventario de lo que el repo usa de JUGAYGANA.

> Estado al 2026-11-18: **nada de esto está cableado.** Este repo sigue operando 100% contra
> JUGAYGANA (`admin.agentesadmin.bet`). Este documento es el mapa para hacer la mudanza sin perder
> nada; lo escribió la sesión que hizo la misma migración en el gemelo CARGASGIROXactivo
> (2026-07-31, WORKLOG #97–#101 de ese repo) mirando el código actual de ESTE repo.
>
> Antes de tocar código: leer `CONOCIMIENTO-EN-PRODUCCION.md` §1 (cinco reglas) y §2 (reference).

---

## 0. Resumen honesto: qué es "2 clicks" y qué no

**Lo que puede quedar en un interruptor** (y conviene diseñarlo así): por qué plataforma salen las
operaciones — altas, saldo, cargas, retiros, regalos, netwin, botón CASINO.

**Lo que NO es un click y hay que hacer ANTES de prender el interruptor:**

1. Que cada jugador **exista** en jugaygana.io (crearlo o vincularlo) — horas de corrida por el
   límite de 60 req/min.
2. Decidir qué pasa con el **saldo** que cada jugador tiene hoy en JUGAYGANA (§5). La Partner API
   no transfiere saldos entre plataformas.
3. Cargar en el panel las **keys** (master y una por publicista) y fondear los saldos de agente.
4. Revisar textos (`/sys_*`, bienvenida, Información) que nombran la página vieja.

**Lo que cambia de reglas aunque el interruptor ande perfecto** (avisar al owner y a los agentes):
rollover (parte del saldo puede no ser retirable), bonos que "pisan", regalos que figuran como Bono,
no hay historial de movimientos por API, no hay saldo del cajero por API.

**Volver atrás:** el interruptor puede volver a JUGAYGANA, pero las operaciones hechas en
jugaygana.io quedan allá (saldos partidos entre dos plataformas). El rollback limpio existe solo
mientras no se haya operado plata real en la nueva.

---

## 1. Datos que hay que conseguir primero

Sin esto no se puede ni probar:

- [ ] **Base URL de la Partner API de jugaygana.io** (NO es `api-lbvip.com`; cada instalación tiene
      la suya).
- [ ] **API key master** (`pk_…`; se crea en el panel del agente: Clientes de API → Nuevo cliente;
      se muestra una sola vez).
- [ ] URL del sitio del jugador (¿`https://jugaygana.io`?) → `GIROX_PLAY_URL` y `/sys_casino_url`.
- [ ] Correr `node docs/1girox/codigo-referencia/scripts/probar-partner-api.js` con esos dos datos
      (solo lectura) y guardar la salida: dice feats, multiplicadores, topes, reglas automáticas,
      motor de bonos, wager y sub-agentes.
- [ ] Preguntar al operador: **¿los jugadores actuales ya existen en jugaygana.io? ¿con sus saldos?
      ¿bajo qué agente?** (define todo el §5).
- [ ] Límite de req/min de la key (60 por defecto; pedir más si hace falta).
- [ ] Una key por cada publicista que hoy tiene usuario+contraseña de sub-agente
      (`Campaign.jugayganaUsername/Password`).

---

## 2. Qué usa hoy este repo de JUGAYGANA (inventario real)

Cuatro clientes + dos servicios, importados en `server.js` ~L440–458:

| Módulo | Qué hace | Lo usan |
|---|---|---|
| `jugaygana.js` (1.694 líneas) | sesión admin, altas, lookup, cargas/retiros/regalos (×100 centavos adentro), rangos de fecha, verificación por saldo y `ambiguous` | `server.js`, `jugayganaPublisherSessions` |
| `jugaygana-movements.js` | saldo (con retry), `makeBonus`, historial de movimientos | `server.js` |
| `src/services/jugayganaService.js` | cliente refactorizado: `loginAsUser`, `changeUserPasswordAsAdmin`, `creditBalance`… | `server.js`, referidos (`referralPayoutService`, `referralRevenueService`, `jugayganaUserLinkService`) |
| `src/services/jugayganaPublisherSessions.js` | pool de sesiones por publicista para el alta | `server.js` |
| `src/services/referralRevenueService.js` | netwin/GGR desde el panel de reportes (royalty-statistics, por `child_user_id`) | `server.js` (reembolsos), `referralCalculationService` |
| `src/services/jugayganaUserLinkService.js` | resuelve `User.jugayganaUserId` | `server.js` |

Call sites en `server.js` (conteo por grep al 2026-11-18):

| Llamada | Veces |
|---|---|
| `jugaygana.errToString` | 15 |
| `jugaygana.creditUserBalance` | 12 |
| `referralRevenueService.getUserNetwinForDateRange` | 10 |
| `jugayganaMovements.getUserBalanceWithRetry` | 10 |
| `jugaygana.syncUserToPlatform` | 6 |
| `jugaygana.depositToUser` | 5 |
| rangos de fecha (`get…RangeArgentinaEpoch`, `getMonthToDate…`) | 13 |
| `jugayganaMovements.getUserBalance` | 4 |
| `jugaygana.withdrawFromUser` | 3 |
| `jugayganaService.loginAsUser` | 3 |
| `jugaygana.getUserInfoByName` | 3 |
| `jugayganaPublisherSessions.*` | 4 |
| `jugaygana.ensureSession`, `logProxyIP`, `setCashierBalanceHook`, `jugayganaMovements.makeBonus`, `getUserMovements`, `jugayganaService.changeUserPasswordAsAdmin`, `referralRevenueService.set/getDateFormat/diagnoseDateFormats` | 1–2 c/u |

Para regenerar el inventario:

```bash
grep -oE '\b(jugaygana|jugayganaMovements|jugayganaService|jugayganaPublisherSessions|referralRevenueService)\.[A-Za-z_]+\(' server.js | sort | uniq -c | sort -rn
grep -rn "require(.*jugaygana\|require(.*referralRevenue" server.js src config | grep -v __tests__
```

Front: `public/js/ui.js` (`VIP.ui._casinoUrl`, default `jugaygana44.bet`), `public/js/auth.js` y
`public/adminprivado2026/admin.js` (credenciales de publicista en el formulario de campañas).

---

## 3. Mapa función por función

`girox` = `docs/1girox/codigo-referencia/services/giroxService.js`.

| Hoy (JUGAYGANA) | Mañana (Partner API) | Ojo |
|---|---|---|
| `jugaygana.ensureSession()`, `loginAndGetToken`, `logProxyIP`, mutex de login | **desaparece** | auth por `X-Api-Key`; `girox.isEnabled()` / `girox.ping()` para el arranque |
| `jugaygana.syncUserToPlatform(localUser)` | `girox.syncUserToPlatform({ username, password })` | no hay `jugayganaUserId`; puede devolver `code:'username_taken_foreign'` → el alta rebota sin cuenta local |
| `jugaygana.createPlatformUser` | `girox.createPlatformUser` | username 3–18 `[A-Za-z0-9_]`, password ≥ 6 |
| `jugaygana.getUserInfoByName` / `lookupUserOrError` (tri-estado) | `girox.getUserInfoByName(u, {fresh})` | devuelve `null` ante cualquier fallo; para distinguir "no existe" de "falló" usar `girox.ping()`/el código de error. Ya no hay HTML de Cloudflare |
| `jugayganaMovements.getUserBalance(WithRetry)` | `girox.getUserBalance(WithRetry)(u, {fresh})` | devuelve además `available`, `locked`, `bonusLocked`, `claimableTotal`, `wager` |
| `jugaygana.depositToUser(u, monto, desc, jugayganaUserId)` | `girox.depositToUser(u, monto, desc, **reference**, wagering?)` | ⚠️ el 4º arg cambia de significado. Monto en pesos (igual que hoy: el ×100 lo hacía el cliente viejo adentro) |
| `jugaygana.withdrawFromUser(u, monto, desc, jugayganaUserId)` | `girox.withdrawFromUser(u, monto, desc, **reference**)` | validar antes contra `available`; errores `insufficient_funds` / `rollover_locked` |
| `jugaygana.creditUserBalance(u, monto, jugayganaUserId)` (12 usos: reembolsos, ruleta, fueguito, bonos…) | `girox.creditUserBalance(u, monto, **reference**, opts?)` | ⚠️ el 3º arg cambia de significado. Sale como bono 0 "regalo directo" con fallback a depósito |
| `jugayganaMovements.makeBonus(u, monto, desc)` | `girox.creditUserBalance(u, monto, reference, {description})` o `girox.creditGift` | con rollover → `creditGift(u, monto, {reference, rolloverX})` |
| `jugayganaService.creditBalance/deposit/withdraw/bonus` (referidos) | los mismos de `girox` | `referralPayoutService`: reference `vip-refcom-<payoutId>` reusando el payout pending/failed |
| `jugayganaService.loginAsUser(u, pass)` (3 usos: validar clave contra la plataforma) | `girox.validateCredentials(u, pass)` | responde 200 con `valid:false` si la clave está mal; ya no devuelve token |
| `jugayganaService.changeUserPasswordAsAdmin` / `jugaygana.changeUserPassword(u, actual, nueva)` | `girox.changeUserPassword(u, nueva)` | no pide la clave actual; cierra las sesiones del jugador en la plataforma |
| `referralRevenueService.getUserNetwinForDateRange(u, jgId, from, to)` | `girox.getPlayerStats(u, from, to, label, {fresh})` | por username, sin ID; `netwin` positivo = perdió; máx. 92 días; ya en pesos (hoy se divide por 100) |
| cálculo de referidos jugador por jugador | `girox.getPlayersStatsBatch(usernames[≤100], from, to)` | la comisión ya no viene del proveedor: tasa propia (`GIROX_REFERRAL_COMMISSION_PCT`) y encima `referralTierService.resolveReferralRate` de este repo |
| `resolveJugayganaUserId` | `giroxUserLinkService.resolveGiroxUserId` | opcional: el ID ya no bloquea nada |
| `jugayganaPublisherSessions.createUserAsPublisher / testCreds / invalidateSession` | `giroxPublisherKeys.createUserAsPublisher / testKey / invalidateSession (no-op)` | una API key por campaña en vez de usuario+contraseña |
| rangos `get…RangeArgentinaEpoch` de `jugaygana.js` | `utils/periodRanges.js` (funciones puras) | no cambiar los strings de fecha: alimentan los `periodKey` de RefundClaim |
| `jugaygana.setCashierBalanceHook` | `girox.setCashierBalanceHook` | la API no informa el saldo del agente → el cruce "cajero" del cierre diario queda `sin_datos` |
| `jugayganaMovements.getUserMovements` | **no existe** | `girox.getUserMovements()` devuelve `not_supported` |
| `jugaygana.errToString` | `girox.errToString` | igual |
| botón "Abrir Casino" (`/sys_casino_url`, link fijo; #193) | `girox.createSession(u)` → `redirect_url` de un uso | se gana el login automático (SSO); `/sys_casino_url` queda de respaldo |
| `ambiguous:true` + verificación por saldo (#151) | reintento con la MISMA reference | ver §4.2 |
| `PROXY_URL` | no se usa | el cliente llama con `proxy:false` |

---

## 4. Las diferencias de fondo (donde se rompe plata)

### 4.1 Toda operación de plata necesita una `reference`

Hoy ningún call site pasa una. Hay que darle a cada uno una llave única y estable entre
reintentos (tabla en `CONOCIMIENTO-EN-PRODUCCION.md` §2). En este repo, por flujo:

- carga manual / retiro manual / bono manual → generar el uuid ANTES de llamar y reusarlo como
  `Transaction.id`;
- auto-carga hgcash (incluida la asignada desde la bandeja, #155) → el `chargeKey` del candado
  (`coelsa` o `movementId`);
- reembolsos → `periodKey` + `userId` (NO el id del RefundClaim);
- ruleta → `spinId`; fueguito → usuario + hito + día; bono automático app/hgcash (#110) → id de la
  carga que lo dispara; lotes con regalo (#149) → `batchId` + `userId`;
- confirmación de retiro → `payoutId`; devolución → `payoutId` con otro prefijo;
- comisiones de referidos → id del ReferralPayout persistido antes de llamar.

Una reference repetida entre operaciones distintas = el cliente transfiere y no recibe fichas.

### 4.2 El manejo de `ambiguous` (#151) cambia de estrategia

Hoy: ante HTML/timeout el cliente verifica por saldo y, si no puede confirmar, devuelve
`ambiguous:true`; el caller frena y avisa (`_alertMoneyAmbiguous`), nunca reintenta ni libera.

Con la Partner API: el cliente ya reintenta solo (2/5/15 s) con la misma reference. Si igual
termina en error transitorio, el estado es "no se sabe", pero **reintentar con la misma reference
es seguro** (si había entrado, vuelve `duplicate:true`). Entonces:

- un error **4xx de negocio** = no se movió nada → liberar la reserva;
- un error **transitorio** = puede haber entrado → liberar la reserva SOLO si el reintento va a
  usar la misma reference (así están hechos los reembolsos del gemelo); si la reference dependiera
  de algo que cambia, no liberar y alertar;
- `_alertMoneyAmbiguous` sigue sirviendo para el caso "se agotaron los reintentos": el agente
  reintenta la MISMA operación, no crea una nueva.

Mientras convivan las dos plataformas, el código tiene que soportar los dos contratos
(`ambiguous` de un lado, `duplicate`/`code`/`httpStatus` del otro).

### 4.3 Retiros contra `available`

Con rollover activo en la instalación, validar contra `balance` deja retiros colgados
(`rollover_locked`). Todo punto que hoy lee el saldo para decidir un retiro tiene que leer
`available` con `{fresh:true}`. El anti-retiro-fantasma (releer el saldo y exigir que bajó) se
mantiene igual.

### 4.4 La plataforma no crea al jugador en la carga

JUGAYGANA lo crea dentro de `depositToUser`. La Partner API no: el cliente nuevo trae la red de
seguridad (crea y reintenta una vez), pero las altas tienen que crear al jugador con `await` y
dejar registrado el error. Auditar TODOS los `User.create` del repo.

### 4.5 Reglas de username

Auditar la base antes de migrar (3–18, `[A-Za-z0-9_]`):

```js
// mongosh — usuarios que NO se pueden crear en la plataforma nueva
db.users.find(
  { role: 'user', username: { $not: /^[A-Za-z0-9_]{3,18}$/ } },
  { username: 1, createdAt: 1 }
).count()
```

Los que no pasan necesitan decisión manual (renombrar = cuenta nueva en la plataforma). Y validar
con `girox.validateUsername` en registro, altas del panel, altas del publicista y `check-username`.

### 4.6 Netwin: signo, unidad e ID

- Hoy `getUserNetwinForDateRange` exige `jugayganaUserId` y devuelve `totalGgr` (centavos ÷ 100).
  Mañana va por username y devuelve `netwin`/`casinoNetwin` en pesos. **Verificar el signo contra
  un caso conocido** antes de pagar un reembolso (en la Partner API positivo = el jugador perdió).
- Se cae el gate "sin `jugayganaUserId` no hay reembolso": usuarios que hoy dan $0 por no tener ID
  van a empezar a cobrar. En referidos, recalcular un período viejo ya pagado hace aparecer deltas.
- Decidir casino solo vs casino + sports (en el gemelo: solo casino).
- La comisión base de referidos deja de venir de `royalty-statistics`: es netwin × tasa propia.
- Períodos anclados a `-03:00` (ver el bug de huso en `CONOCIMIENTO-EN-PRODUCCION.md` §8). El
  `src/utils/periodKey.js` del gemelo tiene ese fix; el de este repo es distinto — comparar antes
  de copiar.

### 4.7 Publicistas

- `Campaign.jugayganaUsername/jugayganaPassword` → `Campaign.giroxApiKey` (`select:false`) +
  espejo `hasGiroxKey` + pool `giroxApiKeysExtra` (ver `models/Campaign.campos-girox.js.txt`).
- `User.giroxOwnerCampaign`: se setea cuando el alta se hizo con la key del publicista; el cliente
  firma TODO lo de ese jugador con esa key (resolver en `server-extractos.js.txt`).
- Las cargas a esos jugadores salen del saldo del sub-agente: hay que mantenerlos fondeados.
- El panel sigue mandando `jugayganaPassword` y llamando `test-jugaygana-creds` (en el gemelo se
  dejaron los nombres legacy y adentro se guarda/prueba la key).

### 4.8 Bonos, rollover y regalos

Depende de la configuración de jugaygana.io (correr el script de diagnóstico):

- con bono suelto habilitado y 0 permitido → los regalos salen como **Bono** (retirables al
  instante); sin eso → depósito libre (figuran como "Carga");
- un bono con rollover a un jugador con bono activo lo **pisa**;
- si el agente tiene reglas automáticas cargadas, cada `/deposit` sin params las hereda → decidir
  si se manda `no_bonus:true`;
- el bono automático de este repo (#110: 100% primera carga / 20%) y los lotes con regalo (#149)
  tienen que decidir si viajan como `bonus_amount` + `bonus_multiplier` de la MISMA operación (como
  en el gemelo) o como operación aparte;
- wager: solo por `POST /promo`; nunca `wager_*` en el depósito.

### 4.9 Lo que se pierde

- `GET /api/movements` (historial de movimientos): sin backend.
- Cruce del cajero en el cierre diario (#155): `sin_datos`.
- Cualquier reporte que hoy salga del panel de JUGAYGANA por scraping.

---

## 5. Los jugadores y sus saldos (la parte que no es un click)

Tres escenarios según lo que responda el operador:

**A. jugaygana.io arranca VACÍO.** Hay que crear cada jugador (`scripts/migrate-users-to-girox.js`:
dry-run por default, reanudable, ~24 usuarios/min compartiendo cupo con producción) y **decidir el
saldo**: la Partner API no importa saldos. Opciones:
1. que el operador importe los saldos de su lado (lo más limpio: pedirlo);
2. acreditarlos nosotros: leer el saldo de cada jugador en JUGAYGANA y hacer un `/deposit` en la
   nueva con reference `vip-mig-<userId>` (idempotente; sale del saldo del agente; con
   `no_bonus:true` y sin rollover), retirando o congelando el saldo viejo;
3. corte "a saldo cero": avisar a los clientes que retiren antes de la fecha.
   El script del gemelo NO mueve saldos: en esa migración la plataforma era nueva para todos.

**B. Los jugadores ya existen en jugaygana.io bajo NUESTRO agente** (copia con datos): el script
los detecta ("ya existe → vinculado"), sin crear nada. Verificar con una muestra que el saldo
coincide (`probar-partner-api.js --player=…`).

**C. Existen pero bajo OTRO agente** (nuestra key no los ve): `GET` da 404 y el alta da "username
ya tomado" → `username_taken_foreign`. No se resuelve por API: el operador tiene que colgarlos de
nuestro agente, o hay que darles username nuevo.

En los tres casos:

- Las **contraseñas** no se migran (bcrypt): clave random + réplica en el próximo login.
- Agregar al modelo `User` los campos `girox*` (ver `models/User.campos-girox.js.txt`) SIN tocar
  los `jugaygana*` (se conservan para volver atrás).
- Correr la migración en horario de poco movimiento; si aparecen 429, SUBIR el delay.

---

## 6. Cómo armar el interruptor (propuesta)

En el gemelo se hizo reemplazo total (era un servidor aparte). Acá, con producción viva, conviene
una fachada:

1. **`src/services/platform.js`** — una sola interfaz (`syncUser`, `getBalance`, `deposit`,
   `withdraw`, `creditGift`, `getNetwin`, `getNetwinBatch`, `changePassword`, `validateLogin`,
   `createSession`, `createUserAsPublisher`, `errToString`) con dos adaptadores: `jugaygana` (los
   clientes de hoy, sin tocarlos) y `partner` (`giroxService`). El adaptador `jugaygana` ignora la
   `reference`; el `partner` la exige.
2. **`Config['platformProvider']`** = `'jugaygana'` (default) | `'partner'`, leído sin cache largo
   (≤ 30 s) para que el cambio aplique en todas las instancias; editable desde el panel solo por el
   admin general, con confirmación.
3. Migrar los call sites de `server.js` a la fachada **de a un flujo**, pasando ya la reference
   correcta (con el proveedor en `jugaygana` no cambia nada → se puede deployar por partes y probar
   en Render).
4. Guardar en cada `Transaction` por qué plataforma salió (`metadata.platform`) y su `reference`.
5. El interruptor NO decide por usuario: es global. Un usuario sin cuenta en la nueva se repara
   con la red de seguridad de la carga / el SSO.

Alternativa más simple si se acepta una ventana de mantenimiento: rama aparte con reemplazo total
(como el gemelo), probar en Render con las env de jugaygana.io, y pasar a EB de una.

---

## 7. Orden de trabajo sugerido

1. Conseguir Base URL + key y correr el diagnóstico (§1).
2. Copiar a su lugar el código de referencia (ver `codigo-referencia/README.md`), sin importarlo
   todavía: `giroxService.js`, `giroxUserLinkService.js`, `giroxPublisherKeys.js`,
   `utils/periodRanges.js`. `node --check`.
3. Modelos: campos `girox*` en `User` y `Campaign` (aditivos).
4. Endpoint de salud `GET /api/admin/girox/health` (extracto incluido) — primera cosa a mirar ante
   cualquier "no funciona".
5. Fachada + interruptor (§6), proveedor en `jugaygana`.
6. Flujos, de menor a mayor riesgo: saldo (lectura) → altas → SSO → reembolsos/regalos → carga
   manual → auto-carga hgcash → retiros → referidos.
7. Auditoría de usernames (§4.5) y migración de jugadores/saldos (§5).
8. Prueba completa en Render con el proveedor en `partner` y un jugador de prueba (checklist §8).
9. Textos: `/sys_*` guardados en la BASE (los sembrados no pisan lo editado), Información del
   Servicio, `/sys_casino_url`, `GIROX_PLAY_URL`.
10. Producción: prender el interruptor en horario tranquilo, mirando logs y el panel de la
    plataforma.
11. Recién con todo verificado: borrar los clientes viejos (o dejarlos para revertir, como hizo el
    gemelo).

---

## 8. Checklist de prueba (jugador de prueba, montos chicos)

- [ ] `health`: ping OK, config de la plataforma legible.
- [ ] Alta desde la PWA, desde el panel y desde un publicista → el jugador aparece en la plataforma
      bajo el agente correcto.
- [ ] Alta con un username inválido / ya tomado → rebota sin dejar cuenta local.
- [ ] Botón CASINO → entra logueado (mobile incluido; ver la trampa del pop-up).
- [ ] Carga manual de $10 → entra UNA vez; repetir la request con la misma reference →
      `duplicate`, sin segunda carga.
- [ ] Carga con bono → carga y bono como tipos distintos en el panel de la plataforma.
- [ ] Auto-carga hgcash (transferencia chica) → una sola acreditación, vínculo en las dos
      direcciones (#155).
- [ ] Reembolso con pérdida conocida → monto correcto (signo y unidad), figura como Bono;
      reclamar dos veces → una sola acreditación.
- [ ] Retiro con rollover pendiente → se rechaza ANTES de llamar a la plataforma, con mensaje claro.
- [ ] Retiro normal → baja el saldo (anti-fantasma), sale el pago hgcash.
- [ ] Devolución de un retiro rechazado → vuelve la plata una sola vez.
- [ ] Ruleta, fueguito, lote con regalo, bono automático app → una acreditación cada uno.
- [ ] Jugador de publicista: carga, retiro, saldo y reembolso con la key del publicista.
- [ ] Referidos: preview de un período con el batch.
- [ ] Cambio de clave → se replica en la plataforma.
- [ ] Cortar la red a mitad de una carga (timeout) → el reintento no duplica.
- [ ] Dos instancias a la vez (EB) → sin 429 sostenidos (`GIROX_MAX_RPM` = límite ÷ instancias).

---

## 9. Preguntas abiertas para el owner

1. ¿jugaygana.io arranca vacío o con los jugadores y saldos copiados? (§5)
2. ¿Rollover y Bonos van a estar activos? ¿Los regalos tienen que salir con rollover o libres?
3. ¿Reembolsos y comisiones sobre casino solo, o casino + sports?
4. ¿Qué tasa de comisión base se usa para referidos, ahora que el proveedor no la informa?
5. ¿Interruptor con convivencia (§6) o corte con ventana de mantenimiento?
6. ¿Los publicistas van a tener agente y key propios en jugaygana.io?
7. ¿Se quiere el botón CASINO con login automático (SSO) y el casino embebido como en el gemelo?
