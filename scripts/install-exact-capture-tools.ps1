param([switch]$SkipDocker)
$ErrorActionPreference = 'Stop'
Write-Host 'Installing optional exact-capture tools…'
if (-not $SkipDocker) { docker pull webrecorder/browsertrix-crawler:latest }
if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
  npm.cmd install --global single-file-cli
}
Write-Host 'Browsertrix Crawler runs from Docker image webrecorder/browsertrix-crawler (not npm).'
Write-Host 'ReplayWeb.page is a desktop replay application; install it separately from https://replayweb.page/ if WACZ replay is required.'
Write-Host 'Run scripts/check-exact-capture-dependencies.ps1 to verify availability.'
