import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const windowsRoot = process.env.SystemRoot ?? String.raw`C:\Windows`
const powershell = join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
const desktopPath = fileURLToPath(new URL("../../../apps/desktop/", import.meta.url))

export function registerFixture(directory: string, name: string) {
  const compiler = join(windowsRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
  const exe = join(directory, `${name}.exe`)
  execFileSync(compiler, [
    "/nologo", "/target:winexe", "/platform:x64", "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll",
    "/r:System.Web.Extensions.dll", `/out:${exe}`, join(desktopPath, "tests/computer-windows/fixtures/Fixture.cs"),
  ], { windowsHide: true, timeout: 12_000 })
  return execFileSync(powershell, [
    "-NoProfile", "-NonInteractive", "-Command", String.raw`
      $ErrorActionPreference = 'Stop'
      [Console]::OutputEncoding = [Text.Encoding]::UTF8
      $shellFolders = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
      $programs = [Environment]::ExpandEnvironmentVariables([string](Get-ItemProperty -LiteralPath $shellFolders -Name Programs -ErrorAction SilentlyContinue).Programs)
      if (!$programs -or !(Test-Path -LiteralPath $programs -PathType Container)) {
        $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
      }
      if (!$programs -or !(Test-Path -LiteralPath $programs -PathType Container)) { throw 'Current user Start Menu is unavailable' }
      $path = Join-Path $programs ($env:VYKOR_WINDOWS_TEST_NAME + '.lnk')
      if (Test-Path -LiteralPath $path) { throw 'The fixture shortcut already exists' }
      $entry = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
      $entry.TargetPath = $env:VYKOR_WINDOWS_TEST_EXE
      $entry.WorkingDirectory = Split-Path -LiteralPath $env:VYKOR_WINDOWS_TEST_EXE
      $entry.Save()
      [Console]::WriteLine($path)
    `,
  ], {
    env: { ...process.env, VYKOR_WINDOWS_TEST_NAME: name, VYKOR_WINDOWS_TEST_EXE: exe },
    encoding: "utf8", windowsHide: true, timeout: 12_000,
  }).trim()
}
