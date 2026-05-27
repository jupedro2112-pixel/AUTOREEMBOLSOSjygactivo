# Guía de Despliegue en AWS Elastic Beanstalk con Redis

Esta guía explica paso a paso cómo configurar la app en AWS Elastic Beanstalk con múltiples instancias, usando Redis (ElastiCache) para que el chat en tiempo real funcione correctamente.

> **¿Por qué necesito Redis?**  
> Cuando tenés 2 o más instancias corriendo al mismo tiempo (como en Elastic Beanstalk con auto-scaling), cada servidor tiene su propia memoria. Si un usuario está conectado a la instancia A y un admin está en la instancia B, los mensajes **no se entregan**. Redis actúa como un canal compartido para que todas las instancias se comuniquen.

---

## Requisitos previos

- Cuenta de AWS activa.
- App ya desplegada en Elastic Beanstalk (EB).
- Acceso a la consola de AWS (https://console.aws.amazon.com).

---

## Paso 1 — Crear un Redis en AWS ElastiCache

1. Andá a la consola de AWS → **ElastiCache**.
2. Hacé clic en **"Create cache"** (o "Crear caché").
3. Elegí **Redis OSS** (no Memcached).
4. Configuración recomendada para producción:
   - **Cluster mode**: Deshabilitado (más simple, suficiente para este caso).
   - **Node type**: `cache.t3.micro` o `cache.t3.small` (suficiente para empezar).
   - **Number of replicas**: 0 si querés ahorrar costos, 1 si querés redundancia.
   - **Engine version**: La más reciente disponible (ej. 7.x).
5. En **"Connectivity"**:
   - **VPC**: Elegí la **misma VPC** que usa tu Elastic Beanstalk.
   - **Subnets**: Elegí las mismas subnets privadas de tu EB.
   - **Security group**: Creá uno nuevo (ej. `redis-sg`) o usá el existente de EB.
6. En **"Security group rules"** del grupo nuevo `redis-sg`:
   - Agregá una regla **Inbound**:
     - Tipo: `Custom TCP`
     - Puerto: `6379`
     - Source: el security group de tu entorno EB (ej. `eb-sg`)
   - Esto permite que las instancias de EB se conecten a Redis, pero nadie externo pueda acceder.
7. Hacé clic en **"Create"** y esperá unos minutos a que el estado sea **"Available"**.
8. Copiá el **"Primary endpoint"** (se ve como `tu-redis.xxxxx.cache.amazonaws.com:6379`).

---

## Paso 2 — Configurar las variables de entorno en Elastic Beanstalk

1. Andá a la consola de AWS → **Elastic Beanstalk** → tu entorno.
2. En el menú izquierdo, hacé clic en **"Configuration"**.
3. Buscá la sección **"Updates, monitoring, and logging"** → hacé clic en **"Edit"**.
4. Bajá hasta **"Environment properties"**.
5. Agregá la siguiente variable:

   | Nombre | Valor |
   |--------|-------|
   | `REDIS_URL` | `redis://tu-redis.xxxxx.cache.amazonaws.com:6379` |

   > Si tu Redis tiene contraseña (opcional en ElastiCache por defecto):  
   > `redis://:TU_PASSWORD@tu-redis.xxxxx.cache.amazonaws.com:6379`

   Alternativamente, podés usar variables separadas en lugar de `REDIS_URL`:

   | Nombre | Valor |
   |--------|-------|
   | `REDIS_HOST` | `tu-redis.xxxxx.cache.amazonaws.com` |
   | `REDIS_PORT` | `6379` |
   | `REDIS_PASSWORD` | *(dejar vacío si no tiene contraseña)* |

6. También revisá que estas variables estén configuradas:

   | Nombre | Descripción |
   |--------|-------------|
   | `MONGODB_URI` | URI de conexión a tu MongoDB Atlas |
   | `JWT_SECRET` | Clave secreta para JWT (usá algo largo y aleatorio) |
   | `ALLOWED_ORIGINS` | URLs permitidas, ej. `https://www.vipcargas.com,https://vipcargas.com` |
   | `NODE_ENV` | `production` |
   | `LOG_LEVEL` | `info` (en producción; usá `debug` solo para debugging) |

7. Hacé clic en **"Apply"**. EB va a reiniciar las instancias con las nuevas variables.

---

## Paso 3 — Habilitar Sticky Sessions en el Load Balancer (ALB)

Las sticky sessions hacen que un mismo usuario siempre llegue a la misma instancia durante su sesión. Esto reduce reconexiones de WebSocket y mejora la experiencia.

1. Andá a la consola de AWS → **EC2** → **Load Balancers**.
2. Encontrá el load balancer asociado a tu entorno EB (el nombre suele incluir el nombre de tu app).
3. Hacé clic en el load balancer → pestaña **"Target groups"**.
4. Hacé clic en el target group asociado.
5. Pestaña **"Attributes"** → **"Edit"**.
6. Habilitá **"Stickiness"**:
   - Type: `Load balancer generated cookie`
   - Duration: `1 day` (86400 segundos)
7. Guardá los cambios.

> **Nota**: Las sticky sessions son un complemento al Redis adapter, no un reemplazo. Si una instancia se cae, el usuario reconecta automáticamente a otra instancia y sigue recibiendo mensajes gracias a Redis.

---

## Paso 4 — Configurar el Load Balancer para WebSocket

Para que WebSocket funcione correctamente detrás de un ALB:

1. En el load balancer → pestaña **"Listeners"**.
2. Hacé clic en el listener HTTP (puerto 80) o HTTPS (puerto 443).
3. En **"Rules"** → las reglas existentes deberían estar bien, pero verificá que el **idle timeout** sea suficiente.
4. Andá a **"Load balancer attributes"** → **"Edit"**:
   - **Idle timeout**: cambialo a `120` segundos (por defecto es 60, muy corto para WebSocket).

---

## Paso 5 — Verificar que todo funciona

### En los logs de EB
1. Andá a EB → tu entorno → **"Logs"** → "Request last 100 lines".
2. Buscá estas líneas en los logs del servidor:
   - ✅ `Socket.IO Redis adapter initialized — multi-instance mode active` → Redis funcionando.
   - ⚠️ `Redis not configured... single-instance mode` → Redis **no** está conectado, revisá las variables.

### Prueba manual de multi-instancia
1. Abrí la app en dos navegadores/dispositivos diferentes.
2. Iniciá sesión como usuario en uno y como admin en el otro.
3. Enviá un mensaje desde el usuario.
4. Verificá que el admin lo recibe en tiempo real.
5. Repetí varias veces. Si Redis está bien configurado, siempre llega.

### Monitoreo en AWS
- **ElastiCache → Metrics**: mirá `CacheHits`, `CurrConnections`, `NetworkBytesOut`.
- **Elastic Beanstalk → Monitoring**: CPU, requests/sec, latencia p95.

---

## Preguntas frecuentes

### ¿Tengo que usar Redis si tengo 1 sola instancia?
No. Si `REDIS_URL` y `REDIS_HOST` no están configurados, la app funciona en modo "single-instance" sin Redis, igual que antes. Redis solo se activa si configurás alguna de esas variables.

### ¿Puedo usar Redis con contraseña?
Sí. En AWS ElastiCache podés habilitar "AUTH token" (contraseña). Luego configurá:
```
REDIS_URL=redis://:TU_PASSWORD@tu-host.cache.amazonaws.com:6379
```

### ¿Qué pasa si Redis se cae?
El servidor detecta el error y continúa en modo single-instance. Los mensajes pueden no llegar entre instancias hasta que Redis se recupere. Para mayor disponibilidad, configurá una réplica en ElastiCache.

### ¿Cómo cambio el nivel de logs?
Configurá la variable de entorno `LOG_LEVEL` en EB:
- `debug`: todos los logs (útil para debugging, ruidoso en producción).
- `info`: solo eventos importantes (recomendado en producción).
- `warn`: solo advertencias y errores.
- `error`: solo errores.

### ¿Cuántas instancias puedo tener?
Con Redis adapter no hay límite práctico en cuanto a mensajería. El límite real lo pone MongoDB Atlas, la CPU y la RAM de cada instancia. Para tu caso (1:1 chat, 5 admins, 10–20 msgs/min), 2–3 instancias `t3.medium` con Atlas M10 debería ser más que suficiente para cientos de usuarios activos.

---

## Resumen de variables de entorno necesarias

```
NODE_ENV=production
LOG_LEVEL=info
MONGODB_URI=mongodb+srv://usuario:password@cluster0.xxxxx.mongodb.net/db?retryWrites=true
JWT_SECRET=una-clave-muy-larga-y-aleatoria-aqui
ALLOWED_ORIGINS=https://www.vipcargas.com,https://vipcargas.com
REDIS_URL=redis://tu-redis.xxxxx.cache.amazonaws.com:6379
```

Para más información sobre AWS ElastiCache: https://docs.aws.amazon.com/elasticache/latest/red-ug/WhatIs.html

---

# Deployment en AWS — Configuración ALB y Variables de Entorno

## Configuración del ALB (Application Load Balancer)

### Sticky Sessions
- Habilitar en el Target Group
- Cookie: `AWSALB`
- Duración: 86400 segundos (1 día)

### Idle Timeout
- Configurar a **300 segundos** (necesario para WebSocket/Socket.IO)
- Default de AWS es 60s, que es muy corto para chat en tiempo real

### Health Check
- Path: `/api/health`
- Protocolo: HTTP
- Puerto: 3000
- Intervalo: 30s
- Threshold saludable: 2
- Threshold no saludable: 3

## Variables de entorno requeridas
- `JWT_SECRET` — Secreto para tokens JWT (obligatorio en producción)
- `MONGODB_URI` — URI de conexión a MongoDB
- `REDIS_URL` o `REDIS_HOST` + `REDIS_PORT` — Conexión a ElastiCache Redis
- `DB_PASSWORD` — Contraseña para acceso a base de datos del panel admin
- `NODE_ENV` — Establecer a `production`

## Variables opcionales
- `S3_BUCKET` — Nombre del bucket S3 para uploads de imágenes
- `AWS_REGION` — Región AWS (default: us-east-1)
- `ALLOWED_ORIGINS` — Orígenes permitidos para CORS (separados por coma)
- `LOG_LEVEL` — Nivel de log (default: info en producción)

