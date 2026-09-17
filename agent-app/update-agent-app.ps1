[CmdletBinding()]
param(
  [ValidateSet("opencode", "codex", "claudecode", "qodercncli")]
  [string[]]$Agent = @("opencode", "codex", "claudecode", "qodercncli"),
  [ValidateSet("linux-x64", "linux-x64-musl", "linux-arm64", "linux-arm64-musl")]
  [string[]]$Platform = @(),
  [switch]$Latest,
  [switch]$Locked,
  [switch]$Check,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$taskModeCount = @($Latest, $Locked, $Check).Where({ $_.IsPresent }).Count
if ($taskModeCount -gt 1) { throw "Choose only one of -Latest, -Locked and -Check." }
$taskNode = Join-Path $PSScriptRoot "..\runtime\node.exe"
if (-not (Test-Path -LiteralPath $taskNode -PathType Leaf)) {
  $taskNodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $taskNodeCommand) { throw "Node.js 22.13+ is required. Use an EasyWork release with its bundled runtime." }
  $taskNode = $taskNodeCommand.Source
}
$taskArguments = @("--agent", ($Agent -join ","))
if ($Platform.Count -gt 0) { $taskArguments += @("--platform", ($Platform -join ",")) }
if ($Latest) { $taskArguments += "--latest" }
elseif ($Check) { $taskArguments += "--check" }
else { $taskArguments += "--locked" }
if ($Help) { $taskArguments += "--help" }
& $taskNode (Join-Path $PSScriptRoot "update-agent-app.mjs") @taskArguments
exit $LASTEXITCODE
