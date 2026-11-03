param(
    [string]$Proxy = 'http://127.0.0.1:7893',
    [ValidateRange(1, 65535)]
    [int]$DebugPort = 9223,
    [switch]$WithBridge
)

$ErrorActionPreference = 'Stop'
$bypassList = '<-loopback>;localhost;127.0.0.1;::1;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*'

if (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) {
    Write-Host 'Codex is already running.'
    Write-Host 'Fully exit Codex first, then run this launcher again.'
    exit 1
}

$package = Get-AppxPackage -Name OpenAI.Codex
if (-not $package) {
    Write-Host 'OpenAI.Codex package was not found.'
    exit 2
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PackagedAppLauncher
{
    [Flags]
    private enum ActivateOptions { None = 0 }

    [ComImport]
    [Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationActivationManager
    {
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            ActivateOptions options,
            out uint processId);

        int ActivateForFile(string appUserModelId, IntPtr itemArray, string verb, out uint processId);
        int ActivateForProtocol(string appUserModelId, IntPtr itemArray, out uint processId);
    }

    [ComImport]
    [Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    private class ApplicationActivationManager { }

    public static uint Launch(string appUserModelId, string arguments)
    {
        var manager = (IApplicationActivationManager)new ApplicationActivationManager();
        uint processId;
        int hresult = manager.ActivateApplication(appUserModelId, arguments, ActivateOptions.None, out processId);
        Marshal.ThrowExceptionForHR(hresult);
        return processId;
    }
}
'@

$appUserModelId = "$($package.PackageFamilyName)!App"
$arguments = "--proxy-server=$Proxy --proxy-bypass-list=`"$bypassList`" --disable-quic"
if ($WithBridge) {
    $arguments += " --remote-debugging-address=127.0.0.1 --remote-debugging-port=$DebugPort"
}

try {
    $processId = [PackagedAppLauncher]::Launch($appUserModelId, $arguments)
    Write-Host "Codex started through the Windows app activator. PID: $processId"
    $bridgeStart = Join-Path $PSScriptRoot '..\browser-bridge\start.ps1'
    if ($WithBridge) {
        try { & $bridgeStart }
        catch { Write-Warning "Codex started, but Browser Bridge startup failed: $($_.Exception.Message)" }
    }
    exit 0
}
catch {
    Write-Host "Failed to start Codex: $($_.Exception.Message)"
    exit 3
}
