$ErrorActionPreference = 'SilentlyContinue'
Write-Host 'AutoWP EXACT_CAPTURE dependency check'
docker version | Out-Host
if ($LASTEXITCODE -eq 0) { Write-Host 'Docker: OK' } else { Write-Host 'Docker: NOT AVAILABLE (start Docker Desktop)' }
foreach ($tool in @('browsertrix','single-file','replaywebpage','pywb')) {
  $cmd = Get-Command $tool -ErrorAction SilentlyContinue
  if ($cmd) { Write-Host "${tool}: $(& $cmd.Source --version 2>$null | Select-Object -First 1)" } else { Write-Host "${tool}: optional/not installed" }
}
$playwright = Test-Path '.\node_modules\playwright'
Write-Host "Playwright workspace package: $playwright"
$drive = Get-PSDrive -Name (Get-Location).Path.Substring(0,1) -ErrorAction SilentlyContinue
if ($drive) { Write-Host "Free space (GB): $([math]::Round($drive.Free/1GB,2))" }
Write-Host 'External capture is optional; existing exports use the local snapshot fallback.'
