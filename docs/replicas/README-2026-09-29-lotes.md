# Réplica #172 + #173 — Lotes con regalo: tope del % · bono canjeado vence a las 24 h · resumen por lote

Paquete para replicar en el repo hermano (plataforma **1girox**, cliente `src/services/giroxService.js`)
lo que se hizo en `AUTOREEMBOLSOSjygactivo` (plataforma **JUGAYGANA**) el 2026-09-29
(WORKLOG #172 commit `7077ec9`, #173 commit `8329e50`).

Archivos de este paquete:
- `2026-09-29-lotes-tope-24h-resumen.patch` — diff EXACTO de los dos commits (solo código:
  server.js, src/models/NotifBatch.js, panel admin). **NO aplica limpio sobre el hermano** (el
  server.js es distinto): sirve como referencia línea por línea para portar.
- Este README — el prompt para el asistente del otro repo (copiar y pegar) + adaptaciones.

## Qué hace (resumen para humanos)

1. **Tope del % de lote (#172).** Un lote "% automático" de 100% con una carga de $10.000 daba
   $10.000 de bono. Ahora respeta el MISMO tope del bono de instalar la app: el % del lote aplica
   hasta el tope ($5.000 acá; en el hermano es $20.000 según su WORKLOG #210) y el excedente de la
   carga se bonifica al % menor (20%), nunca más que el % del lote. 100% y $10.000 → $6.000;
   50% y $10.000 → $3.500; 20% → 20% de todo. Editable donde ya se edita el tope del bono app.
   La nota interna al agente, el texto del regalo al cliente y el cartel del panel dicen
   "(100% hasta $5.000, el resto al 20%)".
2. **Franja horaria con minuto final inclusive (#172).** "de 18:50 a 18:52" vale durante todo el
   minuto 18:52 (antes cortaba al empezar).
3. **Mensaje claro al canjear un código ajeno (#172).** Si el usuario NO está en la lista del lote:
   "Este código no es para tu cuenta: el lote se envió a otros usuarios" (antes: "código no válido").
4. **El bono canjeado vence a las 24 h (#173).** `NotifBatch.useHours` (default 24, 1–168, campo
   nuevo en el formulario, solo con código + %). Al canjear, el PromoBonus vence a
   `canje + useHours` en vez de "hasta que venza el lote" (que puede ser 7 días). El mensaje de
   canje dice "Válido hasta" con la fecha real del bono; la notificación del código aclara
   "una vez canjeado tenés Xhs para usarlo". Modo "por tiempo" no cambia.
5. **Resumen por lote (#173).** La fila del lote muestra "N cargaron ($X regalados) · N activos ·
   N vencidos sin usar · ⏱ 24hs para usar" y "Ver lote" arranca con el resumen (canjearon /
   cargaron con el bono / activos / vencidos / cancelados) y cada destinatario dice "canjeó
   dd/mm hh:mm · cargó con el bono dd/mm hh:mm · carga $X · bono $Y · lo aplicó Z", o "activo ·
   vence …", o "venció sin usar (…)", o "cancelado o reemplazado por otro bono".

## Prompt para pegar en el asistente del repo hermano

```
Leé WORKLOG.md, docs/ARCHITECTURE.md y CLAUDE.md como siempre. Después leé ENTERO el paquete
de réplica que está en el repo gemelo clonado al lado:

  ~/Documents/AUTOREEMBOLSOSjygactivo/docs/replicas/README-2026-09-29-lotes.md
  ~/Documents/AUTOREEMBOLSOSjygactivo/docs/replicas/2026-09-29-lotes-tope-24h-resumen.patch

y el código final de referencia (mismo producto, otra plataforma):
  ~/Documents/AUTOREEMBOLSOSjygactivo/server.js  (buscá "#172" y "#173": _loteBonusAmount,
      _loteCapTxt, _hgcashAppBonusCfgCache, _inDailyWindow, _activateBatchPromoBonus,
      _tryClaimNotifBatchCode, GET /api/admin/notif-batches y /:id, POST /api/admin/notif-batches)
  ~/Documents/AUTOREEMBOLSOSjygactivo/src/models/NotifBatch.js  (useHours)
  ~/Documents/AUTOREEMBOLSOSjygactivo/public/adminprivado2026/{index.html,admin.js}  (buscá "#173")

IMPORTANTE — OTRA PLATAFORMA: el gemelo opera sobre JUGAYGANA (jugaygana.js). ESTE repo opera
sobre 1girox (giroxService). No copiar nada que mencione JUGAYGANA, jugaygana.js, creditUserBalance
de jugaygana ni parent_balance: la acreditación del bono de lote acá va por el mismo camino que ya
usa este repo para el % automático (girox.depositToUser / bono con reference idempotente y
rollover propio del lote). Solo cambia CUÁNTO se acredita (tope) y CUÁNDO vence el bono.

Quiero EXACTAMENTE la misma funcionalidad acá:

1. TOPE DEL % DE LOTE. Helper `_loteBonusAmount(amount, pct, cfg)` =
   min(carga, tope) × pct% + max(0, carga − tope) × min(pct, pctExcedente)%, redondeado. `cfg` es
   la MISMA config del bono por instalar la app que ya tiene este repo (tope $20.000 / excedente
   20% según su WORKLOG #210 — usar los nombres de campos que existan acá, no inventar otros;
   tope 0 = sin tope). Usarlo en los DOS lugares donde hoy se calcula `amount × pct / 100` del
   lote automático: carga manual (claimAutoPromoPercent con usedBy = agente) y carga hgcash
   (usedBy 'auto-hgcash'). Helper `_loteCapTxt(pct, cfg)` → " (100% hasta $20.000, el resto al
   20%)" o '' si el tope no afecta (pct ≤ pctExcedente o tope 0). Ponerlo en: la nota interna
   "⚡ BONO DE LOTE AUTOMÁTICO aplicado…", el texto del regalo al cliente (`_giftLabelOf`, solo
   applyMode 'auto') y el cartel del panel (campo `capTxt` en GET /api/admin/promo-bonus, mostrado
   junto al "+X%" tanto en el cartel automático como en el verde). Cachear la última config leída
   en una variable de módulo para los textos sync. El % en modo AGENTE no se toca (el agente
   escribe el bonus a mano).
2. `_inDailyWindow`: el minuto HASTA es inclusive (`m <= toMin` en las dos ramas).
3. `_tryClaimNotifBatchCode`: cuando el lote tiene lista y el usuario no está, responder
   "Este código no es para tu cuenta: el lote se envió a otros usuarios."
4. `NotifBatch.useHours` { Number, default 24, min 1 }. POST /api/admin/notif-batches: leer
   `b.useHours` (default 24; 1–168 o 400), guardarlo en el batch público y en el de lista.
   `_activateBatchPromoBonus`: `expiresAt = batch.mode === 'code' ? ahora + useHours h :
   batch.expiresAt`. En el canje, "Válido hasta" con `pb.expiresAt` (no `batch.expiresAt`). En la
   notificación del código con %, agregar "y, una vez canjeado, tenés Xhs para usarlo en tu carga".
5. GET /api/admin/notif-batches: proyectar `useHours` y sumar por lote (aggregate de PromoBonus
   por `sourceRuleCode:'lote', sourceRuleId ∈ ids`) `usados` (status used o usesCount>0),
   `activos` (active, no vencido, usesCount 0), `vencidos` (sin uso y expired o expiresAt ≤ ahora)
   y `bonoTotal` (Σ usesTotalBonus). GET /api/admin/notif-batches/:id: primero
   `PromoBonus.updateMany({sourceRuleId: batch.id, status:'active', expiresAt ≤ ahora} → expired)`;
   por destinatario devolver además `outcome` (used | active | expired | cancelled — cancelled =
   expired con expiresAt > ahora, o sea reemplazado/cancelado), `bonusExpiresAt`, `cargaMonto`;
   y un `summary` { total, canjearon, usaron, activos, vencidos, cancelados, bonoTotal }.
6. Panel: input `giftBatchUseHours` ("⏱ Horas para usarlo tras canjear", default 24) dentro del
   bloque de código, visible solo con modo código + regalo %, enviado como `useHours`; la fila del
   lote (solo giftType percent) agrega "N cargaron ($X) · N activos · N vencidos sin usar · ⏱ Nhs
   para usar"; "Ver lote" arranca con el resumen y cada fila usa `outcome` con los textos del
   README (canjeó … / cargó con el bono … / activo · vence … / venció sin usar / cancelado).
   Bumpear CACHE_VERSION del admin-sw. NO hace falta bump de la PWA.
7. Al terminar: `node --check` en todo lo tocado, scan TDZ (ninguna app.* con middleware antes de
   su const), y actualizá WORKLOG.md (entrada nueva numerada con qué se probó y qué falta
   probar), docs/ARCHITECTURE.md y CLAUDE.md si aplica. Commit y push a main.
```

## Checklist post-deploy

1. Lote % automático 100%, carga de $30.000 con el tope de $20.000 → bono $22.000 (20.000 al 100% +
   10.000 al 20%); la nota interna y el cartel dicen "(100% hasta $20.000, el resto al 20%)".
2. Lote con código + %, "horas para usarlo" = 1 → canjear → el chat dice "Válido hasta" una hora
   después; sin cargar, a la hora "Ver lote" lo marca "venció sin usar".
3. Canjear y cargar → la fila del lote suma "1 cargaron ($X)" y el detalle dice "cargó con el bono".
4. Franja 18:50–18:52 → una carga a las 18:52:30 aplica el bono.
5. Canjear con una cuenta que no está en la lista → "Este código no es para tu cuenta…".
