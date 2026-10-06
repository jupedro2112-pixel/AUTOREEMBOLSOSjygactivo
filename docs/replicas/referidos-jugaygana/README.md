# Réplica — SISTEMA DE REFERIDOS completo (#168 → #175) para el repo hermano (plataforma 1girox)

Paquete para replicar TODO lo nuevo de referidos de `AUTOREEMBOLSOSjygactivo` (plataforma
**JUGAYGANA**) en el repo hermano que opera sobre **1girox** (`giroxService`) y quedó en el estado
"base" (tiene el sistema viejo de referidos: `referralController`, `referralRoutes`,
`referralCalculationService`, `ReferralCommission/Payout/Event`, el 🤝 en la barra y el código de
referido en el registro — pero nada de lo de abajo).

## ⚠️ OTRA PLATAFORMA — qué se copia tal cual y qué se ADAPTA

El código de este paquete es el real de JUGAYGANA: sirve como referencia línea por línea, pero
**no se pega a ciegas**. La idea general (producto, reglas, pantallas, endpoints, modelos) es la
misma; cambia únicamente DE DÓNDE sale el netwin y cómo se identifica al usuario en la plataforma.

| Pieza | ¿Depende de la plataforma? | Qué hacer en el hermano |
|-------|----------------------------|-------------------------|
| `referralTierService.js`, `referralRate.js`, `ReferralMilestoneClaim.js`, `referralRoutes.js` | No (Mongo puro) | copiar tal cual (revisar los nombres de `metadata.source` en `NON_BANK_SOURCES`) |
| `referralController.js` | No (Mongo puro) | copiar/diffear; la ruta `/admin/activity` y el detalle con cargas son independientes |
| `referralCalculationService.js` | **SÍ**: lee el netwin de `referralRevenueService` (royalty-statistics de JUGAYGANA) | NO reemplazar el del hermano. Portar sólo 2 cambios: (1) la tasa del referidor sale de `referralTierService.resolveReferralRate(user)`; (2) la comisión se calcula sobre el NETWIN (pérdida neta real del referido) que el hermano YA sabe leer de girox, no sobre "owner revenue" |
| `server-02` → `GET /api/referrals/dashboard` y `GET /api/admin/referrals/:userId/netwin` | **SÍ**: `_referralNetwinMonth` usa `referralRevenueService.getUserNetwinForDateRange` + `resolveJugayganaUserId` + `jugaygana.getCurrentMonthToDateRangeArgentinaEpoch` | reescribir `_referralNetwinMonth(u, range)` con la función que el hermano ya usa para el netwin del mes por usuario en girox (la misma de sus reembolsos/comisiones), manteniendo el contrato: devuelve `Number` (netwin del mes, ≥ o < 0) o `null` si no se pudo leer; cache 15 min por usuario; concurrencia 4; tope 60/80 referidos. El rango del mes = mes argentino en curso (00:00 ART del día 1 → ahora). `jugayganaUserId` → el id de girox que guarde el User del hermano |
| `server-01` (requires, `/linkreferido`, % plano, `/api/admin/referral-rate`) | No | copiar |
| Panel (HTML + admin.js) | No | copiar; los textos dicen "JUGAYGANA" en 2 o 3 tooltips → cambiar por girox |
| PWA (HTML, CSS, ui.js, app.js, auth.js, imágenes) | No | copiar; moneda: acá es $ (ARS), en el hermano usar la que corresponda (Gs. si aplica) en `_refMoney` |
| Fix #148 (fechas `epoch_s`) | Sólo JUGAYGANA | NO aplica en girox: ignorar el punto 5 de la prueba |

No copiar NADA que mencione `jugaygana.js`, `jugayganaService`, `royalty-statistics`, `jugayganaUserId`
ni `referralRevenueService` sin reemplazarlo por el equivalente girox que el hermano ya tiene.

**El paquete se regenera solo:** `python3 docs/replicas/referidos-jugaygana/_extract.py` desde la
raíz del repo (extrae el código ACTUAL de JUGAYGANA por marcadores; el encabezado de cada archivo
dice el commit).

## Qué trae (para humanos)

1. **#168 Referidos VISIBLES (cliente):** popup tipo videojuego al abrir la app ("INVITÁ A TUS
   AMIGOS", 1× por apertura, con arte en 2 imágenes), card en el home con barra de progreso e
   INVITAR AHORA, modal de referidos con el LINK (no el código), tiles (activos, comisión del mes,
   pérdida neta, total cargado), tabla MIS REFERIDOS en vivo (netwin del mes por referido leído de
   JUGAYGANA con cache 15 min), link con dominio propio (`PUBLIC_BASE_URL/?ref=CODE` o el host del
   request; `/linkreferido` redirige), registro con el código FIJO si vino por link (30 días en
   localStorage) y el registro se abre solo al entrar por el link.
2. **#169 % plano editable** en COMANDOS (`Config['referralRate']`, default 3%; se carga al
   arrancar y cada 60 s) y reflejado en todos los copys del cliente.
3. **#170 Botón "Invitar a tus amigos":** copia el link y abre un chooser WhatsApp / Telegram /
   otras apps (share nativo) / copiar.
4. **#171 NIVELES de % por referidos activos (anti-estafa):** nada de premios en plata por cantidad
   (se estafaban con cuentas falsas). `referralTierService.resolveReferralRate(user)`: override por
   usuario > niveles (3 activos → 1%, 5 → 2%, 10 → 3%, editable; activo = cargas reales acumuladas ≥
   mínimo) > % plano. Lo usan el cálculo mensual, el dashboard y el controller. **Base de la
   comisión = NETWIN** (`total_ggr`), no "owner revenue". El tablero del cliente muestra "Tu nivel"
   con barra y qué le falta para el siguiente %. `POST /api/referrals/milestones/claim` → 410.
5. **#174 Admin — Actividad y evolución:** `GET /api/referrals/admin/activity?months=N`: cuántos
   referidos hay, con carga, activos, sin cargar; nuevos en 7 y 30 días vs. el período anterior;
   serie diaria; tabla mes a mes; veredicto mejora/estable/baja; por referidor (activos, nivel,
   nuevos 30 d). Card "📈 Actividad y evolución" + columnas nuevas y filtros en la tabla de
   referidores. Sin JUGAYGANA (carga al instante).
6. **#175 Admin — Ranking + netwin por referido:** card "🏆 Mejores referidores" (ordenable por
   activos / netwin generado / comisión / plata cargada / referidos / nuevos 30 d) y, en el detalle
   de un referidor, cada referido con cargas, total cargado, **netwin del mes en vivo**
   (`GET /api/admin/referrals/:userId/netwin`, cache 15 min) y netwin calculado histórico.

## Archivos del paquete (orden de pegado)

| # | Archivo | Va a | Notas |
|---|---------|------|-------|
| 1 | `src-utils-referralRate.js` | `src/utils/referralRate.js` | reemplaza (default 3% + tasa global en memoria) |
| 2 | `src-services-referralTierService.js` | `src/services/referralTierService.js` | nuevo |
| 3 | `src-models-ReferralMilestoneClaim.js` | `src/models/ReferralMilestoneClaim.js` | nuevo (sólo historial; server.js lo requiere) |
| 4 | `src-services-referralCalculationService.js` | `src/services/referralCalculationService.js` | reemplaza: tasa por `resolveReferralRate` + comisión sobre NETWIN. **Diffear contra el del destino** por si allá hay cambios propios |
| 5 | `src-controllers-referralController.js` | `src/controllers/referralController.js` | reemplaza (activity #174, detalle con cargas/netwin #175, link por dominio). **Diffear** |
| 6 | `src-routes-referralRoutes.js` | `src/routes/referralRoutes.js` | reemplaza (ruta `/admin/activity`) |
| 7 | `server-01-requires-y-rate.js` | server.js | requires, `/linkreferido`, carga del % plano, `GET/POST /api/admin/referral-rate` |
| 8 | `server-02-bloque-168-referidos.js` | server.js, DESPUÉS de `const authMiddleware` | dashboard del cliente, niveles, netwin por referido |
| 9 | `panel-index.html.part` | `public/adminprivado2026/index.html` | card del % en COMANDOS + sección Referidos completa |
| 10 | `panel-admin.js.part` | `public/adminprivado2026/admin.js` | bloque completo del panel de referidos + config niveles/% |
| 11 | `pwa-index.html.part` | `public/index.html` | CSS, campo del registro, card del home, popup, modal |
| 12 | `pwa-js.part` | `public/js/ui.js`, `app.js`, `auth.js` | bloque de referidos de ui.js + exports + hooks |
| 13 | `referidos-promo-top.jpg`, `referidos-promo-bottom.jpg` | `public/img/` | arte del popup |

## Dependencias que el código asume (verificar en el destino)

- **server.js (bloque 02):** `User`, `Transaction`, `getConfig/setConfig` (Config), `logger`,
  `authMiddleware`, `adminMiddleware`, `sensitiveLimiter`, `jugaygana.getCurrentMonthToDateRangeArgentinaEpoch()`,
  `referralRevenueService.getUserNetwinForDateRange(username, jgId, from, to, tag)`,
  `resolveJugayganaUserId(userId, username)` (`jugayganaUserLinkService`), `_publicBaseUrlFromRequest(req)`
  (si no existe: usar `PUBLIC_BASE_URL` o `req.protocol + '://' + req.get('host')`),
  `generateReferralCode` (`src/utils/referralCode`), `_periodKey` (`src/utils/periodKey`).
- **Modelo User:** `referralCode`, `referredByUserId`, `referredByCode`, `referredAt`, `referralStatus`,
  `excludedFromReferral`, `referralRateOverride` (el base ya los tiene) y `jugayganaUserId`.
- **Transaction:** cargas reales = `type:'deposit', status:'completed'` con `metadata.source` fuera de
  `referralTierService.NON_BANK_SOURCES` (regalos/bonos/reembolsos). Si el destino usa otros nombres
  de `source` para regalos, ajustar esa lista.
- **Panel:** `API_URL`, `currentToken`, `fmtFechaAR`, `fmtFechaHoraAR`, `showToast`, `formatMoney`, y el
  nav-item `data-section="referrals"` + el switch de secciones.
- **PWA:** `showModal/hideModal`, `VIP.config.API_URL`, `VIP.state.currentToken/currentUser`,
  `VIP.auth.applyRegisterModalMode`, `VIP.campaign.getActive` (atribución de pauta; si no existe,
  tratar como null), el 🤝 de la barra que llama `VIP.ui.openReferralModal()`.
- **Netwin (girox):** la única fuente externa de todo el sistema. Se usa en 3 lugares: el cálculo
  mensual (ya existe en el hermano), `GET /api/referrals/dashboard` (netwin del mes por referido,
  cliente) y `GET /api/admin/referrals/:userId/netwin` (ídem, admin). Los tres tienen que usar LA
  MISMA función del hermano, para que lo que ve el cliente coincida con lo que se le paga.

## Reglas que NO se pueden perder al portar

1. **Nada de premios en plata por cantidad de referidos** (owner 2026-09-29): el premio es el % de
   comisión por nivel. Sin pérdida real de los referidos no hay nada que cobrar.
2. Todo cálculo o copy que muestre o pague comisión usa `resolveReferralRate(user)` (async), nunca
   `getReferralRateForUser` (sync, sólo conoce el % plano).
3. La comisión mensual se calcula sobre NETWIN (`max(0, totalGgr)`); el campo `totalOwnerRevenue`
   conserva el nombre por compatibilidad del ledger de payouts (delta incremental intacto).
4. `/api/referrals/dashboard` consulta la plataforma por referido con cargas (cache 15 min,
   concurrencia 4, tope 60); `/api/referrals/admin/activity` NO consulta la plataforma. No mezclar:
   el ranking del admin usa netwin calculado (ReferralCommission); el netwin en vivo va aparte por
   referidor.
5. TDZ en server.js: rutas nuevas después de `const authMiddleware`. `node --check` no lo detecta.
6. Al tocar HTML + JS de la PWA juntos: bumpear `?v` de los scripts y `CACHE_VERSION` del SW; en el
   panel, `CACHE_VERSION` de `admin-sw.js`.

## Prompt para pegar en el asistente del repo hermano (1girox)

```
Leé WORKLOG.md, docs/ARCHITECTURE.md y CLAUDE.md como siempre. Después leé ENTERO el paquete
de réplica que está en el repo gemelo clonado al lado:

  /home/amnesia/Documents/AUTOREEMBOLSOSjygactivo/docs/replicas/referidos-jugaygana/README.md   ← primero, sobre todo "⚠️ OTRA PLATAFORMA"
  /home/amnesia/Documents/AUTOREEMBOLSOSjygactivo/docs/replicas/referidos-jugaygana/*            ← todos

IMPORTANTE — OTRA PLATAFORMA: el gemelo opera sobre JUGAYGANA (jugaygana.js, royalty-statistics,
jugayganaUserId). ESTE repo opera sobre 1girox (giroxService). El paquete es código real del
gemelo y sirve como referencia exacta de QUÉ hacer, pero todo lo que lea el netwin o identifique al
usuario en la plataforma lo tenés que reescribir con lo que ESTE repo ya usa para eso (la misma
función de netwin que usan los reembolsos/comisiones acá). No copies nada que mencione jugaygana,
royalty-statistics, referralRevenueService ni jugayganaUserId sin reemplazarlo por el equivalente
girox. La tabla "qué se copia tal cual y qué se ADAPTA" del README dice pieza por pieza.

Quiero implementar acá TODO el sistema nuevo de referidos (#168 a #175 del gemelo), con la misma
idea general, pantallas, reglas y endpoints. Seguí el orden de la tabla "Archivos del paquete":

1. Backend independiente de la plataforma: referralRate.js, referralTierService.js (nuevo; revisá
   que su NON_BANK_SOURCES tenga los nombres de metadata.source que acá usan los regalos/bonos),
   ReferralMilestoneClaim.js (nuevo), referralController.js y referralRoutes.js. Los que REEMPLAZAN
   un archivo existente: diffeá antes de pisar y conservá cambios locales (avisame cuáles).
2. referralCalculationService.js de ESTE repo: NO lo reemplaces. Portá sólo dos cosas: la tasa de
   cada referidor sale de referralTierService.resolveReferralRate(user) (override > niveles por
   referidos activos > % plano) y la comisión se calcula sobre el NETWIN real del referido (pérdida
   neta), no sobre "owner revenue". Grabá la tasa usada en ReferralCommission.referralRate como
   siempre.
3. server.js: requires + /linkreferido + carga del % plano al arrancar y cada 60 s + endpoints
   /api/admin/referral-rate (archivo 07). Después el bloque "#168 REFERIDOS" (archivo 08) DESPUÉS
   de `const authMiddleware`, reescribiendo _referralNetwinMonth(u, range) con la función de netwin
   girox de acá (contrato: Number o null si no se pudo leer; cache 15 min por usuario; concurrencia
   4; tope 60 en el dashboard y 80 en el endpoint del admin; rango = mes argentino en curso).
   Verificá la sección "Dependencias": si un helper tiene otro nombre acá, adaptá; no dupliques.
4. Panel admin: card "🤝 Comisión de referidos" en COMANDOS, sección Referidos completa (reemplaza
   la vieja) y el bloque de admin.js con sus llamadas en el switch de secciones y en loadCommands().
   Cambiá los tooltips que digan JUGAYGANA por girox. Mantené los nombres de funciones de los
   onclick inline. Bumpeá CACHE_VERSION de admin-sw.js.
5. PWA: CSS, campo de referido del registro (conservar ids), card del home, popup, modal, las 2
   imágenes en public/img/, el bloque de ui.js + exports, el hook de app.js (?ref= fijo + abre el
   registro solo), los dos hooks de auth.js. Moneda: usá el formato de ESTE repo en _refMoney.
   Bumpeá ?v de los scripts y CACHE_VERSION del SW.

Reglas de ESTE repo que no se negocian: toda ruta nueva app.get/post DESPUÉS de
`const authMiddleware` (TDZ); `node --check` en cada archivo tocado; HTML del panel y de la PWA
balanceados; nada de premios en plata por cantidad de referidos (el premio es el % por nivel;
se estafaban con cuentas falsas); toda comisión y todo copy del % usan resolveReferralRate; el
netwin que ve el cliente en el tablero sale de la MISMA función con la que se le paga. Al
terminar: WORKLOG (entrada nueva con qué se portó y qué se adaptó a girox), docs/ARCHITECTURE.md
(servicio de niveles, endpoints nuevos, flujo del link, trampas), commit y push. Listá al final qué
adaptaste y qué quedó pendiente de probar en vivo.
```

## Prueba en vivo sugerida (después del deploy del destino)

1. Abrir la app logueado → popup "INVITÁ A TUS AMIGOS" con "Cobrá hasta el 3%" → "Invitar" copia el
   link y abre el chooser WhatsApp/Telegram.
2. Abrir el link `/?ref=CODE` en otro celular sin sesión → se abre solo el registro con el código
   fijo (no editable) → registrarse → en el modal de referidos del invitador aparece el nuevo.
3. El referido carga ≥ el mínimo → en el modal del invitador sube "activos" y la barra del nivel.
4. Panel → COMANDOS → cambiar el % plano y los niveles → el popup y el modal del cliente lo reflejan.
5. Panel → Referidos: card de actividad con números, ranking ordenable, "Ver referidos" muestra
   cargas por referido y el netwin del mes se rellena en unos segundos.
6. Preview del cálculo mensual: la tasa de cada referidor coincide con su nivel y la comisión es
   % × netwin (el mismo número que el cliente vio en su tablero).
