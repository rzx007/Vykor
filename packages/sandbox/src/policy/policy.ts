import { resolve } from "node:path";
import { SandboxUnavailableError } from "../environment/errors.js";
import { normalizeSandboxConfig } from "../configuration/config.js";
import type {
  SandboxFailureKind,
  SandboxPolicy,
  SandboxPolicyInput,
  SandboxPolicyOperation,
  SandboxPolicyService,
} from "../environment/types.js";

export class DefaultSandboxPolicyService implements SandboxPolicyService {
  resolvePolicy(input: SandboxPolicyInput): SandboxPolicy {
    const config = normalizeSandboxConfig(input.config ?? input.settings?.sandbox);
    const cwd = resolve(input.cwd);
    const workspaceRoot = resolve(input.workspaceRoot ?? input.cwd);
    const sessionId = input.sessionId?.trim() || undefined;
    const enabled = config.enabled;
    const writeRoots = [
      ...config.filesystem.allowWrite,
      ...config.filesystem.extraAllowedRoots,
    ];

    return {
      mode: !enabled
        ? "off"
        : writeRoots.length === 0
          ? "read-only"
          : "workspace-write",
      enforcement: !enabled
        ? "off"
        : config.failIfUnavailable
          ? "required"
          : "best-effort",
      enabled,
      backend: config.backend,
      failClosed: enabled && config.failIfUnavailable,
      scope: {
        cwd,
        workspaceRoot,
        ...(sessionId ? { sessionId } : {}),
      },
      filesystem: config.filesystem,
      network: config.network,
      config,
    };
  }
}

export const defaultSandboxPolicyService: SandboxPolicyService = new DefaultSandboxPolicyService();

export function resolveSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  return defaultSandboxPolicyService.resolvePolicy(input);
}

export class SandboxPolicyDeniedError extends Error {
  readonly failureKind = "policy" as const;

  constructor(
    readonly code: "filesystem_denied" | "execution_denied" | "network_denied",
    readonly operation: SandboxPolicyOperation,
    message: string,
  ) {
    super(message);
    this.name = "SandboxPolicyDeniedError";
  }
}

export function classifySandboxFailure(error: unknown): Exclude<SandboxFailureKind, "command"> | undefined {
  if (error instanceof SandboxPolicyDeniedError) return "policy";
  if (error instanceof SandboxUnavailableError) return "runner";
  if (
    typeof error === "object" &&
    error !== null &&
    "failureKind" in error &&
    (error.failureKind === "policy" || error.failureKind === "runner")
  ) {
    return error.failureKind;
  }
  return undefined;
}
