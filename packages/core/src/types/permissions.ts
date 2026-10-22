import type { PermissionDecision } from "@vykor/agent-contracts";
import type { PermissionMode } from "@vykor/host-config";

export interface PermissionChecker {
  /** Runtime owners may expose their current mode; custom checkers need not. */
  getMode?(): PermissionMode;
  checkTool(
    toolName: string,
    input: Record<string, unknown>,
    /** Host-owned schema declarations, used to distinguish business fields from aliases. */
    inputSchema?: Record<string, unknown>,
  ): Promise<PermissionDecision>;
}
