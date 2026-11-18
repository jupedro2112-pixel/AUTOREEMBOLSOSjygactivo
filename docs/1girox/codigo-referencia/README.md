# Código de referencia de la Partner API (copiado del gemelo CARGASGIROXactivo)

> Copia tal cual del repo gemelo al commit `f26b135` (2026-11-18). **Nada de esta carpeta se
> importa desde el server**: vive en `docs/` a propósito, para que tenerlo acá no cambie nada de lo
> que corre hoy. Es código que está en producción sobre la plataforma 1girox.
>
> Los archivos conservan los `require()` del repo de origen (`../utils/logger`, `../models`, …): no
> corren desde esta carpeta, hay que copiarlos a su lugar (abajo dice dónde va cada uno).

## Qué hay y dónde va cada cosa

### `services/` → `src/services/`

| Archivo | Qué es | Depende de | Listo para copiar |
|---|---|---|---|
| `giroxService.js` | **El cliente único de la Partner API**: altas, saldo, cargas, retiros, regalos (bono 0 con fallback), promocional (wager), SSO, stats + batch, config, reclamo de bonos, rate limit por key, reintentos, caches | `axios`, `uuid` (ya están en `package.json`), `src/utils/logger` (existe) | ✅ sí, tal cual |
| `giroxUserLinkService.js` | resuelve y guarda `User.giroxUserId` | `src/models` (`User`), el campo `giroxUserId` | después de sumar el campo al modelo |
| `giroxPublisherKeys.js` | alta de jugadores con la API key del publicista (`createUserAsPublisher`, `testKey`) | `src/models/Campaign` con `giroxApiKey` | después de sumar los campos al modelo |

`giroxService.js` arranca un `setInterval(...).unref()` al cargarse (limpieza de caches): por eso
no conviene dejarlo importado "por las dudas" antes de usarlo.

### `models/` → campos a SUMAR (no reemplazan nada)

- `User.campos-girox.js.txt` — `giroxUserId`, `giroxSyncStatus`, `giroxOwnerCampaign`,
  `giroxSyncError`, `giroxPasswordSynced`. Los `jugaygana*` de este repo no se tocan.
- `Campaign.campos-girox.js.txt` — `giroxApiKey` (`select:false`), `giroxApiKeysExtra`,
  `hasGiroxKey` (espejo booleano sin `select:false`: mantenerlo sincronizado en TODO camino que
  escriba o limpie la key).

### `utils/` → `src/utils/`

| Archivo | Para qué | Notas |
|---|---|---|
| `periodRanges.js` | rangos ayer / semana / mes en hora argentina (funciones puras) | reemplaza a los `get…RangeArgentinaEpoch` de `jugaygana.js`. No cambiar los strings de fecha: alimentan los `periodKey` de RefundClaim |
| `periodKey.js` | períodos de comisiones anclados a `-03:00` | ⚠️ este repo YA tiene un `src/utils/periodKey.js` distinto: comparar, no pisar |
| `refundTiers.js` | rangos de reembolso por pérdida del período (Bronce/Plata/Oro, editables) | decisión de negocio del gemelo; este repo tiene sus propias reglas |
| `cashbackFormula.js` | fórmula pura del reembolso en vivo acumulativo | espec en `specs/ESPEC-REEMBOLSO-1GIROX.md` |
| `bonusRollover.js` | rollover global de bonos (elige el multiplicador permitido) | espec en `specs/ESPEC-ROLLOVER-GLOBAL-…` |
| `bonusKind.js` | qué bono sale como normal y cuál como wager | opcional |
| `vipLevels.js` | escalera VIP por apostado acumulado | opcional |
| `holderKey.js` | normaliza el titular de un comprobante | lo usa un test |

### `scripts/` → `scripts/`

| Archivo | Qué hace |
|---|---|
| **`probar-partner-api.js`** | **Nuevo, escrito para esta mudanza.** Radiografía de una instalación: conexión/key, `GET /config`, `GET /agents` y, con `--player=`, saldo + netwin. Solo lectura, sin dependencias (corre en Tails). Se puede correr desde acá mismo |
| `migrate-users-to-girox.js` | crea/vincula a todos los usuarios en la plataforma nueva. Dry-run por default, reanudable, con throttling. Necesita `dotenv`, `mongoose` y los campos `girox*` del modelo. **No mueve saldos** |
| `check-tdz.js` | detecta rutas/usos de nivel superior antes de su `const` en `server.js` (el incidente #133 de este repo). `node scripts/check-tdz.js` |
| `test-bonus-kind.js`, `test-cashback-formula.js`, `test-rollover-multicuenta.js` | tests en frío de las utils de arriba (requieren `../src/utils/...`) |

### `server-extractos.js.txt` → pedazos de `server.js` para copiar/adaptar

No es un archivo ejecutable: son los bloques del `server.js` del gemelo que conectan el cliente con
la app, con un encabezado que dice qué es cada uno y de qué líneas salió:

1. hooks y resolvers que se le inyectan al cliente (saldo del cajero, rollover global, regalos como wager);
2. resolver `username → API key` del dueño del jugador (cache 60 s);
3. réplica de la contraseña en el login (una vez por usuario);
4. SSO — `POST /api/platform/session` con auto-reparación;
5. `GET /api/admin/girox/health` y `/test-sso`;
6. `_refundReference` (por qué sale del período);
7. `GET /api/admin/girox/stats-raw`;
8. un flujo de plata completo: `POST /api/refunds/claim/daily` (reserva atómica → netwin fresh → crédito con reference estable → rollback);
9. `GET /api/balance` y `/api/balance/live`;
10. `getGiroxBonusMultiplier`;
11. `_creditGiftWithRollover`;
12. `_deductChipsAtConfirm` (débito del retiro contra `available` + anti-retiro-fantasma);
13. radiografía de boot.

Usan helpers del gemelo que acá pueden llamarse distinto o no existir (`renderSystemCommand`,
`getRefundTiersByPeriod`, `_cashbackPaidBetween`, `featureFlags`, …): son ejemplo de PATRÓN, no
parche para aplicar.

### `specs/`

- `ESPEC-REEMBOLSO-1GIROX.md` — reembolso en vivo acumulativo sobre plata real (usa `bonus.granted`
  y el límite de 92 días de `/stats`).
- `ESPEC-ROLLOVER-GLOBAL-Y-MULTICUENTA-TITULAR.md` — rollover global de bonos.
- `REPLICA-2026-09-07-regalos-como-bono.md` — el parche "los regalos van como bono 0" explicado paso a paso.

## Orden mínimo para tener el cliente funcionando

```bash
cp docs/1girox/codigo-referencia/services/giroxService.js src/services/
node --check src/services/giroxService.js
# env: GIROX_API_URL, GIROX_API_KEY (SSM en EB / dashboard en Render), GIROX_PLAY_URL
```

y en `server.js`, DESPUÉS de decidir el diseño (ver `../PLAN-MUDANZA.md` §6):

```js
const girox = require('./src/services/giroxService');
// en el bootstrap, después de cargar los secrets:
if (!girox.isEnabled()) console.warn('[girox] faltan GIROX_API_URL / GIROX_API_KEY');
```

## Si el gemelo cambia

Esta carpeta es una foto. Para refrescarla, copiar de nuevo desde `CARGASGIROXactivo` los mismos
archivos (`src/services/girox*.js`, `src/utils/…`, `scripts/…`) y actualizar el commit de arriba.
