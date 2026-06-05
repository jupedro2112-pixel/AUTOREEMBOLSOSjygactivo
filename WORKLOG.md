# WORKLOG — Estado vivo del proyecto

> Se actualiza tras cada cambio significativo (ver regla en `CLAUDE.md`). El detalle
> commit por commit está en `git log --oneline`. Esto captura decisiones, umbrales de
> negocio y pendientes que NO se ven leyendo el código.
>
> **Última actualización: 2026-06-05**

## Sesión 2026-06-05

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
