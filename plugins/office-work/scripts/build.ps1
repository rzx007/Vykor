$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'build.mjs')
exit $LASTEXITCODE
