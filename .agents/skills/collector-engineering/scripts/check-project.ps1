param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")),
  [switch]$Strict
)

$ErrorActionPreference = "Stop"
$issues = [System.Collections.Generic.List[object]]::new()

function Add-Issue([string]$Level, [string]$Code, [string]$Message) {
  $issues.Add([pscustomobject]@{ Level = $Level; Code = $Code; Message = $Message })
}

function Read-ProjectFile([string]$RelativePath) {
  $path = Join-Path $Root $RelativePath
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  return Get-Content -LiteralPath $path -Raw -Encoding UTF8
}

$packageJson = Read-ProjectFile "package.json"
if (-not $packageJson) {
  Add-Issue "error" "missing-package" "package.json was not found at $Root"
} else {
  $package = $packageJson | ConvertFrom-Json
  if (-not $package.scripts.test) { Add-Issue "error" "missing-tests" "package.json has no test script" }
  if (-not $package.scripts.'test:gui') { Add-Issue "warning" "missing-gui-smoke" "package.json has no test:gui script" }
}

try {
  $nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
  if ($nodeMajor -lt 24) { Add-Issue "error" "node-version" "Collector requires Node 24+; found Node $nodeMajor" }
} catch {
  Add-Issue "error" "node-missing" "Node.js is unavailable"
}

$electron = Join-Path $Root "node_modules\electron\dist\electron.exe"
if (-not (Test-Path -LiteralPath $electron)) {
  Add-Issue "warning" "electron-binary" "Electron package may compile, but the Windows runtime binary is missing"
}

$main = Read-ProjectFile "apps\desktop-capture\src\main.ts"
$preload = Join-Path $Root "apps\desktop-capture\src\preload.cts"
if ($main) {
  if ($main -notmatch 'preload\.cjs') { Add-Issue "error" "preload-format" "Electron main must load the CommonJS preload artifact" }
  if ($main -match 'nodeIntegration\s*:\s*true') { Add-Issue "error" "renderer-node" "Renderer Node integration must remain disabled" }
  if ($main -notmatch 'contextIsolation\s*:\s*true') { Add-Issue "error" "context-isolation" "Renderer context isolation is not explicitly enabled" }
  if ($main -match 'requestSingleInstanceLock' -and $main -notmatch 'COLLECTOR_INSTANCE_ID') {
    Add-Issue "warning" "instance-isolation" "Single-instance behavior has no explicit test instance ID"
  }
}
if (-not (Test-Path -LiteralPath $preload)) { Add-Issue "error" "preload-source" "Expected preload.cts is missing" }

$http = Read-ProjectFile "apps\api\src\http.ts"
if ($http -match 'Access-Control-Allow-Origin[^\r\n]*\*') {
  Add-Issue "error" "wildcard-cors" "Local API still permits wildcard CORS"
}

$guiSmoke = Read-ProjectFile "scripts\gui-smoke.mjs"
if ($guiSmoke) {
  foreach ($required in @('COLLECTOR_PORT', 'COLLECTOR_DATA_DIR', '--user-data-dir')) {
    if ($guiSmoke -notmatch [regex]::Escape($required)) {
      Add-Issue "error" "gui-isolation" "GUI smoke is missing isolation setting: $required"
    }
  }
}

$trackedCandidates = Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object {
    $_.FullName -notmatch '\\(node_modules|\.git|dist|dist-tests|build|release|\.collector-data|\.npm-cache)\\' -and
    $_.Length -lt 2MB
  }
foreach ($file in $trackedCandidates) {
  $content = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  if ($content -match '(?i)(sk-[a-z0-9]{20,}|DEEPSEEK_API_KEY\s*=\s*[^\s"'']+)') {
    Add-Issue "error" "possible-secret" "Possible API credential in $($file.FullName.Substring($Root.Length + 1))"
  }
}

if ($issues.Count -eq 0) {
  Write-Host "Collector project checks passed."
  exit 0
}

$issues | Sort-Object Level, Code | Format-Table -AutoSize
$errorCount = @($issues | Where-Object Level -eq "error").Count
$warningCount = @($issues | Where-Object Level -eq "warning").Count
Write-Host "Collector project checks: $errorCount error(s), $warningCount warning(s)."

if ($errorCount -gt 0 -or ($Strict -and $warningCount -gt 0)) { exit 1 }
