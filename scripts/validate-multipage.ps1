param(
  [Parameter(Mandatory=$true)][string]$SitePath,
  [int]$Port = 8080
)
$ErrorActionPreference = 'Stop'
$manifest = Join-Path $SitePath 'route-map.json'
if (-not (Test-Path $manifest)) { throw "route-map.json not found: $manifest" }
$data = Get-Content $manifest -Raw | ConvertFrom-Json
$results = @()
foreach ($route in @($data.routes)) {
  $path = [string]$route.localPath
  if ([string]::IsNullOrWhiteSpace($path)) { $path = '/' }
  $url = "http://127.0.0.1:$Port$path"
  try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -MaximumRedirection 5
    $results += [pscustomobject]@{ path=$path; url=$url; status=[int]$response.StatusCode; local=$true; error=$null }
  } catch {
    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    $results += [pscustomobject]@{ path=$path; url=$url; status=$code; local=$false; error=$_.Exception.Message }
  }
}
$report = [pscustomobject]@{ generatedAt=(Get-Date).ToUniversalTime().ToString('o'); routesDetected=$results.Count; routesLocal=(@($results | Where-Object local).Count); brokenRoutes=(@($results | Where-Object { -not $_.local }).Count); status=if ((@($results | Where-Object { -not $_.local }).Count) -eq 0) {'pass'} else {'needs_reconstruction'}; routes=$results }
$out = Join-Path $SitePath 'validation\multipage-runtime-report.json'
$report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $out
$report | Format-List
