$ErrorActionPreference = 'Stop'
$private = Join-Path $PSScriptRoot 'private'
New-Item -ItemType Directory -Path $private -Force | Out-Null
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $private '/inheritance:r' '/grant:r' "*$($currentSid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict private-directory permissions' }
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js 22 or later is required. Install it and make node.exe available on PATH.' }
if (-not (Test-Path -LiteralPath (Join-Path $private 'config.json'))) {
    & $node (Join-Path $PSScriptRoot 'server.mjs') setup
    if ($LASTEXITCODE -ne 0) { throw 'Bridge setup failed' }
}
Write-Host 'Ready. The initial login password is in private\login-password.txt.'
