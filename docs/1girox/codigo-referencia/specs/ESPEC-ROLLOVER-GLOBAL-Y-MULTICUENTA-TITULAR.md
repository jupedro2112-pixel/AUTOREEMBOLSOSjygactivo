# Especificación portable: (A) ROLLOVER GLOBAL de bonos + (B) MULTICUENTA por TITULAR del comprobante

> Para implementar lo mismo en otro proyecto que opere sobre la Partner API de
> 1girox. Describe QUÉ hacer y CÓMO se resolvió en PAUTANUEVAsantino (WORKLOG #278
> y #279, commits `1f1d14d` y `f3e80b7`). Los nombres de funciones/archivos son los
> de ese repo; en otro repo pueden cambiar, la lógica no.

---

# A) ROLLOVER GLOBAL DE BONOS (x0 / x2 / x3 / x5 / x10, default x3, editable en el panel)

## A.1 Objetivo
Un único rollover para **todos** los bonos/regalos, elegible desde el panel admin.
Mientras esté activado, los rollovers individuales de cada flujo se ignoran.
Apagado = cada flujo vuelve a usar el suyo (sin migración).

Flujos que SÍ reciben el global: bono de primera carga (100% automático), bonus
manual del agente sobre una carga, bono manual directo, ruleta de bienvenida y
diaria (premios en saldo y en %), lotes de notificación (fichas y %), código de
bienvenida, fueguito, cashback/reembolso instantáneo, reembolso semanal/mensual,
rakeback, bono por nivel VIP.

Flujos que NO (no son bonos, es plata del cliente o del referidor): **comisiones de
referidos** y **devoluciones de retiro rechazado**.

## A.2 Dónde se aplica (la clave del diseño)
No tocar 12 endpoints: se aplica en el **cliente de la Partner API**, en los 3 puntos
por donde pasa TODO bono, con un resolver inyectado desde el server:

```js
// giroxService.js
let _rolloverResolver = null;
function setRolloverResolver(fn) { _rolloverResolver = typeof fn === 'function' ? fn : null; }
async function _globalRollover() {          // número (efectivo) o null (modo global apagado)
  if (!_rolloverResolver) return null;
  try { const v = await _rolloverResolver(); const n = Number(v);
        return (v == null || !Number.isFinite(n) || n < 0) ? null : Math.round(n); }
  catch (_) { return null; }
}
```

1. `creditGift(username, amount, { rolloverX, reference, description, ignoreGlobalRollover })`
   — regalo como BONO (`POST /players/{u}/bonus`) con fallback a depósito con `multiplier`:
   ```js
   let roll = Math.max(0, Math.round(Number(opts.rolloverX) || 0));
   if (!opts.ignoreGlobalRollover) { const g = await _globalRollover(); if (g != null) roll = g; }
   // ... al llamar internamente a creditUserBalance pasar ignoreGlobalRollover:true (ya se aplicó)
   // devolver r.rolloverApplied = roll
   ```
2. `creditUserBalance(username, amount, reference, { multiplier, ignoreGlobalRollover })` —
   rama con `multiplier` explícito (`/bonus` directo):
   ```js
   let mult = Number(opts.multiplier);
   if (!opts.ignoreGlobalRollover) { const g = await _globalRollover(); if (g != null) mult = g; }
   body.multiplier = mult;  // devolver out.rolloverApplied = mult
   ```
   y la rama sin `multiplier` (que delega en `creditGift` con x0) propaga `ignoreGlobalRollover`.
3. `depositToUser(username, amount, description, reference, wagering)` — solo cuando la
   carga lleva bono nuestro:
   ```js
   if ((body.bonus_amount > 0 || body.bonus_percent > 0) && !wagering.ignoreGlobalRollover) {
     const g = await _globalRollover(); if (g != null) body.bonus_multiplier = g;
   }
   ```

Exclusiones: en el pago de comisiones de referidos y en la devolución de retiro
(parte bono) pasar `{ ignoreGlobalRollover: true }`. Una devolución que va por
`depositToUser` SIN wagering no se toca (no lleva bono).

## A.3 Config, validación contra la plataforma y helper del server
```js
// server.js
const BONUS_ROLLOVER_OPTIONS = [0, 2, 3, 5, 10];
const BONUS_ROLLOVER_DEFAULT = { enabled: true, x: 3 };
// Config['bonusRolloverGlobal'] = { enabled, x }  (sin cache: multi-instancia)
async function getGlobalBonusRollover() {
  // lee la config; valida x ∈ OPTIONS; default {true,3}
  // lee bonus.multipliers de GET /config de 1girox (cacheado en giroxService)
  // effective = x si está permitido; si no, el permitido MÁS CERCANO HACIA ARRIBA
  //             (o el máximo permitido); snapped = effective !== x
  return { enabled, x, effective, allowed, snapped, options: BONUS_ROLLOVER_OPTIONS };
}
async function applyGlobalRollover(flowValue) {   // para mensajes/registros
  const g = await getGlobalBonusRollover();
  return g.enabled ? g.effective : Math.max(0, Math.round(Number(flowValue) || 0));
}
girox.setRolloverResolver(async () => { const g = await getGlobalBonusRollover(); return g.enabled ? g.effective : null; });
```
⚠️ **1girox solo acepta los multiplicadores de `bonus.multipliers` de la cuenta** (en la
cuenta de referencia era `[0,2,5,10,20,40]` → x3 NO permitido → efectivo x5 hasta que
soporte lo habilite). Sin la validación, el bono se rechaza (`invalid_multiplier`).
El getter de multiplier de las cargas con bono (`getGiroxBonusMultiplier`) debe devolver
el global efectivo cuando está encendido.

## A.4 Coherencia de lo que se le DICE al cliente
Donde el rollover se muestra o se guarda (mensaje "entra como bono con rollover xN",
`Transaction.metadata.rolloverX`, status del cashback, premio de la ruleta, lote,
fueguito, código de bienvenida) usar `await applyGlobalRollover(valorDelFlujo)` para
que coincida con lo acreditado. Si el repo no puede tocar todos esos puntos, alcanza
con leer `r.rolloverApplied` que devuelve el cliente de la API.

## A.5 Endpoints y panel
- `GET /api/admin/bonus-rollover` → `{ enabled, x, effective, allowed, snapped, options }`.
- `POST /api/admin/bonus-rollover` `{ enabled, x }` (solo admin general; 400 si x ∉ options).
- Card "🎯 Rollover GLOBAL de bonos" en Configuración: switch "activado (pisa los
  individuales)" + botones x0/x2/x3/x5/x10 (los no permitidos por la plataforma en
  gris con ⚠️ y tooltip) + hint "Activo: todos los bonos salen con xN" / aviso de
  `snapped` / lista permitida. Bumpear el service worker del panel.

## A.6 Pruebas
| Caso | Esperado |
|---|---|
| Global ON x3 (permitido) → carga manual con bonus 20% | en 1girox el bono con `bonus_multiplier` 3 |
| Global ON x3 pero plataforma permite [0,2,5,10] | efectivo x5, panel muestra ⚠️ "se está usando x5" |
| Global ON → ruleta diaria premio en saldo con rollover propio x2 | acredita x3 (global) y el mensaje dice x3 |
| Global ON x0 | todos los bonos sin rollover (retirables) |
| Global OFF | cada flujo con su rollover de siempre |
| Global ON → comisión de referidos | sin rollover (excluida) |
| Global ON → devolución de retiro rechazado | sin rollover (excluida) |

---

# B) MULTICUENTA POR TITULAR DEL COMPROBANTE (la persona ya cargó en otra cuenta)

## B.1 El hueco
El cruce de identidad bancaria (mismo CBU/titular de origen ya fondeó a OTRA cuenta →
carga sin bonos + alerta) corría **solo cuando llegaba el movimiento por el webhook
del banco**. Si la transferencia no aparece (banco sin API, demora, datos que no
matchean), la IA verifica el comprobante, lee el titular… y nadie lo cruza. Un mismo
titular podía cobrar el 100% de bienvenida en varias cuentas.

## B.2 Datos
La IA de comprobantes ya extrae `titular_origen` → `Comprobante.originHolder`. Agregar:
```js
originHolderKey: { type: String, default: null, index: true }  // titular normalizado
```
Normalización (misma función en todos lados):
```js
function _holderKey(name) {
  const k = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '')   // sin acentos
    .toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();     // sin puntuación
  if (k.length < 8 || k.split(' ').length < 2) return null;  // "JUAN" o "SA" no identifican
  return k;
}
```
Se guarda al crear el comprobante (`originHolderKey: _holderKey(result.originHolder)`).
Las filas viejas (sin key) se cruzan por `originHolder` exacto case-insensitive.

## B.3 El cruce
```js
async function _findHolderConflict(userId, holderName) {
  const key = _holderKey(holderName); if (!key) return null;
  // 1) comprobantes VERIFICADOS de OTRAS cuentas con ese titular
  const c = await Comprobante.findOne({ isComprobante: true, userId: { $ne: userId },
    $or: [{ originHolderKey: key }, { originHolder: /^<nombre escapado>$/i }],
    status: { $in: ['unique', 'no_key'] } }).sort({ createdAt: -1 });
  if (c) return { username: c.username, via: 'comprobante' };
  // 2) movimientos bancarios de OTRAS cuentas con ese titular de origen
  const m = await BankMovement.findOne({ fromName: /^<nombre escapado>$/i,
    matchedUserId: { $exists: true, $nin: [null, userId] } });
  if (m) return { username: m.matchedUsername, via: 'banco' };
  return null;
}
```

## B.4 Dónde se usa (3 lugares)
1. **Al verificar el comprobante** (después de crear el `Comprobante` con status
   `unique`/`no_key`): si hay conflicto → nota SOLO para agentes en el chat:
   `🚨 MULTICUENTA POR TITULAR: el comprobante viene de "X", que YA cargó en la cuenta
   @otro (comprobante anterior | transferencia confirmada por el banco). Si se carga a
   mano, SIN bonos automáticos. Verificá y bloqueá si corresponde.` + log WARN.
2. **Auto-carga por webhook del banco:** si el cruce por `BankMovement` (CBU/titular)
   no dio nada, probar `_findHolderConflict(user.id, movement.fromName)`; si da →
   misma consecuencia que el cruce bancario: la carga entra (es su plata) **sin bonos
   automáticos** (ni ruleta % ni 1ª carga) + la alerta.
3. **fraud-check del panel** (banner "POSIBLE MULTICUENTA"): señal nueva
   `receipt_holder` (fuerte): titulares de los comprobantes de este usuario →
   comprobantes de otras cuentas con el mismo `originHolderKey`; label "el MISMO
   titular en los comprobantes (Nombre) — leído por la IA". Ícono 🧾 (y 🏦 para la
   señal bancaria).

## B.5 Lo que NO cambia
- La carga manual del agente no bloquea nada sola: el agente ve la nota/banner y decide.
- No se bloquea al usuario automáticamente (falsos positivos: homónimos, cuentas
  familiares) — se avisa y se le quitan los bonos automáticos.
- Fail-open: si el cruce falla (DB), la carga sigue como siempre.

## B.6 Pruebas
| Caso | Esperado |
|---|---|
| Titular "Mercedes Daniela Gaillard" cargó en @a; manda comprobante en @b sin transferencia todavía | nota 🚨 MULTICUENTA POR TITULAR en el chat de @b |
| Mismo titular con acentos/mayúsculas distintas ("MERCEDES  GAILLARD, Daniela") | mismo key → detecta |
| Titular de 1 palabra ("JUAN") | no cruza (evita falsos positivos) |
| Llega el movimiento del banco para @b con `fromName` = titular usado en @a (sin `BankMovement` previo de @a, solo comprobante) | carga sin bonos + alerta |
| Panel → chat de @b → banner amarillo | señal 🧾 "el MISMO titular en los comprobantes" con @a |
| Comprobante viejo (sin `originHolderKey`) del mismo titular | igual detecta (regex por nombre) |
