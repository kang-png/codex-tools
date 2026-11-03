$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -Filter '*.ps1') {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    if ($errors) { throw ($errors | Out-String) }
    if ($file.Name -eq 'CodexProxyLauncher.ps1') {
        $source = $ast.Find({ param($node)
            $node -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
            $node.Value.Contains('public static class PackagedAppLauncher')
        }, $true)
        if (-not $source) { throw 'Launcher C# source was not found.' }
        Add-Type -TypeDefinition $source.Value
    }
    Write-Output "OK: $($file.Name)"
}
