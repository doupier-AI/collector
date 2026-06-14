param(
  [string]$Issue,
  [string]$Model,
  [int]$TimeoutMinutes = 45,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$arguments = @(
  (Join-Path $PSScriptRoot "runner.mjs"),
  "--root", $repoRoot,
  "--timeout-minutes", $TimeoutMinutes
)

if ($Issue) { $arguments += @("--issue", $Issue) }
if ($Model) { $arguments += @("--model", $Model) }
if ($DryRun) { $arguments += "--dry-run" }

& node @arguments
exit $LASTEXITCODE
