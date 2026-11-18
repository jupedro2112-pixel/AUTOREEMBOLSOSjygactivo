# Partner API — lo que NO dice el manual (aprendido en producción)

> Fuente: el repo gemelo **CARGASGIROXactivo**, que corre sobre esta misma API (plataforma 1girox)
> desde el 2026-07-31. Todo lo de acá salió de pruebas en vivo, incidentes reales, respuestas del
> soporte de 1girox o decisiones del owner. Volcado el 2026-11-18.
>
> Cada punto dice de dónde sale: **[probado]** = verificado contra la API real · **[soporte]** =
> lo confirmó el soporte de 1girox · **[incidente]** = costó un bug en producción · **[decisión]** =
> criterio del owner en CARGASGIROXactivo (se puede decidir distinto acá) · **[manual]** = lo dice
> el PDF, se repite porque es crítico.
>
> ⚠️ Todo esto se probó contra la instalación **1girox**. jugaygana.io "usa la misma API", pero la
> CONFIGURACIÓN de cada instalación (feats, multiplicadores, topes, motor de bonos) es propia: hay
> que leerla con `GET /config` antes de asumir nada. Ver §14.

---

## 1. Las cinco reglas que mueven plata

1. **Montos en PESOS.** Se manda `1500.50`, no centavos. JUGAYGANA trabaja ×100; acá multiplicar
   por 100 es cargar 100 veces de más. **[manual]**
2. **Toda operación de plata lleva una `reference` estable y persistida.** Reintento = MISMA
   reference. Mirar `duplicate` antes de dar un pago por bueno. (§2)
3. **Los retiros se validan contra `wagering.available`, nunca contra `balance`.** (§6)
4. **Ante un error transitorio (red, timeout, 429, 5xx) NO se cambia de camino ni de reference:**
   la operación pudo haber entrado. Se reintenta igual; la plataforma deduplica. (§2, §4)
5. **`netwin` POSITIVO = el jugador PERDIÓ.** Es la base del reembolso. (§8)

---

## 2. Idempotencia por `reference` — la regla de oro

- Hasta **100 caracteres**. Si se repite, la API devuelve `200` + `"duplicate": true` con los datos
  de la operación original y NO mueve plata. **[manual + probado]**
- Rompe plata en las DOS direcciones: **[incidente evitado en la migración]**
  - dos operaciones DISTINTAS con la misma reference → la segunda vuelve `duplicate:true` y el
    cliente **no cobra** (y la respuesta parece exitosa: hay que mirar el flag);
  - la reference **cambia** entre reintentos del mismo pago → se paga **dos veces**.
- Por eso cada flujo la deriva de algo que ya es único Y estable entre reintentos:

| Prefijo | Flujo | De dónde sale |
|---|---|---|
| `vip-dep-<txId>` | carga manual del agente | uuid generado ANTES de llamar y reusado como `Transaction.id` |
| `vip-wd-<txId>` | retiro manual del agente | ídem |
| `vip-bonus-<txId>` | bono manual del panel | ídem |
| `vip-rf-<periodKey>-<userId>` | reembolsos | del PERÍODO, no del id del claim (ver abajo) |
| `vip-hg-<coelsa\|movementId>` | auto-carga del banco | identificador de la transferencia (mismo `chargeKey` del candado local) |
| `vip-roulette-<spinId>` | premio de ruleta | id del giro (la misma en el reintento del panel) |
| `vip-fire-<userId>-d<día>-<fecha>` | premio de fueguito | usuario + hito + día (el mismo hito puede repetirse en otra racha) |
| `vip-install-<userId>` | bono instalación | uno por usuario para siempre |
| `vip-payout-<payoutId>` | débito al confirmar un retiro | id del PendingPayout |
| `vip-payoutref-<payoutId>` | devolución de retiro rechazado | ídem |
| `vip-refcom-<payoutId>` | comisión de referidos | id del ReferralPayout, persistido ANTES de llamar; un intento pending/failed se REUSA |
| `vip-cbk-<userId>-<día>-<seq>` | reembolso en vivo | `seq` del índice único del claim |
| `vip-nbatch-<batchId>-<userId>` | fichas de un lote | lote + usuario |
| `vip-depwager-<txId>` / `vip-hgw-<mov>` | promocional (wager) de una carga | el mismo id de la carga |

- **Por qué la del reembolso sale del período:** si el crédito falla, el handler BORRA el
  RefundClaim para que el usuario reintente, y el reintento genera un id nuevo. Con una reference
  derivada de ese id, un fallo FALSO (se acreditó pero la respuesta se perdió por timeout) pagaría
  dos veces. Derivada del `periodKey`, el reintento manda la misma y vuelve `duplicate:true`.
- **Regla general de las reservas locales:** liberar una reserva tras un fallo es seguro SOLO si
  el reintento va a usar la misma reference. Si no se puede garantizar, no liberar.
- El cliente (`giroxService`) genera una reference al vuelo si no se le pasa ninguna y **loguea un
  warning**: eso cubre sus reintentos internos, no un reintento del usuario o del agente.
- **Trampa de firmas al migrar desde JUGAYGANA [incidente evitado]:** el 4º argumento de
  `depositToUser` y el 3º de `creditUserBalance` eran el `jugayganaUserId`; en el cliente nuevo son
  la `reference`. Migrar a ciegas mete el ID del usuario como reference → la SEGUNDA carga a ese
  usuario vuelve `duplicate:true` y no acredita nada.

---

## 3. Autenticación, instalaciones y keys

- Una sola cosa: header `X-Api-Key` fijo. No hay login, ni sesión, ni token que venza, ni mutex de
  login, ni HTML de Cloudflare. Un cambio de key tiene efecto inmediato en todas las instancias.
- **Cada instalación tiene su Base URL.** `api-lbvip.com/api/v1` (el ejemplo del manual) es de otra
  marca: responde con el formato exacto del manual pero rechaza nuestra key con `401`. La URL hay
  que pedirla junto con la key. **[probado: 20 hosts y 8 rutas]**
- La key se crea en el panel del agente (**Clientes de API → Nuevo cliente**) y se muestra UNA vez.
- **`getUserInfoByName` devuelve `null` ante CUALQUIER fallo** (404, 401, timeout). No sirve para
  diagnosticar: un health-check basado en eso dijo "la key es válida" mientras las altas fallaban
  con 401. Para diagnóstico usar `ping()`: consulta un jugador inexistente y espera `404
  player_not_found`; `401` = key rechazada o Base URL de otra instalación. **[incidente]**
- Whitelist de IPs: opcional. Con salida por IP no fija (Elastic Beanstalk sin NAT fija, Render) NO
  activarla o las requests vuelven `401 ip_not_allowed`.
- El cliente llama con `proxy: false`: no usa `PROXY_URL` (que en este repo existe por JUGAYGANA).
- Config **lazy**: `GIROX_API_URL`/`GIROX_API_KEY` se leen en runtime, nunca al `require()` (los
  secrets de SSM cargan después).

---

## 4. Rate limit y reintentos

- **60 req/min POR API KEY** (no por IP). A pedido lo suben por key (a 180 en keys puntuales).
  **[soporte]**
- El limitador local del cliente es **por key ("carril")** y **por proceso**: con N instancias el
  techo real es N × techo local. Criterio: techo local = límite de la key ÷ N instancias. Defaults:
  master `GIROX_MAX_RPM=55`, keys de publicista `GIROX_PUBLISHER_MAX_RPM=30`.
- Reintentos: backoff 2 s / 5 s / 15 s, respetando `Retry-After` (tope 60 s), SIEMPRE con la misma
  reference. Se reintenta 429 y 5xx; un 4xx de negocio no.
- `503 wallet_not_configured` y `502 wallet_error`: no consumieron la reference → reintentar con la
  misma.
- **El lag nocturno [incidente]:** el poll de saldo de la PWA cada 30 s × usuarios online saturaba
  la key (sobre todo la única key de un publicista) y TODO lo de esos usuarios quedaba en cola. Se
  arregló con: cache de lectura del jugador 8 s + coalescing (N pedidos simultáneos = 1 request),
  cache del netwin 90 s, poll del front a 90 s, y pools de keys.
- **Reglas del cache (salieron de una revisión adversarial, no aflojar):** solo se cachean éxitos;
  tras CADA operación de plata se invalida el cache del usuario con guard anti-carrera (una lectura
  en vuelo no puede escribir el saldo pre-operación); toda DECISIÓN de plata lee con
  `{ fresh: true }` (guards de bono, anti-retiro-fantasma, claims de reembolso).
- **Pool de keys de solo-lectura** (`GIROX_API_KEY_CONSULTAS=pk_a:90,pk_b:30`): keys del MISMO
  agente que la master; stats y batch firman con la que tenga más lugar. Nunca reemplazan la key de
  un publicista.
- El batch de stats (100 jugadores por request) es lo que hace viable referidos/VIP: 59 referidos
  pasaron de 59+ requests a 1.

---

## 5. Altas, usernames y jerarquía

- Username: **3–18 caracteres, solo `[A-Za-z0-9_]`**; password mínimo 6. Nuestras reglas locales
  eran más permisivas (hasta 30, con punto y guion): un `juan.perez` creado localmente no puede
  existir NUNCA en la plataforma. Hay que validar en TODOS los puntos de alta. **[incidente]**
- **La plataforma NO crea al jugador dentro del depósito.** JUGAYGANA sí lo hacía (por eso un
  usuario que nunca llegó a la plataforma "se arreglaba solo" en la primera carga). Acá devuelve
  `player_not_found` y la carga falla con el cliente ya habiendo transferido. El cliente tiene una
  red de seguridad: ante `player_not_found` en un depósito, crea al jugador con clave random y
  reintenta UNA vez con la misma reference. **[incidente]**
- **Los usernames son únicos en TODA la plataforma, pero la visibilidad es por rama.** Si el nombre
  ya existe bajo otra estructura (que nuestra key no ve), el alta da "ya existe" y la consulta da
  "no existe". Tratar eso como "vinculado" deja una cuenta local inoperable para siempre (cargas,
  retiros y SSO dan `player_not_found`). El cliente devuelve `code: 'username_taken_foreign'` y
  TODAS las altas tienen que rebotar sin dejar cuenta local. No se rescata: username nuevo.
  **[incidente]**
- **Jerarquía por key:** los jugadores creados con una key quedan bajo el agente dueño de esa key,
  y las cargas salen del saldo de ESE agente (los retiros vuelven a él).
- **La key MASTER NO ve por API a los jugadores creados bajo un sub-agente**, aunque desde el panel
  web el principal sí pueda operarlos. Consultar o cargar con la master da `player_not_found`.
  Solución: guardar en el usuario qué campaña/key lo creó (`User.giroxOwnerCampaign`) y firmar
  TODAS sus operaciones con esa key (resolver inyectado en el cliente; el batch de stats se agrupa
  por key). Consecuencia operativa: hay que mantener fondeado el saldo de cada sub-agente.
  **[incidente]**
- **`agent_id` en `POST /players` es "crear y ENTREGAR":** apenas el jugador nace bajo el
  sub-agente, la key creadora deja de verlo (404 en lectura y en depósito). No reemplaza tener una
  key por publicista. Diagnóstico útil: `GET /agents` con la key de un publicista devuelve lista
  vacía. **[probado]**
- Un username que ya existía queda bajo el agente que lo creó primero: recrearlo con otra key no lo
  mueve de rama.
- **Regla de bienvenida del agente:** si el agente configuró un bono de bienvenida en su panel, el
  `POST /players` lo otorga solo (del saldo del agente). Para manejar los beneficios de nuestro
  lado: `no_bonus: true` en el alta. (El cliente actual NO lo manda: hoy no hay reglas cargadas.)
- Un alta que se hace "fire-and-forget" no deja rastro si falla: hacerla con `await` y persistir
  `giroxSyncStatus:'error'` + el motivo. **[incidente]**

---

## 6. Rollover, bonos y reclamos

- Con el feat **Rollover y Bonos** activo el jugador puede tener saldo que NO puede retirar.
  Validar un retiro contra `balance` → la plataforma responde `422 rollover_locked` y queda un
  retiro colgado. Siempre `wagering.available`. Sin el feat, la API no manda `wagering` y
  disponible = balance (el cliente ya lo resuelve). **[manual + incidente evitado]**
- **Dos listas de multiplicadores distintas** en `GET /config`: `rollover.multipliers` (de la
  CARGA; en 1girox `[0,1,2,5,10]`) y `bonus.multipliers` (del BONO; `[0,2,5,10,20,40]`). Usar la
  lista equivocada da "The selected multiplier is invalid". **[incidente]**
- `bonus_multiplier` es **obligatorio** junto con `bonus_amount`/`bonus_percent` (422 si falta).
  **[incidente]**
- Límites del bono de monto fijo: `fixed_min`/`fixed_max` (en 1girox 2 / 1.000.000). Un regalo de
  $1 rebota con `bonus_out_of_range`.
- **Bono 0 = "regalo directo"** (`POST /bonus` con `multiplier: 0`, v1.10+): disponible y
  retirable al instante, sin reclamo, NO pisa el bono en curso, y en el panel figura como **Bono**
  (ledger `type:"bonus"`). Es la vía por defecto de todos los regalos (reembolsos, ruleta,
  rakeback, nivel VIP, comisiones). Antes iban por `/deposit` y en el panel del agente salían como
  "Carga", indistinguibles de las cargas reales. **[decisión + probado]**
  - Entre la v1.7 y la v1.10 el bono 0 quedaba "a reclamar" (el cliente veía "acreditado" y no la
    plata). Hoy no.
  - Fallback automático a depósito libre **con la misma reference** si: el bono suelto está
    apagado, 0 no está en `bonus.multipliers`, el monto sale de `fixed_min/max`, o la plataforma
    responde `feature_disabled` / `bonus_out_of_range` / 422 de validación / `player_not_found`.
    En un 422 no se movió plata, así que reusar la reference es seguro. Un error TRANSITORIO no cae
    al depósito: se devuelve para reintentar igual.
  - Kill switch sin deploy: `GIROX_GIFT_AS_BONUS=0` → los regalos vuelven a depósito libre.
- **Bono con rollover > 0:** queda bloqueado hasta apostar `monto × multiplier`. Con
  `bonus.claim_required: true` además queda **a reclamar** al cumplirse: si los jugadores no
  entran al casino, reclamarlo por API (`POST /bonus/claim`).
- **Bono sobre bono PISA:** otorgar un bono con rollover a un jugador con bono activo le debita lo
  que le quedaba del viejo. Antes de dar uno, leer fresh `bonus_locked + claimable_total`; si hay
  bono activo, dar el regalo como depósito CON `multiplier` (mismo candado, no pisa). Umbral usado:
  un resto total ≤ $50 no bloquea (centavos residuales de rollovers viejos rebotaban todo).
  **[incidente + decisión]**
- Reclamo: nunca "claim all" automático — se reclama solo el `requirement_id` propio. **[decisión:
  no auto-reclamar el regalito que el cliente ya tenía]**
- **Carga con bono en UNA operación:** `bonus_amount` + `bonus_multiplier` adentro del depósito →
  la plataforma registra carga y bono como tipos distintos. Si el bono viola los límites puede
  rechazarse la operación COMPLETA. Si vuelve `wagering.bonus.status === 'failed'`: la carga entró
  y el bono no — NO reintentar el depósito (devolvería duplicate); escalar a soporte.
- **Herencia de reglas del agente:** un `/deposit` sin params de bono hereda la campaña vigente
  del agente (1er depósito / código). Si el agente carga una promo en su panel, las cargas por API
  la aplican solas. Para evitarlo: `no_bonus: true`.
- El jugador que pierde todo el saldo cancela sus requisitos pendientes.

---

## 7. Saldo promocional (Wager)

Probado en vivo el 2026-11-13 con una key de prueba (cargas de $10 y un jugador de prueba jugando).

- Plata FICTICIA de la casa en un balde aparte (`player.wager`): no sale del saldo del agente, no
  suma al `balance`, no es retirable, no lleva rollover. Se ACUMULA (no se pisa). `wager: null` en
  nuestra lectura = la plataforma no manda el campo (feat apagado), distinto de `0`.
- **Darlo SIEMPRE con el promocional suelto** (`POST /players/{u}/promo`): da wager de verdad con
  el motor "clásico" y con el "unificado", idempotente por reference, `success` solo si
  `promo_bonus.status === 'ok'`.
- ⚠️ **NUNCA mandar `wager_percent` / `wager_amount` adentro del depósito.** Con el motor
  "unificado" la plataforma los convierte en **BONO REAL sin rollover (retirable al instante)**. El
  motor es una opción global del sitio que un admin puede cambiar: usar esos campos puede regalar
  plata real. **[probado]**
- Con motor "unificado" + agente "solo Pulse", un bono NORMAL adjunto a la carga
  (`bonus_percent`/`bonus_amount`) sale como promocional (`promo_bonus` en vez de
  `wagering.bonus`). El cliente lo marca `bonusAsWager`.
- **Cómo se juega [probado jugando]:** el juego muestra UN saldo = real + promocional; cada apuesta
  gasta primero el real y completa con promocional; en CADA apuesta (aunque se pague con real) el
  5% de lo apostado pasa de promocional a real mientras quede promocional; el premio vuelve al
  saldo que pagó la apuesta, en proporción; **un retiro por la API, de cualquier monto, BORRA todo
  el promocional al instante** (744,20 → 0 retirando $1,40).
- El `netwin` de `/stats` viene neto de lo jugado con wager. La plata que el promocional va
  convirtiendo en real ("Conversión wager") no se puede consultar por API.
- Respaldo con bono normal SOLO ante un rechazo 4xx (no movió nada). Ante un fallo transitorio, un
  reintento con la misma reference y, si sigue, dejarlo pendiente (pudo haber entrado).
- Contradicción del manual: dice que convierte "solo con Atomic" (§2.8) y "solo Pulse" (§2.8.1).
  El panel dice Pulse; el juego de prueba era del agregador `atomic`.

---

## 8. Netwin / stats (reembolsos, referidos, VIP)

- `GET /players/{u}/stats` y el batch salen de la misma API, por **username**, con la misma key.
  Antes de la v1.8 había que scrapear el panel de administración (Bearer de sesión, payload
  base64+deflate, búsqueda por LIKE que podía traer a OTRO jugador): era lo más frágil de todo y se
  eliminó. Ya no hace falta ningún ID numérico para pagarle a alguien.
- **Signo:** `netwin` positivo = el jugador perdió. Unidad: pesos.
- Rango máximo **92 días**; se evalúa en hora de **Argentina** del lado de la plataforma. Formatear
  las fechas anclando a `-03:00` (`formatStatsDate`). Para acumulados de por vida hay que consultar
  por tramos y "plegar" (ver `specs/ESPEC-REEMBOLSO-1GIROX.md`).
- **Bug de huso [incidente]:** armar los períodos con `new Date(year, month-1, 1)` usa la hora
  local del PROCESO; con el server en UTC, "1 de julio 00:00" era "30 de junio 21:00" de Argentina
  y esas 3 horas se contaban en dos meses. Anclar a `-03:00` explícito.
- `categories.casino` / `categories.sports` por separado. **[decisión]** reembolsos y comisiones
  solo sobre CASINO (`GIROX_NETWIN_SCOPE=casino`).
- Bloque `bonus { granted, still_locked }`: bono otorgado en el rango, a nivel jugador. Base de
  reembolso "sobre plata real" = `max(0, casinoNetwin − bonus.granted)`. No existe "qué parte de
  cada apuesta fue con bono".
- Los números son en vivo; el panel lee un rollup que se recalcula cada ~10 min (pueden diferir).
- Jugador sin actividad → 200 con ceros. `not_found` del batch mezcla "no existe" y "no es tuyo".
- Batch con jugadores de varias keys: hay que **agrupar por key** (cada key solo ve a los suyos);
  un batch único con la master devolvía a los de publicista como `not_found` y sus reembolsos
  quedaban en $0 en silencio. **[incidente]**
- **La comisión de referidos ya NO viene del proveedor** (todos los `commission` vuelven en 0): la
  tasa es nuestra (`GIROX_REFERRAL_COMMISSION_PCT`, default 8% del netwin = owner-revenue).
- Efecto colateral al migrar: referidos que antes daban $0 por no tener ID empezaron a generar
  comisión; recalcular un período viejo ya pagado hace aparecer deltas.
- Cache de 90 s en lecturas de display; el CLAIM que paga pasa `{ fresh: true }`.

---

## 9. Login único (SSO)

- `POST /players/{u}/session` → `redirect_url` con un código de **un solo uso que vence a los 60
  segundos**. No cachear ni guardar. Sin contraseña (ya autenticamos al usuario nosotros).
- **Trampa del bloqueador de pop-ups:** el link sale de un fetch asíncrono y los navegadores
  mobile bloquean `window.open` fuera del gesto del usuario. Abrir la pestaña PRIMERO, vacía, y
  recién después cambiarle la URL. No mover el `window.open` después del `await`. **[incidente]**
- Auto-reparación: si responde `player_not_found`, crear al jugador con clave random, marcar el
  estado y reintentar UNA vez.
- Limitar por **usuario**, no por IP (CGNAT de las telefónicas: barrios enteros comparten IP) y
  para proteger el cupo de 60 req/min.
- Código de un uso: ojo con prefetch o doble carga del iframe (queman el código y el navegador
  queda deslogueado). Un iframe con `src=''` navega a la propia app.
- `embed: true` (oculta los controles de sesión del casino) y `logout_url`: existen, hoy sin
  cablear en el gemelo.
- **Contraseñas:** las locales son bcrypt, irrecuperables. Los jugadores creados por migración o
  por red de seguridad nacen con clave random; la real se replica en la plataforma en el próximo
  login o cambio de clave (único momento en que la tenemos en claro), una vez por usuario
  (`giroxPasswordSynced`). Nadie queda afuera porque se entra por SSO.

---

## 10. Lo que la API NO tiene

- **Historial de movimientos/apuestas por jugador:** no existe. `getUserMovements()` devuelve
  `not_supported` a propósito.
- **Saldo del agente (cajero):** ninguna respuesta lo informa y no hay endpoint. El cruce "cajero"
  del cierre diario queda `sin_datos`. El hook `setCashierBalanceHook` está cableado por si algún
  día agregan `agent_balance`.
- **Reversiones / anulaciones:** no hay endpoint; para devolver se hace la operación inversa con
  otra reference.
- **Webhooks de la plataforma hacia nosotros:** no hay; todo es polling.
- **Mover un jugador de rama / transferir saldo entre jugadores:** no hay.
- `GET /chip-requests` existe pero requiere habilitación del operador (403 si no).

---

## 11. Panel de la plataforma vs API

- En el panel del agente, una operación figura según su tipo de ledger: `/deposit` = "Carga",
  `/bonus` = "Bono". Todo lo que no sea una carga real conviene mandarlo como bono para que el
  panel cuadre. La devolución de un retiro rechazado se deja como depósito (es plata real que
  vuelve). **[decisión]**
- **Caso asentado [incidente de visualización]:** un retiro de $85.000 hecho por API con la key de
  un sub-agente NO aparecía en "Cargas y Retiros de Fichas" del panel de ese agente, aunque la
  carga por la misma vía sí. La plata estaba bien (fichas descontadas y verificadas). Para
  reclamar: jugador, agente, fecha/hora, monto y la **reference**.
- El saldo del agente dueño de la key SUBE con cada retiro y BAJA con cada carga y cada bono real.
- Las ganancias de juego no aparecen en la vista de cargas/retiros.

---

## 12. Variables de entorno del cliente

| Variable | Default | Para qué |
|---|---|---|
| `GIROX_API_URL` | — | Base de la Partner API de ESTA instalación, sin barra final |
| `GIROX_API_KEY` | — | `X-Api-Key` de la cuenta master (`pk_…`). Secreto |
| `GIROX_PLAY_URL` | `https://1girox.com` | Sitio del jugador (respaldo si el SSO falla). **Cambiar para jugaygana.io** |
| `GIROX_TIMEOUT_MS` | `20000` | Timeout por request |
| `GIROX_MAX_RPM` | `55` | Techo local por instancia de la master |
| `GIROX_PUBLISHER_MAX_RPM` | `30` | Techo local por instancia de cada key de publicista |
| `GIROX_PUBLISHER_KEY_RPM` | — | Overrides `pk_x:90,pk_y:45` |
| `GIROX_API_KEY_CONSULTAS` | — | Pool de keys de solo-lectura `pk_a:90,pk_b` |
| `GIROX_PLAYER_CACHE_MS` | `8000` | Cache de lectura de jugador/saldo |
| `GIROX_STATS_CACHE_MS` | `90000` | Cache del netwin |
| `GIROX_GIFT_AS_BONUS` | (on) | `0` = regalos por depósito libre |
| `GIROX_NETWIN_SCOPE` | `casino` | `casino` \| `total` (server.js) |
| `GIROX_REFERRAL_COMMISSION_PCT` | `8` | % del netwin que es owner-revenue (server.js / referidos) |
| `GIROX_SYNC_PASSWORD_ON_LOGIN` | (on) | `0` = no replicar la clave en el login (server.js) |
| `GIROX_BONUS_MULTIPLIER` | — | Forzar el multiplicador de los bonos manuales (server.js) |
| `GIROX_MIGRATION_DELAY_MS` / `_PROGRESS_EVERY` / `_RATE_WAIT_MS` | 2500 / 25 / 65000 | Script de migración |

Los nombres `GIROX_*` se dejaron iguales a propósito para portar parches 1:1 entre gemelos. Para
jugaygana.io solo cambian los VALORES.

---

## 13. Diagnóstico

- `ping()` → 404 esperado; 401 = key/URL mal.
- `GET /config` crudo: qué feats, multiplicadores y topes tiene la instalación.
- Radiografía de boot `[girox] config:` (a stdout: el logger a archivo no entra en los logs de EB;
  los warn/error del cliente se espejan a `console`).
- `GET /api/admin/girox/health` (en el gemelo): env presentes (nunca los valores), ping, config de
  la plataforma, estado de sync de la base. `…/test-sso` y `…/stats-raw?username=&days=`.
- Script sin dependencias para probar una key desde cualquier máquina:
  `codigo-referencia/scripts/probar-partner-api.js` (solo lectura).

---

## 14. Qué hay que verificar en jugaygana.io antes de asumir nada

Todo esto es configuración POR INSTALACIÓN. Sale de `GET /config` y de preguntarle al operador:

| Dato | Cómo se obtiene | Por qué importa |
|---|---|---|
| Base URL de la Partner API | lo entrega el operador | sin esto no anda nada |
| Sitio del jugador (play URL) | operador | respaldo del SSO, textos `/sys_*` |
| ¿Rollover y Bonos activo? | `config.rollover.enabled`, `config.bonus.enabled` | si está apagado, mandar `multiplier`/bono da `feature_disabled` |
| ¿Bono suelto activo? | `config.bonus.standalone_enabled` | si no, los regalos van por depósito libre (figuran como Carga) |
| Multiplicadores | `config.rollover.multipliers`, `config.bonus.multipliers` | validar antes de mandar |
| Límites del bono fijo | `config.bonus.fixed_min/max` | regalos chicos/grandes rebotan |
| ¿Bonos a reclamar? | `config.bonus.claim_required` | si es true, reclamar por API |
| Reglas automáticas del agente | `config.bonus.auto_rules` | un depósito sin params las hereda |
| Motor de bonos | `config.bonus_engine` (`classic`/`unified`) | en `unified` el tipo del bono adjunto lo decide el agente |
| Wager | `config.wager.enabled/api_enabled/api_max` | sin `api_enabled`, `/promo` da `feature_disabled` |
| Límite de req/min de la key | operador | dimensionar `GIROX_MAX_RPM` ÷ instancias |
| ¿Los jugadores ya existen ahí? ¿con saldo? | operador + `GET /players/{u}` de una muestra | define si se crean, se vinculan o hay que mover saldos (ver PLAN-MUDANZA §5) |
| ¿Hay sub-agentes / publicistas con key propia? | `GET /agents` | ruteo por dueño |
| "El bono se pierde al retirar" | operador | un retiro borra bono activo y promocional |

## 15. Lo medido en jugaygana.io (2026-11-18)

Pruebas en vivo hechas desde AUTOREEMBOLSOSjygactivo con keys de prueba (no están en el repo).

| Tema | Resultado |
|---|---|
| Base URL | **`https://api.jugaygana.io/api/v1`**. `https://api-1gx.com/api/v1` (lo que mostraba el panel) rechaza las keys con 401 |
| Sitio / panel | `https://jugaygana.io` · `admin.jugaygana.io` |
| `GET /config` | `bonus_engine: classic` · rollover on `[0,1,2,3,5,10]` · bono on, suelto on, multiplicadores `[0,2,3,5,10,20,40]`, porcentajes `[10,20,50,100]`, fijo 2–1.000.000, `claim_required: true`, `auto_rules: []` · wager off |
| x3 | permitido (en 1girox no lo estaba) |
| Idempotencia | carga repetida con la misma `reference` → `duplicate:true`, saldo sin cambios; ídem retiro |
| Retiro mayor al saldo | `insufficient_funds` |
| Key de un usuario sin fichas | toda carga da `insufficient_funds`: la key tiene que ser de un agente fondeado |
| Jerarquía | la key de un agente LEE (jugador + stats) a los jugadores de su sub-agente; plata sobre ellos **sin probar**; jugadores de otro agente → 404 |
| En el panel de la plataforma | el bloque de bono suelto / límites fijos tiene su propio botón "Guardar porcentajes" |

Sin probar todavía: bono x0 y bono con rollover reales, SSO, `/stats` con juego real, plata sobre jugadores de un sub-agente, límite
de req/min de la key definitiva.
