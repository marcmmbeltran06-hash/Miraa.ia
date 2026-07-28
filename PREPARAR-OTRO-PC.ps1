$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot

function Require-Command([string]$Name, [string]$Help) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Falta $Name. $Help"
  }
}

Require-Command 'node' 'Instala Node.js 22.'
Require-Command 'corepack' 'Reinstala Node.js 22 incluyendo Corepack.'
Require-Command 'python' 'Instala Python 3.11.'
Require-Command 'docker' 'Instala Docker Desktop con WSL2 para utilizar la GPU NVIDIA.'

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -ne 22) {
  throw "Este proyecto requiere Node.js 22. Versión detectada: $(node --version)."
}

Push-Location $projectRoot
try {
  corepack enable
  corepack prepare pnpm@11.9.0 --activate
  pnpm install --frozen-lockfile
  python -m pip install -r scripts\requirements-campaign.txt
  pnpm exec playwright install chromium

  if (-not (Test-Path packages\web\.env)) {
    Copy-Item packages\web\.env.example packages\web\.env
  }
  if (-not (Test-Path packages\api\.env)) {
    Copy-Item packages\api\.env.example packages\api\.env
  }

  pnpm --filter @autowp/api run build
  pnpm --filter @autowp/web run build
} finally {
  Pop-Location
}

Write-Host ''
Write-Host 'Preparación terminada.'
Write-Host 'Siguiente paso: ejecuta scripts\setup_mira_nvidia.ps1 y después INICIAR-MIRA.ps1.'
