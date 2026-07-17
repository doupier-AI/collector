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
  if ($package.scripts.'dev:desktop' -or $package.scripts.'test:gui') { Add-Issue "error" "retired-desktop-script" "Electron scripts remain in package.json" }
  if ($package.devDependencies.electron -or $package.devDependencies.'electron-builder' -or $package.devDependencies.'@electron/packager') {
    Add-Issue "error" "retired-electron-dependency" "Electron dependencies remain in package.json"
  }
}

try {
  $nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
  if ($nodeMajor -lt 24) { Add-Issue "error" "node-version" "Collector requires Node 24+; found Node $nodeMajor" }
} catch {
  Add-Issue "error" "node-missing" "Node.js is unavailable"
}

if (Test-Path -LiteralPath (Join-Path $Root "apps\desktop-capture")) {
  Add-Issue "error" "retired-desktop-source" "apps/desktop-capture must stay removed"
}

$http = Read-ProjectFile "apps\api\src\http.ts"
if ($http -match 'Access-Control-Allow-Origin[^\r\n]*\*') {
  Add-Issue "error" "wildcard-cors" "Local API still permits wildcard CORS"
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
