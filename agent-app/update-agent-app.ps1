[CmdletBinding()]
param(
  [ValidateSet("opencode", "codex", "claudecode", "qodercncli")]
  [string[]]$Agent = @(),
  [ValidateSet("linux-x64", "linux-x64-musl", "linux-arm64", "linux-arm64-musl")]
  [string[]]$Platform = @(),
  [switch]$All,
  [switch]$Locked,
  [switch]$Check,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
if ($Locked -and $Check) { throw "Choose only one of -Locked and -Check." }
if ($All -and $Agent.Count -gt 0) { throw "Choose either -Agent or -All." }
$taskNode = Join-Path $PSScriptRoot "..\runtime\node.exe"
if (-not (Test-Path -LiteralPath $taskNode -PathType Leaf)) {
  $taskNodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $taskNodeCommand) { throw "Node.js 22.13+ is required. Use an EasyWork release with its bundled runtime." }
  $taskNode = $taskNodeCommand.Source
}
$taskArguments = @()
if ($Agent.Count -gt 0) { $taskArguments += @("--agent", ($Agent -join ",")) }
if ($All) { $taskArguments += "--all" }
if ($Platform.Count -gt 0) { $taskArguments += @("--platform", ($Platform -join ",")) }
if ($Check) { $taskArguments += "--check" }
elseif ($Locked) { $taskArguments += "--locked" }
if ($Help) { $taskArguments += "--help" }
& $taskNode (Join-Path $PSScriptRoot "update-agent-app.mjs") @taskArguments
exit $LASTEXITCODE
