# Especificación: REEMBOLSO / CASHBACK sobre plata real en una plataforma 1girox

> Documento para implementar (o auditar) el reembolso en CUALQUIER proyecto que
> opere sobre la Partner API de 1girox. Es independiente del código de este repo:
> describe QUÉ tiene que pasar y con QUÉ datos. Referencia de implementación:
> `_cashbackStateToday` en `server.js` de PAUTANUEVAsantino (WORKLOG #254 → #275).
> Fecha: 2026-09-11.

---

## 1. Qué queremos lograr (en una frase)

Devolverle al jugador un porcentaje (ej. 5%) de lo que perdió **de su propia plata**,
nunca de la plata que le regalamos (bonos, ruletas, reembolsos anteriores), nunca de
lo que ganó, y sin que el mismo peso se reembolse dos veces.

## 2. Los datos que existen (y los que NO existen)

### 2.1 Lo que da la Partner API — `GET /players/{username}/stats?from&to`
(y `POST /players/stats/batch` para hasta 100 jugadores)

```json
{
  "totals":     { "bets_count", "wagered", "payout", "netwin" },
  "categories": { "casino": {...}, "sports": {...} },
  "bonus":      { "granted": 12000, "still_locked": 3500 }
}
```

- `netwin = wagered − payout`. **POSITIVO = el jugador PERDIÓ** (base del reembolso).
  Negativo = el jugador ganó.
- Usar SOLO `categories.casino.netwin` (decisión de negocio: deportes no genera
  reembolso).
- `bonus.granted` = total de BONO OTORGADO al jugador **en el rango consultado**
  (bonos de depósito, `/bonus`, campañas de la plataforma, bonos dados a mano en el
  panel de 1girox). `still_locked` = cuánto de eso sigue con rollover sin cumplir.
- Reglas del endpoint: rango **máximo 92 días**; fechas en **hora argentina**; formato
  `Y-m-d H:i:s`; rate limit **60 req/min por API key**; un jugador sin actividad
  devuelve todo en 0 (no 404); los números son en vivo.
- El bloque `bonus` va a nivel jugador, NO por categoría. Si la API no lo manda
  (versión vieja), tratarlo como 0.

### 2.2 Lo que NO existe en ninguna plataforma con saldo unificado
- "Qué parte de cada apuesta fue bono y qué parte plata real." El bono entra al
  mismo saldo con un candado de rollover; al apostar, el débito sale del saldo
  unificado. **No pedirlo, no inventarlo.**
- Consecuencia: el descuento se hace sobre lo **otorgado**, no sobre lo "apostado con
  bono". La duda se resuelve siempre a favor de la casa.

### 2.3 Lo que tenemos NOSOTROS (base propia)
Cada peso que le acreditamos al jugador queda registrado como transacción con su
tipo y origen:
- `deposit` (carga real) — con un campo `bonus` si esa carga llevó un % extra.
- `bonus` (ruleta en saldo, código de bienvenida, lote, bono manual del cajero,
  **reembolso instantáneo ya pagado** — `metadata.source:'instant_cashback'`).
- `fire_reward`, `refund` (semanal/mensual), `rakeback`, `vip_levelup`,
  `referral_commission`.
Todo lo que NO es `deposit` (más el `bonus` de los deposits) es **REGALO**.

## 3. La fórmula (cashback acumulativo de por vida)

```
netoDePorVida   = Σ netwin_casino desde el alta del jugador (o desde el arranque en 1girox)
regalado        = TODO lo que le acreditamos sin ser carga real, INCLUIDOS los
                  reembolsos que ya cobró (ver 3.2)
pérdidaReal     = max(0, netoDePorVida − regalado)
cobrado         = Σ reembolsos ya pagados (estado pending + credited)

reclamable      = floor( pct% × pérdidaReal − cobrado )
reclamable      = min(reclamable, topeDiario − cobradoHoy)      // tope por día
si reclamable < mínimo  → no se puede reclamar todavía (mostrar cuánto falta)
```

### 3.1 Por qué "de por vida" y no por día/semana/mes
- Se **acumula** hasta que reclame (no vence).
- Al reclamar queda exacto en **0** y lo que pierda después suma desde cero.
- Una ganancia grande **resta para siempre**: el que ganó $10M no cobra hasta perder
  más de $10M acumulados. Con ventana (ej. 30 días) la ganancia "vencía" y sus
  pérdidas nuevas generaban reembolso — agujero cerrado a propósito.
- Si el negocio quiere otra cosa (ventana rodante, reset mensual, tope al arrastre),
  es UNA línea en `netoDePorVida`; el resto de la fórmula no cambia.

### 3.2 Por qué los reembolsos cobrados cuentan como regalo
Si el jugador pierde los $C que le reembolsamos, `netoDePorVida` sube $C y `regalado`
sube $C → se cancelan → **$0 de reembolso del reembolso**. Sin esto cobraría pct×C
otra vez (chico, pero infinito en teoría).
Efecto aceptado: si en vez del reembolso pierde $C de plata real, tampoco cobra por
esos $C — no se puede distinguir cuál perdió (2.2). Lado conservador.

### 3.3 `regalado`: fuente local + fuente oficial, tramo a tramo
```
regalado = max(localTramoViejo, grantedTramoViejo) + max(localTramoVivo, grantedTramoVivo)
```
- **local** = nuestras transacciones (2.3). Cubre regalos que fueron como DEPÓSITO
  (fallbacks, historia previa a acreditar regalos vía `/bonus`).
- **granted** = `bonus.granted` de la plataforma. Cubre bonos que NO están en nuestra
  base (dados a mano en el panel de 1girox, campañas propias de la plataforma).
- Se toma el MAYOR por tramo: nunca se reembolsa un regalo que alguno de los dos vio.
- Se compara **por tramo** (no total contra total) por el plegado de 3.4.
- Loguear cuando difieren: sirve para auditar y para decidir más adelante si conviene
  usar solo el oficial.

### 3.4 Cómo se suma "de por vida" con un tope de 92 días por consulta
Acumulador PLEGADO por jugador:
- `carryNet` (neto consolidado de tramos viejos, puede ser negativo),
  `carryGranted` (bono otorgado en esos mismos tramos), `anchorAt` (desde dónde se
  consulta en vivo; inicial = alta del jugador o fecha de arranque en 1girox).
- Cuando `hoy − anchorAt > 85 días`: consultar `[anchorAt, anchorAt+60d)`, sumar su
  netwin a `carryNet` y su `granted` a `carryGranted`, y mover `anchorAt` +60 días.
  **Update atómico condicionado al `anchorAt` previo** (dos instancias del server no
  pliegan el mismo tramo dos veces; si el update no modifica nada, releer y seguir).
- `netoDePorVida = carryNet + netwin(anchorAt → hoy)`.
- La suma local de regalos se parte con la MISMA ancla: `< anchorAt` vs `≥ anchorAt`.

### 3.5 Bonos regalados ANTES de esta lógica
Si el proyecto venía acreditando regalos como depósitos, `granted` no los ve. Por eso
la fuente local es obligatoria (no alcanza con el dato oficial) y se toma el máximo.

## 4. El reclamo (pagar)

1. Recalcular con **datos frescos** (sin cache) en el momento del reclamo.
2. Guard anti-doble-click: si hay otro reclamo del mismo jugador creado hace < 20 s,
   abortar. Los reclamos `pending` también cuentan como `cobrado`.
3. **Reservar ANTES de acreditar:** crear el registro del reclamo con índice único
   (jugador + día + secuencia). Si la creación falla por duplicado → ya se reclamó.
4. Acreditar en 1girox como **BONO con rollover** (`POST /players/{u}/bonus`,
   multiplier = rollover configurado, ej. x2) con `reference` idempotente derivada
   del registro (ej. `vip-cbk-<userId>-<día>-<seq>`). Ante timeout/error de red,
   reintentar con la MISMA reference (la plataforma responde `duplicate:true` y no
   paga dos veces). Si el jugador tiene otro bono activo, caer a depósito con
   `multiplier` (no pisarle el bono).
5. Si la acreditación falla definitivamente: marcar el reclamo `failed` (o borrarlo)
   para que pueda reintentar; si es `duplicate:true`, darlo por pagado.
6. Registrar la transacción local `type:'bonus'`, `metadata.source:'instant_cashback'`
   con el monto — es lo que alimenta `regalado` (3.2) y `cobrado`.
7. Tope por día por jugador; mínimo para cobrar; rollover del bono: todo configurable
   desde el panel.

## 5. Reembolso por PERÍODO (semanal / mensual), si el proyecto lo tiene
Misma idea, más simple: no hay acumulado, la base es el período.
```
pérdidaPeríodo = max(0, netwin_casino(período) − bonus.granted(período))
reembolso      = % por rango (ej. Bronce 3% / Plata 6% / Oro 10%) según pérdidaPeríodo
                 − lo ya cobrado en cashback instantáneo dentro de ese período
```
- Reserva atómica por `jugador + tipo + periodKey` (un reclamo por período).
- `reference` derivada del **período** (`vip-rf-<periodKey>-<userId>`), NO del id del
  reclamo: si el reclamo se borra y se reintenta, la reference tiene que ser la misma.
- Imprecisión aceptada: un bono otorgado la semana anterior y perdido esta semana no
  se descuenta (la plataforma solo da "otorgado en el rango").

## 6. Lo que se pidió a 1girox y todavía no está
`bonus.forfeited` (bono efectivamente PERDIDO en el rango) y `bonus.released` (bono
que cumplió rollover y pasó a ser plata real). Con `forfeited` la base sería
`netwin − forfeited` (exacta) en vez de `netwin − granted` (conservadora). Si lo
agregan: cambiar esa única línea y dejar de descontar bonos no jugados.

## 7. Casos de prueba que tienen que dar esto
| Caso | Esperado |
|---|---|
| Carga $20k, regalo $20k, pierde $40k, pct 5% | reclamable **$1.000** (no $2.000) |
| Gana $10M, después pierde $4M | **$0** (neto de por vida −6M) |
| Pierde $100k, cobra $5k, pierde esos $5k | **$0** (sin reembolso del reembolso) |
| Pierde $100k, cobra $5k, pierde $100k más | **$5.000** |
| Regalo $20k todavía bloqueado (no jugado), pierde $10k reales | **$0** hasta que pierda más de $20k (conservador) |
| Doble click en RECLAMAR | un solo pago (índice único + reference idempotente) |
| Timeout de la API al acreditar, reintento | un solo pago (`duplicate:true`) |
| Bono dado a mano en el panel de 1girox (no está en nuestra base) | igual se descuenta (`granted`) |
| 100 días desde el alta | plegado: un tramo de 60 días al carry, ancla avanza |

## 8. Errores típicos a evitar
- Multiplicar montos ×100 (1girox trabaja en PESOS).
- Validar retiros contra `balance` en vez de `wagering.available` (rollover activo).
- Pedir stats con rango > 92 días o en UTC (es hora argentina).
- Acreditar regalos con `/bonus` sin rollover pensando que "no pisa": con rollover > 0
  pisa un bono activo → chequear antes o caer a depósito con `multiplier`.
- Reference nueva en cada reintento (paga doble) o reference repetida entre
  operaciones distintas (la segunda no se acredita).
- Contar sports en el netwin (decisión: solo casino).
- Excluir los reembolsos pagados de `regalado` (reembolso del reembolso).
