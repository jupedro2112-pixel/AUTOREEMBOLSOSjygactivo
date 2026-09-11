# Réplica #155 — Bandeja del banco en tiempo real · carga manual anclada · bajadas · cierre diario

Paquete para replicar en el repo hermano (`PAUTANUEVAsantino`, plataforma **girox**) lo que se
hizo en `AUTOREEMBOLSOSjygactivo` (plataforma **JUGAYGANA**) en la sesión 2026-09-11
(WORKLOG #155, commits `21d1679` código + `221bd3d` docs).

Archivos de este paquete:
- `2026-09-11-banco-bandeja-bajadas-cierre.patch` — diff EXACTO de los dos commits (2.700 líneas).
  Verificado con `git apply --check --reverse` sobre nuestro HEAD. **NO aplica limpio sobre el
  hermano** (el server.js es distinto): sirve como referencia línea por línea para portar.
- Este README — el prompt para el asistente del otro repo (copiar y pegar) + adaptaciones.

## Qué hace (resumen para humanos)

1. **Bandeja del banco** (panel → 🏦 Banco): todas las transferencias de hgcash en vivo (socket),
   con estado. Las que no matchearon por foto se **asignan** a un usuario desde el panel y se
   acreditan por el MISMO camino que la carga automática (mismo candado por coelsa, mismos bonos).
   También: vincular a una carga manual ya hecha, "no corresponde" (admin, con motivo), reabrir.
2. **Carga manual anclada**: el modal Depositar pregunta "¿de dónde viene la plata?" y guarda el
   vínculo con la transferencia (monto exacto, claim atómico antes de acreditar) o el origen
   declarado (otro banco / sin transferencia).
3. **Retro-vínculo por titular**: una carga manual sin movimiento elegido consume la transferencia
   pendiente del mismo monto cuyo titular coincide con el comprobante del cliente (6 h).
4. **Bajadas**: cash-out de hgcash a un CBU externo (financiera), solo admin general / pagos,
   destinos guardados, Telegram, registro permanente (BankSweep).
5. **Cierre diario** (00:05 ART, Telegram): banco↔sistema, cajero de la plataforma↔sistema,
   errores (pago sin descuento, pago sin movimiento, ambiguos sin resolver). Diffs resolubles
   con nota desde el panel; arrastre de días anteriores.

## Prompt para pegar en el asistente del repo hermano

```
Leé WORKLOG.md, docs/ARCHITECTURE.md y CLAUDE.md como siempre. Después leé ENTERO el paquete
de réplica que está en el repo gemelo clonado al lado:

  ~/Documents/AUTOREEMBOLSOSjygactivo/docs/replicas/README-2026-09-11-banco.md
  ~/Documents/AUTOREEMBOLSOSjygactivo/docs/replicas/2026-09-11-banco-bandeja-bajadas-cierre.patch

y también el código final de referencia (es el mismo producto, otra plataforma):
  ~/Documents/AUTOREEMBOLSOSjygactivo/src/services/bankCloseService.js
  ~/Documents/AUTOREEMBOLSOSjygactivo/src/models/{BankSweep,DailyClose,CashierSnapshot}.js
  ~/Documents/AUTOREEMBOLSOSjygactivo/server.js  (buscá "#155" — bloque "BANDEJA DEL BANCO",
      hgcashAutoCarga con `assign`, hgcashConsumeOnManualDeposit, /api/admin/deposit anclado,
      webhook con outKind y _emitHgcashUpdate(kind, movementId))
  ~/Documents/AUTOREEMBOLSOSjygactivo/public/adminprivado2026/{index.html,admin.js}  (buscá "#155")

Quiero EXACTAMENTE la misma funcionalidad acá, prolija e igual: sección "🏦 Banco" en el panel
con bandeja en TIEMPO REAL (socket, sin recargar), asignar/vincular/no corresponde/reabrir,
carga manual anclada con el bloque "¿De dónde viene la plata?" en el modal Depositar,
retro-vínculo por titular en hgcashConsumeOnManualDeposit, bajadas (BankSweep, destinos
guardados, solo admin|withdrawer, Telegram), y el cierre diario (bankCloseService + cron
00:05 ART + Telegram + panel con diffs resolubles). Mismos nombres de modelos, campos,
endpoints, eventos de socket y funciones del panel que en el gemelo, para que las dos bases
queden iguales y los próximos parches se puedan portar 1:1.

REGLAS para portarlo a ESTE repo (girox ≠ JUGAYGANA):
1. La acreditación asignada va SIEMPRE por nuestro hgcashAutoCarga (con `assign`), que acá
   además tiene: reference idempotente `_ref` (vip-hg-<coelsa|movementId>), ruleta de
   bienvenida/diaria %, bono de primera carga, lote automático y anti-multicuenta #259. Con
   `assign` se conserva TODO eso (es "la misma carga automática, elegida por un agente"). El
   comprobante pasa a ser OPCIONAL: definir `compId` y guardar cada Comprobante.updateOne con
   `if (compId)`. La función tiene que devolver { ok, reason|txId }.
2. Cruce 2 del cierre (cajero de la plataforma): en el gemelo se alimenta con `parent_balance`
   que devuelve JUGAYGANA en cada operación. Revisá giroxService: si la Partner API devuelve el
   saldo del AGENTE/cajero en las respuestas de plata o tiene un endpoint de balance del
   agente, implementá el hook `setCashierBalanceHook` igual (CashierSnapshot con opAmount con
   signo). Si NO existe esa info, dejá el cruce en `sin_datos` (el cierre sigue funcionando con
   los cruces 1 y 3) y anotalo en el WORKLOG como pendiente.
3. Nada de rutas nuevas antes del `const authMiddleware` (TDZ): el bloque va justo antes de
   "PAGOS AUTOMÁTICOS (retiros)", como en el gemelo. Reusar resolveHgcashAccountId,
   hgcashPay.createCashOut/lookupAlias/getAccounts/getTransactionStatus, telegramAlert,
   _artDateKey/_artHour/_artDayRange, _amountsEqual, _nameMatch, _statusAccredited,
   _bankIdentityOr/_bankFromKey (#259/#152) y notifyAdmins. Si alguno no existe acá, portarlo.
4. Webhook hgcash: clasificar salientes por externalID (`sweep-<id>` → bajada; otro → pago),
   emitir `bank_movement` con el documento (sin `raw`) en cada alta Y en cada reentrega, y
   desviar `TRANSACTION_REQUEST` de `sweep-…` a `_handleSweepStatusWebhook`. Fan-out y guard
   anti-bucle #117 quedan como están.
5. Panel: nav `nav-item-bank` (admin|depositor|withdrawer, badge de pendientes), sección
   `bankSection` con las mismas tabs, modales `bankAssignModal`/`bankSweepModal`/
   `bankSweepDestModal`, bloque `depositOriginGroup` en el modal Depositar, listeners de socket
   `bank_movement`/`hgcash_movement`/`bank_close`, y las mismas funciones globales
   (bankSetTab, loadBankTray, openBankAssign, bankAssignConfirm, bankLink, bankResolve,
   bankReopen, openSweepModal, submitSweep, openBankClose, bankCloseResolve, getDepositOrigin…).
   Bumpear CACHE_VERSION del admin-sw. NO hace falta bump de ?v de la PWA (no se toca).
6. Modelo BankMovement: agregar chargeSource, transactionId (index), assignedBy/At,
   resolution/resolutionNote/resolvedBy/At, outKind, payoutId, sweepId e índice
   {direction, matchStatus, createdAt}. Sin migración (campos nuevos con default null).
7. Al terminar: `node --check` en todo lo tocado, scan TDZ (ninguna app.* con middleware antes
   de su const), divs/sections balanceados e ids únicos en el index.html del panel, y actualizá
   WORKLOG.md (entrada nueva numerada, con qué se probó y qué falta probar), docs/ARCHITECTURE.md
   y CLAUDE.md (gotcha: una transferencia = una acreditación; la asignada va por
   hgcashAutoCarga({assign})). Commit y push a main.
```

## Checklist post-deploy (mismo que en el gemelo)

1. Llega una transferencia sin foto → aparece en 🏦 Banco → Pendientes al instante (sin F5) →
   Asignar a un usuario → se acredita, la fila pasa a verde y desaparece de Pendientes.
2. Depositar a mano con una transferencia pendiente del mismo monto → viene preseleccionada →
   queda "manual anclada" y NO se auto-carga cuando después llega la foto.
3. Bajada chica a un destino guardado → Telegram "🏦 BAJADA" + fila en Bajadas + movimiento
   saliente marcado "Bajada" en la bandeja.
4. 🧾 Cierre → Recalcular hoy → tiles y diffs; a las 00:05 ART llega el cierre a Telegram.
5. Resolver un diff con nota → queda ✅ con tu usuario; el cierre pasa a "0 diferencias".
