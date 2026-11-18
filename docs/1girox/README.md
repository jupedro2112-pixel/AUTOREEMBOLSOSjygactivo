# Partner API (1girox / jugaygana.io) — todo lo que hay que saber

> Cargado el 2026-11-18 desde el repo gemelo **CARGASGIROXactivo**, que corre sobre esta API desde
> el 2026-07-31. Objetivo: que este repo (hoy sobre JUGAYGANA, `admin.agentesadmin.bet`) pueda
> mudarse a **jugaygana.io** —una copia de 1girox que usa la misma Partner API— sin redescubrir
> nada.
>
> ⚠️ **Estado (#197, 2026-11-18):** esta carpeta sigue siendo documentación y código de referencia (nadie la importa), pero la
> mudanza YA está implementada en el repo, apagada por defecto: `src/services/giroxService.js` (copia del cliente de acá) y
> `src/services/platform.js`. Ver `docs/ARCHITECTURE.md` §10. Lo medido en jugaygana.io: `CONOCIMIENTO-EN-PRODUCCION.md` §15.

## Por dónde empezar

| Si querés… | Leé |
|---|---|
| saber qué endpoint existe y qué devuelve | [`PARTNER-API-v1.20.md`](PARTNER-API-v1.20.md) — el manual oficial completo, en Markdown (tabla resumen al final) |
| no romper plata | [`CONOCIMIENTO-EN-PRODUCCION.md`](CONOCIMIENTO-EN-PRODUCCION.md) §1 y §2 — cinco reglas + idempotencia por `reference` |
| planear la mudanza de ESTE repo | [`PLAN-MUDANZA.md`](PLAN-MUDANZA.md) — inventario de lo que usa JUGAYGANA acá, mapa función por función, saldos, interruptor, checklist |
| ver cómo está hecho en producción | [`codigo-referencia/`](codigo-referencia/README.md) — el cliente real y los extractos de `server.js` |
| saber cómo está configurada jugaygana.io | `node docs/1girox/codigo-referencia/scripts/probar-partner-api.js` (solo lectura, sin dependencias) |

## Qué hay en la carpeta

```
docs/1girox/
├── README.md                        este índice
├── PARTNER-APIv1.20.pdf             manual oficial (19 páginas)
├── PARTNER-APIv1.20.txt             texto crudo del PDF (para citar literal / grep)
├── PARTNER-API-v1.20.md             transcripción completa, ordenada, con notas de campo
├── CONOCIMIENTO-EN-PRODUCCION.md    lo que el manual no dice: pruebas en vivo, incidentes, decisiones
├── PLAN-MUDANZA.md                  JUGAYGANA → jugaygana.io para este repo
└── codigo-referencia/
    ├── README.md                    qué es cada archivo y dónde va
    ├── services/                    giroxService.js (cliente único) + link de IDs + keys de publicista
    ├── models/                      campos a sumar en User y Campaign
    ├── utils/                       rangos de fecha, rangos de reembolso, rollover, cashback, wager, VIP
    ├── scripts/                     diagnóstico, migración de usuarios, tests en frío, check-tdz
    ├── specs/                       especificaciones de reembolso en vivo, rollover global, regalos como bono
    └── server-extractos.js.txt      los bloques de server.js que conectan el cliente con la app
```

## La API en una pantalla

- REST/JSON, header fijo `X-Api-Key: pk_…`. Sin login, sin sesión, sin HTML de Cloudflare.
- Base URL **propia de cada instalación** (la de jugaygana.io hay que pedirla; `api-lbvip.com` es el
  ejemplo del manual, de otra marca).
- **60 req/min por key.** Montos en **pesos**. Todo por **username**.
- Operaciones de plata **idempotentes por `reference`** (hasta 100 caracteres).

| Endpoint | Para qué |
|---|---|
| `POST /players` | alta (username 3–18 `[A-Za-z0-9_]`, password ≥ 6) |
| `POST /players/validate` | validar usuario + clave |
| `GET /players/{u}` | datos, saldo, rollover (`wagering.available`), wager, id |
| `PUT /players/{u}/password` | cambiar clave |
| `POST /players/{u}/deposit` | carga (+ rollover, bono adjunto, código promocional) |
| `POST /players/{u}/withdraw` | retiro |
| `POST /players/{u}/session` | login único: link de un solo uso, 60 s |
| `POST /players/{u}/bonus` | bono suelto (multiplier 0 = regalo directo) |
| `POST /players/{u}/promo` | saldo promocional (wager) |
| `POST /players/{u}/bonus/claim` | destrabar bonos cumplidos |
| `GET /players/{u}/stats` · `POST /players/stats/batch` | netwin y apostado por rango (≤ 92 días, hora AR; batch ≤ 100) |
| `GET /config` | feats, multiplicadores, límites, reglas automáticas, motor de bonos |
| `GET /agents` | sub-agentes de la red |
| `GET /chip-requests` | solicitudes de carga/retiro del sitio (requiere habilitación) |

## Las cinco reglas

1. Montos en **pesos** (JUGAYGANA usa centavos: no multiplicar por 100).
2. Toda operación de plata lleva una **`reference` estable**; reintento = la misma. Mirar `duplicate`.
3. Retiros contra **`wagering.available`**, nunca contra `balance`.
4. Error transitorio ≠ fallo: **no cambiar de camino ni de reference**.
5. **`netwin` positivo = el jugador perdió.**

## Qué falta saber de jugaygana.io

Base URL, key, sitio del jugador, qué feats tiene prendidos y —lo más importante— si los jugadores
y sus saldos ya existen ahí. Lista completa en `CONOCIMIENTO-EN-PRODUCCION.md` §14 y
`PLAN-MUDANZA.md` §1 y §9.

## Versiones

- Manual: **v1.20** (2026-10-17). Si llega uno más nuevo: guardar el PDF acá, regenerar el `.txt`
  (`pdftotext -layout`) y actualizar la transcripción y el historial de cambios.
- Código de referencia: commit `f26b135` de CARGASGIROXactivo (2026-11-18).
