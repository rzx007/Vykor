import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withDataRootLock, writeDataRootSelector } from "../data-root-selection.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "root-permissions-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function powershell(script: string, path: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; ${script}`], {
    env: { ...process.env, PSModulePath: join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "Modules"), TEST_PERMISSION_PATH: path }, encoding: "utf8", windowsHide: true,
  }).trim();
}
function acl(path: string): { protected: boolean; sddl: string; owner: string; current: string; rules: { sid: string; inherited: boolean; type: string }[] } {
  const [header, ...lines] = powershell(`$p=$env:TEST_PERMISSION_PATH; $a=if([IO.Directory]::Exists($p)){[IO.Directory]::GetAccessControl($p)}else{[IO.File]::GetAccessControl($p)}; [Console]::WriteLine($a.AreAccessRulesProtected.ToString()+'|'+$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value+'|'+[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value+'|'+$a.GetSecurityDescriptorSddlForm('All')); foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){[Console]::WriteLine($r.IdentityReference.Value+'|'+$r.IsInherited.ToString()+'|'+$r.AccessControlType.ToString())}`, path).split(/\r?\n/);
  const [protectedValue, owner, current, sddl] = header!.split('|');
  return { protected: protectedValue === 'True', owner: owner!, current: current!, sddl: sddl!, rules: lines.map(line => { const [sid, inherited, type] = line.split('|'); return { sid: sid!, inherited: inherited === 'True', type: type! }; }) };
}

it.runIf(process.platform === "win32")("protects actual Windows locator and lock ACLs without changing an open home ACL", async () => {
  // Only this newly created temporary home receives a broad inherited test ACL.
  powershell(`$a=[IO.Directory]::GetAccessControl($env:TEST_PERMISSION_PATH); $everyone=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($everyone,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $a.AddAccessRule($rule); [IO.Directory]::SetAccessControl($env:TEST_PERMISSION_PATH,$a)`, home);
  const before = acl(home).sddl;
  const check = (path: string) => {
    const security = acl(path);
    expect(security.protected).toBe(true);
    expect(security.owner).toBe(security.current);
    expect(security.rules.length).toBeGreaterThan(0);
    for (const rule of security.rules) {
      expect([security.current, "S-1-5-18"]).toContain(rule.sid);
      expect(rule.inherited).toBe(false);
      expect(rule.type).toBe("Allow");
    }
  };
  await withDataRootLock(home, async lock => {
    check(join(home, ".vykor-root.json.lock"));
    await lock.writeSelector({ version: 1, dataRoot: join(home, "selected") });
    check(join(home, ".vykor-root.json"));
  });
  await writeDataRootSelector(home, { version: 1, dataRoot: join(home, "replacement") });
  check(join(home, ".vykor-root.json"));
  expect(acl(home).sddl).toBe(before);
});

it.runIf(process.platform !== "win32")("keeps an existing POSIX home mode and creates only private files", async () => {
  chmodSync(home, 0o750);
  await withDataRootLock(home, async lock => {
    expect(statSync(join(home, ".vykor-root.json.lock")).mode & 0o777).toBe(0o600);
    await lock.writeSelector({ version: 1, dataRoot: join(home, "selected") });
    expect(statSync(join(home, ".vykor-root.json")).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o750);
  });
  expect(statSync(home).mode & 0o777).toBe(0o750);
});

it("preserves the previous selector if a later save cannot be published", async () => {
  const selector = { version: 1 as const, dataRoot: join(home, "selected") };
  await writeDataRootSelector(home, selector);
  await expect(writeDataRootSelector(home, { version: 1, dataRoot: "relative" })).rejects.toThrow();
  expect(JSON.parse(readFileSync(join(home, ".vykor-root.json"), "utf8"))).toEqual(selector);
});
