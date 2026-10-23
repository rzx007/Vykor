import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export interface ShellInfo {
  command: string;
  args: string[];
}

/** 使用命令模式，退出状态对应命令进程，而不是空闲的交互 shell。 */
export function terminalCommandArgs(shell: string, command: string): string[] {
  const name = shell.split(/[\\/]/).pop()?.replace(/\.exe$/i, "").toLowerCase();
  if (name === "powershell" || name === "pwsh") return ["-NoLogo", "-NoProfile", "-Command", command];
  if (name === "cmd") return ["/d", "/s", "/c", command];
  return ["-lc", command];
}

export function resolveDefaultShell(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): ShellInfo {
  if (platform === "win32") {
    return { command: resolveWindowsShell(env, fileExists), args: [] };
  }

  return {
    command: resolvePosixShell(platform),
    args: [],
  };
}

export function createTerminalEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    TERM: env["TERM"] || "xterm-256color",
    COLORTERM: env["COLORTERM"] || "truecolor",
    FORCE_COLOR: env["FORCE_COLOR"] || "1",
  };
}

function resolveWindowsShell(
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
): string {
  for (const candidate of ["pwsh.exe", "powershell.exe"]) {
    const resolved = findOnPath(candidate, env, fileExists, ";");
    if (resolved) return resolved;
  }

  const comSpec = env["ComSpec"] ?? env["COMSPEC"];
  if (comSpec && fileExists(comSpec)) return comSpec;
  return findOnPath("cmd.exe", env, fileExists, ";") ?? "cmd.exe";
}

function resolvePosixShell(platform: string): string {
  const configured = process.env["SHELL"];
  if (configured) return configured;

  const candidates =
    platform === "darwin"
      ? ["/bin/zsh", "/bin/bash", "/bin/sh"]
      : ["/bin/bash", "/bin/sh"];
  return candidates.find((candidate) => existsSync(candidate)) ?? "/bin/sh";
}

function findOnPath(
  executable: string,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
  pathDelimiter = delimiter,
): string | undefined {
  if (isAbsolute(executable))
    return fileExists(executable) ? executable : undefined;
  const path = env["Path"] ?? env["PATH"] ?? "";
  for (const rawDirectory of path.split(pathDelimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    const candidate = join(directory, executable);
    if (fileExists(candidate)) return candidate;
  }
  return undefined;
}
