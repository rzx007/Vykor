import { execFile, spawnSync } from "node:child_process";

/** User-scoped operating-system service manager for a local daemon host. */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getLogsDir } from "@vykor/core";

const WINDOWS_TASK_NAME = "Vykor Daemon";
const WINDOWS_LAUNCHER_NAME = "daemon-watchdog.vbs";
const SERVICE_LABEL = "dev.vykor.daemon";
const WINDOWS_REGISTER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
  "$action = New-ScheduledTaskAction -Execute $env:VK_EXECUTABLE -Argument $env:VK_TASK_ARGUMENTS -WorkingDirectory $env:VK_WORKING_DIRECTORY",
  "$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $identity",
  "$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(2) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)",
  "$triggers = @($logonTrigger, $watchdogTrigger)",
  "$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited",
  "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew",
  `Register-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' -Description 'Keeps the local Vykor daemon running after sign-in.' -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null`,
  `Start-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}'`,
].join("; ");

export type DaemonSystemServiceState =
  "not-installed" | "stopped" | "running" | "unknown";

export interface DaemonSystemServiceStatus {
  platform: NodeJS.Platform;
  state: DaemonSystemServiceState;
  configPath?: string;
  detail?: string;
}

export interface SystemCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface DaemonServiceInvocation {
  command: string;
  args: string[];
  cwd: string;
}

export interface DaemonSystemServiceOptions {
  invocation: DaemonServiceInvocation;
  platform?: NodeJS.Platform;
  homeDir?: string;
  logsDir?: string;
  uid?: number;
  runCommand?: (
    command: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
  ) => SystemCommandResult;
  runCommandAsync?: (
    command: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
  ) => Promise<SystemCommandResult>;
}

export class DaemonSystemService {
  private readonly platform: NodeJS.Platform;
  private readonly homeDir: string;
  private readonly logsDir: string;
  private readonly uid?: number;
  private readonly runCommand: NonNullable<
    DaemonSystemServiceOptions["runCommand"]
  >;
  private readonly runCommandAsync: NonNullable<
    DaemonSystemServiceOptions["runCommandAsync"]
  >;

  constructor(private readonly options: DaemonSystemServiceOptions) {
    this.platform = options.platform ?? process.platform;
    this.homeDir = options.homeDir ?? homedir();
    this.logsDir = options.logsDir ?? getLogsDir();
    this.uid = options.uid ?? process.getuid?.();
    this.runCommand = options.runCommand ?? runSystemCommand;
    this.runCommandAsync = options.runCommandAsync ?? runSystemCommandAsync;
  }

  invocation(): DaemonServiceInvocation {
    return this.options.invocation;
  }

  status(): DaemonSystemServiceStatus {
    if (this.platform === "win32") return this.windowsStatus();
    const configPath = this.configPath();
    if (!existsSync(configPath))
      return { platform: this.platform, state: "not-installed", configPath };

    if (this.platform === "darwin") {
      const result = this.runCommand("launchctl", [
        "print",
        this.launchdTarget(),
      ]);
      if (result.status !== 0)
        return { platform: this.platform, state: "stopped", configPath };
      const match = /\bstate\s*=\s*([^\r\n]+)/.exec(result.stdout);
      return {
        platform: this.platform,
        state: match?.[1]?.trim() === "running" ? "running" : "unknown",
        configPath,
        ...(match?.[1] ? { detail: match[1].trim() } : {}),
      };
    }

    if (this.platform === "linux") {
      const result = this.runCommand("systemctl", [
        "--user",
        "is-active",
        SERVICE_LABEL,
      ]);
      const detail = result.stdout.trim() || result.stderr.trim();
      return {
        platform: this.platform,
        state:
          detail === "active"
            ? "running"
            : detail === "inactive" || detail === "failed"
              ? "stopped"
              : "unknown",
        configPath,
        ...(detail ? { detail } : {}),
      };
    }

    return { platform: this.platform, state: "not-installed" };
  }

  async statusAsync(): Promise<DaemonSystemServiceStatus> {
    if (this.platform !== "win32") return this.status();
    return this.windowsStatusFromResult(
      await this.runCommandAsync("powershell.exe", this.windowsStatusArguments()),
    );
  }

  isInstalled(): boolean {
    return this.status().state !== "not-installed";
  }

  install(): void {
    mkdirSync(this.logsDir, { recursive: true });
    if (this.platform === "win32") {
      this.stopWindowsTask();
      const launcherPath = this.writeWindowsLauncher();
      this.checked(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          WINDOWS_REGISTER_SCRIPT,
        ],
        {
          VK_EXECUTABLE: windowsScriptHostPath(),
          VK_TASK_ARGUMENTS: serializeWindowsArguments([
            "//B",
            "//Nologo",
            launcherPath,
          ]),
          VK_WORKING_DIRECTORY: this.options.invocation.cwd,
        },
      );
      return;
    }

    const configPath = this.configPath();
    mkdirSync(dirname(configPath), { recursive: true });
    if (this.platform === "darwin") {
      this.runCommand("launchctl", ["bootout", this.launchdTarget()]);
      writeFileSync(configPath, this.launchdPlist(), "utf-8");
      this.checked("launchctl", [
        "bootstrap",
        this.launchdDomain(),
        configPath,
      ]);
      return;
    }
    if (this.platform === "linux") {
      this.runCommand("systemctl", ["--user", "stop", SERVICE_LABEL]);
      writeFileSync(configPath, this.systemdUnit(), "utf-8");
      this.checked("systemctl", ["--user", "daemon-reload"]);
      this.checked("systemctl", ["--user", "enable", "--now", SERVICE_LABEL]);
      return;
    }
    throw new Error(
      `Daemon system service is not supported on ${this.platform}`,
    );
  }

  uninstall(): void {
    const current = this.status();
    if (current.state === "not-installed") {
      if (this.platform === "win32")
        rmSync(this.windowsLauncherPath(), { force: true });
      return;
    }
    if (this.platform === "win32") {
      this.stopWindowsTask();
      this.checked("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Unregister-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`,
      ]);
      rmSync(this.windowsLauncherPath(), { force: true });
      return;
    }

    const configPath = this.configPath();
    if (this.platform === "darwin") {
      if (current.state !== "stopped")
        this.checked("launchctl", ["bootout", this.launchdTarget()]);
      rmSync(configPath, { force: true });
      return;
    }
    if (this.platform === "linux") {
      this.checked("systemctl", ["--user", "disable", "--now", SERVICE_LABEL]);
      rmSync(configPath, { force: true });
      this.checked("systemctl", ["--user", "daemon-reload"]);
      this.runCommand("systemctl", ["--user", "reset-failed", SERVICE_LABEL]);
      return;
    }
    throw new Error(
      `Daemon system service is not supported on ${this.platform}`,
    );
  }

  start(): void {
    this.assertInstalled();
    if (this.platform === "win32") {
      this.checked("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Enable-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' | Out-Null; Start-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}'`,
      ]);
    } else if (this.platform === "darwin") {
      const current = this.status();
      if (current.state === "stopped")
        this.checked("launchctl", [
          "bootstrap",
          this.launchdDomain(),
          this.configPath(),
        ]);
      else this.checked("launchctl", ["kickstart", "-k", this.launchdTarget()]);
    } else if (this.platform === "linux") {
      this.checked("systemctl", ["--user", "start", SERVICE_LABEL]);
    }
  }

  stop(): void {
    const current = this.status();
    if (current.state === "not-installed" || current.state === "stopped")
      return;
    if (this.platform === "win32") this.stopWindowsTask(true, true);
    else if (this.platform === "darwin")
      this.checked("launchctl", ["bootout", this.launchdTarget()]);
    else if (this.platform === "linux")
      this.checked("systemctl", ["--user", "stop", SERVICE_LABEL]);
  }

  restart(): void {
    this.assertInstalled();
    if (this.platform === "win32") {
      this.stopWindowsTask(true);
      this.start();
    } else if (this.platform === "darwin") {
      this.runCommand("launchctl", ["bootout", this.launchdTarget()]);
      this.checked("launchctl", [
        "bootstrap",
        this.launchdDomain(),
        this.configPath(),
      ]);
    } else if (this.platform === "linux") {
      this.checked("systemctl", ["--user", "restart", SERVICE_LABEL]);
    }
  }

  private windowsStatus(): DaemonSystemServiceStatus {
    return this.windowsStatusFromResult(
      this.runCommand("powershell.exe", this.windowsStatusArguments()),
    );
  }

  private windowsStatusArguments(): string[] {
    const script = `$task = Get-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' -ErrorAction SilentlyContinue; if ($null -eq $task) { 'not-installed' } else { $task.State.ToString().ToLowerInvariant() }`;
    return [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ];
  }

  private windowsStatusFromResult(
    result: SystemCommandResult,
  ): DaemonSystemServiceStatus {
    if (result.error)
      throw new Error(
        `Cannot query Windows Task Scheduler: ${result.error.message}`,
      );
    if (result.status !== 0)
      throw new Error(
        `Cannot query Windows Task Scheduler: ${result.stderr.trim() || `exit ${result.status}`}`,
      );
    const detail = result.stdout.trim();
    const state =
      detail === "not-installed"
        ? "not-installed"
        : detail === "disabled"
          ? "stopped"
          : detail
            ? "running"
            : "unknown";
    return { platform: this.platform, state, ...(detail ? { detail } : {}) };
  }

  private stopWindowsTask(required = false, disable = false): void {
    const commands = [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        ...(disable
          ? [
              `Disable-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' -ErrorAction SilentlyContinue | Out-Null`,
            ]
          : []),
        `Stop-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' -ErrorAction SilentlyContinue`,
      ].join("; "),
    ];
    const result = this.runCommand("powershell.exe", commands);
    if (required && (result.error || result.status !== 0)) {
      throw new Error(
        `Cannot stop Windows scheduled task: ${result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`)}`,
      );
    }
  }

  private assertInstalled(): void {
    if (!this.isInstalled())
      throw new Error("Vykor daemon system service is not installed");
  }

  private writeWindowsLauncher(): string {
    const launcherPath = this.windowsLauncherPath();
    mkdirSync(dirname(launcherPath), { recursive: true });
    const command = serializeWindowsArguments([
      this.options.invocation.command,
      ...this.options.invocation.args,
    ]);
    const script = [
      'Set shell = CreateObject("WScript.Shell")',
      `shell.CurrentDirectory = \"${vbscriptEscape(this.options.invocation.cwd)}\"`,
      `exitCode = shell.Run(\"${vbscriptEscape(command)}\", 0, True)`,
      "WScript.Quit exitCode",
      "",
    ].join("\r\n");
    writeFileSync(launcherPath, script, "utf-8");
    return launcherPath;
  }

  private windowsLauncherPath(): string {
    return join(dirname(this.logsDir), "daemon", WINDOWS_LAUNCHER_NAME);
  }

  private checked(
    command: string,
    args: string[],
    extraEnv?: NodeJS.ProcessEnv,
  ): SystemCommandResult {
    const result = this.runCommand(command, args, extraEnv);
    if (result.error || result.status !== 0) {
      const detail =
        result.error?.message ??
        (result.stderr.trim() ||
          result.stdout.trim() ||
          `exit ${result.status}`);
      throw new Error(
        `Failed to manage daemon system service: ${command}: ${detail}`,
      );
    }
    return result;
  }

  private configPath(): string {
    if (this.platform === "darwin")
      return join(
        this.homeDir,
        "Library",
        "LaunchAgents",
        `${SERVICE_LABEL}.plist`,
      );
    if (this.platform === "linux")
      return join(
        this.homeDir,
        ".config",
        "systemd",
        "user",
        `${SERVICE_LABEL}.service`,
      );
    throw new Error(
      `Daemon system service configuration is not file-based on ${this.platform}`,
    );
  }

  private launchdDomain(): string {
    if (this.uid === undefined)
      throw new Error("Cannot determine the current user ID for launchd");
    return `gui/${this.uid}`;
  }

  private launchdTarget(): string {
    return `${this.launchdDomain()}/${SERVICE_LABEL}`;
  }

  private launchdPlist(): string {
    const invocation = this.options.invocation;
    const programArguments = [invocation.command, ...invocation.args]
      .map((value) => `      <string>${xmlEscape(value)}</string>`)
      .join("\n");
    const logPath = join(this.logsDir, "daemon.log");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(invocation.cwd)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(logPath)}</string>
  </dict>
</plist>
`;
  }

  private systemdUnit(): string {
    const invocation = this.options.invocation;
    const command = [invocation.command, ...invocation.args]
      .map(systemdQuote)
      .join(" ");
    return `[Unit]
Description=Vykor daemon
After=network.target

[Service]
Type=simple
ExecStart=${command}
WorkingDirectory=${systemdQuote(invocation.cwd)}
Restart=on-failure
RestartSec=5
StandardOutput=append:${systemdQuote(join(this.logsDir, "daemon.log"))}
StandardError=append:${systemdQuote(join(this.logsDir, "daemon.log"))}

[Install]
WantedBy=default.target
`;
  }
}

export function serializeWindowsArguments(args: string[]): string {
  return args.map(quoteWindowsArgument).join(" ");
}

function quoteWindowsArgument(value: string): string {
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
    } else if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      result += "\\".repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  return result + "\\".repeat(backslashes * 2) + '"';
}

function vbscriptEscape(value: string): string {
  return value.replaceAll('"', '""');
}

function windowsScriptHostPath(): string {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  return windowsRoot
    ? join(windowsRoot, "System32", "wscript.exe")
    : "wscript.exe";
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function runSystemCommand(
  command: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): SystemCommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function runSystemCommandAsync(
  command: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<SystemCommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: "utf-8",
        windowsHide: true,
        env: { ...process.env, ...extraEnv },
      },
      (error, stdout, stderr) => {
        resolve({
          status: error ? (typeof error.code === "number" ? error.code : null) : 0,
          stdout,
          stderr,
          ...(error ? { error } : {}),
        });
      },
    );
  });
}
