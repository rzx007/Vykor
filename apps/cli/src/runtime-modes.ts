import { isWorkMode, normalizeApprovalMode, type ApprovalMode, type WorkMode } from "@vykor/application-client";

/** Keep legacy `--permission-mode plan` working without coupling the two switches. */
export function resolveRuntimeModes(
  options: { permissionMode?: string; workMode?: string; plan?: boolean; dangerouslySkipPermissions?: boolean },
  permissionMode: unknown,
): { approvalMode: ApprovalMode; workMode: WorkMode } {
  const legacyMode = options.permissionMode ?? permissionMode;
  return {
    approvalMode: options.dangerouslySkipPermissions ? "full_access" : normalizeApprovalMode(legacyMode) ?? "ask",
    workMode: isWorkMode(options.workMode)
      ? options.workMode
      : options.plan || legacyMode === "plan" ? "plan" : "execute",
  };
}
