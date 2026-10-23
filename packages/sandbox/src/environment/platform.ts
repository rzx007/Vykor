import { release, platform } from "node:os";
import type { SandboxPlatform } from "./types.js";

export function detectSandboxPlatform(options?: {
  platform?: NodeJS.Platform;
  release?: string;
  env?: NodeJS.ProcessEnv;
}): SandboxPlatform {
  const rawPlatform = options?.platform ?? platform();
  const rawRelease = (options?.release ?? release()).toLowerCase();
  const env = options?.env ?? process.env;

  if (rawPlatform === "darwin") return "macos";
  if (rawPlatform === "win32") return "windows";
  if (rawPlatform === "linux") {
    if (
      rawRelease.includes("microsoft") ||
      env.WSL_DISTRO_NAME !== undefined ||
      env.WSL_INTEROP !== undefined
    ) {
      return "wsl";
    }
    return "linux";
  }
  return "unknown";
}

export function supportsSandboxRuntime(platformName: SandboxPlatform): boolean {
  return platformName === "linux" || platformName === "wsl" || platformName === "macos";
}

