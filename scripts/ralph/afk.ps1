param(
  [ValidateRange(1, 50)]
  [int]$Iterations = 3,
  [string]$Model,
  [int]$TimeoutMinutes = 45,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$arguments = @(
  (Join-Path $PSScriptRoot "runner.mjs"),
  "--root", $repoRoot,
  "--iterations", $Iterations,
  "--timeout-minutes", $TimeoutMinutes
)

if ($Model) { $arguments += @("--model", $Model) }
if ($DryRun) { $arguments += "--dry-run" }

& node @arguments
exit $LASTEXITCODE
