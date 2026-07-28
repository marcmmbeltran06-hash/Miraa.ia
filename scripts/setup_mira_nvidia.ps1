param(
  [string]$EngineDirectory = (Join-Path $PSScriptRoot '..\tools\mira-fashn-engine')
)

$ErrorActionPreference = 'Stop'
$enginePath = (Resolve-Path -LiteralPath $EngineDirectory).Path
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker Desktop no está instalado o no está disponible en PATH.'
}
if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
  throw 'No se detecta el controlador NVIDIA. Instala el driver de la GPU antes de continuar.'
}

docker info | Out-Null
nvidia-smi

$envFile = Join-Path $enginePath '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
  $tokenBytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Fill($tokenBytes)
  $token = [Convert]::ToHexString($tokenBytes)
  Set-Content -LiteralPath $envFile -Value "MIRA_ENGINE_TOKEN=$token" -Encoding utf8
}

Push-Location $enginePath
try {
  docker compose build
  docker compose run --rm mira-fashn python3.11 /app/fashn-vton/scripts/download_weights.py --weights-dir /app/weights
  docker compose up -d
  docker compose ps
} finally {
  Pop-Location
}

Write-Host 'Motor listo en http://127.0.0.1:8000'
Write-Host 'Copia el mismo token de tools/mira-fashn-engine/.env a MIRA_TRYON_ENGINE_TOKEN en packages/api/.env.'
