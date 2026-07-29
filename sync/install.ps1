[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDirectory
$sharedRoot = Split-Path -Parent $projectRoot
$projectName = Split-Path -Leaf $projectRoot
$ignoreFile = Join-Path $sharedRoot ".stignore"
$sharedRules = Join-Path $scriptDirectory "stignore.shared"
$includeLine = "#include $projectName/sync/stignore.shared"

if (-not (Test-Path -LiteralPath $sharedRules -PathType Leaf)) {
  throw "缺少共享忽略规则：$sharedRules"
}

if (-not (Test-Path -LiteralPath $ignoreFile -PathType Leaf)) {
  [System.IO.File]::WriteAllText(
    $ignoreFile,
    "$includeLine`r`n",
    [System.Text.UTF8Encoding]::new($false)
  )
  Write-Host "[同步] 已创建本机 Syncthing 忽略入口：$ignoreFile" -ForegroundColor Green
  exit 0
}

$current = Get-Content -LiteralPath $ignoreFile -Raw -Encoding UTF8
if ($current -notmatch "(?m)^\s*#include\s+$([regex]::Escape("$projectName/sync/stignore.shared"))\s*$") {
  $separator = if ($current.EndsWith("`n")) { "" } else { "`r`n" }
  [System.IO.File]::AppendAllText(
    $ignoreFile,
    "$separator$includeLine`r`n",
    [System.Text.UTF8Encoding]::new($false)
  )
  Write-Host "[同步] 已把 EasyWork 缓存隔离规则加入：$ignoreFile" -ForegroundColor Green
} else {
  Write-Host "[同步] 本机缓存隔离规则已启用。" -ForegroundColor DarkGreen
}

