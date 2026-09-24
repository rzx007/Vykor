import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDaemonSystemService,
  DaemonSystemService,
  serializeWindowsArguments,
  type SystemCommandResult,
} from "./daemon-system-service.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "vk-daemon-service-"));
  cleanup.push(path);
  return path;
}

function ok(stdout = ""): SystemCommandResult {
  return { status: 0, stdout, stderr: "" };
}

describe("DaemonSystemService", () => {
  it("quotes Windows task arguments without losing spaces or trailing slashes", () => {
    expect(serializeWindowsArguments(["plain", "two words", "C:\\Program Files\\", 'say"hi']))
      .toBe('"plain" "two words" "C:\\Program Files\\\\" "say\\"hi"');
  });

  it("installs a Windows sign-in and periodic watchdog task", () => {
    const root = tempRoot();
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const service = new DaemonSystemService({
      platform: "win32",
      logsDir: join(root, "logs"),
      invocation: {
        command: "C:\\Program Files\\node.exe",
        args: ["D:\\repo\\dist\\index.js", "daemon", "watchdog", "serve", "--register"],
        cwd: "D:\\repo",
      },
      runCommand: (command, args, env) => {
        calls.push({ command, args, env });
        if (args.at(-1)?.includes("Get-ScheduledTask")) return ok("not-installed\n");
        return ok();
      },
    });

    service.install();

    const register = calls.find((call) => call.args.includes("Bypass") && call.args.at(-1)?.includes("Register-ScheduledTask"));
    expect(register?.env?.VK_EXECUTABLE).toMatch(/wscript\.exe$/i);
    expect(register?.env?.VK_TASK_ARGUMENTS).toContain("//B");
    expect(register?.env?.VK_TASK_ARGUMENTS).toContain("daemon-watchdog.vbs");
    expect(register?.args.at(-1)).toContain("RepetitionInterval");
    expect(register?.env?.VK_WORKING_DIRECTORY).toBe("D:\\repo");

    const launcher = readFileSync(join(root, "daemon", "daemon-watchdog.vbs"), "utf-8");
    expect(launcher).toContain('""C:\\Program Files\\node.exe""');
    expect(launcher).toContain('""D:\\repo\\dist\\index.js""');
    expect(launcher).toContain('""watchdog""');
    expect(launcher).toContain("shell.Run(");
    expect(launcher).toContain(", 0, True)");
  });

  it("treats an enabled idle Windows watchdog as running", () => {
    const service = new DaemonSystemService({
      platform: "win32",
      invocation: { command: "node.exe", args: [], cwd: "D:\\repo" },
      runCommand: () => ok("ready\n"),
    });

    expect(service.status()).toMatchObject({ platform: "win32", state: "running", detail: "ready" });
  });

  it("adds the one-shot watchdog command to Windows service invocations", () => {
    const root = tempRoot();
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = [];
    const service = createDaemonSystemService("D:/repo/index.js", ["serve", "--register"], {
      platform: "win32",
      bunRuntime: true,
      nodePath: "D:/node/node.exe",
      cwd: "D:/repo",
      logsDir: join(root, "logs"),
      runCommand: (_command, _args, env) => {
        calls.push({ env });
        return ok("not-installed\n");
      },
    });

    service.install();
    const taskArguments = calls.find((call) => call.env?.VK_TASK_ARGUMENTS)?.env?.VK_TASK_ARGUMENTS;
    expect(taskArguments).toContain("daemon-watchdog.vbs");
    const launcher = readFileSync(join(root, "daemon", "daemon-watchdog.vbs"), "utf-8");
    expect(launcher).toContain('""daemon"" ""watchdog"" ""serve"" ""--register""');
  });

  it("writes and enables a Linux user service", () => {
    const root = tempRoot();
    const calls: string[][] = [];
    const service = new DaemonSystemService({
      platform: "linux",
      homeDir: root,
      logsDir: join(root, "logs"),
      invocation: {
        command: "/usr/bin/node",
        args: ["/repo with spaces/dist/index.js", "serve", "--register"],
        cwd: "/repo with spaces",
      },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        return args.includes("is-active") ? ok("active\n") : ok();
      },
    });

    service.install();

    const unitPath = join(root, ".config", "systemd", "user", "dev.vykor.daemon.service");
    const unit = readFileSync(unitPath, "utf-8");
    expect(unit).toContain('ExecStart="/usr/bin/node" "/repo with spaces/dist/index.js" "serve" "--register"');
    expect(unit).toContain("Restart=on-failure");
    expect(calls).toContainEqual(["systemctl", "--user", "enable", "--now", "dev.vykor.daemon"]);
    expect(service.status().state).toBe("running");
  });

  it("writes and loads a macOS LaunchAgent", () => {
    const root = tempRoot();
    const calls: string[][] = [];
    const service = new DaemonSystemService({
      platform: "darwin",
      homeDir: root,
      logsDir: join(root, "logs"),
      uid: 501,
      invocation: {
        command: "/opt/homebrew/bin/node",
        args: ["/repo/a&b/index.js", "serve", "--register"],
        cwd: "/repo/a&b",
      },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        return ok();
      },
    });

    service.install();

    const plistPath = join(root, "Library", "LaunchAgents", "dev.vykor.daemon.plist");
    const plist = readFileSync(plistPath, "utf-8");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("/repo/a&amp;b/index.js");
    expect(calls).toContainEqual(["launchctl", "bootstrap", "gui/501", plistPath]);
  });
});
