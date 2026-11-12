import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);

// Use .NET directly: inherited PowerShell module paths can load incompatible
// Security module type data. The path is data in an env variable, never script.
const restrictWindowsFile = `
$ErrorActionPreference = 'Stop'
$path = $env:VYKOR_PRIVATE_FILE_PATH
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$security = [System.Security.AccessControl.FileSecurity]::new()
$security.SetOwner($user)
$security.SetAccessRuleProtection($true, $false)
foreach ($sid in @($user, $system)) {
  $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
}
[System.IO.File]::SetAccessControl($path, $security)
$actual = [System.IO.File]::GetAccessControl($path)
if (!$actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'File owner or ACL protection was not applied' }
$hasUser = $false
foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin @($user.Value, $system.Value)) { throw 'File ACL contains an unexpected principal or inherited rule' }
  if ($rule.IdentityReference.Value -eq $user.Value -and $rule.FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl) { $hasUser = $true }
}
if (!$hasUser) { throw 'Current user access was not applied' }
`;

/** Only call for newly created application files; never alter a parent/home ACL. */
export async function securePrivateFile(file: string): Promise<void> {
  if (process.platform !== "win32") { await chmod(file, 0o600); return; }
  const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Even -NoProfile PowerShell creates profile cache directories on startup.
  // Isolate those in disposable temp space, not the selected or real home.
  const profile = await mkdtemp(join(tmpdir(), "vykor-file-acl-"));
  try {
    await runFile(executable, ["-NoProfile", "-NonInteractive", "-Command", restrictWindowsFile], {
      env: {
        ...process.env, VYKOR_PRIVATE_FILE_PATH: file, HOME: profile, USERPROFILE: profile,
        APPDATA: join(profile, "AppData", "Roaming"), LOCALAPPDATA: join(profile, "AppData", "Local"),
        PSModuleAnalysisCachePath: join(profile, "module-cache"),
      }, windowsHide: true, timeout: 10_000,
    });
  } catch (error) {
    throw new Error(`Cannot secure private data root file ${file}; existing home permissions were not changed.`, { cause: error });
  } finally { await rm(profile, { recursive: true, force: true }); }
}
