param([switch]$Foreground, [switch]$OpenNetwork)
$ErrorActionPreference = 'Stop'
$private = Join-Path $PSScriptRoot 'private'
if (-not (Test-Path -LiteralPath (Join-Path $private 'config.json'))) { & (Join-Path $PSScriptRoot 'setup.ps1') }
$config = Get-Content -LiteralPath (Join-Path $private 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($OpenNetwork) { & (Join-Path $PSScriptRoot 'network.ps1') }
$listener = Get-NetTCPConnection -LocalPort $config.localPort -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    if ($existing.CommandLine -and $existing.CommandLine.Contains((Join-Path $PSScriptRoot 'server.mjs'))) { Write-Host 'Codex Browser Bridge is already running.'; return }
    throw 'The bridge port is occupied by another process.'
}
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js 22 or later is required. Install it and make node.exe available on PATH.' }
$server = Join-Path $PSScriptRoot 'server.mjs'
if ($Foreground) { & $node $server; exit $LASTEXITCODE }
$child = Start-Process -FilePath $node -ArgumentList "`"$server`"" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $private 'server.log') -RedirectStandardError (Join-Path $private 'server-error.log') -PassThru
$child.Id | Set-Content -LiteralPath (Join-Path $private 'server.pid') -Encoding ascii
Write-Host "Codex Browser Bridge started. PID: $($child.Id)"
