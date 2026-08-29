#!/usr/bin/env bash
# =============================================================================
# Carga masiva de secretos a AWS SSM Parameter Store para un proyecto nuevo.
# Sirve como reemplazo de CloudShell: pegarlo entero en una terminal con la AWS
# CLI (EC2 Instance Connect de una instancia con rol IAM que permita
# ssm:PutParameter, o la CLI local con access keys).
#
# USO:
#   1. Cambiá P= por el path del proyecto (el mismo que va en SSM_PATH de EB).
#   2. Completá los valores entre comillas simples. Si un valor tiene una comilla
#      simple, escribila como '\'' (o usá comillas dobles si no tiene $ ni ").
#   3. Borrá las líneas que no apliquen. Pegá TODO en la terminal.
#   4. Verificá:  aws ssm get-parameters-by-path --path "$P" --with-decryption \
#                   --region $R --query 'Parameters[].Name' --output text
#
# El server lee con GetParametersByPath (Recursive:false, WithDecryption) → los
# parámetros van DIRECTO bajo el path, sin subcarpetas: /nuevoproyecto/prod/MONGODB_URI
# ⚠️ PROXY_URL y PUBLIC_BASE_URL NO van en SSM (se leen al require, antes del
#    bootstrap): van como "environment properties" de Elastic Beanstalk, junto con
#    SSM_PATH, NODE_ENV=production y PORT=8080.
# =============================================================================
set -e
P="/nuevoproyecto/prod"      # ← SSM_PATH del proyecto
R="sa-east-1"                # ← región

put() { aws ssm put-parameter --region "$R" --name "$P/$1" --value "$2" --type SecureString --overwrite >/dev/null && echo "✅ $1"; }

# --- Base / auth -------------------------------------------------------------
put MONGODB_URI            'mongodb+srv://usuario:pass@cluster.mongodb.net/dbname?retryWrites=true&w=majority'
put JWT_SECRET             'CAMBIAR-string-largo-aleatorio-1'
put JWT_REFRESH_SECRET     'CAMBIAR-string-largo-aleatorio-2'
put ADMIN_USERNAME         'admin'
put ADMIN_PASSWORD         'CAMBIAR'
put ALLOWED_ORIGINS        'https://nuevoproyecto.com,https://www.nuevoproyecto.com'
put ADMIN_HOST             'admin.nuevoproyecto.com'      # host desde el que se sirve el panel (opcional)

# --- JUGAYGANA ---------------------------------------------------------------
put PLATFORM_USER          'usuario-agente-jugaygana'
put PLATFORM_PASS          'CAMBIAR'
put JUGAYGANA_API_KEY      'CAMBIAR'                      # si el cliente lo usa
put JUGAYGANA_REPORTS_USER 'usuario-reportes'             # royalty-statistics (referidos/reembolsos)
put JUGAYGANA_REPORTS_PASS 'CAMBIAR'
# JUGAYGANA_REVENUE_DATE_FORMAT no hace falta: el default del código ya es epoch_s (#148)

# --- hgcash (banco automático) ----------------------------------------------
put HGCASH_API_URL         'https://api.hgcash.xxx'
put HGCASH_API_TOKEN       'CAMBIAR'
put HGCASH_WEBHOOK_SECRET  'CAMBIAR'                      # HMAC del webhook (mismo en todos los proyectos que comparten cuenta)
put HGCASH_FANOUT_URL      'off'                          # 'off' salvo que ESTE proyecto deba reenviar el webhook a un hermano

# --- IA (comprobantes + auditoría) ------------------------------------------
put ANTHROPIC_API_KEY      'sk-ant-CAMBIAR'
# COMPROBANTE_AI_MODEL / AUDIT_AI_MODEL: no ponerlos (se manejan desde 🔐 Config privada)

# --- Firebase (push) ---------------------------------------------------------
put FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 'CAMBIAR-base64-del-json-de-la-service-account'

# --- SMS (AWS SNS) -----------------------------------------------------------
put AWS_SNS_REGION         'us-east-1'
put AWS_ACCESS_KEY_ID      'AKIA-CAMBIAR'                 # usuario IAM solo con permiso sns:Publish
put AWS_SECRET_ACCESS_KEY  'CAMBIAR'

# --- Redis (Socket.IO multi-instancia + rate limits) ------------------------
put REDIS_URL              'rediss://default:pass@host:6379'

# --- Meta (pixel / CAPI) -----------------------------------------------------
put META_PIXEL_ID          'CAMBIAR'
put META_CAPI_ACCESS_TOKEN 'CAMBIAR'

# --- Opcionales --------------------------------------------------------------
put S3_BUCKET              'nombre-bucket'                 # comprobantes/imágenes si se usa S3
put TELEGRAM_ALERT_BOT_TOKEN '123456:CAMBIAR'             # opcional: también se carga desde el panel
put TELEGRAM_ALERT_CHAT_ID   '-100CAMBIAR'
# SMS_MASIVO_PASSWORD: ya no hace falta (la clave vive en 🔐 Config privada, #129)

echo; echo "Listo. Parámetros en $P:"
aws ssm get-parameters-by-path --path "$P" --region "$R" --query 'Parameters[].Name' --output text | tr '\t' '\n'
