$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$python = (Get-Command python -ErrorAction Stop).Source
$excel = Join-Path $projectRoot 'Mira_2006_COMPLETO_FINAL.xlsx'

if (Test-Path $excel) {
  Start-Process -FilePath $python -ArgumentList @(
    (Join-Path $projectRoot 'scripts\whatsapp_queue_assistant.py'),
    $excel
  ) -WorkingDirectory $projectRoot -WindowStyle Hidden
} else {
  Start-Process -FilePath $python -ArgumentList @(
    (Join-Path $projectRoot 'scripts\whatsapp_queue_assistant.py')
  ) -WorkingDirectory $projectRoot -WindowStyle Hidden
}
