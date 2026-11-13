import { AsyncLocalStorage } from "node:async_hooks";
import type { ApprovalMode, PermissionMode } from "@vykor/agent-contracts";
import type { ExecutionEnvironmentHandle } from "@vykor/environment";
import { normalizeApprovalMode, type Settings } from "@vykor/host-config";
import { effectivePermissionMode } from "@vykor/permissions";
import { settingsForApprovalMode } from "@vykor/sandbox";
import type { VykorAgentConfiguration } from "../agent/agent-options.js";

/** One captured policy per actual invocation, including waits and detached continuations. */
export function createToolAuthorization(input: {
  settings: Settings;
  configuration: VykorAgentConfiguration;
  sessionId?: string;
  environment?: ExecutionEnvironmentHandle;
}) {
  const local = new AsyncLocalStorage<{
    approvalMode: ApprovalMode; mode: PermissionMode; settings: Settings;
    environment?: ExecutionEnvironmentHandle;
  }>();
  let planning = false;
  const selected = () => {
    const { configuration, settings } = input;
    const live = input.sessionId ? configuration.readApprovalMode?.(input.sessionId) : undefined;
    const selectedMode = configuration.permissionMode ?? settings.permission.mode;
    const approvalMode = live ?? configuration.approvalMode ?? normalizeApprovalMode(selectedMode) ?? "ask";
    const mode: PermissionMode = planning || configuration.workMode === "plan" || selectedMode === "plan"
      ? "plan"
      : live || configuration.approvalMode
        ? effectivePermissionMode(approvalMode, "execute")
        : selectedMode === "ask" || selectedMode === "auto_review" ? "default"
          : selectedMode === "full_access" ? "full_auto" : selectedMode;
    return { approvalMode, mode, settings: settingsForApprovalMode(settings, approvalMode) };
  };
  const current = () => local.getStore() ?? selected();
  // Tool factories and hooks retain this object, including through host-object spreads.
  const settings = new Proxy({ ...input.settings, sandbox: input.settings.sandbox }, {
    get: (_target, key) => {
      const captured = current();
      return key === "permission"
        ? { ...captured.settings.permission, mode: captured.approvalMode }
        : Reflect.get(captured.settings, key);
    },
  });
  return {
    settings,
    getApprovalMode: () => current().approvalMode,
    getMode: () => current().mode,
    getEnvironment: () => local.getStore()?.environment
      ?? input.environment?.withFullAccess?.(selected().approvalMode === "full_access") ?? input.environment,
    hasScope: () => local.getStore() !== undefined,
    setPlanMode: (enabled: boolean) => { planning = enabled; return selected().mode; },
    capture: () => {
      const captured = selected();
      const environment = input.environment?.withFullAccess?.(captured.approvalMode === "full_access") ?? input.environment;
      return <T>(work: () => Promise<T>): Promise<T> => local.run({ ...captured, environment }, work);
    },
  };
}
