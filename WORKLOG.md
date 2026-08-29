# WORKLOG — Estado vivo del proyecto

> Se actualiza tras cada cambio significativo (ver regla en `CLAUDE.md`). El detalle
> commit por commit está en `git log --oneline`. Esto captura decisiones, umbrales de
> negocio y pendientes que NO se ven leyendo el código.
>
> **Última actualización: 2026-08-27**

## Sesión 2026-08-27

> **Deploy a EB hecho por el owner el 2026-08-27 (noche)** con #124–#131 incluidos. **#132 (auditoría) quedó DESPUÉS de ese deploy → pendiente de deploy.**
> Verificado desde afuera: `/api/health` ok, `manifest.json` ya dice AUTOREEMBOLSOS,
> `<title>` nuevo servido. Lo que falta probar (en el panel, con datos reales) está
> marcado como **PROBAR** en cada entrada.

### 148. 🔴 REEMBOLSO DIARIO calculado sobre el día equivocado: JUGAYGANA corta a las 21:00 ART — diagnóstico con logs + formato de fecha configurable desde el panel
- **Reporte del owner:** argenCesar1691, reembolso diario del 28/08: la app
  tomó NETWIN $4.145,85 (10% = $415) y el panel de JUGAYGANA ("Reportes
  globales → AYER, solo saldo real") muestra NETWIN $24.513 (10% = $2.451).
- **Causa (probada con los logs log8/log9, 20→29/08, 92.611 líneas
  `[REFUND] status`):** la app arma bien el día argentino (00:00–23:59 ART)
  pero `formatRevenueDate` (formato "iso") manda `YYYY-MM-DD` **en UTC**:
  `date_from=2026-08-28`, `date_to=2026-08-29`. JUGAYGANA interpreta esas
  fechas como **medianoche UTC con fin exclusivo** → ventana real =
  [27/08 21:00, 28/08 21:00 ART): **deja afuera 21:00–24:00 ART** (el pico
  nocturno) y mete las 21–24 del día anterior. **Evidencia:** en 1.151
  cambios de día (00:00 ART) el "mes en curso" salta ≥$500 en el 54% de los
  usuarios en el mismo minuto (suma $11,3M) — no es juego, es la ventana que
  se corre 24 h cuando cambia el string de `date_to`; argenCesar1691: mes en
  curso 275.513 a las 23:32 ART → 292.312 a las 00:01 ART (+16.800 en un
  minuto = su juego de 21–24 hs, justo lo que faltó en el diario). Afecta
  también semanal/mensual/rango (3 h corridas en cada borde).
- **Por qué no se toca a ciegas:** no sé qué formatos con hora acepta la API
  (si mando algo que no entiende, TODOS los reembolsos dan $0). Fix en 2 pasos:
  1. `referralRevenueService`: formato dinámico (`setDateFormat/getDateFormat`,
     override en runtime > env > "iso"); formatos nuevos `datetime_art`
     ("YYYY-MM-DD HH:mm:ss" ART), `datetime_utc`, `iso_art` además de
     `epoch_s/ms`; `diagnoseDateFormats()` consulta el MISMO día con los 6
     formatos y devuelve NETWIN/apuestas/ganancias lado a lado.
  2. Panel → 🔐 Config privada → card "📅 Reembolsos — formato de fecha":
     diagnóstico (usuario + día ART → tabla por formato; comparar con el panel
     de JUGAYGANA) y selector "Formato activo" guardado en
     `Config['refundsconfig'].revenueDateFormat` (aplica al instante, vacía el
     cache de status; sin SSM). Endpoints `POST /api/admin/private-config/
     refunds` y `…/refunds/diagnose`.
- **Cómo cerrar el tema (owner):** correr el diagnóstico con argenCesar1691 y
  2026-08-28 → el formato cuyo NETWIN dé ≈ $24.513 es el correcto →
  guardarlo. Después, los diarios ya reclamados con el día corrido quedaron
  pagados de menos (o de más) — decisión del owner si se compensan a mano.
- **Validado:** `node --check` OK. admin-sw v33 → v34. Redeploy.

### 147. Aprendizaje diario: a las 00:01 ART procesa el DÍA ANTERIOR COMPLETO, sin tope chico
- **Owner:** "¿por qué una hora y 24 h hacia atrás? que a las 00:01 pase lo del
  día anterior, con la misma info de las auditorías". Cambios en
  `_runAuditLearn`: rango = día ART completo (`_artDayRange`, UTC-3 fijo);
  daily → ayer, manual → hoy hasta ahora (si no hay nada, ayer); default
  `learnHourART` 0 (tick cada 5 min → corre entre 00:00 y 00:05), tope
  `learnMaxChats` 300 (antes 20); se procesa en **tandas de 15 chats por
  llamada** acumulando propuestas/dudas con dedupe (entre tandas, contra
  pendientes y contra el doc); cada propuesta lleva `dayKey`. Telegram y log
  dicen de qué día es. admin-sw v32 → v33. Redeploy.
- Costo estimado: 100-200 chats buenos/día × ~5k tokens ≈ US$2-4/día con sonnet-5.

### 146. "📚 Contexto aprendido": la IA aprende sola CÓMO ES el negocio de los chats bien evaluados, propone al final del día, pregunta si duda, y vos confirmás
- **Pedido del owner:** que la IA vaya armando sola la base de "cómo funciona
  el negocio en general" viendo los chats con mejor puntaje; al final del día
  un análisis con lo que va a cargar, a confirmar; si ya sabe todo que diga
  que no hay nada; y si ve algo nuevo que dude, **que pregunte antes** ("ya
  veo que empieza a aprender de cosas que no están bien"). Las reglas de
  juicio/antifraude (rollover, 30 min) las sigue enseñando el owner.
- **Dos fuentes nuevas de conocimiento, separadas de las reglas:**
  1. **Hechos del sistema** (`_systemFactsForAi`, cache 10 min, leído de la
     config: CBU/alias, hgcash auto/mínimo, retiros mín. $4.999 y flujo,
     rangos de reembolso, fueguito/ruleta/bono app, mensajes `/sys_*` activos
     y comandos de agentes). Bloque "ASÍ FUNCIONA ESTA SALA HOY" en cada
     auditoría. Cero carga del owner, siempre verdad.
  2. **Contexto aprendido** (`Config['auditlearned'].doc`): bloque "CONTEXTO
     DEL NEGOCIO… usalo para entender, NO como reglas". Lo alimenta el
     aprendizaje diario, solo con confirmación.
- **Aprendizaje diario (`_runAuditLearn`; cron cada 10 min que dispara a
  `learnHourART` (5) una vez por día ART, marca `auditlearnlast`):** toma
  hasta `learnMaxChats` (20) auditorías IA con puntaje ≥ `learnMinScore` (8),
  no falsos positivos, últimas 24 h; reconstruye cada charla; llama
  `chatAuditAi.learnFromChats` (prompt: DESCRIBIR, nunca juzgar; si parece
  política/práctica dudosa → pregunta; máx 6 propuestas + 4 dudas; "nada
  nuevo" es válido). Guarda en `Config['auditproposals']` (dedupe vs
  pendientes y vs doc) y avisa por Telegram ("N propuestas y M dudas" o "no
  hay nada nuevo"). Log en `auditlearnlog`.
- **Panel (Config privada → Auditoría → card 📚):** toggle/hora/umbral/máx;
  "Analizar ahora"; pendientes: propuestas (editables) con ✅ Confirmar → se
  agrega al doc / ❌ No; dudas con campo de respuesta → pasa por el
  destilador (#145, ahora con `tipo` regla|contexto): si es criterio → va a
  **Reglas del negocio**; si es descripción → al doc. Doc editable a mano;
  vista de los hechos del sistema. Endpoints
  `POST /api/admin/private-config/audit/learned[/doc|/run|/:id]`.
- **Guardas:** solo chats ≥8 (los malos no entran), descriptivo (no
  normativo), nada entra sin confirmación, dudas antes que suposiciones.
- **Validado:** `node --check` OK en todo; HTML balanceado; rutas después de
  `authMiddleware` (scan 0). **admin-sw v31 → v32.** Redeploy.
- **Futuro (owner):** IA que responda el 70% y humanos el 30%. Esta base
  (hechos + contexto + reglas + auditoría) es el cimiento de eso.

### 145. "🧠 Enseñarle a la IA": reporte + corrección → regla general integrada en la base (con vista previa)
- **Pedido del owner:** poder pegar el aviso que mandó la IA a Telegram, escribir
  la corrección con ese mensaje como referencia, y que eso se sume a la base de
  la IA "como contexto bien, no literal", sin que quede un choclo random.
- **Cómo funciona:** card en Config privada → Auditoría. (1) pega el reporte,
  (2) escribe la corrección en sus palabras, (3) "Generar regla" →
  `POST /api/admin/private-config/audit/teach` → `chatAuditAi.distillRule`
  (IA editora, effort medium, salida estructurada): devuelve UNA regla general
  ("Cuando X, lo correcto es Y / NO es Z", sin nombres ni puntajes) y la
  acción: `agregar`, `reemplazar` (índice de la regla equivalente, versión
  combinada) o `sin_cambio`. El panel muestra explicación + regla editable +
  qué reemplaza. (4) "Agregar a la base" → `…/teach/apply` guarda
  `extraRules` completo (una regla por línea "- …"), recarga la config en
  runtime y anota en `Config['auditteachlog']` (últimas 200: fecha, quién,
  reporte, corrección, regla) para saber de dónde salió cada regla.
- Helpers `parseRules`/`joinRules` normalizan la base (guiones, numeración).
  La base sigue siendo el mismo cuadro "Reglas del negocio" (editable a mano).
- **Validado:** `node --check` OK; HTML balanceado, ids únicos. **admin-sw
  v30 → v31.** Redeploy.

### 144. Config privada: "Guardar auditoría no hace nada" → rate limit compartido (10/15 min) + toast de 3 s; ahora limiter propio (60/15 min) y estado visible
- **Reporte del owner:** escribe reglas del negocio, toca "Guardar auditoría"
  y "no hace nada, no guarda". Descartado: JS viejo (prod sirve admin-sw v29,
  actual) y toast fuera de pantalla (es `position:fixed` abajo-derecha).
  Causa más probable: los 6 endpoints de `/api/admin/private-config/*` usaban
  `sensitiveLimiter` (10 requests / 15 min por IP, pensado para OTP);
  desbloquear + guardar IA + guardar auditoría + probar Telegram + reintentos
  lo agotan en minutos → 429 "Demasiados intentos" en un toast de 3 s que
  pasa desapercibido.
- **Fix:** `privateConfigLimiter` (60/15 min, store Redis `private-config`,
  mensaje explícito) en los 6 endpoints. Panel: `_pcStatus` pinta un estado
  PERSISTENTE al lado del botón ("✅ Guardado 21:17" / "❌ <error>"), en IA y
  en Auditoría; `_pcReadJson` tolera respuestas no-JSON (429/502) y muestra
  el HTTP; errores de JS también se muestran. **admin-sw v29 → v30.**
- Redeploy (back + panel).

### 143. Regla "mensaje repetido" no salta con "Gracias" + modal Mis Referidos con "¿Cómo funciona?" en 3 pasos
- **(1) Falso positivo (captura del owner):** "Gracias" tras una carga disparó
  "ALERTA DE ATENCIÓN (mensaje repetido)". Causa: el contador por cliente
  sumaba repeticiones dentro de 15 min sin importar si entre medio ya le
  habían respondido (ej. "Gracias" después de cada carga), y no filtraba
  cortesías. Fix en `_auditRulesOnUserMessage`: no cuentan mensajes < 8
  caracteres ni cortesías (gracias/ok/dale/listo/hola/…); y si hubo un
  mensaje no-usuario (agente o sistema) desde la repetición anterior, el
  contador arranca de nuevo (`Message.exists`, solo cuando hay match).
- **(2) Referidos:** el owner quiere el copy del otro proyecto (1girox).
  `index.html`: subtítulo "Invitá amigos y cobrá todos los meses el 7%…",
  bloque "💡 ¿Cómo funciona? Así de simple" con 3 pasos + nota 📌 con
  ejemplo ($100.000 → $7.000), ARRIBA del código; se quitó el microcopy
  viejo. El % es dinámico: `/api/referrals/me` devuelve `referralRate`
  (`getReferralRateForUser`, default 0.07, respeta override) y `ui.js` lo
  pinta en `.referralRatePct` / `.referralRateExample`. En este proyecto es
  **7%** (en 1girox 8%: viene de `DEFAULT_REFERRAL_RATE`).
- HTML + JS juntos → **`?v=58` + `CACHE_VERSION='v58'`**. Back necesita
  redeploy (controller + regla).

### 142. Registro: el campo Usuario arranca vacío (antes precargaba "VIP")
- Pedido del owner: "cambiar el VIP por default y dejarlo vacío, para que sean
  libres en elegir". `index.html` (`value=""`, placeholder "Elegí tu
  usuario") + `auth.js` (se quitó el prefill). No hay validación de prefijo
  en el server (los equipos se resuelven por prefijo pero no es obligatorio).
- HTML + JS juntos → **`?v=57` + `CACHE_VERSION='v57'`** (regla #97).
  Solo estáticos → deploy y listo (el server los sirve cacheados por proceso,
  así que igual hace falta el redeploy).

### 141. 👎 sin motivo → la IA lee la última charla y explica el porqué (o dice que no hay motivo)
- **Pedido del owner:** si el cliente pone 👎 y no escribe motivo, que se
  investigue la charla y se dé el contexto; si no hay motivo, que lo diga.
- **Fix (`POST /api/chat/rating`):** con motivo → Telegram al instante (igual
  que antes). Sin motivo → a los 3 min, si sigue sin motivo,
  `_auditConversation(userId,'rating_down',{force,noAlert,hint})` relee la
  ÚLTIMA charla (aunque ya estuviera auditada) con la instrucción de explicar
  qué pudo molestar o decir textualmente "No encuentro en la charla un motivo
  claro para la mala calificación". El resumen va al Telegram ("🤖 Sin motivo
  del cliente — lo que vio la IA (N/10, banderas): …"), a una nota interna en
  el chat y a `ChatRating.aiContext/aiScore` (se muestra en Auditoría →
  Calificaciones negativas). `noAlert` evita un segundo Telegram por la
  auditoría en sí. `auditTranscript` acepta `hint`.
- **Validado:** `node --check` OK. Redeploy.

### 140. Fueguito = igual que reembolso: no abre el chat, no arranca demora, no se audita
- **Telegram 03:05 (owner):** dos alertas SIN RESPUESTA por "🔥 Día 1 de racha
  Fueguito!" — mensaje que la app manda sola en nombre del cliente.
- **Fix:** `_isAutoClientNotice(content)` = reembolso reclamado + los 4
  formatos de fueguito de `fire.js` ("🔥 Día N de racha Fueguito!", "🏆
  ¡Fueguito día N!…", "🎉 ¡Recompensa Fueguito día 15!…", "🎉 ¡Fueguito! …").
  Reemplaza a `_isRefundClaimNotice` en los 5 puntos del server: creación del
  ChatStatus como cerrado (HTTP y socket), no-reabrir (HTTP y socket), reloj
  SLA, y `_isAutoClientMessage` de la auditoría. Nuevo mensaje automático de
  la PWA ⇒ sumarlo a esa regex.
- **Validado:** `node --check` OK. Redeploy.

### 139. Regla antifraude "30 minutos para validar comprobantes" en el prompt base
- El owner pegó en "Reglas del negocio" del panel un reporte de Telegram
  (royalmirtha947, 3/10, ERROR DE PLATA) + la explicación: los comprobantes
  enviados después de 30 min de la transferencia NO se cargan (estafa
  típica: A reclama al instante, B reclama el mismo pago a los 45 min → se
  cargaría 2 veces). El mensaje estándar del agente es "No podremos validar
  ya que excedió el tiempo límite…, solicite la reversión a su banco".
- **Fix (prompt base):** regla explícita: aplicar el límite y repetirlo es
  atención CORRECTA (no error_plata / sin_solucion / "no investigó"); solo es
  problema si hubo grosería, contradicción, o el comprobante claramente entró
  dentro de los 30 min y lo rechazaron igual.
- Recordatorio al owner: en el cuadro del panel van REGLAS ("cuando X, lo
  correcto es Y"), no reportes pegados con nombres y puntajes.
- **Validado:** `node --check` OK. Redeploy.

### 138. Criterio "la pelota del lado del cliente" en el prompt de auditoría (3 falsos positivos del owner)
- Casos reportados (Telegram 00:54-01:02, todos 6/10 con sin_solucion /
  respuesta_pobre): (a) cliente escribe "Disculpe?" sin contexto y el agente
  responde "hola, ¿cómo puedo ayudarte?"; (b) agente resetea clave, cliente
  dice "sigo sin poder entrar", agente pide captura, cliente no vuelve;
  (c) ídem con "no puedo entrar". El owner: si el cliente deja de responder
  después de que el agente se ocupó, es porque resolvió; lo que cuenta es la
  intención de nuestro lado.
- **Fix (prompt base, `chatAuditAiService.SYSTEM`):** sección "CUÁNDO ALGO NO
  ES SIN SOLUCIÓN NI RESPUESTA POBRE": último mensaje relevante del agente +
  cliente en silencio = resuelto; mensajes ambiguos ("Disculpe?", "hola") →
  "¿en qué te ayudo?" es la respuesta correcta EN CONTENIDO, pero **la demora se
  juzga aparte, siempre** (corrección del owner: "si hay demora hay demora y
  punto"); "no puedo entrar" + reset/
  pedido de captura sin respuesta = pudo entrar; no exigir cierre formal.
- **Convención acordada con el owner:** criterios GENERALES de evaluación →
  se los pasa al asistente y van al prompt base (versionado, replicable);
  reglas operativas/puntuales del proyecto → cuadro "Reglas del negocio" del
  panel.
- Nota: esos 3 llegaron a Telegram con 6/10 → el umbral "Alertar si puntaje ≤"
  está por encima del default (4). Cuando las reglas estén afinadas, bajarlo.
- **Validado:** `node --check` OK. Solo backend → redeploy.

### 137. Auditoría IA: analiza SOLO la ÚLTIMA charla (no todo el día)
- **Pedido del owner:** si el cliente habló a las 14, 18, 20 y 22 hs, que se
  audite y reporte únicamente la charla de las 22 hs (la completa), no un
  tramo que mezcle todo el día ni una conversación vieja.
- **Fix (`_auditConversation`):** los mensajes cargados desde `lastAuditMsgAt`
  (o 24 h) se cortan en "charlas" por pausas ≥ `sessionGapMinutes` (default
  60, editable en Config privada → "Pausa que separa charlas"); se audita SOLO
  la última. Las anteriores quedan cubiertas por `lastAuditMsgAt` (no se
  auditan después). `periodStart/End` reflejan esa charla y el Telegram
  agrega "🕒 Charla de HH:MM a HH:MM (N msjs)". Helper `_auditCountMessages`
  extraído de `_auditLoadMessages`.
- **Validado:** `node --check` OK. admin-sw v28 → v29. Redeploy.

### 136. Auditoría IA: REGLAS DEL NEGOCIO (default + editables desde el panel) + botón "❌ Falso positivo"
- **Reporte del owner (Telegram 00:23):** la IA marcó "sin solución" retiros
  donde el agente explicó que con bono hay que duplicar/triplicar antes de
  retirar. Eso es atención CORRECTA. Pregunta: "¿cómo se arma la IA a
  precisión para que funcione tal cual quiero?".
- **Respuesta implementada = reglas del negocio en dos niveles:**
  1. **Default en el prompt** (`chatAuditAiService.SYSTEM`, sección "REGLAS DEL
     NEGOCIO"): retiros con bono ⇒ rollover explicado = correcto (no
     sin_solucion / error_plata / promesa_incumplida); cargas y pagos se
     ejecutan FUERA del chat → la falta de confirmación en la charla no es
     problema; "Recibimos tu solicitud de retiro…" es la respuesta correcta.
  2. **Editables por el owner**: `auditconfig.extraRules` (≤8000 c.) →
     textarea "📜 Reglas del negocio para la IA" en 🔐 Config privada →
     Auditoría; van como 2º bloque `system` DESPUÉS del breakpoint de cache,
     con "PRIORIDAD sobre todo lo anterior". Aplica a la próxima auditoría.
- **Bucle de afinado:** en la lista de Auditoría, botón **❌ Falso positivo**
  (además de "Marcar visto"): pide el motivo, marca `falsePositive:true`
  (campo nuevo en ChatAudit) y esa auditoría sale del ranking de agentes.
  `GET /api/admin/audit/false-positives` lista los últimos 100 con motivo
  para convertirlos en reglas. Método: cada falso positivo → una línea nueva
  en "Reglas del negocio".
- **Validado:** `node --check` OK en todo; HTML 616/616, ids únicos.
  **admin-sw v27 → v28.** Redeploy.

### 135. Auditoría: los mensajes AUTOMÁTICOS del cliente (reembolso reclamado, pedido de CBU) ya no cuentan como "sin respuesta"; el reclamo de reembolso no abre el chat
- **Primeras alertas reales en Telegram (owner, 23:40):** tres falsos
  positivos del mismo tipo: (a) IA 5/10 "el reclamo de reembolso daily quedó
  sin respuesta"; (b) regla SIN RESPUESTA por "💳 Solicito los datos para
  transferir (CBU)"; (c) regla SIN RESPUESTA por "🎁 Reembolso daily
  reclamado". Los tres son mensajes que genera la app al tocar un botón y que
  el sistema responde solo: ningún agente tiene que contestarlos.
- **Fix:** `_isAutoClientMessage(content)` (reembolso reclamado —reusa
  `_isRefundClaimNotice`— o "💳 Solicito los datos para transferir").
  `_auditLoadMessages` ahora devuelve `userMsgs` = mensajes REALES del
  cliente y `unanswered` = reales sin NINGÚN mensaje posterior (agente o
  sistema). `_auditConversation`: sin mensajes reales, o sin agente pero todo
  respondido → no audita (marca el tramo como visto, no gasta IA); la regla
  `sin_respuesta` usa `unanswered`. La transcripción etiqueta esos mensajes
  como `[CLIENTE-AUTOMÁTICO]` y el prompt le dice a la IA que NUNCA los cuente
  como sin respuesta/demora.
- **Pedido extra del owner:** "cuando reclaman un reembolso debería aparecer
  cerrado, no abrirse el chat". Ya no reabría uno cerrado (excepción vieja),
  pero si el cliente NO tenía ChatStatus, el upsert lo CREABA con status
  'open' por default → aparecía en Abiertos. Ahora en ambos caminos (HTTP y
  socket) el aviso de reembolso hace `$setOnInsert: {status:'closed',
  closedBy:'system'}`.
- **Validado:** `node --check` OK. Las auditorías falsas ya creadas quedan en
  el panel (marcar visto). Redeploy.

### 134. Encuesta 👍👎: ahora sale DESPUÉS del mensaje de carga/pago (salía antes) + nota interna también con 👍
- **Captura del owner (Render/EB, 08:36):** la encuesta llegó a las 08:36:58 y
  "¡Carga acreditada!" a las 08:37:00 → orden invertido. Causa: el hook estaba
  en `recordUserActivity('deposit')`, que corre ANTES del mensaje al cliente
  (en el medio hay bono automático + lectura de saldo en JUGAYGANA, más de 2 s).
- **Fix:** el hook se sacó de `recordUserActivity` y se puso en los puntos
  exactos, después del `emit('new_message')` al cliente: auto-carga hgcash,
  carga manual del panel, `notifyPayoutPaid` (pago) y carga self-service
  (después de registrar actividad; solo manda si un agente habló en 24 h).
  Sigue el delay de 2 s → la encuesta aparece siempre DEBAJO de la confirmación.
- **Dónde se ve la respuesta:** 👍 → nota interna verde "👍 El cliente calificó
  BIEN la atención" (nuevo) + cuenta en el ranking de Auditoría. 👎 → nota
  interna "👎 El cliente calificó MAL…" con el motivo, alerta Telegram, fila en
  Auditoría → "Calificaciones negativas" y auditoría IA inmediata del tramo.
- **Validado:** `node --check` OK; rutas sin cambios de posición (sin riesgo TDZ).

### 133. 🔴 Deploy de #132 tumbó el server (502): rutas registradas antes de `const authMiddleware` (TDZ) — FIX
- **Síntoma:** deploy 2026-08-27 23:03 UTC → 502 Bad Gateway en todo; el owner
  volvió a la versión anterior. Logs (web.stdout.log, ambas instancias):
  `ReferenceError: Cannot access 'authMiddleware' before initialization` en
  `server.js:2937` (`app.post('/api/chat/rating', authMiddleware, …)`), en
  loop de reinicio cada 2 s.
- **Causa:** en #132 puse las 7 rutas de auditoría/👍👎 junto a las funciones
  (~L2600, antes del webhook hgcash), pero `authMiddleware` es un `const`
  definido en ~L3270 → al evaluar el módulo la ruta se registra antes de la
  inicialización (temporal dead zone) y el proceso muere al arrancar.
  `node --check` NO lo detecta (es error de runtime, no de sintaxis). Las
  funciones (`_auditConversation`, etc.) sí pueden estar ahí (hoisting).
- **Fix:** las 7 rutas se movieron al bloque de Config privada (después de
  `verify-sms-password`, antes de `/private-config/password`), con comentario
  de advertencia. Scan hecho: ninguna otra `app.*` usa un middleware antes de
  su `const` (la única anterior es `app.use('/api/', generalLimiter)` y ese
  const está arriba). Regla nueva en CLAUDE.md.
- **Validado:** `node --check` OK. **Necesita redeploy** (es el mismo #132 +
  este fix). Nada de #132 llegó a correr en producción (el proceso nunca
  levantó), así que no hay datos ni efectos a limpiar.

### 132. AUDITORÍA DE ATENCIÓN en 3 capas + encuesta 👍👎 al cliente + alertas a Telegram
- **Pedido del owner:** con ~10 chats/segundo en 10 proyectos es imposible
  revisar todo a mano; quiere control del 100% de la atención (mal trato,
  malas respuestas, sin solución). Un solo empleado supervisa y no llega.
  Aclaración posterior: la encuesta 👍👎 NO al cerrar el chat (se cierra y
  reabre varias veces por charla) sino **cuando se resuelve de verdad: tras
  una carga acreditada o un pago hecho**.
- **Arquitectura (todo en server.js, bloque "AUDITORÍA DE ATENCIÓN"; modelos
  `ChatAudit` y `ChatRating` permanentes; servicios `chatAuditAiService.js` y
  `telegramAlertService.js`; campos nuevos en ChatStatus: `auditLockAt`,
  `lastAuditAt`, `lastAuditMsgAt`, `lastRuleAlertAt`, `ratingRequestedAt`):**
  · **Capa 1 — reglas sin IA, en vivo.** `_auditRulesOnUserMessage` (hook junto
    a `delayClockOnUserMessage` en HTTP y socket): regex de insultos y de
    quejas ("estafa", "no me cargan", "hace X horas", "denuncia"…) + mensaje
    repetido 3× en 15 min → nota interna al chat ("⚠️ ALERTA DE ATENCIÓN…
    cliente molesto"), `ChatAudit(source:'rules')` y Telegram. Throttle 30 min
    por cliente ATÓMICO (`ChatStatus.lastRuleAlertAt`, multi-instancia).
    `_auditRulesOnClose` (los 2 cierres manuales): se cerró con `pendingSince`
    en curso → bandera `cerrado_sin_responder` con el agente que cerró.
  · **Capa 2 — IA por conversación.** Cron `_runChatAuditTick` cada 5 min:
    ChatStatus con `lastMessageAt` quieto ≥ `idleMinutes` (20) y mensajes
    nuevos desde `lastAuditMsgAt` (máx. `maxPerTick`=40 por corrida). Claim
    atómico `auditLockAt` (10 min). Tramo = desde el último mensaje auditado
    (o `lookbackHours`=24). Sin mensajes de agente → `sin_respuesta` (puntaje
    2, sin gastar IA; salvo que solo haya bienvenida/confirmación automática).
    Con agente → `chatAuditAi.auditTranscript` (default `claude-sonnet-5`,
    effort low, salida estructurada: puntaje 1-10, banderas, resumen, cita,
    agente responsable, resuelto, cliente enojado). Rúbrica: trato >
    comprensión > solución > plata > tiempos. Transcripción con horas ART,
    `[SISTEMA]` para automáticos, imágenes como `[imagen/comprobante]`.
    Costo ≈ US$0,003-0,006 por chat. `POST /api/admin/audit/run/:userId`
    audita ya.
  · **Capa 3 — humano.** Panel → **🕵️ Auditoría** (solo admin general):
    tiles (auditados, promedio, alertas de reglas, pendientes, 👍/👎),
    ranking por agente (prom., malos ≤4, con bandera, mal trato, sin
    solución, 👍, 👎), calificaciones negativas con motivo, lista de
    auditorías con filtros (pendientes / marcadas / todas / buenas, bandera,
    agente, cliente, período) + "Abrir chat" + "Marcar visto" (con nota).
    Badge rojo en el nav con pendientes (refresh 5 min). **Telegram:**
    `_auditAlert` manda si puntaje ≤ `minScoreAlert` (4) o bandera en
    `alertFlags`; mensaje con dominio del proyecto (mismo bot+grupo para los
    10 proyectos), puntaje, banderas, agentes, resumen, cita y **link al chat**
    `…/adminprivado2026/?chat=<userId>&u=<username>` (deep-link: admin.js lo
    consume tras login y abre la conversación).
  · **👍👎:** `_scheduleRatingRequest` desde `recordUserActivity(type
    'deposit')` (cubre carga manual, auto hgcash y self-service) y desde
    `notifyPayoutPaid`. **2 s** después (owner: a los 45 s el cliente ya se fue) manda Message `type:'system'` con
    `metadata.kind:'rating_request'` (texto editable `/sys_rating_request`),
    solo si un agente humano habló en las últimas 24 h y con tope atómico
    `ratingCooldownHours` (6) por cliente. La PWA (chat.js,
    `buildRatingCardHtml`) pinta 2 botones; 👎 abre textarea "Contanos qué
    pasó. Lo va a leer un supervisor". `POST /api/chat/rating` → `ChatRating`
    (1 por mensaje; el motivo puede llegar después), `metadata.rated` en el
    Message, nota interna, Telegram (al llegar el motivo, o a los 3 min si no
    lo manda) y auditoría IA inmediata del tramo. Respuestas editables
    `/sys_rating_thanks` y `/sys_rating_thanks_negative`. **El GET de mensajes
    ahora proyecta `metadata`** (antes no viajaba a la PWA).
- **Config (🔐 Config privada → card "Auditoría + Telegram", `Config['auditconfig']`):**
  enabled, rulesEnabled, ratingEnabled, model, effort, idleMinutes,
  minScoreAlert, alertFlags, ratingCooldownHours, maxPerTick, lookbackHours,
  telegram {botToken (enmascarado), chatId} + botón "Probar Telegram". Env
  fallback: `AUDIT_AI_MODEL`, `TELEGRAM_ALERT_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID`.
  La API key es la misma de comprobantes. Endpoints: `POST
  /api/admin/private-config/audit`, `/telegram-test`; `GET /api/admin/audit/
  {list,agents,ratings}`, `POST /api/admin/audit/:id/review`,
  `/ratings/:id/review`.
- **Validado:** `node --check` OK en todo (server.js, 2 modelos, 2 servicios,
  chat.js, admin.js, admin-sw). HTML del panel: 615/615 divs, 26/26
  sections, ids únicos. **admin-sw v26 → v27.** PWA: solo chat.js (SWR) → sin
  bump de `?v`. Back necesita redeploy. **PROBAR tras deploy:** (1) Config
  privada → Auditoría: cargar token+chat id → "Probar Telegram"; (2) hacerle
  una carga a un cliente con el que un agente habló → a los 2 s le llega la
  encuesta; tocar 👎 y escribir motivo → nota interna + Telegram + fila en
  Auditoría; (3) esperar 20 min de una charla quieta → aparece auditada con
  puntaje; (4) escribir como cliente "no me cargan, estafa" → alerta de regla
  al instante; (5) abrir el link del Telegram → el panel abre ese chat.
- **Limitaciones conocidas:** `_repeatMap` (mensaje repetido) es por
  instancia; la rúbrica va a necesitar 2-3 semanas de ajuste con el
  supervisor (falsos positivos esperables al inicio: subir `minScoreAlert`
  o quitar banderas de `alertFlags` desde el panel). Costo: ~10k chats/día
  ≈ US$30-60/día con sonnet-5 (bajar a haiku-4-5 desde el panel si hace falta).

### 131. Auto-carga hgcash: el guard "POSIBLE DUPLICADO (<8 min)" ya no frena una SEGUNDA transferencia real
- **Reporte del owner (captura):** cliente mandó $2.000, comprobante verificado
  único (op. distinta), y la auto-carga igual frenó con "⚠️ POSIBLE DUPLICADO —
  ya se le cargó $2.000 hace pocos minutos" porque había cargado $2.000 un
  rato antes. Coelsa y horario eran otros.
- **Causa:** la "red de seguridad" de `hgcashAutoCarga` miraba SOLO "mismo
  usuario + mismo monto + deposit en <`duplicateGuardMinutes`(8) min" en
  Transaction, sin distinguir si esa carga anterior era OTRA transferencia. El
  candado real contra doble acreditación es `HgcashCharge` (índice único por
  coelsa) y ya había pasado; el guard existe para el caso "el agente cargó a
  mano y DESPUÉS llega el aviso del banco" (manual sin coelsa).
- **Fix:** una carga reciente del mismo monto cuenta como posible duplicado
  SOLO si no se puede probar que es otra transferencia: auto-carga hgcash con
  `metadata.movementId` distinto → no cuenta; carga manual que consumió otro
  movimiento (`BankMovement manual_charged`, mismo monto, ventana, movementId
  distinto) → no cuenta (una por manual); carga manual sin movimiento asociado
  → SÍ cuenta (caso original). Si no queda ninguna "inexplicada", la carga
  sigue sola; se loguea `[hgcash] N carga(s) reciente(s)… son OTRAS transferencias`.
- **Validado:** `node --check` OK. Solo backend → redeploy.

### 130. SMS Masivo: la clave se exige del lado SERVER en preview y envío
- Cierra la nota de #129: `POST /api/admin/bulk-sms` y `/bulk-sms/preview`
  ahora reciben `password` en el body y lo verifican con `_smsPasswordCheck`
  (helper compartido con `verify-sms-password`: hash de Config privada, env
  solo fallback). Sin clave válida → 401 `{code:'SMS_PASSWORD'}` (500 si no
  hay clave definida en ningún lado). `preview` suma `sensitiveLimiter`.
- **Panel:** la clave verificada en el modal se retiene en `_smsPassword` y
  viaja en cada preview/envío; ante `SMS_PASSWORD` el panel re-bloquea la
  sección y vuelve a pedirla (`_smsRelock`).
- **Validado:** `node --check` OK (server.js, admin.js). Mismo deploy (v26).

### 129. SMS Masivo usa la misma clave de "🔐 Config privada" (adiós SMS_MASIVO_PASSWORD en SSM)
- **Pedido del owner:** mover la clave de SMS Masivo al esquema nuevo.
- **Cambio (`POST /api/admin/verify-sms-password`):** si ya hay clave del
  sector privado (hash en `Config['privateconfigpass']`) se verifica contra ESA
  (bcrypt) y la env se ignora. Fallback a `SMS_MASIVO_PASSWORD` (SSM) SOLO
  mientras no se haya definido la clave del sector — sin ventana rota. Sin
  ninguna de las dos → error claro "Definí primero la clave en 🔐 Config
  privada". Se le sumó `sensitiveLimiter` (antes no tenía rate limit).
- **Panel:** el modal de SMS dice "Clave del sector privado (la misma de 🔐
  Config privada)", Enter envía, y muestra el error real del server.
- **Una vez definida la clave desde el panel, `SMS_MASIVO_PASSWORD` se puede
  borrar de SSM.**
- ~~Nota: bulk-sms no exigía la clave del lado server~~ → cerrado en #130.
- **Validado:** `node --check` OK (server.js, admin.js). Mismo deploy que #128
  (admin-sw sigue en v26).

### 128. Panel: sección "🔐 Config privada" con clave propia (hash en DB) → la IA de comprobantes se configura sin código ni SSM
- **Pedido del owner:** que la IA se configure desde el panel, en un sector
  privado con clave, "para que no sea todo código o SSM".
- **Clave del sector:** propia (distinta del login), guardada como **hash
  bcrypt en `Config['privateconfigpass']`**. La primera vez la define el admin
  general desde el mismo panel (formulario "Definir clave"); no vive en SSM ni
  en código (a diferencia de `SMS_MASIVO_PASSWORD`, que sigue en SSM). El
  server NO guarda "sesión desbloqueada": cada escritura exige la clave en el
  body; el panel la retiene en memoria solo mientras el sector está
  desbloqueado (`_pcPassword`; "Bloquear" la borra). Endpoints (solo
  `role==='admin'` + `sensitiveLimiter` 10/15 min contra fuerza bruta):
  `GET /api/admin/private-config/status` · `POST …/setup` (solo si no hay
  clave) · `POST …/unlock` · `POST …/ai` · `POST …/password`. **Si se olvida
  la clave:** borrar el doc `privateconfigpass` de Config en Atlas → el panel
  vuelve a pedir definirla.
- **Config de IA (`Config['aiconfig']`):** `enabled`, `model` (select con
  opus-5 / sonnet-5 / opus-4-8 / haiku-4-5 + "otro" libre), `effort`
  (low/medium/high), `apiKey` (opcional, formato `sk-ant-…`; pisa la de SSM;
  al panel vuelve solo enmascarada `••••1234`; checkbox para borrarla y volver
  a SSM), `extraRules` (texto libre ≤4000 c. que se agrega al prompt como
  segundo bloque `system`, después del breakpoint de cache). Prioridad:
  **panel > env/SSM > default del código**.
- **Aplicación en runtime:** `comprobanteAiService.applyConfig(cfg)` +
  `getEffectiveConfig()`; server.js la carga en `initializeData()` y la
  **refresca cada 60 s** (`_loadAiConfigIntoService`, multi-instancia) y al
  guardar la aplica al instante en la instancia que atendió el POST.
  `isEnabled()` ahora también respeta `enabled:false` del panel.
- **Panel:** nav "🔐 Config privada" (solo admin general, patrón
  `nav-item-sms-masivo`), `#privateConfigSection` con card de candado
  (definir / desbloquear / bloquear / cambiar clave) y card de IA con estado
  "En uso ahora" (modelo, fuente, esfuerzo, key). Funciones `loadPrivateConfig`,
  `setupPrivateConfigPassword`, `unlockPrivateConfig`, `savePrivateAiConfig`,
  `changePrivateConfigPassword`, `renderPrivateAiConfig`.
- **Validado:** `node --check` OK (server.js, comprobanteAiService.js, admin.js,
  admin-sw.js); 589/589 divs, 25/25 sections, ids únicos. **admin-sw v25 →
  v26.** Back necesita redeploy. **PROBAR:** entrar como admin general →
  Config privada → definir clave → desbloquear → cambiar modelo a sonnet-5 y
  guardar → "En uso ahora" refleja el cambio; mandar un comprobante y ver en
  el log `[comprobante-ai]` / en la colección Comprobante el campo `model`.
  Con un depositor la sección no debe aparecer.

### 127. Paquete de réplica para los repos hermanos (`docs/replicas/`)
- El owner pidió "toda la implementación para copiar y pegar en los demás
  proyectos". Quedó en el repo (Tails no persiste nada local):
  `docs/replicas/2026-08-27-comprobantes-hgcash-retiros.patch` (diff exacto de
  #124 + #125 + #126 sobre server.js, comprobanteAiService.js y Comprobante.js;
  verificado con `git apply --check`) y `docs/replicas/README-2026-08-27.md`
  (opción A `git apply`, opción B a mano con los bloques a pegar y un prompt
  para el asistente del otro repo, checklist post-deploy). NO incluye el
  rename de la PWA (específico de cada proyecto).

### 126. IA de comprobantes: modelo Opus 5 + salida estructurada + prompt que distingue CBU/CUIT de N° de operación + duplicados "posibles" en vez de "YA UTILIZADO"
- **Queja del owner:** "la IA es muy inútil a veces": (a) hay N° de comprobante Y
  CBU en la imagen y devuelve el CBU como N° de operación; (b) marca
  "COMPROBANTE YA UTILIZADO POR @x" cuando nunca fue usado por nadie.
- **Causas:** (a) el modelo era `claude-haiku-4-5` (el más chico) con un prompt
  de una línea por campo; el server descartaba el N° si era IGUAL al CBU leído o
  ≥18 dígitos, pero no si era un pedazo del CBU, y aunque lo descartara dejaba
  el valor en `operationNumber` → el agente veía "op. N°<CBU>" en el chat. (b) La
  huella de fallback sin N° de operación era `monto|origen|cbuOrigen|fecha` con
  `fecha` OPCIONAL: sin fecha, cualquier transferencia anterior de la misma
  persona por el mismo monto (o dos del mismo día) daba "🚨 YA UTILIZADO".
- **`src/services/comprobanteAiService.js` (reescrito):**
  · Modelo default **`claude-opus-5`** (era haiku-4-5). Sigue configurable con
    `COMPROBANTE_AI_MODEL` (⚠️ si esa env está seteada en EB/SSM con haiku,
    PISA el default: borrarla o ponerla en `claude-opus-5`/`claude-sonnet-5`).
    Costo aprox. por comprobante: ~US$0,01-0,02 (era ~0,003).
  · **Salida estructurada** (`output_config.format` = json_schema con las 12
    claves, `additionalProperties:false`): la API garantiza JSON válido.
    `parseJsonLoose` queda de red de seguridad.
  · Prompt nuevo en `system` (cacheable) con reglas explícitas: CBU = 22
    dígitos, CUIT = 11 con formato XX-XXXXXXXX-X, alias = palabras con puntos →
    NUNCA son N° de operación; lista de etiquetas válidas ("Número de
    operación", "Referencia", "ID de transacción"…); origen vs destino; monto;
    null antes que un dato dudoso. Campos nuevos: `numero_operacion_etiqueta`
    (la etiqueta impresa junto al número) y `hora` separada de `fecha`.
  · `effort: 'medium'`, `max_tokens 4096` (thinking adaptativo cuenta contra
    max_tokens), timeout 90 s, refusal-fallback beta (`fallbacks:'default'`
    + header `server-side-fallback-2026-07-01`) con reintento sin la beta ante
    HTTP 400; `stop_reason:'refusal'` → error controlado.
- **server.js (`analyzeComprobanteFromMessage`):**
  · Descarta el N° también si la ETIQUETA dice cbu/cvu/cuit/cuil/alias/cuenta/
    tarjeta/cliente/dni, o si son ≥8 dígitos contenidos en el CBU origen/destino
    (pedazo del CBU). Todo N° descartado pasa a `operationNumberRejected`
    (auditoría) y `operationNumber` queda null (el chat muestra "s/N°
    operación"; el match hgcash no lo usa).
  · Huella de fallback EXIGE fecha y suma la hora: `monto|origen|cbu|fecha|hora`.
    Sin fecha → sin huella → estado `no_key` ("verificá a mano"), no falso
    duplicado.
  · Aviso de duplicado de OTRO usuario en 3 niveles: imagen idéntica → "🚨 YA
    UTILIZADO"; mismo N° de operación → "🚨 YA UTILIZADO (mismo N°…)"; solo
    combo de datos → "⚠️ POSIBLE comprobante repetido… puede ser otra
    transferencia legítima o error de lectura, compará a ojo".
- **Modelo Comprobante:** campos nuevos `operationLabel`, `operationNumberRejected`,
  `paymentTime` (sin migración).
- **Validado:** `node --check` OK (server.js, comprobanteAiService.js,
  Comprobante.js). No se puede probar la API localmente (sin node_modules ni
  key): **probar tras deploy** con 2-3 comprobantes reales (Mercado Pago con
  "Número de operación" + CBU visible; uno de banco con "Referencia"; y el
  mismo comprobante reenviado por otro usuario) y mirar el log
  `[comprobante-ai]` por errores 400 del schema/beta.

### 125. Auto-carga hgcash: comprobante a un CBU de OTRO proyecto (mismo titular) ya NO conecta
- **Reporte del owner (Telegram de los agentes):** a un cliente se le cargó
  automático un comprobante cuya transferencia había ido al CBU `…212` del
  equipo de Nardo (OTRO proyecto). Los proyectos usan CBUs distintos con el
  MISMO titular ("CUATRO P MOVIL S.A."). Justo había acá un movimiento
  pendiente por el mismo monto (alguien había enviado ese monto a nuestro CBU)
  y coincidió. **Aclaración del owner:** los webhooks de hgcash son SIEMPRE
  del CBU propio — nunca llega un evento de otro CBU; el problema es del lado
  del comprobante.
- **Causa en el código:** la regla (2) del match (`_comprobanteMatchesMovement`,
  monto + nombre de origen + "destino consistente") aceptaba el destino por
  **nombre del titular** (`_destConsistentOk` → `movement.toName` o
  `cfg.accountName`), y el titular es idéntico en todos los proyectos → un
  comprobante con CBU destino `…212` pasaba como "consistente" y se cargaba
  acá plata que había entrado allá.
- **Fix (server.js, sin fricción para el caso normal):**
  · `getHgcashConfig()` agrega `ownCbus` = `hgcash.cbu` + `Config['cbu'].number`
    (solo dígitos, ≥6). En el match se suma el `toCBU` del movimiento (siempre
    propio). Helpers `_cbuSameAccount` (compara por SUFIJO ≥6 dígitos porque
    muchos comprobantes muestran el CBU recortado) y `_comprobanteForeignCbu`.
  · **Si el comprobante MUESTRA un CBU destino, ese CBU manda:** si no coincide
    con ninguno propio, `_destConsistentOk` devuelve false (el titular ya no
    cuenta como prueba). Si el comprobante no trae CBU (solo titular o nada),
    TODO sigue igual que antes → las cargas normales conectan igual.
  · `hgcashMatchFromComprobante` lo detecta ANTES de buscar candidatos: marca
    el comprobante `bankMatchStatus:'other_cbu'` (enum nuevo en el modelo
    Comprobante; queda fuera de todo match futuro, también del que dispara el
    webhook) y avisa al agente con nota interna "⛔ Este comprobante va a OTRO
    CBU (…212), no al de este proyecto (…xxxx). NO se auto-carga…". NO toca
    ningún movimiento: la transferencia pendiente sigue esperando a SU
    comprobante real.
  · **También por ALIAS:** el campo `cbu_destino` de la IA trae "CBU/CVU o
    alias". Si el comprobante muestra alias en vez de CBU, se compara
    (normalizado, minúsculas sin espacios) contra `Config['cbu'].alias`
    (`cfg.ownAlias`); alias distinto → mismo tratamiento `other_cbu`.
  · **Si el comprobante NO muestra ni CBU ni alias de destino, no hay forma de
    distinguir el proyecto** (el titular es el mismo): queda el criterio de
    siempre (monto + nombre de origen + ventana + ambigüedad, o N° de operación
    == coelsa que es definitivo). Ese caso residual sigue siendo posible pero
    requiere la triple coincidencia; el owner prefiere eso a frenar cargas.
  · Sin CBU/alias propio configurado (`hgcash.cbu`, `Config.cbu.number` y
    `Config.cbu.alias` vacíos) no se puede juzgar → se comporta como antes.
    **Verificar en el panel que el CBU de hgcash y el CBU + alias que se
    muestran al cliente estén cargados.**
- **Validado:** `node --check` OK (server.js, Comprobante.js). Solo backend →
  sin bump de `?v`. Back necesita redeploy. **PROBAR:** mandar un comprobante
  con CBU destino ajeno → nota ⛔ en el chat y sin carga; uno al CBU propio
  → carga como siempre. Lección para el repo hermano (mismo código).

### 124. Retiros: "No se pudo leer el saldo del cliente para descontar" = JUGAYGANA/proxy, pero el código NO reintentaba + la app instalada pasa a llamarse AUTOREEMBOLSOS
- **Reporte del owner (captura de un agente, días previos):** al confirmar un
  retiro de $15.000 el panel mostraba la nota interna "⚠️ No se pudo leer el
  saldo del cliente para descontar $15.000. Reintentá en unos minutos" y no
  descontaba de JUGAYGANA. "Ahora se solucionó" — ¿código o JUGAYGANA?
- **Diagnóstico: las dos cosas.** El origen del fallo es JUGAYGANA/el proxy
  (timeout, HTML de Cloudflare o el proxy saturado de #122 — justamente esos
  días); por eso "se arregló solo" al bajar el tráfico a JUGAYGANA. PERO el
  código lo amplificaba: el paso 1 de `_deductChipsAtConfirm` (server.js) leía
  el saldo con `jugayganaMovements.getUserBalance` = **UNA sola llamada** sin
  retry (encima vía `getUserInfoByName`, que colapsa "falló la API" con "no
  existe"), mientras que TODAS las demás lecturas de saldo del server usan
  `getUserBalanceWithRetry`. Un solo timeout tumbaba la confirmación entera.
  Que "no descuente" es lo CORRECTO: el flujo aborta ANTES de tocar plata y
  deja el payout en `failed`, que el agente puede volver a pagar (el endpoint
  `/pay` acepta `pending_review` y `failed`).
- **Fix:** paso 1 pasa a `getUserBalanceWithRetry` (3 intentos, 500/1000 ms
  entre medio, igual que el resto). Si aun así falla, la nota interna y el
  error del payout ahora dicen la CAUSA real (`errToString` del error de
  JUGAYGANA), aclaran "No se descontó nada" y que hay que reintentar el pago.
  El paso 4 (verificación anti-fantasma post-descuento) ya usaba retry.
- **(2) Nombre de la app instalada → AUTOREEMBOLSOS.** El ícono de la PWA se
  llamaba "VIPCARGAS" porque este repo es el gemelo de vipcargas. Cambiado en
  `public/manifest.json` (`name`, `short_name`, `description`, label de
  screenshot) y en `public/index.html` (`<title>`, `apple-mobile-web-app-title`
  —el que usa iOS—, `application-name`). NO se tocaron `id`/`scope`/`start_url`
  (cambiarlos haría que el navegador lo tome como OTRA app). Los textos de
  marketing dentro de la app ("Bienvenido a VIPCARGAS", logo `<h1>`, etc.)
  siguen diciendo VIPCARGAS — cambiarlos si el owner lo pide.
  ⚠️ **Instalaciones existentes:** Android/Chrome actualiza el nombre solo
  cuando re-verifica el manifest (puede tardar días o pedir confirmación);
  en iOS el nombre queda fijo al instalar → hay que borrar y reinstalar.
  Las instalaciones NUEVAS salen con el nombre nuevo desde el deploy.
- **Validado:** `node --check server.js` OK; manifest.json parsea. Cambio de
  HTML sin JS nuevo → sin bump de `?v` (index.html es navigate/network, el
  manifest es network-first en el SW). Back necesita redeploy (la nota del
  panel viene del backend; index.html/manifest se sirven cacheados por proceso
  → el redeploy los refresca).

## Sesión 2026-08-25

### 123. Panel: mensajes de sistema INTERNOS (adminOnly) en VERDE con etiqueta "🔒 INTERNO" (réplica #198 del gemelo)
- **Problema:** en el chat del panel todos los mensajes de sistema se veían
  naranjas iguales — imposible distinguir cuáles le LLEGARON al cliente
  (automáticos) de los internos del equipo (cierre de chat, alertas de bonus,
  comprobante repetido, etc.).
- **La distinción ya viajaba en los datos:** `adminOnly: true` (verificado en
  esta repo: el GET de mensajes lo proyecta —server.js `adminOnly: 1`— y los
  payloads de socket de `_emitAdminOnlyChatNote` lo incluyen). Solo se PINTA:
  cero backend.
- **Cambio (solo panel):** `createMessageElement` rama `type==='system'` (único
  punto de render: el camino en vivo delega acá, #21): `adminOnly===true` →
  clase `message system internal` + badge "🔒 INTERNO — el cliente NO lo ve"
  y sin ícono; NO interno → ícono 🤖 (`.icon-robot`, reemplaza al 🔒 que era
  engañoso: parecían internos y el cliente los había visto). CSS: internos en
  VERDE (`rgba(37,211,102,…)` + `#25d366`), automáticos quedan naranjas.
- **Validado:** `node --check` OK (admin.js, admin-sw.js); llaves CSS 311/311.
  **admin-sw bump v24 → v25.** Solo estáticos del panel → deploy y recargar.
  **PROBAR:** "Chat cerrado por..." y alertas internas en verde con etiqueta;
  confirmaciones de depósito/bono (que el cliente sí vio) en naranja con 🤖.

### 122. 🎯 CULPABLE IDENTIFICADO: saturación del camino a JUGAYGANA (proxy) — caches + menos polling
- **Evidencia de la instrumentación de #121 (logs con [slow-req], 20 min de
  datos):** 1.610 requests lentos y TODOS son endpoints que llaman a JUGAYGANA:
  `GET /api/balance/live` 1.226 veces (~2s c/u), `GET /api/refunds/status` 286
  (~4.5s, hace 4 llamadas NETWIN), claims ~6s, `admin/deposit` ~7s,
  `payouts/pay` ~11s, login ~3.6s. NINGÚN endpoint puro-Mongo aparece; el
  event-loop está limpio (una sola traba de 513ms) y el adapter Redis de
  Socket.IO está ACTIVO en ambas instancias ("multi-instance mode active").
- **La cadena:** cada PWA online consultaba su saldo cada 30s → cada consulta =
  1 llamada a JUGAYGANA vía el proxy residencial rotativo → con cientos de
  clientes son varias llamadas/segundo → el proxy/proveedor responde a ~2s →
  TODO lo que toca JUGAYGANA se arrastra (incluidas las acciones de los
  agentes: depósitos, pagos) → "el panel anda lento".
- **Fixes (bajar el tráfico a JUGAYGANA sin tocar flujos de plata):**
  1. `/api/balance/live` con **cache de 20s por usuario** + ante fallo de
     JUGAYGANA sirve el último saldo conocido (≤2 min, flag `stale`) en vez de
     400. El saldo real igual llega al instante por socket al acreditar cargas.
  2. **Poll del cliente 30s → 90s** (ui.js) + no pollea con la pestaña oculta.
     El poll es solo respaldo del socket `balance_updated`.
  3. `/api/refunds/status` con **cache de 3 min por usuario** (data de display;
     res.json interceptado para cachear sin reescribir el handler). Se INVALIDA
     en los 3 claims (`_invalidateRefundsStatus`: al entrar Y al terminar el
     claim, así un status concurrente no re-puebla el estado viejo). La puerta
     real del claim sigue siendo el índice único — el cache no toca plata.
  Caches en memoria por instancia con poda cada 10 min (unref).
- **Pendiente si sigue lento tras esto:** el proxy en sí (webshare residencial
  rotativo, ~2s por request). Opciones: plan mejor / proxy estático / revisar
  ancho de banda (ya se agotó una vez, #99). Decisión de plata del owner.
- **Validado:** `node --check` OK (server.js, ui.js). Cambio de JS puro → sin
  bump de `?v` (SW SWR revalida /js/ en la próxima carga, #90). Back necesita
  redeploy.

### 121. La teoría de capacidad de #120 QUEDÓ DESCARTADA — instrumentación para cazar la lentitud real
- **Datos nuevos (gráficos de CloudWatch del owner, 25/08 04:00 UTC):** CPU del
  entorno ~5% promedio con picos de 13%; saldo de créditos de CPU planchado en
  577 (llenos); instancias t3.medium; trigger de escalado ya estaba bien
  (CPUUtilization 70/30). Y los agentes reportan "está muy tranquilo, solo que
  tarda en cargar los chats" → lento SIN carga. **No es capacidad** (el
  razonamiento de #120 era plausible pero los gráficos lo refutan).
- **Sospechosos vigentes:** (1) MongoDB Atlas lento/saturado (cargar un chat es
  puro Mongo; revisar métricas del cluster en Atlas: tier, conexiones, latencia);
  (2) trabas cortas del event loop que el promedio de CPU esconde; (3) llamadas
  a JUGAYGANA en el camino de abrir chat. El log de healthd sigue roto → no hay
  latencias de requests en ningún lado, por eso se instrumenta:
- **Instrumentación agregada (server.js, siempre prendida, costo despreciable):**
  · `[slow-req]`: loguea todo request de /api/ que tarde >1.5s (método, ruta,
    ms, status, user). Umbral en `SLOW_REQ_MS`.
  · `[event-loop]`: tick de 1s; si el timer se corre >500ms, loguea la traba
    (detecta bloqueos del proceso invisibles en el promedio de CPU).
- **Cómo se usa tras el deploy:** dejar correr unas horas (ideal cruzar el pico
  nocturno) → EB → Registros → últimas 100 líneas o bundle completo → buscar
  `[slow-req]` (QUÉ endpoint es lento) y `[event-loop]` (si hay bloqueos). Además
  el arranque fresco vuelve a loguear si el adapter Redis de Socket.IO quedó en
  "multi-instance mode active" o cayó a single-instance (explicaría los mensajes
  "en visto": eventos que no cruzan entre instancias).
- **Validado:** `node --check` OK. Solo backend → sin bump de `?v`.
- **DATOS DE ATLAS (Query Insights, mismo día):** la query que carga los
  mensajes del chat tarda **1ms** → Mongo NO es lo que cuelga "Cargando
  mensajes" (buscar la traba en Node con [slow-req]/[event-loop]). Pero hay
  derroche real: (1) `chatstatuses` aggregate del listado de conversaciones:
  80.3k ejecuciones/día × 127ms = 2,8 h/día (falta índice status+lastMessageAt
  — lo recomienda Performance Advisor, crear DESDE ATLAS); (2) conteos
  filterless (`countDocuments()`) escaneando messages (62k docs, 492ms) y
  transactions (97k, 117ms) miles de veces/día; (3) `bankmovements` find de
  150ms examinando 10k docs (falta índice). Performance Advisor tiene 10
  recomendaciones de índices pendientes de revisar.
- **Fix aplicado (server.js):** `/api/admin/stats` y `/api/admin/sync-status`
  pasan los conteos sin filtro a `estimatedDocumentCount()` (metadata, ~0ms) y
  la suma de depósitos/retiros de hoy pasa de `find().lean()` + suma en JS a
  una agregación `$group` en Mongo. Display-only → el conteo estimado es
  equivalente en la práctica.
- **Performance Advisor (revisado con el owner):** de las 10 recomendaciones se
  crean SOLO 2 desde Atlas (sin deploy): `refundclaims {username, claimedAt}`
  (el buscador de Reembolsos reclamados de #116: 303ms escaneando 76k docs) y
  `bankmovements {matchedUserId, createdAt, matchStatus}` (589ms, flujo
  hgcashConsumeOnManualDeposit). Las otras 8 se DESCARTAN: consultas de ~1
  vez/día sobre `users` (que ya tiene 56 índices — sobre-indexada; el Advisor
  también sugiere borrar 22, pendiente de revisar con cuidado otro día porque
  varios pueden ser candados de idempotencia). El índice de `chatstatuses`
  {status, lastMessageAt} YA existe en el modelo — los 127ms del listado de
  conversaciones son el $lookup del último mensaje por chat (diseño, no falta
  de índice); optimizable a futuro bajando la frecuencia de polling del panel.

### 120. ANÁLISIS: Warning intermitente de EB + chats "en visto" = CAPACIDAD en el pico nocturno (no es bug)
- **Síntoma:** EB Warning↔Ok cada ~10 min ("TargetGroups reduced health") entre
  las 00:25 y 03:28 UTC del 25/08; agentes reportan chats que no cargan y
  respuestas que "quedan en visto" (el mensaje se guarda pero el cliente no lo
  ve en vivo). El owner reinició los app servers y "se arregló".
- **Análisis de logs (2 instancias, bundles completos):** CERO fallas — sin
  tormentas, sin OOM, sin errores de nginx/kernel/Redis/Mongo, app logueando
  normal durante toda la ventana. La correlación es de CARGA: el Warning ocurre
  EXACTAMENTE en el pico nocturno (21:30–00:30 ART; conexiones 344→565/h por
  instancia, pico previo de 947/h). Bajo pico, la instancia tarda de más en
  contestar algún health check del ELB por momentos → Warning; se recupera sola.
  Los síntomas de los agentes son la misma lentitud (eventos de socket demorados
  → "visto"; requests lentos → "Cargando mensajes…"). El reinicio coincidió con
  el fin del pico — VA A REPETIRSE cada noche si no se agranda la capacidad.
- **Recomendación (config EB, no código):** Configuración → Capacidad → subir
  mínimo de instancias 2→3 y/o subir el tipo de instancia (t3.small→medium).
- **Pendiente de código que aliviaría el pico (no hecho):** cachear
  `/api/refunds/status` (hoy 4 llamadas NETWIN a JUGAYGANA por CADA ingreso de
  usuario — lo más pesado por sesión, ver nota en #102).
- **Notas sueltas del análisis:** (a) los reportes de Telegram eran de agentes
  de GIROX (otro proyecto/entorno; NUEVOgirox también Warning y
  Paginaaaacreada-env-1 Degraded — misma receta, otro repo); (b) el logging de
  healthd (application.log de nginx) está ROTO en ambas instancias desde hace
  días (720 warns/h "does not exist") → EB no tiene métricas de requests, la
  salud sale solo del ELB; inofensivo pero explica la poca visibilidad;
  (c) el ssm-agent loguea "Failed to connect to Systems Manager" cada ~15 min
  en ambas instancias desde siempre (ruido crónico, probable permiso IAM).

## Sesión 2026-08-22

### 119. Buscador en Ruleta diaria + "cerrar sesiones" no mata la sesión propia + fix Registrarse en iPhone
- **(1) Buscador de usuario en la sección Ruleta diaria del panel.** Input
  `#rouletteSearchInput` junto al selector de días (debounce 350ms + Enter +
  guard anti-race). Filtra server-side la tabla "Quién ganó qué" — el endpoint
  `GET /api/admin/roulette/history` pasa de match EXACTO de `username` a
  substring case-insensitive (`escapeRegex`, término en minúsculas porque el
  campo se guarda lower, máx 40 chars). Las tarjetas de stats siguen mostrando
  el total del período. Título y empty-state reflejan la búsqueda.
- **(2) "Cerrar todas las sesiones" al cambiar la clave ya NO desloguea a la
  sesión que hace el cambio** (pedido del owner). Antes: el bump de
  `tokenVersion` invalidaba TODOS los tokens (incluido el propio) y el front
  forzaba re-login. Ahora los DOS endpoints (`/api/auth/change-password` y
  `/change-password/pending`) emiten un **token nuevo** (payload idéntico al
  login, 90d, con el tokenVersion nuevo) en el campo `token` de la respuesta
  cuando `closeAllSessions` — las demás sesiones mueren en su próximo request,
  esta sigue. `auth.js` guarda el token (localStorage + VIP.state) en los dos
  caminos (normal y entrada temporal) y el toast pasa a "Se cerraron las demás
  sesiones. Esta sesión sigue activa". **Fallback:** si el backend viejo no
  manda `token` (rolling deploy), se mantiene el comportamiento anterior
  (re-login) — sin ventana rota en ninguna dirección.
- **(3) iPhone: "Registrarse" no se dejaba presionar.** Causa: el botón
  flotante "📱 Agregar a Inicio" (`#pwaInstallButton`, position:fixed,
  z-index 9999, bottom ~80px) se muestra SIEMPRE en iOS (no hay
  beforeinstallprompt) y en pantallas cortas quedaba fijo ENCIMA del botón
  "📝 Registrarse" del login → el toque se lo comía el flotante (abría las
  instrucciones de instalación o no hacía "nada" visible). Fix: el flotante
  NO se muestra mientras `#loginScreen` esté visible (además instalar la PWA
  sin sesión en iOS es contraproducente: abriría deslogueada, el traspaso de
  sesión de #101 necesita login). Un MutationObserver sobre la clase `hidden`
  de `#loginScreen` lo muestra al entrar y lo esconde al volver al login.
  Aplica a todas las plataformas (mismo riesgo de solape en Android).
- **Validado:** `node --check` OK (server.js, auth.js, admin.js, SW); divs
  balanceados e ids únicos en ambos index.html. **`?v=56` +
  `CACHE_VERSION='v56'`** (cambiaron index.html y auth.js juntos, regla #97).
  Back necesita redeploy. **PROBAR tras deploy:** (a) buscar un usuario en
  Ruleta diaria; (b) cambiar clave con "cerrar sesiones" tildado → la sesión
  actual sigue viva y otra sesión abierta del mismo user queda inválida;
  (c) en un iPhone real, pantalla de login → tocar "Registrarse" (debe abrir
  el modal; el botón flotante no debe verse hasta después de entrar).

## Sesión 2026-08-20

### 118. RULETA DIARIA abierta a todos los que tengan la app + tope diario fail-closed
- **Pedido del owner:** "volver a habilitar" la ruleta diaria. Diagnóstico: nunca
  estuvo apagada (no existe interruptor) — lo que la escondía era el gate de
  "cliente activo" (>10 cargas reales/30d, #71): en esta base migrada casi nadie
  lo cumple → la card no se mostraba a nadie.
- **Decisión del owner (2026-08-20):** (a) puede girar TODO cliente con la app
  instalada + notificaciones (sin mínimo de cargas); (b) el tope de plata regalada
  por día se edita desde el panel y se reparte a lo largo de las 24 hs; (c) el
  total del día NUNCA puede superar el tope.
- **Gate apagado:** `ROULETTE_ACTIVE_GATE_DISABLED = true` (server.js) —
  `_rouletteIsActiveClient` devuelve `{active:true}` sin consultar la DB. El
  código del gate queda intacto para reponerlo con `false`. Status y spin no se
  tocaron (leen `act.active`).
- **El pacing pedido YA existía** (reparto lineal del budget por hora ART, fuerza
  SIN PREMIO si el premio supera el acumulado que corresponde a la hora; el
  budget no gastado a la mañana queda disponible más tarde). Se documenta que el
  tope es duro: no hay camino que lo supere.
- **NUEVO — fail-closed del tope** (antes era al revés y quedaba peligroso con la
  ruleta abierta a toda la base): SIN tope activo (checkbox apagado o monto $0)
  los giros salen SIEMPRE SIN PREMIO (antes: sin tope = premios SIN LÍMITE).
  Ídem ante error de DB en el pacing (antes fallaba "silencioso" y dejaba pasar
  el premio). Cartel del panel actualizado con la nueva semántica.
- **Operativo (owner):** entrar a panel → Ruleta diaria → activar el tope y poner
  el monto diario — sin eso la ruleta gira pero no regala nada. El botón
  "Reiniciar ruleta de HOY" y la simulación de giro quedan igual.
- **Validado:** `node --check` OK (server.js, admin.js); 574/574 divs, ids únicos.
  Solo backend + panel (network-first) → sin bump de `?v`. Back necesita redeploy.
  **PROBAR tras deploy:** un cliente con app y pocas cargas debe ver la card y
  poder girar; con el tope apagado todos los giros salen SIN PREMIO; con tope
  puesto, los premios respetan el reparto horario (ver "gastado/tope" en el panel).

### 117. 🔴 INCIDENTE: entorno caído (504 en todo) por BUCLE del fan-out hgcash contra sí mismo
- **Síntoma:** EB "Severe" desde las 07:14 UTC del 20/08; 504 Gateway Time-out en
  todas las URLs; ELB con 43,5% de 4xx. El deploy del 19/08 20:04 UTC NO fue la
  causa (nada del diff toca el webhook; el bucle venía de antes, ver abajo).
- **Causa raíz:** el fan-out de webhooks (#94) reenvía todo webhook firmado a
  `https://www.autoreembolsos.com/api/hgcash/webhook` (default), pero **este
  entorno ES autoreembolsos.com** → se reenviaba a sí mismo. El reenvío llega con
  firma válida (mismo secret) y NO había chequeo de `X-Forwarded-By` → se volvía
  a reenviar: **bucle infinito**. Los webhooks TRANSACTION_REQUEST son los peores:
  el handler responde 200 ANTES de procesar → el reenvío "sale bien" → bucle sin
  amortiguación. En los logs, el MISMO pago (`ext=null` = ni siquiera es de este
  proyecto, viene del hermano) se procesó 30.700 veces entre las 06 y 07 UTC.
- **Por qué "funcionaba bien" antes:** los reenvíos a sí mismo morían rápido con
  429 (rate-limit) — el bucle zumbaba capado (~500-1.600 warns/h desde el 16/08,
  todos 429). La madrugada del 20/08 los webhooks de pago fueron sembrando bucles
  (5k→9k→30k por hora); a las 06:40 el server dejó de responder en <8s → los 429
  pasaron a timeout (sin freno + reintentos) → ~115.000 reenvíos fallidos POR HORA
  en CADA instancia → event loop saturado → 504 general. Hubo un casi-colapso
  previo el 19/08 a las 23:00 UTC (18,5k) que se recuperó solo.
- **Mitigación INMEDIATA (owner, consola EB, sin deploy):** propiedad de entorno
  **`HGCASH_FANOUT_URL=off`** (kill switch que ya existía, #94). Si hgcash apunta
  DIRECTO a este entorno y vipcargas necesita la copia, apuntar a
  `https://vipcargas.com/api/hgcash/webhook` en vez de off.
  ✅ **Aplicada por el owner el 20/08 ~12:15 UTC** (verificado en captura: la
  propiedad quedó en `off` y el entorno se actualizó). Confirmado también que en
  SSM (`/autoreembjyg/prod`) NUNCA hubo `HGCASH_FANOUT_URL`: el reenvío salía del
  **default hardcodeado** del código. El fan-out de vipcargas → autoreembolsos SE
  MANTIENE (es la única fuente de webhooks de este proyecto; un solo salto, sin
  bucle posible con el guard nuevo).
- **Fix de código (`_fanoutHgcashWebhook`), doble guard anti-bucle:**
  1. Webhook que llega con `X-Forwarded-By` (ya es un reenvío del hermano) → NO se
     re-reenvía (corta cualquier cadena/bucle entre los dos proyectos).
  2. Si el host del fanout == nuestro propio dominio (`PUBLIC_BASE_URL` o el host
     del request, normalizando www.) → NO se reenvía y se loguea el aviso. Aunque
     la config quede mal, el bucle no se puede armar.
- **Lección (aplica al repo hermano vipcargas, MISMO código):** el default
  hardcodeado del fanout apuntando a un dominio fijo es una bomba cuando el mismo
  código corre EN ese dominio. El guard nuevo protege a ambos.
- **Validado:** `node --check` OK. Solo backend → sin bump de `?v`. Back necesita
  redeploy (el guard queda activo aunque después se re-habilite el fanout).

## Sesión 2026-08-19

### 116. Mínimo de carga $1.500 + el 20% no se da con saldo previo >$500 + buscador en Reembolsos reclamados
- **(1) Mínimo de carga automática $2.000 → $1.500** (pedido del owner): cambiado el
  default `minChargeARS` en `HGCASH_DEFAULTS` y el fallback del chequeo en
  `hgcashAutoCarga`. La config guardada en DB NO persiste `minChargeARS` (el POST
  del panel no lo incluye), así que el default de código es el valor efectivo —
  verificado antes de tocar. El aviso al agente ya usa el valor calculado (no había
  textos hardcodeados con $2.000 en el front).
- **(2) El bono del 20% NO se da si el cliente ya tiene más de $500 de saldo**
  (pedido del owner; sólo afecta el 20% "todas las cargas" — el 100% de primera
  carga queda igual):
  · Const `HGCASH_APP_BONUS_SKIP_BALANCE_ARS = 500` (server.js, junto a los
    defaults del bono).
  · En `hgcashAutoCarga` se lee el saldo PREVIO a acreditar
    (`jugayganaMovements.getUserBalanceWithRetry`) — SOLO cuando el 20% está en
    juego (app instalada + promo prendida y vigente), para no sumar llamadas a
    JUGAYGANA en el resto de las cargas. Se pasa como 3er parámetro a
    `_hgcashApplyAppBonus(user, amount, preBalance)`.
    **Ajuste 2026-08-20:** la lectura pasa a `{maxAttempts:1}` (sin retry) — con
    JUGAYGANA lento, los 3 intentos con backoff del default metían hasta ~40s de
    demora visible en la carga automática (reporte del owner: una carga tardó
    ~50s y otra ~11s). Es best-effort: si falla, el bono sale igual (fail-open).
  · Decisión en el helper: rama `app_20` con `preBalance > 500` → NO acredita,
    devuelve `skippedForBalance:true`. **Fail-open:** si la lectura de saldo falla
    (`preBalance` null), el bono sale como siempre — no se castiga al cliente por
    una lectura caída de JUGAYGANA (es flaky).
  · **Aviso al cliente EDITABLE:** comando nuevo `/sys_deposit_no_bonus_saldo`
    (sembrado en systemCmds; vaciarlo lo apaga). Variables: `{username}`,
    `{saldo}` (saldo previo), `{pctTodas}`, `{limite}`. La nota admin-only de la
    carga también dice "SIN bono 20%: saldo previo $X (más de $500)".
- **(3) Buscador de usuarios en "Reembolsos reclamados"** (panel admin, con captura):
  · Backend: `GET /api/admin/reembolsos` acepta `?search=` (substring
    case-insensitive con `escapeRegex`, máx 40 chars) que filtra SOLO la tabla de
    últimos reclamos (limit 120); las tarjetas de totales por tipo siguen globales.
  · Panel: input `#reembSearchInput` + botón "✕ Limpiar", estáticos en index.html
    (FUERA de `#reembolsosBody` para que el re-render no los pise). Debounce 350ms
    + Enter; guard anti-race (si el usuario siguió tipeando, la respuesta vieja se
    descarta); título de la tabla y empty-state reflejan la búsqueda.
- **Validado:** `node --check` OK (server.js, admin.js); 574/574 divs, ids únicos.
  Solo backend + panel (network-first) → **sin bump de `?v`**. Back necesita
  redeploy (siembra el comando nuevo). **PROBAR tras deploy:** (a) transferencia de
  $1.500–$1.999 → debe cargar automático; <$1.500 → needs_review; (b) carga
  automática de un cliente con app y saldo >$500 → carga SIN 20% + mensaje del
  comando nuevo; con saldo ≤$500 → 20% normal; (c) buscar un usuario en Reembolsos
  reclamados y ver solo sus reclamos.

## Sesión 2026-08-18

### 115. Cuatro reportes del owner: chat que se abre por reembolsos, [object Object], token FCM y falsos duplicados de comprobantes
- **(1) El reclamo de reembolso ya NO reabre el chat cerrado.** La confirmación
  "🎁 Reembolso X reclamado: $Y" la manda la PWA como mensaje del usuario
  (`refunds.js:328` → `/api/messages/send`) y la reapertura de chats cerrados la
  disparaba igual que cualquier mensaje. Nuevo `_isRefundClaimNotice(content)`
  (regex sobre el texto exacto, tipos en inglés y español): el mensaje se guarda
  y se ve en el chat, pero NO reabre el chat NI arranca el reloj de demoras
  (nadie tiene que responderlo). Guardas en `/api/messages/send` Y en el socket.
  Si un cliente tipea ese texto a mano, sólo "pierde" la reapertura automática.
- **(2) "[object Object]" al reclamar el diario** (Royalfabio880): los 3 claims
  concatenaban `depositResult.error` (objeto) → ahora pasan por
  `jugaygana.errToString`. **Causa de fondo del fallo real:** los logs muestran
  que los fallos de `creditUserBalance` de esa noche son casi todos
  `{"code":18,"message":"not enough money"}` → **la cuenta cajero de JUGAYGANA
  sin saldo** (el semanal de $31.200 salió y minutos después el diario de
  $31.960 no tenía fondos). El claim ya libera la reserva en ese caso
  (canClaim:true) → el cliente puede reintentar cuando haya saldo. Es
  OPERATIVO: mantener fondeada la cuenta cajero (2ª vez que aparece, ver #113).
- **(3) "Permiso concedido pero no se pudo obtener el token"** (argennestor531):
  el permiso de Android está OK pero `messaging.getToken()` (el registro contra
  los servidores de Google/FCM) falla — ya hay una estrategia de 3 niveles de
  reintento (getToken → deleteToken+getToken → re-registrar SW) y aun así no
  sale: es del lado del TELÉFONO/RED (señal 3G en la captura; típico también de
  Xiaomi/Oppo con servicios de Google restringidos). No hay fix de servidor
  posible sin debilitar la validación anti-truchos (el claim exige token FCM
  standalone real). Se mejoró el toast con pasos concretos (WiFi, cerrar/abrir
  la app, reintentar). HTML-only → sin bump.
- **(4) Falsos duplicados de comprobantes — 4 endurecimientos** en
  `analyzeComprobanteFromMessage`:
  · El combo fallback exige `originHolder` u `originCbu` (antes bastaba
    monto+fecha → dos clientes con $5.000 el mismo día = "mismo comprobante").
  · N° de operación con huella mínima de 6 caracteres (los cortos se repiten
    entre bancos).
  · `messageId: {$ne}` en la búsqueda: el mismo mensaje analizado 2 veces
    (socket+HTTP / reintento) ya no se marca duplicado de sí mismo.
  · Mensajes al agente con contexto: reenvío del MISMO cliente en <10 min =
    "reenvió recién, cargala UNA vez" (no alarma); duplicado de OTRO usuario
    distingue "imagen idéntica" (certeza) de "coinciden datos leídos por IA"
    (puede ser error de lectura, comparar a ojo).
- **Validado:** `node --check` OK. Back necesita redeploy; el cambio de
  index.html es sólo texto de toast (sin bump de `?v`).

## Sesión 2026-08-15

### 114. Aviso INTERNO de bono en el modal de depósito (cargas manuales)
- **Pedido del owner:** cuando el comprobante no matchea y el agente carga a mano,
  que el panel le AVISE qué bono automático le correspondería al cliente — pero
  **interno**: al cliente no le llega nada, y el aviso lo dice explícitamente
  ("🔒 AVISO INTERNO — el cliente NO ve este mensaje").
- **Backend:** `GET /api/admin/users/:userId/app-bonus-hint` (depositorMiddleware;
  sólo lectura, no consume nada). Devuelve `{hasApp, firstAvailable, firstPct,
  allActive, allPct, firstUsedBy}` con la MISMA lógica del bono automático
  (config del panel + detección app/notifs + cupón disponible + guard de
  dispositivo + vigencia de la promo).
- **Panel:** banner arriba del modal Depositar (`#depositAppBonusHint`, lo pinta
  `loadDepositAppBonusHint()` al abrir; async y best-effort — si falla, el modal
  sigue normal). 4 estados: primera carga disponible (+X%, dorado), 20% vigente
  (verde, muestra quién usó el 100% si aplica), app sin bono que corresponda, y
  sin app. Nada de esto envía mensajes al cliente.
- **Cierra el circuito con #113:** el agente aplica el % sugerido en "Bonificación
  extra" y, si es ≥100%, el cupón queda consumido solo.
- **Validado:** `node --check` OK (server.js, admin.js); 573/573 divs, ids únicos.
  Solo panel (network-first) + backend → sin bump de `?v`. Back necesita redeploy.

### 113. "Da 100% en todas las cargas" — NO era el auto-bono: eran bonos MANUALES + cupón sin consumir
- **Reporte del owner (capturas de JUGAYGANA + logs de las 2 instancias de EB):**
  clientes con 100% repetido en varias cargas (atodiego852, RoyalLuis613).
- **Diagnóstico (con línea de tiempo anclada):** el código del bono entró a
  producción a las **23:56 ART del 14/08** (deploy 02:56 UTC). TODOS los 100%
  duplicados de las capturas son ANTERIORES a esa hora → **bonos manuales de
  agentes** (el mensaje "instalá la app" les decía a los clientes "avisale al
  cajero"). Después del deploy, en TODO el log **ningún usuario recibió
  `install_100` dos veces**, y la marca persiste entre instancias (royalBrenda812:
  100% en una instancia a las 04:52 UTC → sus 2 cargas siguientes en la OTRA
  instancia salieron con 20%). El agujero real: **el bonus manual del agente no
  consumía el cupón**, así que el sistema después daba "su" 100% legítimo.
  Discriminador para auditar: en Transacciones, los automáticos figuran como
  `auto-hgcash`; los manuales llevan el nombre del agente.
- **Fix 1 (carga manual, server.js):** si el agente aplica un bonus manual
  **≥100% del monto**, se consume el cupón install-bonus-100 en esa misma
  operación (pendiente → usado; nunca reclamado → queda directamente consumido,
  `installBonus100UsedBy = '<agente> (bonus manual ≥100%)'`). Un bonus menor
  (20%, etc.) NO lo consume.
- **Fix 2 (migración one-shot `migration_install100_consume_manual_done`):**
  consume el cupón de todo usuario que YA tenga un Transaction de depósito con
  `bonus >= amount` (sólo los manuales usan ese campo; las auto-cargas no).
  Regla del owner que esto implementa: **UN 100% por cliente en TOTAL**.
- **Operativo (avisar a los agentes):** NO aplicar más el 100% "por instalación"
  a mano en cargas que van a entrar por hgcash — es automático. Conviene editar
  los comandos `/sys_install_app` y `/sys_install_bonus_100` desde el panel para
  que dejen de decir "avisale al cajero" (los textos viven en la DB; se editan
  desde COMANDOS).
- **Observación aparte de los logs:** ~01:05 ART la cuenta cajero de JUGAYGANA
  se quedó **sin saldo** ("not enough money") y un crédito de $360 a
  maresteban649 se reintentó muchas veces sin entrar. Revisar saldo de la cuenta.
- **Validado:** `node --check` OK. Solo backend → sin bump de `?v`. Back necesita
  redeploy (la migración corre sola al arrancar y loguea cuántos consumió).

### 112. El menú del home arranca OCULTO (invierte el arranque de siempre)
- **Pedido del owner:** que a los usuarios el menú ya les aparezca ocultado — "ahora
  es al revés". Una línea: `applyHomePanel(true, false)` en el init (app.js ~364).
  El toggle "Ver menú/Ocultar menú" queda igual; sigue sin recordarse el estado
  entre sesiones (antes siempre abierto, ahora siempre cerrado). Los reembolsos
  viven dentro del panel (#104) → arrancan ocultos también; RETIRAR MI PREMIO
  sigue afuera, siempre visible.
- **Validado:** `node --check` OK. **`?v=55` + `CACHE_VERSION='v55'`** (cambió JS:
  sin el bump, las PWAs cacheadas seguirían con el arranque viejo).

### 111. Los bonos automáticos hgcash se prenden/apagan y cambian de % desde el panel
- **Pedido del owner (mismo día que #110):** poder APAGAR el 20% y el 100% desde el
  panel "por las dudas que empiece a darle a todos", y que los porcentajes sean
  editables.
- **Config:** `Config['hgcashAppBonus']` = `{ firstEnabled, firstPct, allEnabled,
  allPct }` — defaults `{true, 100, true, 20}` (reproducen #110 sin tocar nada).
  Lectura con `getHgcashAppBonusConfig()` (sanitiza: % entero 1–200; ante error de
  DB usa defaults). La FECHA límite del bono "todas" (31/08 23:59 ART) queda fija
  en código (no se pidió editarla).
- **Comportamiento:** interruptor apagado = la carga entra igual, sin bono. Con el
  bono de primera carga APAGADO **NO se consume el cupón** (el chequeo está detrás
  del flag). El aviso `/sys_deposit_no_app_20` sólo se envía si hay al menos un
  bono prendido (y el de "todas", vigente) — no se promete nada apagado; ahora
  soporta variables `{pctPrimera}` y `{pctTodas}` con los % configurados.
- **Endpoints:** `GET/POST /api/admin/hgcash/app-bonus` (solo admin general, junto
  a los otros de hgcash). Panel: card nueva "🎁 Bonos automáticos hgcash (app +
  notificaciones)" en COMANDOS, debajo de Equipos (checkbox + % por bono, muestra
  el vencimiento; se oculta sola si no es admin general, mismo patrón que Equipos).
- **Validado:** `node --check` OK (server.js, admin.js); 572/572 divs, ids únicos.
  Solo panel (network-first) + backend → sin bump de `?v`. Back necesita redeploy.
  **PROBAR tras deploy:** apagar el 20% y hacer una carga automática con app (no
  debe bonificar ni consumir cupón si también está apagado el de primera); cambiar
  el % a otro valor y verificar el monto acreditado y el texto del aviso.

### 110. BONO AUTOMÁTICO en cargas hgcash: 100% primera carga + 20% todas (app + notifs)
- **Pedido del owner (2026-08-15), sólo para cargas AUTOMÁTICAS por hgcash** (las
  manuales las bonifica el agente a mano, como siempre):
  1. **100% en la primera carga** si el cliente tiene la **app instalada con
     notificaciones activas**. Es el MISMO cupón install-bonus-100 que ya existía:
     si lo tenía pendiente (reclamado desde la app) se consume automático; si nunca
     lo reclamó, se otorga y consume EN EL ACTO al detectar app+notifs. Queda
     plasmado (`installBonus100UsedAt`/`UsedBy='auto-hgcash'`) → **no se repite**.
  2. **20% en TODAS las cargas automáticas** mientras tenga app+notifs, **hasta el
     31/08/2026 23:59 ART** (`HGCASH_APP_BONUS_20_UNTIL`). No se acumula con el
     100% (la carga que lleva 100% no lleva además 20%).
  3. **Sin app y/o notifs:** la carga entra SIN bono y se le manda un aviso
     **editable** desde COMANDOS: **`/sys_deposit_no_app_20`** (vaciarlo lo apaga;
     sólo se envía mientras la promo del 20% esté vigente).
- **Detección app+notifs:** `_rouletteHasAppInstalled` (token FCM contexto
  `standalone`) — el mismo gate que la ruleta; ese token sólo existe con la PWA
  instalada Y el permiso de notificaciones concedido.
- **DECISIONES a registrar:**
  - El otorgamiento automático del 100% **NO exige teléfono verificado** (el claim
    manual desde la app sí lo sigue exigiendo). Automático por detección = sin
    fricción, decisión implícita del pedido. **SÍ se mantiene** el candado
    anti-multicuenta por dispositivo (`_installBonusDeviceFree`, mismo guard del
    claim; fail-closed ante error de DB).
  - Los que ya cobraron el bono viejo de $5.000 o ya usaron el cupón NO reciben el
    100% (`installBonusClaimed=true` los frena) — sí el 20%.
  - ⚠️ El 100% es **excepción explícita del owner al "tope 30% en todo lo
    automático"** (anotado en CLAUDE.md).
- **Implementación (server.js):** `_hgcashApplyAppBonus(user, amount)` llamado en
  `hgcashAutoCarga` después de acreditar la carga y ANTES de leer el balance (el
  saldo del mensaje ya incluye el bono). Marca atómica del cupón ANTES de acreditar
  (patrón reserva→acreditar de #96); si `creditUserBalance` falla, **deshace la
  marca** (el cupón vuelve a pendiente / el otorgamiento se revierte) y avisa al
  agente por nota admin-only para aplicarlo a mano. Pausa de 700 ms carga→bonus
  (rate-limit JUGAYGANA, causa del bug "carga sí, bonus no"). Bono registrado como
  `Transaction {type:'bonus', adminUsername:'auto-hgcash',
  metadata.source:'auto_hgcash_bonus', kind:'install_100'|'app_20'}`. El mensaje al
  cliente usa `/sys_deposit_bonus` cuando hubo bono (antes siempre `/sys_deposit`);
  la nota admin-only de la carga ahora dice qué bono se sumó. Un solo camino de
  carga automática (verificado: los demás `depositToUser` son manuales/devoluciones).
- **Nota:** el `bonus` del Transaction de la CARGA queda en 0 (el registro del bono
  es la Transaction 'bonus' separada, igual que el flujo manual que también la crea
  aparte). El aviso sin-app NO reutiliza `/sys_install_app` (su copy dice "avisale
  al cajero", obsoleto para el flujo automático).
- **Validado:** `node --check` OK. Solo backend → sin bump de `?v`. **Back necesita
  redeploy.** **PROBAR tras deploy:** (a) carga automática de un cliente con app+
  notifs que nunca reclamó el bono → +100% acreditado y marcado usado; (b) segunda
  carga automática del mismo → +20%; (c) cliente sin app → carga sin bono + aviso
  `/sys_deposit_no_app_20`; (d) cliente con cupón pendiente reclamado desde la app
  → la carga automática lo consume (+100%) y el banner del agente desaparece;
  (e) después del 31/08 23:59 ART → ni 20% ni aviso (el 100% sigue).

### 109. Los chats VACÍOS ya no aparecen en Abiertos (eran interminables)
- **Reportado por el owner (con screencast):** la pestaña Abiertos llena de chats
  "Sin mensajes" con fechas de junio; los cerraba a mano y aparecían más — inagotables.
- **Causa:** `Message` tiene TTL de 3 días pero `ChatStatus` queda `open` para siempre.
  Todo usuario que ingresó alguna vez recibió la bienvenida (que le creó el ChatStatus,
  server.js ~5431); al expirar sus mensajes el chat queda abierto y vacío. La purga
  one-shot previa (`migration_purge_empty_chatstatus_done`, #6, server.js ~8599) sólo
  cubría usuarios que NUNCA ingresaron — estos sí ingresaron. Con ~9k usuarios, los
  vacíos copaban el `$limit 100` del listado: cerrar uno hacía entrar al siguiente.
- **Fix (server.js, `GET /api/admin/conversations`):** para `status === 'open'` se agregó
  un `$match: {'lastMsg.0': {$exists: true}}` después del lookup del último mensaje —
  chat sin ningún mensaje no se lista. **No se toca la DB**: los ChatStatus siguen `open`;
  si el cliente escribe, vuelve a tener mensajes y reaparece solo (y la reapertura de
  cerrados ya existía en send_message). Con el paso del tiempo es automático: un chat sin
  actividad desaparece de Abiertos solo cuando su último mensaje expira (3 días), sin que
  ningún agente tenga que cerrarlo.
- **Alcance deliberado:** sólo Abiertos. **Pagos NO se filtra** (puede haber un retiro
  pendiente aunque los mensajes hayan expirado) ni Cerrados/Comunidad (archivo / no fue
  lo pedido; extender es trivial si molesta ahí también).
- **Bordes anotados:** (1) el `$limit 100` corre ANTES del filtro — no starvea porque un
  chat con mensajes vivos tiene `lastMessageAt` dentro del TTL y ordena arriba de los
  vacíos viejos; (2) "Enviar a abiertos" sobre un chat sin mensajes lo deja invisible en
  la lista hasta que alguien escriba (no hay nada que atender igual; el agente que lo
  movió ya lo tiene abierto en el panel derecho).
- **Validado:** `node --check` OK. Solo backend → sin bump de `?v`. **Back necesita
  redeploy.** PROBAR tras deploy: Abiertos debe quedar solo con chats con mensajes;
  escribirle a un chat vacío desde Usuarios/buscador y ver que aparece en Abiertos.

## Sesión 2026-08-14

### 108. Un solo lugar para el canal de Telegram (había DOS campos para lo mismo)
- **Detectado por el owner (con capturas):** en COMANDOS había **dos campos de canal de
  Telegram** y no se entendía cuál mandaba. Eran dos claves distintas de Config apuntando
  a dos elementos distintos de la app, que en la práctica había que llenar con el MISMO link:
  - `canalInformativoUrl` → el botón 📢 de la barra superior del cliente.
  - `communityConfig.channelUrl` → la tarjeta "Canal Exclusivo" del dashboard.
  Con los equipos (#106) se sumó un tercero (`teams.general.telegram`).
- **Unificado: el canal se configura SOLO en la card "👥 Equipos"** (uno por equipo + el
  general). Los DOS elementos de la interfaz —el botón 📢 y la tarjeta— lo resuelven ahora
  con el mismo criterio: canal del equipo → general de `teams` → `communityConfig.channelUrl`
  → `canalInformativoUrl` (los dos últimos, sólo como fallback legacy para no romper lo ya
  cargado). O sea: `GET /api/config/canal-url` pasó a resolver por equipo.
- **El SOPORTE queda GENERAL** (reiterado por el owner): la sección de COMANDOS se renombró
  a "💬 Soporte de Telegram (general)" y quedó con **un solo campo**, aclarando que es el
  mismo para todos los equipos y que los canales se cargan en Equipos.
- **Para no borrarle datos a nadie:** el panel ahora manda SOLO `supportUrl`, y
  `POST /api/admin/community` **conserva** el `channelUrl` guardado cuando no viene en el
  body (antes lo hubiera pisado con vacío).
- **Código muerto eliminado** (verificado por grep, 0 referencias vivas): `loadCanalUrlConfig()`
  y `saveCanalUrl()` del panel + su llamada. Los endpoints `/api/admin/config` y
  `/api/admin/canal-url` **se conservan** en el server como fallback legacy.
- **Validado:** `node --check` OK (server.js, admin.js); 565/565 divs, ids únicos, sin
  referencias huérfanas a los campos borrados. Solo panel + backend → **no hace falta
  bumpear `?v`** (el panel se sirve network-first).

### 107. El link de autologin salía con el dominio del PANEL, no con el público
- **Reportado por el owner:** al crear un usuario, el link de acceso sale con un dominio
  distinto al de `PUBLIC_BASE_URL`.
- **Causa:** `_publicBaseUrlFromRequest` armaba el link con el **host del request**, y el
  panel admin se sirve desde `ADMIN_HOST` (el dominio de Elastic Beanstalk,
  `autoreembolsosgirox.sa-east-1.elasticbeanstalk.com`), no desde el público. Así que todo
  link generado desde el panel salía con el dominio del panel.
- **Por qué NO era cosmético:** el link abre un **ORIGEN distinto**. Como `localStorage` es
  por origen, el usuario entraba y quedaba logueado **en el dominio equivocado**; al ir
  después a autoreembolsos.com tenía que loguearse igual, o sea que el link no cumplía su
  función. (Y en iOS, el traspaso de sesión a la PWA quedaba atado a ese otro origen.)
- **Fix:** ahora manda `PUBLIC_BASE_URL` **si está seteada de verdad en el entorno**
  (se lee `process.env` directo, NO la const, que tiene un default hardcodeado que taparía
  el caso "no configurada"). Sin ella, sigue el host del request — que igual es mejor que
  el default, porque ese apunta al dominio del OTRO proyecto.
- **⚠️ NO se tocó el webhook de cash-out de hgcash** (`server.js:13663`), que también se
  arma con el host del request. Es el mismo patrón pero **cambiarlo es riesgoso**: hoy
  apunta al hostname de EB, que **esquiva Cloudflare**. Si se lo pasa al dominio público y
  Cloudflare bloquea el POST server-to-server (le pasó a vipcargas en #66 y está anotado
  como riesgo para autoreembolsos en #94), **se romperían las confirmaciones de pago**. El
  protocolo sí está bien: `trust proxy` está en 1, así que `req.protocol` da `https`.
  Queda anotado como decisión consciente, no como olvido.
- **Validado:** `node --check` OK. Solo backend → no hace falta bumpear `?v`.

### 106. EQUIPOS por prefijo de usuario: Telegram propio + cartel de acceso por WhatsApp
- **Pedido del owner:** el proyecto lo operan **varios equipos**; cada uno tiene su grupo de
  Telegram y su número de WhatsApp. Se detecta a qué equipo pertenece cada cliente por el
  **INICIO de su usuario** (ej: prefijo `mar` → equipo Marshall). En la pantalla de login va
  un cartel diciendo que escriban al WhatsApp para pedir su acceso nuevo; si no saben a qué
  número, ponen su usuario y les aparece el botón del WhatsApp de SU equipo. Si no matchea
  ningún equipo → WhatsApp **general**.
- **DECISIÓN DEL OWNER (aclarada expresamente):** el **SOPORTE es lo ÚNICO general** —
  un solo soporte para TODOS los equipos. Lo que se divide por equipo es el **canal de
  Telegram** y el **WhatsApp del cartel de login**.
- **Modelo:** `Config['teams']` =
  `{ general: {telegram, whatsapp}, list: [{prefix, name, telegram, whatsapp}] }`.
  El equipo se calcula **al vuelo** desde el username; NO se guarda un campo en User, así
  que cambiar un prefijo se refleja al instante y no deja datos viejos.
- **Matcheo:** case-insensitive y **gana el prefijo MÁS LARGO** — así `mar` (Marshall) y
  `marte` (Marte) conviven sin que el corto le robe los usuarios al largo. Probado con
  `marcosVIP`, `MarShallPedro`, `marteLuis`, `MARTE99`, `mar`, `ma`.
- **Backend (server.js):** `getTeamsConfig()`, `resolveTeamForUsername()`,
  `buildWhatsappUrl()`; `GET /api/config/team?username=` (**PÚBLICO**, para el login) y
  `GET/POST /api/admin/teams` (solo admin general).
  🔒 El endpoint público **sólo compara prefijos contra la config**: no consulta la base ni
  revela si la cuenta existe, así que **no sirve para enumerar usuarios**. Devuelve el link
  de `wa.me` con el mensaje prellenado ("Hola! Mi usuario es X. Quiero mis datos de acceso
  para autoreembolsos.com"). Ya está cubierto por el `generalLimiter` de `/api/`.
- **`GET /api/config/community` ahora resuelve el canal por equipo:** Telegram del equipo →
  general de `teams` → `communityConfig.channelUrl` (compatibilidad con la config previa).
  **`supportUrl` NO se toca**: sigue siendo único para todos.
- **Front (login):** cartel `#teamAccessBanner` con input de usuario y botón. Si el campo
  está vacío usa el usuario que ya escribió en el formulario de login (no lo hace tipear dos
  veces). Enter también busca, sin enviar el form. Muestra el nombre del equipo detectado o
  avisa que va al soporte general.
- **Panel → COMANDOS:** card "👥 Equipos (por inicio del usuario)" con el bloque General y
  filas agregables/borrables (prefijo, nombre, Telegram, WhatsApp). Valida el prefijo contra
  el mismo alfabeto que los usernames (`[a-z0-9._-]{1,20}`) e ignora repetidos, avisando
  cuántas filas descartó. Solo admin general (si no, la card se oculta sola).
- **Validado:** `node --check` OK (server.js, app.js, admin.js); ids únicos y divs
  balanceados en los dos HTML (380/380 y 569/569); resolvedor probado con casos de solape.
  **`?v=54` + `CACHE_VERSION='v54'`.** Back necesita redeploy.
  **PROBAR tras deploy:** cargar 2 equipos con prefijos que se pisen (`mar` y `marte`) +
  el general; en el login poner un usuario de cada uno y verificar que el botón lleva al
  WhatsApp correcto; con un usuario que no matchee, que caiga al general; y entrar con una
  cuenta de equipo y ver que la tarjeta "Canal Exclusivo" muestra SU Telegram mientras que
  "Soporte" sigue siendo el mismo para todos.

### 105. Zona horaria del reembolso SEMANAL y MENSUAL (misma familia que #102)
- **Contexto:** en #102 se corrigió el diario, que evaluaba "qué día es hoy" con el reloj
  del PROCESO. El semanal y el mensual tenían el mismo bug (`getDay()`, `getDate()`,
  `setHours()`), documentado ahí como preexistente. El owner pidió arreglarlos.
- **El bug:** en EB el server corre en **UTC** y Argentina es **UTC−3**, así que el día del
  server arranca a las **21:00 ART**. Las ventanas reales eran:
  - Semanal: **domingo 21:00 → martes 20:59** (en vez de lunes y martes completos).
  - Mensual: desde **el día 6 a las 21:00**, y **se cerraba el último día del mes a las
    21:00**.
  - Los dos bordes malos, verificados forzando `TZ=UTC`:
    · **Martes 22:30 ART** (último día válido) → el sistema decía "no disponible" y el
      usuario **perdía la semana**.
    · **Día 31 a las 22:00 ART** → "no disponible", justo antes de que el período rote.
    · Y al revés, dejaba reclamar el **domingo a las 22:00** y el **día 6 a las 22:00**.
- **Fix:** helpers de fecha argentina en `models/refunds.js` (`_artParts`, `_artMidnight`,
  `_addDays`) y las dos funciones reescritas para decidir por el **día ARGENTINO**.
  `nextClaim` también pasa a ser medianoche ART real (antes devolvía las 21:00).
- **Además, mismo criterio que el diario:** `canClaimWeeklyRefund(userId, periodDateStr)` y
  `canClaimMonthlyRefund(userId, periodMonthStr)` ahora consultan el **periodKey EXACTO**
  del período que se va a reembolsar, así la puerta de UX coincide 1:1 con el candado del
  índice único. Se conserva un fallback (rango de fechas ART) por si alguien los llama sin
  período. Los 3 claims y el status resuelven el período ANTES de chequear la ventana.
- **Validado:** `node --check` OK; lógica probada con `TZ=UTC` (el escenario real de EB)
  contra los 4 bordes de arriba + cambio de año en el "próximo día 7" (dic → ene 2027).
  Sin cambios de front → **no hace falta bumpear `?v`/CACHE_VERSION**. Back necesita redeploy.

### 104. Los reembolsos vuelven a ocultarse con el menú (revierte #98)
- **Pedido del owner:** al ocultar el menú, el recuadro de reembolsos (diario/semanal/
  mensual) también tiene que desaparecer. En #98 se había hecho lo CONTRARIO —sacarlos
  fuera de `#homePanel` para que quedaran siempre visibles porque "es lo que más se usa y
  más retiene"— así que esto revierte esa decisión.
- **Cambio:** el bloque `.dash-refunds-sticky` se movió DENTRO de `#homePanel`, como su
  primer hijo. Con el panel abierto el orden visual queda igual que antes; al colapsar,
  se va con el resto. El botón **RETIRAR MI PREMIO sigue afuera** (siempre visible).
- **No hizo falta tocar JS:** el toggle calcula la altura con `scrollHeight` en cada
  click y usa `max-height:none` al expandir, así que agregar contenido al panel no
  requiere ajustes. Los selectores de reembolsos son todos `getElementById` planos, sin
  dependencia de la jerarquía → **JS viejo + HTML nuevo no rompe** (por eso NO se bumpeó
  `?v`/CACHE_VERSION: sólo cambió el HTML y un par de comentarios, regla de #97).
- Se corrigieron los comentarios de CSS y de `app.js` que afirmaban lo contrario, y se
  dejó anotado en el CSS por qué `.dash-refunds-sticky` conserva `width:100%` (si algún
  día vuelve a colgar de `.chat-section`, que es flex column, sin eso queda una pastilla
  angosta — la trampa que documentó #98).
- **Validado:** `node --check` OK (app.js), 377/377 divs, ids únicos, y verificado por
  índice que el bloque quedó entre `#homePanel` y `.home-dash`.

### 103. Post-deploy: carrera del índice entre instancias + 2 ruidos de arranque que mentían
- **Contexto:** primer deploy del código a EB con los logs de las DOS instancias a la vista.
  Confirmado en producción lo que decía #102: `[refund-index] el índice ... existe pero con
  opciones viejas (sparse)` — o sea que el candado anti-doble-cobro **efectivamente estaba
  mal creado** en la base real.
- 🔴 **CARRERA ENTRE INSTANCIAS (corregida).** Las dos instancias arrancaron en el mismo
  segundo, las dos detectaron el índice viejo y las dos hicieron `dropIndex`: una logueó
  "✅ CREADO" y la otra murió con `Index build failed ... caused by :: dropIndexes command`.
  El drop de la segunda puede haber abortado el build de la primera → **el índice podía
  quedar en cualquiera de los dos estados y el log no lo decía.** Fixes:
  1. **Candado entre instancias** usando la unicidad de `Config.key`
     (`refund_index_repair_lock`): sólo la instancia que gana el insert atómico repara; las
     demás loguean y siguen. Lock viejo (>10 min, instancia muerta a mitad) se toma igual.
     Se libera al terminar, también por el camino de error.
  2. **Se relee el estado justo antes de dropear** (entre el chequeo inicial y ese punto
     puede pasar un rato: el backfill recorre la colección).
  3. **Verificación final leyendo de la DB**, en vez de confiar en que `createIndex` no
     tiró: el log ahora dice `✅ ACTIVO (verificado)` o `⛔ el índice NO quedó creado — EL
     SISTEMA ESTÁ SIN CANDADO`. Antes podía decir "CREADO" y ser mentira.
- **Ruido de arranque #1 — `ERR_ERL_UNKNOWN_VALIDATION` (corregido).** `generalLimiter`
  pasaba `validate: { keyGeneratorIpFallback: false }`, opción que la versión instalada de
  express-rate-limit **no conoce**: tiraba un ValidationError con stack completo en CADA
  arranque (parecía un crash) y encima ignoraba la opción. Eliminada — la validación que
  desactivaba sólo emite un aviso, no cambia comportamiento.
- **Ruido de arranque #2 — aviso FALSO de `ALLOWED_ORIGINS` (corregido).** El chequeo estaba
  en el cuerpo del módulo, que se evalúa **ANTES** del bootstrap que carga SSM: con la var
  correctamente cargada en SSM, el warning de "CORS rechazará orígenes cruzados" saltaba
  igual **siempre**. CORS en realidad funcionaba bien (lee la env lazy, por request). El
  aviso se movió después de `loadSecretsFromSSM`. ⚠️ Es la MISMA familia de problema que
  `PROXY_URL`/`PUBLIC_BASE_URL`: **cualquier lectura de `process.env` en el cuerpo del
  módulo pasa antes de SSM.**
- **Observaciones de los logs (no se tocaron):**
  - La `MONGODB_URI` no trae nombre de base → Mongo usa **`test`** (se ve en
    `Collection test.refundclaims`). Funciona y los datos reales están ahí, pero conviene
    nombrarla explícitamente en la URI para que no sorprenda.
  - `The deployment used the default Node.js version ... instead of the one in package.json`.
  - Siguen los 2 avisos de índice duplicado de Mongoose (`clickedAt`, `nextRetryAt`):
    cosméticos, es `index: true` + `schema.index()` sobre el mismo campo.
  - El proxy anda y rota IP en cada arranque; JUGAYGANA loguea OK y las cargas funcionan.
  - `refund_daily_restore: comandos actualizados: 0` — correcto: la migración de #97 ya
    había dejado el texto nuevo (que ahora incluye DIARIO), así que no había qué reemplazar.

### 102. VUELVE EL REEMBOLSO DIARIO (en todo el repo) + modal "MI MES" + tarjetas de Telegram
- **Pedido del owner:** (a) reimplantar el reembolso DIARIO que se había eliminado en #97,
  en TODO el repo y sin fallas; (b) que el recuadro USUARIO del dashboard sea clickeable y
  explique los rangos, cuánto le corresponde y el % — que se note que tiene función;
  (c) mejorar el bloque de soporte de Telegram, que "se ve mal", tomando la URL de la DB
  que se carga en COMANDOS.
- **DECISIONES DEL OWNER (para no volver a discutirlas):**
  1. El diario usa **el MISMO % del rango** (bronce/plata/oro) que el semanal y el mensual,
     **todo editable desde el panel → COMANDOS**. Un solo juego de rangos para los tres.
  2. Los tres reembolsos **SE SOLAPAN a propósito**: el día de ayer también cae dentro de
     la semana y del mes que se reembolsan, así que un cliente puede cobrar por la misma
     pérdida en los tres. **NO se descuentan entre sí** (igual que el solape preexistente
     entre semanal y mensual de #73). Queda documentado como comportamiento buscado.
- **Mapeo previo con 3 agentes de sólo-lectura** (reembolsos punta a punta, soporte/comandos,
  dashboard/modales) antes de tocar una línea; después una **revisión adversarial** con un
  cuarto agente sobre el diff.
- **Backend del diario:**
  - `canClaimDailyRefund` RESTAURADA en `models/refunds.js` (+ export). Una por día
    calendario; la ventana se reabre a las 00:00.
  - `POST /api/refunds/claim/daily`: de stub a implementación completa, **calcada del claim
    semanal** (que es el patrón ya probado): lock → canClaim → `resolveJugayganaUserId` →
    rango de AYER (`getYesterdayRangeArgentinaEpoch`, ya existía y estaba exportado) →
    NETWIN (`refund-daily`) → guard `netLoss === 0` → rango del mes → guard
    `refundAmount <= 0` **ANTES de reservar** → **reserva atómica `RefundClaim.create` con
    `periodKey: 'daily:YYYY-MM-DD'` ANTES de acreditar** (patrón #96: el índice único
    `userId+type+periodKey` es el candado real, no el lock Redis) → `creditUserBalance` con
    `jugayganaUserId` → si falla, `deleteOne` de la reserva → Transaction → Meta CAPI
    (`refund_daily`) → `releaseRefundLock` a los 3 s.
  - `GET /api/refunds/status`: el `daily` inerte pasó a ser real (4ª llamada NETWIN en
    paralelo, `canClaimDailyRefund`, `dailyTier`, `dailyPotential`, `period`).
  - **Qué mes define el rango del diario:** el mes al que pertenece AYER. Casi siempre es el
    mes en curso; el único borde es el **día 1**, donde ayer cayó en el mes anterior → se usa
    ESE mes completo (misma lógica que el semanal, para no descartar la pérdida acumulada).
  - `_generateExampleClaims` vuelve a incluir `'daily'` en el ticker.
- **Reglas push B1/B2 restauradas** (`notificationRulesService.js`) con copys sin % fijo
  (ahora depende del rango). ⚠️ Se siembran **DESACTIVADAS** como todas las de refund
  (`_seedDisabledAudiences`) — no se activan envíos masivos por migración; las prende el
  owner desde el panel. Además la audiencia `refund-pending-daily` depende de
  `DailyPlayerStats`, que **no está portado**: hasta entonces devuelve vacío y no dispara.
- **Migración one-shot `migration_refund_daily_restore_done`:** actualiza por SUBSTRING los
  comandos que quedaron diciendo "SEMANAL y MENSUAL" para que vuelvan a nombrar los tres.
  También se actualizaron los fallbacks hardcodeados y los seeds de `/sys_welcome`,
  `/sys_deposit` y `/sys_deposit_bonus`. ⚠️ Si el owner editó esos textos a mano el
  substring no matchea: revisar COMANDOS buscando "SEMANAL y MENSUAL".
- **Front del diario:** botón `#dailyRefundBtn` (verde, para distinguirlo del violeta
  semanal y el rojo mensual), `.refund-btn.daily` en `header.css`, listener en `app.js`,
  `updateRefundButton('daily')`, tooltip, `#unifiedDailyPct` y botón propio en el modal
  unificado, rama `daily` en `showRefundModal` (countdown hasta las 00:00), card en el
  infoModal. El panel admin dejó de decir "Diarios (descontinuado)".
- **Modal "MI MES" (NUEVO):** la card `.dash-user` era **la única del dashboard sin
  ninguna acción**; ahora abre `#myMonthModal` y lleva un chip dorado "VER MI MES ›" +
  `cursor:pointer` + borde dorado para que se note. El modal muestra: rango con su emoji y
  su %, la pérdida (NETWIN) del mes que lo define, la tabla 🥉🥈🥇 con el actual resaltado
  ("◄ VOS"), cuánto falta para subir, y **una tarjeta por cada reembolso** (diario/semanal/
  mensual) con el monto disponible, el período, la pérdida y si está listo para reclamar;
  cierra con una explicación de que son independientes y que se calculan sobre NETWIN.
  Todo sale de `/api/refunds/status` (ya cacheado); si no está, lo pide antes de pintar.
- **Tarjetas de Telegram rehechas:** el bloque lo cargaba un **script inline en index.html
  con polling de 1 s × 25** esperando el token — si el login tardaba más de 25 s, no
  aparecía nunca. Ahora es `VIP.ui.loadCommunityLinks()`, llamado desde `initializeSession`
  como el resto. Visual: se apilan en pantallas angostas (`flex-wrap` + `flex:1 1 190px`,
  antes se apretaban y cortaban el texto), avatar en círculo, chevron ›, feedback al tocar,
  y el **soporte pasó a VERDE** (era violeta, se confundía con el canal). Copys más claros:
  "Canal Exclusivo / Promos y sorteos" y "Soporte 24/7 / Te respondemos al toque".
  ⚠️ **Las URLs salen de `Config['communityConfig']`** (`channelUrl`/`supportUrl`), que se
  edita en el panel → COMANDOS. En la captura del owner sólo se veía el canal porque
  `supportUrl` está VACÍA: hay que cargarla ahí para que aparezca la tarjeta de soporte.
- **REVISIÓN ADVERSARIAL (agente sobre el diff) — 1 bug REAL corregido + 1 blindaje:**
  - 🔴 **BUG DE ZONA HORARIA (corregido).** `canClaimDailyRefund` comparaba "día
    calendario" con `toDateString()`, que usa la TZ del **proceso**: en EB es **UTC**, y
    Argentina es UTC−3. O sea que el "día" del server arrancaba a las **21:00 ART**.
    Un usuario que reclamaba a las 22:00 ART quedaba marcado como "ya reclamó hoy" hasta
    las 21:00 del día siguiente (**~21 h de bloqueo falso**) y, si no volvía después de esa
    hora, **PERDÍA ese período para siempre**. En la práctica: todo el que reclama de noche
    perdía uno de cada dos reembolsos diarios. **Fix:** `canClaimDailyRefund(userId,
    periodDateStr)` ahora consulta el **periodKey EXACTO** del día a reembolsar → la puerta
    de UX coincide 1:1 con el candado del índice único y deja de depender de la TZ del
    server. `nextClaim` pasa a ser la próxima medianoche **argentina** real
    (`_nextArgentinaMidnightISO`, ART = UTC−3 fijo, sin horario de verano). Verificado
    forzando `TZ=UTC`: 22:00 ART → devuelve 00:00 ART del día siguiente (el método viejo
    devolvía las 21:00 ART, un día entero tarde).
    ⚠️ **Los reembolsos semanal y mensual tienen la MISMA familia de bug** (usan `getDay()`
    y `getDate()`, también en UTC → la ventana semanal real es domingo 21:00 → martes
    20:59 ART). Es PREEXISTENTE y no se tocó en esta tanda; queda anotado para arreglarlo.
  - **Blindaje de la reserva:** el `creditUserBalance` del diario quedó en su propio
    try/catch que **borra la reserva antes de propagar**. Si JUGAYGANA tiraba una excepción
    (en vez de devolver `success:false`) justo ahí, el `RefundClaim` quedaba huérfano y el
    usuario perdía el día sin cobrar. Importa más en el diario que en el semanal porque se
    reclama 7× más seguido. También se envolvió el `Transaction.create` posterior: si falla
    DESPUÉS de acreditar, se loguea pero ya no devuelve "Error del servidor" a alguien que
    sí cobró.
  - **Confirmado OK por la revisión** (no se tocó): el orden reserva→acreditar, el guard de
    $0 antes de reservar, el borde del **día 1** en el cálculo del rango (status y claim
    coinciden), el contrato completo del objeto `daily` contra los 3 consumidores del front,
    `showMyMonthModal` sin caminos de TypeError (todos los accesos guardados, incluido
    backend viejo sin `s.daily`), ids únicos y modal bien anidado, y compatibilidad en las
    dos direcciones con clientes cacheados (JS viejo + back nuevo, y JS nuevo + back viejo
    durante el rolling deploy).
- 🔴 **ÍNDICE ANTI-DOBLE-COBRO: estaba MAL DECLARADO — corregido y ahora se auto-repara.**
  Toda la garantía de que un reembolso no se paga dos veces descansa en el índice único
  `{userId, type, periodKey}` de `refundclaims` (el RefundClaim se crea ANTES de acreditar;
  el E11000 aborta el pago — #96). Estaba declarado con **`sparse`**, y en un índice
  **COMPUESTO** `sparse` sólo excluye el doc si le faltan TODOS los campos: como `userId`
  siempre existe, los claims viejos con `periodKey` null quedaban indexados como null y, con
  dos o más, **la creación del índice fallaba EN SILENCIO** → el sistema podía estar
  corriendo sin ningún candado. (El header de `scripts/migrate-refund-periodkey.js` ya
  documentaba esto desde hacía meses, pero el modelo nunca se corrigió y el script era
  manual: probablemente nunca se corrió.)
  - **Modelo corregido:** `partialFilterExpression: { periodKey: { $type: 'string' } }` en
    lugar de `sparse` (`src/models/RefundClaim.js`).
  - **Rutina de arranque nueva (`[refund-index]` en server.js), en CADA boot:** si el índice
    ya está bien, es sólo una lectura de metadatos (barato, no toca la colección). Si no:
    (1) rellena los `periodKey` faltantes, (2) busca duplicados reales, (3) borra el índice
    viejo y crea el correcto. Si encuentra **duplicados** (= alguien cobró dos veces el mismo
    período en el pasado) **NO borra nada** —son registros de plata— y loguea en ERROR la
    lista con un aviso de que el sistema está sin candado, para que el owner los resuelva.
    Nunca tumba el arranque.
  - **Bug del backfill corregido:** el script viejo derivaba el `periodKey` de la fecha del
    RECLAMO, pero el período reembolsado es otro (el diario paga AYER, el semanal la semana
    PASADA, el mensual el mes PASADO) → generaba claves corridas que no coinciden con las del
    código vivo. La rutina nueva prioriza el campo `period` que guarda el propio claim y sólo
    cae a derivar de `claimedAt` restando un período. Verificado con casos borde (día 1,
    cambio de año, lunes vs martes). El script quedó marcado como OBSOLETO — no correrlo.
- **⚠️ Consecuencia del solape que el owner aceptó, con el número concreto:** un cliente que
  reclama los tres cobra ~**3× el % de su rango** sobre la misma pérdida → en 🥇 Oro son
  **30% de cashback**. Roza el "tope 30% en TODO lo automático" documentado en CLAUDE.md.
  Es lo que el owner pidió explícitamente; queda registrado por si más adelante quiere
  descontarlos entre sí.
- **Nota de carga:** `/api/refunds/status` pasó de 3 a **4 llamadas NETWIN concurrentes** a
  JUGAYGANA (+33%), y `getUserNetwinForDateRange` **no cachea**. Corre en cada
  `initializeSession` y tras cada reclamo. Si la del diario falla, `dailyNetLoss` cae a 0 y
  el cliente ve $0 — indistinguible de no tener pérdida. `showMyMonthModal` usa el estado ya
  cacheado a propósito (no dispara otra tanda de llamadas).
- **Validado:** `node --check` OK en los 9 archivos tocados; ids únicos y `<div>` balanceados
  (377/377) en index.html. **`?v=53` + `CACHE_VERSION='v53'`** (HTML+JS+CSS juntos, regla
  de #97). Sin migraciones de datos destructivas. **Back necesita redeploy.**
  **PROBAR tras deploy:** reclamar el diario (monto = % del rango sobre la pérdida de ayer),
  reclamarlo dos veces seguidas (la segunda debe rechazar), tocar la card USUARIO (modal MI
  MES con los 3 reembolsos), cargar `supportUrl` en COMANDOS y ver la tarjeta de soporte,
  y abrir con una PWA vieja cacheada (no debe romper).

## Sesión 2026-08-13

### 101. PWA en iOS: la app instalada arranca con la sesión ya iniciada (traspaso por `start_url`)
- **Problema (confirmado por el owner en un iPhone real):** al agregar la app a inicio desde
  Safari, la PWA **abre pidiendo login** aunque en Safari la sesión siga abierta. Causa: en
  iOS la web app de la pantalla de inicio corre en **su propio contenedor de almacenamiento**,
  separado de Safari → no hereda `localStorage`, donde vive `userToken`. **En Android/Chrome
  y escritorio NO pasa**: la app instalada comparte origen y storage, así que ya arrancaba
  logueada (`app.js:10` lee el token y llama a `verifyToken()`).
- **Verificado antes de tocar nada:** el `start_url` del manifest era `/?source=pwa` estático
  y **`source=pwa` no lo leía NADIE** (grep en todo el repo: sólo aparecía en manifest.json).
  No había ningún mecanismo de traspaso.
- **Solución (reusa el canje del autologin de #100):** el `start_url` es la ÚNICA URL que se
  ejecuta DENTRO del contenedor de la app, así que es por donde se puede pasar la sesión.
  1. `POST /api/auth/pwa-session-token` (autenticado): el usuario pide un token **para sí
     mismo**. TTL corto (`PWA_SESSION_TTL_MINUTES`, **30 min** — se usa en el acto) y **NO
     toca `mustChangePassword`** (a diferencia del link de admin: acá ya tiene contraseña).
     Sólo para `role: user`.
  2. `GET /manifest.json?al=TOKEN` (ruta nueva ANTES de `express.static`): devuelve el mismo
     manifest pero con `start_url: "/?al=TOKEN"`. **`id` y `scope` quedan intactos** — si
     cambiaran, el navegador lo tomaría como otra app. Sin `?al` o con formato inválido cae
     al static de siempre. `Cache-Control: no-store, private` (es de un solo usuario y un
     solo uso). Filtro de forma del token (`^[A-Za-z0-9_-]{20,120}$`) probado contra path
     traversal y basura.
  3. `primePwaSessionHandoff()` (ui.js): al mostrar las instrucciones de instalación **de
     iOS**, pide el token y reescribe el `href` del `<link rel="manifest">`. Fire-and-forget
     a propósito (el usuario todavía tiene que abrir el menú Compartir, sobra tiempo) y
     best-effort: si falla, se instala igual y pide login una vez, como hoy.
  4. Al abrir la app, `consumeAutologinFromUrl()` (ya existía) canjea el token y deja la
     sesión armada adentro del contenedor.
- **⚠️ Trampa que cazó la revisión y HABÍA que resolver:** iOS abre el `start_url` en **CADA
  arranque**, así que del segundo en adelante el token ya está usado y el canje falla. Sin
  fix, el usuario habría visto un toast de error **cada vez que abre la app**. Ahora
  `_runAutologin` distingue: si el canje falla **y ya hay sesión**, sigue de largo en
  SILENCIO (`verifyToken()`); sólo avisa cuando NO hay sesión (ahí el error sí es útil:
  el link venció o ya se usó).
- **Comparte los campos `autologin*` de User** con el link de admin: pedir un token de PWA
  PISA un link de admin vivo para ese usuario. Benigno y documentado — sólo puede pasar si
  el usuario ya está logueado, y en ese caso no necesita el link (el admin lo regenera con
  un clic).
- **Validado:** `node --check` OK (server.js, ui.js, auth.js); manifest sigue siendo JSON
  válido tras inyectar `start_url`; filtro del token probado con casos maliciosos.
  **NO hace falta bumpear `?v`/CACHE_VERSION** (index.html no se tocó; el href del manifest
  se reescribe en runtime). Back necesita redeploy. **PROBAR EN UN IPHONE REAL:** logueado en
  Safari → Instalar App → Agregar a inicio → abrir el ícono (debe entrar SIN pedir login) →
  **cerrarla y volver a abrirla** (debe seguir logueada y SIN toast de error).
  ⚠️ Que iOS respete el `start_url` del manifest al agregar a inicio es lo que marca el
  estándar, pero Apple cambió el comportamiento entre versiones — si no funciona, el
  siguiente intento sería que el propio `start_url` NO se canjee sino que la app pida la
  sesión de otra forma. Degrada sin romper: si iOS lo ignora, queda el login de hoy.

### 100. LINK DE AUTOLOGIN (alta por agente) + el registro público deja de vincular cuentas de JUGAYGANA
- **Contexto (decisión del owner):** se va a reemplazar el proyecto **autoreembolsos** por
  ESTE código. autoreembolsos entra con usuario SIN contraseña; vipcargas pide contraseña.
  Requisitos: (a) el que ya tiene sesión iniciada NO la pierde; (b) el que no la tiene, el
  agente le crea la cuenta desde el panel (se vincula sola a JUGAYGANA) y le manda un
  **link de autologin** por WhatsApp; (c) al entrar, cambio de contraseña OBLIGATORIO con
  SMS **omitible**, pero SMS **obligatorio para retirar**.
- **Auditoría de compatibilidad de sesiones (con la IA del otro repo):** son el mismo
  linaje de código → `JWT_SECRET`, claim `userId`, `localStorage['userToken']`,
  `User.findOne({id})` y hasta el nombre del service worker (`firebase-messaging-sw.js`,
  scope `/`) COINCIDEN. **Las sesiones sobreviven** con: mismo valor de `JWT_SECRET`
  (está en SSM del proyecto viejo), misma `MONGODB_URI` y mismo dominio. NO hace falta
  ningún shim de localStorage.
- **Lo que YA existía y NO se tocó** (verificado leyendo el código): modal forzado de
  contraseña (`mustChangePassword` + allow-list en authMiddleware), crear contraseña sin
  saber la anterior, **omitir el SMS** (`POST /api/auth/change-password/pending` → deja
  `phoneVerificationPending:true`; botón "📲 Entrar de forma temporal" ya en el modal,
  index.html:1081) y **SMS obligatorio al retirar** (`/api/withdraw` corta con
  `phoneVerified !== true`). Los 2 endpoints de alta por admin (`POST /api/users` y
  `POST /api/admin/users`) YA validan que el username no exista local y YA vinculan la
  cuenta de JUGAYGANA vía `syncUserToPlatform`.
- **Registro PÚBLICO ya no vincula (server.js, los 2 endpoints):** si `syncUserToPlatform`
  devuelve `alreadyExists`, ahora responde 400 `USERNAME_TAKEN` ("Ese nombre de usuario ya
  está en uso. Si ya tenés una cuenta, iniciá sesión."). **Por qué:** en el registro el
  username es la ÚNICA prueba de identidad → cualquiera podía registrarse con el nombre de
  otro y quedarse con su cuenta Y SU SALDO. Era preexistente (el camino `found` vinculaba
  desde siempre), pero se vuelve crítico al migrar una base donde el 100% de los usuarios
  existe en JUGAYGANA. **Regla del owner: vincular es potestad del ADMIN, no del registro.**
- **Link de autologin — NUEVO:**
  - Campos en User: `autologinTokenHash` (SHA-256; el claro vive SOLO en el link),
    `autologinExpiresAt`, `autologinUsedAt`, `autologinCreatedBy` (auditoría) + índice
    sparse por hash. Un link nuevo PISA al anterior (uno vivo por usuario).
  - `POST /api/admin/users/:id/autologin-link` — **admin general únicamente** (generar el
    link ES entrar a la cuenta; mismo criterio que el reset de contraseña) y **nunca sobre
    staff**. Setea `mustChangePassword:true`. Devuelve `{ link, expiresAt, expiresInHours }`.
    TTL por `AUTOLOGIN_TTL_HOURS` (**72 h**, elegido por el owner) y **UN SOLO USO**.
  - `POST /api/auth/autologin` — público. **Es POST a propósito: WhatsApp/Facebook visitan
    los links para armar la vista previa y con un GET el crawler quemaría el token de un
    solo uso antes de que el usuario lo abriera.** El "un solo uso" se garantiza con
    **reserva atómica** (`findOneAndUpdate` con `autologinUsedAt:null` + no vencido en el
    FILTRO) — mismo patrón que #96; sin eso sería un TOCTOU. Errores sin distinguir
    "no existe"/"vencido"/"usado" (no dar información a quien pruebe tokens).
  - SHA-256 y no bcrypt a propósito: el token tiene 256 bits de entropía real (no es una
    contraseña humana) y el canje tiene que ser una lectura indexada barata.
  - Base del link: se arma con el **host del REQUEST** (el mismo código va a correr en
    vipcargas Y en autoreembolsos; el panel siempre se abre desde el dominio correcto),
    con `PUBLIC_BASE_URL` como override. ⚠️ `PUBLIC_BASE_URL` se lee al arrancar, ANTES
    del bootstrap SSM → va como env property de EB, NO en SSM (mismo gotcha que PROXY_URL).
  - PWA: `consumeAutologinFromUrl()` (auth.js) detecta `?al=TOKEN`, **limpia la URL con
    `replaceState` ANTES de cualquier await** (que no quede el token en la barra si
    recarga o comparte) y canjea por POST. `app.js` la llama ANTES de `verifyToken` y
    aborta el arranque normal si había token.
  - Panel: botón 🔗 en la fila del usuario (solo admin general, no staff) → confirm →
    copia el link al portapapeles, con fallback a `prompt()` si el navegador lo bloquea.
- **CERRADO el atajo de la contraseña fija `asd123` (pedido del owner, mismo día):**
  - **Antes:** el login importaba al usuario de JUGAYGANA creándolo con `password:'asd123'`
    FIJA y recién después comparaba contra ese mismo valor → **quien supiera un username
    entraba escribiendo "asd123"** y se quedaba con la cuenta. Encima había un fallback
    explícito (server.js ~3546) que aceptaba `asd123` para `source==='jugaygana'` sin
    `passwordChangedAt`.
  - **Ahora:** la importación valida la contraseña **contra JUGAYGANA**
    (`jugayganaService.loginAsUser`) ANTES de crear nada, y guarda la contraseña REAL del
    usuario (hasheada por el pre-save). El fallback explícito se ELIMINÓ (lápida en el
    código; rollback por `git revert`).
  - **`loginAsUser` ahora marca `transient:true`** cuando la plataforma no respondió (HTML
    de Cloudflare / timeout / red). El login lo traduce a **503 `PLATFORM_UNAVAILABLE`**
    ("probá en 1-2 minutos") en vez de "credenciales inválidas": decirle eso a alguien que
    tiene la contraseña bien lo manda a resetearla al pedo.
  - Guard nuevo: sin `password` no se importa nada (el `temporaryCode` sólo puede existir
    para un usuario que YA está en esta base).
  - **DECISIÓN DEL OWNER (2026-08-13), para no volver a discutirla:**
    1. **NO se usan contraseñas aleatorias.** La contraseña elegida por quien crea la
       cuenta vale para vipcargas Y para JUGAYGANA (ya es así: registro y altas de admin
       propagan la contraseña elegida). **Si un admin elige `asd123`, está perfecto** — el
       problema nunca fue el valor, sino que apareciera SIN que nadie lo eligiera.
    2. **NO se fuerza el cambio de contraseña** a los usuarios que hoy tienen `asd123`
       guardada. "Si deciden tener esa, que la tengan." (Coherente con la remoción previa
       del forzado, server.js:3552.)
  - **`asd123` residual del lado de JUGAYGANA — analizado, NO es un agujero de vipcargas:**
    el auto-alta de `depositToUser`/`withdrawFromUser` crea la cuenta EN LA PLATAFORMA con
    `asd123` (ídem el sync de admin, server.js:5527, y el default `|| 'asd123'` de
    `syncUserToPlatform`). **Verificados los 9 call sites de deposit/withdraw: TODOS parten
    de un usuario que ya existe en la base de vipcargas.** Y la validación contra JUGAYGANA
    sólo corre en la importación del login, o sea cuando el usuario NO existe localmente
    → para estas cuentas nunca se ejecuta: el login compara contra la contraseña real
    guardada acá. **Conclusión: ese `asd123` no habilita ningún acceso a vipcargas.** Lo
    único que queda es que su contraseña EN el sitio de JUGAYGANA sea `asd123`, relevante
    sólo si el usuario entra directo a la plataforma. No se cambia nada.
  - **Cuándo se dispara ese auto-alta** (es una red de reparación, no un camino normal):
    cuando el usuario existe en vipcargas pero NO en JUGAYGANA — porque la creación en la
    plataforma al registrarse/crear por admin es **fire-and-forget** (`.then()` sin await,
    server.js:5180: si falla no se reintenta ni se registra el error, el user queda en
    `jugayganaSyncStatus:'pending'`), o porque borraron la cuenta del lado de la plataforma.
- **Pendiente de la migración (no hecho todavía):** script one-shot que ponga
  `mustChangePassword:true` a los usuarios sin contraseña real y normalice los roles que
  vipcargas no acepta (`closings_viewer`/`roulette_viewer` no están en el enum de
  `User.js:80` → ValidationError en el primer `save()`); parche para que los tokens
  legacy con `scope:'refunds-only'` no queden como tokens de privilegio TOTAL (vipcargas
  ignora `scope`); y verificar `referralCode` (unique+sparse: los nulls explícitos rompen
  la construcción del índice). ⚠️ El login **auto-limpia** `mustChangePassword` si el
  usuario entra con `asd123` (server.js:3568) — puede desarmar la migración.
- **Validado:** `node --check` OK en los 5 archivos (server.js, User.js, auth.js, app.js,
  admin.js). Sin migraciones de datos (los campos nuevos son opcionales; el índice lo crea
  Mongoose por autoIndex). **Back necesita redeploy.** **`?v=52` + `CACHE_VERSION='v52'`**
  (HTML y JS cambiaron juntos por el ajuste del teléfono opcional — regla de #97).

- **AJUSTE tras probar el link en producción (mismo día):** el modal de cambio obligatorio
  pedía el teléfono como **obligatorio** (captura del owner). El botón "📲 Entrar de forma
  temporal" existía pero vivía en el **paso 2** (la pantalla del OTP), o sea que había que
  cargar un teléfono y pedir el SMS para siquiera poder omitirlo. Ahora, **solo dentro del
  cambio OBLIGATORIO** (`VIP.state.passwordChangePending`): el campo deja de ser `required`,
  el label dice "(opcional)", el texto de ayuda avisa que **para RETIRAR va a necesitar
  verificarlo por SMS**, y `handleChangePassword` suma el **CASO A2** (sin teléfono y sin
  teléfono verificado → commitea directo). El backend ya lo aceptaba sin tocar nada:
  con `mustChangePassword:true` no pide la contraseña actual y con `requestedPhone` null
  deja `isPhoneChange` en false. El usuario entra con `phoneVerified:false` → `/api/withdraw`
  lo frena al retirar, que es exactamente lo pedido. Fuera del cambio obligatorio el
  teléfono sigue siendo obligatorio (ahí no hay urgencia de dejarlo entrar).
  IDs nuevos en index.html (`changePasswordWhatsAppLabel`, `changePasswordWhatsAppHint`)
  para no depender de `querySelector` posicional. `_commitPasswordChange` refresca el
  banner de "verificá tu teléfono" al cerrar, así el usuario ve enseguida lo que le falta.

- **AJUSTE 2 — el link se muestra en un recuadro y sale solo al crear el usuario** (pedido
  del owner tras usarlo): antes el link se copiaba al portapapeles con un toast, y si el
  navegador bloqueaba el portapapeles caía a un `prompt()` feo. Ahora hay un modal
  `autologinLinkModal` (adminprivado2026/index.html) con el **username** bien visible, el
  link en un `<textarea>` seleccionable (click = select all), el aviso de un-solo-uso +
  vencimiento, y botón "Copiar de nuevo". **Se copia solo al abrirse.**
  `copyAutologinLink()` usa `navigator.clipboard` con fallback a `execCommand('copy')`
  (navegadores que niegan el permiso o contextos sin HTTPS) y, si nada funciona, deja el
  texto seleccionado y lo avisa en amarillo — el link nunca se pierde.
  **Además: al crear un usuario desde el panel** (`role === 'user'`, admin general), el
  link se genera y se muestra AUTOMÁTICAMENTE — es el paso siguiente natural del alta.
  `generateAutologinLink` acepta `{skipConfirm:true}` para no preguntar dos veces en ese
  caso. `POST /api/admin/users` ya devolvía `user.id` y `user.username`, así que no hubo
  que tocar el backend.
  **PROBAR tras deploy:** generar link desde el panel y abrirlo en incógnito (debe entrar
  y saltar el modal de contraseña), abrirlo DOS veces (la segunda debe fallar), esperar el
  vencimiento, registro público con un username que ya exista en JUGAYGANA (debe decir
  "ya está en uso", NO vincular), y alta por admin de un usuario que existe en JUGAYGANA
  (SÍ debe vincular).

### 99. REGISTRO — fin del `[object Object]` + `syncUserToPlatform` con lookup tri-estado y recuperación de "ya existe"
- **Síntoma reportado por el owner (con captura):** un usuario intentó registrarse
  (`VIPjuancito2020`) y la PWA mostró **"No se pudo crear el usuario en JUGAYGANA:
  [object Object]"**. El mensaje real quedaba oculto.
- **Causa del `[object Object]`:** `createPlatformUser` devolvía `error: data?.error`
  TAL CUAL, y JUGAYGANA a veces manda `error` como **objeto**, no string. En
  `server.js` se concatenaba (`'…: ' + jgResult.error`) → JS lo convierte a
  `[object Object]`. Mismo bug latente en los logs (template literals) y en
  `jugayganaPublisherSessions.js:325`, donde además terminaba **persistido** en
  `User.jugayganaSyncError` (el panel quedaba sin diagnóstico).
- **Causa de fondo (por qué falló ESE registro):** `syncUserToPlatform` chequeaba
  existencia con `getUserInfoByName`, el wrapper de 2 estados que **colapsa
  `error` y `not_found` en `null`**. Con JUGAYGANA intermitente (HTML/Cloudflare,
  timeout, sesión caída por el proxy en 402 — ver nota del proxy más abajo), un fallo
  de la búsqueda se leía como "no existe" → se disparaba `CREATEUSER` → la plataforma
  respondía "user already existing" → el registro moría con un error confuso.
  `depositToUser`/`withdrawFromUser` YA tenían la red de seguridad para ese caso
  (#patrón de re-lookup); `syncUserToPlatform` NO.
- **Fix 1 — `errToString()` + `safeJson()` (jugaygana.js, exportado):** normalizan a
  string cualquier forma de error (string, `{message}`, `{error}`, `{msg}`,
  `{description}`, objeto plano → JSON de ≤300 chars, array, `Error`, circular →
  fallback). `safeJson` nunca tira ni devuelve `undefined` (ojo: `JSON.stringify(undefined)`
  es `undefined` y un `.slice()` encima explota). **REGLA NUEVA: todo `.error` que
  devuelvan los clientes JUGAYGANA pasa por `errToString`.** Aplicado en
  `createPlatformUser` (+ loguea la respuesta CRUDA, que es lo único que permite
  diagnosticar un rechazo nuevo), en `jugayganaPublisherSessions.js` y como defensa en
  profundidad en los 2 endpoints de registro.
- **Fix 2 — `syncUserToPlatform` reescrito** con contrato explícito
  (`{success, alreadyExists?, jugayganaUserId, jugayganaUsername}` /
  `{success:false, error:<STRING>, code, transient}`):
  1. Lookup **tri-estado** (`lookupUserOrError`) en vez de `getUserInfoByName`.
  2. `found` → vincula. `error` → **igual intenta crear** (mejor-esfuerzo: es el camino
     que históricamente funcionaba; abortar ahí habría perdido registros válidos) pero
     recuerda el fallo en `lookupFailed`.
  3. Si `CREATEUSER` dice "already existing" (helper compartido `looksLikeAlreadyExists`)
     → **re-busca 3× cada 1,5 s y VINCULA** en vez de fallar.
  4. Clasificación del error final: `LOOKUP_UNAVAILABLE` / `EXISTS_UNCONFIRMED` /
     `PLATFORM_UNAVAILABLE` (todos `transient:true`) vs `CREATE_FAILED`
     (`transient:false` = rechazo real: nombre/contraseña que la plataforma no acepta).
- **Fix 3 — mensajes al cliente diferenciados** (`server.js` en `/api/auth/register` y
  `/api/auth/register-quick`): si `transient` → se muestra el texto ya redactado ("La
  plataforma no está respondiendo en este momento (…). Esperá 1-2 minutos y volvé a
  intentar."), sin el prefijo técnico ni culpar al nombre elegido. Si no, el prefijo de
  siempre + el motivo REAL de JUGAYGANA. Ambos loguean
  `[Register] JUGAYGANA rechazó a <user>: [<code>] <error>`.
- **Refactor menor prolijo:** `depositToUser` y `withdrawFromUser` tenían el bloque de
  normalización y la lista de substrings de "ya existe" **duplicados**; ahora usan
  `errToString` + `looksLikeAlreadyExists`. Comportamiento idéntico (verificado caso por
  caso: `already exist`/`already existing`/`duplicate`/`ya existe`).
- **Status HTTP:** se mantiene **400** en los 2 endpoints incluso para errores
  transitorios (503 sería más correcto, pero `register-quick` no tiene caller en este
  repo — lo consume una landing externa — y cambiarle el status es riesgo sin necesidad).
  El front de la PWA usa `response.ok` + `data.error`, así que el mensaje llega igual.
- **⚠️ Consecuencia de diseño a tener en cuenta (NO es nueva, ahora se dispara un poco
  más seguido):** si el username ya existe en JUGAYGANA, el registro **vincula** al
  usuario local con esa cuenta de plataforma preexistente (con su saldo y su contraseña
  vieja). Eso ya pasaba en el camino `found` desde siempre; el cambio sólo hace que el
  caso "la lookup dio falso negativo" se comporte igual que el caso normal, en vez de
  fallar. Si el owner quiere BLOQUEAR usernames ya existentes en la plataforma, es una
  decisión de producto aparte.
- **Nota de contexto (mismo día):** el owner reportó también "No hay sesión válida" en el
  panel al depositar. Eso **no es un bug del repo**: el proxy (`PROXY_URL`) agotó su
  ancho de banda y responde `HTTP 402 "Bandwidth limit reached"` a TODO el tráfico hacia
  JUGAYGANA, así que `ensureSession` falla en loop. Se arregla recargando/cambiando el
  proxy. ⚠️ `PROXY_URL` se lee al `require()` (antes del bootstrap SSM) → tiene que estar
  como **environment property de EB**, NO en SSM, o no toma efecto. En los mismos logs
  aparece `[hgcash-fanout] … 404` contra autoreembolsos.com (endpoint inexistente del
  lado de ellos; es fire-and-forget, no afecta vipcargas — kill switch
  `HGCASH_FANOUT_URL=off`).
- **Validado:** `node --check` OK en los 3 archivos tocados (jugaygana.js, server.js,
  jugayganaPublisherSessions.js). Helpers testeados en aislamiento con 13 formas de error
  + circulares + `undefined` → ningún caso devuelve `[object Object]`. Verificado que los
  6 callers de `syncUserToPlatform` en server.js siguen leyendo campos que el contrato
  mantiene (`success`, `alreadyExists`, `jugayganaUserId`, `jugayganaUsername`,
  `user?.user_id`, `error`). Sin migraciones. **Back necesita redeploy.**
  **PROBAR tras deploy:** registro normal nuevo, registro con un username que ya exista
  en JUGAYGANA (debe vincular y entrar, no error), y forzar un error de la plataforma
  para confirmar que NUNCA más aparece `[object Object]`. En los logs, buscar
  `CREATEUSER falló … | raw:` para ver qué respondió realmente JUGAYGANA en el caso de
  `VIPjuancito2020` si se repite.

## Sesión 2026-07-28

### 98. UI del home: REEMBOLSOS siempre visibles (fuera del menú colapsable) + tamaños emprolijados
- **Pedido del owner (con captura):** al tocar "Ocultar menú" se escondía TODO, incluidos los
  reembolsos ("lo que más se usa y más retiene"); y había recuadros muy grandes y otros muy
  chicos.
- **Reembolsos SIEMPRE visibles:** el recuadro (`.dash-refunds`, con badge de rango + botones
  semanal/mensual) se movió FUERA de `#homePanel`, a un wrapper nuevo `.dash-refunds-sticky >
  .dash-refunds-frame` (marco dorado propio, antes lo aportaba `.dash-top`), ubicado ANTES del
  panel — mismo patrón que el botón RETIRAR MI PREMIO. Con el menú oculto queda: reembolsos →
  barra del menú → retirar → chat. Cambio de HTML/CSS inline puro: TODOS los ids se conservan y
  `git diff` de public/js/ solo toca un comentario → NO hace falta bumpear `?v`/CACHE_VERSION
  (regla de #97: solo cuando cambian DOM y JS juntos).
- **Tamaños:** badge de rango pasó de botón full-width a PILL junto al título (fila
  `.dash-refunds-head`); botones semanal/mensual parejos a lo ancho (flex:1 en fila ancha);
  card USUARIO de columna angosta (84px) a fila horizontal compacta (flex:1); banners del bono
  100% compactados (padding/fonts) y centrados con `width:calc(100% - 16px); max-width:664px`
  (= ancho interno del resto). `#unifiedRefundBtn` ELIMINADO (markup muerto: display:none, cero
  referencias JS, su CSS apuntaba a `.header-center` que no existe).
- **⚠️ Trampa flexbox que cazó la revisión (agente):** `.chat-section` es flex column → un flex
  item con `margin: X auto` NO se estira (queda a fit-content, una pastilla de ~290px). Fix:
  `.dash-refunds-sticky` lleva `width:100%; box-sizing:border-box` además del max-width+auto.
  Si se agrega otro hijo directo a `.chat-section`, recordar esto.
- **Botón flotante "📱 Instalar App / Agregar a Inicio" subido:** estaba `position:fixed;
  bottom:20px` y TAPABA la barra de escribir mensaje (captura del owner). Ahora
  `bottom: calc(80px + safe-area)` → queda justo por encima del input (el estilo vive en el
  `<style>` que inyecta el JS inline de PWA en index.html).
- **Validado:** estructura de divs balanceada, IDs únicos, `node --check` OK (app.js — solo
  comentario). Agente revisor verificó: selectores JS todos por getElementById plano (ninguno
  dependía de la jerarquía vieja), colapso del panel intacto (BFC de overflow:hidden evita
  margen fantasma), media queries de responsive.css no pisan el layout nuevo, badge elipsiza
  bien a 320px. PROBAR tras deploy: abrir la PWA, ocultar el menú (los reembolsos y RETIRAR
  deben quedar), badge de rango y montos en el recuadro sticky, banner del bono 100%.

### 97. REEMBOLSOS POR RANGO (🥉🥈🥇, sin diario) + bono instalación → cupón 100% próxima carga
- **Pedido del owner:** (a) eliminar el reembolso DIARIO y dejar solo semanal y mensual, con un
  sistema de RANGOS según lo perdido en el mes: hasta $30.000 → bronce 3%, hasta $100.000 →
  plata 5%, más → oro 10%, siempre sobre NETWIN; (b) el bono por instalar la app deja de regalar
  $5.000 y pasa a desbloquear un **100% EXTRA en la próxima carga**, con visibilidad y botón
  "marcar usado" para el admin. Decisiones confirmadas por el owner: el % del rango aplica a
  AMBOS reembolsos; rango por mes calendario; el 100% lo acredita el AGENTE a mano; el cliente
  VE su rango en la PWA.
- **Rangos (backend):** `Config['refundTiers']` (editable panel→COMANDOS, solo admin general,
  `GET/POST /api/admin/refund-tiers` — reemplazan a refund-percents; `Config['refundPercents']`
  queda huérfana en DB). `getRefundTiers()` + `computeRefundTier()` (corte INCLUSIVO: $30.000
  exactos = bronce). **Qué mes define el rango:** mensual → el propio mes reembolsado; semanal →
  el mes del LUNES de la semana reembolsada (mes en curso a hoy, o el mes anterior COMPLETO si
  la semana arrancó allá). ⚠️ Decidir por el domingo era un bug que la revisión cazó: en la
  primera semana de cada mes el rango se calculaba con 1-2 días del mes nuevo y descartaba toda
  la pérdida del mes anterior (Oro caía a Bronce). `RefundClaim` guarda `tier`; los claims pasan
  `jugayganaUserId` a `creditUserBalance` (evita un lookup flaky). Guard nuevo
  `refundAmount <= 0` ANTES de reservar (con % 0 o pérdida ínfima se quemaba el período por $0).
  El patrón #96 (RefundClaim ANTES de acreditar) quedó intacto; el netwin del rango se consulta
  ANTES de reservar (fallo → abortar reintentable, sin reserva huérfana).
- **Diario eliminado:** `POST /api/refunds/claim/daily` = stub amigable (success:false +
  mensaje explicando los rangos) porque las PWAs cacheadas lo siguen llamando (lección #88);
  `GET /api/refunds/status` devuelve un `daily` inerte con el shape que el JS viejo espera +
  objeto `tier` nuevo (rango en vivo del mes, nextTier con `missing` = tope−pérdida+1, tabla de
  rangos). `canClaimDailyRefund` eliminada de models/refunds.js. Ticker fake sin daily/bono.
- **PWA:** botón diario ELIMINADO del dashboard; badge `#dashTierBadge` (TU RANGO: 🥇 ORO ·
  10%) + panel `#unifiedTierPanel` en el modal unificado (rango, pérdida del mes, cuánto falta
  para subir, tabla 🥉🥈🥇 y nota de que el mensual usa el rango del mes reembolsado); copys de
  infoModal/adServiceModal/beneficios/welcome actualizados. **`?v=51` en TODOS los script/link
  de index.html** (fix de raíz de la revisión: el SW SWR servía UNA carga de HTML nuevo + JS
  viejo → TypeError por el DOM del botón diario eliminado y toast falso "¡$5.000 acreditado!").
  REGLA NUEVA: al cambiar HTML y JS juntos, bumpear `?v` y CACHE_VERSION (v51) al mismo número.
- **Cupón 100% instalación:** el claim (mismos gates: standalone real, teléfono verificado,
  anti-multicuenta por token) ya NO llama a JUGAYGANA — la reserva atómica setea también
  `installBonus100Pending/GrantedAt` (sin plata → sin rollback). Campos nuevos en User
  (+`UsedAt/UsedBy`). Panel: banner VERDE en el chat (patrón fueguito) con "✓ Marcar usado" →
  `POST /api/admin/users/:id/install-bonus-100/apply` (depositorMiddleware, update atómico con
  guard). PWA: banner dorado "Reclamar mi 100%" → al reclamar, banner verde "BONO ACTIVO…
  avisale al cajero" (persiste hasta que el admin lo marca usado; se refresca al recargar).
  Sección del panel renombrada "Bono App (100%)" con stats cupón pendiente/usado y "Pagado
  legacy"; feed de reclamos excluye cupones (sin monto mostrable). Comando NUEVO
  `/sys_install_bonus_100`; `/sys_install_app` con copy nuevo.
- **Migración one-shot `migration_refund_tiers_install100_done`:** actualiza `/sys_welcome` y
  `/sys_deposit(_bonus)` por SUBSTRING (respeta ediciones del owner alrededor) y
  `/sys_install_app` solo-si-default; borra `/sys_install_bonus`; desactiva las reglas push
  `refund-pending-daily` (B1/B2) en DB. Seeds B1/B2 eliminados; copy de B3-B6 sin % fijos.
  ⚠️ Si el owner tenía editados esos comandos con textos viejos, la migración NO los toca:
  revisar COMANDOS tras el deploy (buscar menciones a "diario" o "$5.000").
- **Revisión con 2 agentes adversariales** (plata/races y contrato front-back/stale clients).
  Corregido: bug del rango semanal en cambio de mes (ALTA), ventana HTML nuevo + JS viejo
  (ALTA, fix `?v=51`), off-by-one de nextTier.missing, quema de período por $0, copia shallow
  de defaults, guards en el panel, CSS muerto, card "Diarios (descontinuado)".
- **Trade-offs aceptados (documentados, no bugs):** el claim semanal ahora depende de 2
  llamadas a JUGAYGANA (si falla la del rango → error reintentable; en el borde martes 23:59
  se puede perder la ventana); los reclamos daily históricos siguen visibles en ticker/reportes;
  el banner verde del cliente no se limpia por socket al marcarlo usado (solo al recargar);
  semanal y mensual siguen SIN descontarse entre sí (solape preexistente de #73); usuarios que
  ya cobraron los $5.000 legacy NO pueden reclamar el cupón (installBonusClaimed ya en true).
- **Validado:** `node --check` OK en todo lo tocado (server.js, jugaygana.js, models/refunds.js,
  User.js, RefundClaim.js, notificationRulesService.js, refunds.js, app.js, installbonus.js,
  roulette.js, SW, admin.js). Back necesita redeploy (corre la migración). **PROBAR tras
  deploy:** status de reembolsos (badge de rango + panel), reclamo semanal (lunes/martes) y
  mensual con el % del rango correcto, claim diario desde una PWA vieja (mensaje amigable),
  reclamo del bono de instalación (debe dar cupón, NO $5.000), banner verde en el chat del
  panel + "Marcar usado", editor de rangos en COMANDOS (solo admin general), y revisar
  COMANDOS por textos viejos con "diario"/"$5.000".

## Sesión 2026-07-09

### 96. SEGURIDAD — 2 races de doble-cobro cerrados con reserva atómica ANTES de acreditar (fueguito + reembolsos)
- **Contexto:** auditoría de seguridad completa del repo (4 frentes: auth/roles, plata, inyección,
  secrets). De los hallazgos, el owner pidió corregir AHORA los 2 races de plata explotables; el
  resto queda anotado para tandas siguientes. **Los detalles del resto NO se documentan acá a
  propósito** (el repo es público en GitHub — no se publica el mapa de ataque de algo sin arreglar).
- **Fueguito `POST /api/fire/claim-reward` (server.js) — race de doble/N-cobro por el cliente:** el
  handler acreditaba el premio (`makeBonus`, con un `await` largo) y RECIÉN DESPUÉS ponía
  `pendingCashReward` en 0. N requests concurrentes del mismo cliente leían todos el flag >0 y
  cobraban el premio (hasta $200.000) N veces (TOCTOU). **Fix:** reserva atómica —
  `FireStreak.findOneAndUpdate({userId, pendingCashReward:{$gt:0}}, {$set:{...en 0}}, {new:false})`
  ANTES de acreditar. Solo un request "gana" el doc con el monto; los demás reciben null → abortan.
  Si `makeBonus` falla, se RESTAURA el premio (guard `pendingCashReward:0` para no pisar uno nuevo)
  y el cliente puede reintentar. `totalClaimed` pasó a `$inc` atómico. Mismo patrón que ya usaban
  la ruleta y el bono de instalación (que estaban bien).
- **Reembolsos `POST /api/refunds/claim/{daily|weekly|monthly}` (server.js) — doble pago si el lock
  Redis cae en multi-instancia:** el orden era acreditar (`creditUserBalance`) y DESPUÉS crear el
  `RefundClaim` con el `periodKey` único → el índice único solo evitaba la fila duplicada, no el
  doble pago (dos instancias con el lock Redis degradado acreditaban ambas y la segunda solo fallaba
  al escribir la fila, con la plata ya duplicada). **Fix:** invertido el orden en los 3 — se CREA el
  `RefundClaim` PRIMERO (el índice único `userId+type+periodKey` es ahora el candado atómico real);
  si choca (E11000) → se aborta SIN acreditar; recién si la reserva ganó se acredita; si el crédito
  falla se borra la reserva (`deleteOne`) para permitir reintentar; el `transactionId` se persiste
  con un update posterior. El `acquireRefundLock` (Redis+fallback memoria) queda como defensa en
  profundidad (evita el trabajo duplicado del cálculo), pero ya NO es la única barrera de plata.
- **Validado:** `node --check` OK (server.js). Sin migraciones (el índice único ya existía —
  `RefundClaim.js:88`). Back necesita redeploy. PROBAR tras deploy: reclamar un reembolso normal
  (debe seguir funcionando) y una recompensa de fueguito; el doble-reclamo concurrente ahora paga
  una sola vez.

### 95. Lectura integral del repo + docs vivos (ARCHITECTURE/CLAUDE/WORKLOG) + limpieza de código muerto
- **Pedido del owner:** leer TODO el repo de punta a punta para tener contexto completo, y que
  `docs/ARCHITECTURE.md` y `CLAUDE.md` se mantengan actualizados junto con `WORKLOG.md` a medida
  que se trabaja — así una sesión nueva en Tails arranca sabiendo todo sin re-analizar el repo.
- **Lectura integral hecha (2026-07-09):** server.js completo (15.7k líneas), los 4 clientes
  JUGAYGANA, config/database.js, los 28 modelos, models/refunds.js legacy, y (vía agentes
  lectores) la PWA completa, el panel admin completo y todo src/ (servicios/rutas/middlewares/
  utils/scripts). Todo lo aprendido quedó volcado en `docs/ARCHITECTURE.md`.
- **`docs/ARCHITECTURE.md` REESCRITO** (versión 2026-07-09): líneas corregidas (authMiddleware
  ~L2477, login ~L3341, Socket.IO ~L7325 — el doc viejo apuntaba a posiciones de hace meses),
  y secciones nuevas: tabla de los 4 clientes JUGAYGANA (con el gotcha de que
  jugaygana-movements.js NO multiplica ×100), flujo completo de auto-carga hgcash y de pagos
  deductAtPay, mapa del front (PWA VIP.* + panel), tabla de motores/crons con su estado
  (encuesta/inactividad/estrategia apagados) e idempotencia por índices únicos, y ~20 trampas.
- **`CLAUDE.md` actualizado:** la REGLA PERMANENTE ahora cubre los 3 docs vivos (WORKLOG +
  ARCHITECTURE + CLAUDE), datos corregidos (server.js ~15.7k líneas, líneas reales) y gotchas
  de primer nivel nuevos (4 clientes JUGAYGANA, bonos apagados por flags, multi-instancia,
  front frágil por onclick/USERS_LIST_FIELDS).
- **LIMPIEZA de código muerto (verificado por grep antes de borrar cada cosa):**
  - **Sección "Base de Datos" del panel ELIMINADA por completo**: era inalcanzable — no existía
    nav-item `data-section="database"` ni `<section id="databaseSection">` en el HTML (quedó
    huérfana desde #79). Borrado: branch en switchSection, `loadDatabaseUsers`,
    `renderDatabaseUsers`, `verifyDatabaseAccessFromModal`, `showDatabasePasswordModal`,
    `dbAccessGranted/dbStoredPassword` (admin.js), el modal `databasePasswordModal`
    (index.html) y en el BACKEND los endpoints `POST /api/admin/database/verify` y
    `POST /api/admin/database/users` (dumpeaba TODA la base sin paginar) + dbPasswordMiddleware
    + el chequeo fatal de `DB_PASSWORD` (la env queda sin uso; se puede sacar de SSM cuando se
    quiera). ⚠️ La nota de #93 que decía que la sección Base de Datos "usaba" ese endpoint era
    incorrecta: la sección ya era inalcanzable. `getRoleLabel` y `escapeCsvField` se CONSERVAN
    (los usan la tabla de usuarios y el export CSV vivo). Rollback: `git revert`.
  - **`_suspiciousOpenUser` (admin.js)**: eliminada la rama que llamaba a `openChatByUsername`,
    función que nunca existió (siempre caía al fallback). Comportamiento idéntico.
  - **FIX ruleta (roulette.js)**: tras ganar llamaba a `VIP.auth.refreshBalance`, que tampoco
    existió nunca → el saldo del header NO se refrescaba al ganar. Ahora llama a
    `VIP.ui.syncBalance()` (el mismo patrón que usan installbonus y withdraw).
  - **`window.setPasswordChangePending` fantasma**: eliminados los 2 llamados guardados
    (ui.js y auth.js) — la línea anterior ya seteaba `VIP.state.passwordChangePending` directo.
  - **NO borrado a propósito**: `_communityRecommendCard` (roulette.js) — es una feature pedida
    por el owner que nunca se conectó (lee `VIP.state.communityLink*` que nadie setea); quedó
    documentada en ARCHITECTURE §9 como mejora pendiente (reconectarla desde `loadCommunity()`),
    igual que `checkUsernameAvailability` en la PWA.
- **Validado:** `node --check` OK (server.js, admin.js, roulette.js, ui.js, auth.js). Grep: 0
  referencias vivas a lo eliminado (solo comentarios-lápida). Back necesita redeploy (endpoints
  eliminados); panel y PWA se actualizan al recargar (SW stale-while-revalidate para /js/).
  PROBAR tras deploy: panel Cuentas sospechosas → botón "Ver chat" (debe llevar a Usuarios con
  toast), y en la PWA ganar la ruleta debería refrescar el saldo del header.

## Sesión 2026-07-08

### 94. Fan-out del webhook hgcash → autoreembolsos.com (proyecto hermano, misma cuenta hgcash)
- **Pedido del owner:** hgcash permite UNA sola URL de webhook por cuenta; vipcargas la recibe.
  Reenviar cada webhook VÁLIDO a autoreembolsos.com (comparte la cuenta hgcash; cada proyecto
  matchea sus propios comprobantes → no hay doble carga). SIN tocar el procesamiento actual ni
  la URL configurada en hgcash.
- **Implementación (`_fanoutHgcashWebhook` en server.js, junto al webhook):**
  - Se dispara DESPUÉS de validar la firma (solo webhooks auténticos) y ANTES de los filtros
    locales → el destino recibe TODO (movimientos entrantes Y estados de pago TRANSACTION_REQUEST,
    que también necesita para sus propios cash-outs).
  - Reenvía el **body CRUDO** (`req.rawBody`, bytes exactos) + la firma original
    `X-HG-Webhook-Signature` → autoreembolsos valida el mismo HMAC con el secret compartido
    (⚠️ debe tener el MISMO `HGCASH_WEBHOOK_SECRET` configurado). Header `X-Forwarded-By: vipcargas`.
  - **Fire-and-forget** (sin await): jamás demora la respuesta 200 a hgcash ni afecta el
    procesamiento local. Timeout 8s + 1 reintento a los 15s; después desiste con log
    `[hgcash-fanout]`. `maxRedirects:0` a propósito (un redirect www↔apex rompería el POST y
    debe quedar visible en logs, no silenciado).
  - **URL configurable** por env/SSM `HGCASH_FANOUT_URL` (lectura lazy por el bootstrap SSM);
    default `https://www.autoreembolsos.com/api/hgcash/webhook` (confirmado por el owner).
    **Kill switch sin deploy:** setear `HGCASH_FANOUT_URL=off`.
- **OJO (lado autoreembolsos, no nuestro):** si autoreembolsos.com está detrás de Cloudflare,
  puede bloquear el POST server-to-server — mismo problema que tuvo vipcargas con su propio
  webhook (#66): necesitaría regla WAF "Skip" para su ruta /api/hgcash/webhook. Si en los logs
  aparece `[hgcash-fanout] ... 403` es eso.
- **Validado:** `node --check` OK (server.js). Back necesita redeploy. PROBAR: tras una carga real,
  buscar `[hgcash-fanout]` en los logs (ausencia de warns = entregas OK) y verificar que el
  movimiento apareció en autoreembolsos.

### 93. PERFORMANCE — Listados de usuarios: proyección campo por campo + 3 endpoints muertos eliminados
- **Hallazgo clave (mejor de lo esperado):** la sección Usuarios del panel YA estaba paginada
  (`GET /api/admin/users?page=…`, 20 por página, búsqueda server-side) — no hacía falta el
  refactor grande de paginación. Lo que quedaba: docs completos viajando al pedo y 3 endpoints
  muertos que dumpeaban la base entera.
- **Proyección verificada CAMPO POR CAMPO contra el panel:**
  - `GET /api/admin/users` (paginado, el que usa la sección Usuarios): `select('-password')`
    arrastraba fcmTokens/tagHistory/withdrawalAccount/acquisitionUtm/adminNotes de cada fila →
    ahora `USERS_LIST_FIELDS` (17 campos, enumerados leyendo `renderUsers` + `notifUsageCell` +
    los onclick de la tabla en admin.js). El detalle completo lo sigue trayendo
    `GET /api/users/:userId` (viewUser/loadUserInfo) — intacto. ⚠️ Columna nueva en la tabla del
    panel ⇒ sumar el campo al select.
  - `POST /api/admin/database/users` (sección Base de Datos): trae TODA la base (sin paginar) pero
    ahora solo las 8 columnas que `renderDatabaseUsers` muestra (username email phone role balance
    isActive lastLogin createdAt) — el payload baja ~20-50×.
- **ELIMINADOS 3 endpoints muertos** (0 callers, verificado en admin.js + ambos index.html con JS
  inline + public/js + scripts): `GET /api/users` (dump completo de la base con doc entero),
  `GET /api/admin/database` (ídem) y `POST /api/admin/database/export/csv` (botón borrado en #79).
  El export vivo (`GET /api/admin/users/export/csv`, ya proyectado) y los POST de database
  (verify/users) quedan. Rollback: `git revert`.
- **Validado:** `node --check` OK (server.js). Solo queda 1 `User.find()` sin filtro en el repo:
  el export CSV vivo (proyectado a 5 campos, es su función). PROBAR tras deploy: sección Usuarios
  (tabla completa con etiquetas, plan de notis, botones SMS/bloquear/clave), modal "Ver detalle",
  sección Base de Datos, export CSV de usuarios.

### 92. PERFORMANCE — Login/registro case-insensitive por índice (usernameLower) con red de seguridad
- **Problema:** TODAS las búsquedas de usuario case-insensitive usaban regex `^...$/i`, que NO puede
  usar el índice de `username` → COLLSCAN de la colección entera en cada login, cada chequeo de
  "usuario disponible" y cada verificación de unicidad al crear cuentas (10 lugares). Crece linealmente
  con la base; pega peor justo en ráfagas de registro por pauta.
- **Diseño (a prueba de dejar gente afuera):**
  - Nuevo campo **`usernameLower`** en User (copia en minúsculas, indexada). Lo mantiene un hook
    `pre('save')` (cubre TODAS las altas; verificado por grep que no hay renames de username por
    updateOne/findOneAndUpdate).
  - **Backfill en CADA arranque** (no one-shot): `updateMany({usernameLower:null},
    [{$set:{usernameLower:{$toLower:'$username'}}}])` — idempotente, barato cuando no hay nada que
    rellenar, y repara usuarios creados por instancias con código viejo durante un rolling deploy.
    Solo si terminó OK se habilita el modo rápido puro (`_usernameLowerReady`).
  - Helper único **`findUserByUsernameCI(username, {select,lean,critical})`**: busca por
    `usernameLower` (indexado); si no encuentra Y (`!_usernameLowerReady` O `critical`), cae al
    regex histórico (COLLSCAN) y si lo encuentra AUTO-REPARA el campo (fire-and-forget).
  - **El LOGIN usa `critical:true`** → fallback lento disponible SIEMPRE: es imposible que alguien
    quede afuera de su cuenta por este cambio (peor caso = comportamiento de hoy). El costo del
    fallback solo se paga con usernames inexistentes (tipeos), y el login está rate-limiteado.
- **Migrados los 10 call sites:** login (3316), check-username (2582), register (2913),
  register-quick (3150), verify-phone/registro con username (4184), admin create user (5103 y
  13242), influencer create (9820), asignar cuenta de campaña (10176), simulación ruleta (13804).
  Grep: 0 regex de username fuera del helper.
- **Validado:** `node --check` OK (server.js, User.js). Mongoose 8 (soporta pipeline updates).
  Back necesita redeploy (crea el índice + corre el backfill). PROBAR tras deploy: login con
  mayúsculas/minúsculas mezcladas, registro de usuario nuevo, "usuario ya existe" al intentar
  duplicado con otra capitalización.

### 91. PERFORMANCE — Batch B (subset seguro): endpoints muertos peligrosos + cache de campañas + render del panel
- **Contexto:** producción con gente activa (JUGAYGANA/backupviejo quedó como el repo vivo; Spingama
  NUNCA se deployó → cero problema de datos). Del Batch B se aplicó SOLO lo que no toca flujos de
  plata (nada de pagos, CBU, login ni depósitos). Cada cambio verificado a mano contra sus callers.
- **ELIMINADOS 3 endpoints muertos peligrosos** (server.js): `GET /api/admin/chats/:status`,
  `GET /api/admin/all-chats` y `GET /api/admin/chats/category/:category`. Verificado por grep:
  0 callers en panel/cliente/scripts (el panel usa `/api/admin/conversations`, aggregation con
  limit 100). Eran bombas de memoria: all-chats cargaba TODA la colección de mensajes + usuarios a
  RAM por request (con un token de admin bastaba para tumbar la instancia). Los POST de
  close/reopen/assign/category quedan intactos. Rollback: `git revert`.
- **Cache 30s de campañas activas para el vanity por slug** (`_getActiveCampaignsCached`): el
  branch de slug de `GET /:code` corre en CADA page-view SPA de un segmento (/register, /chat…) y
  traía TODAS las campañas activas de la DB por request. El matching por CODE exacto NO usa el
  cache (sigue directo a la DB, indexado) → una campaña nueva funciona por code al instante y por
  slug a los ≤30s.
- **Panel — render de la lista de chats:** (a) **delegación de eventos**: un solo listener en el
  contenedor (antes se re-adjuntaba un listener POR ITEM en cada render); (b) **coalescing por
  frame** (`requestAnimationFrame`): antes cada evento de socket (chat_updated/new_message/
  messages_read) disparaba un rebuild COMPLETO de la lista — en horas pico eran ~100 rebuilds/min.
  Ahora N eventos en el mismo frame = 1 render. El estado se actualiza igual al instante; con
  pestaña oculta el navegador pausa rAF y pinta al volver. Verificado: ningún caller lee el DOM
  inmediatamente después de renderConversations(); los otros forEach de `.conversation-item`
  (selectConversation/cerrar chat) solo togglean clases.
- **NO tocado a propósito (riesgo/plata):** `_pollPayingPayouts` sigue secuencial (toca PAGOS;
  con hgcash flaky, paralelizar es riesgo sin urgencia); cache de `getConfig` (multi-instancia:
  un cambio de CBU tardaría el TTL en verse en otras instancias — plata); login por regex
  (COLLSCAN pero tocarlo arriesga logins); paginación de /api/users (toca contrato con el front);
  mongoSanitize/xss por ruta; defer de scripts del panel (colisión de nombres); drop de índices
  redundantes (requiere explain() en Atlas).
- **Validado:** `node --check` OK (server.js, admin.js). Back necesita redeploy; panel, recargar.
  PROBAR tras deploy: links de pauta (por code y por slug), y en el panel: click en conversaciones,
  buscador, badge de no leídos, cambio de pestañas.

### 90. PERFORMANCE — Batch A: optimización general de riesgo bajo (auditoría con 3 agentes)
- **Pedido del owner:** optimización general de rendimiento/velocidad SIN romper nada. Se auditó
  todo (queries Mongo, runtime Node/Express, frontend PWA+panel) con 3 agentes de solo-lectura y
  se verificó cada hallazgo a mano. Se aplicó el batch de riesgo cero/bajo; lo de riesgo medio
  queda anotado abajo (Batch B).
- **Backend (server.js):**
  - **Cache en memoria de assets con handler propio** (`readFileCached` + `_indexHtmlBase` +
    `_adminHtmlRendered`): antes CADA page-view hacía `fs.readFileSync` de index.html (242KB, + 3
    regex-replace sobre todo el string) y cada apertura del panel leía admin.js (~600KB) — I/O
    síncrona que bloqueaba el event loop. Ahora se lee 1 vez por proceso (los archivos solo cambian
    con redeploy); del index se precomputa pixel/base-url y por request solo se reemplaza el
    campaignCode. No cachea errores (null) → reintenta.
  - **authMiddleware con `.select()`** (`AUTH_USER_FIELDS`): corría en cada request autenticado
    hidratando el doc User COMPLETO (fcmTokens/tagHistory/etc.) para leer 8 campos. Ahora trae solo
    esos. El self-heal de admins pasó de `user.save()` a `updateOne` puntual.
    ⚠️ Si un chequeo futuro necesita otro campo del user: agregarlo al select.
  - **`_maybeSendPushFallback` con select+lean** (por mensaje de chat con fallback push; verificado
    que `sendPushIfOffline` solo usa `_id/id/username/fcmToken/fcmTokens` y limpia por updateOne).
  - **FIX fuga `connectedAdmins`:** authenticate mete admin/depositor/withdrawer/comunidad al Map,
    pero disconnect solo limpiaba `role==='admin'` → sockets muertos de los otros roles quedaban
    para siempre (fuga + emits a sockets desconectados en broadcastStats) y encima se notificaba
    `user_disconnected` como si fueran clientes. Ahora disconnect usa la misma lista de roles.
  - **CSP precomputada** (`CSP_HEADER_VALUE`): antes se armaba el array + join en CADA request.
- **Índices nuevos en User** (src/models/User.js): `{'fcmTokens.token':1}` (multikey — reclamo del
  bono instalación, fraud-check multicuenta y logout hacían COLLSCAN) y `{role:1, lastLogin:1}`
  (audiencias de recuperación/inactividad + cron de reglas cada 5 min). Mongoose los crea al
  deployar (autoIndex).
- **Logs por-request apagados tras flag** (`_dlog`, prender con `FCM_DEBUG_LOGS=1`):
  `notificationRoutes.js` tenía ~5 `console.log` por CADA registro de token FCM (cada carga de la
  PWA) y 2-3 por CADA request del panel (requireAdmin). Los `console.error` quedan.
- **PWA cliente:**
  - **Poll de mensajes = solo respaldo** (`socket.js`): antes cada usuario online pegaba
    `GET /api/messages` cada 30s AUNQUE el socket entregara todo en tiempo real (~120 req/h por
    usuario). Ahora el tick se saltea si el socket está conectado+autenticado (flag
    `VIP.state.socketAuthed`); si el socket cae, el poll de 30s sigue igual. El catch-up al
    reconectar ya existía (`loadMessages(true)` en authenticated/reconnect).
  - **Service worker v50 — stale-while-revalidate para `/js/` y `/css/`**: antes cache-first PURO
    sin revalidación → un deploy no llegaba a usuarios recurrentes hasta bumpear CACHE_VERSION a
    mano (causa raíz de los bugs "fantasma" #88/#89). Ahora responde del caché (rápido) y revalida
    en background → el deploy llega en la SIGUIENTE carga. **Ya no hace falta bumpear versión por
    cambios en js/css** (sí para cambios de estrategia del SW o purga forzada). Logs por-fetch del
    SW tras flag `SW_DEBUG` (const en el archivo).
- **Panel admin:** reconciliación de conversaciones 60s → 180s + skip con pestaña oculta (fetch
  grande + re-render completo; el socket cubre el tiempo real, esto es solo red de seguridad).
- **NO tocado — Batch B pendiente (riesgo medio, consultar):** `/api/admin/all-chats` y chats por
  status/categoría traen TODOS los mensajes a memoria (reescribir con aggregation como
  `/api/conversations`); paginación de `GET /api/users` (trae toda la colección; toca el front);
  cache TTL en `getConfig` (⚠️ multi-instancia: un cambio de CBU tardaría el TTL en verse en las
  otras instancias — decidir con el owner); login por regex case-insensitive no usa el índice de
  username (COLLSCAN por login; requiere collation o usernameLower); ruta vanity `/:code` hace
  `Campaign.find` de todas las campañas activas por page-view SPA (cachear con TTL corto);
  `_pollPayingPayouts` hace hasta 25 llamadas hgcash SECUENCIALES por tick (paralelizar);
  acotar mongoSanitize/xss a `/api/` (coordinar con seguridad); `defer` en scripts del head del
  panel (colisión de nombres a resolver); event delegation + coalescing en `renderConversations`
  (re-render total + N listeners por evento de socket); índices single-field redundantes en
  Message/User/Transaction (requiere `explain()` + drop en Atlas).
- **Verificado como YA-BIEN por la auditoría (no tocar):** compression() activo, timeouts en TODAS
  las llamadas externas (axios), FCM en lotes de 500 con logging por-lote, broadcastStats cacheado
  60s, Socket.IO sin broadcasts globales (todo a rooms), rate-limit Maps con cleanup, admin-sw.js
  ya network-first para admin.js/css, roulette.js con guarda de visibilidad (patrón modelo).
- **Validado:** `node --check` OK (server.js, User.js, notificationRoutes.js, socket.js,
  firebase-messaging-sw.js, admin.js). Back necesita redeploy (activa caches + crea índices);
  cliente recibe el SW v50 en la próxima recarga.

### 89. FIX bonos-fantasma 50%/100%: eliminados TODOS los caminos que seguían dando/prometiendo 50-100%
- **Síntoma (owner):** pidió eliminar los bonos automáticos del 50%/100% (bajados a 15/20/30%), pero
  a usuarios les SEGUÍAN apareciendo ofertas de 50/100% (y al aparecerles hay que respetarlas).
  Mismo fix que en el repo nuevo (VIPCARGASANTINO #99), pero auditado y aplicado ACÁ desde cero
  (pedido explícito del owner: no asumir que los dos repos están iguales).
- **Causa raíz (barrido completo de ESTE repo con 3 agentes):** los kill switches de #71
  (BONUS_STRATEGY_DISABLED / INACTIVIDAD_DISABLED / CHARGE_BONUSES_DISABLED) apagan la CREACIÓN en
  esos 3 motores, pero quedaron 5 fugas:
  1. **`_getActivePromoBonus` devolvía el `percent` CRUDO de Mongo sin tope** → cualquier PromoBonus
     viejo activo con 50/100 (vigencia hasta 720h) se seguía mostrando al usuario (banner
     `promobonus.js`) y al agente (banner del chat), que lo aplicaba a mano en la carga.
  2. **Plantillas push `bono_50`/`bono_100`** hardcodeadas en `notificationRoutes.js` + worker
     `_runDueSchedules` cada 60s → un `ScheduledNotif` daily/weekly viejo re-mandaba "¡Bono del
     100%!" para siempre.
  3. **Motor de encuesta**: `ENCUESTA_PLAN_DEFAULTS.bonoPercents [50,100]`, validación hasta 500%,
     `insertMany` sin cap. Hoy semi-apagado por `bDays=[]` (encuestaService), pero latente: revertir
     UNA línea revivía el 50/100. El panel además pre-rellenaba `50,100` si la config venía vacía →
     guardar sin tocar el campo RE-SEMBRABA los 50/100.
  4. **Copy hardcodeado en la PWA** (`index.html`): "Bonos del 50% y 100% en tus cargas" (infoModal
     1386 + adServiceModal 1440) y "Día 15: 100% en próxima carga" (menú estático del fueguito 1333
     — hito que YA NI EXISTE, los defaults son 10/20/30 cash).
  5. **Panel**: opciones "Bono 50%/100%" en programadas + input % de estrategia hasta 1000.
- **Fix aplicado (misma decisión owner que el repo nuevo: tope 30% solo en lo AUTOMÁTICO; los
  botones manuales +50/+100 del modal de depósito QUEDAN — herramienta del agente):**
  - `_getActivePromoBonus` (server.js): **cap de lectura `percent>30 → 30`** — cubre
    `/api/promo-bonus/mine` y `/api/admin/promo-bonus`. Basura vieja en DB nunca más se ve >30%.
  - **Migración one-shot `migration_kill_bonus_50_100_done`** (server.js, tras las existentes):
    vence PromoBonus activos `percent>30` + desactiva ScheduledNotif tipo bono_50/bono_100. El flag
    solo se setea si TODO salió bien (si falla, reintenta al próximo arranque).
  - **Plantillas**: bono_50/bono_100 ELIMINADAS de `NOTIF_TEMPLATE_DEFAULTS`, `NOTIF_TYPE_CATEGORY`
    y de los enums de `NotifTemplate`/`ScheduledNotif`. **Guard en `_runStrategyLaunch`** (tipo
    desconocido → error, NUNCA envía; sin esto un tipo sin categoría caía en la rama "sin tope" del
    reembolso y se mandaba a todo el plan) + `_runDueSchedules` auto-desactiva schedules de tipos
    eliminados (doble cinturón además de la migración).
  - **Encuesta**: defaults `[50,100]→[15,30]` (server.js + encuestaService), validación
    `_encNum(p,15,1,30)` (antes 1..500), cap `Math.min(30,…)` en el slot y en el `insertMany`.
  - **Panel**: sin opciones bono 50/100 en programadas; `TYPE_LABELS` los conserva como
    "(ELIMINADO)" para schedules viejos; pre-relleno encuesta `50,100→15,30`; input % estrategia
    max 1000→30 (el modelo ya capeaba a 30); comentario stale "50%->100%" corregido.
  - **PWA**: copy → "Bonos de hasta el 30%…" (index.html 1386/1440), línea "Día 15: 100%" BORRADA
    (hito inexistente), `CACHE_VERSION` v48→v49 (purga cachés viejos, patrón #88).
- **NO tocado (a propósito):** botones +50%/+100% del modal de depósito (manual, decisión owner);
  `/sys_recover_100` ("recuperá el 100% de lo que perdiste") — es texto de RECUPERACIÓN/Comunidad
  editable por COMANDOS, no bono de carga (si molesta, se edita desde el panel); ruleta (premios
  cash fijos, sin %); fueguito (ya en 30%, defaults 10/20/30 cash); `autoEditBonusPercent`
  (config manual del admin, max 1000 — lo setea el admin a mano).
- **Validado:** `node --check` OK (server.js, encuestaService, notificationRoutes, NotifTemplate,
  ScheduledNotif, admin.js, firebase-messaging-sw.js). Grep: 0 referencias vivas a bono_50/100
  fuera de comentarios/migración/label legacy; 0 "[50, 100]" ni "50% y 100%". Las rutas de
  plantillas/lanzamiento rechazan los tipos eliminados (validan contra NOTIF_TEMPLATE_TYPES).
  **Back necesita redeploy** para que corra la migración y aplique el cap de lectura.

## Sesión 2026-07-02

### 88. FIX "bienvenida-fantasma": mensaje de bienvenida viejo apareciendo como enviado por el cliente
- **Síntoma (owner):** tras cambiar los % de reembolso y editar `/sys_welcome`, la bienvenida a veces sale bien (por "Sistema", con % nuevos) pero en OTROS casos aparece como enviada por el PROPIO CLIENTE y con el texto/porcentajes VIEJOS.
- **Causa raíz:** el server actual crea la bienvenida como Sistema (`/api/messages/welcome`, con `renderSystemCommand('/sys_welcome')`). Pero **versiones VIEJAS cacheadas de la PWA** (service worker) todavía corren el código anterior, que mandaba la bienvenida vía `/api/messages/send` con el token del cliente → se registraba con `senderRole:'user'` y con el TEXTO HARDCODEADO viejo (20/10/5). El código actual del cliente (`ui.js` → `/api/messages/welcome`) está limpio; el problema son los dispositivos con caché vieja.
- **Fix (2 capas):**
  - **Servidor (inmediato, cubre a TODOS incluidos los cacheados):** guard `_isStaleClientWelcome(content)` en `/api/messages/send` (HTTP) y `send_message` (socket): si un usuario (`role==='user'`) manda un mensaje que ES la bienvenida (matchea "Bienvenido a la Sala de Juegos" + "Beneficios exclusivos"/"Reembolso DIARIO/SEMANAL/MENSUAL"), se descarta silenciosamente (no se guarda ni emite; HTTP devuelve `{success:true, ignored:true}`). Marcadores muy específicos → no toca mensajes reales.
  - **Service worker:** `CACHE_VERSION` v47 → v48 para que los clientes viejos actualicen a `ui.js` limpio (que ya usa `/api/messages/welcome`).
- **NO tocado (latente, no era la causa):** los textos de bienvenida HARDCODEADOS con % viejos en `server.js:4930` (fallback de `/api/messages/welcome`) y en el seed `/sys_welcome` (`$setOnInsert`) — son dormidos porque `/sys_welcome` está editado; solo reaparecerían si se borra el comando. Se puede limpiar si se quiere.
- **Validado:** `node --check` OK (server.js). `socket.role` confirmado seteado (L7389). Sin migraciones. Back redeploy; el efecto del SW se ve cuando los clientes recargan la PWA.

## Sesión 2026-06-30

### 87. Auto-carga hgcash/Urbana: NO cargar transferencias menores al mínimo ($2000)
- **Pedido del owner:** el casino tiene mínimo de carga $2000, pero la auto-carga acreditaba transferencias menores. Quiere que si el monto es < $2000 NO se cargue automático; que el comprobante igual se verifique y, si está correcto, se avise que está OK pero NO se cargó por estar bajo el mínimo, para que el agente le pida la diferencia al cliente.
- **Fix:** en `hgcashAutoCarga` (server.js), después del modo sombra y ANTES de cargar, si `movement.amount < minChargeARS` → NO carga: deja el movimiento y el comprobante en `needs_review` (estados ya existentes, sin enums nuevos) y emite aviso admin-only: "✅ Comprobante CORRECTO (…) — PERO el monto es menor al mínimo ($2.000). NO se cargó automático. 👉 Pedile al cliente que envíe la diferencia y cargá la suma a mano". El movimiento en `needs_review` lo consume la carga manual posterior (`hgcashConsumeOnManualDeposit` ya maneja `needs_review`) → no se pierde plata ni queda colgado.
- **Mínimo configurable:** nuevo `minChargeARS: 2000` en `HGCASH_DEFAULTS` (lo lee `getHgcashConfig`, default 2000 aunque no esté en la config guardada). Editable por DB si algún día cambia el mínimo; no se expuso campo en el panel (se puede agregar si lo piden).
- **Alcance:** solo afecta la AUTO-CARGA (modo auto). En modo sombra/manual no cambia nada (el agente decide). La verificación del comprobante (OCR) sigue igual.
- **Validado:** `node --check` OK (server.js). Sin migraciones. Back necesita redeploy.

### 86. FIX comprobantes: falso "YA UTILIZADO" por leer el CUIT como N° de operación
- **Síntoma (reportado por el owner, varias veces):** comprobantes NUEVOS y verificados salían como "duplicado", y a veces decían "COMPROBANTE YA UTILIZADO POR: @VIPpocha7" atribuyéndolo a un usuario que NO lo había mandado. Captura: vipPaulo427 manda un comprobante de $4.000 y salta "ya utilizado por @VIPpocha7 op. N°30-71876498-6".
- **Causa raíz:** `30-71876498-6` es un **CUIT**, no un N° de operación. La IA (`comprobanteAiService`) lo leía y lo devolvía como `numero_operacion`. La defensa anti-falso-duplicado de `analyzeComprobanteFromMessage` (server.js) descartaba la huella solo si coincidía con el CBU (22 díg) o era de 18+ dígitos → **el CUIT de 11 dígitos se colaba** como `dedupeKey`. Como el CUIT del destino (o procesador) se REPITE en todas las transferencias, cada comprobante nuevo chocaba con el primero que tuviera ese CUIT → falso "ya utilizado", atribuido al primero que lo mandó.
- **Fix (2 capas):**
  - **Servidor (determinístico):** la defensa ahora también descarta el `opKey` si parece CUIT/CUIL — 11 dígitos con prefijo válido (20/23/24/27/30/33/34), con o sin guiones (`/^(20|23|24|27|30|33|34)-?\d{8}-?\d$/`). Al descartarlo, cae al combo `monto|titularOrigen|cbuOrigen|fecha` (que SÍ distingue transferencias de distintas personas) o a `no_key` (verificá a mano) — nunca a un falso duplicado. Probado: agarra CUITs, no toca N° de operación normales (9-10 díg, alfanuméricos).
  - **Prompt IA (fuente):** se le aclara explícitamente que NO use el CUIT/CUIL (formato XX-XXXXXXXX-X) como número de operación, porque identifica a una persona y se repite entre transferencias.
- **Por qué es seguro:** el peor caso de descartar el CUIT es usar el combo de dedup (más débil pero correcto) o pedir verificación manual — JAMÁS marca un falso duplicado. No empeora ningún caso. Sin migración: los comprobantes viejos con CUIT como huella quedan en la DB pero los NUEVOS ya no generan esa huella, así que no vuelven a chocar.
- **Validado:** `node --check` OK (server.js, comprobanteAiService.js). Back necesita redeploy.

## Sesión 2026-06-26

### 85. Alerta de MULTICUENTA en el chat (en el momento, no a posteriori)
- **Pedido del owner:** la sección "Cuentas sospechosas" detecta multicuentas (por IP / dispositivo / teléfono) pero hay que entrar a revisarla a mano, y para cuando lo hacen el usuario ya se llevó el bono y retiró. Quería una ALERTA en el chat, al abrirlo, que avise y explique por qué, para detectar y bloquear en el momento.
- **Backend:** nuevo endpoint `GET /api/admin/users/:userId/fraud-check` (adminMiddleware): para el usuario dado, cuenta cuántas OTRAS cuentas (`role:'user'`, distinto id) comparten su **dispositivo** (token FCM, singular + array `fcmTokens.token`), su **teléfono** (`phoneKey` si existe, si no `phone`) y su **IP de registro** (`registrationIp`). Devuelve `{ suspicious, reasons:[{type,label,strong,count,accounts:[{id,username,isBlocked}]}] }` (hasta 8 nombres por motivo, +N más). `suspicious` = dispositivo/teléfono con 1+ (señal fuerte) **o** IP con 2+ otras cuentas (3+ en total; la IP sola es señal débil por wifi/datos compartidos — decisión owner). Queries con `.limit(50)`, anti-inyección (`String(req.params.userId)`).
- **Panel (`adminprivado2026`):** al abrir un chat, `loadUserInfo` dispara `renderFraudBanner(userId)` (fire-and-forget, con guarda de race por `activeConversationId`, try/catch — NUNCA frena ni rompe el chat). Si es sospechoso → banner ámbar/rojo en el header "⚠️ POSIBLE MULTICUENTA — tocá para ver por qué"; al tocarlo despliega el detalle (📱 dispositivo / ☎️ teléfono / 🌐 IP con qué cuentas, marcando 🚫 las ya bloqueadas) + botón "Bloquear este usuario" que **reusa el flujo existente** `openBlockModal` (modal con motivo). Banner nuevo `#chatFraudBanner` en el header; se oculta al cambiar de chat.
- **Impacto:** el agente ve la alerta JUSTO cuando atiende al cliente (carga/pago), incluido el withdrawer antes de pagar un retiro. Aplica a todos los roles de agente (adminMiddleware). Additivo: no cambia nada de lo existente.
- **Validado:** `node --check` OK (server.js, admin.js). Sin migraciones. Back necesita redeploy; panel, recargar. PROBAR en el panel: abrir el chat de un usuario que aparezca en "Cuentas sospechosas" y verificar que salga el banner. (Posible mejora futura: índice en `fcmTokens.token` si el fraud-check se nota lento con muchos usuarios; y badge en la lista de chats.)

### 84. Seguridad — Batch C: tope de longitud de texto en chat + saneo de filename (anti-DoS/storage)
- **Tope de texto:** el envío de mensajes (HTTP `/api/messages/send` y socket `send_message`) no limitaba la longitud del texto → se podía guardar un blob de varios MB como `type:'text'` (el límite de 5MB solo aplicaba a imagen/video). Ahora rechaza `type:'text'` con `content.length > 8000` (un mensaje de chat real es muy corto; 8000 es holgado). Cero impacto en mensajes legítimos.
- **Saneo de `filename`:** en `/api/upload/presigned-url` el `filename` se concatenaba crudo a la key de S3. Ahora se sanea (`[^\w.\-]→_`, máx 120 chars) antes de armar la key. BAJO, higiene.
- **Validado:** `node --check` OK (server.js). Sin migraciones.
- **NOTA sobre el "10/10":** con esto se cierra prácticamente toda la deuda de seguridad a NIVEL CÓDIGO de bajo riesgo. Los saltos restantes hacia 8-9 son: 2FA para el admin general (mayor valor), acortar la vida de los tokens de usuario (30-90d → afecta UX), sacar `'unsafe-inline'` de la CSP (refactor grande), y endurecer la INFRA (SSM/Atlas/Firebase rules/Cloudflare WAF/monitoreo) — esto último ya NO es código. El "10/10" no es un estado real alcanzable.

### 83. Seguridad — Batch B: endurecimientos de riesgo cero (defensa en profundidad)
- **Pedido:** seguir con la deuda de seguridad sin romper nada. Se hicieron los hallazgos BAJOS de la auditoría que son arreglos chicos y 100% seguros (no cambian comportamiento para flujos legítimos):
  - **JWT con algoritmo fijado:** `verifyAccessToken`/`verifyRefreshToken` en `src/middlewares/auth.js` (usados por las rutas de referidos, que mueven plata) ahora pasan `{ algorithms: ['HS256'] }` — consistente con los `jwt.verify` de server.js, evita confusión de algoritmos. Los tokens ya eran HS256 → sin impacto en sesiones válidas.
  - **`tokenVersion` normalizado:** 2 guards que usaban `user.tokenVersion && ...` (frágil con tokenVersion 0) pasados a `(decoded.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)` — en `/api/admin/me` (L3640) y en la auth del socket (L7326), igual que el authMiddleware principal. Benigno hoy, pero saca la trampa.
  - **`X-XSS-Protection: 0`** (antes `1; mode=block`): recomendación moderna (el header viejo introdujo vulnerabilidades en navegadores antiguos; la CSP es la defensa real).
  - **`User.statics.findByUsername`** (código muerto): regex sin escapar → ahora escapa metacaracteres (anti-ReDoS / inyección de regex). Saca la trampa por si alguien lo usa a futuro.
- **NO hecho (las 3 "grandes" de la deuda, RIESGOSAS o de producto):**
  - **`'unsafe-inline'` en la CSP de scripts:** sacarlo requiere nonces/hashes + refactorizar TODOS los `onclick` inline del `index.html` (243 KB) a `addEventListener` → refactor enorme y riesgoso. Diferido.
  - **`xss-clean` (deprecado):** sacarlo reduciría defensa en profundidad sin ganar (la protección real es el escape en el output, que el front ya hace). No es vuln activa; es deuda para una eventual migración a Express 5. Se deja.
  - **Mínimo de contraseña (6):** subirlo es decisión de producto (fricción/soporte) más que seguridad pura; el brute-force ya está mitigado por rate-limit. A definir con el owner.
- **Validado:** `node --check` OK (server.js, auth.js, User.js). Sin migraciones. Back necesita redeploy.

### 82. Seguridad — rate-limit de login/sensibles (express-rate-limit) a Redis, con fallback a memoria
- **Continuación de #81:** ahora los limiters de `express-rate-limit` que protegen brute-force: `authLimiter` (10/min: login, register, check-username, change-password, login-otp…) y `sensitiveLimiter` (10/15min: reset password, verify-phone, OTP). También vivían en memoria por instancia → ~N× en multi-instancia.
- **Fix:** custom Store `RedisBackedRateStore` (server.js, sección rate limiting) que implementa la interfaz de express-rate-limit v7 (`init`/`increment`/`decrement`/`resetKey`) con backend Redis (`INCR`+`EXPIRE`, contador compartido entre instancias). Reusa `getRedisClient()` (node-redis v4) — sin dependencias nuevas. Se aplica vía `store: makeRateStore('auth'|'sensitive')`.
- **Diseño a prueba de roturas (clave, porque esto envuelve el LOGIN):**
  - El store DELEGA al `MemoryStore` de la propia librería como fallback. Ante NO-Redis o CUALQUIER error de Redis (`try/catch`), usa el MemoryStore → **comportamiento idéntico al de hoy** (memoria por instancia). Nunca crashea ni bloquea login por un problema de infra.
  - `makeRateStore` devuelve `undefined` si la lib no expusiera `MemoryStore` → el limiter usa su store por defecto (= comportamiento actual). Imposible romper el arranque.
  - `authLimiter` NO usa `skipSuccessfulRequests` (es contador simple) → no hay semántica especial que preservar.
- **Decisión de alcance (mínimo radio de impacto):** **`generalLimiter` (envuelve TODO `/api/`) NO se tocó** — no es un gate de brute-force (es DoS general, 300/min) y es el más riesgoso de tocar. Queda en memoria.
- **Limitación honesta:** en este entorno no se puede correr el server (sin node_modules) → `node --check` valida sintaxis pero NO el runtime. El diseño con fallback al MemoryStore de la lib hace que el peor caso sea = comportamiento actual, pero conviene mirar los logs tras el primer deploy (buscar `Redis rate-limit error` o 429 inesperados en login).
- **Validado:** `node --check` OK (server.js). Sin migraciones. Back necesita redeploy. Beneficio multi-instancia activo cuando `REDIS_URL`/`REDIS_HOST` esté seteado.

### 81. Seguridad — rate-limit de SMS/registro a Redis (anti-spam multi-instancia) con fallback a memoria
- **Problema (deuda de #80):** los limiters por IP de SMS/registro (`smsIpLimiter` 5/15min, `bulkSmsIpLimiter` 1/h, `registerIpLimiter` 3/h) vivían en un `Map` EN MEMORIA por instancia. En AWS EB multi-instancia, cada instancia contaba por su lado → el límite efectivo era ~N× → riesgo de **spam de SMS (cuesta plata real, AWS SNS)** y creación masiva de cuentas para abusar del bono.
- **Fix:** `createIpSmsLimiter` ahora usa un **contador compartido en Redis** (`INCR` + `EXPIRE`, ventana fija) cuando Redis está disponible → el límite se respeta entre TODAS las instancias. Reusa el mismo cliente node-redis v4 + `getRedisClient()` que ya usa `acquireRefundLock` (patrón probado).
- **Sin romper nada (clave):** si NO hay Redis (instancia única / Redis no configurado) o si Redis **falla en medio**, cae automáticamente a la lógica EN MEMORIA original (ventana deslizante) vía `try/catch` → comportamiento idéntico al de antes, nunca crashea ni bloquea a un usuario legítimo por un problema de infra. **Los 3 límites quedan idénticos** (5/15min, 1/h, 3/h), así que para el usuario legítimo no cambia nada.
- **Detalle:** clave Redis `rl:<prefijo>:<ip>` (prefijos `sms`/`bulksms`/`register`); `getRedisClient()` solo devuelve el cliente si está `isReady`; el `Map` de memoria se mantiene como fallback (y su cleanup interval sigue válido).
- **NO migrado (queda pendiente):** los limiters de `express-rate-limit` (`authLimiter` login, `generalLimiter`, `sensitiveLimiter`) siguen en memoria. Migrarlos necesita la dep `rate-limit-redis` + resolver el orden de arranque (Redis conecta en el bootstrap, después de crear los limiters) y `authLimiter` tiene `skipSuccessfulRequests` (semántica distinta) → se deja para una tanda dedicada con cuidado.
- **Validado:** `node --check` OK (server.js). Sin migraciones. Back necesita redeploy. (Si no hay Redis configurado en EB, el SMS sigue protegido como hoy por instancia; el beneficio multi-instancia aparece cuando `REDIS_URL`/`REDIS_HOST` esté seteado, que es lo que ya usa el adapter de Socket.IO.)

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
