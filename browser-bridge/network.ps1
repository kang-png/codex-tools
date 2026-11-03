param([switch]$Remove, [ValidateRange(1, 65535)][int]$ExternalPort = 18443)
$ErrorActionPreference = 'Stop'
$description = 'CodexBrowserBridge-TLS'
$nat = New-Object -ComObject HNetCfg.NATUPnP
$mappings = $nat.StaticPortMappingCollection
if ($null -eq $mappings) { throw 'UPnP gateway is unavailable' }
$existing = @($mappings) | Where-Object { $_.ExternalPort -eq $externalPort -and $_.Protocol -eq 'TCP' }
if ($Remove) {
    if ($existing -and $existing.Description -eq $description) { $mappings.Remove($externalPort, 'TCP') }
    Get-NetFirewallRule -Name 'CodexBrowserBridge-TLS' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Write-Host 'Bridge network access removed.'
    exit 0
}
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'private\config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not ($config.certificate -and $config.privateKey)) { throw 'Configure HTTPS before opening network access.' }
$internalPort = $config.tlsPort
$route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1
$lan = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 -ExpandProperty IPAddress
if ($existing) {
    if ($existing.Description -ne $description -or $existing.InternalPort -ne $internalPort -or $existing.InternalClient -ne $lan) { throw "Port $ExternalPort belongs to another mapping; no change made." }
} else { $mappings.Add($externalPort, 'TCP', $internalPort, $lan, $true, $description) | Out-Null }
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js 22 or later is required. Install it and make node.exe available on PATH.' }
if (-not (Get-NetFirewallRule -Name 'CodexBrowserBridge-TLS' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'CodexBrowserBridge-TLS' -DisplayName 'Codex Browser Bridge HTTPS' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $internalPort -Program $node | Out-Null
}
Write-Host "HTTPS mapping is ready on port $externalPort."
