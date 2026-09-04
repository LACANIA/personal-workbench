[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$AppRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$MyAgentRoot = [System.IO.Path]::GetFullPath((Join-Path $AppRoot '..\..'))
$ReleaseRoot = [System.IO.Path]::GetFullPath((Join-Path $AppRoot 'releases'))
$Version = (Get-Content -Raw -LiteralPath (Join-Path $AppRoot 'package.json') | ConvertFrom-Json).version
$PackageName = "Personal-Workbench-$Version-win-x64"
$StageRoot = [System.IO.Path]::GetFullPath((Join-Path $ReleaseRoot ".stage-$PackageName"))
$PackageRoot = Join-Path $StageRoot $PackageName
$ZipPath = Join-Path $ReleaseRoot "$PackageName.zip"

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $Stream = [System.IO.File]::OpenRead($LiteralPath)
    try {
        $Algorithm = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([System.BitConverter]::ToString($Algorithm.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant()
        }
        finally {
            $Algorithm.Dispose()
        }
    }
    finally {
        $Stream.Dispose()
    }
}

if (-not $StageRoot.StartsWith($ReleaseRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'RELEASE_STAGE_PATH_DENIED'
}
if (Test-Path -LiteralPath $StageRoot) { Remove-Item -LiteralPath $StageRoot -Recurse -Force }
New-Item -ItemType Directory -Path $PackageRoot -Force | Out-Null

& pnpm.cmd run build
if ($LASTEXITCODE -ne 0) { throw "Workbench build failed: $LASTEXITCODE" }

$TargetApp = Join-Path $PackageRoot 'my-agent\apps\personal-workbench'
New-Item -ItemType Directory -Path $TargetApp -Force | Out-Null
foreach ($Name in @('package.json', 'README.md')) { Copy-Item -LiteralPath (Join-Path $AppRoot $Name) -Destination $TargetApp }
foreach ($Directory in @('shared', 'server', 'launchers', 'web\dist')) {
    $Source = Join-Path $AppRoot $Directory
    $Destination = Join-Path $TargetApp $Directory
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse
}

foreach ($Directory in @('plugins', 'config', 'launchers')) {
    $Source = Join-Path $MyAgentRoot $Directory
    if (Test-Path -LiteralPath $Source -PathType Container) {
        $Destination = Join-Path (Join-Path $PackageRoot 'my-agent') $Directory
        Copy-Item -LiteralPath $Source -Destination $Destination -Recurse
    }
}

foreach ($Directory in @('memory\api', 'memory\search', 'memory\schemas')) {
    $Source = Join-Path $MyAgentRoot $Directory
    if (Test-Path -LiteralPath $Source -PathType Container) {
        $Destination = Join-Path (Join-Path $PackageRoot 'my-agent') $Directory
        New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
        Copy-Item -LiteralPath $Source -Destination $Destination -Recurse
    }
}

Get-ChildItem -LiteralPath $PackageRoot -Recurse -File | Where-Object {
    $Name = $_.Name.ToLowerInvariant()
    $Name -eq 'local-config.json' -or $Name.EndsWith('.db') -or $Name.EndsWith('.db-wal') -or $Name.EndsWith('.db-shm')
} | Remove-Item -Force

$InstallText = @'
# Personal Workbench Portable Release

1. Install Node.js 24+, pnpm 11+ and Ollama.
2. Place or configure deepseek-harness and DSH_HOME on this computer.
3. Run `pnpm install` in `my-agent\apps\personal-workbench`.
4. Double-click `launchers\启动 Personal Workbench.cmd`.
5. The First Run Wizard creates `local-config.json` from detected paths. Review Harness, DSH_HOME and Research Memory paths before model tasks.

The package contains source, built Web assets and local adapters. It contains no model, cloud key, user database, session data or media file.
'@
$InstallText | Set-Content -LiteralPath (Join-Path $PackageRoot 'INSTALL.md') -Encoding UTF8

$Files = Get-ChildItem -LiteralPath $PackageRoot -Recurse -File | Sort-Object FullName | ForEach-Object {
    [ordered]@{
        path = $_.FullName.Substring($PackageRoot.Length + 1).Replace('\', '/')
        size = $_.Length
        sha256 = Get-Sha256Hex -LiteralPath $_.FullName
    }
}
$Manifest = [ordered]@{
    schema = 'personal-workbench.release.v1'
    version = $Version
    created_at = [DateTime]::UtcNow.ToString('o')
    platform = 'win32-x64'
    portable_config_version = 2
    excludes = @('models','media','cloud keys','runtime databases','sessions','node_modules')
    files = @($Files)
}
$Manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $PackageRoot 'release-manifest.json') -Encoding UTF8

if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
Compress-Archive -LiteralPath $PackageRoot -DestinationPath $ZipPath -CompressionLevel Optimal
$ZipHash = Get-Sha256Hex -LiteralPath $ZipPath
$Result = [ordered]@{ package = $ZipPath; sha256 = $ZipHash; files = @($Files).Count; size = (Get-Item -LiteralPath $ZipPath).Length }
$Result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $ReleaseRoot "$PackageName.manifest.json") -Encoding UTF8
Remove-Item -LiteralPath $StageRoot -Recurse -Force
$Result | ConvertTo-Json -Compress
