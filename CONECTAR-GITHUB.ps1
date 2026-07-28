$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$repository = 'https://github.com/marcmmbeltran06-hash/Miraa.ia.git'
$branch = 'main'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'Instala Git para Windows antes de conectar el proyecto.'
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw 'Instala GitHub CLI desde https://cli.github.com/ y vuelve a ejecutar este archivo.'
}

gh auth status
Push-Location $projectRoot
try {
  if (-not (Test-Path '.git')) {
    git init
    git remote add origin $repository
    git fetch origin main
    git checkout -B $branch origin/main
  } else {
    $currentRemote = git remote get-url origin 2>$null
    if (-not $currentRemote) { git remote add origin $repository }
    elseif ($currentRemote -ne $repository) { git remote set-url origin $repository }
    git fetch origin main
    git checkout $branch
    git pull --ff-only origin $branch
  }

  git add .npmrc .gitignore package.json pnpm-lock.yaml pnpm-workspace.yaml vercel.json packages scripts docs tools/mira-fashn-engine PREPARAR-OTRO-PC.ps1 INICIAR-MIRA.ps1 CONECTAR-GITHUB.ps1 OTRO-PC-LEEME.md
  git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) {
    git commit -m 'Añadir generador de campañas Mira'
  }
  git push -u origin $branch

} finally {
  Pop-Location
}

Write-Host 'Programa conectado a la rama principal. Las campañas nuevas se publicarán en el dominio de producción.'
