import type { Settings } from "@vykor/core";
import { normalizeSandboxConfig } from "./config.js";
import type { ResolvedSandboxConfig } from "./types.js";

export type ExecutionSurface = "desktop_managed" | "cli_advanced";
export interface ResolveExecutionEnvironmentConfigInput { surface: ExecutionSurface; settings: Settings; cwd: string }
export type ResolvedExecutionEnvironmentConfig =
  | { mode: "local"; kind: "local"; failClosed: false; cwd: string; sandbox: ResolvedSandboxConfig }
  | { mode: "wsl"; kind: "wsl"; failClosed: true; cwd: string; sandbox: ResolvedSandboxConfig };

export class ExecutionConfigError extends Error {
  constructor(readonly code: "unsupported_srt", message: string) { super(message); this.name = "ExecutionConfigError"; }
}

export function resolveExecutionEnvironmentConfig(input: ResolveExecutionEnvironmentConfigInput): ResolvedExecutionEnvironmentConfig {
  const sandbox = normalizeSandboxConfig(input.settings.sandbox);
  if (input.settings.agentEnvironment?.kind === "wsl") {
    if (sandbox.enabled) throw new ExecutionConfigError("unsupported_srt", "WSL cannot currently be combined with the configured local sandbox");
    return { mode: "wsl", kind: "wsl", failClosed: true, cwd: input.cwd, sandbox };
  }
  return { mode: "local", kind: "local", failClosed: false, cwd: input.cwd, sandbox };
}
