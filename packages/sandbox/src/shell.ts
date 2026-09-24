import { spawn, spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";
import { resolve } from "node:path";
import { loadSettings, type Settings } from "@vykor/core";
import type { EnvironmentExecutionOwner } from "@vykor/environment";
import { shellArgv, type ShellDescriptor } from "@vykor/environment";
import { getSrtAvailability } from "./availability.js";
import { SandboxUnavailableError } from "./errors.js";
import { bindProcessAbortSignal } from "./process-control.js";
import { resolveSandboxPolicy } from "./policy.js";
import { wrapCommandForSrt } from "./srt-adapter.js";
import type { SandboxPolicy } from "./types.js";

export interface CreateShellProcessOptions {
  cwd: string;
  sessionId?: string;
  settings?: Settings;
  policy?: SandboxPolicy;
  env?: Record<string, string>;
  owner?: EnvironmentExecutionOwner;
  stdio?: StdioOptions;
  signal?: AbortSignal;
  detached?: boolean;
  /** Host shell selection policy. */
  hostShell?: "preferred" | "system";
  shellDescriptor?: ShellDescriptor;
}

export interface CreateProcessOptions extends CreateShellProcessOptions {}

/** Start an argv process through the configured sandbox backend. */
export async function createProcess(
  argv: string[],
  options: CreateProcessOptions,
): Promise<ChildProcess> {
  if (argv.length === 0 || !argv[0]) throw new Error("createProcess requires a non-empty argv");
  const settings = options.settings ?? await loadSettings(undefined, {
    projectRoot: options.cwd,
    includeProject: true,
  });
  const policy = options.policy ?? resolveSandboxPolicy({
    cwd: options.cwd,
    sessionId: options.sessionId,
    settings,
  });
  return createResolvedProcess(argv, options, settings, policy);
}

export type HostShellLauncher =
  | { kind: "posix-sh" }
  | { kind: "bash"; bin: string }
  | { kind: "powershell"; bin: string }
  | { kind: "cmd"; bin: string };

/** Process-lifetime cache for host shell probes (avoid spawnSync on every Bash call). */
let cachedHostShell: HostShellLauncher | undefined;

export async function createShellProcess(
  command: string,
  options: CreateShellProcessOptions,
): Promise<ChildProcess> {
  const settings = options.settings ?? await loadSettings(undefined, {
    projectRoot: options.cwd,
    includeProject: true,
  });
  const policy = options.policy ?? resolveSandboxPolicy({
    cwd: options.cwd,
    sessionId: options.sessionId,
    settings,
  });
  const spawnHostOverride = options.hostShell === "system"
    ? () => spawnSystemShell(command, options)
    : undefined;
  return createResolvedProcess(
    options.hostShell === "system"
      ? resolveSystemShellArgv(command)
      : options.shellDescriptor
        ? shellArgv(options.shellDescriptor, command)
        : resolveShellArgv(command),
    options,
    settings,
    policy,
    spawnHostOverride,
  );
}

function resolveSystemShellArgv(command: string): string[] {
  if (process.platform === "win32") return [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", command];
  return [process.env.SHELL || "/bin/sh", "-c", command];
}

async function createResolvedProcess(
  hostArgv: string[],
  options: CreateProcessOptions,
  settings: Settings,
  policy: SandboxPolicy,
  spawnHostOverride?: () => ChildProcess,
): Promise<ChildProcess> {
  const sandbox = policy.config;
  const spawnLocal = () => spawnHostOverride?.() ?? spawnHost(hostArgv, options);
  if (!sandbox.enabled) return spawnLocal();

  const availability = getSrtAvailability(policy.config);
  if (!availability.available) {
    if (sandbox.failIfUnavailable) {
      throw new SandboxUnavailableError(availability.reason ?? "srt sandbox is unavailable");
    }
    return spawnLocal();
  }

  const wrapped = await wrapCommandForSrt(hostArgv, policy.config);
  const child = spawnHost(wrapped.argv, options);
  const cleanup = () => void wrapped.cleanup();
  child.once("close", cleanup);
  child.once("error", cleanup);
  return child;
}


export function resolveHostShellLauncher(): HostShellLauncher {
  return detectHostShell();
}

export interface ResolveShellDescriptorInput {
  platform?: NodeJS.Platform;
  tempDir: string;
  configuredExecutable?: string;
  probe?: (executable: string) => Promise<{ version: string } | null>;
}

export async function resolveShellDescriptor(
  input: ResolveShellDescriptorInput,
): Promise<ShellDescriptor> {
  const targetPlatform = input.platform ?? process.platform;
  const probe = input.probe ?? probeShellExecutable;
  const configured = input.configuredExecutable?.trim();
  if (configured) {
    const result = await probe(configured);
    if (!result) throw new Error(`Configured shell is unavailable: ${configured}`);
    return descriptorForExecutable(configured, result.version, targetPlatform, input.tempDir);
  }

  if (targetPlatform === "win32") {
    for (const executable of ["pwsh.exe", "powershell.exe", process.env.ComSpec || "cmd.exe"]) {
      const result = await probe(executable);
      if (result) return descriptorForExecutable(executable, result.version, targetPlatform, input.tempDir);
    }
    throw new Error("No supported Windows shell is available (pwsh.exe, powershell.exe, cmd.exe).");
  }

  const configuredPosix = process.env.SHELL;
  const candidates = configuredPosix ? [configuredPosix, "/bin/sh"] : ["/bin/sh"];
  for (const executable of candidates) {
    const result = await probe(executable);
    if (result) return descriptorForExecutable(executable, result.version, targetPlatform, input.tempDir);
  }
  throw new Error("No supported POSIX shell is available.");
}

async function probeShellExecutable(executable: string): Promise<{ version: string } | null> {
  const lower = executable.toLowerCase();
  const args = lower.includes("powershell") || lower.includes("pwsh")
    ? ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]
    : lower.endsWith("cmd.exe") || lower === "cmd"
      ? ["/d", "/s", "/c", "ver"]
      : ["-c", "printf %s \"${BASH_VERSION:-${ZSH_VERSION:-sh}}\""];
  try {
    const result = spawnSync(executable, args, {
      windowsHide: true,
      encoding: "utf8",
      timeout: 3000,
    });
    if (result.status !== 0) return null;
    return { version: String(result.stdout || "").trim() || "unknown" };
  } catch {
    return null;
  }
}

function descriptorForExecutable(
  executable: string,
  version: string,
  targetPlatform: NodeJS.Platform,
  tempDir: string,
): ShellDescriptor {
  const lower = executable.toLowerCase().replace(/\\/g, "/");
  if (/(^|\/)pwsh(?:\.exe)?$/.test(lower)) {
    return {
      family: "powershell", dialect: "pwsh", executable,
      argsPrefix: ["-NoLogo", "-NoProfile", "-Command"],
      displayName: `PowerShell ${version}`, version,
      pathStyle: "windows", tempDir,
      capabilities: { conditionalAndOr: true, supportsLoginShell: false },
    };
  }
  if (/(^|\/)powershell(?:\.exe)?$/.test(lower)) {
    return {
      family: "powershell", dialect: "windows-powershell", executable,
      argsPrefix: ["-NoLogo", "-NoProfile", "-Command"],
      displayName: `Windows PowerShell ${version}`, version,
      pathStyle: "windows", tempDir,
      capabilities: { conditionalAndOr: false, supportsLoginShell: false },
    };
  }
  if (/(^|\/)cmd(?:\.exe)?$/.test(lower)) {
    return {
      family: "cmd", dialect: "cmd", executable,
      argsPrefix: ["/d", "/s", "/c"], displayName: "Command Prompt", version,
      pathStyle: "windows", tempDir,
      capabilities: { conditionalAndOr: true, supportsLoginShell: false },
    };
  }
  const dialect = /(^|\/)zsh$/.test(lower) ? "zsh" : /(^|\/)bash$/.test(lower) ? "bash" : "posix-sh";
  return {
    family: "posix", dialect, executable,
    argsPrefix: ["-lc"], displayName: dialect === "posix-sh" ? "POSIX Shell" : dialect,
    version, pathStyle: targetPlatform === "win32" ? "windows" : "posix", tempDir,
    capabilities: { conditionalAndOr: true, supportsLoginShell: true },
  };
}

export function describeHostShellLauncher(shell: HostShellLauncher = resolveHostShellLauncher()): string {
  switch (shell.kind) {
    case "bash":
      return `${shell.bin} -c`;
    case "powershell":
      return `${shell.bin} -NoLogo -NoProfile -Command`;
    case "cmd":
      return `${shell.bin} /d /s /c`;
    case "posix-sh":
      return "/bin/sh -c";
  }
}

/**
 * 解析宿主平台 shell：
 * - Windows：优先 PowerShell 7，其次 Windows PowerShell，最后 cmd
 * - POSIX：`/bin/sh -c`
 *
 * 探测结果进程内缓存。
 */
export function resolveShellArgv(command: string): string[] {
  const shell = detectHostShell();
  switch (shell.kind) {
    case "bash":
      return [shell.bin, "-c", command];
    case "powershell":
      return [shell.bin, "-NoLogo", "-NoProfile", "-Command", command];
    case "cmd":
      return [shell.bin, "/d", "/s", "/c", command];
    case "posix-sh":
      return ["/bin/sh", "-c", command];
  }
}

/** @internal test helper */
export function resetHostShellCacheForTests(): void {
  cachedHostShell = undefined;
}

function detectHostShell(): HostShellLauncher {
  if (cachedHostShell) return cachedHostShell;

  if (process.platform !== "win32") {
    cachedHostShell = { kind: "posix-sh" };
    return cachedHostShell;
  }

  if (isUsableCommand("pwsh.exe")) {
    cachedHostShell = { kind: "powershell", bin: "pwsh.exe" };
    return cachedHostShell;
  }

  const powershell = process.env.ComSpec?.toLowerCase().includes("powershell")
    ? process.env.ComSpec
    : "powershell.exe";
  if (isUsableCommand(powershell)) {
    cachedHostShell = { kind: "powershell", bin: powershell };
    return cachedHostShell;
  }

  cachedHostShell = { kind: "cmd", bin: process.env.ComSpec ?? "cmd.exe" };
  return cachedHostShell;
}

function isUsableCommand(
  command: string,
  args: string[] = ["-NoLogo", "-NoProfile", "-Command", "exit 0"],
): boolean {
  try {
    const result = spawnSync(command, args, {
      windowsHide: true,
      stdio: "ignore",
      timeout: 3000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function spawnHost(argv: string[], options: CreateShellProcessOptions): ChildProcess {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: resolve(options.cwd),
    env: options.env ? { ...process.env, ...options.env } : process.env,
    windowsHide: true,
    detached: options.detached ?? process.platform !== "win32",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  bindProcessAbortSignal(child, options.signal);
  return child;
}

function spawnSystemShell(command: string, options: CreateShellProcessOptions): ChildProcess {
  const child = spawn(command, {
    cwd: resolve(options.cwd),
    env: options.env ? { ...process.env, ...options.env } : process.env,
    windowsHide: true,
    detached: options.detached ?? process.platform !== "win32",
    shell: true,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  bindProcessAbortSignal(child, options.signal);
  return child;
}
