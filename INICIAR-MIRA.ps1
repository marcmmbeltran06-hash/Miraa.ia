$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$logs = Join-Path $projectRoot 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$pythonPath = (Get-Command python -ErrorAction Stop).Source
$env:AUTOWP_PYTHON = $pythonPath
$env:PORT = '3000'
$env:REPORT_CONCURRENCY = '32'
$env:REPORT_MAX_PAGES = '3'
$env:MIRA_TRYON_ENGINE_URL = 'http://127.0.0.1:8000'

$engineEnv = Join-Path $projectRoot 'tools\mira-fashn-engine\.env'
if (Test-Path $engineEnv) {
  $tokenLine = Get-Content $engineEnv | Where-Object { $_ -match '^MIRA_ENGINE_TOKEN=' } | Select-Object -First 1
  if ($tokenLine) { $env:MIRA_TRYON_ENGINE_TOKEN = $tokenLine.Substring('MIRA_ENGINE_TOKEN='.Length) }
}
$env:MIRA_FEMALE_MODEL_IMAGE = Join-Path $projectRoot 'packages\web\public\tryon-models\female-neutral.png'
$env:MIRA_MALE_MODEL_IMAGE = Join-Path $projectRoot 'packages\web\public\tryon-models\male-neutral.webp'

$pnpm = (Get-Command pnpm -ErrorAction Stop).Source
Start-Process -FilePath $pnpm -ArgumentList '--filter','@autowp/api','start' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'api.log') -RedirectStandardError (Join-Path $logs 'api-error.log')
Start-Process -FilePath $pnpm -ArgumentList '--filter','@autowp/web','dev','--host','127.0.0.1' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'web.log') -RedirectStandardError (Join-Path $logs 'web-error.log')

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 2
    if ($health.status -eq 'ok') { $ready = $true; break }
  } catch {
    Start-Sleep -Seconds 1
  }
}
if (-not $ready) {
  throw 'La aplicación no ha arrancado. Revisa logs\api-error.log.'
}

Start-Process 'http://127.0.0.1:5173/'
Write-Host 'Mira está abierto. Puedes probar una URL o seleccionar el Excel.'
