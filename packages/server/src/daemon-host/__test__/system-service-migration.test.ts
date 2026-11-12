import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { DaemonSystemService } from "../system-service.js";
const cleanup: string[] = [];
afterEach(() => cleanup.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

it("restores the exact original service definition and installs target arguments without starting", async () => {
  const root = mkdtempSync(join(tmpdir(), "vykor-service-move-")); cleanup.push(root);
  const homeDir = join(root, "home"), source = join(root, "source").replaceAll("\\", "/"), target = join(root, "target").replaceAll("\\", "/");
  const config = join(homeDir, ".config/systemd/user/dev.vykor.daemon.service");
  mkdirSync(join(homeDir, ".config/systemd/user"), { recursive: true });
  const original = "[Service]\nEnvironment=SECRET=private-original-definition\nExecStart=/old/launcher\n";
  writeFileSync(config, original);
  let running = true;
  const service = new DaemonSystemService({ platform: "linux", homeDir, logsDir: join(source, "data/logs"), invocation: { command: "/usr/bin/node", args: ["/app/daemon.js", "--data-root", source], cwd: "/app" }, runCommand: (_command, args) => {
    if (args.includes("is-active")) return { status: 0, stdout: running ? "active" : "inactive", stderr: "" };
    if (args.includes("stop") || args.includes("disable")) running = false;
    if (args.includes("start") || args.includes("--now") && args.includes("enable")) running = true;
    return { status: 0, stdout: "", stderr: "" };
  } });
  const snapshot = service.snapshotForMigration();
  service.pauseForMigration();
  expect(running).toBe(false);
  const next = service.forDataRoot(target);
  next.install({ start: false });
  expect(running).toBe(false);
  expect(readFileSync(config, "utf8")).toContain(target);
  expect(readFileSync(config, "utf8")).not.toContain(source);
  service.restoreMigrationSnapshot(snapshot);
  expect(readFileSync(config, "utf8")).toBe(original);
  expect(running).toBe(false);
});

it.each(["win32", "darwin"] as const)("keeps original running and disabled intent for %s using owned service adapters", platform => {
  const root = mkdtempSync(join(tmpdir(), "migration-service-state-")); cleanup.push(root);
  const homeDir = join(root, "home"), source = join(root, "source"), target = join(root, "target"), calls: string[] = [];
  if (platform === "darwin") { mkdirSync(join(homeDir, "Library/LaunchAgents"), { recursive: true }); writeFileSync(join(homeDir, "Library/LaunchAgents/dev.vykor.daemon.plist"), "original-private-plist"); }
  let running = true;
  const service = new DaemonSystemService({ platform, homeDir, uid: 501, logsDir: join(source, "data/logs"), invocation: { command: process.execPath, args: ["/main", "--data-root", source], cwd: root }, runCommand: (_command, args) => {
    const call = args.join(" "); calls.push(call);
    if (call.includes("ConvertTo-Json")) return { status: 0, stdout: JSON.stringify({ enabled: false, running: true }), stderr: "" };
    if (call.includes("Export-ScheduledTask")) return { status: 0, stdout: "<Task>original-private-xml</Task>", stderr: "" };
    if (call.includes("Get-ScheduledTask")) return { status: 0, stdout: running ? "running" : "disabled", stderr: "" };
    if (args[0] === "print-disabled") return { status: 0, stdout: 'disabled services = { "dev.vykor.daemon" => true }', stderr: "" };
    if (args[0] === "print") return { status: running ? 0 : 1, stdout: "state = running", stderr: "" };
    if (call.includes("Stop-ScheduledTask") || args[0] === "bootout") running = false;
    if (call.includes("Start-ScheduledTask") || args[0] === "bootstrap") running = true;
    return { status: 0, stdout: "", stderr: "" };
  } });
  const snapshot = service.snapshotForMigration(); expect(snapshot).toMatchObject({ wasEnabled: false, wasRunning: true });
  service.pauseForMigration(); service.forDataRoot(target).install({ start: false }); expect(running).toBe(false);
  service.restoreMigrationSnapshot(snapshot); expect(running).toBe(false);
  service.resumeMigrationSnapshot(snapshot); expect(running).toBe(true);
  expect(calls.at(-1)).toContain(platform === "win32" ? "Disable-ScheduledTask" : "disable");
});
