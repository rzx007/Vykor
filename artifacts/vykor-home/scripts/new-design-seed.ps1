param(
  [ValidateRange(128, 4096)][int]$Length = 384,
  [string]$OutputPath
)

$vykorAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
$vykorRandom = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$vykorBuilder = [System.Text.StringBuilder]::new()
try {
  while ($vykorBuilder.Length -lt $Length) {
    $vykorBytes = New-Object byte[] 512
    $vykorRandom.GetBytes($vykorBytes)
    foreach ($vykorByte in $vykorBytes) {
      # Rejection sampling keeps all 62 characters equally likely.
      if ($vykorByte -lt 248 -and $vykorBuilder.Length -lt $Length) {
        [void]$vykorBuilder.Append($vykorAlphabet[[int]$vykorByte % 62])
      }
    }
  }
} finally {
  $vykorRandom.Dispose()
}
$vykorSeed = $vykorBuilder.ToString()
$vykorHash = [System.Security.Cryptography.SHA256]::Create()
try {
  $vykorDigest = ([BitConverter]::ToString($vykorHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($vykorSeed)))).Replace('-', '').ToLowerInvariant()
} finally {
  $vykorHash.Dispose()
}
$vykorResult = [ordered]@{
  seed = $vykorSeed
  sha256 = $vykorDigest
  drawSeed = [Convert]::ToUInt32($vykorDigest.Substring(0, 8), 16)
  length = $vykorSeed.Length
  repeatedPairs = @([regex]::Matches($vykorSeed, '(.)\1') | ForEach-Object { $_.Value })
  digitRuns = @([regex]::Matches($vykorSeed, '\d{2,}') | ForEach-Object { $_.Value })
}
$vykorJson = $vykorResult | ConvertTo-Json -Depth 5
if ($OutputPath) { $vykorJson | Set-Content -Encoding utf8 -LiteralPath $OutputPath }
$vykorJson
