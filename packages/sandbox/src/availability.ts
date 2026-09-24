import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { SandboxConfig } from "@vykor/core";
import { normalizeSandboxConfig } from "./config.js";
import { detectSandboxPlatform, supportsSandboxRuntime } from "./platform.js";
import type { SandboxAvailability, SandboxPlatform } from "./types.js";

export interface AvailabilityDeps { platform?: SandboxPlatform; which?: (command: string) => string | undefined }

export function getSandboxAvailability(config?: SandboxConfig, deps: AvailabilityDeps = {}): SandboxAvailability {
  return getSrtAvailability(config, deps);
}

export function getSrtAvailability(config?: SandboxConfig, deps: AvailabilityDeps = {}): SandboxAvailability {
  const resolved = normalizeSandboxConfig(config);
  const platform = deps.platform ?? detectSandboxPlatform();
  if (!resolved.enabled) return { enabled: false, available: false, active: false, backend: "srt", platform, reason: "srt sandbox is not enabled" };
  if (!supportsSandboxRuntime(platform)) {
    return unavailable(platform, platform === "windows" ? "sandbox runtime is not supported on native Windows; use WSL" : `sandbox runtime is not supported on platform ${platform}`);
  }
  if (resolved.enabledPlatforms.length > 0 && !resolved.enabledPlatforms.includes(platform as never)) {
    return unavailable(platform, `sandbox is disabled for platform ${platform} by configuration`);
  }
  const which = deps.which ?? findExecutable;
  const srt = which(resolved.srt.runtimeCommand);
  if (!srt) return unavailable(platform, "sandbox runtime CLI not found; install @anthropic-ai/sandbox-runtime");
  if ((platform === "linux" || platform === "wsl") && !which("bwrap")) return unavailable(platform, "bubblewrap (`bwrap`) is required for sandbox runtime");
  if (platform === "macos" && !which("sandbox-exec")) return unavailable(platform, "`sandbox-exec` is required for sandbox runtime on macOS");
  return { enabled: true, available: true, active: true, backend: "srt", platform, command: srt };
}

function unavailable(platform: SandboxPlatform, reason: string): SandboxAvailability {
  return { enabled: true, available: false, active: false, backend: "srt", platform, reason };
}

function findExecutable(command: string): string | undefined {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return undefined;
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(delimiter)) for (const ext of extensions) {
    const candidate = join(dir, command.endsWith(ext) ? command : `${command}${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
