import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureMigrationService, installMigrationService, pauseMigrationService, restoreMigrationService } from "../data-root-service.js";
import type { MigrationJournal } from "../data-root-migration-journal.js";
import { DaemonSystemService } from "../system-service.js";

const owned: string[] = [];
afterEach(() => owned.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture(platform: "linux" | "darwin" | "win32" = "linux") {
  const root = mkdtempSync(join(tmpdir(), "service-owner-")); owned.push(root);
  const homeDir = join(root, "home"), source = join(root, "source"), other = join(root, "other"), target = join(root, "target");
  mkdirSync(homeDir); mkdirSync(source);
  const config = platform === "darwin" ? join(homeDir, "Library/LaunchAgents/dev.vykor.daemon.plist") : join(homeDir, ".config/systemd/user/dev.vykor.daemon.service");
  mkdirSync(join(config, ".."), { recursive: true });
  const calls: string[] = [];
  let definition = "", running = true, dropIns = "", reload = "no", loadedArgs: string[] | undefined;
  const service = new DaemonSystemService({ platform, homeDir, uid: 501, logsDir: join(source, "data/logs"), invocation: { command: "/node", args: ["/app/main.js", "--data-root", source, ...(platform === "win32" ? ["--daemon-watchdog"] : [])], cwd: "/app" }, runCommand: (_command, args, env) => {
    const call = args.join(" "); calls.push(call);
    if (call.includes("ConvertTo-Json")) return { status: 0, stdout: JSON.stringify({ enabled: true, running }), stderr: "" };
    if (call.includes("Export-ScheduledTask")) return { status: 0, stdout: definition, stderr: "" };
    if (call.includes("Get-ScheduledTask")) return { status: 0, stdout: running ? "running" : "disabled", stderr: "" };
    if (args.includes("is-active")) return { status: 0, stdout: running ? "active" : "inactive", stderr: "" };
    if (args.includes("show")) return { status: 0, stdout: `FragmentPath=${config}\nDropInPaths=${dropIns}\nNeedDaemonReload=${reload}\n`, stderr: "" };
    if (args[0] === "print") {
      const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(readFileSync(config, "utf8"))?.[1] ?? "";
      const actual = loadedArgs ?? [...array.matchAll(/<string>([^<]*)<\/string>/g)].map(match => match[1]!);
      return { status: running ? 0 : 1, stdout: `state = running\nprogram = ${actual[0]}\narguments = {\n${actual.map(arg => `\t${arg}`).join("\n")}\n}\n`, stderr: "" };
    }
    if (args.includes("disable") || args[0] === "bootout" || call.includes("Stop-ScheduledTask")) running = false;
    if (env?.VK_TASK_XML) definition = env.VK_TASK_XML;
    if (env?.VK_TASK_ARGUMENTS) definition = `<Task><Actions><Exec><Command>wscript.exe</Command><Arguments>${env.VK_TASK_ARGUMENTS.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}</Arguments></Exec></Actions></Task>`;
    return { status: 0, stdout: args.includes("is-enabled") ? "enabled" : "", stderr: "" };
  } });
  const journal = { version: 1, sourceRoot: source, targetRoot: target, homeDir, journalPath: join(root, "journal.json") } as MigrationJournal;
  const unit = (dataRoot: string) => `[Service]\nExecStart="/node" "/app/main.js" "--data-root" "${dataRoot.replaceAll("\\", "\\\\")}"\n`;
  return { root, source, other, target, config, calls, service, journal, unit, setDefinition: (value: string) => { definition = value; }, setEffective: (paths: string, needsReload = "no") => { dropIns = paths; reload = needsReload; }, setLoaded: (args: string[]) => { loadedArgs = args; running = true; }, setStopped: () => { running = false; } };
}

// Removing the installed-definition check would let A's adapter stop and replace B's unit.
it("refuses another root's actual service before pause or installation", async () => {
  const f = fixture(); const original = f.unit(f.other); writeFileSync(f.config, original);
  await expect(captureMigrationService(f.journal, f.service)).rejects.toThrow(/belong|ownership/i);
  expect(f.journal.systemService).toBeUndefined();
  expect(readFileSync(f.config, "utf8")).toBe(original);
  expect(f.calls.some(call => /disable|daemon-reload/.test(call))).toBe(false);
});
it("refuses an installed command whose root cannot be proved", async () => {
  const f = fixture(); writeFileSync(f.config, "[Service]\nExecStart=/unrelated --message='--data-root ignored'\n");
  await expect(captureMigrationService(f.journal, f.service)).rejects.toThrow(/belong|ownership/i);
});
it("migrates a service bound to the source and restores the exact original definition", async () => {
  const f = fixture(); const original = `${f.unit(f.source)}Environment=SECRET=original-private-value\n`; writeFileSync(f.config, original);
  await captureMigrationService(f.journal, f.service); await pauseMigrationService(f.journal, f.service);
  await installMigrationService(f.journal, f.service);
  expect(readFileSync(f.config, "utf8")).toContain(f.target.replaceAll("\\", "\\\\"));
  await restoreMigrationService(f.journal, f.service);
  expect(readFileSync(f.config, "utf8")).toBe(original);
  expect(readFileSync(f.journal.journalPath, "utf8")).not.toContain("original-private-value");
});
it("rechecks the definition immediately before pausing when it changes after capture", async () => {
  const f = fixture(); writeFileSync(f.config, f.unit(f.source));
  await captureMigrationService(f.journal, f.service);
  const unrelated = f.unit(f.other); writeFileSync(f.config, unrelated);
  await expect(pauseMigrationService(f.journal, f.service)).rejects.toThrow(/changed|belong|ownership/i);
  expect(f.calls.some(call => call.includes("disable"))).toBe(false);
  expect(readFileSync(f.config, "utf8")).toBe(unrelated);
});
it("rejects a macOS ProgramArguments root even when the source path occurs elsewhere", async () => {
  const f = fixture("darwin"); writeFileSync(f.config, `<plist><dict><key>ProgramArguments</key><array><string>/node</string><string>/app/main.js</string><string>--data-root</string><string>${f.other}</string></array><key>StandardOutPath</key><string>${join(f.source, "data/logs/daemon.log")}</string></dict></plist>`);
  await expect(captureMigrationService(f.journal, f.service)).rejects.toThrow(/belong|ownership/i);
});
it("rejects a Windows task pointing to another root even if the adapter has a source launcher", async () => {
  const f = fixture("win32"); const launcher = join(f.source, "data/daemon/daemon-watchdog.vbs"); mkdirSync(join(launcher, ".."), { recursive: true }); writeFileSync(launcher, "source launcher");
  f.setDefinition(`<Task><Actions><Exec><Command>wscript.exe</Command><Arguments>&quot;//B&quot; &quot;//Nologo&quot; &quot;${join(f.other, "data/daemon/daemon-watchdog.vbs")}&quot;</Arguments></Exec></Actions></Task>`);
  await expect(captureMigrationService(f.journal, f.service)).rejects.toThrow(/belong|ownership/i);
  expect(f.calls.some(call => call.includes("Stop-ScheduledTask"))).toBe(false);
});
it.each(["darwin", "win32"] as const)("migrates and restores a generated %s service bound to the source", async platform => {
  const f = fixture(platform); f.service.install({ start: false });
  const original = f.service.snapshotForMigration();
  await captureMigrationService(f.journal, f.service); await pauseMigrationService(f.journal, f.service);
  await installMigrationService(f.journal, f.service); await restoreMigrationService(f.journal, f.service);
  const restored = f.service.snapshotForMigration();
  expect(restored.definition).toBe(original.definition); expect(restored.launcher).toBe(original.launcher);
});
it.each(["VYKOR_CONFIG_DIR", "VYKOR_DATA_DIR"])("accepts a legacy Linux service bound by its actual %s environment", async key => {
  const f = fixture(); const value = key === "VYKOR_CONFIG_DIR" ? f.source : join(f.root, "legacy-runtime"); mkdirSync(value, { recursive: true });
  f.journal.preparation = { sourceIdentity: "owned", complete: false, runtimeDirectories: [{ path: value, identity: "owned" }] };
  writeFileSync(f.config, `[Service]\nExecStart="/node" "/app/main.js"\nEnvironment="${key}=${value.replaceAll("\\", "\\\\")}"\n`);
  await captureMigrationService(f.journal, f.service); await pauseMigrationService(f.journal, f.service);
  expect(f.journal.systemService?.state).toBe("paused");
});
it("accepts an unloaded legacy macOS service bound by its source environment", async () => {
  const f = fixture("darwin"); writeFileSync(f.config, `<plist><dict><key>ProgramArguments</key><array><string>/node</string><string>/app/main.js</string></array><key>EnvironmentVariables</key><dict><key>VYKOR_CONFIG_DIR</key><string>${f.source}</string></dict></dict></plist>`);
  f.setStopped();
  await captureMigrationService(f.journal, f.service); await pauseMigrationService(f.journal, f.service);
  expect(f.journal.systemService?.state).toBe("paused");
});
it("rejects a source task whose actual launcher launches another root", async () => {
  const f = fixture("win32"); f.service.install({ start: false });
  const launcher = join(f.source, "data/daemon/daemon-watchdog.vbs");
  writeFileSync(launcher, readFileSync(launcher, "utf8").replaceAll(f.source, f.other));
  await expect(captureMigrationService(f.journal, f.service)).rejects.toThrow(/ownership/i);
});
it("refuses a bare legacy Windows launcher because inherited environment or selector may select another root", async () => {
  const f = fixture("win32"); f.service.install({ start: false });
  const launcher = join(f.source, "data/daemon/daemon-watchdog.vbs");
  const original = readFileSync(launcher, "utf8");
  writeFileSync(launcher, original.replace(` ""--data-root"" ""${f.source}""`, ""));
  expect(readFileSync(launcher, "utf8")).not.toContain("--data-root");
  await expect(captureMigrationService(f.journal, f.service)).rejects.toThrow(/ownership.*[Rr]einstall/);
});
it.each(["root-prefix", "second-service-section", "conflicting-environment", "duplicate-root"])("rejects ambiguous Linux ownership: %s", async variant => {
  const f = fixture();
  const text = variant === "root-prefix" ? f.unit(`${f.source}-other`)
    : variant === "second-service-section" ? `${f.unit(f.source)}${f.unit(f.other)}`
    : variant === "conflicting-environment" ? `${f.unit(f.source)}Environment="VYKOR_CONFIG_DIR=${f.other.replaceAll("\\", "\\\\")}"\n`
    : f.unit(f.source).replace('"--data-root"', `"--data-root=${f.source.replaceAll("\\", "\\\\")}" "--data-root"`);
  writeFileSync(f.config, text);
  await expect(captureMigrationService(f.journal, f.service)).rejects.toThrow(/ownership/i);
});
it.each(["drop-in", "stale-loaded-unit"])("refuses an unproved Linux effective unit: %s", async variant => {
  const f = fixture(); writeFileSync(f.config, f.unit(f.source));
  f.setEffective(variant === "drop-in" ? join(f.root, "other-root.conf") : "", variant === "stale-loaded-unit" ? "yes" : "no");
  await expect(captureMigrationService(f.journal, f.service)).rejects.toThrow(/ownership/i);
  expect(f.calls.some(call => call.includes("disable"))).toBe(false);
});
it("rejects an empty legacy Windows invocation even from a source launcher", async () => {
  const f = fixture("win32"); f.service.install({ start: false });
  const launcher = join(f.source, "data/daemon/daemon-watchdog.vbs");
  writeFileSync(launcher, 'Set shell = CreateObject("WScript.Shell")\r\nshell.CurrentDirectory = "/app"\r\nexitCode = shell.Run("", 0, True)\r\nWScript.Quit exitCode\r\n');
  await expect(captureMigrationService(f.journal, f.service)).rejects.toThrow(/ownership/i);
});
it("refuses a macOS loaded job for another root even when its plist now selects the source", async () => {
  const f = fixture("darwin"); f.service.install({ start: false });
  f.setLoaded(["/node", "/app/main.js", "--data-root", f.other]);
  const before = f.calls.length;
  await expect(captureMigrationService(f.journal, f.service)).rejects.toThrow(/ownership/i);
  expect(f.journal.systemService).toBeUndefined();
  expect(f.calls.slice(before).some(call => call.includes("bootout"))).toBe(false);
});
it("accepts a macOS loaded job whose actual program and arguments match the source plist", async () => {
  const f = fixture("darwin"); f.service.install({ start: false });
  f.setLoaded(["/node", "/app/main.js", "--data-root", f.source]);
  await captureMigrationService(f.journal, f.service); await pauseMigrationService(f.journal, f.service);
  expect(f.journal.systemService?.state).toBe("paused");
});
it("refuses a loaded legacy macOS job without an explicit root even when its plist supplies source environment", async () => {
  const f = fixture("darwin"); writeFileSync(f.config, `<plist><dict><key>ProgramArguments</key><array><string>/node</string><string>/app/main.js</string></array><key>EnvironmentVariables</key><dict><key>VYKOR_CONFIG_DIR</key><string>${f.source}</string></dict></dict></plist>`);
  await expect(captureMigrationService(f.journal, f.service)).rejects.toThrow(/ownership/i);
});
