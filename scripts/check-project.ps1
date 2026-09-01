param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")),
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
  if (-not $package.scripts.'test:e2e:sentinel') { Add-Issue "error" "missing-e2e-sentinel" "package.json has no high-risk E2E sentinel script" }
  if ($package.scripts.'dev:desktop' -or $package.scripts.'test:gui') { Add-Issue "error" "retired-desktop-script" "Electron scripts remain in package.json" }
  $ralphScripts = @($package.scripts.PSObject.Properties.Name | Where-Object { $_ -like 'ralph:*' })
  if ($ralphScripts.Count -gt 0) { Add-Issue "error" "retired-ralph-script" "Retired local Markdown Issue runner scripts remain in package.json" }
  if ($package.devDependencies.electron -or $package.devDependencies.'electron-builder' -or $package.devDependencies.'@electron/packager') {
    Add-Issue "error" "retired-electron-dependency" "Electron dependencies remain in package.json"
  }
}

$gateWorkflow = Read-ProjectFile ".github\workflows\gate.yml"
if (-not $gateWorkflow) {
  Add-Issue "error" "missing-gate-workflow" ".github/workflows/gate.yml was not found"
} else {
  $workflowSections = $gateWorkflow -split '(?m)^  full-gate:\s*$'
  if ($workflowSections.Count -ne 2) {
    Add-Issue "error" "ci-validation-levels" "GitHub workflow must keep separate daily gate and opt-in full-gate jobs"
  } else {
    $dailyGate = $workflowSections[0]
    $fullGate = $workflowSections[1]
    if ($dailyGate -notmatch 'npm run gate:fast') {
      Add-Issue "error" "daily-fast-gate" "Daily GitHub gate must run gate:fast for product-code changes"
    }
    if ($dailyGate -match 'npm run gate:e2e|npx playwright install chromium') {
      Add-Issue "error" "daily-full-e2e" "Daily GitHub gate must not install Chromium or run the full E2E gate"
    }
    if ($fullGate -notmatch 'npm run gate:e2e') {
      Add-Issue "error" "missing-full-e2e" "Opt-in full-gate must run gate:e2e"
    }
    if ($fullGate -notmatch 'npm run test:e2e:sentinel') {
      Add-Issue "error" "missing-e2e-sentinel" "Opt-in full-gate must run the high-risk E2E sentinel"
    } elseif ($fullGate.IndexOf('npm run test:e2e:sentinel') -gt $fullGate.IndexOf('npm run gate:e2e')) {
      Add-Issue "error" "late-e2e-sentinel" "High-risk E2E sentinel must run before the complete E2E gate"
    }
    foreach ($trigger in @('schedule', 'workflow_dispatch', 'full-gate')) {
      if ($fullGate -notmatch [regex]::Escape($trigger)) {
        Add-Issue "error" "missing-full-trigger" "Opt-in full-gate must support $trigger"
      }
    }
  }
  if ($gateWorkflow -notmatch '(?m)^\s+E2E_TRACK_CONCURRENCY:\s*["'']?1["'']?\s*$') {
    Add-Issue "error" "remote-e2e-concurrency" "GitHub full E2E gate must set E2E_TRACK_CONCURRENCY to 1 for runner stability"
  }
}

$playwrightConfig = Read-ProjectFile "apps\web\playwright.config.ts"
if (-not $playwrightConfig) {
  Add-Issue "error" "missing-playwright-config" "apps/web/playwright.config.ts was not found"
} elseif ($playwrightConfig -match '(?m)^\s*retries:\s*[1-9]\d*\s*,?\s*$') {
  Add-Issue "error" "e2e-retry-masks-failure" "Playwright retries must stay disabled; classification reruns cannot turn a first failure green"
}

try {
  $nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
  if ($nodeMajor -lt 24) { Add-Issue "error" "node-version" "Collector requires Node 24+; found Node $nodeMajor" }
} catch {
  Add-Issue "error" "node-missing" "Node.js is unavailable"
}

$worktreeSafety = & node (Join-Path $Root "scripts\worktree-safety.mjs") check --root $Root 2>&1
if ($LASTEXITCODE -ne 0) {
  foreach ($line in @($worktreeSafety)) {
    if ($line) { Add-Issue "error" "worktree-safety" $line }
  }
}

$answerQualityBoundary = & node (Join-Path $Root "scripts\check-answer-quality-boundary.mjs") 2>&1
if ($LASTEXITCODE -ne 0) {
  foreach ($line in @($answerQualityBoundary)) {
    if ($line) { Add-Issue "error" "answer-quality-boundary" $line }
  }
}

if (Test-Path -LiteralPath (Join-Path $Root "apps\desktop-capture")) {
  Add-Issue "error" "retired-desktop-source" "apps/desktop-capture must stay removed"
}

$ralphSource = Join-Path $Root "scripts\ralph"
if ((Test-Path -LiteralPath $ralphSource) -and @(Get-ChildItem -LiteralPath $ralphSource -Recurse -File).Count -gt 0) {
  Add-Issue "error" "retired-ralph-source" "scripts/ralph must stay removed; parallel work uses globally visible tasks and unified integration"
}

$http = Read-ProjectFile "apps\api\src\http.ts"
if ($http -match 'Access-Control-Allow-Origin[^\r\n]*\*') {
  Add-Issue "error" "wildcard-cors" "Local API still permits wildcard CORS"
}

$candidatePaths = & git -C $Root ls-files --cached --others --exclude-standard
foreach ($relativePath in $candidatePaths) {
  $file = Get-Item -LiteralPath (Join-Path $Root $relativePath) -ErrorAction SilentlyContinue
  if (-not $file -or $file.PSIsContainer -or $file.Length -ge 2MB) { continue }
  $content = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  if ($content -match '(?i)(sk-[a-z0-9]{20,}|DEEPSEEK_API_KEY\s*=\s*[^\s"'']+)') {
    Add-Issue "error" "possible-secret" "Possible API credential in $relativePath"
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
