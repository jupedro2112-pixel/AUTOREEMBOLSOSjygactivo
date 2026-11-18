# RÉPLICA 2026-09-07 — Regalos como BONO en 1girox + Transacciones del panel por tipo

> Documento para copiar y pegar en la sesión de la repo gemela. Contiene TODO lo
> hecho el 2026-09-07 en VIPCARGASgiroxnuevo (commits `d57acbf` y `b399ef1`), con
> el código final tal cual quedó. Aplicar en orden. Al final: `node --check` en
> cada archivo tocado, actualizar WORKLOG/ARCHITECTURE/CLAUDE.md, commit y push.

## 0. Contexto (leer antes de tocar)

**Problema del owner (captura del panel de 1girox):** los premios de la ruleta
(`vip-roulette-*`) y los reembolsos (`vip-rf-daily-*`) figuraban como "↑ Carga",
indistinguibles de las cargas reales de los cajeros / hgcash.

**Causa:** `creditUserBalance` sin `multiplier` caía en `depositToUser`
(`POST /players/{u}/deposit`). Se había decidido así el 2026-07-31 porque con la
Partner API v1.7 un `POST /bonus` con `multiplier: 0` quedaba "a reclamar".
**Desde la v1.10 (2026-08-03)** el bono 0 es un **regalo directo**: disponible y
retirable al instante, sin reclamo ("el bono 0 nunca pasa por el claim: se
acredita directo"), **no pisa el bono en curso**, y en el ledger es
`type: "bonus"` → figura como **Bono**. Lo confirma el manual **Partner API
v1.15** (secciones 2.9 y 2.12 + changelog). Guardar el PDF como
`docs/PARTNER-APIv1.15.pdf` (el owner lo tiene en Downloads).

**Datos de la config real del sitio (`GET /config`):** `bonus.multipliers =
[0,2,5,10,20,40]`, `fixed_min = 2`, `fixed_max = 1000000`, `claim_required =
true`, `standalone_enabled = true`, `rollover.multipliers = [0,1,2,5,10]`.
Consecuencia: un reembolso de $1 NO puede ir como bono (fixed_min=2) → tiene que
caer a depósito sin rebotar.

**Pedido adicional del owner:** "todo lo que no sea depósito común (reembolso,
bonificación, ruleta, TODO lo demás) se cargue como BONUS, y que se anote bien en
Transacciones del panel admin, separado".

**Decisiones tomadas (respetarlas):**
- Regalos SIN rollover (reembolsos, ruleta, rakeback, bono de nivel VIP,
  comisiones de referidos, parte "bonus" de una devolución de retiro rechazado)
  → `/bonus` con `multiplier: 0`, con **fallback automático a depósito libre con
  la MISMA reference** (la plata SIEMPRE llega; sólo cambia cómo figura).
- Los flujos que ya pasaban `multiplier` explícito (botón Bonificación del panel,
  welcome code cash, lotes con regalo) quedan `/bonus` ESTRICTO sin fallback: un
  `bonus_out_of_range` se ve como error, no como carga silenciosa.
- **Fueguito** con rollover >0 → `/bonus` con ese multiplier (figura como Bono),
  PERO si el jugador ya tiene un bono activo (`bonus_locked + claimable > 0`) cae
  al depósito con `multiplier` de antes: otorgar otro bono lo PISARÍA y le
  debitaría el resto ("bono sobre bono"). Con rollover 0 → regalo directo.
- **Devolución de retiro rechazado** (`vip-payoutref-*` por `depositToUser`) se
  DEJA como depósito: no es un regalo, es plata real que vuelve.
- Kill switch sin deploy: env `GIROX_GIFT_AS_BONUS=0` → todo vuelve a depósito.
- Nunca claim-all automático: si el regalo quedara "a reclamar", se reclama SÓLO
  ese `requirement_id` (decisión previa del owner de no auto-reclamar el regalito
  que el cliente ya tuviera).
- Errores transitorios (red / 429 / 5xx) del `/bonus` NO caen a depósito: se
  devuelven al caller para que reintente con la misma reference (un timeout puede
  haber acreditado del otro lado).

---

## 1. `src/services/giroxService.js` — reemplazar `creditUserBalance` completa

Buscar el bloque que empieza en el docblock `/** * Acredita un bono / premio /
reembolso.` y termina en la llave de cierre de `async function
creditUserBalance(...)`. Reemplazarlo ENTERO por esto (incluye 5 helpers nuevos):

```js
/**
 * Acredita un bono / premio / reembolso (regalo: reembolsos, ruleta, rakeback, bono
 * de nivel VIP, comisiones de referidos, regalos de lote, código de bienvenida).
 *
 * DEFAULT (sin `opts.multiplier`) = REGALO DIRECTO por `POST /players/{u}/bonus` con
 * `multiplier: 0` (Partner API v1.10+, confirmado en el manual v1.15 §2.9/§2.12):
 *   - queda disponible/RETIRABLE al instante, SIN pasar por el reclamo (el bono 0
 *     "nunca pasa por el claim: se acredita directo");
 *   - NO pisa el bono en curso del jugador (a diferencia de un bono con rollover);
 *   - en el panel de 1girox figura como BONO (ledger `type: "bonus"`), no como Carga.
 * Antes (hasta 2026-09-07) esta rama iba por `/deposit` libre y TODOS los regalos
 * aparecían como "Carga" en el panel del agente, indistinguibles de las cargas reales
 * (reclamo del owner con captura: vip-rf-* y vip-roulette-* como "↑ Carga").
 *
 * 🪦 El comentario viejo decía "NO USAR /bonus: con multiplier 0 queda a reclamar
 * (v1.7)". Eso fue cierto sólo entre la 1.7 y la 1.10 (2026-07-31 → 2026-08-03).
 *
 * FALLBACK AUTOMÁTICO A DEPÓSITO LIBRE (misma reference — en un 422 la plataforma
 * NO mueve plata, así que reusar la reference es seguro): cuando el bono suelto no
 * está habilitado, el 0 no está entre `bonus.multipliers`, el monto queda fuera de
 * `fixed_min/fixed_max` (ej. un reembolso de $1 con fixed_min=2), o la plataforma
 * responde `feature_disabled` / `bonus_out_of_range` / validación 422. La plata
 * SIEMPRE llega; sólo cambia cómo figura en el panel. Errores transitorios (red,
 * 429, 5xx) NO caen al depósito: se devuelven para que el caller reintente con la
 * misma reference (un timeout puede haber acreditado del otro lado).
 *
 * Kill switch sin deploy: `GIROX_GIFT_AS_BONUS=0` → vuelve al depósito libre de antes.
 *
 * Con `opts.multiplier` explícito usa `/bonus` ESTRICTO (sin fallback): con >0 el
 * bono queda bloqueado hasta apostar amount × multiplier, con `claim_required` puede
 * quedar "a reclamar" (los callers hacen claimPendingBonus) y ⚠️ PISA un bono activo
 * previo; con 0 explícito es el mismo regalo directo pero un rechazo se devuelve
 * como error (botón Bonificación del panel, welcome code, lotes).
 *
 * @returns misma forma que depositToUser (+ `creditedAs: 'bonus'|'deposit'`)
 */
async function creditUserBalance(username, amount, reference = null, opts = {}) {
  const amt = _normalizeAmount(amount);
  if (amt === null) return { success: false, error: 'Monto inválido', code: 'invalid_amount' };

  // Multiplier EXPLÍCITO (incluido 0): /bonus estricto, SIN fallback a depósito —
  // lo usan el botón Bonificación del panel, el welcome code cash y los lotes, donde
  // un bonus_out_of_range tiene que verse como error (no convertirse en carga).
  if (opts && opts.multiplier != null) {
    const body = {
      amount: amt,
      multiplier: Number(opts.multiplier),
      reference: _buildReference('bonus', reference)
    };
    // El endpoint /bonus no documenta `description`, pero se manda igual para que el
    // historial de la plataforma no quede sin contexto (un campo extra se ignora).
    if (opts.description) body.description = String(opts.description).slice(0, 500);
    const r = await _request({
      method: 'post',
      path: `/players/${encodeURIComponent(String(username))}/bonus`,
      body,
      label: `bonus(${username}, $${amt}, x${body.multiplier}, ref=${body.reference})`,
      username
    });
    if (!r.ok) return { success: false, error: r.error, code: r.code, httpStatus: r.httpStatus };
    // El estado del jugador cambió (bono nuevo): invalidar la lectura cacheada.
    _invalidatePlayer(username);
    const out = _moneyResult(r.data);
    out.creditedAs = 'bonus';
    return out;
  }

  // Regalo directo = bono 0 (default). La reference es la MISMA en las dos ramas.
  const ref = _buildReference('bonus', reference);
  const description = (opts && opts.description) || '';

  if (_giftAsBonusEnabled()) {
    const pre = await _giftPrecheck(amt);
    if (pre.ok) {
      const body = { amount: amt, multiplier: 0, reference: ref };
      if (description) body.description = String(description).slice(0, 500);
      const r = await _request({
        method: 'post',
        path: `/players/${encodeURIComponent(String(username))}/bonus`,
        body,
        label: `gift(${username}, $${amt}, ref=${ref})`,
        username
      });
      if (r.ok) {
        _invalidatePlayer(username);
        const out = _moneyResult(r.data);
        out.creditedAs = 'bonus';
        // Cinturón: si (contra lo documentado) el regalo quedara "a reclamar", se
        // reclama SÓLO ese requirement — nunca claim-all, para respetar la decisión
        // del owner de no auto-reclamar el regalito que el cliente ya tuviera.
        if (!out.duplicate) await _claimOwnGiftIfLocked(username, r.data);
        return out;
      }
      if (!_giftFallbackToDeposit(r)) {
        return { success: false, error: r.error, code: r.code, httpStatus: r.httpStatus };
      }
      logger.warn(`[girox] gift(${username}, $${amt}) rechazado por la plataforma (${r.code}) — cae a depósito libre con la misma reference ${ref}`);
    } else {
      logger.info(`[girox] gift(${username}, $${amt}) va por depósito libre: ${pre.reason}`);
    }
  }

  // Depósito libre (fallback / kill switch)
  const out = await depositToUser(username, amt, description, ref);
  if (out && out.success) out.creditedAs = 'deposit';
  return out;
}

/** Kill switch: GIROX_GIFT_AS_BONUS=0|false|off → regalos por depósito libre (como antes). */
function _giftAsBonusEnabled() {
  const raw = String(process.env.GIROX_GIFT_AS_BONUS || '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/**
 * Chequeo previo contra GET /config (cacheado 10 min) para no gastar un request en un
 * /bonus que va a rebotar. Sin config disponible → se intenta igual (el 422 cae al
 * fallback). Devuelve { ok, reason }.
 */
async function _giftPrecheck(amt) {
  let cfg = null;
  try {
    const r = await getPlatformConfig();
    if (r.success) cfg = r.config || null;
  } catch (_) { /* sin config: se intenta */ }
  if (!cfg || !cfg.bonus) return { ok: true, reason: 'config no disponible' };
  const b = cfg.bonus;
  if (b.enabled === false) return { ok: false, reason: 'bonos deshabilitados en la plataforma' };
  if (b.standalone_enabled === false) return { ok: false, reason: 'bono suelto deshabilitado en la plataforma' };
  if (Array.isArray(b.multipliers) && b.multipliers.length && !b.multipliers.map(Number).includes(0)) {
    return { ok: false, reason: 'la plataforma no permite multiplier 0 en bonos' };
  }
  const min = Number(b.fixed_min) || 0;
  const max = Number(b.fixed_max) || 0;
  if (min > 0 && amt < min) return { ok: false, reason: `monto $${amt} menor al mínimo de bono fijo ($${min})` };
  if (max > 0 && amt > max) return { ok: false, reason: `monto $${amt} mayor al máximo de bono fijo ($${max})` };
  return { ok: true, reason: 'ok' };
}

/**
 * ¿Un fallo del /bonus 0 debe caer a depósito libre? Sólo los rechazos de NEGOCIO en
 * los que la plataforma NO movió plata (422 de feat/rango/validación) y el jugador
 * inexistente (404: depositToUser lo crea al vuelo). Nunca en errores transitorios.
 */
function _giftFallbackToDeposit(r) {
  if (!r) return false;
  if (r.code === 'feature_disabled' || r.code === 'bonus_out_of_range' || r.code === 'player_not_found') return true;
  return r.httpStatus === 422;
}

/**
 * Cinturón anti "regalo a reclamar": si la respuesta del bono 0 trae un
 * requirement_id que además aparece en `claimable`, se reclama ESE puntual.
 * Con la v1.10+ no debería pasar (bono 0 = directo); se deja por si la config del
 * sitio lo cambia. Fire-and-forget: nunca hace fallar el crédito (la plata ya entró).
 */
async function _claimOwnGiftIfLocked(username, data) {
  try {
    const w = data && data.wagering;
    const reqId = w && w.bonus && w.bonus.requirement_id;
    if (reqId == null) return;
    const bd = w.breakdown || {};
    const claimable = Array.isArray(bd.claimable) ? bd.claimable : (Array.isArray(w.claimable) ? w.claimable : []);
    if (!claimable.some((c) => c && Number(c.id) === Number(reqId))) return;
    logger.warn(`[girox] gift(${username}) quedó "a reclamar" (req=${reqId}) — se reclama ese requirement`);
    const c = await claimPendingBonus(username, reqId);
    if (!c.success) logger.warn(`[girox] gift(${username}) claim del req=${reqId} falló: ${c.error}`);
  } catch (e) {
    logger.warn(`[girox] gift(${username}) claim excepción: ${e.message}`);
  }
}

/** Resumen para la radiografía de boot: cómo se acreditan los regalos. */
function getGiftModeSummary() {
  return _giftAsBonusEnabled() ? 'bono 0 (regalo directo, fallback depósito)' : 'depósito libre (GIROX_GIFT_AS_BONUS=0)';
}
```

Después, en el `module.exports` al final del archivo, agregar `getGiftModeSummary`
justo después de `claimPendingBonus,`:

```js
  claimPendingBonus,
  getGiftModeSummary,
```

Notas:
- `_request`, `_buildReference`, `_normalizeAmount`, `_moneyResult`,
  `_invalidatePlayer`, `getPlatformConfig`, `claimPendingBonus`, `depositToUser`
  y `logger` ya existen en el archivo; no hay imports nuevos.
- `_moneyResult` ya devuelve `data.wagering` y `duplicate`; no tocar.
- Verificar que `getPlatformConfig` exista (cache 10 min de `GET /config`). Si en
  la gemela no está, es: `GET /config` → `{ success, config }` cacheado.

---

## 2. `src/models/Transaction.js` — tipo nuevo `roulette`

Reemplazar el enum de `type`:

```js
    // 'rakeback' = rakeback semanal VIP (% del apostado); 'vip_levelup' = bono
    // one-time por alcanzar un nivel VIP; 'roulette' = premio de la ruleta diaria
    // (2026-09-07 — antes la ruleta NO escribía Transaction y era invisible en
    // el panel). Ninguno es 'deposit' a propósito: la analítica de
    // publicistas/clientes cuenta cargas reales. En 1girox todos estos regalos
    // van como BONO (ver ARCHITECTURE §4.5); `metadata.creditedAs` guarda cómo
    // salió de verdad ('bonus' | 'deposit' si hubo fallback).
    enum: ['deposit', 'withdrawal', 'bonus', 'refund', 'transfer', 'referral_commission', 'fire_reward', 'rakeback', 'vip_levelup', 'roulette'],
```

(`metadata` ya es `Mixed`; no hay que agregar campos.)

---

## 3. `server.js`

### 3.1 Health: `GET /api/admin/girox/health` — dentro de `out.configuracionPlataforma`

Después de `limitesBonoFijo: ...` agregar:

```js
        limitesBonoFijo: c.bonus ? { min: c.bonus.fixed_min, max: c.bonus.fixed_max } : null,
        // Cómo se acreditan reembolsos/ruleta/rakeback/VIP/referidos (2026-09-07):
        // bono 0 = figuran como BONO en el panel de 1girox; requiere bono suelto
        // habilitado + 0 en multiplicadores; montos fuera de min/max caen a depósito.
        regalosComoBono: girox.getGiftModeSummary(),
        multiplicadoresBono: (c.bonus && c.bonus.multipliers) || null
```

### 3.2 Radiografía de boot `[girox] config:` (bootstrap, al final del archivo)

Cambiar el último tramo del `console.log`:

```js
        `cache jugador=${girox.getPlayerCacheTtlMs()}ms · ` +
        `regalos=${girox.getGiftModeSummary()}`
      );
```

### 3.3 Fueguito — helper nuevo `_creditFireReward` (pegar justo ANTES de `app.get('/api/fire/status', ...)`)

```js
// Premio del fueguito como BONO (2026-09-07, pedido del owner: "todo lo que no
// sea depósito común se carga como BONUS"). Devuelve la misma forma que
// creditUserBalance/depositToUser + `creditedAs` ('bonus'|'deposit') y
// `claimRequired` (true cuando salió como bono con rollover y hay que liberarlo
// desde el casino al completar el objetivo).
//   mult = 0  → creditUserBalance sin multiplier = bono 0 "regalo directo".
//   mult > 0  → /bonus con ese multiplier SI: bono suelto habilitado, mult ∈
//               bonus.multipliers, monto dentro de fixed_min/max y el jugador
//               NO tiene bono activo (bonus_locked + claimable = 0 — otorgar otro
//               lo PISA y le debita el resto, regla "bono sobre bono").
//               Si algo no se cumple → depósito CON multiplier (candado igual,
//               figura como Carga), que es lo que hacía hasta hoy. Un error
//               transitorio del /bonus se devuelve tal cual (el caller restaura
//               el premio y el cliente reintenta con la MISMA reference).
async function _creditFireReward(username, amount, desc, ref, mult) {
  if (!(mult > 0)) {
    return girox.creditUserBalance(username, amount, ref, { description: desc });
  }
  let why = null;
  try {
    const cfg = await girox.getPlatformConfig();
    const b = cfg.success && cfg.config && cfg.config.bonus;
    if (!b || b.enabled === false || b.standalone_enabled === false) why = 'bono suelto deshabilitado en la plataforma';
    else if (Array.isArray(b.multipliers) && b.multipliers.length && !b.multipliers.map(Number).includes(mult)) {
      why = `x${mult} no está entre los multiplicadores de bono (${b.multipliers.join(', ')})`;
    } else {
      const min = Number(b.fixed_min) || 0;
      const max = Number(b.fixed_max) || 0;
      if ((min > 0 && amount < min) || (max > 0 && amount > max)) why = `monto $${amount} fuera de los límites del bono fijo (${min}-${max || '∞'})`;
    }
  } catch (e) { why = `config no disponible (${e.message})`; }
  if (!why) {
    // fresh:true — decisión de plata: no leer el cache corto.
    const info = await girox.getUserInfoByName(username, { fresh: true });
    if (!info) why = 'no se pudo leer el estado del jugador';
    else if ((Number(info.bonusLocked) || 0) + (Number(info.claimableTotal) || 0) > 0) {
      why = `el jugador ya tiene un bono activo (bloqueado $${info.bonusLocked || 0}, a reclamar $${info.claimableTotal || 0}) — otorgar otro lo pisaría`;
    }
  }
  if (!why) {
    const r = await girox.creditUserBalance(username, amount, ref, { multiplier: mult, description: desc });
    if (r && r.success) { r.claimRequired = true; return r; }
    if (r && (r.httpStatus === 422 || r.code === 'feature_disabled' || r.code === 'bonus_out_of_range' || r.code === 'player_not_found')) {
      why = `la plataforma rechazó el bono (${r.code})`;
    } else {
      return r; // transitorio: no cambiar de vía (un timeout puede haber acreditado)
    }
  }
  logger.warn(`[FIRE_REWARD] ${username} $${amount} va por DEPÓSITO con rollover x${mult} (figura como Carga) — ${why}`);
  const r = await girox.depositToUser(username, amount, desc, ref, { multiplier: mult });
  if (r && r.success) r.creditedAs = 'deposit';
  return r;
}
```

`getUserInfoByName(username, {fresh:true})` tiene que devolver `bonusLocked` y
`claimableTotal` (en la gemela ya lo usa el guard del botón Bonificación —
verificar con grep `claimableTotal`).

### 3.4 Fueguito — `POST /api/fire/claim-reward`: usar el helper

Reemplazar:

```js
    const _fireMult = await getFireRolloverMultiplier();
    const bonusResult = await girox.depositToUser(
      username, rewardAmount, rewardDesc, _fireRef,
      _fireMult > 0 ? { multiplier: _fireMult } : null
    );
```

por:

```js
    // Acreditación (2026-09-07): como BONO en 1girox — ver _creditFireReward.
    // Con rollover >0 va por /bonus con ese multiplier (bloqueado hasta apostar
    // multiplier × premio; con claim_required el jugador lo libera tocando el
    // regalito del casino al completar el objetivo). Con rollover 0 es regalo
    // directo (bono 0). Si el jugador YA tiene un bono activo, el bono suelto lo
    // PISARÍA → cae al depósito con multiplier de antes (mismo candado, figura
    // como Carga). La reference es la MISMA en todas las ramas → idempotencia.
    const _fireMult = await getFireRolloverMultiplier();
    const bonusResult = await _creditFireReward(username, rewardAmount, rewardDesc, _fireRef, _fireMult);
```

(Borrar el comentario viejo que decía "NO creditUserBalance con multiplier: esa
rama va por /bonus, que desde la v1.7 queda a reclamar" — quedó stale.)

En el `Transaction.create({ type: 'fire_reward', ... })` del mismo handler agregar
dos campos:

```js
        description: `Fueguito - ${rewardDesc}`,
        transactionId: bonusResult.data?.transfer_id || bonusResult.data?.transferId || null,
        metadata: { source: 'fire_reward', creditedAs: bonusResult.creditedAs || null, rollover: _fireMult },
        timestamp: new Date()
```

Y en el mensaje de éxito (`_rolloverMsg`):

```js
    const _rolloverMsg = _fireMult > 0
      ? ` Para poder RETIRARLOS tenés que apostar $${Math.round(rewardAmount * _fireMult).toLocaleString('es-AR')} (rollover x${_fireMult}). ¡Ya podés jugarlos!` +
        (bonusResult.claimRequired ? ' Cuando completes el objetivo, tocá el regalito 🎁 en el casino para liberarlos.' : '')
      : '';
```

### 3.5 `POST /api/admin/fire-milestones` — validar el rollover contra `bonus.multipliers`

Justo después de `rolloverMultiplier = Math.round(rm * 10) / 10;` y ANTES del
`Config.set('fireRolloverMultiplier', ...)`:

```js
      // Para que el premio figure como BONO en 1girox el rollover tiene que ser un
      // multiplicador de BONO permitido (2026-09-07). Otro valor no rompe (caería a
      // depósito con rollover = "Carga"), pero se rechaza para que el owner lo sepa.
      if (rolloverMultiplier > 0) {
        try {
          const cfg = await girox.getPlatformConfig();
          const allowed = cfg.success && cfg.config && cfg.config.bonus && cfg.config.bonus.multipliers;
          if (Array.isArray(allowed) && allowed.length && !allowed.map(Number).includes(rolloverMultiplier)) {
            return res.status(400).json({
              error: `Para que el premio del fueguito figure como BONO en 1girox, el rollover tiene que ser uno de: ${allowed.join(', ')} (0 = sin rollover).`
            });
          }
        } catch (_) { /* config no disponible: se guarda igual (rango 0-50 ya validado) */ }
      }
```

### 3.6 Ruleta — helper `_recordRouletteTransaction` (pegar justo ANTES de `app.get('/api/roulette/status', ...)`)

```js
// Transaction 'roulette' por premio acreditado (idempotente por spinId: el
// reintento desde el panel no duplica la fila). Nunca hace fallar el flujo.
async function _recordRouletteTransaction(spinId, userId, username, prizeARS, label, txId, credit) {
  try {
    const exists = await Transaction.findOne({ type: 'roulette', 'metadata.spinId': spinId }).select('_id').lean();
    if (exists) return;
    await Transaction.create({
      id: uuidv4(),
      type: 'roulette',
      userId: userId || null,
      username,
      amount: Number(prizeARS) || 0,
      description: `Premio de la ruleta diaria${label ? ` — ${label}` : ''}`,
      transactionId: txId || null,
      metadata: { source: 'roulette', spinId, creditedAs: (credit && credit.creditedAs) || null },
      timestamp: new Date()
    });
  } catch (e) {
    logger.warn(`[ROULETTE] no se pudo registrar la Transaction del spin ${spinId} (${username}): ${e.message}`);
  }
}
```

### 3.7 Ruleta — `POST /api/roulette/spin`: llamar al helper tras marcar `credited`

Después del `DailyRouletteSpin.updateOne({ id: spinDoc.id }, { $set: { status:
'credited', creditTxId: txId, ... } })` y antes del `logger.info('[ROULETTE] ...
acreditado')`:

```js
    // Registro en Transacciones del panel (2026-09-07): antes el premio sólo
    // vivía en DailyRouletteSpin y era invisible en "Transacciones". Tipo propio
    // 'roulette' (NO 'deposit': no es carga real). Fire-and-forget.
    await _recordRouletteTransaction(spinDoc.id, userId, username, prizeARS, pick.label, txId, credit);
```

(`userId`, `username`, `prizeARS`, `pick`, `spinDoc`, `txId`, `credit` ya existen en
ese handler.)

### 3.8 Ruleta — `POST /api/admin/roulette/:id/retry-credit`: ídem

Después del `DailyRouletteSpin.updateOne({ id: spin.id }, { $set: { status:
'credited', ... } })` y antes del `res.json({ success: true, transactionId: txId })`:

```js
    await _recordRouletteTransaction(spin.id, spin.userId, spin.username, spin.prizeARS, spin.prizeLabel || null, txId, credit);
```

### 3.9 `GET /api/admin/transactions` — resumen con los tipos nuevos

Reemplazar el bloque del resumen:

```js
    let deposits = 0, withdrawals = 0, bonuses = 0, refunds = 0, fireRewards = 0, referrals = 0,
      rakebacks = 0, vipLevelups = 0, roulette = 0, totalAll = 0;
    for (const g of sumAgg) {
      totalAll += g.count;
      switch (g._id) {
        case 'deposit': deposits = g.total; break;
        case 'withdrawal': withdrawals = g.total; break;
        case 'bonus': bonuses = g.total; break;
        case 'refund': refunds = g.total; break;
        case 'fire_reward': fireRewards = g.total; break;
        case 'referral_commission': referrals = g.total; break;
        case 'rakeback': rakebacks = g.total; break;
        case 'vip_levelup': vipLevelups = g.total; break;
        case 'roulette': roulette = g.total; break;
      }
    }

    // Saldo neto = depósitos - retiros (bonos y reembolsos no afectan).
    // `gifts` = TODO lo que no es carga ni retiro (lo que en 1girox va como Bono).
    const gifts = bonuses + refunds + fireRewards + referrals + rakebacks + vipLevelups + roulette;
    const summary = {
      deposits,
      withdrawals,
      bonuses,
      refunds,
      fireRewards,
      referrals,
      rakebacks,
      vipLevelups,
      roulette,
      gifts,
      netBalance: deposits - withdrawals,
      totalTransactions: totalAll
    };
```

---

## 4. Panel admin (`public/adminprivado2026/`)

### 4.1 `admin.js` — `getTransactionTypeLabel`

```js
    const labels = {
        deposit: 'Depósito',
        withdrawal: 'Retiro',
        bonus: 'Bonificación',
        fire_reward: '🔥 Fueguito',
        refund: 'Reembolso',
        referral_commission: '🤝 Referido',
        rakeback: '💎 Rakeback VIP',
        vip_levelup: '👑 Nivel VIP',
        roulette: '🎡 Ruleta',
        transfer: 'Transferencia'
    };
```

### 4.2 `admin.js` — `renderTransactionStats`: tarjetas nuevas

Justo después de la tarjeta condicional de Fueguito (`${summary.fireRewards > 0 ?
... : ''}`) y ANTES de la tarjeta "Saldo Neto":

```js
            <div class="stat-card roulette">
                <span style="font-size:1.2rem">🎡</span>
                <span class="stat-number">${formatMoney(summary.roulette || 0)}</span>
                <span class="stat-label">Ruleta</span>
            </div>
            ${summary.rakebacks > 0 ? `
            <div class="stat-card rakeback">
                <span style="font-size:1.2rem">💎</span>
                <span class="stat-number">${formatMoney(summary.rakebacks || 0)}</span>
                <span class="stat-label">Rakeback VIP</span>
            </div>` : ''}
            ${summary.vipLevelups > 0 ? `
            <div class="stat-card vip_levelup">
                <span style="font-size:1.2rem">👑</span>
                <span class="stat-number">${formatMoney(summary.vipLevelups || 0)}</span>
                <span class="stat-label">Bonos de nivel VIP</span>
            </div>` : ''}
            <div class="stat-card gifts" title="Todo lo que NO es carga ni retiro: bonificaciones + reembolsos + fueguito + referidos + rakeback + nivel VIP + ruleta. En 1girox va como BONO.">
                <span style="font-size:1.2rem">🎁</span>
                <span class="stat-number">${formatMoney(summary.gifts || 0)}</span>
                <span class="stat-label">Total regalos (no cargas)</span>
            </div>
```

### 4.3 `index.html` — botones de filtro (sección Transacciones, `.filter-bar`)

Después del botón `Referidos`:

```html
                    <button class="filter-btn" data-filter="roulette" onclick="filterTransactions('roulette')">🎡 Ruleta</button>
                    <button class="filter-btn" data-filter="rakeback" onclick="filterTransactions('rakeback')">💎 Rakeback</button>
                    <button class="filter-btn" data-filter="vip_levelup" onclick="filterTransactions('vip_levelup')">👑 Nivel VIP</button>
```

### 4.4 `admin.css` — badges y tarjetas (después de `.type-badge.referral_commission {...}`)

```css
/* Tipos de regalo agregados a Transacciones (2026-09-07) */
.type-badge.roulette { background: rgba(168, 85, 247, 0.18); color: #c084fc; }
.type-badge.rakeback { background: rgba(56, 189, 248, 0.18); color: #7dd3fc; }
.type-badge.vip_levelup { background: rgba(250, 204, 21, 0.18); color: #fde047; }
.type-badge.fire_reward { background: rgba(249, 115, 22, 0.18); color: #fb923c; }
.stat-card.roulette { border-left: 4px solid #a855f7; }
.stat-card.roulette .stat-number { color: #c084fc; }
.stat-card.rakeback { border-left: 4px solid #38bdf8; }
.stat-card.rakeback .stat-number { color: #7dd3fc; }
.stat-card.vip_levelup { border-left: 4px solid #facc15; }
.stat-card.vip_levelup .stat-number { color: #fde047; }
.stat-card.gifts { border-left: 4px solid #22c55e; }
.stat-card.gifts .stat-number { color: #4ade80; }
```

### 4.5 `public/admin-sw.js` — bump de `CACHE_VERSION` (+1 respecto del que tenga la gemela)

Comentario sugerido: `// vNN: Transacciones con ruleta / rakeback / nivel VIP
(etiquetas, filtros, tarjetas, total regalos)`.

---

## 5. Cosas que NO hay que tocar (verificar que sigan igual)

- `POST /api/admin/deposit` (carga manual), auto-carga hgcash y
  `/api/movements/deposit`: siguen con `depositToUser` = depósito común.
- Devolución de retiro rechazado (`vip-payoutref-*` y `vip-payoutref-chips-*`):
  sigue `depositToUser`. La parte `vip-payoutref-bonus-*` usa `creditUserBalance`
  y pasa sola a bono 0.
- Botón Bonificación (`POST /api/admin/bonus`), welcome code cash y lotes
  (`_creditNotifBatchGift`): siguen pasando `multiplier` explícito → `/bonus`
  estricto, y siguen haciendo `claimPendingBonus` después como hasta ahora.
- Guards bono-sobre-bono existentes: sin cambios (siguen estrictos).
- Analítica de cargas reales (Datos, Datos 2.0, publicistas, "cliente activo"
  de la ruleta): cuentan sólo `type:'deposit'` → no cambia nada.

---

## 6. Validación y docs

1. `node --check` en: `src/services/giroxService.js`, `src/models/Transaction.js`,
   `server.js`, `public/adminprivado2026/admin.js`, `public/admin-sw.js`.
2. Copiar el manual a `docs/PARTNER-APIv1.15.pdf`.
3. **WORKLOG.md**: dos entradas nuevas (regalos como bono 0 con fallback + kill
   switch; auditoría "todo lo que no es depósito = BONUS" con fueguito, ruleta en
   Transacciones y resumen/filtros del panel). Anotar la decisión de dejar la
   devolución de retiro rechazado como depósito.
4. **docs/ARCHITECTURE.md**: §2 (enum de Transaction con `roulette` +
   `metadata.creditedAs`), §4.5 (reescribir el bloque "Bonos a reclamar": ahora
   regalos = bono 0 con precheck/fallback/kill switch; fueguito por `/bonus` con
   rollover y guard; devolución sigue depósito), §4.8 (env `GIROX_GIFT_AS_BONUS`),
   §4.11 (v1.10 IMPLEMENTADO; novedades v1.12–1.15 sin cablear: reglas
   automáticas de bono del agente con `promo_code`/`no_bonus` — ⚠️ un `/deposit`
   sin params HEREDA la campaña de 1er depósito si el agente configura una en su
   panel —, `embed:true` en `/session`, `GET /chip-requests`, whitelist de IPs),
   §5 (ruleta escribe Transaction), §6 (sección Transacciones del panel: tarjetas,
   filtros, `summary.gifts`; tipo nuevo ⇒ etiqueta + botón + case del resumen),
   §9 (trampa "Regalos = bono 0, NO depósito; no llamar depositToUser para un
   regalo").
5. **CLAUDE.md**: reemplazar el gotcha "Bonos a reclamar" por el nuevo "Regalos =
   BONO 0 regalo directo" (resumen de lo de arriba + kill switch + fueguito + ruleta
   escribe Transaction + devolución sigue depósito).
6. Commit y push a `main`.

---

## 7. Qué probar después del deploy (back necesita redeploy; panel, recargar)

- Logs de arranque: `[girox] config: ... regalos=bono 0 (regalo directo, fallback depósito)`.
- `GET /api/admin/girox/health` → `configuracionPlataforma.regalosComoBono` y
  `multiplicadoresBono`.
- Reclamar un reembolso → en el panel de 1girox figura como **Bono** con ref
  `vip-rf-*`, y `wagering.available` del jugador sube (retirable). Un reembolso
  menor a $2 → figura como Carga (fallback) y en logs `[girox] gift(...) va por
  depósito libre: monto ... menor al mínimo`.
- Girar la ruleta con premio → **Bono** en 1girox (`vip-roulette-*`) y fila
  "🎡 Ruleta" en Transacciones del panel; el retry desde el panel no duplica la fila.
- Reclamar un premio de fueguito → **Bono** con rollover en 1girox; si el jugador
  tenía bono activo → Carga con rollover + warn `[FIRE_REWARD] ... va por DEPÓSITO`.
  El mensaje al cliente menciona el regalito del casino al completar el objetivo.
- Config → Fueguito → rollover 3 → rechazado con la lista `0, 2, 5, 10, 20, 40`.
- Transacciones: filtros 🎡/💎/👑 funcionan; tarjetas Ruleta y "Total regalos (no
  cargas)" visibles; badges con color.
- Rollback sin deploy si algo sale mal: env `GIROX_GIFT_AS_BONUS=0` (los regalos
  vuelven a depósito libre; el fueguito con rollover >0 sigue intentando `/bonus`
  porque pasa `multiplier` explícito — si hace falta apagar eso también, poner el
  rollover del fueguito en 0 o revertir el commit).
