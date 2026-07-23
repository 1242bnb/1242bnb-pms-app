# Respaldo en la nube de la PWA y del worker de push, con wrangler.
#
# POR QUE ASI: este repo NO tiene remoto de git, asi que la carpeta local era la unica copia
# del fuente y de todo su historial. R2 seria el lugar natural, pero no esta habilitado en la
# cuenta (dashboard -> R2), asi que el respaldo vive en un namespace KV.
#
# QUE SUBE: un `git bundle --all` (un solo archivo con TODAS las ramas y TODO el historial;
# se restaura con `git clone <bundle> <carpeta>`) + un zip del worker de push, que no tiene git.
#
# USO:  .\respaldar.ps1
# RESTAURAR:  ver el bloque del final de este archivo.

$ErrorActionPreference = 'Stop'

$NS      = '088541bc24934ca6a8193fbdba54e793'   # namespace KV "backups"
$APP     = 'C:\Users\sukov\Documents\1242bnb-pms-app'
$PUSH    = 'C:\Users\sukov\Documents\1242bnb-push'
$FECHA   = Get-Date -Format 'yyyy-MM-dd'
$TMP     = Join-Path $env:TEMP "respaldo-1242bnb"

if (Test-Path $TMP) { Remove-Item $TMP -Recurse -Force }
New-Item -ItemType Directory -Path $TMP -Force | Out-Null

# --- 1. PWA: bundle de git -------------------------------------------------------------
# El bundle solo captura lo COMMITEADO. Si el arbol esta sucio, se avisa y se corta: un
# respaldo que dice tener todo y no lo tiene es peor que no tener respaldo.
$sucio = git -C $APP status --porcelain
if ($sucio) {
  Write-Host "ABORTADO: hay cambios sin commitear en $APP" -ForegroundColor Red
  $sucio
  exit 1
}
$bundle = Join-Path $TMP '1242bnb-pms-app.bundle'
git -C $APP bundle create $bundle --all
git -C $APP bundle verify $bundle | Out-Null
Write-Host ("bundle: {0:N0} bytes - HEAD {1}" -f (Get-Item $bundle).Length, (git -C $APP rev-parse --short HEAD))

# --- 2. Worker de push: tambien por bundle (versionado desde el 23/07/2026) -------------
$sucioP = git -C $PUSH status --porcelain
if ($sucioP) {
  Write-Host "ABORTADO: hay cambios sin commitear en $PUSH" -ForegroundColor Red
  $sucioP
  exit 1
}
$bundleP = Join-Path $TMP '1242bnb-push.bundle'
git -C $PUSH bundle create $bundleP --all
git -C $PUSH bundle verify $bundleP | Out-Null
Write-Host ("bundle push: {0:N0} bytes - HEAD {1}" -f (Get-Item $bundleP).Length, (git -C $PUSH rev-parse --short HEAD))

# --- 3. Subir a KV ----------------------------------------------------------------------
# Clave con fecha: cada corrida deja su propia copia en vez de pisar la anterior.
Push-Location $APP
npx wrangler kv key put "1242bnb-pms-app/$FECHA.bundle" --path $bundle  --namespace-id $NS --remote
npx wrangler kv key put "1242bnb-push/$FECHA.bundle"    --path $bundleP --namespace-id $NS --remote
Pop-Location

Write-Host ""
Write-Host "Respaldo subido. Claves en el namespace:" -ForegroundColor Green
Push-Location $APP
npx wrangler kv key list --namespace-id $NS --remote | Select-String '"name"'
Pop-Location

Remove-Item $TMP -Recurse -Force

# ============================================================================================
# RESTAURAR (desde cualquier maquina con wrangler autenticado en 1242bnb@gmail.com)
#
#   # 1. Bajar el bundle. OJO: la redireccion tiene que ser por cmd, no por PowerShell:
#   #    PowerShell pasa la salida por su pipeline de texto y corrompe los bytes.
#   cmd /c "npx wrangler kv key get ""1242bnb-pms-app/2026-07-23.bundle"" --namespace-id 088541bc24934ca6a8193fbdba54e793 --remote > app.bundle"
#
#   # 2. Clonar el repo completo, con historial
#   git clone app.bundle 1242bnb-pms-app
#
#   # 3. Verificar
#   git -C 1242bnb-pms-app rev-parse "HEAD^{tree}"    # debe coincidir con el original
#
# NOTA sobre tamanos: los archivos restaurados pesan mas que los originales (~1 byte por
# linea). No es corrupcion: es core.autocrlf=true convirtiendo LF a CRLF en el checkout. Lo
# que se compara para saber si el contenido es identico es el hash del arbol, no los bytes.
# ============================================================================================
