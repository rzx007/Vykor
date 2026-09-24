import type { SandboxConfig } from "@vykor/core";
import type { ResolvedSandboxConfig } from "./types.js";

export function normalizeSandboxConfig(config?: SandboxConfig): ResolvedSandboxConfig {
  return {
    enabled: config?.enabled ?? false,
    backend: "srt",
    failIfUnavailable: config?.failIfUnavailable ?? false,
    enabledPlatforms: config?.enabledPlatforms ?? [],
    filesystem: {
      allowRead: config?.filesystem?.allowRead ?? ["."],
      denyRead: config?.filesystem?.denyRead ?? [],
      allowWrite: config?.filesystem?.allowWrite ?? ["."],
      denyWrite: config?.filesystem?.denyWrite ?? [],
      extraAllowedRoots: config?.filesystem?.extraAllowedRoots ?? [],
    },
    network: {
      mode: config?.network?.mode ?? "none",
      allowedDomains: config?.network?.allowedDomains ?? [],
      deniedDomains: config?.network?.deniedDomains ?? [],
      strictDomainPolicy: config?.network?.strictDomainPolicy ?? false,
    },
    srt: {
      runtimeCommand: config?.srt?.runtimeCommand ?? "srt",
    },
  };
}
