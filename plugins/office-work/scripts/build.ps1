param([switch]$PrepareOnly)
$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path $PSScriptRoot -Parent
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $pluginRoot '../..'))
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'packages/services/src/office/office-engine.mjs') -Destination (Join-Path $pluginRoot 'tools/office-engine.mjs') -Force
$engineDirectory = Join-Path $pluginRoot 'bin'
$enginePath = Join-Path $engineDirectory 'officecli-win-x64.exe'
$expected = '864e0580c8e8c91a6aa4a4c1e8900551c8d4aa648ff10136ceed3a6ba5310888'
New-Item -ItemType Directory -Force $engineDirectory | Out-Null
if (-not (Test-Path -LiteralPath $enginePath)) {
  $downloadPath = Join-Path $engineDirectory ('download-' + [guid]::NewGuid().ToString() + '.tmp')
  try {
    Invoke-WebRequest -Uri 'https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.139/officecli-win-x64.exe' -OutFile $downloadPath -TimeoutSec 120
    if ((Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'OfficeCLI download hash mismatch' }
    Move-Item -LiteralPath $downloadPath -Destination $enginePath
  } finally { if (Test-Path -LiteralPath $downloadPath) { Remove-Item -LiteralPath $downloadPath } }
}
if ((Get-FileHash -LiteralPath $enginePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'OfficeCLI hash mismatch; remove the invalid binary and rebuild' }
if ($PrepareOnly) { Write-Output 'OfficeCLI v1.0.139 verified'; return }
if (-not (Test-Path -LiteralPath (Join-Path $pluginRoot 'licenses/OFFICECLI-LICENSE'))) { throw 'OfficeCLI license missing' }
Add-Type -AssemblyName System.IO.Compression
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $pluginRoot '../..'))
$outputDirectory = Join-Path $repositoryRoot 'apps/desktop/out/bundled-plugins'
New-Item -ItemType Directory -Force $outputDirectory | Out-Null
$zipPath = Join-Path $outputDirectory 'office-work.zip'
$stream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -LiteralPath $pluginRoot -Recurse -File | ForEach-Object {
    $name = $_.FullName.Substring($pluginRoot.Length + 1).Replace('\','/')
    if ($name -notmatch '^(test|scripts|out)/' -and $name -ne '.gitignore') {
      $entry = $archive.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
      $entryStream = $entry.Open()
      try { $bytes = [System.IO.File]::ReadAllBytes($_.FullName); $entryStream.Write($bytes,0,$bytes.Length) } finally { $entryStream.Dispose() }
    }
  }
} finally { $archive.Dispose(); $stream.Dispose() }
Write-Output $zipPath
