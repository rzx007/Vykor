param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$Unpacked,
    [switch]$RequireSignature,
    [string]$Publisher
)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP) {
    throw 'Run the silent install check on a fresh Windows CI runner. It registers Vykor for the current user.'
}

$uninstallRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
$existing = foreach ($root in $uninstallRoots) {
    Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | Get-ItemProperty |
        Where-Object DisplayName -EQ 'Vykor'
}
if ($existing -or (Get-Process Vykor -ErrorAction SilentlyContinue)) {
    throw 'This runner already has Vykor installed or running.'
}

$Installer = (Resolve-Path -LiteralPath $Installer).Path
$Unpacked = (Resolve-Path -LiteralPath $Unpacked).Path
$installDir = Join-Path (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path ("vykor-computer-install-" + [guid]::NewGuid())
$verifier = Join-Path $PSScriptRoot 'verify-cua-packaging.mjs'
$windowsPowerShellSecurity = Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1'
Import-Module $windowsPowerShellSecurity

function Assert-VykorSignature([string]$File) {
    if (!$RequireSignature) { return }
    $signature = Get-AuthenticodeSignature -LiteralPath $File
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.GetNameInfo('SimpleName', $false) -cne $Publisher) {
        throw "Invalid Vykor publisher signature ($($signature.Status)): $File"
    }
}

if ($RequireSignature -and [string]::IsNullOrWhiteSpace($Publisher)) { throw 'Set the expected Vykor signing publisher.' }
Assert-VykorSignature $Installer

$files = @('Vykor.exe', 'resources\elevate.exe', 'resources\app.asar')
foreach ($file in $files[0..1]) { Assert-VykorSignature (Join-Path $Unpacked $file) }

$uninstaller = Join-Path $installDir 'Uninstall Vykor.exe'
try {
    $install = Start-Process -FilePath $Installer -ArgumentList '/S', "/D=$installDir" -Wait -PassThru -WindowStyle Hidden
    if ($install.ExitCode -ne 0) { throw "NSIS install failed: $($install.ExitCode)" }
    if (!(Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'Missing installed uninstaller.' }
    Assert-VykorSignature $uninstaller
    foreach ($file in $files) {
        $expected = Get-FileHash -LiteralPath (Join-Path $Unpacked $file) -Algorithm SHA256
        $installed = Get-FileHash -LiteralPath (Join-Path $installDir $file) -Algorithm SHA256
        if ($expected.Hash -ne $installed.Hash) { throw "Installed file differs from the unpacked build: $file" }
    }
    & node $verifier --artifact (Join-Path $installDir 'resources')
    if ($LASTEXITCODE -ne 0) { throw 'Installed driver verification failed.' }
} finally {
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
        $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S', "_?=$installDir" -Wait -PassThru -WindowStyle Hidden
        if ($uninstall.ExitCode -ne 0) { throw "NSIS uninstall failed: $($uninstall.ExitCode)" }
        if ((Test-Path -LiteralPath (Join-Path $installDir 'Vykor.exe')) -or
            (Test-Path -LiteralPath (Join-Path $installDir 'resources\computer-windows\cua-driver.exe'))) {
            throw 'Vykor executable or Cua driver remained after uninstall.'
        }
        if (Test-Path -LiteralPath $uninstaller -PathType Leaf) { Remove-Item -LiteralPath $uninstaller }
    }
}
if (Test-Path -LiteralPath $installDir -PathType Container) {
    $leftovers = @(Get-ChildItem -LiteralPath $installDir -Force)
    if ($leftovers.Count -ne 0) { throw 'Private install directory was not empty after uninstall.' }
    Remove-Item -LiteralPath $installDir
}
Write-Output 'Verified the installed Cua files, Vykor files and uninstall cleanup.'
